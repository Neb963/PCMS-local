import type { DatabaseSync } from "node:sqlite";

import {
  ProviderGate,
  type ProviderGateLimits
} from "./provider-gate.js";

const SAFE_EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_KIND = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_METADATA_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SENSITIVE_METADATA_KEY =
  /(password|passwd|secret|token|cookie|authorization|verification[-_]?code|private[-_]?key)/iu;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_STRING_LENGTH = 1024;
const MAX_METADATA_JSON_LENGTH = 8192;
const MAX_PRECONDITIONS = 32;
const MAX_PRECONDITION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type OperationState =
  | "PREPARED"
  | "RUNNING"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED_SAFE"
  | "UNCERTAIN"
  | "CANCELLED"
  | "NEEDS_HUMAN";

export type SafeOperationMetadataValue =
  | string
  | number
  | boolean
  | null;

export type SafeOperationMetadata = Readonly<
  Record<string, SafeOperationMetadataValue>
>;

export type OperationOwner =
  | Readonly<{ kind: "CORE" }>
  | Readonly<{
      kind: "MODULE";
      moduleId: string;
      moduleVersion: string;
      runtimeGeneration: number;
    }>;

export interface OperationPrecondition {
  readonly key: string;
  readonly observedAt: string;
  readonly maxAgeMs: number;
  readonly evidenceRef: string;
}

export interface PrepareOperationInput {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly owner: OperationOwner;
  readonly actorSource: string;
  readonly targetKey: string;
  readonly operationKind: string;
  readonly schemaVersion: number;
  readonly personaUid?: string | null;
  readonly accountId?: string | null;
  readonly desiredFingerprint: string;
  readonly provenance: SafeOperationMetadata;
  readonly preconditions: readonly OperationPrecondition[];
  readonly attempt?: number;
}

export interface DispatchAuthorizationInput {
  readonly operationId: string;
  readonly expectedClaimEpoch: number;
  readonly evidence: SafeOperationMetadata;
}

export type OperationExecutionLossSource =
  | "MODULE"
  | "BROWSER"
  | "NETWORK"
  | "CONTROL_PLANE";

export type OperationEffectState =
  | "NOT_DISPATCHED"
  | "MAY_HAVE_OCCURRED";

export interface RecordExecutionLossInput {
  readonly operationId: string;
  readonly expectedClaimEpoch: number;
  readonly source: OperationExecutionLossSource;
  readonly effectState: OperationEffectState;
}

export interface DispatchPermit {
  readonly operationId: string;
  readonly targetKey: string;
  readonly claimEpoch: number;
  readonly attempt: number;
  readonly authorizedAt: string;
}

export interface OperationRecord {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly state: OperationState;
  readonly targetKey: string;
  readonly operationKind: string;
  readonly schemaVersion: number;
  readonly owner: OperationOwner;
  readonly actorSource: string;
  readonly personaUid: string | null;
  readonly accountId: string | null;
  readonly desiredFingerprint: string;
  readonly provenance: SafeOperationMetadata;
  readonly preconditions: readonly OperationPrecondition[];
  readonly attempt: number;
  readonly claimEpoch: number;
  readonly dispatchAuthorizedAt: string | null;
  readonly dispatchEvidence: SafeOperationMetadata | null;
  readonly cancellationRequestedAt: string | null;
  readonly lastTransitionReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
  readonly revision: number;
}

export interface OperationCoordinatorOptions {
  readonly database: DatabaseSync;
  readonly now?: () => Date;
  readonly providerGate?: ProviderGateLimits;
}

export type OperationCoordinatorErrorCode =
  | "OPERATION_INVALID_INPUT"
  | "OPERATION_NOT_FOUND"
  | "OPERATION_ID_CONFLICT"
  | "OPERATION_IDEMPOTENCY_CONFLICT"
  | "OPERATION_TARGET_CLAIMED"
  | "OPERATION_CLAIM_STALE"
  | "OPERATION_INVALID_TRANSITION"
  | "OPERATION_PREFLIGHT_STALE"
  | "OPERATION_MODULE_OWNER_STALE"
  | "OPERATION_ROW_INVALID"
  | "OPERATION_EPOCH_EXHAUSTED";

export class OperationCoordinatorError extends Error {
  public constructor(
    public readonly code: OperationCoordinatorErrorCode,
    message: string,
    public readonly retryable = false,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OperationCoordinatorError";
  }
}

interface PreparedOperationInput {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly owner: OperationOwner;
  readonly actorSource: string;
  readonly targetKey: string;
  readonly operationKind: string;
  readonly schemaVersion: number;
  readonly personaUid: string | null;
  readonly accountId: string | null;
  readonly desiredFingerprint: string;
  readonly provenance: SafeOperationMetadata;
  readonly preconditions: readonly OperationPrecondition[];
  readonly attempt: number;
}

interface OperationRow {
  readonly operation_id: unknown;
  readonly idempotency_key: unknown;
  readonly state: unknown;
  readonly target_key: unknown;
  readonly operation_kind: unknown;
  readonly schema_version: unknown;
  readonly owner_kind: unknown;
  readonly owner_module_id: unknown;
  readonly owner_module_version: unknown;
  readonly owner_runtime_generation: unknown;
  readonly actor_source: unknown;
  readonly persona_uid: unknown;
  readonly account_id: unknown;
  readonly desired_fingerprint: unknown;
  readonly provenance_json: unknown;
  readonly preconditions_json: unknown;
  readonly attempt: unknown;
  readonly claim_epoch: unknown;
  readonly dispatch_authorized_at: unknown;
  readonly dispatch_evidence_json: unknown;
  readonly cancellation_requested_at: unknown;
  readonly last_transition_reason: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly terminal_at: unknown;
  readonly revision: unknown;
}

const UNRESOLVED_STATES: readonly OperationState[] = Object.freeze([
  "PREPARED",
  "RUNNING",
  "VERIFYING",
  "UNCERTAIN",
  "NEEDS_HUMAN"
]);

const TERMINAL_STATES: readonly OperationState[] = Object.freeze([
  "SUCCEEDED",
  "FAILED_SAFE",
  "CANCELLED"
]);

