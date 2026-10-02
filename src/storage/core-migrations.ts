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
  }),
  Object.freeze({
    version: 3,
    id: "0003-module-authority-activation",
    sql: `
      ALTER TABLE module_registry
        ADD COLUMN approved_authority_json TEXT NOT NULL
        DEFAULT '{"capabilities":[],"requiredServices":[]}';

      ALTER TABLE module_registry
        ADD COLUMN activated_at TEXT;

      CREATE TABLE module_generation_authority (
        module_id TEXT NOT NULL,
        state_generation INTEGER NOT NULL CHECK (state_generation > 0),
        requested_authority_json TEXT NOT NULL
          CHECK (length(requested_authority_json) BETWEEN 2 AND 16384),
        authority_delta_json TEXT NOT NULL
          CHECK (length(authority_delta_json) BETWEEN 2 AND 16384),
        approval_status TEXT NOT NULL
          CHECK (
            approval_status IN (
              'NOT_REQUIRED',
              'AWAITING_APPROVAL',
              'APPROVED',
              'DECLINED'
            )
          ),
        requested_at TEXT NOT NULL,
        decided_at TEXT,
        activated_at TEXT,
        PRIMARY KEY (module_id, state_generation),
        FOREIGN KEY (module_id, state_generation)
          REFERENCES module_state_generations(module_id, state_generation)
          ON DELETE CASCADE
      ) STRICT;

      INSERT INTO module_generation_authority (
        module_id,
        state_generation,
        requested_authority_json,
        authority_delta_json,
        approval_status,
        requested_at,
        decided_at,
        activated_at
      )
      SELECT
        module_id,
        active_state_generation,
        '{"capabilities":[],"requiredServices":[]}',
        '{"addedCapabilities":[],"removedCapabilities":[],"addedRequiredServices":[],"removedRequiredServices":[],"expands":false}',
        'APPROVED',
        updated_at,
        updated_at,
        updated_at
      FROM module_registry;

      UPDATE module_registry
      SET activated_at = updated_at
      WHERE activated_at IS NULL;
    `
  })
]);
