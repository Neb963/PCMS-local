import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export interface SqlitePragmaState {
  readonly foreignKeys: boolean;
  readonly journalMode: string;
  readonly busyTimeoutMs: number;
  readonly defensiveModeEnabled: boolean;
}

export class DatabaseConfigurationError extends Error {
  public readonly code = "DATABASE_CONFIGURATION_FAILED";

  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DatabaseConfigurationError";
  }
}

type DefensiveDatabase = DatabaseSync & {
  enableDefensive?: (active: boolean) => void;
};

function scalarValue(
  database: DatabaseSync,
  sql: string,
  column: string
): unknown {
  const row = database.prepare(sql).get();
  if (row === undefined || !(column in row)) {
    throw new DatabaseConfigurationError(
      `SQLite did not return expected column ${column} for ${sql}`
    );
  }
  return row[column];
}

function integerPragma(database: DatabaseSync, sql: string, column: string): number {
  const value = scalarValue(database, sql, column);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DatabaseConfigurationError(
      `SQLite returned a non-integer ${column} pragma value`
    );
  }
  return value;
}

function textPragma(database: DatabaseSync, sql: string, column: string): string {
  const value = scalarValue(database, sql, column);
  if (typeof value !== "string") {
    throw new DatabaseConfigurationError(
      `SQLite returned a non-text ${column} pragma value`
    );
  }
  return value;
}

export function readSqlitePragmaState(database: DatabaseSync): SqlitePragmaState {
  return Object.freeze({
    foreignKeys:
      integerPragma(database, "PRAGMA foreign_keys", "foreign_keys") === 1,
    journalMode: textPragma(database, "PRAGMA journal_mode", "journal_mode"),
    busyTimeoutMs: integerPragma(
      database,
      "PRAGMA busy_timeout",
      "timeout"
    ),
    defensiveModeEnabled:
      typeof (database as DefensiveDatabase).enableDefensive === "function"
  });
}

export function openConfiguredSqliteDatabase(path: string): DatabaseSync {
  if (!isAbsolute(path)) {
    throw new DatabaseConfigurationError(
      "SQLite database path must be absolute"
    );
  }

  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(path, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: SQLITE_BUSY_TIMEOUT_MS
    });

    database.enableLoadExtension(false);

    const defensiveDatabase = database as DefensiveDatabase;
    if (typeof defensiveDatabase.enableDefensive === "function") {
      defensiveDatabase.enableDefensive(true);
    }

    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA trusted_schema = OFF;
    `);

    const state = readSqlitePragmaState(database);
    if (!state.foreignKeys) {
      throw new DatabaseConfigurationError(
        "SQLite foreign key enforcement could not be enabled"
      );
    }
    if (state.journalMode.toLowerCase() !== "wal") {
      throw new DatabaseConfigurationError(
        `SQLite journal mode is ${state.journalMode}; WAL is required`
      );
    }
    if (state.busyTimeoutMs !== SQLITE_BUSY_TIMEOUT_MS) {
      throw new DatabaseConfigurationError(
        `SQLite busy timeout is ${state.busyTimeoutMs}ms; expected ${SQLITE_BUSY_TIMEOUT_MS}ms`
      );
    }

    return database;
  } catch (error: unknown) {
    if (database?.isOpen === true) {
      database.close();
    }
    if (error instanceof DatabaseConfigurationError) {
      throw error;
    }
    throw new DatabaseConfigurationError(
      `Failed to configure SQLite database at ${path}`,
      error
    );
  }
}
