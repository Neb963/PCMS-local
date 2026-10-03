import type { DatabaseSync } from "node:sqlite";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_KIND = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SAFE_METADATA_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SENSITIVE_METADATA_KEY =
  /(password|passwd|secret|token|cookie|authorization|verification[-_]?code|private[-_]?key)/iu;
const MAX_EVIDENCE_ENTRIES = 32;
const MAX_EVIDENCE_VALUE_LENGTH = 1024;
const MAX_TRANSIENT_INPUT_LENGTH = 4096;
const MAX_TRANSIENT_INPUT_TTL_MS = 15 * 60 * 1000;

export type HumanTaskStatus =
  | "OPEN"
  | "RESOLVED"
  | "CANCELLED"
  | "EXPIRED";

export type HumanTaskEvidenceValue =
  | string
  | number
  | boolean
  | null;

export type HumanTaskEvidence = Readonly<
  Record<string, HumanTaskEvidenceValue>
>;

export interface HumanTaskContinuationDescriptor {
  readonly kind: string;
  readonly version: number;
  readonly ref: string;
}

export interface HumanTaskRecord {
  readonly taskId: string;
  readonly taskType: string;
  readonly status: HumanTaskStatus;
  readonly accountId: string | null;
  readonly personaUid: string | null;
  readonly operationId: string | null;
  readonly title: string;
  readonly explanation: string;
  readonly requiredActionKind: string;
  readonly continuation: HumanTaskContinuationDescriptor;
  readonly evidence: HumanTaskEvidence;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
  readonly revision: number;
}

export interface CreateHumanTaskInput {
  readonly taskId: string;
  readonly taskType: string;
  readonly accountId?: string | null;
  readonly personaUid?: string | null;
  readonly operationId?: string | null;
  readonly title: string;
  readonly explanation: string;
  readonly requiredActionKind: string;
  readonly continuation: HumanTaskContinuationDescriptor;
  readonly evidence: HumanTaskEvidence;
  readonly expiresAt?: string | null;
}

export interface TransientHumanInputReceipt {
  readonly taskId: string;
  readonly kind: string;
  readonly expiresAt: string;
}

export interface HumanTaskStoreOptions {
  readonly database: DatabaseSync;
  readonly now?: () => Date;
}

export type HumanTaskStoreErrorCode =
  | "HUMAN_TASK_INVALID_INPUT"
  | "HUMAN_TASK_NOT_FOUND"
  | "HUMAN_TASK_CONFLICT"
  | "HUMAN_TASK_NOT_OPEN"
  | "HUMAN_TASK_OPERATION_INVALID"
  | "HUMAN_TASK_EXPIRED"
  | "HUMAN_INPUT_UNAVAILABLE"
  | "HUMAN_TASK_ROW_INVALID";

export class HumanTaskStoreError extends Error {
  public constructor(
    public readonly code: HumanTaskStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HumanTaskStoreError";
  }
}

interface HumanTaskRow {
  readonly task_id: unknown;
  readonly task_type: unknown;
  readonly status: unknown;
  readonly account_id: unknown;
  readonly persona_uid: unknown;
  readonly operation_id: unknown;
  readonly title: unknown;
  readonly explanation: unknown;
  readonly required_action_kind: unknown;
  readonly continuation_kind: unknown;
  readonly continuation_version: unknown;
  readonly continuation_ref: unknown;
  readonly evidence_json: unknown;
  readonly expires_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly resolved_at: unknown;
  readonly revision: unknown;
}

interface TransientInput {
  readonly kind: string;
  readonly value: string;
  readonly expiresAtMs: number;
}

function fail(
  code: HumanTaskStoreErrorCode,
  message: string
): never {
  throw new HumanTaskStoreError(code, message);
}

function transaction<T>(
  database: DatabaseSync,
  operation: () => T
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

function plainObject(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
    )
  );
}

function validateId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) {
    fail("HUMAN_TASK_INVALID_INPUT", `${label} has invalid syntax`);
  }
  return value;
}

function validateKind(value: string, label: string): string {
  if (!SAFE_KIND.test(value)) {
    fail("HUMAN_TASK_INVALID_INPUT", `${label} has invalid syntax`);
  }
  return value;
}

function nullableId(
  value: string | null | undefined,
  label: string
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return validateId(value, label);
}

