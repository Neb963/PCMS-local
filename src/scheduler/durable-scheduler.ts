import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  BoundedWorkQueue,
  WorkQueueError,
  type WorkPriority
} from "./work-queue.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const SAFE_KIND = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_TARGET = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,319}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_BUDGET_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_WAKE_SCAN = 10_000;

export interface ScheduleBudgetInput {
  readonly limit: number;
  readonly windowMs: number;
}

export interface ScheduleBudget {
  readonly limit: number;
  readonly windowMs: number;
  readonly windowStartedAt: string;
  readonly used: number;
}

export interface CreateScheduleInput {
  readonly scheduleId: string;
  readonly ownerModuleId?: string | null;
  readonly operationKind: string;
  readonly schemaVersion: number;
  readonly targetRef: string;
  readonly payloadRef?: string | null;
  readonly intervalMs: number;
  readonly timeZone: string;
  readonly priority?: WorkPriority;
  readonly fairnessKey?: string;
  readonly enabled?: boolean;
  readonly nextDueAt: string;
  readonly budget?: ScheduleBudgetInput | null;
}

export interface ScheduleRecord {
  readonly scheduleId: string;
  readonly ownerModuleId: string | null;
  readonly operationKind: string;
  readonly schemaVersion: number;
  readonly targetRef: string;
  readonly payloadRef: string | null;
  readonly intervalMs: number;
  readonly timeZone: string;
  readonly priority: WorkPriority;
  readonly fairnessKey: string;
  readonly enabled: boolean;
  readonly nextDueAt: string;
  readonly lastClockAt: string;
  readonly pendingDispatchId: string | null;
  readonly pendingCreatedAt: string | null;
  readonly lastDispatchedOperationId: string | null;
  readonly lastTerminalOperationId: string | null;
  readonly lastFailureCode: string | null;
  readonly budget: ScheduleBudget | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface ScheduleDispatchIntent {
  readonly dispatchId: string;
  readonly scheduleId: string;
  readonly ownerModuleId: string | null;
  readonly operationKind: string;
  readonly schemaVersion: number;
  readonly targetRef: string;
  readonly payloadRef: string | null;
  readonly createdAt: string;
}

export interface SchedulerWakeResult {
  readonly observedNow: string;
  readonly scanned: number;
  readonly enqueued: number;
  readonly coalesced: number;
  readonly budgetBlocked: number;
  readonly backpressured: number;
  readonly scanLimited: boolean;
}

export interface DurableSchedulerOptions {
  readonly database: DatabaseSync;
  readonly queue: BoundedWorkQueue<ScheduleDispatchIntent>;
  readonly now?: () => Date;
  readonly dispatchId?: () => string;
  readonly maxWakeScan?: number;
}

export type SchedulerErrorCode =
  | "SCHEDULER_INVALID_INPUT"
  | "SCHEDULE_NOT_FOUND"
  | "SCHEDULE_CONFLICT"
  | "SCHEDULE_ROW_INVALID"
  | "SCHEDULE_DISPATCH_STALE"
  | "SCHEDULE_OPERATION_INVALID";

export class SchedulerError extends Error {
  public constructor(
    public readonly code: SchedulerErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SchedulerError";
  }
}

interface ScheduleRow {
  readonly schedule_id: unknown;
  readonly owner_module_id: unknown;
  readonly operation_kind: unknown;
  readonly schema_version: unknown;
  readonly target_ref: unknown;
  readonly payload_ref: unknown;
  readonly interval_ms: unknown;
  readonly time_zone: unknown;
  readonly priority: unknown;
  readonly fairness_key: unknown;
  readonly enabled: unknown;
  readonly next_due_at: unknown;
  readonly last_clock_at: unknown;
  readonly pending_dispatch_id: unknown;
  readonly pending_created_at: unknown;
  readonly last_dispatched_operation_id: unknown;
  readonly last_terminal_operation_id: unknown;
  readonly last_failure_code: unknown;
  readonly budget_limit: unknown;
  readonly budget_window_ms: unknown;
  readonly budget_window_started_at: unknown;
  readonly budget_used: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly revision: unknown;
}

function fail(
  code: SchedulerErrorCode,
  message: string
): never {
  throw new SchedulerError(code, message);
}

function validateId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) {
    fail(
      "SCHEDULER_INVALID_INPUT",
      `${label} has invalid syntax`
    );
  }
  return value;
}

