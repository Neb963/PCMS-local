import type { DatabaseSync } from "node:sqlite";

import {
  computeModuleAuthorityDelta,
  normalizeModuleAuthorityEnvelope,
  parseSerializedModuleAuthorityDelta,
  parseSerializedModuleAuthorityEnvelope,
  serializeModuleAuthorityDelta,
  serializeModuleAuthorityEnvelope,
  type ModuleAuthorityDelta,
  type ModuleAuthorityEnvelope
} from "./authority.js";

const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export type ModuleAuthorityApprovalStatus =
  | "NOT_REQUIRED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "DECLINED";

export interface ModuleCandidateAuthority {
  readonly moduleId: string;
  readonly stateGeneration: number;
  readonly requestedAuthority: ModuleAuthorityEnvelope;
  readonly delta: ModuleAuthorityDelta;
  readonly approvalStatus: ModuleAuthorityApprovalStatus;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly activatedAt: string | null;
}

export interface ModuleActivationResult {
  readonly moduleId: string;
  readonly previousVersion: string;
  readonly activeVersion: string;
  readonly previousStateGeneration: number;
  readonly activeStateGeneration: number;
  readonly runtimeGeneration: number;
  readonly approvedAuthority: ModuleAuthorityEnvelope;
  readonly activatedAt: string;
}

export interface ModuleActivationStoreOptions {
  readonly now?: () => Date;
}

export class ModuleActivationError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(
    code: string,
    message: string,
    retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ModuleActivationError";
    this.code = code;
    this.retryable = retryable;
  }
}

interface CandidateAuthorityRow {
  readonly module_id: string;
  readonly state_generation: number;
  readonly requested_authority_json: string;
  readonly authority_delta_json: string;
  readonly approval_status: string;
  readonly requested_at: string;
  readonly decided_at: string | null;
  readonly activated_at: string | null;
}

function fail(
  code: string,
  message: string,
  retryable = false,
  cause?: unknown
): never {
  throw new ModuleActivationError(
    code,
    message,
    retryable,
    cause === undefined ? undefined : { cause }
  );
}

function validateModuleId(moduleId: string): void {
  if (moduleId.length > 64 || !MODULE_ID.test(moduleId)) {
    fail("INVALID_MODULE_ACTIVATION", "moduleId has invalid syntax");
  }
}

