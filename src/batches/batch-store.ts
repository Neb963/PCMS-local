import type { DatabaseSync } from "node:sqlite";

import {
  OperationCoordinator,
  OperationCoordinatorError,
  type OperationRecord,
  type OperationState
} from "../operations/operation-coordinator.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const MAX_BATCH_CHILDREN = 10_000;

export type BatchCancellationOutcome =
  | "CANCELLED_CLEAN"
  | "UNCERTAIN"
  | "NEEDS_HUMAN"
  | "TERMINAL_UNCHANGED"
  | "ERROR";

export type BatchStatus =
  | "ACTIVE"
  | "NEEDS_ATTENTION"
  | "COMPLETE";

export interface CreateBatchInput {
  readonly batchId: string;
  readonly actorSource: string;
  readonly label?: string | null;
  readonly operationIds: readonly string[];
}

export interface BatchChildSnapshot {
  readonly ordinal: number;
  readonly operation: OperationRecord;
  readonly cancellationRequestedAt: string | null;
  readonly cancellationOutcome: BatchCancellationOutcome | null;
  readonly cancellationErrorCode: string | null;
}

export interface BatchStateCounts {
  readonly PREPARED: number;
  readonly RUNNING: number;
  readonly VERIFYING: number;
  readonly SUCCEEDED: number;
  readonly FAILED_SAFE: number;
  readonly UNCERTAIN: number;
  readonly CANCELLED: number;
  readonly NEEDS_HUMAN: number;
}

export interface BatchSnapshot {
  readonly batchId: string;
  readonly actorSource: string;
  readonly label: string | null;
  readonly status: BatchStatus;
  readonly cancellationRequestedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly counts: BatchStateCounts;
  readonly children: readonly BatchChildSnapshot[];
}

export interface BatchCancellationResult {
  readonly batch: BatchSnapshot;
  readonly attemptedChildren: number;
  readonly errorChildren: number;
}

export interface BatchStoreOptions {
  readonly database: DatabaseSync;
  readonly coordinator: OperationCoordinator;
  readonly now?: () => Date;
}

export type BatchStoreErrorCode =
  | "BATCH_INVALID_INPUT"
  | "BATCH_NOT_FOUND"
  | "BATCH_CONFLICT"
  | "BATCH_ROW_INVALID";

export class BatchStoreError extends Error {
  public constructor(
    public readonly code: BatchStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BatchStoreError";
  }
}

interface BatchRow {
  readonly batch_id: unknown;
  readonly actor_source: unknown;
  readonly label: unknown;
  readonly cancellation_requested_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly revision: unknown;
}

interface BatchChildRow {
  readonly ordinal: unknown;
  readonly operation_id: unknown;
  readonly cancellation_requested_at: unknown;
  readonly cancellation_outcome: unknown;
  readonly cancellation_error_code: unknown;
}

function fail(
  code: BatchStoreErrorCode,
  message: string
): never {
  throw new BatchStoreError(code, message);
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

function validateId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) {
    fail("BATCH_INVALID_INPUT", `${label} has invalid syntax`);
  }
  return value;
}

function boundedText(
  value: string,
  label: string,
  maxLength: number
): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength) {
    fail(
      "BATCH_INVALID_INPUT",
      `${label} must contain 1-${maxLength} characters`
    );
  }
  return normalized;
}

function nullableText(
  value: string | null | undefined,
  label: string,
  maxLength: number
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return boundedText(value, label, maxLength);
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
      "BATCH_ROW_INVALID",
      `stored ${label} is invalid`
    );
  }
  return value;
}

function parseCancellationOutcome(
  value: unknown
): BatchCancellationOutcome | null {
  if (value === null) {
    return null;
  }
  if (
    value === "CANCELLED_CLEAN" ||
    value === "UNCERTAIN" ||
    value === "NEEDS_HUMAN" ||
    value === "TERMINAL_UNCHANGED" ||
    value === "ERROR"
  ) {
    return value;
  }
  fail(
    "BATCH_ROW_INVALID",
    "stored batch cancellation outcome is invalid"
  );
}

function emptyCounts(): Record<OperationState, number> {
  return {
    PREPARED: 0,
    RUNNING: 0,
    VERIFYING: 0,
    SUCCEEDED: 0,
    FAILED_SAFE: 0,
    UNCERTAIN: 0,
    CANCELLED: 0,
    NEEDS_HUMAN: 0
  };
}

function batchStatus(
  counts: BatchStateCounts,
  total: number
): BatchStatus {
  const terminal =
    counts.SUCCEEDED +
    counts.FAILED_SAFE +
    counts.CANCELLED;
  if (terminal === total) {
    return "COMPLETE";
  }
  if (counts.UNCERTAIN > 0 || counts.NEEDS_HUMAN > 0) {
    return "NEEDS_ATTENTION";
  }
  return "ACTIVE";
}

