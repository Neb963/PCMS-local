import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  BrowserDriverCommandOptions,
  BrowserPage
} from "../browser/browser-driver.js";
import {
  generatorOperationTargetKey,
  OperationCoordinator,
  type OperationOwner,
  type OperationRecord
} from "../operations/operation-coordinator.js";
import { OperationReconciler } from "../operations/reconciliation.js";
import {
  PerchanceMutationError,
  PerchanceProvider,
  type PerchanceDeploymentFile,
  type PerchanceDeploymentObservation,
  type PerchanceDesiredDeployment
} from "../providers/perchance-provider.js";
import type {
  ResolvedDeploymentArtifact
} from "./artifact-selection.js";
import {
  DeployerTargetResolver,
  type ResolvedRepositoryTarget
} from "./target-mapping.js";

const PRECONDITION_MAX_AGE_MS = 60_000;
const DEPLOYMENT_OPERATION_KIND = "deployer.initial-deployment";
const DEPLOYMENT_SCHEMA_VERSION = 1;

export interface InitialDeploymentInput {
  readonly page: BrowserPage;
  readonly artifact: ResolvedDeploymentArtifact;
  readonly accountId: string;
  readonly expectedProviderIdentity: string;
  readonly requiredPublic: boolean;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly owner: OperationOwner;
  readonly actorSource: string;
  readonly commandOptions?: BrowserDriverCommandOptions;
  readonly mutationCommandOptions?: BrowserDriverCommandOptions;
}

export type DeploymentDisposition =
  | "NO_OP"
  | "APPLIED"
  | "RECONCILED_APPLIED";

export interface InitialDeploymentResult {
  readonly disposition: DeploymentDisposition;
  readonly target: ResolvedRepositoryTarget;
  readonly desired: PerchanceDesiredDeployment;
  readonly observation: PerchanceDeploymentObservation;
  readonly operation: OperationRecord | null;
}

export class InitialDeploymentError extends Error {
  public constructor(
    public readonly code:
      | "DEPLOYER_DEPLOYMENT_MUTATION_FAILED"
      | "DEPLOYER_DEPLOYMENT_VERIFICATION_FAILED"
      | "DEPLOYER_DEPLOYMENT_OPERATION_CONFLICT"
      | "DEPLOYER_DEPLOYMENT_RECONCILIATION_UNRESOLVED",
    message: string,
    public readonly operationId: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "InitialDeploymentError";
  }
}

function relativeArtifactPath(
  artifact: ResolvedDeploymentArtifact,
  path: string
): string {
  if (artifact.contentRoot === null) {
    return path;
  }
  const prefix = `${artifact.contentRoot}/`;
  if (!path.startsWith(prefix)) {
    throw new Error(
      `deployment artifact entry is outside content root: ${path}`
    );
  }
  return path.slice(prefix.length);
}

function materializeDeployment(
  artifact: ResolvedDeploymentArtifact,
  isPublic: boolean
): PerchanceDesiredDeployment {
  const files: PerchanceDeploymentFile[] = [];
  for (const entry of artifact.entries) {
    if (entry.kind !== "file") {
      continue;
    }
    const path = relativeArtifactPath(artifact, entry.path);
    files.push(Object.freeze({
      path,
      contentBase64: artifact.readFile(path).toString("base64")
    }));
  }
  files.sort((left, right) =>
    left.path.localeCompare(right.path, "en")
  );
  if (files.length === 0) {
    throw new Error("deployment artifact contains no files");
  }
  return Object.freeze({
    artifactSha256: artifact.sha256,
    files: Object.freeze(files),
    isPublic
  });
}

function desiredFingerprint(
  desired: PerchanceDesiredDeployment
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      artifactSha256: desired.artifactSha256,
      isPublic: desired.isPublic
    }))
    .digest("hex");
}

function sameDeployment(
  target: ResolvedRepositoryTarget,
  desired: PerchanceDesiredDeployment,
  observed: PerchanceDeploymentObservation
): boolean {
  return (
    observed.publicId === target.generator.providerStableId &&
    observed.slug === target.generator.currentSlug &&
    observed.artifactSha256 === desired.artifactSha256 &&
    observed.isPublic === desired.isPublic &&
    JSON.stringify(observed.files) === JSON.stringify(desired.files)
  );
}