function boundedText(
  value: string,
  label: string,
  maxLength: number
): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength) {
    fail(
      "HUMAN_TASK_INVALID_INPUT",
      `${label} must contain 1-${maxLength} characters`
    );
  }
  return normalized;
}

function normalizeTimestamp(
  value: string,
  label: string
): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    fail(
      "HUMAN_TASK_INVALID_INPUT",
      `${label} must be a valid timestamp`
    );
  }
  return new Date(milliseconds).toISOString();
}

function normalizeEvidence(
  value: HumanTaskEvidence
): HumanTaskEvidence {
  if (!plainObject(value)) {
    fail(
      "HUMAN_TASK_INVALID_INPUT",
      "HumanTask evidence must be a plain object"
    );
  }
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_EVIDENCE_ENTRIES) {
    fail(
      "HUMAN_TASK_INVALID_INPUT",
      "HumanTask evidence contains too many entries"
    );
  }

  const normalized: Record<string, HumanTaskEvidenceValue> = {};
  for (const key of keys) {
    if (
      !SAFE_METADATA_KEY.test(key) ||
      SENSITIVE_METADATA_KEY.test(key)
    ) {
      fail(
        "HUMAN_TASK_INVALID_INPUT",
        `HumanTask evidence contains unsafe key: ${key}`
      );
    }
    const item = value[key];
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      fail(
        "HUMAN_TASK_INVALID_INPUT",
        "HumanTask evidence values must be scalar JSON values"
      );
    }
    if (
      typeof item === "string" &&
      item.length > MAX_EVIDENCE_VALUE_LENGTH
    ) {
      fail(
        "HUMAN_TASK_INVALID_INPUT",
        "HumanTask evidence string is too large"
      );
    }
    if (
      typeof item === "number" &&
      (!Number.isFinite(item) || !Number.isSafeInteger(item))
    ) {
      fail(
        "HUMAN_TASK_INVALID_INPUT",
        "HumanTask evidence numbers must be safe integers"
      );
    }
    normalized[key] = item;
  }

  const serialized = JSON.stringify(normalized);
  if (serialized.length > 8192) {
    fail(
      "HUMAN_TASK_INVALID_INPUT",
      "HumanTask evidence is too large"
    );
  }
  return Object.freeze(normalized);
}

function normalizeContinuation(
  value: HumanTaskContinuationDescriptor
): HumanTaskContinuationDescriptor {
  validateKind(value.kind, "continuation kind");
  if (!Number.isSafeInteger(value.version) || value.version < 1) {
    fail(
      "HUMAN_TASK_INVALID_INPUT",
      "continuation version must be a positive safe integer"
    );
  }
  if (!SAFE_REF.test(value.ref)) {
    fail(
      "HUMAN_TASK_INVALID_INPUT",
      "continuation ref has invalid syntax"
    );
  }
  return Object.freeze({
    kind: value.kind,
    version: value.version,
    ref: value.ref
  });
}

function parseStatus(value: unknown): HumanTaskStatus {
  if (
    value === "OPEN" ||
    value === "RESOLVED" ||
    value === "CANCELLED" ||
    value === "EXPIRED"
  ) {
    return value;
  }
  fail(
    "HUMAN_TASK_ROW_INVALID",
    "stored HumanTask status is invalid"
  );
}

function nullableString(
  value: unknown,
  label: string
): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    fail(
      "HUMAN_TASK_ROW_INVALID",
      `stored ${label} is invalid`
    );
  }
  return value;
}