const LEGAL_TRANSITIONS = {
  PREPARED: ["RUNNING", "CANCELLED"],
  RUNNING: ["VERIFYING", "FAILED_SAFE", "UNCERTAIN"],
  VERIFYING: [
    "SUCCEEDED",
    "FAILED_SAFE",
    "UNCERTAIN",
    "NEEDS_HUMAN"
  ],
  SUCCEEDED: [],
  FAILED_SAFE: [],
  UNCERTAIN: ["VERIFYING"],
  CANCELLED: [],
  NEEDS_HUMAN: ["VERIFYING"]
} as const satisfies Readonly<
  Record<OperationState, readonly OperationState[]>
>;

function fail(
  code: OperationCoordinatorErrorCode,
  message: string,
  retryable = false,
  cause?: unknown
): never {
  throw new OperationCoordinatorError(code, message, retryable, cause);
}

function transaction<T>(database: DatabaseSync, run: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = run();
    database.exec("COMMIT");
    return value;
  } catch (error: unknown) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function validateEvidenceId(value: string, label: string): void {
  if (!SAFE_EVIDENCE_ID.test(value)) {
    fail("OPERATION_INVALID_INPUT", `${label} has invalid syntax`);
  }
}

function validateOpaqueId(value: string, label: string): void {
  if (!SAFE_OPAQUE_ID.test(value)) {
    fail("OPERATION_INVALID_INPUT", `${label} has invalid syntax`);
  }
}

function validateSafeKind(value: string, label: string): void {
  if (!SAFE_KIND.test(value)) {
    fail("OPERATION_INVALID_INPUT", `${label} has invalid syntax`);
  }
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("OPERATION_INVALID_INPUT", `${label} must be a positive safe integer`);
  }
}

function validateReason(reason: string): string {
  const normalized = reason.trim();
  if (normalized.length < 1 || normalized.length > 256) {
    fail(
      "OPERATION_INVALID_INPUT",
      "operation transition reason must contain 1-256 characters"
    );
  }
  return normalized;
}