function sameOwner(
  left: OperationOwner,
  right: OperationOwner
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "CORE" && right.kind === "CORE") {
    return true;
  }
  return (
    left.kind === "MODULE" &&
    right.kind === "MODULE" &&
    left.moduleId === right.moduleId &&
    left.moduleVersion === right.moduleVersion &&
    left.runtimeGeneration === right.runtimeGeneration
  );
}

function deploymentProvenance(
  artifact: ResolvedDeploymentArtifact
): Readonly<{
  source: string;
  repositoryOwner: string;
  repository: string;
  commitSha: string;
  artifactPath: string;
  artifactSha256: string;
}> {
  return Object.freeze({
    source: "github-repository",
    repositoryOwner: artifact.owner,
    repository: artifact.repository,
    commitSha: artifact.commitSha,
    artifactPath: artifact.path,
    artifactSha256: artifact.sha256
  });
}

function sameOperationIntent(
  operation: OperationRecord,
  input: InitialDeploymentInput,
  target: ResolvedRepositoryTarget,
  desired: PerchanceDesiredDeployment
): boolean {
  const provenance = operation.provenance;
  return (
    operation.idempotencyKey === input.idempotencyKey &&
    operation.targetKey ===
      generatorOperationTargetKey(target.generator.generatorLocalId) &&
    operation.operationKind === DEPLOYMENT_OPERATION_KIND &&
    operation.schemaVersion === DEPLOYMENT_SCHEMA_VERSION &&
    sameOwner(operation.owner, input.owner) &&
    operation.actorSource === input.actorSource &&
    operation.personaUid === target.personaUid &&
    operation.accountId === target.account.accountId &&
    operation.desiredFingerprint === desiredFingerprint(desired) &&
    operation.attempt === 1 &&
    provenance["source"] === "github-repository" &&
    provenance["repositoryOwner"] === input.artifact.owner &&
    provenance["repository"] === input.artifact.repository &&
    provenance["commitSha"] === input.artifact.commitSha &&
    provenance["artifactPath"] === input.artifact.path &&
    provenance["artifactSha256"] === input.artifact.sha256
  );
}

export class InitialDeploymentService {
  readonly #provider: PerchanceProvider;
  readonly #coordinator: OperationCoordinator;
  readonly #targets: DeployerTargetResolver;
  readonly #reconciler: OperationReconciler;