function validateGeneration(stateGeneration: number): void {
  if (!Number.isSafeInteger(stateGeneration) || stateGeneration < 1) {
    fail(
      "INVALID_MODULE_ACTIVATION",
      "stateGeneration must be a positive safe integer"
    );
  }
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
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

function parseApprovalStatus(
  value: string
): ModuleAuthorityApprovalStatus {
  if (
    value === "NOT_REQUIRED" ||
    value === "AWAITING_APPROVAL" ||
    value === "APPROVED" ||
    value === "DECLINED"
  ) {
    return value;
  }
  fail(
    "MODULE_AUTHORITY_CORRUPT",
    `invalid module authority approval status: ${value}`
  );
}

function parseCandidateAuthorityRow(
  row: Record<string, unknown> | undefined
): ModuleCandidateAuthority {
  if (row === undefined) {
    fail(
      "MODULE_CANDIDATE_AUTHORITY_MISSING",
      "module candidate authority record does not exist"
    );
  }

  const candidate = row as unknown as CandidateAuthorityRow;
  if (
    typeof candidate.module_id !== "string" ||
    typeof candidate.state_generation !== "number" ||
    !Number.isSafeInteger(candidate.state_generation) ||
    typeof candidate.requested_authority_json !== "string" ||
    typeof candidate.authority_delta_json !== "string" ||
    typeof candidate.approval_status !== "string" ||
    typeof candidate.requested_at !== "string" ||
    !(
      candidate.decided_at === null ||
      typeof candidate.decided_at === "string"
    ) ||
    !(
      candidate.activated_at === null ||
      typeof candidate.activated_at === "string"
    )
  ) {
    fail(
      "MODULE_AUTHORITY_CORRUPT",
      "module candidate authority record contains invalid metadata"
    );
  }

  try {
    return Object.freeze({
      moduleId: candidate.module_id,
      stateGeneration: candidate.state_generation,
      requestedAuthority: parseSerializedModuleAuthorityEnvelope(
        candidate.requested_authority_json
      ),
      delta: parseSerializedModuleAuthorityDelta(
        candidate.authority_delta_json
      ),
      approvalStatus: parseApprovalStatus(
        candidate.approval_status
      ),
      requestedAt: candidate.requested_at,
      decidedAt: candidate.decided_at,
      activatedAt: candidate.activated_at
    });
  } catch (error: unknown) {
    if (error instanceof ModuleActivationError) throw error;
    fail(
      "MODULE_AUTHORITY_CORRUPT",
      "module candidate authority record could not be decoded",
      false,
      error
    );
  }
}

export class ModuleActivationStore {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  public constructor(
    database: DatabaseSync,
    options: ModuleActivationStoreOptions = {}
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  public getApprovedAuthority(
    moduleId: string
  ): ModuleAuthorityEnvelope {
    validateModuleId(moduleId);
    const row = this.#database.prepare(`
      SELECT approved_authority_json
      FROM module_registry
      WHERE module_id = ?
    `).get(moduleId);
    if (row === undefined) {
      fail("MODULE_NOT_REGISTERED", "module is not registered");
    }
    const serialized = row["approved_authority_json"];
    if (typeof serialized !== "string") {
      fail(
        "MODULE_AUTHORITY_CORRUPT",
        "module registry authority metadata is invalid"
      );
    }
    try {
      return parseSerializedModuleAuthorityEnvelope(serialized);
    } catch (error: unknown) {
      fail(
        "MODULE_AUTHORITY_CORRUPT",
        "approved module authority could not be decoded",
        false,
        error
      );
    }
  }

  public stageCandidateAuthority(
    moduleId: string,
    stateGeneration: number,
    requestedAuthority: ModuleAuthorityEnvelope
  ): ModuleCandidateAuthority {
    validateModuleId(moduleId);
    validateGeneration(stateGeneration);
    const requested =
      normalizeModuleAuthorityEnvelope(requestedAuthority);
    const requestedAt = this.#now().toISOString();

    return transaction(this.#database, () => {
      const current = this.getApprovedAuthority(moduleId);
      const generation = this.#database.prepare(`
        SELECT status
        FROM module_state_generations
        WHERE module_id = ? AND state_generation = ?
      `).get(moduleId, stateGeneration);
      if (generation === undefined) {
        fail(
          "MODULE_CANDIDATE_MISSING",
          "module candidate state generation does not exist"
        );
      }
      if (generation["status"] !== "READY_TO_SWITCH") {
        fail(
          "MODULE_CANDIDATE_NOT_READY",
          "module candidate is not ready to switch"
        );
      }

      const existing = this.#database.prepare(`
        SELECT module_id
        FROM module_generation_authority
        WHERE module_id = ? AND state_generation = ?
      `).get(moduleId, stateGeneration);
      if (existing !== undefined) {
        fail(
          "MODULE_CANDIDATE_AUTHORITY_EXISTS",
          "module candidate authority is already staged"
        );
      }

      const delta = computeModuleAuthorityDelta(
        current,
        requested
      );
      const approvalStatus: ModuleAuthorityApprovalStatus =
        delta.expands ? "AWAITING_APPROVAL" : "NOT_REQUIRED";

      this.#database.prepare(`
        INSERT INTO module_generation_authority (
          module_id,
          state_generation,
          requested_authority_json,
          authority_delta_json,
          approval_status,
          requested_at,
          decided_at,
          activated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        moduleId,
        stateGeneration,
        serializeModuleAuthorityEnvelope(requested),
        serializeModuleAuthorityDelta(delta),
        approvalStatus,
        requestedAt
      );

      return this.getCandidateAuthority(
        moduleId,
        stateGeneration
      );
    });
  }

  public getCandidateAuthority(
    moduleId: string,
    stateGeneration: number
  ): ModuleCandidateAuthority {
    validateModuleId(moduleId);
    validateGeneration(stateGeneration);

    const row = this.#database.prepare(`
      SELECT
        module_id,
        state_generation,
        requested_authority_json,
        authority_delta_json,
        approval_status,
        requested_at,
        decided_at,
        activated_at
      FROM module_generation_authority
      WHERE module_id = ? AND state_generation = ?
    `).get(moduleId, stateGeneration);
    return parseCandidateAuthorityRow(row);
  }

  public approveCandidateAuthority(
    moduleId: string,
    stateGeneration: number
  ): ModuleCandidateAuthority {
    return this.#decideCandidateAuthority(
      moduleId,
      stateGeneration,
      "APPROVED"
    );
  }

  public declineCandidateAuthority(
    moduleId: string,
    stateGeneration: number
  ): ModuleCandidateAuthority {
    return this.#decideCandidateAuthority(
      moduleId,
      stateGeneration,
      "DECLINED"
    );
  }

  public activateReadyCandidate(
    moduleId: string,
    stateGeneration: number
  ): ModuleActivationResult {
    validateModuleId(moduleId);
    validateGeneration(stateGeneration);
    const activatedAt = this.#now().toISOString();

    return transaction(this.#database, () => {
      const registry = this.#database.prepare(`
        SELECT
          active_version,
          active_state_generation,
          runtime_generation,
          state_revision,
          lifecycle_status
        FROM module_registry
        WHERE module_id = ?
      `).get(moduleId);
      if (registry === undefined) {
        fail("MODULE_NOT_REGISTERED", "module is not registered");
      }

      const previousVersion = registry["active_version"];
      const previousStateGeneration =
        registry["active_state_generation"];
      const runtimeGeneration = registry["runtime_generation"];
      const stateRevision = registry["state_revision"];
      const lifecycleStatus = registry["lifecycle_status"];
      if (
        typeof previousVersion !== "string" ||
        typeof previousStateGeneration !== "number" ||
        !Number.isSafeInteger(previousStateGeneration) ||
        typeof runtimeGeneration !== "number" ||
        !Number.isSafeInteger(runtimeGeneration) ||
        typeof stateRevision !== "number" ||
        !Number.isSafeInteger(stateRevision) ||
        typeof lifecycleStatus !== "string"
      ) {
        fail(
          "MODULE_ACTIVATION_CORRUPT",
          "module registry activation metadata is invalid"
        );
      }
      if (lifecycleStatus === "REMOVED") {
        fail(
          "MODULE_REMOVED",
          "removed module cannot activate a candidate"
        );
      }
      if (
        lifecycleStatus !== "ENABLED" &&
        lifecycleStatus !== "DISABLED"
      ) {
        fail(
          "MODULE_ACTIVATION_CORRUPT",
          "module lifecycle status is invalid"
        );
      }
      if (runtimeGeneration >= Number.MAX_SAFE_INTEGER) {
        fail(
          "MODULE_RUNTIME_GENERATION_EXHAUSTED",
          "module runtime generation is exhausted"
        );
      }

      const candidate = this.#database.prepare(`
        SELECT
          module_version,
          schema_version,
          status,
          base_state_generation,
          base_state_revision
        FROM module_state_generations
        WHERE module_id = ? AND state_generation = ?
      `).get(moduleId, stateGeneration);
      if (candidate === undefined) {
        fail(
          "MODULE_CANDIDATE_MISSING",
          "module candidate state generation does not exist"
        );
      }

      const activeVersion = candidate["module_version"];
      const stateSchemaVersion = candidate["schema_version"];
      const candidateStatus = candidate["status"];
      const baseStateGeneration =
        candidate["base_state_generation"];
      const baseStateRevision = candidate["base_state_revision"];
      if (
        typeof activeVersion !== "string" ||
        typeof stateSchemaVersion !== "number" ||
        !Number.isSafeInteger(stateSchemaVersion) ||
        typeof candidateStatus !== "string" ||
        typeof baseStateGeneration !== "number" ||
        !Number.isSafeInteger(baseStateGeneration) ||
        typeof baseStateRevision !== "number" ||
        !Number.isSafeInteger(baseStateRevision)
      ) {
        fail(
          "MODULE_ACTIVATION_CORRUPT",
          "module candidate activation metadata is invalid"
        );
      }
      if (candidateStatus !== "READY_TO_SWITCH") {
        fail(
          "MODULE_CANDIDATE_NOT_READY",
          "module candidate is not ready to switch"
        );
      }
      if (
        baseStateGeneration !== previousStateGeneration ||
        baseStateRevision !== stateRevision
      ) {
        fail(
          "MODULE_CANDIDATE_STALE",
          "module candidate no longer derives from the active state",
          true
        );
      }

      const authority = this.getCandidateAuthority(
        moduleId,
        stateGeneration
      );
      if (authority.approvalStatus === "AWAITING_APPROVAL") {
        fail(
          "MODULE_CAPABILITY_APPROVAL_REQUIRED",
          "module capability expansion requires explicit approval"
        );
      }
      if (authority.approvalStatus === "DECLINED") {
        fail(
          "MODULE_CAPABILITY_APPROVAL_DECLINED",
          "module capability expansion was declined"
        );
      }
      if (
        authority.approvalStatus !== "NOT_REQUIRED" &&
        authority.approvalStatus !== "APPROVED"
      ) {
        fail(
          "MODULE_AUTHORITY_CORRUPT",
          "module candidate has invalid activation approval state"
        );
      }

      this.#database.prepare(`
        UPDATE module_state_generations
        SET status = 'RETAINED'
        WHERE module_id = ?
          AND state_generation = ?
          AND status = 'ACTIVE'
      `).run(
        moduleId,
        previousStateGeneration
      );
      this.#database.prepare(`
        UPDATE module_state_generations
        SET status = 'ACTIVE'
        WHERE module_id = ?
          AND state_generation = ?
          AND status = 'READY_TO_SWITCH'
      `).run(moduleId, stateGeneration);

      const nextRuntimeGeneration = runtimeGeneration + 1;
      this.#database.prepare(`
        UPDATE module_registry
        SET active_version = ?,
            active_state_generation = ?,
            runtime_generation = ?,
            state_schema_version = ?,
            state_revision = 0,
            approved_authority_json = ?,
            activated_at = ?,
            updated_at = ?
        WHERE module_id = ?
      `).run(
        activeVersion,
        stateGeneration,
        nextRuntimeGeneration,
        stateSchemaVersion,
        serializeModuleAuthorityEnvelope(
          authority.requestedAuthority
        ),
        activatedAt,
        activatedAt,
        moduleId
      );

      this.#database.prepare(`
        UPDATE module_generation_authority
        SET activated_at = ?
        WHERE module_id = ? AND state_generation = ?
      `).run(
        activatedAt,
        moduleId,
        stateGeneration
      );

      return Object.freeze({
        moduleId,
        previousVersion,
        activeVersion,
        previousStateGeneration,
        activeStateGeneration: stateGeneration,
        runtimeGeneration: nextRuntimeGeneration,
        approvedAuthority: authority.requestedAuthority,
        activatedAt
      });
    });
  }

  #decideCandidateAuthority(
    moduleId: string,
    stateGeneration: number,
    decision: "APPROVED" | "DECLINED"
  ): ModuleCandidateAuthority {
    validateModuleId(moduleId);
    validateGeneration(stateGeneration);
    const decidedAt = this.#now().toISOString();

    return transaction(this.#database, () => {
      const current = this.getCandidateAuthority(
        moduleId,
        stateGeneration
      );
      if (current.approvalStatus !== "AWAITING_APPROVAL") {
        fail(
          "MODULE_CAPABILITY_APPROVAL_NOT_PENDING",
          "module candidate does not have a pending capability expansion"
        );
      }

      this.#database.prepare(`
        UPDATE module_generation_authority
        SET approval_status = ?, decided_at = ?
        WHERE module_id = ? AND state_generation = ?
      `).run(
        decision,
        decidedAt,
        moduleId,
        stateGeneration
      );
      return this.getCandidateAuthority(
        moduleId,
        stateGeneration
      );
    });
  }
}
