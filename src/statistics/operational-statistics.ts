import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

const OPERATION_STATES = Object.freeze([
  "PREPARED",
  "RUNNING",
  "VERIFYING",
  "SUCCEEDED",
  "FAILED_SAFE",
  "UNCERTAIN",
  "CANCELLED",
  "NEEDS_HUMAN"
] as const);

const OWNER_KINDS = Object.freeze([
  "CORE",
  "MODULE"
] as const);

export type StatisticsOperationState =
  (typeof OPERATION_STATES)[number];

export type StatisticsOwnerKind =
  (typeof OWNER_KINDS)[number];

export interface StatisticsStateBucket {
  readonly state: StatisticsOperationState;
  readonly count: number;
}

export interface StatisticsOperationKindBucket {
  readonly operationKind: string;
  readonly count: number;
}

export interface StatisticsOwnerBucket {
  readonly ownerKind: StatisticsOwnerKind;
  readonly count: number;
}

export interface OperationalStatisticsSnapshot {
  readonly totalOperations: number;
  readonly unresolvedOperations: number;
  readonly terminalOperations: number;
  readonly byState: readonly StatisticsStateBucket[];
  readonly byOperationKind: readonly StatisticsOperationKindBucket[];
  readonly byOwnerKind: readonly StatisticsOwnerBucket[];
  readonly oldestCreatedAt: string | null;
  readonly latestUpdatedAt: string | null;
}

export class OperationalStatisticsError extends Error {
  public readonly code: string;

  public constructor(
    code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "OperationalStatisticsError";
    this.code = code;
  }
}

function fail(
  code: string,
  message: string,
  cause?: unknown
): never {
  throw new OperationalStatisticsError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function parseCount(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail(
      "STATISTICS_FACTS_CORRUPT",
      `operational facts returned an invalid ${label} count`
    );
  }
  return value;
}

function parseNullableTimestamp(
  value: unknown,
  label: string
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    fail(
      "STATISTICS_FACTS_CORRUPT",
      `operational facts returned an invalid ${label} timestamp`
    );
  }
  return value;
}

function stateCount(
  buckets: readonly StatisticsStateBucket[],
  state: StatisticsOperationState
): number {
  return buckets.find((bucket) => bucket.state === state)?.count ?? 0;
}

export class OperationalStatistics {
  readonly #database: DatabaseSync;
  #closed = false;

  public constructor(databasePath: string) {
    if (!isAbsolute(databasePath)) {
      fail(
        "INVALID_STATISTICS_DATABASE",
        "statistics database path must be absolute"
      );
    }

    try {
      this.#database = new DatabaseSync(databasePath, {
        readOnly: true,
        allowExtension: false,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        timeout: 5_000
      });
      this.#database.enableLoadExtension(false);
      this.#database.exec(`
        PRAGMA query_only = ON;
        PRAGMA trusted_schema = OFF;
      `);
    } catch (error: unknown) {
      fail(
        "STATISTICS_DATABASE_OPEN_FAILED",
        "failed to open read-only operational facts database",
        error
      );
    }
  }

  public snapshot(): OperationalStatisticsSnapshot {
    if (this.#closed) {
      fail(
        "STATISTICS_DATABASE_CLOSED",
        "statistics projection is closed"
      );
    }

    const stateRows = this.#database.prepare(`
      SELECT state, count(*) AS count
      FROM operations
      GROUP BY state
      ORDER BY state
    `).all() as unknown as readonly Record<string, unknown>[];

    const byState = Object.freeze(
      stateRows.map((row): StatisticsStateBucket => {
        const state = row["state"];
        if (
          typeof state !== "string" ||
          !OPERATION_STATES.some((candidate) => candidate === state)
        ) {
          fail(
            "STATISTICS_FACTS_CORRUPT",
            "operational facts returned an unknown operation state"
          );
        }
        return Object.freeze({
          state: state as StatisticsOperationState,
          count: parseCount(row["count"], state)
        });
      })
    );

    const operationKindRows = this.#database.prepare(`
      SELECT operation_kind, count(*) AS count
      FROM operations
      GROUP BY operation_kind
      ORDER BY operation_kind
    `).all() as unknown as readonly Record<string, unknown>[];

    const byOperationKind = Object.freeze(
      operationKindRows.map(
        (row): StatisticsOperationKindBucket => {
          const operationKind = row["operation_kind"];
          if (
            typeof operationKind !== "string" ||
            operationKind.length < 1 ||
            operationKind.length > 128
          ) {
            fail(
              "STATISTICS_FACTS_CORRUPT",
              "operational facts returned an invalid operation kind"
            );
          }
          return Object.freeze({
            operationKind,
            count: parseCount(row["count"], operationKind)
          });
        }
      )
    );

    const ownerRows = this.#database.prepare(`
      SELECT owner_kind, count(*) AS count
      FROM operations
      GROUP BY owner_kind
      ORDER BY owner_kind
    `).all() as unknown as readonly Record<string, unknown>[];

    const byOwnerKind = Object.freeze(
      ownerRows.map((row): StatisticsOwnerBucket => {
        const ownerKind = row["owner_kind"];
        if (
          typeof ownerKind !== "string" ||
          !OWNER_KINDS.some((candidate) => candidate === ownerKind)
        ) {
          fail(
            "STATISTICS_FACTS_CORRUPT",
            "operational facts returned an unknown owner kind"
          );
        }
        return Object.freeze({
          ownerKind: ownerKind as StatisticsOwnerKind,
          count: parseCount(row["count"], ownerKind)
        });
      })
    );

    const bounds = this.#database.prepare(`
      SELECT
        count(*) AS total,
        min(created_at) AS oldest_created_at,
        max(updated_at) AS latest_updated_at
      FROM operations
    `).get() as Record<string, unknown> | undefined;
    if (bounds === undefined) {
      fail(
        "STATISTICS_FACTS_CORRUPT",
        "operational facts did not return aggregate bounds"
      );
    }

    const unresolvedOperations =
      stateCount(byState, "PREPARED") +
      stateCount(byState, "RUNNING") +
      stateCount(byState, "VERIFYING") +
      stateCount(byState, "UNCERTAIN") +
      stateCount(byState, "NEEDS_HUMAN");
    const terminalOperations =
      stateCount(byState, "SUCCEEDED") +
      stateCount(byState, "FAILED_SAFE") +
      stateCount(byState, "CANCELLED");

    return Object.freeze({
      totalOperations: parseCount(
        bounds["total"],
        "total operation"
      ),
      unresolvedOperations,
      terminalOperations,
      byState,
      byOperationKind,
      byOwnerKind,
      oldestCreatedAt: parseNullableTimestamp(
        bounds["oldest_created_at"],
        "oldest-created"
      ),
      latestUpdatedAt: parseNullableTimestamp(
        bounds["latest_updated_at"],
        "latest-updated"
      )
    });
  }

  public close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}
