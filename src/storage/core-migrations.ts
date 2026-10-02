import type { MigrationDefinition } from "./migrations.js";

export const CORE_MIGRATIONS: readonly MigrationDefinition[] = Object.freeze([
  Object.freeze({
    version: 1,
    id: "0001-schema-migrations",
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        migration_id TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL CHECK (length(checksum) = 64),
        applied_at TEXT NOT NULL
      ) STRICT;
    `
  })
]);