function nullableModuleId(
  value: string | null | undefined
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!MODULE_ID.test(value)) {
    fail(
      "SCHEDULER_INVALID_INPUT",
      "ownerModuleId has invalid syntax"
    );
  }
  return value;
}

function validatePositiveInteger(
  value: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    fail(
      "SCHEDULER_INVALID_INPUT",
      `${label} must be a positive bounded safe integer`
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
      "SCHEDULER_INVALID_INPUT",
      `${label} must be a valid timestamp`
    );
  }
  return new Date(milliseconds).toISOString();
}

function validateTimeZone(value: string): string {
  if (value.length < 1 || value.length > 128) {
    fail(
      "SCHEDULER_INVALID_INPUT",
      "timeZone must contain 1-128 characters"
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: value
    }).format(new Date(0));
  } catch {
    fail(
      "SCHEDULER_INVALID_INPUT",
      "timeZone must be a supported IANA timezone"
    );
  }
  return value;
}

function validatePriority(value: WorkPriority): WorkPriority {
  if (
    value !== "RECOVERY" &&
    value !== "INTERACTIVE" &&
    value !== "SCHEDULED" &&
    value !== "BACKGROUND"
  ) {
    fail(
      "SCHEDULER_INVALID_INPUT",
      "schedule priority is invalid"
    );
  }
  return value;
}

function nullableStoredText(
  value: unknown,
  label: string
): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    fail(
      "SCHEDULE_ROW_INVALID",
      `stored ${label} is invalid`
    );
  }
  return value;
}

function parseBudget(row: ScheduleRow): ScheduleBudget | null {
  if (
    row.budget_limit === null &&
    row.budget_window_ms === null &&
    row.budget_window_started_at === null &&
    row.budget_used === null
  ) {
    return null;
  }
  if (
    typeof row.budget_limit !== "number" ||
    !Number.isSafeInteger(row.budget_limit) ||
    row.budget_limit < 1 ||
    typeof row.budget_window_ms !== "number" ||
    !Number.isSafeInteger(row.budget_window_ms) ||
    row.budget_window_ms < 1 ||
    typeof row.budget_window_started_at !== "string" ||
    typeof row.budget_used !== "number" ||
    !Number.isSafeInteger(row.budget_used) ||
    row.budget_used < 0 ||
    row.budget_used > row.budget_limit
  ) {
    fail(
      "SCHEDULE_ROW_INVALID",
      "stored schedule budget is invalid"
    );
  }
  return Object.freeze({
    limit: row.budget_limit,
    windowMs: row.budget_window_ms,
    windowStartedAt: row.budget_window_started_at,
    used: row.budget_used
  });
}

function parsePriority(value: unknown): WorkPriority {
  if (
    value === "RECOVERY" ||
    value === "INTERACTIVE" ||
    value === "SCHEDULED" ||
    value === "BACKGROUND"
  ) {
    return value;
  }
  fail(
    "SCHEDULE_ROW_INVALID",
    "stored schedule priority is invalid"
  );
}

function parseRow(
  row: ScheduleRow | undefined
): ScheduleRecord | null {
  if (row === undefined) {
    return null;
  }
  if (
    typeof row.schedule_id !== "string" ||
    typeof row.operation_kind !== "string" ||
    typeof row.schema_version !== "number" ||
    !Number.isSafeInteger(row.schema_version) ||
    row.schema_version < 1 ||
    typeof row.target_ref !== "string" ||
    typeof row.interval_ms !== "number" ||
    !Number.isSafeInteger(row.interval_ms) ||
    row.interval_ms < 1 ||
    typeof row.time_zone !== "string" ||
    typeof row.fairness_key !== "string" ||
    (row.enabled !== 0 && row.enabled !== 1) ||
    typeof row.next_due_at !== "string" ||
    typeof row.last_clock_at !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string" ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    fail(
      "SCHEDULE_ROW_INVALID",
      "stored schedule row is invalid"
    );
  }

  return Object.freeze({
    scheduleId: row.schedule_id,
    ownerModuleId: nullableStoredText(
      row.owner_module_id,
      "ownerModuleId"
    ),
    operationKind: row.operation_kind,
    schemaVersion: row.schema_version,
    targetRef: row.target_ref,
    payloadRef: nullableStoredText(row.payload_ref, "payloadRef"),
    intervalMs: row.interval_ms,
    timeZone: row.time_zone,
    priority: parsePriority(row.priority),
    fairnessKey: row.fairness_key,
    enabled: row.enabled === 1,
    nextDueAt: row.next_due_at,
    lastClockAt: row.last_clock_at,
    pendingDispatchId: nullableStoredText(
      row.pending_dispatch_id,
      "pendingDispatchId"
    ),
    pendingCreatedAt: nullableStoredText(
      row.pending_created_at,
      "pendingCreatedAt"
    ),
    lastDispatchedOperationId: nullableStoredText(
      row.last_dispatched_operation_id,
      "lastDispatchedOperationId"
    ),
    lastTerminalOperationId: nullableStoredText(
      row.last_terminal_operation_id,
      "lastTerminalOperationId"
    ),
    lastFailureCode: nullableStoredText(
      row.last_failure_code,
      "lastFailureCode"
    ),
    budget: parseBudget(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision
  });
}

