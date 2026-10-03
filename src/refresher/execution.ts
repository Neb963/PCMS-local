import { createHash } from "node:crypto";

import {
  generatorOperationTargetKey,
  OperationCoordinator,
  type OperationOwner,
  type OperationPrecondition,
  type OperationRecord
} from "../operations/operation-coordinator.js";
import {
  PerchanceMutationError
} from "../providers/perchance-provider.js";
import type {
  PerchancePublicListingObservation,
  PerchanceRecentObservation,
  PerchanceRefreshEffectObservation
} from "../providers/perchance-refresh-contract.js";
import { RefresherAdmission } from "./admission.js";

const REFRESH_OPERATION_KIND = "refresher.refresh";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MAX_HISTORY_PER_GENERATOR = 64;

export type RefresherExecutionMode =
  | "MANUAL"
  | "SCHEDULED"
  | "RECENT_VISIBILITY";

export interface RefresherRemoteAdapter {
  readonly saveRefresh: (
    input: Readonly<{
      providerStableId: string;
      currentSlug: string;
      refreshToken: string;
    }>
  ) => void | Promise<void>;
  readonly observePublicListing: () =>
    | PerchancePublicListingObservation
    | Promise<PerchancePublicListingObservation>;
  readonly observeRefreshEffect: (
    providerStableId: string
  ) =>
    | PerchanceRefreshEffectObservation
    | Promise<PerchanceRefreshEffectObservation>;
  readonly observeRecent: () =>
    | PerchanceRecentObservation
    | Promise<PerchanceRecentObservation>;
}

export interface RefresherExecutionInput {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly generatorLocalId: string;
  readonly providerStableId: string;
  readonly currentSlug: string;
  readonly refreshToken: string;
  readonly mode: RefresherExecutionMode;
  readonly owner: OperationOwner;
  readonly actorSource: string;
  readonly personaUid: string;
  readonly accountId: string;
  readonly preconditions: readonly OperationPrecondition[];
  readonly remote: RefresherRemoteAdapter;
}

export interface RefresherHistoryRecord {
  readonly operationId: string;
  readonly claimEpoch: number;
  readonly generatorLocalId: string;
  readonly providerStableId: string;
  readonly slug: string;
  readonly mode: RefresherExecutionMode;
  readonly refreshToken: string;
  readonly refreshSequence: number;
  readonly effectState: "PENDING" | "VISIBLE";
  readonly recentRank: number | null;
  readonly publicStateVerified: true;
  readonly verifiedAt: string;
}

export interface RefresherHistorySnapshot {
  readonly version: 1;
  readonly generators: Readonly<
    Record<string, readonly RefresherHistoryRecord[]>
  >;
}

export type RefresherExecutionDisposition =
  | "APPLIED"
  | "ALREADY_VERIFIED";

export interface RefresherExecutionResult {
  readonly disposition: RefresherExecutionDisposition;
  readonly operation: OperationRecord;
  readonly history: RefresherHistoryRecord;
}

export class RefresherExecutionError extends Error {
  public constructor(
    public readonly code:
      | "REFRESHER_EXECUTION_INVALID_INPUT"
      | "REFRESHER_EXECUTION_OPERATION_CONFLICT"
      | "REFRESHER_EXECUTION_UNRESOLVED"
      | "REFRESHER_EXECUTION_MUTATION_FAILED"
      | "REFRESHER_EXECUTION_VERIFICATION_FAILED",
    message: string,
    public readonly operationId: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RefresherExecutionError";
  }
}

function failInput(message: string, operationId: string): never {
  throw new RefresherExecutionError(
    "REFRESHER_EXECUTION_INVALID_INPUT",
    message,
    operationId
  );
}

function boundedText(
  value: string,
  maximum: number,
  label: string,
  operationId: string
): void {
  if (value.length < 1 || value.length > maximum) {
    failInput(
      label + " must contain 1-" + maximum + " characters",
      operationId
    );
  }
}

