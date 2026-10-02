import type { DatabaseSync } from "node:sqlite";

const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type ModuleLifecycleStatus =
  | "ENABLED"
  | "DISABLED"
  | "REMOVED";

export type ModuleEvidenceKind =
  | "OPERATION"
  | "HUMAN_TASK";

export interface ModuleLifecycleSnapshot {
  readonly moduleId: string;
  readonly status: ModuleLifecycleStatus;
  readonly runtimeGeneration: number;
  readonly runtimeEnabled: boolean;
  readonly activeVersion: string;
  readonly activeStateGeneration: number;
  readonly removedAt: string | null;
  readonly updatedAt: string;
}

export interface ModuleLifecycleEvidence {
  readonly moduleId: string;
  readonly kind: ModuleEvidenceKind;
  readonly evidenceId: string;
  readonly unresolved: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
}

export interface ModuleLifecycleStoreOptions {
  readonly now?: () => Date;
}

export class ModuleLifecycleError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(
    code: string,
    message: string,
    retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ModuleLifecycleError";
    this.code = code;
    this.retryable = retryable;
  }
}

interface LifecycleRow {
  readonly module_id: string;
  readonly lifecycle_status: string;
  readonly runtime_generation: number;
  readonly runtime_enabled: number;
  readonly active_version: string;
  readonly active_state_generation: number;
  readonly removed_at: string | null;
  readonly updated_at: string;
}

interface EvidenceRow {
  readonly module_id: string;
  readonly evidence_kind: string;
  readonly evidence_id: string;
  readonly unresolved: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly resolved_at: string | null;
}

function fail(
  code: string,
  message: string,
  retryable = false,
  cause?: unknown
): never {
  throw new ModuleLifecycleError(
    code,
    message,
    retryable,
    cause === undefined ? undefined : { cause }
  );
}

function validateModuleId(moduleId: string): void {
  if (moduleId.length > 64 || !MODULE_ID.test(moduleId)) {
    fail("INVALID_MODULE_LIFECYCLE", "moduleId has invalid syntax");
  }
}

function validateGeneration(
  runtimeGeneration: number,
  label = "runtimeGeneration"
): void {
  if (
    !Number.isSafeInteger(runtimeGeneration) ||
    runtimeGeneration < 1
  ) {
    fail(
      "INVALID_MODULE_LIFECYCLE",
      `${label} must be a positive safe integer`
    );
  }
}

function validateEvidenceKind(
  kind: ModuleEvidenceKind
): void {
  if (kind !== "OPERATION" && kind !== "HUMAN_TASK") {
    fail(
      "INVALID_MODULE_EVIDENCE",
      `unsupported module evidence kind: ${String(kind)}`
    );
  }
}

function validateEvidenceId(evidenceId: string): void {
  if (!EVIDENCE_ID.test(evidenceId)) {
    fail(
      "INVALID_MODULE_EVIDENCE",
      "evidenceId has invalid syntax"
    );
  }
}

function parseLifecycleStatus(
  value: string
): ModuleLifecycleStatus {
  if (
    value === "ENABLED" ||
    value === "DISABLED" ||
    value === "REMOVED"
  ) {
    return value;
  }
  fail(
    "MODULE_LIFECYCLE_CORRUPT",
    `invalid lifecycle status: ${value}`
  );
}

function parseLifecycleRow(
  row: Record<string, unknown> | undefined
): ModuleLifecycleSnapshot {
  if (row === undefined) {
    fail("MODULE_NOT_REGISTERED", "module is not registered");
  }

  const candidate = row as unknown as LifecycleRow;
  if (
    typeof candidate.module_id !== "string" ||
    typeof candidate.lifecycle_status !== "string" ||
    typeof candidate.runtime_generation !== "number" ||
    !Number.isSafeInteger(candidate.runtime_generation) ||
    (candidate.runtime_enabled !== 0 &&
      candidate.runtime_enabled !== 1) ||
    typeof candidate.active_version !== "string" ||
    typeof candidate.active_state_generation !== "number" ||
    !Number.isSafeInteger(candidate.active_state_generation) ||
    !(
      candidate.removed_at === null ||
      typeof candidate.removed_at === "string"
    ) ||
    typeof candidate.updated_at !== "string"
  ) {
    fail(
      "MODULE_LIFECYCLE_CORRUPT",
      "module lifecycle row contains invalid metadata"
    );
  }

  const status = parseLifecycleStatus(
    candidate.lifecycle_status
  );
  const runtimeEnabled = candidate.runtime_enabled === 1;
  if (
    (status === "ENABLED" && !runtimeEnabled) ||
    (status !== "ENABLED" && runtimeEnabled) ||
    (status === "REMOVED" && candidate.removed_at === null) ||
    (status !== "REMOVED" && candidate.removed_at !== null)
  ) {
    fail(
      "MODULE_LIFECYCLE_CORRUPT",
      "module lifecycle/runtime state is inconsistent"
    );
  }

  return Object.freeze({
    moduleId: candidate.module_id,
    status,
    runtimeGeneration: candidate.runtime_generation,
    runtimeEnabled,
    activeVersion: candidate.active_version,
    activeStateGeneration:
      candidate.active_state_generation,
    removedAt: candidate.removed_at,
    updatedAt: candidate.updated_at
  });
}

