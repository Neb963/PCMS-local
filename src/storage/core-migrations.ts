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
  }),
  Object.freeze({
    version: 4,
    id: "0004-module-lifecycle-evidence",
    sql: `
      ALTER TABLE module_registry
        ADD COLUMN lifecycle_status TEXT NOT NULL
        DEFAULT 'ENABLED'
        CHECK (lifecycle_status IN ('ENABLED', 'DISABLED', 'REMOVED'));

      ALTER TABLE module_registry
        ADD COLUMN removed_at TEXT;

      UPDATE module_registry
      SET lifecycle_status = 'DISABLED'
      WHERE runtime_enabled = 0;

      CREATE TABLE module_lifecycle_evidence (
        module_id TEXT NOT NULL,
        evidence_kind TEXT NOT NULL
          CHECK (evidence_kind IN ('OPERATION', 'HUMAN_TASK')),
        evidence_id TEXT NOT NULL
          CHECK (length(evidence_id) BETWEEN 1 AND 128),
        unresolved INTEGER NOT NULL
          CHECK (unresolved IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        PRIMARY KEY (module_id, evidence_kind, evidence_id),
        FOREIGN KEY (module_id)
          REFERENCES module_registry(module_id)
          ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX module_lifecycle_unresolved_evidence
        ON module_lifecycle_evidence(module_id, unresolved);
    `
  }),
  Object.freeze({
    version: 5,
    id: "0005-persona-profile-lifecycle",
    sql: `
      CREATE TABLE personas (
        persona_uid TEXT PRIMARY KEY
          CHECK (length(persona_uid) BETWEEN 1 AND 128),
        lifecycle_status TEXT NOT NULL
          CHECK (lifecycle_status IN ('ACTIVE', 'RETIRED')),
        profile_state TEXT NOT NULL
          CHECK (profile_state IN ('CLOSED', 'OPEN')),
        browser_backend TEXT NOT NULL
          CHECK (browser_backend = 'chromium-v1'),
        profile_relative_path TEXT NOT NULL UNIQUE
          CHECK (length(profile_relative_path) BETWEEN 1 AND 512),
        profile_delete_state TEXT NOT NULL DEFAULT 'PRESENT'
          CHECK (profile_delete_state IN ('PRESENT', 'DELETE_STAGED', 'DELETED')),
        profile_deleted_at TEXT,
        profile_backup_decision TEXT
          CHECK (
            profile_backup_decision IS NULL OR
            profile_backup_decision IN ('BACKED_UP', 'SKIPPED')
          ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        retired_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0
          CHECK (revision >= 0),
        CHECK (lifecycle_status <> 'RETIRED' OR profile_state = 'CLOSED'),
        CHECK (profile_delete_state = 'PRESENT' OR lifecycle_status = 'RETIRED'),
        CHECK (profile_delete_state = 'PRESENT' OR profile_state = 'CLOSED'),
        CHECK (
          (profile_delete_state = 'PRESENT' AND
            profile_deleted_at IS NULL AND
            profile_backup_decision IS NULL) OR
          (profile_delete_state = 'DELETE_STAGED' AND
            profile_deleted_at IS NULL AND
            profile_backup_decision IS NOT NULL) OR
          (profile_delete_state = 'DELETED' AND
            profile_deleted_at IS NOT NULL AND
            profile_backup_decision IS NOT NULL)
        )
      ) STRICT;
    `
  }),
  Object.freeze({
    version: 6,
    id: "0006-persona-browser-runtime",
    sql: `
      CREATE TABLE persona_browser_runtime (
        persona_uid TEXT PRIMARY KEY,
        state TEXT NOT NULL
          CHECK (state IN ('STARTING', 'RUNNING', 'DEGRADED')),
        pid INTEGER
          CHECK (pid IS NULL OR pid > 0),
        process_start_ticks TEXT,
        executable_path TEXT,
        executable_real_path TEXT,
        browser_version TEXT,
        devtools_port INTEGER
          CHECK (
            devtools_port IS NULL OR
            (devtools_port BETWEEN 1 AND 65535)
          ),
        devtools_path TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
          CHECK (last_error IS NULL OR length(last_error) <= 512),
        CHECK (
          state <> 'RUNNING' OR
          (
            pid IS NOT NULL AND
            process_start_ticks IS NOT NULL AND
            executable_path IS NOT NULL AND
            executable_real_path IS NOT NULL AND
            browser_version IS NOT NULL AND
            devtools_port IS NOT NULL AND
            devtools_path IS NOT NULL
          )
        ),
        FOREIGN KEY (persona_uid)
          REFERENCES personas(persona_uid)
          ON DELETE CASCADE
      ) STRICT;
    `
  }),
  Object.freeze({
    version: 7,
    id: "0007-account-persona-inventory",
    sql: `
      CREATE TABLE accounts (
        account_id TEXT PRIMARY KEY
          CHECK (length(account_id) BETWEEN 1 AND 128),
        display_name TEXT NOT NULL
          CHECK (length(display_name) BETWEEN 1 AND 256),
        lifecycle_status TEXT NOT NULL
          CHECK (lifecycle_status IN ('ACTIVE', 'INACTIVE')),
        persona_uid TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
          CHECK (revision >= 0),
        FOREIGN KEY (persona_uid)
          REFERENCES personas(persona_uid)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE UNIQUE INDEX accounts_one_active_account_per_persona
        ON accounts(persona_uid)
        WHERE lifecycle_status = 'ACTIVE' AND persona_uid IS NOT NULL;

      CREATE INDEX accounts_persona_lookup
        ON accounts(persona_uid);

      CREATE TABLE persona_bindings_history (
        binding_event_id INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL,
        event_kind TEXT NOT NULL
          CHECK (event_kind IN ('BIND', 'REBIND', 'UNBIND')),
        previous_persona_uid TEXT,
        next_persona_uid TEXT,
        reason TEXT NOT NULL
          CHECK (length(reason) BETWEEN 1 AND 256),
        changed_at TEXT NOT NULL,
        account_revision INTEGER NOT NULL
          CHECK (account_revision > 0),
        CHECK (
          (event_kind = 'BIND' AND
            previous_persona_uid IS NULL AND
            next_persona_uid IS NOT NULL) OR
          (event_kind = 'REBIND' AND
            previous_persona_uid IS NOT NULL AND
            next_persona_uid IS NOT NULL AND
            previous_persona_uid <> next_persona_uid) OR
          (event_kind = 'UNBIND' AND
            previous_persona_uid IS NOT NULL AND
            next_persona_uid IS NULL)
        ),
        FOREIGN KEY (account_id)
          REFERENCES accounts(account_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (previous_persona_uid)
          REFERENCES personas(persona_uid)
          ON DELETE RESTRICT,
        FOREIGN KEY (next_persona_uid)
          REFERENCES personas(persona_uid)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX persona_bindings_history_account
        ON persona_bindings_history(account_id, binding_event_id);

      CREATE TRIGGER persona_bindings_history_append_only_update
      BEFORE UPDATE ON persona_bindings_history
      BEGIN
        SELECT RAISE(ABORT, 'persona binding history is append-only');
      END;

      CREATE TRIGGER persona_bindings_history_append_only_delete
      BEFORE DELETE ON persona_bindings_history
      BEGIN
        SELECT RAISE(ABORT, 'persona binding history is append-only');
      END;
    `
  })
]);
