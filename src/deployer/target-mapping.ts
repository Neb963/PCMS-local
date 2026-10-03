import type { DatabaseSync } from "node:sqlite";

import {
  AccountRepository,
  type AccountRecord
} from "../accounts/account-repository.js";
import type {
  BrowserDriverCommandOptions,
  BrowserPage
} from "../browser/browser-driver.js";
import {
  GeneratorRepository,
  type GeneratorRecord
} from "../generators/generator-repository.js";
import type {
  PerchanceGeneratorIdentityEvidence
} from "../providers/perchance-provider.js";

const MAX_REPOSITORY_SLUG_LENGTH = 512;

export interface GeneratorIdentityProvider {
  probeGeneratorIdentity(
    page: BrowserPage,
    expectedIdentity: string,
    generator: Readonly<{
      generatorLocalId: string;
      providerStableId: string | null;
      currentSlug: string;
    }>,
    commandOptions?: BrowserDriverCommandOptions
  ): Promise<PerchanceGeneratorIdentityEvidence>;
}

export interface ResolveRepositoryTargetInput {
  readonly page: BrowserPage;
  readonly accountId: string;
  readonly repositorySlug: string;
  readonly expectedProviderIdentity: string;
  readonly commandOptions?: BrowserDriverCommandOptions;
}

export interface ResolvedRepositoryTarget {
  readonly account: AccountRecord;
  readonly generator: GeneratorRecord & {
    readonly providerStableId: string;
  };
  readonly personaUid: string;
  readonly identityEvidence: PerchanceGeneratorIdentityEvidence;
}

export type DeployerTargetMappingErrorCode =
  | "DEPLOYER_TARGET_ACCOUNT_INACTIVE"
  | "DEPLOYER_TARGET_PERSONA_REQUIRED"
  | "DEPLOYER_TARGET_NOT_FOUND"
  | "DEPLOYER_TARGET_AMBIGUOUS"
  | "DEPLOYER_TARGET_STABLE_ID_REQUIRED"
  | "DEPLOYER_TARGET_IDENTITY_UNVERIFIED"
  | "DEPLOYER_TARGET_SLUG_CHANGED";

export class DeployerTargetMappingError extends Error {
  public constructor(
    public readonly code: DeployerTargetMappingErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DeployerTargetMappingError";
  }
}

function normalizeRepositorySlug(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > MAX_REPOSITORY_SLUG_LENGTH
  ) {
    throw new DeployerTargetMappingError(
      "DEPLOYER_TARGET_NOT_FOUND",
      "Repository slug must be a non-empty bounded string"
    );
  }
  return normalized;
}

export class DeployerTargetResolver {
  readonly #accounts: AccountRepository;
  readonly #generators: GeneratorRepository;
  readonly #provider: GeneratorIdentityProvider;

  public constructor(options: Readonly<{
    database: DatabaseSync;
    provider: GeneratorIdentityProvider;
  }>) {
    this.#accounts = new AccountRepository({
      database: options.database
    });
    this.#generators = new GeneratorRepository({
      database: options.database
    });
    this.#provider = options.provider;
  }

  public async resolve(
    input: ResolveRepositoryTargetInput
  ): Promise<ResolvedRepositoryTarget> {
    const account = this.#accounts.require(input.accountId);
    if (account.lifecycleStatus !== "ACTIVE") {
      throw new DeployerTargetMappingError(
        "DEPLOYER_TARGET_ACCOUNT_INACTIVE",
        `Account ${account.accountId} is not ACTIVE`
      );
    }
    if (account.personaUid === null) {
      throw new DeployerTargetMappingError(
        "DEPLOYER_TARGET_PERSONA_REQUIRED",
        `Account ${account.accountId} is not bound to a Persona`
      );
    }

    const repositorySlug = normalizeRepositorySlug(
      input.repositorySlug
    );
    const matches = this.#generators.list().filter(
      (candidate) =>
        candidate.accountId === account.accountId &&
        candidate.currentSlug === repositorySlug
    );
    if (matches.length === 0) {
      throw new DeployerTargetMappingError(
        "DEPLOYER_TARGET_NOT_FOUND",
        `Repository slug ${repositorySlug} is not mapped to a managed Generator for Account ${account.accountId}`
      );
    }
    if (matches.length !== 1) {
      throw new DeployerTargetMappingError(
        "DEPLOYER_TARGET_AMBIGUOUS",
        `Repository slug ${repositorySlug} maps to multiple managed Generators for Account ${account.accountId}`
      );
    }

    const generator = matches[0];
    if (generator === undefined) {
      throw new DeployerTargetMappingError(
        "DEPLOYER_TARGET_NOT_FOUND",
        "Mapped Generator disappeared"
      );
    }
    if (generator.providerStableId === null) {
      throw new DeployerTargetMappingError(
        "DEPLOYER_TARGET_STABLE_ID_REQUIRED",
        `Generator ${generator.generatorLocalId} has no stable provider identity`
      );
    }

    const identityEvidence =
      await this.#provider.probeGeneratorIdentity(
        input.page,
        input.expectedProviderIdentity,
        {
          generatorLocalId: generator.generatorLocalId,
          providerStableId: generator.providerStableId,
          currentSlug: generator.currentSlug
        },
        input.commandOptions
      );

    if (
      identityEvidence.sessionStatus !== "EXPECTED" ||
      identityEvidence.identityStatus !== "VERIFIED" ||
      identityEvidence.observedProviderStableId !==
        generator.providerStableId
    ) {
      throw new DeployerTargetMappingError(
        "DEPLOYER_TARGET_IDENTITY_UNVERIFIED",
        `Generator ${generator.generatorLocalId} provider identity is not freshly verified`
      );
    }
    if (
      identityEvidence.slugStatus !== "CURRENT" ||
      identityEvidence.observedSlug !== generator.currentSlug
    ) {
      throw new DeployerTargetMappingError(
        "DEPLOYER_TARGET_SLUG_CHANGED",
        `Generator ${generator.generatorLocalId} provider slug changed before mutation`
      );
    }

    return Object.freeze({
      account,
      generator: Object.freeze({
        ...generator,
        providerStableId: generator.providerStableId
      }),
      personaUid: account.personaUid,
      identityEvidence
    });
  }
}
