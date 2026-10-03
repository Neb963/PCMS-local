import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  AccountRepository,
  type AccountRecord
} from "../accounts/account-repository.js";
import {
  OperationCoordinator,
  accountOperationTargetKey,
  type OperationOwner,
  type OperationRecord
} from "../operations/operation-coordinator.js";
import { OperationReconciler } from "../operations/reconciliation.js";
import {
  decodeExplorerAvailabilityContract
} from "./observation.js";

const CLAIM_OPERATION_KIND = "explorer.claim";
const CLAIM_SCHEMA_VERSION = 1;
const PRECONDITION_MAX_AGE_MS = 60_000;
const SAFE_CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_SLUG_LENGTH = 512;
const MAX_PROVIDER_STABLE_ID_LENGTH = 256;

export type ExplorerClaimEffectState =
  | "NOT_DISPATCHED"
  | "MAY_HAVE_OCCURRED";

export class ExplorerClaimMutationError extends Error {
  public constructor(
    message: string,
    public readonly effectState: ExplorerClaimEffectState,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ExplorerClaimMutationError";
  }
}

export interface ExplorerOwnershipEvidence {
  readonly compatibility: "VERIFIED" | "UNKNOWN";
  readonly owned: boolean | null;
  readonly providerStableId: string | null;
  readonly slug: string | null;
  readonly observedAt: string;
}

export interface ExplorerClaimRemote {
  readAvailability(slug: string): Promise<unknown>;
  claim(slug: string): Promise<void>;
  observeOwnership(slug: string): Promise<ExplorerOwnershipEvidence>;
}

export interface ExplorerClaimInput {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly candidateId: string;
  readonly slug: string;
  readonly accountId: string;
  readonly personaUid: string;
  readonly owner: OperationOwner;
  readonly actorSource: string;
  readonly remote: ExplorerClaimRemote;
}

export interface ExplorerReservationRecord {
  readonly operationId: string;
  readonly claimEpoch: number;
  readonly candidateId: string;
  readonly slug: string;
  readonly accountId: string;
  readonly personaUid: string;
  readonly providerStableId: string;
  readonly ownership: "VERIFIED";
  readonly verifiedAt: string;
}

export type ExplorerClaimDisposition =
  | "APPLIED"
  | "RECONCILED_APPLIED"
  | "ALREADY_VERIFIED";

export interface ExplorerClaimResult {
  readonly disposition: ExplorerClaimDisposition;
  readonly operation: OperationRecord;
  readonly reservation: ExplorerReservationRecord;
}

export class ExplorerClaimError extends Error {
  public constructor(
    public readonly code:
      | "EXPLORER_CLAIM_INVALID_INPUT"
      | "EXPLORER_CLAIM_ACCOUNT_UNAVAILABLE"
      | "EXPLORER_CLAIM_NOT_AVAILABLE"
      | "EXPLORER_CLAIM_OPERATION_CONFLICT"
      | "EXPLORER_CLAIM_MUTATION_FAILED"
      | "EXPLORER_CLAIM_VERIFICATION_FAILED"
      | "EXPLORER_CLAIM_UNRESOLVED",
    message: string,
    public readonly operationId: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ExplorerClaimError";
  }
}

function normalizeCandidateId(
  candidateId: string,
  operationId: string
): string {
  if (!SAFE_CANDIDATE_ID.test(candidateId)) {
    throw new ExplorerClaimError(
      "EXPLORER_CLAIM_INVALID_INPUT",
      "Explorer candidateId has invalid syntax",
      operationId
    );
  }
  return candidateId;
}

function normalizeSlug(slug: string, operationId: string): string {
  const normalized = slug.trim();
  if (
    normalized.length < 1 ||
    normalized.length > MAX_SLUG_LENGTH
  ) {
    throw new ExplorerClaimError(
      "EXPLORER_CLAIM_INVALID_INPUT",
      `Explorer slug must contain 1-${MAX_SLUG_LENGTH} characters`,
      operationId
    );
  }
  return normalized;
}