function cancellationOutcomeFor(
  operation: OperationRecord
): BatchCancellationOutcome {
  if (operation.state === "CANCELLED") {
    return "CANCELLED_CLEAN";
  }
  if (operation.state === "UNCERTAIN") {
    return "UNCERTAIN";
  }
  if (operation.state === "NEEDS_HUMAN") {
    return "NEEDS_HUMAN";
  }
  return "TERMINAL_UNCHANGED";
}

function isTerminal(state: OperationState): boolean {
  return (
    state === "SUCCEEDED" ||
    state === "FAILED_SAFE" ||
    state === "CANCELLED"
  );
}

export class BatchStore {
  readonly #database: DatabaseSync;
  readonly #coordinator: OperationCoordinator;
  readonly #now: () => Date;

  public constructor(options: BatchStoreOptions) {
    this.#database = options.database;
    this.#coordinator = options.coordinator;
    this.#now = options.now ?? (() => new Date());
  }

  public create(input: CreateBatchInput): BatchSnapshot {
    const batchId = validateId(input.batchId, "batchId");
    const actorSource = boundedText(
      input.actorSource,
      "actorSource",
      128
    );
    const label = nullableText(input.label, "label", 256);
    if (
      !Array.isArray(input.operationIds) ||
      input.operationIds.length < 1 ||
      input.operationIds.length > MAX_BATCH_CHILDREN
    ) {
      fail(
        "BATCH_INVALID_INPUT",
        `operationIds must contain 1-${MAX_BATCH_CHILDREN} children`
      );
    }

    const operationIds = input.operationIds.map((operationId) =>
      validateId(operationId, "operationId")
    );
    if (new Set(operationIds).size !== operationIds.length) {
      fail(
        "BATCH_INVALID_INPUT",
        "batch child operation IDs must be unique"
      );
    }
    for (const operationId of operationIds) {
      this.#coordinator.require(operationId);
    }

    const now = this.#currentIso();
    transaction(this.#database, () => {
      const existing = this.#database.prepare(`
        SELECT 1
        FROM batches
        WHERE batch_id = ?
      `).get(batchId);
      if (existing !== undefined) {
        fail(
          "BATCH_CONFLICT",
          `batch ${batchId} already exists`
        );
      }

      this.#database.prepare(`
        INSERT INTO batches (
          batch_id,
          actor_source,
          label,
          cancellation_requested_at,
          created_at,
          updated_at,
          revision
        ) VALUES (?, ?, ?, NULL, ?, ?, 0)
      `).run(
        batchId,
        actorSource,
        label,
        now,
        now
      );

      const insertChild = this.#database.prepare(`
        INSERT INTO batch_children (
          batch_id,
          ordinal,
          operation_id,
          cancellation_requested_at,
          cancellation_outcome,
          cancellation_error_code
        ) VALUES (?, ?, ?, NULL, NULL, NULL)
      `);
      operationIds.forEach((operationId, ordinal) => {
        insertChild.run(batchId, ordinal, operationId);
      });
    });

    return this.require(batchId);
  }

  public get(batchId: string): BatchSnapshot | null {
    validateId(batchId, "batchId");
    const row = this.#database.prepare(`
      SELECT
        batch_id,
        actor_source,
        label,
        cancellation_requested_at,
        created_at,
        updated_at,
        revision
      FROM batches
      WHERE batch_id = ?
    `).get(batchId) as unknown as BatchRow | undefined;
    if (row === undefined) {
      return null;
    }
    return this.#snapshotFromRow(row);
  }

  public require(batchId: string): BatchSnapshot {
    const batch = this.get(batchId);
    if (batch === null) {
      fail(
        "BATCH_NOT_FOUND",
        `batch ${batchId} does not exist`
      );
    }
    return batch;
  }

  public requestCancellation(
    batchId: string
  ): BatchCancellationResult {
    validateId(batchId, "batchId");
    const now = this.#currentIso();

    transaction(this.#database, () => {
      const current = this.#database.prepare(`
        SELECT revision
        FROM batches
        WHERE batch_id = ?
      `).get(batchId);
      if (current === undefined) {
        fail(
          "BATCH_NOT_FOUND",
          `batch ${batchId} does not exist`
        );
      }
      this.#database.prepare(`
        UPDATE batches
        SET cancellation_requested_at =
              COALESCE(cancellation_requested_at, ?),
            updated_at = ?,
            revision = revision + 1
        WHERE batch_id = ?
      `).run(now, now, batchId);
    });

    const rows = this.#database.prepare(`
      SELECT
        ordinal,
        operation_id,
        cancellation_requested_at,
        cancellation_outcome,
        cancellation_error_code
      FROM batch_children
      WHERE batch_id = ?
      ORDER BY ordinal
    `).all(batchId) as unknown as BatchChildRow[];

    let attemptedChildren = 0;
    let errorChildren = 0;
    for (const row of rows) {
      if (typeof row.operation_id !== "string") {
        fail(
          "BATCH_ROW_INVALID",
          "stored batch child operation ID is invalid"
        );
      }
      const operationId = row.operation_id;
      const current = this.#coordinator.require(operationId);
      let outcome: BatchCancellationOutcome;
      let errorCode: string | null = null;

      if (isTerminal(current.state)) {
        outcome = "TERMINAL_UNCHANGED";
      } else {
        attemptedChildren += 1;
        try {
          const cancelled = this.#coordinator.requestCancellation(
            current.operationId,
            current.claimEpoch,
            "batch-cancellation-requested"
          );
          outcome = cancellationOutcomeFor(cancelled);
        } catch (error: unknown) {
          outcome = "ERROR";
          errorChildren += 1;
          errorCode =
            error instanceof OperationCoordinatorError
              ? error.code
              : "UNEXPECTED";
        }
      }

      this.#database.prepare(`
        UPDATE batch_children
        SET cancellation_requested_at = ?,
            cancellation_outcome = ?,
            cancellation_error_code = ?
        WHERE batch_id = ?
          AND operation_id = ?
      `).run(
        now,
        outcome,
        errorCode,
        batchId,
        operationId
      );
    }

    return Object.freeze({
      batch: this.require(batchId),
      attemptedChildren,
      errorChildren
    });
  }

  #snapshotFromRow(row: BatchRow): BatchSnapshot {
    if (
      typeof row.batch_id !== "string" ||
      typeof row.actor_source !== "string" ||
      typeof row.created_at !== "string" ||
      typeof row.updated_at !== "string" ||
      typeof row.revision !== "number" ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0
    ) {
      fail(
        "BATCH_ROW_INVALID",
        "stored batch row is invalid"
      );
    }

    const childRows = this.#database.prepare(`
      SELECT
        ordinal,
        operation_id,
        cancellation_requested_at,
        cancellation_outcome,
        cancellation_error_code
      FROM batch_children
      WHERE batch_id = ?
      ORDER BY ordinal
    `).all(row.batch_id) as unknown as BatchChildRow[];

    if (childRows.length < 1) {
      fail(
        "BATCH_ROW_INVALID",
        "stored batch has no child operations"
      );
    }

    const counts = emptyCounts();
    const children = childRows.map((childRow) => {
      if (
        typeof childRow.ordinal !== "number" ||
        !Number.isSafeInteger(childRow.ordinal) ||
        childRow.ordinal < 0 ||
        typeof childRow.operation_id !== "string"
      ) {
        fail(
          "BATCH_ROW_INVALID",
          "stored batch child row is invalid"
        );
      }
      const operation = this.#coordinator.require(
        childRow.operation_id
      );
      counts[operation.state] += 1;
      return Object.freeze({
        ordinal: childRow.ordinal,
        operation,
        cancellationRequestedAt: nullableStoredText(
          childRow.cancellation_requested_at,
          "child cancellationRequestedAt"
        ),
        cancellationOutcome: parseCancellationOutcome(
          childRow.cancellation_outcome
        ),
        cancellationErrorCode: nullableStoredText(
          childRow.cancellation_error_code,
          "child cancellationErrorCode"
        )
      });
    });

    const frozenCounts: BatchStateCounts = Object.freeze({
      PREPARED: counts.PREPARED,
      RUNNING: counts.RUNNING,
      VERIFYING: counts.VERIFYING,
      SUCCEEDED: counts.SUCCEEDED,
      FAILED_SAFE: counts.FAILED_SAFE,
      UNCERTAIN: counts.UNCERTAIN,
      CANCELLED: counts.CANCELLED,
      NEEDS_HUMAN: counts.NEEDS_HUMAN
    });

    return Object.freeze({
      batchId: row.batch_id,
      actorSource: row.actor_source,
      label: nullableStoredText(row.label, "batch label"),
      status: batchStatus(frozenCounts, children.length),
      cancellationRequestedAt: nullableStoredText(
        row.cancellation_requested_at,
        "batch cancellationRequestedAt"
      ),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      counts: frozenCounts,
      children: Object.freeze(children)
    });
  }

  #currentIso(): string {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      fail(
        "BATCH_INVALID_INPUT",
        "batch clock returned an invalid time"
      );
    }
    return value.toISOString();
  }
}