function selectScheduleSql(where: string): string {
  return `
    SELECT
      schedule_id,
      owner_module_id,
      operation_kind,
      schema_version,
      target_ref,
      payload_ref,
      interval_ms,
      time_zone,
      priority,
      fairness_key,
      enabled,
      next_due_at,
      last_clock_at,
      pending_dispatch_id,
      pending_created_at,
      last_dispatched_operation_id,
      last_terminal_operation_id,
      last_failure_code,
      budget_limit,
      budget_window_ms,
      budget_window_started_at,
      budget_used,
      created_at,
      updated_at,
      revision
    FROM schedules
    WHERE ${where}
  `;
}

function dispatchKey(
  scheduleId: string,
  dispatchId: string
): string {
  return `schedule:${scheduleId}:${dispatchId}`;
}

function intentFrom(
  schedule: ScheduleRecord
): ScheduleDispatchIntent {
  if (
    schedule.pendingDispatchId === null ||
    schedule.pendingCreatedAt === null
  ) {
    fail(
      "SCHEDULE_ROW_INVALID",
      "schedule has no pending dispatch intent"
    );
  }
  return Object.freeze({
    dispatchId: schedule.pendingDispatchId,
    scheduleId: schedule.scheduleId,
    ownerModuleId: schedule.ownerModuleId,
    operationKind: schedule.operationKind,
    schemaVersion: schedule.schemaVersion,
    targetRef: schedule.targetRef,
    payloadRef: schedule.payloadRef,
    createdAt: schedule.pendingCreatedAt
  });
}

export class DurableScheduler {
  readonly #database: DatabaseSync;
  readonly #queue: BoundedWorkQueue<ScheduleDispatchIntent>;
  readonly #now: () => Date;
  readonly #dispatchId: () => string;
  readonly #maxWakeScan: number;

