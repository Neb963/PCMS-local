import type { DatabaseSync } from "node:sqlite";

const SAFE_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_DISPLAY_NAME_LENGTH = 256;

export type AccountLifecycleStatus = "ACTIVE" | "INACTIVE";

export interface AccountRecord {
  readonly accountId: string;
  readonly displayName: string;
  readonly lifecycleStatus: AccountLifecycleStatus;
  readonly personaUid: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface CreateAccountInput {
  readonly accountId: string;
  readonly displayName: string;
  readonly lifecycleStatus?: AccountLifecycleStatus;
}

export interface AccountRepositoryOptions {
  readonly database: DatabaseSync;
  readonly now?: () => Date;
}

export type AccountRepositoryErrorCode =
  | "ACCOUNT_ID_INVALID"
  | "ACCOUNT_DISPLAY_NAME_INVALID"
  | "ACCOUNT_EXISTS"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_ROW_INVALID";

export class AccountRepositoryError extends Error {
  public constructor(
    public readonly code: AccountRepositoryErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AccountRepositoryError";
  }
}

interface AccountRow {
  readonly account_id: unknown;
  readonly display_name: unknown;
  readonly lifecycle_status: unknown;
  readonly persona_uid: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly revision: unknown;
}

function parseAccount(row: AccountRow | undefined): AccountRecord | null {
  if (row === undefined) {
    return null;
  }

  const {
    account_id: accountId,
    display_name: displayName,
    lifecycle_status: lifecycleStatus,
    persona_uid: personaUid,
    created_at: createdAt,
    updated_at: updatedAt,
    revision
  } = row;

  if (
    typeof accountId !== "string" ||
    typeof displayName !== "string" ||
    (lifecycleStatus !== "ACTIVE" && lifecycleStatus !== "INACTIVE") ||
    (personaUid !== null && typeof personaUid !== "string") ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new AccountRepositoryError(
      "ACCOUNT_ROW_INVALID",
      "Stored Account metadata is invalid"
    );
  }

  return Object.freeze({
    accountId,
    displayName,
    lifecycleStatus,
    personaUid,
    createdAt,
    updatedAt,
    revision
  });
}

function assertAccountId(accountId: string): void {
  if (!SAFE_ACCOUNT_ID.test(accountId)) {
    throw new AccountRepositoryError(
      "ACCOUNT_ID_INVALID",
      "Account ID must be a safe opaque identifier using only letters, digits, underscore or hyphen"
    );
  }
}

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_DISPLAY_NAME_LENGTH
  ) {
    throw new AccountRepositoryError(
      "ACCOUNT_DISPLAY_NAME_INVALID",
      `Account display name must contain 1-${MAX_DISPLAY_NAME_LENGTH} characters`
    );
  }
  return normalized;
}

function isAccountPrimaryKeyConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed: accounts.account_id")
  );
}

export class AccountRepository {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  public constructor(options: AccountRepositoryOptions) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
  }

  public create(input: CreateAccountInput): AccountRecord {
    assertAccountId(input.accountId);
    const displayName = normalizeDisplayName(input.displayName);
    const lifecycleStatus = input.lifecycleStatus ?? "ACTIVE";
    const now = this.#now().toISOString();

    try {
      this.#database.prepare(`
        INSERT INTO accounts (
          account_id,
          display_name,
          lifecycle_status,
          persona_uid,
          created_at,
          updated_at,
          revision
        ) VALUES (?, ?, ?, NULL, ?, ?, 0)
      `).run(
        input.accountId,
        displayName,
        lifecycleStatus,
        now,
        now
      );
    } catch (error: unknown) {
      if (isAccountPrimaryKeyConflict(error)) {
        throw new AccountRepositoryError(
          "ACCOUNT_EXISTS",
          `Account ${input.accountId} already exists`,
          error
        );
      }
      throw error;
    }

    return this.require(input.accountId);
  }

  public get(accountId: string): AccountRecord | null {
    assertAccountId(accountId);
    const row = this.#database.prepare(`
      SELECT
        account_id,
        display_name,
        lifecycle_status,
        persona_uid,
        created_at,
        updated_at,
        revision
      FROM accounts
      WHERE account_id = ?
    `).get(accountId) as unknown as AccountRow | undefined;

    return parseAccount(row);
  }

  public require(accountId: string): AccountRecord {
    const account = this.get(accountId);
    if (account === null) {
      throw new AccountRepositoryError(
        "ACCOUNT_NOT_FOUND",
        `Account ${accountId} does not exist`
      );
    }
    return account;
  }

  public list(): readonly AccountRecord[] {
    const rows = this.#database.prepare(`
      SELECT
        account_id,
        display_name,
        lifecycle_status,
        persona_uid,
        created_at,
        updated_at,
        revision
      FROM accounts
      ORDER BY account_id
    `).all() as unknown as AccountRow[];

    return Object.freeze(rows.map((row) => {
      const parsed = parseAccount(row);
      if (parsed === null) {
        throw new AccountRepositoryError(
          "ACCOUNT_ROW_INVALID",
          "Stored Account metadata unexpectedly disappeared"
        );
      }
      return parsed;
    }));
  }
}
