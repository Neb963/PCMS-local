import type { DatabaseSync } from "node:sqlite";

import type { AccountRecord } from "./account-repository.js";
import { AccountRepository } from "./account-repository.js";

const MAX_BINDING_REASON_LENGTH = 256;

export interface PersonaBindingOptions {
  readonly database: DatabaseSync;
  readonly now?: () => Date;
}

export interface BindPersonaInput {
  readonly accountId: string;
  readonly personaUid: string;
  readonly expectedRevision: number;
  readonly reason: string;
}

export type PersonaBindingErrorCode =
  | "ACCOUNT_NOT_ACTIVE"
  | "PERSONA_NOT_FOUND"
  | "PERSONA_NOT_ACTIVE"
  | "ACCOUNT_ALREADY_BOUND"
  | "PERSONA_ALREADY_BOUND"
  | "ACCOUNT_REVISION_CONFLICT"
  | "BINDING_REASON_INVALID";

export class PersonaBindingError extends Error {
  public constructor(
    public readonly code: PersonaBindingErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PersonaBindingError";
  }
}

interface PersonaStateRow {
  readonly lifecycle_status: unknown;
}

interface PersonaOwnerRow {
  readonly account_id: unknown;
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

function normalizeReason(reason: string): string {
  const normalized = reason.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_BINDING_REASON_LENGTH
  ) {
    throw new PersonaBindingError(
      "BINDING_REASON_INVALID",
      `Binding reason must contain 1-${MAX_BINDING_REASON_LENGTH} characters`
    );
  }
  return normalized;
}

function validateExpectedRevision(expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new PersonaBindingError(
      "ACCOUNT_REVISION_CONFLICT",
      "Expected Account revision must be a non-negative safe integer"
    );
  }
}

function readPersonaState(
  database: DatabaseSync,
  personaUid: string
): "ACTIVE" | "RETIRED" {
  const row = database.prepare(`
    SELECT lifecycle_status
    FROM personas
    WHERE persona_uid = ?
  `).get(personaUid) as unknown as PersonaStateRow | undefined;

  if (row === undefined) {
    throw new PersonaBindingError(
      "PERSONA_NOT_FOUND",
      `Persona ${personaUid} does not exist`
    );
  }
  if (
    row.lifecycle_status !== "ACTIVE" &&
    row.lifecycle_status !== "RETIRED"
  ) {
    throw new PersonaBindingError(
      "PERSONA_NOT_ACTIVE",
      `Persona ${personaUid} has invalid lifecycle metadata`
    );
  }
  return row.lifecycle_status;
}

function readActivePersonaOwner(
  database: DatabaseSync,
  personaUid: string,
  excludingAccountId: string
): string | null {
  const row = database.prepare(`
    SELECT account_id
    FROM accounts
    WHERE
      persona_uid = ? AND
      lifecycle_status = 'ACTIVE' AND
      account_id <> ?
    LIMIT 1
  `).get(personaUid, excludingAccountId) as unknown as
    | PersonaOwnerRow
    | undefined;

  if (row === undefined) {
    return null;
  }
  if (typeof row.account_id !== "string") {
    throw new PersonaBindingError(
      "PERSONA_ALREADY_BOUND",
      "Stored Persona binding owner is invalid"
    );
  }
  return row.account_id;
}

function isPersonaUniquenessConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "UNIQUE constraint failed: accounts.persona_uid"
    )
  );
}

export class PersonaBindingService {
  readonly #database: DatabaseSync;
  readonly #accounts: AccountRepository;
  readonly #now: () => Date;

  public constructor(options: PersonaBindingOptions) {
    this.#database = options.database;
    this.#accounts = new AccountRepository({
      database: options.database,
      ...(options.now === undefined ? {} : { now: options.now })
    });
    this.#now = options.now ?? (() => new Date());
  }

  public bind(input: BindPersonaInput): AccountRecord {
    validateExpectedRevision(input.expectedRevision);
    const reason = normalizeReason(input.reason);

    try {
      return transaction(this.#database, () => {
        const account = this.#accounts.require(input.accountId);
        if (account.lifecycleStatus !== "ACTIVE") {
          throw new PersonaBindingError(
            "ACCOUNT_NOT_ACTIVE",
            `Account ${input.accountId} is not ACTIVE`
          );
        }
        if (account.revision !== input.expectedRevision) {
          throw new PersonaBindingError(
            "ACCOUNT_REVISION_CONFLICT",
            `Account ${input.accountId} revision changed from expected ${input.expectedRevision} to ${account.revision}`
          );
        }
        if (account.personaUid !== null) {
          if (account.personaUid === input.personaUid) {
            return account;
          }
          throw new PersonaBindingError(
            "ACCOUNT_ALREADY_BOUND",
            `Account ${input.accountId} is already bound to Persona ${account.personaUid}; explicit rebind is required`
          );
        }

        const personaStatus = readPersonaState(
          this.#database,
          input.personaUid
        );
        if (personaStatus !== "ACTIVE") {
          throw new PersonaBindingError(
            "PERSONA_NOT_ACTIVE",
            `Persona ${input.personaUid} is not ACTIVE`
          );
        }

        const existingOwner = readActivePersonaOwner(
          this.#database,
          input.personaUid,
          input.accountId
        );
        if (existingOwner !== null) {
          throw new PersonaBindingError(
            "PERSONA_ALREADY_BOUND",
            `Persona ${input.personaUid} is already bound to ACTIVE Account ${existingOwner}`
          );
        }

        const changedAt = this.#now().toISOString();
        this.#database.prepare(`
          UPDATE accounts
          SET
            persona_uid = ?,
            updated_at = ?,
            revision = revision + 1
          WHERE
            account_id = ? AND
            lifecycle_status = 'ACTIVE' AND
            persona_uid IS NULL AND
            revision = ?
        `).run(
          input.personaUid,
          changedAt,
          input.accountId,
          input.expectedRevision
        );

        const updated = this.#accounts.require(input.accountId);
        if (
          updated.personaUid !== input.personaUid ||
          updated.revision !== input.expectedRevision + 1
        ) {
          throw new PersonaBindingError(
            "ACCOUNT_REVISION_CONFLICT",
            `Account ${input.accountId} changed while binding Persona`
          );
        }

        this.#database.prepare(`
          INSERT INTO persona_bindings_history (
            account_id,
            event_kind,
            previous_persona_uid,
            next_persona_uid,
            reason,
            changed_at,
            account_revision
          ) VALUES (?, 'BIND', NULL, ?, ?, ?, ?)
        `).run(
          input.accountId,
          input.personaUid,
          reason,
          changedAt,
          updated.revision
        );

        return updated;
      });
    } catch (error: unknown) {
      if (isPersonaUniquenessConstraint(error)) {
        throw new PersonaBindingError(
          "PERSONA_ALREADY_BOUND",
          `Persona ${input.personaUid} is already bound to another ACTIVE Account`,
          error
        );
      }
      throw error;
    }
  }
}