function normalizeOwnership(
  value: ExplorerOwnershipEvidence
): ExplorerOwnershipEvidence {
  const parsedTime = Date.parse(value.observedAt);
  if (!Number.isFinite(parsedTime)) {
    return Object.freeze({
      compatibility: "UNKNOWN",
      owned: null,
      providerStableId: null,
      slug: null,
      observedAt: new Date(0).toISOString()
    });
  }
  const observedAt = new Date(parsedTime).toISOString();

  if (value.compatibility !== "VERIFIED") {
    return Object.freeze({
      compatibility: "UNKNOWN",
      owned: null,
      providerStableId: null,
      slug: null,
      observedAt
    });
  }
  if (value.owned === false) {
    return Object.freeze({
      compatibility: "VERIFIED",
      owned: false,
      providerStableId: null,
      slug: value.slug,
      observedAt
    });
  }
  if (
    value.owned !== true ||
    typeof value.providerStableId !== "string" ||
    value.providerStableId.length < 1 ||
    value.providerStableId.length > MAX_PROVIDER_STABLE_ID_LENGTH ||
    typeof value.slug !== "string" ||
    value.slug.length < 1 ||
    value.slug.length > MAX_SLUG_LENGTH
  ) {
    return Object.freeze({
      compatibility: "UNKNOWN",
      owned: null,
      providerStableId: null,
      slug: null,
      observedAt
    });
  }
  return Object.freeze({
    compatibility: "VERIFIED",
    owned: true,
    providerStableId: value.providerStableId,
    slug: value.slug,
    observedAt
  });
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

function desiredFingerprint(
  candidateId: string,
  slug: string,
  accountId: string
): string {
  return createHash("sha256")
    .update(JSON.stringify({ candidateId, slug, accountId }))
    .digest("hex");
}

function sameIntent(
  operation: OperationRecord,
  input: ExplorerClaimInput,
  candidateId: string,
  slug: string
): boolean {
  return (
    operation.idempotencyKey === input.idempotencyKey &&
    operation.targetKey === accountOperationTargetKey(input.accountId) &&
    operation.operationKind === CLAIM_OPERATION_KIND &&
    operation.schemaVersion === CLAIM_SCHEMA_VERSION &&
    sameOwner(operation.owner, input.owner) &&
    operation.actorSource === input.actorSource &&
    operation.personaUid === input.personaUid &&
    operation.accountId === input.accountId &&
    operation.desiredFingerprint ===
      desiredFingerprint(candidateId, slug, input.accountId) &&
    operation.provenance["source"] === "explorer" &&
    operation.provenance["candidateId"] === candidateId &&
    operation.provenance["slug"] === slug
  );
}

function exactOwnership(
  evidence: ExplorerOwnershipEvidence,
  slug: string
): evidence is ExplorerOwnershipEvidence & Readonly<{
  compatibility: "VERIFIED";
  owned: true;
  providerStableId: string;
  slug: string;
}> {
  return (
    evidence.compatibility === "VERIFIED" &&
    evidence.owned === true &&
    evidence.slug === slug &&
    typeof evidence.providerStableId === "string"
  );
}

export class ExplorerReservationLedger {
  readonly #byOperation = new Map<
    string,
    ExplorerReservationRecord
  >();

  public reserve(
    record: ExplorerReservationRecord
  ): ExplorerReservationRecord {
    const existing = this.#byOperation.get(record.operationId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error(
          "Explorer operation is already reserved with different ownership evidence"
        );
      }
      return existing;
    }
    const stored = Object.freeze({ ...record });
    this.#byOperation.set(record.operationId, stored);
    return stored;
  }

  public findByOperationId(
    operationId: string
  ): ExplorerReservationRecord | null {
    return this.#byOperation.get(operationId) ?? null;
  }

  public list(): readonly ExplorerReservationRecord[] {
    return Object.freeze(
      [...this.#byOperation.values()].sort((left, right) =>
        left.operationId.localeCompare(right.operationId, "en")
      )
    );
  }
}

export class ExplorerClaimService {
  readonly #accounts: AccountRepository;
  readonly #coordinator: OperationCoordinator;
  readonly #reconciler: OperationReconciler;
  readonly #reservations: ExplorerReservationLedger;
  readonly #now: () => Date;