function parseEvidenceRow(
  row: Record<string, unknown>
): ModuleLifecycleEvidence {
  const candidate = row as unknown as EvidenceRow;
  if (
    typeof candidate.module_id !== "string" ||
    typeof candidate.evidence_kind !== "string" ||
    typeof candidate.evidence_id !== "string" ||
    (candidate.unresolved !== 0 &&
      candidate.unresolved !== 1) ||
    typeof candidate.created_at !== "string" ||
    typeof candidate.updated_at !== "string" ||
    !(
      candidate.resolved_at === null ||
      typeof candidate.resolved_at === "string"
    )
  ) {
    fail(
      "MODULE_EVIDENCE_CORRUPT",
      "module lifecycle evidence contains invalid metadata"
    );
  }

  const kind = candidate.evidence_kind;
  validateEvidenceKind(kind as ModuleEvidenceKind);
  validateEvidenceId(candidate.evidence_id);
  const unresolved = candidate.unresolved === 1;
  if (
    (unresolved && candidate.resolved_at !== null) ||
    (!unresolved && candidate.resolved_at === null)
  ) {
    fail(
      "MODULE_EVIDENCE_CORRUPT",
      "module lifecycle evidence resolution metadata is inconsistent"
    );
  }

  return Object.freeze({
    moduleId: candidate.module_id,
    kind: kind as ModuleEvidenceKind,
    evidenceId: candidate.evidence_id,
    unresolved,
    createdAt: candidate.created_at,
    updatedAt: candidate.updated_at,
    resolvedAt: candidate.resolved_at
  });
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
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export class ModuleLifecycleStore {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  public constructor(
    database: DatabaseSync,
    options: ModuleLifecycleStoreOptions = {}
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  public getLifecycle(
    moduleId: string
  ): ModuleLifecycleSnapshot {
    validateModuleId(moduleId);
    const row = this.#database.prepare(`
      SELECT
        module_id,
        lifecycle_status,
        runtime_generation,
        runtime_enabled,
        active_version,
        active_state_generation,
        removed_at,
        updated_at
      FROM module_registry
      WHERE module_id = ?
    `).get(moduleId);
    return parseLifecycleRow(row);
  }

  public disableModule(
    moduleId: string,
    expectedRuntimeGeneration: number
  ): ModuleLifecycleSnapshot {
    return this.#setEnabled(
      moduleId,
      expectedRuntimeGeneration,
      false
    );
  }

  public enableModule(
    moduleId: string,
    expectedRuntimeGeneration: number
  ): ModuleLifecycleSnapshot {
    return this.#setEnabled(
      moduleId,
      expectedRuntimeGeneration,
      true
    );
  }

  public recordUnresolvedEvidence(
    moduleId: string,
    kind: ModuleEvidenceKind,
    evidenceId: string
  ): ModuleLifecycleEvidence {
    validateModuleId(moduleId);
    validateEvidenceKind(kind);
    validateEvidenceId(evidenceId);
    const now = this.#now().toISOString();

    return transaction(this.#database, () => {
      this.getLifecycle(moduleId);
      this.#database.prepare(`
        INSERT INTO module_lifecycle_evidence (
          module_id,
          evidence_kind,
          evidence_id,
          unresolved,
          created_at,
          updated_at,
          resolved_at
        ) VALUES (?, ?, ?, 1, ?, ?, NULL)
        ON CONFLICT(module_id, evidence_kind, evidence_id)
        DO UPDATE SET
          unresolved = 1,
          updated_at = excluded.updated_at,
          resolved_at = NULL
      `).run(
        moduleId,
        kind,
        evidenceId,
        now,
        now
      );
      return this.#getEvidence(
        moduleId,
        kind,
        evidenceId
      );
    });
  }

  public resolveEvidence(
    moduleId: string,
    kind: ModuleEvidenceKind,
    evidenceId: string
  ): ModuleLifecycleEvidence {
    validateModuleId(moduleId);
    validateEvidenceKind(kind);
    validateEvidenceId(evidenceId);
    const now = this.#now().toISOString();

    return transaction(this.#database, () => {
      const result = this.#database.prepare(`
        UPDATE module_lifecycle_evidence
        SET unresolved = 0,
            updated_at = ?,
            resolved_at = ?
        WHERE module_id = ?
          AND evidence_kind = ?
          AND evidence_id = ?
      `).run(
        now,
        now,
        moduleId,
        kind,
        evidenceId
      );
      if (result.changes !== 1) {
        fail(
          "MODULE_EVIDENCE_NOT_FOUND",
          "module lifecycle evidence does not exist"
        );
      }
      return this.#getEvidence(
        moduleId,
        kind,
        evidenceId
      );
    });
  }

  public listUnresolvedEvidence(
    moduleId: string
  ): readonly ModuleLifecycleEvidence[] {
    validateModuleId(moduleId);
    this.getLifecycle(moduleId);
    const rows = this.#database.prepare(`
      SELECT
        module_id,
        evidence_kind,
        evidence_id,
        unresolved,
        created_at,
        updated_at,
        resolved_at
      FROM module_lifecycle_evidence
      WHERE module_id = ? AND unresolved = 1
      ORDER BY evidence_kind, evidence_id
    `).all(moduleId);

    return Object.freeze(rows.map(parseEvidenceRow));
  }

  #setEnabled(
    moduleId: string,
    expectedRuntimeGeneration: number,
    enabled: boolean
  ): ModuleLifecycleSnapshot {
    validateModuleId(moduleId);
    validateGeneration(
      expectedRuntimeGeneration,
      "expectedRuntimeGeneration"
    );
    const now = this.#now().toISOString();

    return transaction(this.#database, () => {
      const current = this.getLifecycle(moduleId);
      if (
        current.runtimeGeneration !==
        expectedRuntimeGeneration
      ) {
        fail(
          "MODULE_RUNTIME_STALE",
          `expected runtime generation ${expectedRuntimeGeneration}, current generation is ${current.runtimeGeneration}`
        );
      }
      if (current.status === "REMOVED") {
        fail(
          "MODULE_REMOVED",
          "removed module cannot be enabled or disabled"
        );
      }

      const targetStatus: ModuleLifecycleStatus =
        enabled ? "ENABLED" : "DISABLED";
      if (current.status === targetStatus) {
        return current;
      }
      if (
        current.runtimeGeneration ===
        Number.MAX_SAFE_INTEGER
      ) {
        fail(
          "MODULE_RUNTIME_GENERATION_EXHAUSTED",
          "module runtime generation is exhausted"
        );
      }

      const nextGeneration =
        current.runtimeGeneration + 1;
      const result = this.#database.prepare(`
        UPDATE module_registry
        SET lifecycle_status = ?,
            runtime_enabled = ?,
            runtime_generation = ?,
            removed_at = NULL,
            updated_at = ?
        WHERE module_id = ?
          AND runtime_generation = ?
      `).run(
        targetStatus,
        enabled ? 1 : 0,
        nextGeneration,
        now,
        moduleId,
        expectedRuntimeGeneration
      );
      if (result.changes !== 1) {
        fail(
          "MODULE_RUNTIME_STALE",
          "module runtime generation changed during lifecycle transition",
          true
        );
      }

      return this.getLifecycle(moduleId);
    });
  }

  #getEvidence(
    moduleId: string,
    kind: ModuleEvidenceKind,
    evidenceId: string
  ): ModuleLifecycleEvidence {
    const row = this.#database.prepare(`
      SELECT
        module_id,
        evidence_kind,
        evidence_id,
        unresolved,
        created_at,
        updated_at,
        resolved_at
      FROM module_lifecycle_evidence
      WHERE module_id = ?
        AND evidence_kind = ?
        AND evidence_id = ?
    `).get(moduleId, kind, evidenceId);
    if (row === undefined) {
      fail(
        "MODULE_EVIDENCE_NOT_FOUND",
        "module lifecycle evidence does not exist"
      );
    }
    return parseEvidenceRow(row);
  }
}
