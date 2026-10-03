import type { DatabaseSync } from "node:sqlite";

import {
  AccountRepository,
  prepareCreateAccountInput
} from "../accounts/account-repository.js";

const MAX_PROVIDER_IDENTITY_LENGTH = 320;
const MAX_SECRET_REF_LENGTH = 512;

export interface ProvisioningStageInput {
  readonly accountId: string;
  readonly displayName: string;
  readonly providerIdentity: string;
  readonly credentialSecretRef: string;
}

export interface ProvisioningStagedAccount {
  readonly accountId: string;
  readonly displayName: string;
  readonly providerIdentity: string;
  readonly providerIdentityKey: string;
  readonly credentialSecretRef: string;
  readonly lifecycleStatus: "INACTIVE";
}

export type ProvisioningStagingErrorCode =
  | "PROVISIONING_STAGE_EMPTY"
  | "PROVISIONING_STAGE_NOT_FOUND"
  | "PROVISIONING_PROVIDER_IDENTITY_INVALID"
  | "PROVISIONING_SECRET_REF_INVALID"
  | "PROVISIONING_DUPLICATE_ACCOUNT_ID"
  | "PROVISIONING_DUPLICATE_PROVIDER_IDENTITY"
  | "PROVISIONING_ACCOUNT_EXISTS";

export class ProvisioningStagingError extends Error {
  public constructor(
    public readonly code: ProvisioningStagingErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProvisioningStagingError";
  }
}

export interface ProvisioningStagingServiceOptions {
  readonly database: DatabaseSync;
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32)
  );
}

function normalizeProviderIdentity(value: string): {
  readonly display: string;
  readonly key: string;
} {
  const display = value.trim();
  if (
    display.length === 0 ||
    display.length > MAX_PROVIDER_IDENTITY_LENGTH ||
    /[\r\n\0]/u.test(display)
  ) {
    throw new ProvisioningStagingError(
      "PROVISIONING_PROVIDER_IDENTITY_INVALID",
      `Provider identity must contain 1-${MAX_PROVIDER_IDENTITY_LENGTH} safe characters`
    );
  }
  return Object.freeze({
    display,
    key: asciiLowercase(display)
  });
}

function normalizeSecretRef(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_SECRET_REF_LENGTH ||
    /[\r\n\0]/u.test(normalized)
  ) {
    throw new ProvisioningStagingError(
      "PROVISIONING_SECRET_REF_INVALID",
      `Credential SecretRef must contain 1-${MAX_SECRET_REF_LENGTH} safe characters`
    );
  }
  return normalized;
}

function prepare(input: ProvisioningStageInput): ProvisioningStagedAccount {
  const account = prepareCreateAccountInput({
    accountId: input.accountId,
    displayName: input.displayName,
    lifecycleStatus: "INACTIVE"
  });
  const providerIdentity = normalizeProviderIdentity(input.providerIdentity);
  return Object.freeze({
    accountId: account.accountId,
    displayName: account.displayName,
    providerIdentity: providerIdentity.display,
    providerIdentityKey: providerIdentity.key,
    credentialSecretRef: normalizeSecretRef(input.credentialSecretRef),
    lifecycleStatus: "INACTIVE"
  });
}

export class ProvisioningStagingService {
  readonly #accounts: AccountRepository;
  readonly #stagedByAccount = new Map<string, ProvisioningStagedAccount>();
  readonly #stagedIdentityOwners = new Map<string, string>();

  public constructor(options: ProvisioningStagingServiceOptions) {
    this.#accounts = new AccountRepository({ database: options.database });
  }

  public stageBatch(
    inputs: readonly ProvisioningStageInput[]
  ): readonly ProvisioningStagedAccount[] {
    if (inputs.length === 0) {
      throw new ProvisioningStagingError(
        "PROVISIONING_STAGE_EMPTY",
        "Provisioning batch must contain at least one Account"
      );
    }

    const prepared = inputs.map(prepare);
    const accountIds = new Set<string>();
    const providerIdentityKeys = new Set<string>();

    for (const candidate of prepared) {
      if (accountIds.has(candidate.accountId)) {
        throw new ProvisioningStagingError(
          "PROVISIONING_DUPLICATE_ACCOUNT_ID",
          `Provisioning batch contains duplicate Account ID ${candidate.accountId}`
        );
      }
      accountIds.add(candidate.accountId);

      if (providerIdentityKeys.has(candidate.providerIdentityKey)) {
        throw new ProvisioningStagingError(
          "PROVISIONING_DUPLICATE_PROVIDER_IDENTITY",
          `Provisioning batch contains duplicate provider identity ${candidate.providerIdentity}`
        );
      }
      providerIdentityKeys.add(candidate.providerIdentityKey);
    }

    // Complete all duplicate/conflict checks before changing staged state.
    for (const candidate of prepared) {
      if (this.#accounts.get(candidate.accountId) !== null) {
        throw new ProvisioningStagingError(
          "PROVISIONING_ACCOUNT_EXISTS",
          `Account ${candidate.accountId} already exists`
        );
      }
      if (this.#stagedByAccount.has(candidate.accountId)) {
        throw new ProvisioningStagingError(
          "PROVISIONING_DUPLICATE_ACCOUNT_ID",
          `Account ${candidate.accountId} is already staged`
        );
      }
      const existingIdentityOwner = this.#stagedIdentityOwners.get(
        candidate.providerIdentityKey
      );
      if (existingIdentityOwner !== undefined) {
        throw new ProvisioningStagingError(
          "PROVISIONING_DUPLICATE_PROVIDER_IDENTITY",
          `Provider identity ${candidate.providerIdentity} is already staged for Account ${existingIdentityOwner}`
        );
      }
    }

    for (const candidate of prepared) {
      this.#stagedByAccount.set(candidate.accountId, candidate);
      this.#stagedIdentityOwners.set(
        candidate.providerIdentityKey,
        candidate.accountId
      );
    }

    return Object.freeze([...prepared]);
  }

  public require(accountId: string): ProvisioningStagedAccount {
    const staged = this.#stagedByAccount.get(accountId);
    if (staged === undefined) {
      throw new ProvisioningStagingError(
        "PROVISIONING_STAGE_NOT_FOUND",
        `Account ${accountId} is not staged in this provisioning session`
      );
    }
    return staged;
  }

  public list(): readonly ProvisioningStagedAccount[] {
    return Object.freeze(
      [...this.#stagedByAccount.values()].sort((left, right) =>
        left.accountId.localeCompare(right.accountId, "en")
      )
    );
  }
}
