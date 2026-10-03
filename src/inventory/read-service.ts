import type { DatabaseSync } from "node:sqlite";

import type {
  AccountLifecycleStatus,
  AccountRecord
} from "../accounts/account-repository.js";
import { AccountRepository } from "../accounts/account-repository.js";
import type {
  PersonaInventoryRecord,
  PersonaLifecycleStatus,
  PersonaProfileState
} from "../personas/repository.js";
import { PersonaRepository } from "../personas/repository.js";
import type { InventorySearchResult } from "./search.js";
import { InventorySearchService } from "./search.js";

export interface AccountInventorySummary {
  readonly accountId: string;
  readonly displayName: string;
  readonly lifecycleStatus: AccountLifecycleStatus;
  readonly personaUid: string | null;
  readonly revision: number;
}

export interface PersonaNavigationRecord {
  readonly personaUid: string;
  readonly lifecycleStatus: PersonaLifecycleStatus;
  readonly profileState: PersonaProfileState;
  readonly browserBackend: "chromium-v1";
  readonly revision: number;
}

export interface AccountPersonaNavigation {
  readonly accountId: string;
  readonly persona: PersonaNavigationRecord | null;
}

export interface InventoryReadServiceOptions {
  readonly database: DatabaseSync;
}

export class InventoryReadError extends Error {
  public readonly code = "BOUND_PERSONA_NOT_FOUND";

  public constructor(accountId: string, personaUid: string) {
    super(
      `Account ${accountId} references Persona ${personaUid}, but that Persona inventory record is unavailable`
    );
    this.name = "InventoryReadError";
  }
}

function summarizeAccount(account: AccountRecord): AccountInventorySummary {
  return Object.freeze({
    accountId: account.accountId,
    displayName: account.displayName,
    lifecycleStatus: account.lifecycleStatus,
    personaUid: account.personaUid,
    revision: account.revision
  });
}

function summarizePersona(
  persona: PersonaInventoryRecord
): PersonaNavigationRecord {
  return Object.freeze({
    personaUid: persona.personaUid,
    lifecycleStatus: persona.lifecycleStatus,
    profileState: persona.profileState,
    browserBackend: persona.browserBackend,
    revision: persona.revision
  });
}

export class InventoryReadService {
  readonly #accounts: AccountRepository;
  readonly #personas: PersonaRepository;
  readonly #search: InventorySearchService;

  public constructor(options: InventoryReadServiceOptions) {
    this.#accounts = new AccountRepository({ database: options.database });
    this.#personas = new PersonaRepository({ database: options.database });
    this.#search = new InventorySearchService({ database: options.database });
  }

  public listAccounts(): readonly AccountInventorySummary[] {
    return Object.freeze(
      this.#accounts.list().map((account) => summarizeAccount(account))
    );
  }

  public accountPersona(accountId: string): AccountPersonaNavigation {
    const account = this.#accounts.require(accountId);
    if (account.personaUid === null) {
      return Object.freeze({
        accountId: account.accountId,
        persona: null
      });
    }

    const persona = this.#personas.get(account.personaUid);
    if (persona === null) {
      throw new InventoryReadError(account.accountId, account.personaUid);
    }

    return Object.freeze({
      accountId: account.accountId,
      persona: summarizePersona(persona)
    });
  }

  public search(query: string): readonly InventorySearchResult[] {
    return this.#search.search(query);
  }
}
