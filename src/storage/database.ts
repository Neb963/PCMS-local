import type { MigrationDefinition } from "./migrations.js";
import {
  DatabaseMigrationError,
  DatabaseSchemaError,
  applyPcmsMigrations
} from "./migrations.js";
import {
  DatabaseConfigurationError,
  openConfiguredSqliteDatabase
} from "./sqlite.js";

export interface OpenPcmsDatabaseOptions {
  readonly migrations?: readonly MigrationDefinition[];
  readonly now?: () => Date;
}

export interface PcmsDatabase {
  readonly applicationId: number;
  readonly schemaVersion: number;
  close(): void;
}

export class DatabaseOpenError extends Error {
  public readonly code = "DATABASE_OPEN_FAILED";

  public constructor(path: string, cause?: unknown) {
    super(
      `Failed to open PCMS-local SQLite database at ${path}`,
      cause === undefined ? undefined : { cause }
    );
    this.name = "DatabaseOpenError";
  }
}

export function openPcmsDatabase(
  path: string,
  options: OpenPcmsDatabaseOptions = {}
): PcmsDatabase {
  let database = null;

  try {
    database = openConfiguredSqliteDatabase(path);
    const migrationResult = applyPcmsMigrations(database, options);
    let closed = false;

    return Object.freeze({
      applicationId: migrationResult.applicationId,
      schemaVersion: migrationResult.schemaVersion,
      close(): void {
        if (closed) {
          return;
        }
        closed = true;
        database?.close();
        database = null;
      }
    });
  } catch (error: unknown) {
    if (database?.isOpen === true) {
      database.close();
    }

    if (
      error instanceof DatabaseSchemaError ||
      error instanceof DatabaseMigrationError
    ) {
      throw error;
    }

    if (error instanceof DatabaseConfigurationError) {
      throw new DatabaseOpenError(path, error);
    }

    throw new DatabaseOpenError(path, error);
  }
}
