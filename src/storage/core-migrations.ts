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
  }),
  Object.freeze({
    version: 8,
    id: "0008-generator-identity",
    sql: `
      CREATE TABLE generators (
        generator_local_id TEXT PRIMARY KEY
          CHECK (length(generator_local_id) BETWEEN 1 AND 128),
        account_id TEXT NOT NULL,
        provider_stable_id TEXT
          CHECK (
            provider_stable_id IS NULL OR
            (
              length(provider_stable_id) BETWEEN 1 AND 256 AND
              provider_stable_id = trim(provider_stable_id)
            )
          ),
        current_slug TEXT NOT NULL
          CHECK (
            length(current_slug) BETWEEN 1 AND 512 AND
            current_slug = trim(current_slug)
          ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
          CHECK (revision >= 0),
        FOREIGN KEY (account_id)
          REFERENCES accounts(account_id)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE UNIQUE INDEX generators_provider_stable_id_unique
        ON generators(provider_stable_id)
        WHERE provider_stable_id IS NOT NULL;

      CREATE INDEX generators_account_lookup
        ON generators(account_id, generator_local_id);

      CREATE INDEX generators_current_slug_lookup
        ON generators(current_slug);
    `
  }),
  Object.freeze({
    version: 9,
    id: "0009-operation-coordinator",
    sql: `
      CREATE TABLE operation_target_epochs (
        target_key TEXT PRIMARY KEY
          CHECK (length(target_key) BETWEEN 1 AND 320),
        last_epoch INTEGER NOT NULL
          CHECK (last_epoch > 0)
      ) STRICT;

      CREATE TABLE operations (
        operation_id TEXT PRIMARY KEY
          CHECK (length(operation_id) BETWEEN 1 AND 128),
        idempotency_key TEXT NOT NULL UNIQUE
          CHECK (length(idempotency_key) BETWEEN 1 AND 128),
        state TEXT NOT NULL
          CHECK (
            state IN (
              'PREPARED',
              'RUNNING',
              'VERIFYING',
              'SUCCEEDED',
              'FAILED_SAFE',
              'UNCERTAIN',
              'CANCELLED',
              'NEEDS_HUMAN'
            )
          ),
        target_key TEXT NOT NULL
          CHECK (length(target_key) BETWEEN 1 AND 320),
        operation_kind TEXT NOT NULL
          CHECK (length(operation_kind) BETWEEN 1 AND 128),
        schema_version INTEGER NOT NULL
          CHECK (schema_version > 0),
        owner_kind TEXT NOT NULL
          CHECK (owner_kind IN ('CORE', 'MODULE')),
        owner_module_id TEXT,
        owner_module_version TEXT,
        owner_runtime_generation INTEGER,
        actor_source TEXT NOT NULL
          CHECK (length(actor_source) BETWEEN 1 AND 128),
        persona_uid TEXT,
        account_id TEXT,
        desired_fingerprint TEXT NOT NULL
          CHECK (length(desired_fingerprint) = 64),
        provenance_json TEXT NOT NULL
          CHECK (length(provenance_json) BETWEEN 2 AND 8192),
        preconditions_json TEXT NOT NULL
          CHECK (length(preconditions_json) BETWEEN 2 AND 16384),
        attempt INTEGER NOT NULL
          CHECK (attempt > 0),
        claim_epoch INTEGER NOT NULL
          CHECK (claim_epoch > 0),
        dispatch_authorized_at TEXT,
        dispatch_evidence_json TEXT
          CHECK (
            dispatch_evidence_json IS NULL OR
            length(dispatch_evidence_json) BETWEEN 2 AND 8192
          ),
        cancellation_requested_at TEXT,
        last_transition_reason TEXT
          CHECK (
            last_transition_reason IS NULL OR
            length(last_transition_reason) BETWEEN 1 AND 256
          ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0
          CHECK (revision >= 0),
        CHECK (
          (
            owner_kind = 'CORE' AND
            owner_module_id IS NULL AND
            owner_module_version IS NULL AND
            owner_runtime_generation IS NULL
          ) OR
          (
            owner_kind = 'MODULE' AND
            owner_module_id IS NOT NULL AND
            owner_module_version IS NOT NULL AND
            owner_runtime_generation IS NOT NULL AND
            owner_runtime_generation > 0
          )
        ),
        CHECK (
          state NOT IN ('RUNNING', 'VERIFYING', 'SUCCEEDED', 'UNCERTAIN', 'NEEDS_HUMAN') OR
          dispatch_authorized_at IS NOT NULL
        ),
        CHECK (
          (state IN ('SUCCEEDED', 'FAILED_SAFE', 'CANCELLED') AND terminal_at IS NOT NULL) OR
          (state NOT IN ('SUCCEEDED', 'FAILED_SAFE', 'CANCELLED') AND terminal_at IS NULL)
        ),
        FOREIGN KEY (persona_uid)
          REFERENCES personas(persona_uid)
          ON DELETE RESTRICT,
        FOREIGN KEY (account_id)
          REFERENCES accounts(account_id)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE UNIQUE INDEX operations_one_unresolved_claim_per_target
        ON operations(target_key)
        WHERE state IN (
          'PREPARED',
          'RUNNING',
          'VERIFYING',
          'UNCERTAIN',
          'NEEDS_HUMAN'
        );

      CREATE INDEX operations_target_history
        ON operations(target_key, claim_epoch);

      CREATE INDEX operations_unresolved_state
        ON operations(state, updated_at)
        WHERE state IN (
          'PREPARED',
          'RUNNING',
          'VERIFYING',
          'UNCERTAIN',
          'NEEDS_HUMAN'
        );
    `
  }),
  Object.freeze({
    version: 10,
    id: "0010-provider-gate-state",
    sql: `
      CREATE TABLE provider_state (
        provider_id TEXT NOT NULL
          CHECK (length(provider_id) BETWEEN 1 AND 64),
        scope_kind TEXT NOT NULL
          CHECK (scope_kind IN ('PROVIDER', 'ACCOUNT', 'PERSONA')),
        scope_key TEXT NOT NULL
          CHECK (length(scope_key) BETWEEN 1 AND 128),
        signal_kind TEXT NOT NULL
          CHECK (signal_kind IN ('RATE_LIMIT', 'CHALLENGE', 'OUTAGE')),
        cooldown_until TEXT NOT NULL,
        reason TEXT NOT NULL
          CHECK (length(reason) BETWEEN 1 AND 256),
        observed_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
          CHECK (revision >= 0),
        PRIMARY KEY (provider_id, scope_kind, scope_key)
      ) STRICT;

      CREATE INDEX provider_state_active_cooldown
        ON provider_state(provider_id, cooldown_until);
    `
  }),
  Object.freeze({
    version: 11,
    id: "0011-human-tasks",
    sql: `
      CREATE TABLE human_tasks (
        task_id TEXT PRIMARY KEY
          CHECK (length(task_id) BETWEEN 1 AND 128),
        task_type TEXT NOT NULL
          CHECK (length(task_type) BETWEEN 1 AND 64),
        status TEXT NOT NULL
          CHECK (status IN ('OPEN', 'RESOLVED', 'CANCELLED', 'EXPIRED')),
        account_id TEXT,
        persona_uid TEXT,
        operation_id TEXT,
        title TEXT NOT NULL
          CHECK (length(title) BETWEEN 1 AND 256),
        explanation TEXT NOT NULL
          CHECK (length(explanation) BETWEEN 1 AND 1024),
        required_action_kind TEXT NOT NULL
          CHECK (length(required_action_kind) BETWEEN 1 AND 64),
        continuation_kind TEXT NOT NULL
          CHECK (length(continuation_kind) BETWEEN 1 AND 64),
        continuation_version INTEGER NOT NULL
          CHECK (continuation_version > 0),
        continuation_ref TEXT NOT NULL
          CHECK (length(continuation_ref) BETWEEN 1 AND 256),
        evidence_json TEXT NOT NULL
          CHECK (length(evidence_json) BETWEEN 2 AND 8192),
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0
          CHECK (revision >= 0),
        CHECK (
          (status = 'OPEN' AND resolved_at IS NULL) OR
          (status <> 'OPEN' AND resolved_at IS NOT NULL)
        ),
        FOREIGN KEY (account_id)
          REFERENCES accounts(account_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (persona_uid)
          REFERENCES personas(persona_uid)
          ON DELETE RESTRICT,
        FOREIGN KEY (operation_id)
          REFERENCES operations(operation_id)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX human_tasks_open_attention
        ON human_tasks(status, created_at)
        WHERE status = 'OPEN';

      CREATE INDEX human_tasks_operation
        ON human_tasks(operation_id, status)
        WHERE operation_id IS NOT NULL;

      CREATE UNIQUE INDEX human_tasks_one_open_action_per_operation
        ON human_tasks(operation_id, required_action_kind)
        WHERE status = 'OPEN' AND operation_id IS NOT NULL;
    `
  }),
  Object.freeze({
    version: 12,
    id: "0012-batches",
    sql: `
      CREATE TABLE batches (
        batch_id TEXT PRIMARY KEY
          CHECK (length(batch_id) BETWEEN 1 AND 128),
        actor_source TEXT NOT NULL
          CHECK (length(actor_source) BETWEEN 1 AND 128),
        label TEXT
          CHECK (label IS NULL OR length(label) BETWEEN 1 AND 256),
        cancellation_requested_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
          CHECK (revision >= 0)
      ) STRICT;

      CREATE TABLE batch_children (
        batch_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL
          CHECK (ordinal >= 0),
        operation_id TEXT NOT NULL,
        cancellation_requested_at TEXT,
        cancellation_outcome TEXT
          CHECK (
            cancellation_outcome IS NULL OR
            cancellation_outcome IN (
              'CANCELLED_CLEAN',
              'UNCERTAIN',
              'NEEDS_HUMAN',
              'TERMINAL_UNCHANGED',
              'ERROR'
            )
          ),
        cancellation_error_code TEXT
          CHECK (
            cancellation_error_code IS NULL OR
            length(cancellation_error_code) BETWEEN 1 AND 128
          ),
        PRIMARY KEY (batch_id, operation_id),
        UNIQUE (batch_id, ordinal),
        FOREIGN KEY (batch_id)
          REFERENCES batches(batch_id)
          ON DELETE CASCADE,
        FOREIGN KEY (operation_id)
          REFERENCES operations(operation_id)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX batch_children_operation
        ON batch_children(operation_id);

      CREATE INDEX batches_cancellation
        ON batches(cancellation_requested_at)
        WHERE cancellation_requested_at IS NOT NULL;
    `
  }),
  Object.freeze({
    version: 13,
    id: "0013-schedules",
    sql: `
      CREATE TABLE schedules (
        schedule_id TEXT PRIMARY KEY
          CHECK (length(schedule_id) BETWEEN 1 AND 128),
        owner_module_id TEXT
          CHECK (
            owner_module_id IS NULL OR
            length(owner_module_id) BETWEEN 1 AND 128
          ),
        operation_kind TEXT NOT NULL
          CHECK (length(operation_kind) BETWEEN 1 AND 128),
        schema_version INTEGER NOT NULL
          CHECK (schema_version > 0),
        target_ref TEXT NOT NULL
          CHECK (length(target_ref) BETWEEN 1 AND 320),
        payload_ref TEXT
          CHECK (
            payload_ref IS NULL OR
            length(payload_ref) BETWEEN 1 AND 256
          ),
        interval_ms INTEGER NOT NULL
          CHECK (interval_ms > 0),
        time_zone TEXT NOT NULL
          CHECK (length(time_zone) BETWEEN 1 AND 128),
        priority TEXT NOT NULL
          CHECK (
            priority IN (
              'RECOVERY',
              'INTERACTIVE',
              'SCHEDULED',
              'BACKGROUND'
            )
          ),
        fairness_key TEXT NOT NULL
          CHECK (length(fairness_key) BETWEEN 1 AND 128),
        enabled INTEGER NOT NULL
          CHECK (enabled IN (0, 1)),
        next_due_at TEXT NOT NULL,
        last_clock_at TEXT NOT NULL,
        pending_dispatch_id TEXT
          CHECK (
            pending_dispatch_id IS NULL OR
            length(pending_dispatch_id) BETWEEN 1 AND 128
          ),
        pending_created_at TEXT,
        last_dispatched_operation_id TEXT,
        last_terminal_operation_id TEXT,
        last_failure_code TEXT
          CHECK (
            last_failure_code IS NULL OR
            length(last_failure_code) BETWEEN 1 AND 128
          ),
        budget_limit INTEGER
          CHECK (budget_limit IS NULL OR budget_limit > 0),
        budget_window_ms INTEGER
          CHECK (budget_window_ms IS NULL OR budget_window_ms > 0),
        budget_window_started_at TEXT,
        budget_used INTEGER
          CHECK (budget_used IS NULL OR budget_used >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
          CHECK (revision >= 0),
        CHECK (
          (
            pending_dispatch_id IS NULL AND
            pending_created_at IS NULL
          ) OR
          (
            pending_dispatch_id IS NOT NULL AND
            pending_created_at IS NOT NULL
          )
        ),
        CHECK (
          (
            budget_limit IS NULL AND
            budget_window_ms IS NULL AND
            budget_window_started_at IS NULL AND
            budget_used IS NULL
          ) OR
          (
            budget_limit IS NOT NULL AND
            budget_window_ms IS NOT NULL AND
            budget_window_started_at IS NOT NULL AND
            budget_used IS NOT NULL AND
            budget_used <= budget_limit
          )
        )
      ) STRICT;

      CREATE INDEX schedules_wake_scan
        ON schedules(enabled, next_due_at, schedule_id);

      CREATE INDEX schedules_pending_dispatch
        ON schedules(pending_dispatch_id)
        WHERE pending_dispatch_id IS NOT NULL;
    `
  }),
  Object.freeze({
    version: 14,
    id: "0014-project-targets",
    sql: `
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY
          CHECK (length(project_id) BETWEEN 1 AND 128),
        generator_local_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
          CHECK (revision >= 0),
        FOREIGN KEY (generator_local_id)
          REFERENCES generators(generator_local_id)
          ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX projects_generator_lookup
        ON projects(generator_local_id);
    `
  }),
  Object.freeze({
    version: 15,
    id: "0015-recovery-control",
    sql: `
      CREATE TABLE recovery_control (
        singleton INTEGER PRIMARY KEY
          CHECK (singleton = 1),
        mode TEXT NOT NULL
          CHECK (mode IN ('NORMAL', 'RECOVERY_HOLD')),
        source_backup_id TEXT
          CHECK (
            source_backup_id IS NULL OR
            length(source_backup_id) BETWEEN 1 AND 128
          ),
        entered_at TEXT,
        revision INTEGER NOT NULL DEFAULT 0
          CHECK (revision >= 0),
        CHECK (
          (
            mode = 'NORMAL' AND
            source_backup_id IS NULL AND
            entered_at IS NULL
          ) OR
          (
            mode = 'RECOVERY_HOLD' AND
            source_backup_id IS NOT NULL AND
            entered_at IS NOT NULL
          )
        )
      ) STRICT;

      INSERT INTO recovery_control (
        singleton,
        mode,
        source_backup_id,
        entered_at,
        revision
      ) VALUES (1, 'NORMAL', NULL, NULL, 0);
    `
  })
]);
