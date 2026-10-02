import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { CORE_MIGRATIONS } from "./core-migrations.js";

export const PCMS_APPLICATION_ID = 0x50434d53;

export interface MigrationDefinition {
  readonly version: number;
  readonly id: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly id: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationResult {
  readonly applicationId: number;
  readonly schemaVersion: number;
  readonly applied: readonly AppliedMigration[];
}

export interface ApplyMigrationOptions {
  readonly migrations?: readonly MigrationDefinition[];
  readonly now?: () => Date;
}

export class DatabaseSchemaError extends Error {
  public readonly code = "DATABASE_INCOMPATIBLE_SCHEMA";

  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DatabaseSchemaError";
  }
}

export class DatabaseMigrationError extends Error {
  public readonly code = "DATABASE_MIGRATION_FAILED";
  public readonly migrationId: string;

  public constructor(migrationId: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DatabaseMigrationError";
    this.migrationId = migrationId;
  }
}

interface MigrationRow {
  readonly version: number;
  readonly migration_id: string;
  readonly checksum: string;
  readonly applied_at: string;
}

function pragmaInteger(database: DatabaseSync, pragma: string, column: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  const value = row?.[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DatabaseSchemaError(
      `SQLite returned invalid ${pragma} metadata`
    );
  }
  return value;
}

function listUserSchemaObjects(database: DatabaseSync): readonly string[] {
  const rows = database
    .prepare(`
      SELECT type, name
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `)
    .all();

  return rows.map((row) => `${String(row["type"])}:${String(row["name"])}`);
}

function readMigrationRows(database: DatabaseSync): readonly MigrationRow[] {
  const rows = database
    .prepare(`
      SELECT version, migration_id, checksum, applied_at
      FROM schema_migrations
      ORDER BY version
    `)
    .all();

  return rows.map((row) => {
    const version = row["version"];
    const id = row["migration_id"];
    const checksum = row["checksum"];
    const appliedAt = row["applied_at"];

    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      typeof id !== "string" ||
      typeof checksum !== "string" ||
      typeof appliedAt !== "string"
    ) {
      throw new DatabaseSchemaError(
        "schema_migrations contains invalid metadata"
      );
    }

    return Object.freeze({
      version,
      migration_id: id,
      checksum,
      applied_at: appliedAt
    });
  });
}

export function checksumMigration(migration: MigrationDefinition): string {
  return createHash("sha256")
    .update(String(migration.version))
    .update("\0")
    .update(migration.id)
    .update("\0")
    .update(migration.sql)
    .digest("hex");
}

function validateMigrationDefinitions(
  migrations: readonly MigrationDefinition[]
): void {
  const ids = new Set<string>();

  migrations.forEach((migration, index) => {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new DatabaseSchemaError(
        `Migration order is invalid: expected version ${expectedVersion}, got ${migration.version}`
      );
    }
    if (!/^\d{4}-[a-z0-9-]+$/u.test(migration.id)) {
      throw new DatabaseSchemaError(
        `Migration ${migration.version} has invalid id ${migration.id}`
      );
    }
    if (ids.has(migration.id)) {
      throw new DatabaseSchemaError(
        `Duplicate migration id ${migration.id}`
      );
    }
    if (migration.sql.trim() === "") {
      throw new DatabaseSchemaError(
        `Migration ${migration.id} has empty SQL`
      );
    }
    ids.add(migration.id);
  });
}

function verifyExistingHistory(
  database: DatabaseSync,
  migrations: readonly MigrationDefinition[],
  userVersion: number
): void {
  let rows: readonly MigrationRow[];
  try {
    rows = readMigrationRows(database);
  } catch (error: unknown) {
    if (error instanceof DatabaseSchemaError) {
      throw error;
    }
    throw new DatabaseSchemaError(
      "PCMS schema version is nonzero but migration history is unavailable",
      error
    );
  }

  if (rows.length !== userVersion) {
    throw new DatabaseSchemaError(
      `Migration history has ${rows.length} rows but user_version is ${userVersion}`
    );
  }

  for (let index = 0; index < userVersion; index += 1) {
    const expected = migrations[index];
    const observed = rows[index];
    if (expected === undefined || observed === undefined) {
      throw new DatabaseSchemaError(
        `No known migration matches applied schema version ${index + 1}`
      );
    }

    const expectedChecksum = checksumMigration(expected);
    if (
      observed.version !== expected.version ||
      observed.migration_id !== expected.id ||
      observed.checksum !== expectedChecksum
    ) {
      throw new DatabaseSchemaError(
        `Applied migration ${observed.version} does not match immutable migration ${expected.id}`
      );
    }
  }
}