function normalizeTimestamp(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    fail("OPERATION_INVALID_INPUT", `${label} must be a valid timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function normalizeMetadata(
  input: SafeOperationMetadata,
  label: string,
  requireNonEmpty: boolean
): SafeOperationMetadata {
  if (!isPlainObject(input)) {
    fail("OPERATION_INVALID_INPUT", `${label} must be a plain object`);
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length > MAX_METADATA_ENTRIES ||
    (requireNonEmpty && keys.length === 0)
  ) {
    fail(
      "OPERATION_INVALID_INPUT",
      `${label} must contain ${requireNonEmpty ? "1-" : "0-"}${MAX_METADATA_ENTRIES} safe entries`
    );
  }

  const normalized: Record<string, SafeOperationMetadataValue> = {};
  for (const key of keys) {
    if (!SAFE_METADATA_KEY.test(key) || SENSITIVE_METADATA_KEY.test(key)) {
      fail(
        "OPERATION_INVALID_INPUT",
        `${label} contains an unsafe metadata key: ${key}`
      );
    }
    const value = input[key];
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      fail(
        "OPERATION_INVALID_INPUT",
        `${label} values must be scalar JSON values`
      );
    }
    if (
      typeof value === "string" &&
      value.length > MAX_METADATA_STRING_LENGTH
    ) {
      fail(
        "OPERATION_INVALID_INPUT",
        `${label} string values must be at most ${MAX_METADATA_STRING_LENGTH} characters`
      );
    }
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) || !Number.isSafeInteger(value))
    ) {
      fail(
        "OPERATION_INVALID_INPUT",
        `${label} numeric values must be finite safe integers`
      );
    }
    normalized[key] = value;
  }

  const serialized = JSON.stringify(normalized);
  if (serialized.length > MAX_METADATA_JSON_LENGTH) {
    fail(
      "OPERATION_INVALID_INPUT",
      `${label} serialized form is too large`
    );
  }
  return Object.freeze(normalized);
}

function normalizePreconditions(
  input: readonly OperationPrecondition[]
): readonly OperationPrecondition[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_PRECONDITIONS) {
    fail(
      "OPERATION_INVALID_INPUT",
      `preconditions must contain 1-${MAX_PRECONDITIONS} observations`
    );
  }

  const keys = new Set<string>();
  const normalized = input.map((item) => {
    if (!isPlainObject(item)) {
      fail("OPERATION_INVALID_INPUT", "precondition must be an object");
    }

    const key = item["key"];
    const evidenceRef = item["evidenceRef"];
    const maxAgeMs = item["maxAgeMs"];
    const observedAt = item["observedAt"];

    if (
      typeof key !== "string" ||
      !SAFE_METADATA_KEY.test(key) ||
      SENSITIVE_METADATA_KEY.test(key)
    ) {
      fail("OPERATION_INVALID_INPUT", "precondition key has invalid syntax");
    }
    if (keys.has(key)) {
      fail(
        "OPERATION_INVALID_INPUT",
        `duplicate precondition key: ${key}`
      );
    }
    keys.add(key);

    if (
      typeof evidenceRef !== "string" ||
      !SAFE_REFERENCE.test(evidenceRef)
    ) {
      fail(
        "OPERATION_INVALID_INPUT",
        `precondition ${key} evidenceRef has invalid syntax`
      );
    }
    if (
      typeof maxAgeMs !== "number" ||
      !Number.isSafeInteger(maxAgeMs) ||
      maxAgeMs < 1 ||
      maxAgeMs > MAX_PRECONDITION_AGE_MS
    ) {
      fail(
        "OPERATION_INVALID_INPUT",
        `precondition ${key} maxAgeMs must be between 1 and ${MAX_PRECONDITION_AGE_MS}`
      );
    }
    if (typeof observedAt !== "string") {
      fail(
        "OPERATION_INVALID_INPUT",
        `precondition ${key} observedAt must be a string timestamp`
      );
    }

    return Object.freeze({
      key,
      observedAt: normalizeTimestamp(
        observedAt,
        `precondition ${key} observedAt`
      ),
      maxAgeMs,
      evidenceRef
    });
  });

  normalized.sort((left, right) => left.key.localeCompare(right.key));
  const serialized = JSON.stringify(normalized);
  if (serialized.length > 16_384) {
    fail("OPERATION_INVALID_INPUT", "serialized preconditions are too large");
  }
  return Object.freeze(normalized);
}

function normalizeOwner(owner: OperationOwner): OperationOwner {
  if (owner.kind === "CORE") {
    return Object.freeze({ kind: "CORE" });
  }
  if (owner.kind !== "MODULE") {
    fail("OPERATION_INVALID_INPUT", "operation owner kind is invalid");
  }
  if (owner.moduleId.length > 64 || !MODULE_ID.test(owner.moduleId)) {
    fail("OPERATION_INVALID_INPUT", "operation owner moduleId has invalid syntax");
  }
  const moduleVersion = owner.moduleVersion.trim();
  if (moduleVersion.length < 1 || moduleVersion.length > 128) {
    fail(
      "OPERATION_INVALID_INPUT",
      "operation owner moduleVersion must contain 1-128 characters"
    );
  }
  validatePositiveInteger(owner.runtimeGeneration, "owner runtimeGeneration");
  return Object.freeze({
    kind: "MODULE",
    moduleId: owner.moduleId,
    moduleVersion,
    runtimeGeneration: owner.runtimeGeneration
  });
}

function normalizeTargetKey(targetKey: string): string {
  const generatorPrefix = "perchance:generator:";
  const accountPrefix = "perchance:account:";
  const personaPrefix = "persona:";
  const personaSuffix = ":control";

  if (targetKey.startsWith(generatorPrefix)) {
    validateOpaqueId(targetKey.slice(generatorPrefix.length), "generator target ID");
    return targetKey;
  }
  if (targetKey.startsWith(accountPrefix)) {
    validateOpaqueId(targetKey.slice(accountPrefix.length), "account target ID");
    return targetKey;
  }
  if (targetKey.startsWith(personaPrefix) && targetKey.endsWith(personaSuffix)) {
    const personaUid = targetKey.slice(
      personaPrefix.length,
      -personaSuffix.length
    );
    validateOpaqueId(personaUid, "Persona target ID");
    return targetKey;
  }
  fail(
    "OPERATION_INVALID_INPUT",
    "targetKey must use a supported stable PCMS target identity"
  );
}

export function generatorOperationTargetKey(generatorLocalId: string): string {
  validateOpaqueId(generatorLocalId, "generatorLocalId");
  return `perchance:generator:${generatorLocalId}`;
}

export function accountOperationTargetKey(accountId: string): string {
  validateOpaqueId(accountId, "accountId");
  return `perchance:account:${accountId}`;
}

export function personaControlOperationTargetKey(personaUid: string): string {
  validateOpaqueId(personaUid, "personaUid");
  return `persona:${personaUid}:control`;
}

function prepareInput(input: PrepareOperationInput): PreparedOperationInput {
  validateEvidenceId(input.operationId, "operationId");
  validateEvidenceId(input.idempotencyKey, "idempotencyKey");
  validateSafeKind(input.actorSource, "actorSource");
  validateSafeKind(input.operationKind, "operationKind");
  validatePositiveInteger(input.schemaVersion, "schemaVersion");

  const personaUid = input.personaUid ?? null;
  const accountId = input.accountId ?? null;
  if (personaUid !== null) {
    validateOpaqueId(personaUid, "personaUid");
  }
  if (accountId !== null) {
    validateOpaqueId(accountId, "accountId");
  }
  if (!SHA256_HEX.test(input.desiredFingerprint)) {
    fail(
      "OPERATION_INVALID_INPUT",
      "desiredFingerprint must be a lowercase SHA-256 hex digest of non-secret desired state"
    );
  }

  const attempt = input.attempt ?? 1;
  validatePositiveInteger(attempt, "attempt");

  return Object.freeze({
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    owner: normalizeOwner(input.owner),
    actorSource: input.actorSource,
    targetKey: normalizeTargetKey(input.targetKey),
    operationKind: input.operationKind,
    schemaVersion: input.schemaVersion,
    personaUid,
    accountId,
    desiredFingerprint: input.desiredFingerprint,
    provenance: normalizeMetadata(input.provenance, "provenance", true),
    preconditions: normalizePreconditions(input.preconditions),
    attempt
  });
}

function isOperationState(value: unknown): value is OperationState {
  return (
    value === "PREPARED" ||
    value === "RUNNING" ||
    value === "VERIFYING" ||
    value === "SUCCEEDED" ||
    value === "FAILED_SAFE" ||
    value === "UNCERTAIN" ||
    value === "CANCELLED" ||
    value === "NEEDS_HUMAN"
  );
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    fail("OPERATION_ROW_INVALID", `stored ${label} is not valid JSON`, false, error);
  }
}

function parseStoredMetadata(value: unknown, label: string): SafeOperationMetadata {
  if (typeof value !== "string") {
    fail("OPERATION_ROW_INVALID", `stored ${label} is invalid`);
  }
  const parsed = parseJson(value, label);
  try {
    return normalizeMetadata(
      parsed as SafeOperationMetadata,
      label,
      label !== "dispatch evidence"
    );
  } catch (error: unknown) {
    fail("OPERATION_ROW_INVALID", `stored ${label} is invalid`, false, error);
  }
}

function parseStoredPreconditions(value: unknown): readonly OperationPrecondition[] {
  if (typeof value !== "string") {
    fail("OPERATION_ROW_INVALID", "stored preconditions are invalid");
  }
  const parsed = parseJson(value, "preconditions");
  try {
    return normalizePreconditions(parsed as readonly OperationPrecondition[]);
  } catch (error: unknown) {
    fail("OPERATION_ROW_INVALID", "stored preconditions are invalid", false, error);
  }
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    fail("OPERATION_ROW_INVALID", `stored ${label} is invalid`);
  }
  return value;
}

function parseOperationRow(row: OperationRow | undefined): OperationRecord | null {
  if (row === undefined) {
    return null;
  }

  if (
    typeof row.operation_id !== "string" ||
    typeof row.idempotency_key !== "string" ||
    !isOperationState(row.state) ||
    typeof row.target_key !== "string" ||
    typeof row.operation_kind !== "string" ||
    typeof row.schema_version !== "number" ||
    !Number.isSafeInteger(row.schema_version) ||
    row.schema_version < 1 ||
    typeof row.actor_source !== "string" ||
    typeof row.desired_fingerprint !== "string" ||
    typeof row.attempt !== "number" ||
    !Number.isSafeInteger(row.attempt) ||
    row.attempt < 1 ||
    typeof row.claim_epoch !== "number" ||
    !Number.isSafeInteger(row.claim_epoch) ||
    row.claim_epoch < 1 ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string" ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    fail("OPERATION_ROW_INVALID", "stored operation metadata is invalid");
  }

  let owner: OperationOwner;
  if (
    row.owner_kind === "CORE" &&
    row.owner_module_id === null &&
    row.owner_module_version === null &&
    row.owner_runtime_generation === null
  ) {
    owner = Object.freeze({ kind: "CORE" });
  } else if (
    row.owner_kind === "MODULE" &&
    typeof row.owner_module_id === "string" &&
    typeof row.owner_module_version === "string" &&
    typeof row.owner_runtime_generation === "number" &&
    Number.isSafeInteger(row.owner_runtime_generation) &&
    row.owner_runtime_generation > 0
  ) {
    owner = Object.freeze({
      kind: "MODULE",
      moduleId: row.owner_module_id,
      moduleVersion: row.owner_module_version,
      runtimeGeneration: row.owner_runtime_generation
    });
  } else {
    fail("OPERATION_ROW_INVALID", "stored operation owner is invalid");
  }

  const dispatchEvidence =
    row.dispatch_evidence_json === null
      ? null
      : parseStoredMetadata(row.dispatch_evidence_json, "dispatch evidence");

  return Object.freeze({
    operationId: row.operation_id,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    targetKey: row.target_key,
    operationKind: row.operation_kind,
    schemaVersion: row.schema_version,
    owner,
    actorSource: row.actor_source,
    personaUid: nullableString(row.persona_uid, "personaUid"),
    accountId: nullableString(row.account_id, "accountId"),
    desiredFingerprint: row.desired_fingerprint,
    provenance: parseStoredMetadata(row.provenance_json, "provenance"),
    preconditions: parseStoredPreconditions(row.preconditions_json),
    attempt: row.attempt,
    claimEpoch: row.claim_epoch,
    dispatchAuthorizedAt: nullableString(
      row.dispatch_authorized_at,
      "dispatchAuthorizedAt"
    ),
    dispatchEvidence,
    cancellationRequestedAt: nullableString(
      row.cancellation_requested_at,
      "cancellationRequestedAt"
    ),
    lastTransitionReason: nullableString(
      row.last_transition_reason,
      "lastTransitionReason"
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: nullableString(row.terminal_at, "terminalAt"),
    revision: row.revision
  });
}

function serializeMetadata(value: SafeOperationMetadata): string {
  return JSON.stringify(value);
}

function serializePreconditions(
  value: readonly OperationPrecondition[]
): string {
  return JSON.stringify(value);
}

function sameOwner(left: OperationOwner, right: OperationOwner): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "CORE" && right.kind === "CORE") {
    return true;
  }
  if (left.kind === "MODULE" && right.kind === "MODULE") {
    return (
      left.moduleId === right.moduleId &&
      left.moduleVersion === right.moduleVersion &&
      left.runtimeGeneration === right.runtimeGeneration
    );
  }
  return false;
}

function samePreparedIntent(
  existing: OperationRecord,
  prepared: PreparedOperationInput
): boolean {
  return (
    existing.idempotencyKey === prepared.idempotencyKey &&
    existing.targetKey === prepared.targetKey &&
    existing.operationKind === prepared.operationKind &&
    existing.schemaVersion === prepared.schemaVersion &&
    sameOwner(existing.owner, prepared.owner) &&
    existing.actorSource === prepared.actorSource &&
    existing.personaUid === prepared.personaUid &&
    existing.accountId === prepared.accountId &&
    existing.desiredFingerprint === prepared.desiredFingerprint &&
    serializeMetadata(existing.provenance) ===
      serializeMetadata(prepared.provenance) &&
    serializePreconditions(existing.preconditions) ===
      serializePreconditions(prepared.preconditions) &&
    existing.attempt === prepared.attempt
  );
}

function isTerminal(state: OperationState): boolean {
  return TERMINAL_STATES.includes(state);
}

function isUnresolved(state: OperationState): boolean {
  return UNRESOLVED_STATES.includes(state);
}

function assertLegalTransition(
  current: OperationState,
  next: OperationState
): void {
  const allowed: readonly OperationState[] = LEGAL_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    fail(
      "OPERATION_INVALID_TRANSITION",
      `operation transition ${current} -> ${next} is not legal`
    );
  }
}

function assertFreshPreconditions(
  preconditions: readonly OperationPrecondition[],
  now: Date
): void {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    fail("OPERATION_INVALID_INPUT", "coordinator clock returned an invalid time");
  }

  const stale: string[] = [];
  for (const item of preconditions) {
    const observedMs = Date.parse(item.observedAt);
    const ageMs = nowMs - observedMs;
    if (
      !Number.isFinite(observedMs) ||
      ageMs < 0 ||
      ageMs > item.maxAgeMs
    ) {
      stale.push(item.key);
    }
  }
  if (stale.length > 0) {
    fail(
      "OPERATION_PREFLIGHT_STALE",
      `mutation preflight is stale or invalid for: ${stale.sort().join(", ")}`,
      true
    );
  }
}

function selectOperationSql(where: string): string {
  return `
    SELECT
      operation_id,
      idempotency_key,
      state,
      target_key,
      operation_kind,
      schema_version,
      owner_kind,
      owner_module_id,
      owner_module_version,
      owner_runtime_generation,
      actor_source,
      persona_uid,
      account_id,
      desired_fingerprint,
      provenance_json,
      preconditions_json,
      attempt,
      claim_epoch,
      dispatch_authorized_at,
      dispatch_evidence_json,
      cancellation_requested_at,
      last_transition_reason,
      created_at,
      updated_at,
      terminal_at,
      revision
    FROM operations
    WHERE ${where}
  `;
}

export class OperationCoordinator {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;
  public readonly providerGate: ProviderGate;

  public constructor(options: OperationCoordinatorOptions) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.providerGate = new ProviderGate({
      database: options.database,
      now: this.#now,
      ...options.providerGate
    });
  }

  public get(operationId: string): OperationRecord | null {
    validateEvidenceId(operationId, "operationId");
    return this.#getByOperationId(operationId);
  }

  public require(operationId: string): OperationRecord {
    const operation = this.get(operationId);
    if (operation === null) {
      fail(
        "OPERATION_NOT_FOUND",
        `operation ${operationId} does not exist`
      );
    }
    return operation;
  }

  public getByIdempotencyKey(
    idempotencyKey: string
  ): OperationRecord | null {
    validateEvidenceId(idempotencyKey, "idempotencyKey");
    return this.#getByIdempotencyKey(idempotencyKey);
  }

  public getUnresolvedClaim(targetKey: string): OperationRecord | null {
    const normalizedTarget = normalizeTargetKey(targetKey);
    const row = this.#database.prepare(
      selectOperationSql(
        "target_key = ? AND state IN ('PREPARED','RUNNING','VERIFYING','UNCERTAIN','NEEDS_HUMAN')"
      )
    ).get(normalizedTarget) as unknown as OperationRow | undefined;
    return parseOperationRow(row);
  }

  public prepare(input: PrepareOperationInput): OperationRecord {
    const prepared = prepareInput(input);

    return transaction(this.#database, () => {
      const byOperationId = this.#getByOperationId(prepared.operationId);
      const byIdempotency = this.#getByIdempotencyKey(
        prepared.idempotencyKey
      );

      if (
        byOperationId !== null &&
        byIdempotency !== null &&
        byOperationId.operationId !== byIdempotency.operationId
      ) {
        fail(
          "OPERATION_ID_CONFLICT",
          "operationId and idempotencyKey already refer to different operations"
        );
      }

      const existing = byOperationId ?? byIdempotency;
      if (existing !== null) {
        if (samePreparedIntent(existing, prepared)) {
          return existing;
        }
        fail(
          byOperationId !== null
            ? "OPERATION_ID_CONFLICT"
            : "OPERATION_IDEMPOTENCY_CONFLICT",
          "existing operation identity is bound to a different durable mutation intent"
        );
      }

      const currentClaim = this.#getUnresolvedClaimUnchecked(
        prepared.targetKey
      );
      if (currentClaim !== null) {
        fail(
          "OPERATION_TARGET_CLAIMED",
          `target ${prepared.targetKey} is already claimed by operation ${currentClaim.operationId}`,
          true
        );
      }

      if (prepared.owner.kind === "MODULE") {
        this.#assertModuleOwnerCurrent(prepared.owner);
      }

      const claimEpoch = this.#nextClaimEpoch(prepared.targetKey);
      const now = this.#currentIso();
      const owner =
        prepared.owner.kind === "CORE"
          ? {
              kind: "CORE" as const,
              moduleId: null,
              moduleVersion: null,
              runtimeGeneration: null
            }
          : {
              kind: "MODULE" as const,
              moduleId: prepared.owner.moduleId,
              moduleVersion: prepared.owner.moduleVersion,
              runtimeGeneration: prepared.owner.runtimeGeneration
            };

      try {
        this.#database.prepare(`
          INSERT INTO operations (
            operation_id,
            idempotency_key,
            state,
            target_key,
            operation_kind,
            schema_version,
            owner_kind,
            owner_module_id,
            owner_module_version,
            owner_runtime_generation,
            actor_source,
            persona_uid,
            account_id,
            desired_fingerprint,
            provenance_json,
            preconditions_json,
            attempt,
            claim_epoch,
            dispatch_authorized_at,
            dispatch_evidence_json,
            cancellation_requested_at,
            last_transition_reason,
            created_at,
            updated_at,
            terminal_at,
            revision
          ) VALUES (
            ?, ?, 'PREPARED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            NULL, NULL, NULL, 'prepared', ?, ?, NULL, 0
          )
        `).run(
          prepared.operationId,
          prepared.idempotencyKey,
          prepared.targetKey,
          prepared.operationKind,
          prepared.schemaVersion,
          owner.kind,
          owner.moduleId,
          owner.moduleVersion,
          owner.runtimeGeneration,
          prepared.actorSource,
          prepared.personaUid,
          prepared.accountId,
          prepared.desiredFingerprint,
          serializeMetadata(prepared.provenance),
          serializePreconditions(prepared.preconditions),
          prepared.attempt,
          claimEpoch,
          now,
          now
        );
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message.includes(
            "operations_one_unresolved_claim_per_target"
          )
        ) {
          fail(
            "OPERATION_TARGET_CLAIMED",
            `target ${prepared.targetKey} was claimed concurrently`,
            true,
            error
          );
        }
        throw error;
      }

      if (prepared.owner.kind === "MODULE") {
        this.#recordModuleEvidence(
          prepared.owner.moduleId,
          prepared.operationId,
          now
        );
      }

      return this.#requireByOperationId(prepared.operationId);
    });
  }

  public refreshPreconditions(
    operationId: string,
    expectedClaimEpoch: number,
    preconditions: readonly OperationPrecondition[]
  ): OperationRecord {
    validateEvidenceId(operationId, "operationId");
    validatePositiveInteger(expectedClaimEpoch, "expectedClaimEpoch");
    const normalized = normalizePreconditions(preconditions);

    return transaction(this.#database, () => {
      const operation = this.#requireCurrentClaim(
        operationId,
        expectedClaimEpoch
      );
      if (operation.state !== "PREPARED") {
        fail(
          "OPERATION_INVALID_TRANSITION",
          "preconditions can only be refreshed while operation is PREPARED"
        );
      }
      const now = this.#currentIso();
      const result = this.#database.prepare(`
        UPDATE operations
        SET preconditions_json = ?,
            updated_at = ?,
            last_transition_reason = 'preconditions-refreshed',
            revision = revision + 1
        WHERE operation_id = ?
          AND claim_epoch = ?
          AND state = 'PREPARED'
      `).run(
        serializePreconditions(normalized),
        now,
        operationId,
        expectedClaimEpoch
      );
      if (result.changes !== 1) {
        fail(
          "OPERATION_CLAIM_STALE",
          "operation changed while refreshing preconditions",
          true
        );
      }
      return this.#requireByOperationId(operationId);
    });
  }

  public authorizeDispatch(
    input: DispatchAuthorizationInput
  ): DispatchPermit {
    validateEvidenceId(input.operationId, "operationId");
    validatePositiveInteger(
      input.expectedClaimEpoch,
      "expectedClaimEpoch"
    );
    const evidence = normalizeMetadata(
      input.evidence,
      "dispatch evidence",
      true
    );

    return transaction(this.#database, () => {
      const operation = this.#requireCurrentClaim(
        input.operationId,
        input.expectedClaimEpoch
      );
      if (operation.state !== "PREPARED") {
        fail(
          "OPERATION_INVALID_TRANSITION",
          `dispatch requires PREPARED state, found ${operation.state}`
        );
      }
      if (operation.owner.kind === "MODULE") {
        this.#assertModuleOwnerCurrent(operation.owner);
      }
      const nowDate = this.#currentDate();
      assertFreshPreconditions(operation.preconditions, nowDate);
      const authorizedAt = nowDate.toISOString();

      const result = this.#database.prepare(`
        UPDATE operations
        SET state = 'RUNNING',
            dispatch_authorized_at = ?,
            dispatch_evidence_json = ?,
            updated_at = ?,
            last_transition_reason = 'dispatch-authorized',
            revision = revision + 1
        WHERE operation_id = ?
          AND claim_epoch = ?
          AND state = 'PREPARED'
      `).run(
        authorizedAt,
        serializeMetadata(evidence),
        authorizedAt,
        input.operationId,
        input.expectedClaimEpoch
      );
      if (result.changes !== 1) {
        fail(
          "OPERATION_CLAIM_STALE",
          "operation changed before dispatch authorization",
          true
        );
      }

      return Object.freeze({
        operationId: operation.operationId,
        targetKey: operation.targetKey,
        claimEpoch: operation.claimEpoch,
        attempt: operation.attempt,
        authorizedAt
      });
    });
  }

  public recordExecutionLoss(
    input: RecordExecutionLossInput
  ): OperationRecord {
    validateEvidenceId(input.operationId, "operationId");
    validatePositiveInteger(
      input.expectedClaimEpoch,
      "expectedClaimEpoch"
    );
    if (
      input.source !== "MODULE" &&
      input.source !== "BROWSER" &&
      input.source !== "NETWORK" &&
      input.source !== "CONTROL_PLANE"
    ) {
      fail("OPERATION_INVALID_INPUT", "execution loss source is invalid");
    }
    if (
      input.effectState !== "NOT_DISPATCHED" &&
      input.effectState !== "MAY_HAVE_OCCURRED"
    ) {
      fail("OPERATION_INVALID_INPUT", "execution loss effect state is invalid");
    }

    const current = this.require(input.operationId);
    if (
      current.claimEpoch !== input.expectedClaimEpoch ||
      !isUnresolved(current.state)
    ) {
      fail(
        "OPERATION_CLAIM_STALE",
        `operation ${input.operationId} no longer owns unresolved claim epoch ${input.expectedClaimEpoch}`,
        true
      );
    }

    const source = input.source.toLowerCase().replace("_", "-");
    if (input.effectState === "MAY_HAVE_OCCURRED") {
      if (current.state === "UNCERTAIN") {
        return this.#requireCurrentClaim(
          input.operationId,
          input.expectedClaimEpoch
        );
      }
      if (current.state !== "RUNNING" && current.state !== "VERIFYING") {
        fail(
          "OPERATION_INVALID_TRANSITION",
          `possible-dispatch loss requires RUNNING or VERIFYING state, found ${current.state}`
        );
      }
      return this.#transition(
        input.operationId,
        input.expectedClaimEpoch,
        "UNCERTAIN",
        `${source}-loss-after-possible-dispatch`
      );
    }

    if (current.state !== "RUNNING") {
      fail(
        "OPERATION_INVALID_TRANSITION",
        `proven non-dispatch can become FAILED_SAFE only from RUNNING, found ${current.state}`
      );
    }
    return this.#transition(
      input.operationId,
      input.expectedClaimEpoch,
      "FAILED_SAFE",
      `${source}-loss-proven-not-dispatched`
    );
  }

  public requestCancellation(
    operationId: string,
    expectedClaimEpoch: number,
    reason = "operator-cancelled"
  ): OperationRecord {
    validateEvidenceId(operationId, "operationId");
    validatePositiveInteger(expectedClaimEpoch, "expectedClaimEpoch");
    const normalizedReason = validateReason(reason);

    return transaction(this.#database, () => {
      const operation = this.#requireCurrentClaim(
        operationId,
        expectedClaimEpoch
      );
      const now = this.#currentIso();

      let nextState: OperationState;
      if (operation.state === "PREPARED") {
        nextState = "CANCELLED";
      } else if (
        operation.state === "RUNNING" ||
        operation.state === "VERIFYING"
      ) {
        nextState = "UNCERTAIN";
      } else if (
        operation.state === "UNCERTAIN" ||
        operation.state === "NEEDS_HUMAN"
      ) {
        nextState = operation.state;
      } else {
        fail(
          "OPERATION_INVALID_TRANSITION",
          `operation in state ${operation.state} cannot accept cancellation`
        );
      }

      if (nextState !== operation.state) {
        assertLegalTransition(operation.state, nextState);
      }
      const terminalAt = nextState === "CANCELLED" ? now : null;
      const transitionReason =
        nextState === "CANCELLED"
          ? normalizedReason
          : nextState === operation.state
            ? `${normalizedReason}-recorded`
            : `${normalizedReason}-after-possible-dispatch`;

      const result = this.#database.prepare(`
        UPDATE operations
        SET state = ?,
            cancellation_requested_at = ?,
            updated_at = ?,
            terminal_at = ?,
            last_transition_reason = ?,
            revision = revision + 1
        WHERE operation_id = ?
          AND claim_epoch = ?
          AND state = ?
      `).run(
        nextState,
        now,
        now,
        terminalAt,
        transitionReason,
        operationId,
        expectedClaimEpoch,
        operation.state
      );
      if (result.changes !== 1) {
        fail(
          "OPERATION_CLAIM_STALE",
          "operation changed during cancellation request",
          true
        );
      }

      if (nextState === "CANCELLED" && operation.owner.kind === "MODULE") {
        this.#resolveModuleEvidence(
          operation.owner.moduleId,
          operation.operationId,
          now
        );
      }
      return this.#requireByOperationId(operationId);
    });
  }

  public recoverInterrupted(): readonly OperationRecord[] {
    return transaction(this.#database, () => {
      const rows = this.#database.prepare(
        selectOperationSql("state IN ('RUNNING','VERIFYING')")
      ).all() as unknown as OperationRow[];
      if (rows.length === 0) {
        return Object.freeze([]);
      }

      const now = this.#currentIso();
      const recovered: OperationRecord[] = [];
      for (const row of rows) {
        const operation = parseOperationRow(row);
        if (operation === null) {
          fail(
            "OPERATION_ROW_INVALID",
            "interrupted operation unexpectedly disappeared"
          );
        }
        const result = this.#database.prepare(`
          UPDATE operations
          SET state = 'UNCERTAIN',
              updated_at = ?,
              last_transition_reason = 'startup-recovery-after-possible-dispatch',
              revision = revision + 1
          WHERE operation_id = ?
            AND claim_epoch = ?
            AND state IN ('RUNNING','VERIFYING')
        `).run(now, operation.operationId, operation.claimEpoch);
        if (result.changes !== 1) {
          fail(
            "OPERATION_CLAIM_STALE",
            `operation ${operation.operationId} changed during startup recovery`,
            true
          );
        }
        recovered.push(this.#requireByOperationId(operation.operationId));
      }
      return Object.freeze(recovered);
    });
  }

  public beginVerification(
    operationId: string,
    expectedClaimEpoch: number,
    reason = "remote-effect-dispatched"
  ): OperationRecord {
    return this.#transition(
      operationId,
      expectedClaimEpoch,
      "VERIFYING",
      reason
    );
  }

  public markSucceeded(
    operationId: string,
    expectedClaimEpoch: number,
    reason = "remote-effect-verified"
  ): OperationRecord {
    return this.#transition(
      operationId,
      expectedClaimEpoch,
      "SUCCEEDED",
      reason
    );
  }

  public markFailedSafe(
    operationId: string,
    expectedClaimEpoch: number,
    reason: string
  ): OperationRecord {
    validateEvidenceId(operationId, "operationId");
    validatePositiveInteger(expectedClaimEpoch, "expectedClaimEpoch");
    const current = this.require(operationId);
    if (current.state !== "RUNNING" && current.state !== "VERIFYING") {
      fail(
        "OPERATION_INVALID_TRANSITION",
        `FAILED_SAFE requires RUNNING or VERIFYING state, found ${current.state}`
      );
    }
    return this.#transition(
      operationId,
      expectedClaimEpoch,
      "FAILED_SAFE",
      reason
    );
  }

  public markUncertain(
    operationId: string,
    expectedClaimEpoch: number,
    reason: string
  ): OperationRecord {
    validateEvidenceId(operationId, "operationId");
    validatePositiveInteger(expectedClaimEpoch, "expectedClaimEpoch");
    const current = this.require(operationId);
    if (current.state !== "RUNNING" && current.state !== "VERIFYING") {
      fail(
        "OPERATION_INVALID_TRANSITION",
        `UNCERTAIN requires RUNNING or VERIFYING state, found ${current.state}`
      );
    }
    return this.#transition(
      operationId,
      expectedClaimEpoch,
      "UNCERTAIN",
      reason
    );
  }

  public beginReconciliation(
    operationId: string,
    expectedClaimEpoch: number,
    reason = "reconciliation-started"
  ): OperationRecord {
    validateEvidenceId(operationId, "operationId");
    validatePositiveInteger(expectedClaimEpoch, "expectedClaimEpoch");
    const current = this.require(operationId);
    if (
      current.state !== "UNCERTAIN" &&
      current.state !== "NEEDS_HUMAN"
    ) {
      fail(
        "OPERATION_INVALID_TRANSITION",
        `reconciliation requires UNCERTAIN or NEEDS_HUMAN state, found ${current.state}`
      );
    }
    return this.#transition(
      operationId,
      expectedClaimEpoch,
      "VERIFYING",
      reason
    );
  }

  public markNeedsHuman(
    operationId: string,
    expectedClaimEpoch: number,
    reason: string
  ): OperationRecord {
    return this.#transition(
      operationId,
      expectedClaimEpoch,
      "NEEDS_HUMAN",
      reason
    );
  }

  #transition(
    operationId: string,
    expectedClaimEpoch: number,
    nextState: OperationState,
    reason: string
  ): OperationRecord {
    validateEvidenceId(operationId, "operationId");
    validatePositiveInteger(expectedClaimEpoch, "expectedClaimEpoch");
    const normalizedReason = validateReason(reason);

    return transaction(this.#database, () => {
      const operation = this.#requireCurrentClaim(
        operationId,
        expectedClaimEpoch
      );
      assertLegalTransition(operation.state, nextState);

      const now = this.#currentIso();
      const terminalAt = isTerminal(nextState) ? now : null;
      const result = this.#database.prepare(`
        UPDATE operations
        SET state = ?,
            updated_at = ?,
            terminal_at = ?,
            last_transition_reason = ?,
            revision = revision + 1
        WHERE operation_id = ?
          AND claim_epoch = ?
          AND state = ?
      `).run(
        nextState,
        now,
        terminalAt,
        normalizedReason,
        operationId,
        expectedClaimEpoch,
        operation.state
      );
      if (result.changes !== 1) {
        fail(
          "OPERATION_CLAIM_STALE",
          "operation changed during state transition",
          true
        );
      }

      if (isTerminal(nextState) && operation.owner.kind === "MODULE") {
        this.#resolveModuleEvidence(
          operation.owner.moduleId,
          operation.operationId,
          now
        );
      }
      return this.#requireByOperationId(operationId);
    });
  }

  #getByOperationId(operationId: string): OperationRecord | null {
    const row = this.#database.prepare(
      selectOperationSql("operation_id = ?")
    ).get(operationId) as unknown as OperationRow | undefined;
    return parseOperationRow(row);
  }

  #requireByOperationId(operationId: string): OperationRecord {
    const operation = this.#getByOperationId(operationId);
    if (operation === null) {
      fail(
        "OPERATION_NOT_FOUND",
        `operation ${operationId} does not exist`
      );
    }
    return operation;
  }

  #getByIdempotencyKey(idempotencyKey: string): OperationRecord | null {
    const row = this.#database.prepare(
      selectOperationSql("idempotency_key = ?")
    ).get(idempotencyKey) as unknown as OperationRow | undefined;
    return parseOperationRow(row);
  }

  #getUnresolvedClaimUnchecked(targetKey: string): OperationRecord | null {
    const row = this.#database.prepare(
      selectOperationSql(
        "target_key = ? AND state IN ('PREPARED','RUNNING','VERIFYING','UNCERTAIN','NEEDS_HUMAN')"
      )
    ).get(targetKey) as unknown as OperationRow | undefined;
    return parseOperationRow(row);
  }

  #requireCurrentClaim(
    operationId: string,
    expectedClaimEpoch: number
  ): OperationRecord {
    const operation = this.#requireByOperationId(operationId);
    if (
      operation.claimEpoch !== expectedClaimEpoch ||
      !isUnresolved(operation.state)
    ) {
      fail(
        "OPERATION_CLAIM_STALE",
        `operation ${operationId} no longer owns unresolved claim epoch ${expectedClaimEpoch}`,
        true
      );
    }

    const epochRow = this.#database.prepare(`
      SELECT last_epoch
      FROM operation_target_epochs
      WHERE target_key = ?
    `).get(operation.targetKey);
    const lastEpoch = epochRow?.["last_epoch"];
    if (
      typeof lastEpoch !== "number" ||
      !Number.isSafeInteger(lastEpoch) ||
      lastEpoch !== expectedClaimEpoch
    ) {
      fail(
        "OPERATION_CLAIM_STALE",
        `target ${operation.targetKey} fencing epoch has advanced`,
        true
      );
    }

    const currentClaim = this.#getUnresolvedClaimUnchecked(
      operation.targetKey
    );
    if (
      currentClaim === null ||
      currentClaim.operationId !== operation.operationId ||
      currentClaim.claimEpoch !== expectedClaimEpoch
    ) {
      fail(
        "OPERATION_CLAIM_STALE",
        `operation ${operationId} is not the current target claim owner`,
        true
      );
    }
    return operation;
  }

  #nextClaimEpoch(targetKey: string): number {
    const row = this.#database.prepare(`
      SELECT last_epoch
      FROM operation_target_epochs
      WHERE target_key = ?
    `).get(targetKey);
    if (row === undefined) {
      this.#database.prepare(`
        INSERT INTO operation_target_epochs (target_key, last_epoch)
        VALUES (?, 1)
      `).run(targetKey);
      return 1;
    }

    const current = row["last_epoch"];
    if (
      typeof current !== "number" ||
      !Number.isSafeInteger(current) ||
      current < 1
    ) {
      fail("OPERATION_ROW_INVALID", "stored target claim epoch is invalid");
    }
    if (current >= Number.MAX_SAFE_INTEGER) {
      fail(
        "OPERATION_EPOCH_EXHAUSTED",
        `target ${targetKey} claim epoch is exhausted`
      );
    }
    const next = current + 1;
    const updated = this.#database.prepare(`
      UPDATE operation_target_epochs
      SET last_epoch = ?
      WHERE target_key = ? AND last_epoch = ?
    `).run(next, targetKey, current);
    if (updated.changes !== 1) {
      fail(
        "OPERATION_CLAIM_STALE",
        `target ${targetKey} claim epoch changed concurrently`,
        true
      );
    }
    return next;
  }

  #assertModuleOwnerCurrent(
    owner: Extract<OperationOwner, { kind: "MODULE" }>
  ): void {
    const row = this.#database.prepare(`
      SELECT
        active_version,
        runtime_generation,
        runtime_enabled,
        lifecycle_status
      FROM module_registry
      WHERE module_id = ?
    `).get(owner.moduleId);
    if (
      row === undefined ||
      row["active_version"] !== owner.moduleVersion ||
      row["runtime_generation"] !== owner.runtimeGeneration ||
      row["runtime_enabled"] !== 1 ||
      row["lifecycle_status"] !== "ENABLED"
    ) {
      fail(
        "OPERATION_MODULE_OWNER_STALE",
        `module owner ${owner.moduleId}@${owner.moduleVersion} generation ${owner.runtimeGeneration} is not the current enabled runtime`
      );
    }
  }

  #recordModuleEvidence(
    moduleId: string,
    operationId: string,
    now: string
  ): void {
    this.#database.prepare(`
      INSERT INTO module_lifecycle_evidence (
        module_id,
        evidence_kind,
        evidence_id,
        unresolved,
        created_at,
        updated_at,
        resolved_at
      ) VALUES (?, 'OPERATION', ?, 1, ?, ?, NULL)
      ON CONFLICT(module_id, evidence_kind, evidence_id)
      DO UPDATE SET
        unresolved = 1,
        updated_at = excluded.updated_at,
        resolved_at = NULL
    `).run(moduleId, operationId, now, now);
  }

  #resolveModuleEvidence(
    moduleId: string,
    operationId: string,
    now: string
  ): void {
    const result = this.#database.prepare(`
      UPDATE module_lifecycle_evidence
      SET unresolved = 0,
          updated_at = ?,
          resolved_at = ?
      WHERE module_id = ?
        AND evidence_kind = 'OPERATION'
        AND evidence_id = ?
        AND unresolved = 1
    `).run(now, now, moduleId, operationId);
    if (result.changes !== 1) {
      fail(
        "OPERATION_ROW_INVALID",
        "module operation evidence is missing or already resolved"
      );
    }
  }

  #currentDate(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      fail("OPERATION_INVALID_INPUT", "coordinator clock returned an invalid time");
    }
    return value;
  }

  #currentIso(): string {
    return this.#currentDate().toISOString();
  }
}
