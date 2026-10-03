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

export interface RebindPersonaInput extends BindPersonaInput {}

export interface UnbindPersonaInput {
  readonly accountId: string;
  readonly expectedRevision: number;
  readonly reason: string;
}

export type PersonaBindingEventKind = "BIND" | "REBIND" | "UNBIND";

export interface PersonaBindingHistoryRecord {
  readonly bindingEventId: number;
  readonly accountId: string;
  readonly eventKind: PersonaBindingEventKind;
  readonly previousPersonaUid: string | null;
  readonly nextPersonaUid: string | null;
  readonly reason: string;
  readonly changedAt: string;
  readonly accountRevision: number;
}

export type PersonaBindingErrorCode =
  | "ACCOUNT_NOT_ACTIVE"
  | "ACCOUNT_NOT_INACTIVE"
  | "PERSONA_NOT_FOUND"
  | "PERSONA_NOT_ACTIVE"
  | "ACCOUNT_ALREADY_BOUND"
  | "ACCOUNT_NOT_BOUND"
  | "PERSONA_ALREADY_BOUND"
  | "ACCOUNT_REVISION_CONFLICT"
  | "BINDING_REASON_INVALID"
  | "BINDING_HISTORY_INVALID";

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

interface BindingHistoryRow {
  readonly binding_event_id: unknown;
  readonly account_id: unknown;
  readonly event_kind: unknown;
  readonly previous_persona_uid: unknown;
  readonly next_persona_uid: unknown;
  readonly reason: unknown;
  readonly changed_at: unknown;
  readonly account_revision: unknown;
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

function requireActiveAccount(
  accounts: AccountRepository,
  accountId: string,
  expectedRevision: number
): AccountRecord {
  const account = accounts.require(accountId);
  if (account.lifecycleStatus !== "ACTIVE") {
    throw new PersonaBindingError(
      "ACCOUNT_NOT_ACTIVE",
      `Account ${accountId} is not ACTIVE`
    );
  }
  if (account.revision !== expectedRevision) {
    throw new PersonaBindingError(
      "ACCOUNT_REVISION_CONFLICT",
      `Account ${accountId} revision changed from expected ${expectedRevision} to ${account.revision}`
    );
  }
  return account;
}

function requireInactiveAccount(
  accounts: AccountRepository,
  accountId: string,
  expectedRevision: number
): AccountRecord {
  const account = accounts.require(accountId);
  if (account.lifecycleStatus !== "INACTIVE") {
    throw new PersonaBindingError(
      "ACCOUNT_NOT_INACTIVE",
      `Account ${accountId} is not INACTIVE`
    );
  }
  if (account.revision !== expectedRevision) {
    throw new PersonaBindingError(
      "ACCOUNT_REVISION_CONFLICT",
      `Account ${accountId} revision changed from expected ${expectedRevision} to ${account.revision}`
    );
  }
  return account;
}

function requireActivePersona(
  database: DatabaseSync,
  personaUid: string
): void {
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
  if (row.lifecycle_status !== "ACTIVE") {
    throw new PersonaBindingError(
      "PERSONA_NOT_ACTIVE",
      `Persona ${personaUid} is not ACTIVE`
    );
  }
}

function requirePersonaAvailable(
  database: DatabaseSync,
  personaUid: string,
  accountId: string,
  includeInactiveOwners = false
): void {
  requireActivePersona(database, personaUid);
  const row = database.prepare(`
    SELECT account_id
    FROM accounts
    WHERE
      persona_uid = ? AND
      ${includeInactiveOwners ? "" : "lifecycle_status = 'ACTIVE' AND"}
      account_id <> ?
    LIMIT 1
  `).get(personaUid, accountId) as unknown as PersonaOwnerRow | undefined;

  if (row === undefined) {
    return;
  }
  if (typeof row.account_id !== "string") {
    throw new PersonaBindingError(
      "BINDING_HISTORY_INVALID",
      "Stored Persona binding owner is invalid"
    );
  }
  throw new PersonaBindingError(
    "PERSONA_ALREADY_BOUND",
    `Persona ${personaUid} is already bound to ACTIVE Account ${row.account_id}`
  );
}

function appendHistory(
  database: DatabaseSync,
  event: Omit<PersonaBindingHistoryRecord, "bindingEventId">
): void {
  database.prepare(`
    INSERT INTO persona_bindings_history (
      account_id,
      event_kind,
      previous_persona_uid,
      next_persona_uid,
      reason,
      changed_at,
      account_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.accountId,
    event.eventKind,
    event.previousPersonaUid,
    event.nextPersonaUid,
    event.reason,
    event.changedAt,
    event.accountRevision
  );
}

function parseHistoryRow(row: BindingHistoryRow): PersonaBindingHistoryRecord {
  const {
    binding_event_id: bindingEventId,
    account_id: accountId,
    event_kind: eventKind,
    previous_persona_uid: previousPersonaUid,
    next_persona_uid: nextPersonaUid,
    reason,
    changed_at: changedAt,
    account_revision: accountRevision
  } = row;

  if (
    typeof bindingEventId !== "number" ||
    !Number.isSafeInteger(bindingEventId) ||
    bindingEventId < 1 ||
    typeof accountId !== "string" ||
    (eventKind !== "BIND" && eventKind !== "REBIND" && eventKind !== "UNBIND") ||
    (previousPersonaUid !== null && typeof previousPersonaUid !== "string") ||
    (nextPersonaUid !== null && typeof nextPersonaUid !== "string") ||
    typeof reason !== "string" ||
    typeof changedAt !== "string" ||
    typeof accountRevision !== "number" ||
    !Number.isSafeInteger(accountRevision) ||
    accountRevision < 1
  ) {
    throw new PersonaBindingError(
      "BINDING_HISTORY_INVALID",
      "Stored Persona binding history is invalid"
    );
  }

  return Object.freeze({
    bindingEventId,
    accountId,
    eventKind,
    previousPersonaUid,
    nextPersonaUid,
    reason,
    changedAt,
    accountRevision
  });
}

function isPersonaUniquenessConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed: accounts.persona_uid")
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
        const account = requireActiveAccount(
          this.#accounts,
          input.accountId,
          input.expectedRevision
        );
        if (account.personaUid !== null) {
          if (account.personaUid === input.personaUid) {
            return account;
          }
          throw new PersonaBindingError(
            "ACCOUNT_ALREADY_BOUND",
            `Account ${input.accountId} is already bound to Persona ${account.personaUid}; explicit rebind is required`
          );
        }

        requirePersonaAvailable(
          this.#database,
          input.personaUid,
          input.accountId
        );

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

        appendHistory(this.#database, {
          accountId: input.accountId,
          eventKind: "BIND",
          previousPersonaUid: null,
          nextPersonaUid: input.personaUid,
          reason,
          changedAt,
          accountRevision: updated.revision
        });
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

  public bindProvisioningInactive(input: BindPersonaInput): AccountRecord {
    validateExpectedRevision(input.expectedRevision);
    const reason = normalizeReason(input.reason);

    return transaction(this.#database, () => {
      const account = requireInactiveAccount(
        this.#accounts,
        input.accountId,
        input.expectedRevision
      );
      if (account.personaUid !== null) {
        if (account.personaUid === input.personaUid) {
          return account;
        }
        throw new PersonaBindingError(
          "ACCOUNT_ALREADY_BOUND",
          `Account ${input.accountId} is already bound to Persona ${account.personaUid}; explicit recovery is required`
        );
      }

      // Provisioning reserves a dedicated Persona before activation, so an
      // INACTIVE Account must not share it with any other managed Account.
      requirePersonaAvailable(
        this.#database,
        input.personaUid,
        input.accountId,
        true
      );

      const changedAt = this.#now().toISOString();
      this.#database.prepare(`
        UPDATE accounts
        SET
          persona_uid = ?,
          updated_at = ?,
          revision = revision + 1
        WHERE
          account_id = ? AND
          lifecycle_status = 'INACTIVE' AND
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
        updated.lifecycleStatus !== "INACTIVE" ||
        updated.revision !== input.expectedRevision + 1
      ) {
        throw new PersonaBindingError(
          "ACCOUNT_REVISION_CONFLICT",
          `Account ${input.accountId} changed while reserving its provisioning Persona`
        );
      }

      appendHistory(this.#database, {
        accountId: input.accountId,
        eventKind: "BIND",
        previousPersonaUid: null,
        nextPersonaUid: input.personaUid,
        reason,
        changedAt,
        accountRevision: updated.revision
      });
      return updated;
    });
  }

  public rebind(input: RebindPersonaInput): AccountRecord {
    validateExpectedRevision(input.expectedRevision);
    const reason = normalizeReason(input.reason);

    try {
      return transaction(this.#database, () => {
        const account = requireActiveAccount(
          this.#accounts,
          input.accountId,
          input.expectedRevision
        );
        if (account.personaUid === null) {
          throw new PersonaBindingError(
            "ACCOUNT_NOT_BOUND",
            `Account ${input.accountId} has no Persona to rebind`
          );
        }
        if (account.personaUid === input.personaUid) {
          return account;
        }

        requirePersonaAvailable(
          this.#database,
          input.personaUid,
          input.accountId
        );

        const previousPersonaUid = account.personaUid;
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
            persona_uid = ? AND
            revision = ?
        `).run(
          input.personaUid,
          changedAt,
          input.accountId,
          previousPersonaUid,
          input.expectedRevision
        );

        const updated = this.#accounts.require(input.accountId);
        if (
          updated.personaUid !== input.personaUid ||
          updated.revision !== input.expectedRevision + 1
        ) {
          throw new PersonaBindingError(
            "ACCOUNT_REVISION_CONFLICT",
            `Account ${input.accountId} changed while rebinding Persona`
          );
        }

        appendHistory(this.#database, {
          accountId: input.accountId,
          eventKind: "REBIND",
          previousPersonaUid,
          nextPersonaUid: input.personaUid,
          reason,
          changedAt,
          accountRevision: updated.revision
        });
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

  public unbind(input: UnbindPersonaInput): AccountRecord {
    validateExpectedRevision(input.expectedRevision);
    const reason = normalizeReason(input.reason);

    return transaction(this.#database, () => {
      const account = requireActiveAccount(
        this.#accounts,
        input.accountId,
        input.expectedRevision
      );
      if (account.personaUid === null) {
        return account;
      }

      const previousPersonaUid = account.personaUid;
      const changedAt = this.#now().toISOString();
      this.#database.prepare(`
        UPDATE accounts
        SET
          persona_uid = NULL,
          updated_at = ?,
          revision = revision + 1
        WHERE
          account_id = ? AND
          lifecycle_status = 'ACTIVE' AND
          persona_uid = ? AND
          revision = ?
      `).run(
        changedAt,
        input.accountId,
        previousPersonaUid,
        input.expectedRevision
      );

      const updated = this.#accounts.require(input.accountId);
      if (
        updated.personaUid !== null ||
        updated.revision !== input.expectedRevision + 1
      ) {
        throw new PersonaBindingError(
          "ACCOUNT_REVISION_CONFLICT",
          `Account ${input.accountId} changed while unbinding Persona`
        );
      }

      appendHistory(this.#database, {
        accountId: input.accountId,
        eventKind: "UNBIND",
        previousPersonaUid,
        nextPersonaUid: null,
        reason,
        changedAt,
        accountRevision: updated.revision
      });
      return updated;
    });
  }

  public listHistory(accountId: string): readonly PersonaBindingHistoryRecord[] {
    this.#accounts.require(accountId);
    const rows = this.#database.prepare(`
      SELECT
        binding_event_id,
        account_id,
        event_kind,
        previous_persona_uid,
        next_persona_uid,
        reason,
        changed_at,
        account_revision
      FROM persona_bindings_history
      WHERE account_id = ?
      ORDER BY binding_event_id
    `).all(accountId) as unknown as BindingHistoryRow[];

    return Object.freeze(rows.map(parseHistoryRow));
  }
}