function inspectCompatibility(
  database: DatabaseSync,
  migrations: readonly MigrationDefinition[]
): number {
  const applicationId = pragmaInteger(
    database,
    "application_id",
    "application_id"
  );
  const userVersion = pragmaInteger(database, "user_version", "user_version");

  if (applicationId === 0 && userVersion === 0) {
    const objects = listUserSchemaObjects(database);
    if (objects.length !== 0) {
      throw new DatabaseSchemaError(
        `Refusing to adopt unowned non-empty SQLite database: ${objects.join(", ")}`
      );
    }
    return 0;
  }

  if (applicationId !== PCMS_APPLICATION_ID) {
    throw new DatabaseSchemaError(
      `SQLite application_id ${applicationId} does not identify PCMS-local`
    );
  }

  if (userVersion < 1) {
    throw new DatabaseSchemaError(
      "PCMS-local database has application identity but no valid schema version"
    );
  }

  if (userVersion > migrations.length) {
    throw new DatabaseSchemaError(
      `Database schema version ${userVersion} is newer than supported version ${migrations.length}`
    );
  }

  verifyExistingHistory(database, migrations, userVersion);
  return userVersion;
}

function applyOneMigration(
  database: DatabaseSync,
  migration: MigrationDefinition,
  appliedAt: string,
  initializeApplicationId: boolean
): AppliedMigration {
  const checksum = checksumMigration(migration);

  database.exec("BEGIN IMMEDIATE");
  try {
    if (initializeApplicationId) {
      database.exec(`PRAGMA application_id = ${PCMS_APPLICATION_ID}`);
    }

    database.exec(migration.sql);
    database
      .prepare(`
        INSERT INTO schema_migrations (
          version,
          migration_id,
          checksum,
          applied_at
        ) VALUES (?, ?, ?, ?)
      `)
      .run(migration.version, migration.id, checksum, appliedAt);
    database.exec(`PRAGMA user_version = ${migration.version}`);
    database.exec("COMMIT");
  } catch (error: unknown) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw new DatabaseMigrationError(
      migration.id,
      `Migration ${migration.id} failed`,
      error
    );
  }

  return Object.freeze({
    version: migration.version,
    id: migration.id,
    checksum,
    appliedAt
  });
}

export function applyPcmsMigrations(
  database: DatabaseSync,
  options: ApplyMigrationOptions = {}
): MigrationResult {
  const migrations = options.migrations ?? CORE_MIGRATIONS;
  const now = options.now ?? (() => new Date());

  validateMigrationDefinitions(migrations);

  let currentVersion: number;
  try {
    currentVersion = inspectCompatibility(database, migrations);
  } catch (error: unknown) {
    if (error instanceof DatabaseSchemaError) {
      throw error;
    }
    throw new DatabaseSchemaError(
      "Failed to inspect PCMS-local SQLite schema metadata",
      error
    );
  }

  const applied: AppliedMigration[] = [];
  for (const migration of migrations.slice(currentVersion)) {
    applied.push(
      applyOneMigration(
        database,
        migration,
        now().toISOString(),
        currentVersion === 0 && migration.version === 1
      )
    );
    currentVersion = migration.version;
  }

  const applicationId = pragmaInteger(
    database,
    "application_id",
    "application_id"
  );
  const schemaVersion = pragmaInteger(
    database,
    "user_version",
    "user_version"
  );

  if (
    applicationId !== PCMS_APPLICATION_ID ||
    schemaVersion !== migrations.length
  ) {
    throw new DatabaseSchemaError(
      "SQLite schema metadata does not match the migration authority after migration"
    );
  }
  verifyExistingHistory(database, migrations, schemaVersion);

  return Object.freeze({
    applicationId,
    schemaVersion,
    applied: Object.freeze(applied)
  });
}