function parseRow(
  row: HumanTaskRow | undefined
): HumanTaskRecord | null {
  if (row === undefined) {
    return null;
  }
  if (
    typeof row.task_id !== "string" ||
    typeof row.task_type !== "string" ||
    typeof row.title !== "string" ||
    typeof row.explanation !== "string" ||
    typeof row.required_action_kind !== "string" ||
    typeof row.continuation_kind !== "string" ||
    typeof row.continuation_version !== "number" ||
    !Number.isSafeInteger(row.continuation_version) ||
    row.continuation_version < 1 ||
    typeof row.continuation_ref !== "string" ||
    typeof row.evidence_json !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string" ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    fail(
      "HUMAN_TASK_ROW_INVALID",
      "stored HumanTask row contains invalid metadata"
    );
  }

  let evidence: HumanTaskEvidence;
  try {
    evidence = normalizeEvidence(
      JSON.parse(row.evidence_json) as HumanTaskEvidence
    );
  } catch (error: unknown) {
    if (error instanceof HumanTaskStoreError) {
      fail(
        "HUMAN_TASK_ROW_INVALID",
        "stored HumanTask evidence is invalid"
      );
    }
    fail(
      "HUMAN_TASK_ROW_INVALID",
      "stored HumanTask evidence is not JSON"
    );
  }

  return Object.freeze({
    taskId: row.task_id,
    taskType: row.task_type,
    status: parseStatus(row.status),
    accountId: nullableString(row.account_id, "accountId"),
    personaUid: nullableString(row.persona_uid, "personaUid"),
    operationId: nullableString(row.operation_id, "operationId"),
    title: row.title,
    explanation: row.explanation,
    requiredActionKind: row.required_action_kind,
    continuation: Object.freeze({
      kind: row.continuation_kind,
      version: row.continuation_version,
      ref: row.continuation_ref
    }),
    evidence,
    expiresAt: nullableString(row.expires_at, "expiresAt"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: nullableString(row.resolved_at, "resolvedAt"),
    revision: row.revision
  });
}

function selectTaskSql(where: string): string {
  return `
    SELECT
      task_id,
      task_type,
      status,
      account_id,
      persona_uid,
      operation_id,
      title,
      explanation,
      required_action_kind,
      continuation_kind,
      continuation_version,
      continuation_ref,
      evidence_json,
      expires_at,
      created_at,
      updated_at,
      resolved_at,
      revision
    FROM human_tasks
    WHERE ${where}
  `;
}

export class HumanTaskStore {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;
  readonly #transientInputs = new Map<string, TransientInput>();