function normalizeInput(input: RefresherExecutionInput): void {
  boundedText(input.operationId, 128, "operationId", input.operationId);
  boundedText(input.idempotencyKey, 128, "idempotencyKey", input.operationId);
  boundedText(
    input.generatorLocalId,
    128,
    "generatorLocalId",
    input.operationId
  );
  boundedText(
    input.providerStableId,
    256,
    "providerStableId",
    input.operationId
  );
  boundedText(input.currentSlug, 512, "currentSlug", input.operationId);
  boundedText(input.personaUid, 128, "personaUid", input.operationId);
  boundedText(input.accountId, 128, "accountId", input.operationId);
  if (!SAFE_ID.test(input.refreshToken)) {
    failInput("refreshToken has invalid syntax", input.operationId);
  }
  if (
    input.mode !== "MANUAL" &&
    input.mode !== "SCHEDULED" &&
    input.mode !== "RECENT_VISIBILITY"
  ) {
    failInput("mode is invalid", input.operationId);
  }
}

function desiredFingerprint(
  input: RefresherExecutionInput
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      generatorLocalId: input.generatorLocalId,
      providerStableId: input.providerStableId,
      currentSlug: input.currentSlug,
      refreshToken: input.refreshToken,
      mode: input.mode
    }))
    .digest("hex");
}

function sameOwner(
  left: OperationOwner,
  right: OperationOwner
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "CORE" && right.kind === "CORE") return true;
  return (
    left.kind === "MODULE" &&
    right.kind === "MODULE" &&
    left.moduleId === right.moduleId &&
    left.moduleVersion === right.moduleVersion &&
    left.runtimeGeneration === right.runtimeGeneration
  );
}

function sameIntent(
  operation: OperationRecord,
  input: RefresherExecutionInput
): boolean {
  return (
    operation.idempotencyKey === input.idempotencyKey &&
    operation.targetKey ===
      generatorOperationTargetKey(input.generatorLocalId) &&
    operation.operationKind === REFRESH_OPERATION_KIND &&
    operation.schemaVersion === 1 &&
    sameOwner(operation.owner, input.owner) &&
    operation.actorSource === input.actorSource &&
    operation.personaUid === input.personaUid &&
    operation.accountId === input.accountId &&
    operation.desiredFingerprint === desiredFingerprint(input) &&
    operation.provenance["mode"] === input.mode &&
    operation.provenance["providerStableId"] ===
      input.providerStableId &&
    operation.provenance["markerStrategyId"] ===
      "PCMS_MARKER_BOTH_V1"
  );
}

function positivePublicListing(
  observation: PerchancePublicListingObservation,
  input: RefresherExecutionInput
): boolean {
  return (
    observation.compatibility === "VERIFIED" &&
    observation.items.some((item) =>
      item.publicId === input.providerStableId &&
      item.slug === input.currentSlug
    )
  );
}

interface VerifiedRemoteState {
  readonly effect: PerchanceRefreshEffectObservation;
  readonly recent: PerchanceRecentObservation | null;
}

async function verifyRemoteState(
  input: RefresherExecutionInput
): Promise<VerifiedRemoteState | null> {
  const [listing, effect] = await Promise.all([
    input.remote.observePublicListing(),
    input.remote.observeRefreshEffect(input.providerStableId)
  ]);
  if (
    !positivePublicListing(listing, input) ||
    effect.compatibility !== "VERIFIED" ||
    effect.publicId !== input.providerStableId ||
    effect.markerStrategyId !== "PCMS_MARKER_BOTH_V1" ||
    effect.refreshToken !== input.refreshToken ||
    (
      effect.state !== "PENDING" &&
      effect.state !== "VISIBLE"
    ) ||
    effect.refreshSequence === null
  ) {
    return null;
  }

  if (input.mode !== "RECENT_VISIBILITY") {
    return Object.freeze({ effect, recent: null });
  }
  if (effect.state !== "VISIBLE") {
    return null;
  }

  const recent = await input.remote.observeRecent();
  if (
    recent.compatibility !== "VERIFIED" ||
    !recent.items.some((item) =>
      item.publicId === input.providerStableId
    )
  ) {
    return null;
  }
  return Object.freeze({ effect, recent });
}

