import type { DatabaseSync } from "node:sqlite";

import {
  AccountRepository,
  type AccountRecord
} from "../accounts/account-repository.js";
import {
  PersonaBindingService
} from "../accounts/persona-binding.js";
import {
  PersonaProfileLifecycle,
  type AllocatedPersonaProfile
} from "../personas/profile-lifecycle.js";
import type { ProvisioningStagedAccount } from "./staging.js";

export type ProvisioningAllocationErrorCode =
  | "PROVISIONING_STAGE_INVALID"
  | "PROVISIONING_ACCOUNT_CONFLICT"
  | "PROVISIONING_PERSONA_ALREADY_ALLOCATED";

export class ProvisioningAllocationError extends Error {
  public constructor(
    public readonly code: ProvisioningAllocationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProvisioningAllocationError";
  }
}

export interface ProvisioningAllocationServiceOptions {
  readonly database: DatabaseSync;
  readonly personasRoot: string;
  readonly now?: () => Date;
}

export interface ProvisioningAllocationResult {
  readonly account: AccountRecord;
  readonly persona: AllocatedPersonaProfile;
}

interface PersonaOwnerRow {
  readonly account_id: unknown;
}

export class ProvisioningAllocationService {
  readonly #database: DatabaseSync;
  readonly #accounts: AccountRepository;
  readonly #bindings: PersonaBindingService;
  readonly #profiles: PersonaProfileLifecycle;

  public constructor(options: ProvisioningAllocationServiceOptions) {
    this.#database = options.database;
    const timed = {
      database: options.database,
      ...(options.now === undefined ? {} : { now: options.now })
    };
    this.#accounts = new AccountRepository(timed);
    this.#bindings = new PersonaBindingService(timed);
    this.#profiles = new PersonaProfileLifecycle({
      database: options.database,
      personasRoot: options.personasRoot,
      ...(options.now === undefined ? {} : { now: options.now })
    });
  }

  public async allocate(
    staged: ProvisioningStagedAccount,
    personaUid: string
  ): Promise<ProvisioningAllocationResult> {
    if (staged.lifecycleStatus !== "INACTIVE") {
      throw new ProvisioningAllocationError(
        "PROVISIONING_STAGE_INVALID",
        "Provisioning allocation requires an INACTIVE staged Account"
      );
    }

    const owner = this.#database.prepare(`
      SELECT account_id
      FROM accounts
      WHERE persona_uid = ? AND account_id <> ?
      LIMIT 1
    `).get(personaUid, staged.accountId) as unknown as
      | PersonaOwnerRow
      | undefined;
    if (owner !== undefined) {
      if (typeof owner.account_id !== "string") {
        throw new ProvisioningAllocationError(
          "PROVISIONING_ACCOUNT_CONFLICT",
          "Stored Persona ownership metadata is invalid"
        );
      }
      throw new ProvisioningAllocationError(
        "PROVISIONING_PERSONA_ALREADY_ALLOCATED",
        `Persona ${personaUid} is already allocated to Account ${owner.account_id}`
      );
    }

    let account = this.#accounts.get(staged.accountId);
    if (account === null) {
      account = this.#accounts.create({
        accountId: staged.accountId,
        displayName: staged.displayName,
        lifecycleStatus: "INACTIVE"
      });
    } else if (
      account.lifecycleStatus !== "INACTIVE" ||
      account.displayName !== staged.displayName
    ) {
      throw new ProvisioningAllocationError(
        "PROVISIONING_ACCOUNT_CONFLICT",
        `Account ${staged.accountId} no longer matches its staged provisioning identity`
      );
    }

    if (account.personaUid !== null && account.personaUid !== personaUid) {
      throw new ProvisioningAllocationError(
        "PROVISIONING_ACCOUNT_CONFLICT",
        `Account ${staged.accountId} is already allocated to Persona ${account.personaUid}`
      );
    }

    const persona = await this.#profiles.allocate(personaUid);
    const bound = account.personaUid === personaUid
      ? account
      : this.#bindings.bindProvisioningInactive({
          accountId: staged.accountId,
          personaUid,
          expectedRevision: account.revision,
          reason: "Account Provisioning dedicated Persona allocation"
        });

    return Object.freeze({ account: bound, persona });
  }
}