  public constructor(options: HumanTaskStoreOptions) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
  }

  public get(taskId: string): HumanTaskRecord | null {
    validateId(taskId, "taskId");
    const row = this.#database.prepare(
      selectTaskSql("task_id = ?")
    ).get(taskId) as unknown as HumanTaskRow | undefined;
    return parseRow(row);
  }

  public require(taskId: string): HumanTaskRecord {
    const task = this.get(taskId);
    if (task === null) {
      fail(
        "HUMAN_TASK_NOT_FOUND",
        `HumanTask ${taskId} does not exist`
      );
    }
    return task;
  }

  public listOpen(): readonly HumanTaskRecord[] {
    const rows = this.#database.prepare(
      selectTaskSql("status = 'OPEN' ORDER BY created_at, task_id")
    ).all() as unknown as HumanTaskRow[];
    return Object.freeze(
      rows.map((row) => {
        const task = parseRow(row);
        if (task === null) {
          fail(
            "HUMAN_TASK_ROW_INVALID",
            "open HumanTask disappeared during read"
          );
        }
        return task;
      })
    );
  }

  public create(input: CreateHumanTaskInput): HumanTaskRecord {
    const taskId = validateId(input.taskId, "taskId");
    const taskType = validateKind(input.taskType, "taskType");
    const accountId = nullableId(input.accountId, "accountId");
    const personaUid = nullableId(input.personaUid, "personaUid");
    const operationId = nullableId(input.operationId, "operationId");
    const title = boundedText(input.title, "title", 256);
    const explanation = boundedText(
      input.explanation,
      "explanation",
      1024
    );
    const requiredActionKind = validateKind(
      input.requiredActionKind,
      "requiredActionKind"
    );
    const continuation = normalizeContinuation(input.continuation);
    const evidence = normalizeEvidence(input.evidence);
    const expiresAt =
      input.expiresAt === undefined || input.expiresAt === null
        ? null
        : normalizeTimestamp(input.expiresAt, "expiresAt");
    const now = this.#currentDate();
    if (
      expiresAt !== null &&
      Date.parse(expiresAt) <= now.getTime()
    ) {
      fail(
        "HUMAN_TASK_INVALID_INPUT",
        "HumanTask expiresAt must be in the future"
      );
    }

    return transaction(this.#database, () => {
      const existing = this.get(taskId);
      if (existing !== null) {
        fail(
          "HUMAN_TASK_CONFLICT",
          `HumanTask ${taskId} already exists`
        );
      }

      let ownerModuleId: string | null = null;
      if (operationId !== null) {
        const operation = this.#database.prepare(`
          SELECT
            state,
            account_id,
            persona_uid,
            owner_module_id
          FROM operations
          WHERE operation_id = ?
        `).get(operationId);
        if (
          operation === undefined ||
          operation["state"] !== "NEEDS_HUMAN"
        ) {
          fail(
            "HUMAN_TASK_OPERATION_INVALID",
            "linked operation must exist in NEEDS_HUMAN state"
          );
        }
        if (
          accountId !== null &&
          operation["account_id"] !== accountId
        ) {
          fail(
            "HUMAN_TASK_OPERATION_INVALID",
            "HumanTask account does not match linked operation"
          );
        }
        if (
          personaUid !== null &&
          operation["persona_uid"] !== personaUid
        ) {
          fail(
            "HUMAN_TASK_OPERATION_INVALID",
            "HumanTask Persona does not match linked operation"
          );
        }
        const candidateModuleId = operation["owner_module_id"];
        if (
          candidateModuleId !== null &&
          typeof candidateModuleId !== "string"
        ) {
          fail(
            "HUMAN_TASK_OPERATION_INVALID",
            "linked operation owner metadata is invalid"
          );
        }
        ownerModuleId = candidateModuleId;
      }

      try {
        this.#database.prepare(`
          INSERT INTO human_tasks (
            task_id,
            task_type,
            status,
            account_id,
            persona_uid,
            operation_id,
            title,
            explanation,
            required_action_kind,
            continuation_kind,
            continuation_version,
            continuation_ref,
            evidence_json,
            expires_at,
            created_at,
            updated_at,
            resolved_at,
            revision
          ) VALUES (
            ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0
          )
        `).run(
          taskId,
          taskType,
          accountId,
          personaUid,
          operationId,
          title,
          explanation,
          requiredActionKind,
          continuation.kind,
          continuation.version,
          continuation.ref,
          JSON.stringify(evidence),
          expiresAt,
          now.toISOString(),
          now.toISOString()
        );
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message.includes(
            "human_tasks_one_open_action_per_operation"
          )
        ) {
          fail(
            "HUMAN_TASK_CONFLICT",
            "linked operation already has an open task for this action"
          );
        }
        throw error;
      }

      if (ownerModuleId !== null) {
        this.#recordModuleEvidence(
          ownerModuleId,
          taskId,
          now.toISOString()
        );
      }
      return this.require(taskId);
    });
  }

  public resolve(taskId: string): HumanTaskRecord {
    validateId(taskId, "taskId");
    const now = this.#currentDate().toISOString();
    return transaction(this.#database, () => {
      const task = this.require(taskId);
      if (task.status === "RESOLVED") {
        return task;
      }
      if (task.status !== "OPEN") {
        fail(
          "HUMAN_TASK_NOT_OPEN",
          `HumanTask ${taskId} is ${task.status}`
        );
      }
      const result = this.#database.prepare(`
        UPDATE human_tasks
        SET status = 'RESOLVED',
            updated_at = ?,
            resolved_at = ?,
            revision = revision + 1
        WHERE task_id = ?
          AND status = 'OPEN'
      `).run(now, now, taskId);
      if (result.changes !== 1) {
        fail(
          "HUMAN_TASK_CONFLICT",
          "HumanTask changed during resolution"
        );
      }
      this.#transientInputs.delete(taskId);
      this.#resolveModuleEvidence(task, now);
      return this.require(taskId);
    });
  }

  public expireDue(): readonly string[] {
    const now = this.#currentDate();
    const due = this.#database.prepare(`
      SELECT task_id
      FROM human_tasks
      WHERE status = 'OPEN'
        AND expires_at IS NOT NULL
        AND expires_at <= ?
      ORDER BY task_id
    `).all(now.toISOString());
    const expired: string[] = [];
    for (const row of due) {
      const taskId = row["task_id"];
      if (typeof taskId !== "string") {
        fail(
          "HUMAN_TASK_ROW_INVALID",
          "expiring HumanTask ID is invalid"
        );
      }
      transaction(this.#database, () => {
        const task = this.require(taskId);
        if (task.status !== "OPEN") {
          return;
        }
        const timestamp = now.toISOString();
        const result = this.#database.prepare(`
          UPDATE human_tasks
          SET status = 'EXPIRED',
              updated_at = ?,
              resolved_at = ?,
              revision = revision + 1
          WHERE task_id = ?
            AND status = 'OPEN'
        `).run(timestamp, timestamp, taskId);
        if (result.changes === 1) {
          this.#transientInputs.delete(taskId);
          this.#resolveModuleEvidence(task, timestamp);
          expired.push(taskId);
        }
      });
    }
    return Object.freeze(expired);
  }

  public submitTransientInput(
    taskId: string,
    kind: string,
    value: string,
    ttlMs: number
  ): TransientHumanInputReceipt {
    const task = this.require(taskId);
    if (task.status !== "OPEN") {
      fail(
        "HUMAN_TASK_NOT_OPEN",
        `HumanTask ${taskId} is ${task.status}`
      );
    }
    const now = this.#currentDate();
    if (
      task.expiresAt !== null &&
      Date.parse(task.expiresAt) <= now.getTime()
    ) {
      this.expireDue();
      fail(
        "HUMAN_TASK_EXPIRED",
        `HumanTask ${taskId} has expired`
      );
    }

    const inputKind = validateKind(kind, "transient input kind");
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > MAX_TRANSIENT_INPUT_LENGTH
    ) {
      fail(
        "HUMAN_TASK_INVALID_INPUT",
        "transient input must be a non-empty bounded string"
      );
    }
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > MAX_TRANSIENT_INPUT_TTL_MS
    ) {
      fail(
        "HUMAN_TASK_INVALID_INPUT",
        `transient input ttlMs must be between 1 and ${MAX_TRANSIENT_INPUT_TTL_MS}`
      );
    }

    const expiresAtMs = now.getTime() + ttlMs;
    this.#transientInputs.set(taskId, {
      kind: inputKind,
      value,
      expiresAtMs
    });
    return Object.freeze({
      taskId,
      kind: inputKind,
      expiresAt: new Date(expiresAtMs).toISOString()
    });
  }

  public consumeTransientInput(
    taskId: string,
    expectedKind: string
  ): string {
    this.require(taskId);
    const kind = validateKind(
      expectedKind,
      "expected transient input kind"
    );
    const input = this.#transientInputs.get(taskId);
    const nowMs = this.#currentDate().getTime();
    if (
      input === undefined ||
      input.kind !== kind ||
      input.expiresAtMs <= nowMs
    ) {
      this.#transientInputs.delete(taskId);
      fail(
        "HUMAN_INPUT_UNAVAILABLE",
        "transient human input is unavailable or expired"
      );
    }
    this.#transientInputs.delete(taskId);
    return input.value;
  }

  #recordModuleEvidence(
    moduleId: string,
    taskId: string,
    now: string
  ): void {
    this.#database.prepare(`
      INSERT INTO module_lifecycle_evidence (
        module_id,
        evidence_kind,
        evidence_id,
        unresolved,
        created_at,
        updated_at,
        resolved_at
      ) VALUES (?, 'HUMAN_TASK', ?, 1, ?, ?, NULL)
      ON CONFLICT(module_id, evidence_kind, evidence_id)
      DO UPDATE SET
        unresolved = 1,
        updated_at = excluded.updated_at,
        resolved_at = NULL
    `).run(moduleId, taskId, now, now);
  }

  #resolveModuleEvidence(
    task: HumanTaskRecord,
    now: string
  ): void {
    if (task.operationId === null) {
      return;
    }
    const operation = this.#database.prepare(`
      SELECT owner_module_id
      FROM operations
      WHERE operation_id = ?
    `).get(task.operationId);
    const moduleId = operation?.["owner_module_id"];
    if (moduleId === null || moduleId === undefined) {
      return;
    }
    if (typeof moduleId !== "string") {
      fail(
        "HUMAN_TASK_OPERATION_INVALID",
        "linked operation owner metadata is invalid"
      );
    }
    this.#database.prepare(`
      UPDATE module_lifecycle_evidence
      SET unresolved = 0,
          updated_at = ?,
          resolved_at = ?
      WHERE module_id = ?
        AND evidence_kind = 'HUMAN_TASK'
        AND evidence_id = ?
        AND unresolved = 1
    `).run(now, now, moduleId, task.taskId);
  }

  #currentDate(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      fail(
        "HUMAN_TASK_INVALID_INPUT",
        "HumanTask clock returned an invalid time"
      );
    }
    return value;
  }
}