  public constructor(options: DurableSchedulerOptions) {
    this.#database = options.database;
    this.#queue = options.queue;
    this.#now = options.now ?? (() => new Date());
    this.#dispatchId = options.dispatchId ?? randomUUID;
    this.#maxWakeScan = validatePositiveInteger(
      options.maxWakeScan ?? 256,
      "maxWakeScan",
      MAX_WAKE_SCAN
    );
  }

  public create(
    input: CreateScheduleInput
  ): ScheduleRecord {
    const scheduleId = validateId(input.scheduleId, "scheduleId");
    const ownerModuleId = nullableModuleId(input.ownerModuleId);
    if (!SAFE_KIND.test(input.operationKind)) {
      fail(
        "SCHEDULER_INVALID_INPUT",
        "operationKind has invalid syntax"
      );
    }
    const schemaVersion = validatePositiveInteger(
      input.schemaVersion,
      "schemaVersion"
    );
    if (!SAFE_TARGET.test(input.targetRef)) {
      fail(
        "SCHEDULER_INVALID_INPUT",
        "targetRef has invalid syntax"
      );
    }
    const payloadRef =
      input.payloadRef === undefined ||
      input.payloadRef === null
        ? null
        : input.payloadRef;
    if (payloadRef !== null && !SAFE_REF.test(payloadRef)) {
      fail(
        "SCHEDULER_INVALID_INPUT",
        "payloadRef has invalid syntax"
      );
    }
    const intervalMs = validatePositiveInteger(
      input.intervalMs,
      "intervalMs",
      MAX_INTERVAL_MS
    );
    const timeZone = validateTimeZone(input.timeZone);
    const priority = validatePriority(
      input.priority ?? "SCHEDULED"
    );
    const fairnessKey = validateId(
      input.fairnessKey ??
        (ownerModuleId === null ? "core" : ownerModuleId),
      "fairnessKey"
    );
    const nextDueAt = normalizeTimestamp(
      input.nextDueAt,
      "nextDueAt"
    );
    const enabled = input.enabled ?? true;
    const now = this.#currentDate();
    const budgetInput = input.budget ?? null;
    let budgetLimit: number | null = null;
    let budgetWindowMs: number | null = null;
    let budgetWindowStartedAt: string | null = null;
    let budgetUsed: number | null = null;
    if (budgetInput !== null) {
      budgetLimit = validatePositiveInteger(
        budgetInput.limit,
        "budget.limit"
      );
      budgetWindowMs = validatePositiveInteger(
        budgetInput.windowMs,
        "budget.windowMs",
        MAX_BUDGET_WINDOW_MS
      );
      budgetWindowStartedAt = now.toISOString();
      budgetUsed = 0;
    }

    try {
      this.#database.prepare(`
        INSERT INTO schedules (
          schedule_id,
          owner_module_id,
          operation_kind,
          schema_version,
          target_ref,
          payload_ref,
          interval_ms,
          time_zone,
          priority,
          fairness_key,
          enabled,
          next_due_at,
          last_clock_at,
          pending_dispatch_id,
          pending_created_at,
          last_dispatched_operation_id,
          last_terminal_operation_id,
          last_failure_code,
          budget_limit,
          budget_window_ms,
          budget_window_started_at,
          budget_used,
          created_at,
          updated_at,
          revision
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 0
        )
      `).run(
        scheduleId,
        ownerModuleId,
        input.operationKind,
        schemaVersion,
        input.targetRef,
        payloadRef,
        intervalMs,
        timeZone,
        priority,
        fairnessKey,
        enabled ? 1 : 0,
        nextDueAt,
        now.toISOString(),
        budgetLimit,
        budgetWindowMs,
        budgetWindowStartedAt,
        budgetUsed,
        now.toISOString(),
        now.toISOString()
      );
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        fail(
          "SCHEDULE_CONFLICT",
          `schedule ${scheduleId} already exists`
        );
      }
      throw error;
    }
    return this.require(scheduleId);
  }

  public get(scheduleId: string): ScheduleRecord | null {
    validateId(scheduleId, "scheduleId");
    const row = this.#database.prepare(
      selectScheduleSql("schedule_id = ?")
    ).get(scheduleId) as unknown as ScheduleRow | undefined;
    return parseRow(row);
  }

  public require(scheduleId: string): ScheduleRecord {
    const schedule = this.get(scheduleId);
    if (schedule === null) {
      fail(
        "SCHEDULE_NOT_FOUND",
        `schedule ${scheduleId} does not exist`
      );
    }
    return schedule;
  }

  public wake(): SchedulerWakeResult {
    const observedNow = this.#currentDate();
    const rows = this.#database.prepare(
      `${selectScheduleSql("enabled = 1")}
       ORDER BY
         CASE WHEN pending_dispatch_id IS NULL THEN 1 ELSE 0 END,
         next_due_at,
         schedule_id
       LIMIT ?`
    ).all(this.#maxWakeScan + 1) as unknown as ScheduleRow[];

    const scanLimited = rows.length > this.#maxWakeScan;
    const scannedRows = rows.slice(0, this.#maxWakeScan);
    let enqueued = 0;
    let coalesced = 0;
    let budgetBlocked = 0;
    let backpressured = 0;

    for (const row of scannedRows) {
      const schedule = parseRow(row);
      if (schedule === null) {
        fail(
          "SCHEDULE_ROW_INVALID",
          "wake scan returned an invalid schedule"
        );
      }
      const effectiveNowMs = Math.max(
        observedNow.getTime(),
        Date.parse(schedule.lastClockAt)
      );
      const effectiveNow = new Date(effectiveNowMs);

      if (schedule.pendingDispatchId !== null) {
        this.#persistClock(schedule, effectiveNow);
        const outcome = this.#enqueuePending(schedule);
        if (outcome === "ENQUEUED") {
          enqueued += 1;
        } else if (outcome === "COALESCED") {
          coalesced += 1;
        } else {
          backpressured += 1;
        }
        continue;
      }

      const budget = this.#budgetAt(schedule, effectiveNow);
      const due =
        Date.parse(schedule.nextDueAt) <= effectiveNowMs;
      if (!due) {
        this.#persistClockAndBudget(
          schedule,
          effectiveNow,
          budget
        );
        continue;
      }

      if (
        budget !== null &&
        budget.used >= budget.limit
      ) {
        budgetBlocked += 1;
        const windowEnd =
          Date.parse(budget.windowStartedAt) +
          budget.windowMs;
        const nextDueAt = new Date(
          Math.max(Date.parse(schedule.nextDueAt), windowEnd)
        ).toISOString();
        this.#persistClockAndBudget(
          schedule,
          effectiveNow,
          budget,
          nextDueAt
        );
        continue;
      }

      if (this.#queue.remainingCapacity < 1) {
        backpressured += 1;
        this.#persistClockAndBudget(
          schedule,
          effectiveNow,
          budget
        );
        continue;
      }

      const dispatchId = validateId(
        this.#dispatchId(),
        "dispatchId"
      );
      const pendingCreatedAt = effectiveNow.toISOString();
      const nextDueAt = new Date(
        effectiveNowMs + schedule.intervalMs
      ).toISOString();
      const nextBudget =
        budget === null
          ? null
          : Object.freeze({
              ...budget,
              used: budget.used + 1
            });

      const result = this.#database.prepare(`
        UPDATE schedules
        SET next_due_at = ?,
            last_clock_at = ?,
            pending_dispatch_id = ?,
            pending_created_at = ?,
            budget_window_started_at = ?,
            budget_used = ?,
            updated_at = ?,
            revision = revision + 1
        WHERE schedule_id = ?
          AND revision = ?
          AND enabled = 1
          AND pending_dispatch_id IS NULL
      `).run(
        nextDueAt,
        pendingCreatedAt,
        dispatchId,
        pendingCreatedAt,
        nextBudget?.windowStartedAt ?? null,
        nextBudget?.used ?? null,
        pendingCreatedAt,
        schedule.scheduleId,
        schedule.revision
      );
      if (result.changes !== 1) {
        coalesced += 1;
        continue;
      }

      const pending = this.require(schedule.scheduleId);
      const outcome = this.#enqueuePending(pending);
      if (outcome === "ENQUEUED") {
        enqueued += 1;
      } else if (outcome === "COALESCED") {
        coalesced += 1;
      } else {
        backpressured += 1;
      }
    }

    return Object.freeze({
      observedNow: observedNow.toISOString(),
      scanned: scannedRows.length,
      enqueued,
      coalesced,
      budgetBlocked,
      backpressured,
      scanLimited
    });
  }

  public claimNext(
    now: Date = this.#currentDate()
  ): ScheduleDispatchIntent | null {
    return this.#queue.claimNext(now)?.value ?? null;
  }

  public acknowledgeDispatch(
    scheduleId: string,
    dispatchId: string,
    operationId: string
  ): ScheduleRecord {
    validateId(scheduleId, "scheduleId");
    validateId(dispatchId, "dispatchId");
    validateId(operationId, "operationId");
    const operation = this.#database.prepare(`
      SELECT operation_id
      FROM operations
      WHERE operation_id = ?
    `).get(operationId);
    if (operation === undefined) {
      fail(
        "SCHEDULE_OPERATION_INVALID",
        `operation ${operationId} does not exist`
      );
    }

    const now = this.#currentDate().toISOString();
    const result = this.#database.prepare(`
      UPDATE schedules
      SET pending_dispatch_id = NULL,
          pending_created_at = NULL,
          last_dispatched_operation_id = ?,
          updated_at = ?,
          revision = revision + 1
      WHERE schedule_id = ?
        AND pending_dispatch_id = ?
    `).run(
      operationId,
      now,
      scheduleId,
      dispatchId
    );
    if (result.changes !== 1) {
      fail(
        "SCHEDULE_DISPATCH_STALE",
        "schedule pending dispatch no longer matches acknowledgement"
      );
    }
    this.#queue.complete(dispatchKey(scheduleId, dispatchId));
    return this.require(scheduleId);
  }

  public abandonClaim(
    scheduleId: string,
    dispatchId: string
  ): void {
    validateId(scheduleId, "scheduleId");
    validateId(dispatchId, "dispatchId");
    const schedule = this.require(scheduleId);
    if (schedule.pendingDispatchId !== dispatchId) {
      fail(
        "SCHEDULE_DISPATCH_STALE",
        "schedule pending dispatch no longer matches abandoned claim"
      );
    }
    this.#queue.abandon(dispatchKey(scheduleId, dispatchId));
  }

  public recordTerminal(
    scheduleId: string,
    operationId: string,
    failureCode?: string | null
  ): ScheduleRecord {
    validateId(scheduleId, "scheduleId");
    validateId(operationId, "operationId");
    const normalizedFailureCode =
      failureCode === undefined || failureCode === null
        ? null
        : validateId(failureCode, "failureCode");
    const operation = this.#database.prepare(`
      SELECT state
      FROM operations
      WHERE operation_id = ?
    `).get(operationId);
    const state = operation?.["state"];
    if (
      state !== "SUCCEEDED" &&
      state !== "FAILED_SAFE" &&
      state !== "CANCELLED"
    ) {
      fail(
        "SCHEDULE_OPERATION_INVALID",
        "only terminal child operations can be recorded"
      );
    }
    const schedule = this.require(scheduleId);
    if (schedule.lastDispatchedOperationId !== operationId) {
      fail(
        "SCHEDULE_OPERATION_INVALID",
        "terminal operation is not the schedule's last dispatched child"
      );
    }

    const now = this.#currentDate().toISOString();
    this.#database.prepare(`
      UPDATE schedules
      SET last_terminal_operation_id = ?,
          last_failure_code = ?,
          updated_at = ?,
          revision = revision + 1
      WHERE schedule_id = ?
    `).run(
      operationId,
      normalizedFailureCode,
      now,
      scheduleId
    );
    return this.require(scheduleId);
  }

  #enqueuePending(
    schedule: ScheduleRecord
  ): "ENQUEUED" | "COALESCED" | "BACKPRESSURED" {
    const intent = intentFrom(schedule);
    try {
      return this.#queue.enqueue({
        key: dispatchKey(
          schedule.scheduleId,
          intent.dispatchId
        ),
        priority: schedule.priority,
        fairnessKey: schedule.fairnessKey,
        createdAt: intent.createdAt,
        value: intent
      });
    } catch (error: unknown) {
      if (
        error instanceof WorkQueueError &&
        error.code === "WORK_QUEUE_FULL"
      ) {
        return "BACKPRESSURED";
      }
      throw error;
    }
  }

  #budgetAt(
    schedule: ScheduleRecord,
    effectiveNow: Date
  ): ScheduleBudget | null {
    if (schedule.budget === null) {
      return null;
    }
    const windowStartMs = Date.parse(
      schedule.budget.windowStartedAt
    );
    if (
      effectiveNow.getTime() >=
      windowStartMs + schedule.budget.windowMs
    ) {
      return Object.freeze({
        limit: schedule.budget.limit,
        windowMs: schedule.budget.windowMs,
        windowStartedAt: effectiveNow.toISOString(),
        used: 0
      });
    }
    return schedule.budget;
  }

  #persistClock(
    schedule: ScheduleRecord,
    effectiveNow: Date
  ): void {
    if (schedule.lastClockAt === effectiveNow.toISOString()) {
      return;
    }
    this.#database.prepare(`
      UPDATE schedules
      SET last_clock_at = ?,
          updated_at = ?,
          revision = revision + 1
      WHERE schedule_id = ?
        AND revision = ?
    `).run(
      effectiveNow.toISOString(),
      effectiveNow.toISOString(),
      schedule.scheduleId,
      schedule.revision
    );
  }

  #persistClockAndBudget(
    schedule: ScheduleRecord,
    effectiveNow: Date,
    budget: ScheduleBudget | null,
    nextDueAt = schedule.nextDueAt
  ): void {
    this.#database.prepare(`
      UPDATE schedules
      SET next_due_at = ?,
          last_clock_at = ?,
          budget_window_started_at = ?,
          budget_used = ?,
          updated_at = ?,
          revision = revision + 1
      WHERE schedule_id = ?
        AND revision = ?
    `).run(
      nextDueAt,
      effectiveNow.toISOString(),
      budget?.windowStartedAt ?? null,
      budget?.used ?? null,
      effectiveNow.toISOString(),
      schedule.scheduleId,
      schedule.revision
    );
  }

  #currentDate(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      fail(
        "SCHEDULER_INVALID_INPUT",
        "scheduler clock returned an invalid time"
      );
    }
    return value;
  }
}
