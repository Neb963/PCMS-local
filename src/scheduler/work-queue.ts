const SAFE_QUEUE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const MAX_QUEUE_CAPACITY = 100_000;

export type WorkPriority =
  | "RECOVERY"
  | "INTERACTIVE"
  | "SCHEDULED"
  | "BACKGROUND";

const PRIORITY_ORDER: readonly WorkPriority[] = Object.freeze([
  "RECOVERY",
  "INTERACTIVE",
  "SCHEDULED",
  "BACKGROUND"
]);

export interface EnqueueWorkInput<T> {
  readonly key: string;
  readonly priority: WorkPriority;
  readonly fairnessKey: string;
  readonly createdAt: string;
  readonly deadlineAt?: string | null;
  readonly value: T;
}

export interface QueuedWorkItem<T> {
  readonly key: string;
  readonly priority: WorkPriority;
  readonly fairnessKey: string;
  readonly createdAt: string;
  readonly deadlineAt: string | null;
  readonly value: T;
}

export type WorkQueueEnqueueResult =
  | "ENQUEUED"
  | "COALESCED";

export type WorkQueueErrorCode =
  | "WORK_QUEUE_INVALID_INPUT"
  | "WORK_QUEUE_FULL";

export class WorkQueueError extends Error {
  public constructor(
    public readonly code: WorkQueueErrorCode,
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "WorkQueueError";
  }
}

function fail(
  code: WorkQueueErrorCode,
  message: string,
  retryable = false
): never {
  throw new WorkQueueError(code, message, retryable);
}

function validateKey(value: string, label: string): string {
  if (!SAFE_QUEUE_KEY.test(value)) {
    fail(
      "WORK_QUEUE_INVALID_INPUT",
      `${label} has invalid syntax`
    );
  }
  return value;
}

function normalizeTimestamp(
  value: string,
  label: string
): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    fail(
      "WORK_QUEUE_INVALID_INPUT",
      `${label} must be a valid timestamp`
    );
  }
  return new Date(milliseconds).toISOString();
}

function validatePriority(value: WorkPriority): WorkPriority {
  if (
    value !== "RECOVERY" &&
    value !== "INTERACTIVE" &&
    value !== "SCHEDULED" &&
    value !== "BACKGROUND"
  ) {
    fail(
      "WORK_QUEUE_INVALID_INPUT",
      "work priority is invalid"
    );
  }
  return value;
}

export class BoundedWorkQueue<T> {
  readonly #capacity: number;
  readonly #lanes = new Map<
    WorkPriority,
    Map<string, QueuedWorkItem<T>[]>
  >();
  readonly #keys = new Set<string>();
  readonly #inFlight = new Set<string>();

  public constructor(capacity: number) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      capacity > MAX_QUEUE_CAPACITY
    ) {
      fail(
        "WORK_QUEUE_INVALID_INPUT",
        `queue capacity must be between 1 and ${MAX_QUEUE_CAPACITY}`
      );
    }
    this.#capacity = capacity;
    for (const priority of PRIORITY_ORDER) {
      this.#lanes.set(priority, new Map());
    }
  }

  public get capacity(): number {
    return this.#capacity;
  }

  public get size(): number {
    return this.#keys.size;
  }

  public get queuedSize(): number {
    return this.#keys.size - this.#inFlight.size;
  }

  public get inFlightSize(): number {
    return this.#inFlight.size;
  }

  public get remainingCapacity(): number {
    return this.#capacity - this.#keys.size;
  }

  public has(key: string): boolean {
    return this.#keys.has(key);
  }

  public isInFlight(key: string): boolean {
    return this.#inFlight.has(key);
  }

  public enqueue(
    input: EnqueueWorkInput<T>
  ): WorkQueueEnqueueResult {
    const key = validateKey(input.key, "work key");
    const fairnessKey = validateKey(
      input.fairnessKey,
      "fairnessKey"
    );
    const priority = validatePriority(input.priority);
    const createdAt = normalizeTimestamp(
      input.createdAt,
      "createdAt"
    );
    const deadlineAt =
      input.deadlineAt === undefined ||
      input.deadlineAt === null
        ? null
        : normalizeTimestamp(input.deadlineAt, "deadlineAt");

    if (this.#keys.has(key)) {
      return "COALESCED";
    }
    if (this.#keys.size >= this.#capacity) {
      fail(
        "WORK_QUEUE_FULL",
        "bounded work queue is at capacity",
        true
      );
    }

    const item: QueuedWorkItem<T> = Object.freeze({
      key,
      priority,
      fairnessKey,
      createdAt,
      deadlineAt,
      value: input.value
    });
    const lane = this.#lane(priority);
    const group = lane.get(fairnessKey) ?? [];
    group.push(item);
    lane.set(fairnessKey, group);
    this.#keys.add(key);
    return "ENQUEUED";
  }

  public claimNext(
    now: Date = new Date()
  ): QueuedWorkItem<T> | null {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) {
      fail(
        "WORK_QUEUE_INVALID_INPUT",
        "queue clock must be valid"
      );
    }
    this.#dropExpired(nowMs);

    for (const priority of PRIORITY_ORDER) {
      const lane = this.#lane(priority);
      while (lane.size > 0) {
        const first = lane.entries().next().value;
        if (first === undefined) {
          break;
        }
        const [fairnessKey, group] = first;
        const item = group.shift();
        lane.delete(fairnessKey);
        if (group.length > 0) {
          lane.set(fairnessKey, group);
        }
        if (item === undefined) {
          continue;
        }
        this.#inFlight.add(item.key);
        return item;
      }
    }
    return null;
  }

  public complete(key: string): boolean {
    validateKey(key, "work key");
    if (!this.#inFlight.delete(key)) {
      return false;
    }
    this.#keys.delete(key);
    return true;
  }

  public abandon(key: string): boolean {
    return this.complete(key);
  }

  public cancelQueued(key: string): boolean {
    validateKey(key, "work key");
    if (
      !this.#keys.has(key) ||
      this.#inFlight.has(key)
    ) {
      return false;
    }

    for (const priority of PRIORITY_ORDER) {
      const lane = this.#lane(priority);
      for (const [fairnessKey, group] of lane) {
        const index = group.findIndex((item) => item.key === key);
        if (index < 0) {
          continue;
        }
        group.splice(index, 1);
        if (group.length === 0) {
          lane.delete(fairnessKey);
        }
        this.#keys.delete(key);
        return true;
      }
    }
    return false;
  }

  #dropExpired(nowMs: number): void {
    for (const priority of PRIORITY_ORDER) {
      const lane = this.#lane(priority);
      for (const [fairnessKey, group] of [...lane.entries()]) {
        const retained = group.filter((item) => {
          const expired =
            item.deadlineAt !== null &&
            Date.parse(item.deadlineAt) <= nowMs;
          if (expired) {
            this.#keys.delete(item.key);
          }
          return !expired;
        });
        if (retained.length === 0) {
          lane.delete(fairnessKey);
        } else if (retained.length !== group.length) {
          lane.set(fairnessKey, retained);
        }
      }
    }
  }

  #lane(
    priority: WorkPriority
  ): Map<string, QueuedWorkItem<T>[]> {
    const lane = this.#lanes.get(priority);
    if (lane === undefined) {
      fail(
        "WORK_QUEUE_INVALID_INPUT",
        "queue priority lane is missing"
      );
    }
    return lane;
  }
}