function historyRecord(
  input: RefresherExecutionInput,
  operation: OperationRecord,
  verified: VerifiedRemoteState
): RefresherHistoryRecord {
  const effect = verified.effect;
  if (
    effect.refreshToken === null ||
    effect.refreshSequence === null ||
    (
      effect.state !== "PENDING" &&
      effect.state !== "VISIBLE"
    )
  ) {
    throw new Error("verified refresh effect is incomplete");
  }
  const recentRank =
    verified.recent === null
      ? effect.recentRank
      : verified.recent.items.findIndex((item) =>
          item.publicId === input.providerStableId
        );

  return Object.freeze({
    operationId: operation.operationId,
    claimEpoch: operation.claimEpoch,
    generatorLocalId: input.generatorLocalId,
    providerStableId: input.providerStableId,
    slug: input.currentSlug,
    mode: input.mode,
    refreshToken: effect.refreshToken,
    refreshSequence: effect.refreshSequence,
    effectState: effect.state,
    recentRank:\n      recentRank === null || recentRank < 0\n        ? null\n        : recentRank,
    publicStateVerified: true,
    verifiedAt: effect.observedAt
  });
}

export class RefresherHistoryLedger {
  readonly #records = new Map<
    string,
    RefresherHistoryRecord[]
  >();

  public append(
    record: RefresherHistoryRecord
  ): RefresherHistoryRecord {
    const current = this.#records.get(record.generatorLocalId) ?? [];
    const duplicate = current.find((candidate) =>
      candidate.operationId === record.operationId
    );
    if (duplicate !== undefined) {
      if (JSON.stringify(duplicate) !== JSON.stringify(record)) {
        throw new Error(
          "refresh history operation identity is bound to different evidence"
        );
      }
      return duplicate;
    }
    const next = [...current, Object.freeze({ ...record })];
    if (next.length > MAX_HISTORY_PER_GENERATOR) {
      next.splice(0, next.length - MAX_HISTORY_PER_GENERATOR);
    }
    this.#records.set(record.generatorLocalId, next);
    return next[next.length - 1] as RefresherHistoryRecord;
  }

  public list(
    generatorLocalId: string
  ): readonly RefresherHistoryRecord[] {
    return Object.freeze([
      ...(this.#records.get(generatorLocalId) ?? [])
    ]);
  }

  public findByOperationId(
    operationId: string
  ): RefresherHistoryRecord | null {
    for (const records of this.#records.values()) {
      const found = records.find((record) =>
        record.operationId === operationId
      );
      if (found !== undefined) return found;
    }
    return null;
  }

  public snapshot(): RefresherHistorySnapshot {
    const generators: Record<
      string,
      readonly RefresherHistoryRecord[]
    > = {};
    for (
      const [generatorLocalId, records]
      of [...this.#records.entries()].sort(([left], [right]) =>
        left.localeCompare(right, "en")
      )
    ) {
      generators[generatorLocalId] = Object.freeze(
        records.map((record) => Object.freeze({ ...record }))
      );
    }
    return Object.freeze({
      version: 1,
      generators: Object.freeze(generators)
    });
  }
}

export class RefresherExecutionService {
  readonly #coordinator: OperationCoordinator;
  readonly #admission: RefresherAdmission;
  readonly #history: RefresherHistoryLedger;

  public constructor(options: Readonly<{
    coordinator: OperationCoordinator;
    history: RefresherHistoryLedger;
  }>) {
    this.#coordinator = options.coordinator;
    this.#admission = new RefresherAdmission(options.coordinator);
    this.#history = options.history;
  }