  public constructor(options: Readonly<{
    database: DatabaseSync;
    provider: PerchanceProvider;
    coordinator?: OperationCoordinator;
  }>) {
    this.#provider = options.provider;
    this.#coordinator =
      options.coordinator ??
      new OperationCoordinator({ database: options.database });
    this.#targets = new DeployerTargetResolver({
      database: options.database,
      provider: options.provider
    });
    this.#reconciler = new OperationReconciler(this.#coordinator);
  }

  public async deploy(
    input: InitialDeploymentInput
  ): Promise<InitialDeploymentResult> {
    const target = await this.#targets.resolve({
      page: input.page,
      accountId: input.accountId,
      repositorySlug: input.artifact.repository,
      expectedProviderIdentity: input.expectedProviderIdentity,
      ...(input.commandOptions === undefined
        ? {}
        : { commandOptions: input.commandOptions })
    });
    const desired = materializeDeployment(
      input.artifact,
      input.requiredPublic
    );

    const byOperationId = this.#coordinator.get(input.operationId);
    const byIdempotency =
      this.#coordinator.getByIdempotencyKey(input.idempotencyKey);
    if (
      byOperationId !== null &&
      byIdempotency !== null &&
      byOperationId.operationId !== byIdempotency.operationId
    ) {
      throw new InitialDeploymentError(
        "DEPLOYER_DEPLOYMENT_OPERATION_CONFLICT",
        "Deployment operation ID and idempotency key refer to different durable operations",
        input.operationId
      );
    }
    const existing = byOperationId ?? byIdempotency;
    if (existing !== null) {
      if (!sameOperationIntent(existing, input, target, desired)) {
        throw new InitialDeploymentError(
          "DEPLOYER_DEPLOYMENT_OPERATION_CONFLICT",
          "Existing deployment operation identity is bound to a different durable intent",
          existing.operationId
        );
      }

      if (
        existing.state === "UNCERTAIN" ||
        existing.state === "NEEDS_HUMAN"
      ) {
        const gate = this.#coordinator.providerGate.acquire({
          provider: "perchance",
          accountId: target.account.accountId,
          personaUid: target.personaUid
        });
        try {
          return await this.#reconcileDeployment(
            input,
            target,
            desired,
            existing
          );
        } finally {
          gate.release();
        }
      }

      if (existing.state === "SUCCEEDED") {
        const observation = await this.#observeCurrent(
          input,
          target,
          existing.operationId
        );
        if (!sameDeployment(target, desired, observation)) {
          throw new InitialDeploymentError(
            "DEPLOYER_DEPLOYMENT_OPERATION_CONFLICT",
            "Completed deployment idempotency key cannot be reused after provider state drift",
            existing.operationId
          );
        }
        return Object.freeze({
          disposition: "NO_OP",
          target,
          desired,
          observation,
          operation: existing
        });
      }

      throw new InitialDeploymentError(
        "DEPLOYER_DEPLOYMENT_RECONCILIATION_UNRESOLVED",
        `Existing deployment operation is ${existing.state} and cannot be redispatched`,
        existing.operationId
      );
    }

    const current = await this.#observeCurrent(
      input,
      target,
      input.operationId
    );
    if (sameDeployment(target, desired, current)) {
      return Object.freeze({
        disposition: "NO_OP",
        target,
        desired,
        observation: current,
        operation: null
      });
    }

    const observedAt = target.identityEvidence.observedAt;
    const operation = this.#coordinator.prepare({
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      owner: input.owner,
      actorSource: input.actorSource,
      targetKey: generatorOperationTargetKey(
        target.generator.generatorLocalId
      ),
      operationKind: DEPLOYMENT_OPERATION_KIND,
      schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
      personaUid: target.personaUid,
      accountId: target.account.accountId,
      desiredFingerprint: desiredFingerprint(desired),
      provenance: deploymentProvenance(input.artifact),
      preconditions: [
        {
          key: "accountBinding",
          observedAt,
          maxAgeMs: PRECONDITION_MAX_AGE_MS,
          evidenceRef:
            `account:${target.account.accountId}:rev:${target.account.revision}`
        },
        {
          key: "generatorIdentity",
          observedAt,
          maxAgeMs: PRECONDITION_MAX_AGE_MS,
          evidenceRef:
            `generator:${target.generator.generatorLocalId}:rev:${target.generator.revision}`
        },
        {
          key: "providerSession",
          observedAt,
          maxAgeMs: PRECONDITION_MAX_AGE_MS,
          evidenceRef:
            `session:${target.account.accountId}:generator:${target.generator.generatorLocalId}`
        }
      ]
    });

    const gate = this.#coordinator.providerGate.acquire({
      provider: "perchance",
      accountId: target.account.accountId,
      personaUid: target.personaUid
    });
    try {
      this.#coordinator.authorizeDispatch({
        operationId: operation.operationId,
        expectedClaimEpoch: operation.claimEpoch,
        evidence: {
          provider: "perchance",
          generatorLocalId: target.generator.generatorLocalId,
          providerStableId: target.generator.providerStableId,
          artifactSha256: desired.artifactSha256
        }
      });

      try {
        await this.#provider.saveGeneratorDeployment(
          input.page,
          input.expectedProviderIdentity,
          {
            providerStableId: target.generator.providerStableId,
            currentSlug: target.generator.currentSlug
          },
          desired,
          input.mutationCommandOptions ?? input.commandOptions
        );
      } catch (error: unknown) {
        const effectState =
          error instanceof PerchanceMutationError
            ? error.effectState
            : "MAY_HAVE_OCCURRED";
        const lost = this.#coordinator.recordExecutionLoss({
          operationId: operation.operationId,
          expectedClaimEpoch: operation.claimEpoch,
          source: "NETWORK",
          effectState
        });

        if (effectState === "MAY_HAVE_OCCURRED") {
          return await this.#reconcileDeployment(
            input,
            target,
            desired,
            lost
          );
        }

        throw new InitialDeploymentError(
          "DEPLOYER_DEPLOYMENT_MUTATION_FAILED",
          "Deployment mutation was rejected before a remote effect could be established",
          operation.operationId,
          { cause: error }
        );
      }

      this.#coordinator.beginVerification(
        operation.operationId,
        operation.claimEpoch,
        "provider-save-acknowledged"
      );

      const observation = await this.#observeAfterDispatch(
        input,
        target,
        operation
      );
      if (!sameDeployment(target, desired, observation)) {
        this.#coordinator.markUncertain(
          operation.operationId,
          operation.claimEpoch,
          "post-save-provider-state-mismatch"
        );
        throw new InitialDeploymentError(
          "DEPLOYER_DEPLOYMENT_VERIFICATION_FAILED",
          "Deployment provider state does not match desired content/public state",
          operation.operationId
        );
      }

      const succeeded = this.#coordinator.markSucceeded(
        operation.operationId,
        operation.claimEpoch,
        "post-save-provider-state-verified"
      );
      return Object.freeze({
        disposition: "APPLIED",
        target,
        desired,
        observation,
        operation: succeeded
      });
    } finally {
      gate.release();
    }
  }

  async #observeCurrent(
    input: InitialDeploymentInput,
    target: ResolvedRepositoryTarget,
    operationId: string
  ): Promise<PerchanceDeploymentObservation> {
    try {
      return await this.#provider.observeGeneratorDeployment(
        input.page,
        input.expectedProviderIdentity,
        target.generator.providerStableId,
        input.commandOptions
      );
    } catch (error: unknown) {
      throw new InitialDeploymentError(
        "DEPLOYER_DEPLOYMENT_VERIFICATION_FAILED",
        "Deployment current provider state could not be verified",
        operationId,
        { cause: error }
      );
    }
  }

  async #observeAfterDispatch(
    input: InitialDeploymentInput,
    target: ResolvedRepositoryTarget,
    operation: OperationRecord
  ): Promise<PerchanceDeploymentObservation> {
    try {
      return await this.#provider.observeGeneratorDeployment(
        input.page,
        input.expectedProviderIdentity,
        target.generator.providerStableId,
        input.commandOptions
      );
    } catch (error: unknown) {
      this.#coordinator.markUncertain(
        operation.operationId,
        operation.claimEpoch,
        "post-save-provider-read-failed"
      );
      throw new InitialDeploymentError(
        "DEPLOYER_DEPLOYMENT_VERIFICATION_FAILED",
        "Deployment could not read provider state after save",
        operation.operationId,
        { cause: error }
      );
    }
  }

  async #reconcileDeployment(
    input: InitialDeploymentInput,
    target: ResolvedRepositoryTarget,
    desired: PerchanceDesiredDeployment,
    operation: OperationRecord
  ): Promise<InitialDeploymentResult> {
    let observation: PerchanceDeploymentObservation | null = null;
    const reconciled = await this.#reconciler.reconcile({
      operationId: operation.operationId,
      expectedClaimEpoch: operation.claimEpoch,
      read: async () => {
        observation = await this.#provider.observeGeneratorDeployment(
          input.page,
          input.expectedProviderIdentity,
          target.generator.providerStableId,
          input.commandOptions
        );
        if (sameDeployment(target, desired, observation)) {
          return {
            kind: "CONFIRMED_APPLIED",
            reason: "deployment-reconciliation-confirmed-applied"
          };
        }
        return {
          kind: "UNKNOWN",
          reason: "deployment-reconciliation-state-mismatch"
        };
      }
    });

    if (
      reconciled.operation.state === "SUCCEEDED" &&
      observation !== null
    ) {
      return Object.freeze({
        disposition: "RECONCILED_APPLIED",
        target,
        desired,
        observation,
        operation: reconciled.operation
      });
    }

    throw new InitialDeploymentError(
      "DEPLOYER_DEPLOYMENT_RECONCILIATION_UNRESOLVED",
      "Deployment outcome remains uncertain after read-first reconciliation; automatic redispatch is blocked",
      reconciled.operation.operationId
    );
  }
}
