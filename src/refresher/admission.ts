import {
  generatorOperationTargetKey,
  OperationCoordinator,
  type OperationOwner,
  type OperationPrecondition,
  type OperationRecord,
  type SafeOperationMetadata
} from "../operations/operation-coordinator.js";
import type {
  ProviderGateCooldown,
  ProviderGatePermit,
  ProviderGateScope
} from "../operations/provider-gate.js";
import type {
  PerchanceGateSignalEvidence
} from "../providers/perchance-gate-signal.js";

const REFRESH_OPERATION_KIND = "refresher.refresh";
const REFRESH_OPERATION_SCHEMA_VERSION = 1;

export interface PrepareRefresherMutationInput {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly generatorLocalId: string;
  readonly owner: OperationOwner;
  readonly actorSource: string;
  readonly personaUid?: string | null;
  readonly accountId?: string | null;
  readonly desiredFingerprint: string;
  readonly provenance: SafeOperationMetadata;
  readonly preconditions: readonly OperationPrecondition[];
}

export interface RecordRefresherProviderSignalInput {
  readonly scope: ProviderGateScope;
  readonly evidence: PerchanceGateSignalEvidence;
}

export type RecordRefresherProviderSignalResult =
  | Readonly<{
      status: "RECORDED";
      cooldown: ProviderGateCooldown;
    }>
  | Readonly<{
      status: "NO_SIGNAL";
      compatibility: "VERIFIED" | "UNKNOWN";
    }>;

export class RefresherAdmission {
  readonly #coordinator: OperationCoordinator;

  public constructor(coordinator: OperationCoordinator) {
    this.#coordinator = coordinator;
  }

  public prepareMutation(
    input: PrepareRefresherMutationInput
  ): OperationRecord {
    return this.#coordinator.prepare({
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      owner: input.owner,
      actorSource: input.actorSource,
      targetKey: generatorOperationTargetKey(
        input.generatorLocalId
      ),
      operationKind: REFRESH_OPERATION_KIND,
      schemaVersion: REFRESH_OPERATION_SCHEMA_VERSION,
      ...(input.personaUid === undefined
        ? {}
        : { personaUid: input.personaUid }),
      ...(input.accountId === undefined
        ? {}
        : { accountId: input.accountId }),
      desiredFingerprint: input.desiredFingerprint,
      provenance: input.provenance,
      preconditions: input.preconditions
    });
  }

  public acquireProviderPermit(
    scope: ProviderGateScope
  ): ProviderGatePermit {
    return this.#coordinator.providerGate.acquire(scope);
  }

  public recordProviderSignal(
    input: RecordRefresherProviderSignalInput
  ): RecordRefresherProviderSignalResult {
    const signal = input.evidence.signal;
    if (
      input.evidence.compatibility !== "VERIFIED" ||
      signal === null
    ) {
      return Object.freeze({
        status: "NO_SIGNAL",
        compatibility: input.evidence.compatibility
      });
    }
    const cooldown = this.#coordinator.providerGate.observeSignal({
      provider: input.scope.provider,
      accountId: input.scope.accountId,
      personaUid: input.scope.personaUid,
      kind: signal.kind,
      cooldownMs: signal.cooldownMs,
      reason: signal.reason,
      scopeKind: signal.scopeKind
    });
    return Object.freeze({
      status: "RECORDED",
      cooldown
    });
  }
}
