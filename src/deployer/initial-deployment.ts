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
  | "APPLIED";

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
      | "DEPLOYER_DEPLOYMENT_VERIFICATION_FAILED",
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

export class InitialDeploymentService {
  readonly #provider: PerchanceProvider;
  readonly #coordinator: OperationCoordinator;
  readonly #targets: DeployerTargetResolver;

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
  }

  public async deploy(
    input: InitialDeploymentInput
  ): Promise<InitialDeploymentResult> {
    const target = await this.#targets.resolve({
      page: input.page,
      accountId: input.accountId,
      repositorySlug: input.artifact.repository,
      expectedProviderIdentity: input.expectedProviderIdentity,
      commandOptions: input.commandOptions
    });
    const desired = materializeDeployment(
      input.artifact,
      input.requiredPublic
    );

    let current: PerchanceDeploymentObservation;
    try {
      current = await this.#provider.observeGeneratorDeployment(
        input.page,
        input.expectedProviderIdentity,
        target.generator.providerStableId,
        input.commandOptions
      );
    } catch (error: unknown) {
      throw new InitialDeploymentError(
        "DEPLOYER_DEPLOYMENT_VERIFICATION_FAILED",
        "Deployment current provider state could not be verified before mutation",
        input.operationId,
        { cause: error }
      );
    }

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
      operationKind: "deployer.initial-deployment",
      schemaVersion: 1,
      personaUid: target.personaUid,
      accountId: target.account.accountId,
      desiredFingerprint: desiredFingerprint(desired),
      provenance: {
        source: "github-repository",
        repositoryOwner: input.artifact.owner,
        repository: input.artifact.repository,
        commitSha: input.artifact.commitSha,
        artifactPath: input.artifact.path,
        artifactSha256: input.artifact.sha256
      },
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
        this.#coordinator.recordExecutionLoss({
          operationId: operation.operationId,
          expectedClaimEpoch: operation.claimEpoch,
          source: "NETWORK",
          effectState
        });
        throw new InitialDeploymentError(
          "DEPLOYER_DEPLOYMENT_MUTATION_FAILED",
          "Deployment mutation did not produce a safely acknowledged save",
          operation.operationId,
          { cause: error }
        );
      }

      this.#coordinator.beginVerification(
        operation.operationId,
        operation.claimEpoch,
        "provider-save-acknowledged"
      );

      let observation: PerchanceDeploymentObservation;
      try {
        observation =
          await this.#provider.observeGeneratorDeployment(
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
}
