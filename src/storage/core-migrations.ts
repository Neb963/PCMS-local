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
  }),
  Object.freeze({
    version: 2,
    id: "0002-module-state-generations",
    sql: `
      CREATE TABLE module_state_generations (
        module_id TEXT NOT NULL,
        state_generation INTEGER NOT NULL CHECK (state_generation > 0),
        module_version TEXT NOT NULL CHECK (length(module_version) BETWEEN 1 AND 128),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'READY_TO_SWITCH', 'RETAINED')),
        base_state_generation INTEGER,
        base_state_revision INTEGER,
        created_at TEXT NOT NULL,
        PRIMARY KEY (module_id, state_generation)
      ) STRICT;

      CREATE UNIQUE INDEX module_state_one_active
        ON module_state_generations(module_id)
        WHERE status = 'ACTIVE';

      CREATE UNIQUE INDEX module_state_one_ready_candidate
        ON module_state_generations(module_id)
        WHERE status = 'READY_TO_SWITCH';

      CREATE TABLE module_state_entries (
        module_id TEXT NOT NULL,
        state_generation INTEGER NOT NULL,
        state_key TEXT NOT NULL CHECK (length(state_key) BETWEEN 1 AND 128),
        value_json TEXT NOT NULL CHECK (length(value_json) <= 32768),
        PRIMARY KEY (module_id, state_generation, state_key),
        FOREIGN KEY (module_id, state_generation)
          REFERENCES module_state_generations(module_id, state_generation)
          ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE module_registry (
        module_id TEXT PRIMARY KEY,
        active_version TEXT NOT NULL CHECK (length(active_version) BETWEEN 1 AND 128),
        active_state_generation INTEGER NOT NULL CHECK (active_state_generation > 0),
        runtime_generation INTEGER NOT NULL CHECK (runtime_generation > 0),
        runtime_enabled INTEGER NOT NULL CHECK (runtime_enabled IN (0, 1)),
        state_schema_version INTEGER NOT NULL CHECK (state_schema_version > 0),
        state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
        updated_at TEXT NOT NULL,
        FOREIGN KEY (module_id, active_state_generation)
          REFERENCES module_state_generations(module_id, state_generation)
      ) STRICT;
    `
  })
]);