  public async execute(
    input: RefresherExecutionInput
  ): Promise<RefresherExecutionResult> {
    normalizeInput(input);

    const byOperationId =
      this.#coordinator.get(input.operationId);
    const byIdempotency =
      this.#coordinator.getByIdempotencyKey(input.idempotencyKey);
    if (
      byOperationId !== null &&
      byIdempotency !== null &&
      byOperationId.operationId !== byIdempotency.operationId
    ) {
      throw new RefresherExecutionError(
        "REFRESHER_EXECUTION_OPERATION_CONFLICT",
        "operationId and idempotencyKey refer to different refresh operations",
        input.operationId
      );
    }

    const existing = byOperationId ?? byIdempotency;
    if (existing !== null) {
      if (!sameIntent(existing, input)) {
        throw new RefresherExecutionError(
          "REFRESHER_EXECUTION_OPERATION_CONFLICT",
          "existing refresh operation identity is bound to different intent",
          existing.operationId
        );
      }
      if (existing.state === "SUCCEEDED") {
        const existingHistory =
          this.#history.findByOperationId(existing.operationId);
        if (existingHistory === null) {
          throw new RefresherExecutionError(
            "REFRESHER_EXECUTION_UNRESOLVED",
            "completed refresh operation has no verified module history",
            existing.operationId
          );
        }
        return Object.freeze({
          disposition: "ALREADY_VERIFIED",
          operation: existing,
          history: existingHistory
        });
      }
      throw new RefresherExecutionError(
        "REFRESHER_EXECUTION_UNRESOLVED",
        "existing refresh operation is unresolved and cannot be redispatched",
        existing.operationId
      );
    }

    const operation = this.#admission.prepareMutation({
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      generatorLocalId: input.generatorLocalId,
      owner: input.owner,
      actorSource: input.actorSource,
      personaUid: input.personaUid,
      accountId: input.accountId,
      desiredFingerprint: desiredFingerprint(input),
      provenance: {
        source: "refresher",
        mode: input.mode,
        providerStableId: input.providerStableId,
        markerStrategyId: "PCMS_MARKER_BOTH_V1"
      },
      preconditions: input.preconditions
    });

    const permit = this.#admission.acquireProviderPermit({
      provider: "perchance",
      accountId: input.accountId,
      personaUid: input.personaUid
    });
    try {
      this.#coordinator.authorizeDispatch({
        operationId: operation.operationId,
        expectedClaimEpoch: operation.claimEpoch,
        evidence: {
          provider: "perchance",
          generatorLocalId: input.generatorLocalId,
          providerStableId: input.providerStableId,
          mode: input.mode
        }
      });

      try {
        await input.remote.saveRefresh({
          providerStableId: input.providerStableId,
          currentSlug: input.currentSlug,
          refreshToken: input.refreshToken
        });
      } catch (error: unknown) {
        const effectState =
          error instanceof PerchanceMutationError
            ? error.effectState
            : "MAY_HAVE_OCCURRED";
        this.#coordinator.recordExecutionLoss({
          operationId: operation.operationId,
          expectedClaimEpoch: operation.claimEpoch,
          source: "NETWORK",
          effectState
        });
        throw new RefresherExecutionError(
          "REFRESHER_EXECUTION_MUTATION_FAILED",
          effectState === "MAY_HAVE_OCCURRED"
            ? "refresh outcome is uncertain after mutation execution loss"
            : "refresh mutation was rejected before a remote effect",
          operation.operationId,
          error instanceof Error ? { cause: error } : undefined
        );
      }

      this.#coordinator.beginVerification(
        operation.operationId,
        operation.claimEpoch,
        "refresh-save-acknowledged"
      );

      let verified: VerifiedRemoteState | null;
      try {
        verified = await verifyRemoteState(input);
      } catch (error: unknown) {
        this.#coordinator.markUncertain(
          operation.operationId,
          operation.claimEpoch,
          "refresh-verification-read-failed"
        );
        throw new RefresherExecutionError(
          "REFRESHER_EXECUTION_VERIFICATION_FAILED",
          "refresh provider state could not be verified after mutation",
          operation.operationId,
          error instanceof Error ? { cause: error } : undefined
        );
      }

      if (verified === null) {
        this.#coordinator.markUncertain(
          operation.operationId,
          operation.claimEpoch,
          "refresh-verification-mismatch"
        );
        throw new RefresherExecutionError(
          "REFRESHER_EXECUTION_VERIFICATION_FAILED",
          "refresh provider state does not match the intended effect",
          operation.operationId
        );
      }

      const succeeded = this.#coordinator.markSucceeded(
        operation.operationId,
        operation.claimEpoch,
        "refresh-effect-and-public-state-verified"
      );
      const history = this.#history.append(
        historyRecord(input, succeeded, verified)
      );
      return Object.freeze({
        disposition: "APPLIED",
        operation: succeeded,
        history
      });
    } finally {
      permit.release();
    }
  }
}