  public constructor(options: Readonly<{
    database: DatabaseSync;
    coordinator?: OperationCoordinator;
    reservations: ExplorerReservationLedger;
    now?: () => Date;
  }>) {
    this.#accounts = new AccountRepository({
      database: options.database,
      ...(options.now === undefined ? {} : { now: options.now })
    });
    this.#coordinator =
      options.coordinator ??
      new OperationCoordinator({
        database: options.database,
        ...(options.now === undefined ? {} : { now: options.now })
      });
    this.#reconciler = new OperationReconciler(this.#coordinator);
    this.#reservations = options.reservations;
    this.#now = options.now ?? (() => new Date());
  }

  #requireAccount(input: ExplorerClaimInput): AccountRecord {
    const account = this.#accounts.require(input.accountId);
    if (
      account.lifecycleStatus !== "ACTIVE" ||
      account.personaUid !== input.personaUid
    ) {
      throw new ExplorerClaimError(
        "EXPLORER_CLAIM_ACCOUNT_UNAVAILABLE",
        "Explorer claim requires the selected ACTIVE Account and its current Persona binding",
        input.operationId
      );
    }
    return account;
  }

  async #readOwnership(
    input: ExplorerClaimInput,
    slug: string
  ): Promise<ExplorerOwnershipEvidence> {
    try {
      return normalizeOwnership(
        await input.remote.observeOwnership(slug)
      );
    } catch {
      return Object.freeze({
        compatibility: "UNKNOWN",
        owned: null,
        providerStableId: null,
        slug: null,
        observedAt: this.#now().toISOString()
      });
    }
  }

  #reservation(
    input: ExplorerClaimInput,
    operation: OperationRecord,
    candidateId: string,
    slug: string,
    ownership: ExplorerOwnershipEvidence & Readonly<{
      compatibility: "VERIFIED";
      owned: true;
      providerStableId: string;
      slug: string;
    }>
  ): ExplorerReservationRecord {
    return this.#reservations.reserve(Object.freeze({
      operationId: operation.operationId,
      claimEpoch: operation.claimEpoch,
      candidateId,
      slug,
      accountId: input.accountId,
      personaUid: input.personaUid,
      providerStableId: ownership.providerStableId,
      ownership: "VERIFIED",
      verifiedAt: ownership.observedAt
    }));
  }

  async #reconcile(
    input: ExplorerClaimInput,
    operation: OperationRecord,
    candidateId: string,
    slug: string
  ): Promise<ExplorerClaimResult> {
    let ownership: ExplorerOwnershipEvidence | null = null;
    const reconciled = await this.#reconciler.reconcile({
      operationId: operation.operationId,
      expectedClaimEpoch: operation.claimEpoch,
      read: async () => {
        ownership = await this.#readOwnership(input, slug);
        if (exactOwnership(ownership, slug)) {
          return {
            kind: "CONFIRMED_APPLIED" as const,
            reason: "explorer-claim-ownership-verified"
          };
        }
        return {
          kind: "UNKNOWN" as const,
          reason: "explorer-claim-ownership-unresolved"
        };
      }
    });

    if (
      reconciled.operation.state === "SUCCEEDED" &&
      ownership !== null &&
      exactOwnership(ownership, slug)
    ) {
      return Object.freeze({
        disposition: "RECONCILED_APPLIED",
        operation: reconciled.operation,
        reservation: this.#reservation(
          input,
          reconciled.operation,
          candidateId,
          slug,
          ownership
        )
      });
    }

    throw new ExplorerClaimError(
      "EXPLORER_CLAIM_UNRESOLVED",
      "Explorer claim remains uncertain after read-first ownership reconciliation; automatic redispatch is blocked",
      reconciled.operation.operationId
    );
  }

  public async claim(
    input: ExplorerClaimInput
  ): Promise<ExplorerClaimResult> {
    const candidateId = normalizeCandidateId(
      input.candidateId,
      input.operationId
    );
    const slug = normalizeSlug(input.slug, input.operationId);
    const account = this.#requireAccount(input);

    const byOperationId = this.#coordinator.get(input.operationId);
    const byIdempotency = this.#coordinator.getByIdempotencyKey(
      input.idempotencyKey
    );
    if (
      byOperationId !== null &&
      byIdempotency !== null &&
      byOperationId.operationId !== byIdempotency.operationId
    ) {
      throw new ExplorerClaimError(
        "EXPLORER_CLAIM_OPERATION_CONFLICT",
        "operationId and idempotencyKey refer to different Explorer claims",
        input.operationId
      );
    }

    const existing = byOperationId ?? byIdempotency;
    if (existing !== null) {
      if (!sameIntent(existing, input, candidateId, slug)) {
        throw new ExplorerClaimError(
          "EXPLORER_CLAIM_OPERATION_CONFLICT",
          "existing Explorer claim identity is bound to different intent",
          existing.operationId
        );
      }
      if (
        existing.state === "UNCERTAIN" ||
        existing.state === "NEEDS_HUMAN"
      ) {
        const gate = this.#coordinator.providerGate.acquire({
          provider: "perchance",
          accountId: input.accountId,
          personaUid: input.personaUid
        });
        try {
          return await this.#reconcile(
            input,
            existing,
            candidateId,
            slug
          );
        } finally {
          gate.release();
        }
      }
      if (existing.state === "SUCCEEDED") {
        const reservation =
          this.#reservations.findByOperationId(existing.operationId);
        if (reservation === null) {
          throw new ExplorerClaimError(
            "EXPLORER_CLAIM_UNRESOLVED",
            "completed Explorer claim has no verified reservation evidence",
            existing.operationId
          );
        }
        const ownership = await this.#readOwnership(input, slug);
        if (
          !exactOwnership(ownership, slug) ||
          ownership.providerStableId !== reservation.providerStableId
        ) {
          throw new ExplorerClaimError(
            "EXPLORER_CLAIM_VERIFICATION_FAILED",
            "completed Explorer claim ownership no longer matches its verified reservation",
            existing.operationId
          );
        }
        return Object.freeze({
          disposition: "ALREADY_VERIFIED",
          operation: existing,
          reservation
        });
      }
      throw new ExplorerClaimError(
        "EXPLORER_CLAIM_UNRESOLVED",
        `existing Explorer claim is ${existing.state} and cannot be redispatched`,
        existing.operationId
      );
    }

    const observedAt = this.#now().toISOString();
    let availability;
    try {
      availability = decodeExplorerAvailabilityContract(
        await input.remote.readAvailability(slug),
        observedAt
      );
    } catch {
      availability = decodeExplorerAvailabilityContract(
        null,
        observedAt
      );
    }
    if (
      availability.compatibility !== "VERIFIED" ||
      availability.slug !== slug ||
      availability.available !== true
    ) {
      throw new ExplorerClaimError(
        "EXPLORER_CLAIM_NOT_AVAILABLE",
        "Explorer candidate is not freshly verified available",
        input.operationId
      );
    }

    const operation = this.#coordinator.prepare({
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      owner: input.owner,
      actorSource: input.actorSource,
      targetKey: accountOperationTargetKey(input.accountId),
      operationKind: CLAIM_OPERATION_KIND,
      schemaVersion: CLAIM_SCHEMA_VERSION,
      personaUid: input.personaUid,
      accountId: input.accountId,
      desiredFingerprint: desiredFingerprint(
        candidateId,
        slug,
        input.accountId
      ),
      provenance: {
        source: "explorer",
        candidateId,
        slug
      },
      preconditions: [
        {
          key: "accountBinding",
          observedAt: availability.observedAt,
          maxAgeMs: PRECONDITION_MAX_AGE_MS,
          evidenceRef:
            `account:${account.accountId}:rev:${account.revision}`
        },
        {
          key: "explorerAvailability",
          observedAt: availability.observedAt,
          maxAgeMs: PRECONDITION_MAX_AGE_MS,
          evidenceRef: `candidate:${candidateId}:available`
        }
      ]
    });

    const gate = this.#coordinator.providerGate.acquire({
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
          candidateId,
          slug
        }
      });

      try {
        await input.remote.claim(slug);
      } catch (error: unknown) {
        const effectState =
          error instanceof ExplorerClaimMutationError
            ? error.effectState
            : "MAY_HAVE_OCCURRED";
        const lost = this.#coordinator.recordExecutionLoss({
          operationId: operation.operationId,
          expectedClaimEpoch: operation.claimEpoch,
          source: "NETWORK",
          effectState
        });
        if (effectState === "MAY_HAVE_OCCURRED") {
          return await this.#reconcile(
            input,
            lost,
            candidateId,
            slug
          );
        }
        throw new ExplorerClaimError(
          "EXPLORER_CLAIM_MUTATION_FAILED",
          "Explorer claim was rejected before a remote effect",
          operation.operationId,
          error instanceof Error ? { cause: error } : undefined
        );
      }

      this.#coordinator.beginVerification(
        operation.operationId,
        operation.claimEpoch,
        "explorer-claim-acknowledged"
      );
      const ownership = await this.#readOwnership(input, slug);
      if (!exactOwnership(ownership, slug)) {
        this.#coordinator.markUncertain(
          operation.operationId,
          operation.claimEpoch,
          "explorer-claim-ownership-unverified"
        );
        throw new ExplorerClaimError(
          "EXPLORER_CLAIM_VERIFICATION_FAILED",
          "Explorer claim acknowledgement did not prove ownership",
          operation.operationId
        );
      }

      const succeeded = this.#coordinator.markSucceeded(
        operation.operationId,
        operation.claimEpoch,
        "explorer-claim-ownership-verified"
      );
      return Object.freeze({
        disposition: "APPLIED",
        operation: succeeded,
        reservation: this.#reservation(
          input,
          succeeded,
          candidateId,
          slug,
          ownership
        )
      });
    } finally {
      gate.release();
    }
  }
}
