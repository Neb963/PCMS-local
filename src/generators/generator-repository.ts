import type { DatabaseSync } from "node:sqlite";

import { AccountRepository } from "../accounts/account-repository.js";

const SAFE_GENERATOR_LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_PROVIDER_STABLE_ID_LENGTH = 256;
const MAX_CURRENT_SLUG_LENGTH = 512;

export interface GeneratorRecord {
  readonly generatorLocalId: string;
  readonly accountId: string;
  readonly providerStableId: string | null;
  readonly currentSlug: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface CreateGeneratorInput {
  readonly generatorLocalId: string;
  readonly accountId: string;
  readonly providerStableId?: string | null;
  readonly currentSlug: string;
}

export interface GeneratorRepositoryOptions {
  readonly database: DatabaseSync;
  readonly now?: () => Date;
}

export type GeneratorRepositoryErrorCode =
  | "GENERATOR_LOCAL_ID_INVALID"
  | "GENERATOR_PROVIDER_ID_INVALID"
  | "GENERATOR_SLUG_INVALID"
  | "GENERATOR_EXISTS"
  | "GENERATOR_PROVIDER_ID_CONFLICT"
  | "GENERATOR_NOT_FOUND"
  | "GENERATOR_ROW_INVALID";

export class GeneratorRepositoryError extends Error {
  public constructor(
    public readonly code: GeneratorRepositoryErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GeneratorRepositoryError";
  }
}

interface GeneratorRow {
  readonly generator_local_id: unknown;
  readonly account_id: unknown;
  readonly provider_stable_id: unknown;
  readonly current_slug: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly revision: unknown;
}

function assertGeneratorLocalId(generatorLocalId: string): void {
  if (!SAFE_GENERATOR_LOCAL_ID.test(generatorLocalId)) {
    throw new GeneratorRepositoryError(
      "GENERATOR_LOCAL_ID_INVALID",
      "Generator local ID must be a safe opaque identifier using only letters, digits, underscore or hyphen"
    );
  }
}

function normalizeProviderStableId(
  providerStableId: string | null | undefined
): string | null {
  if (providerStableId === null || providerStableId === undefined) {
    return null;
  }
  const normalized = providerStableId.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PROVIDER_STABLE_ID_LENGTH
  ) {
    throw new GeneratorRepositoryError(
      "GENERATOR_PROVIDER_ID_INVALID",
      `Provider stable ID must contain 1-${MAX_PROVIDER_STABLE_ID_LENGTH} characters when known`
    );
  }
  return normalized;
}

function normalizeCurrentSlug(currentSlug: string): string {
  const normalized = currentSlug.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_CURRENT_SLUG_LENGTH
  ) {
    throw new GeneratorRepositoryError(
      "GENERATOR_SLUG_INVALID",
      `Current Generator slug must contain 1-${MAX_CURRENT_SLUG_LENGTH} characters`
    );
  }
  return normalized;
}

function parseGenerator(row: GeneratorRow | undefined): GeneratorRecord | null {
  if (row === undefined) {
    return null;
  }

  const {
    generator_local_id: generatorLocalId,
    account_id: accountId,
    provider_stable_id: providerStableId,
    current_slug: currentSlug,
    created_at: createdAt,
    updated_at: updatedAt,
    revision
  } = row;

  if (
    typeof generatorLocalId !== "string" ||
    typeof accountId !== "string" ||
    (providerStableId !== null && typeof providerStableId !== "string") ||
    typeof currentSlug !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new GeneratorRepositoryError(
      "GENERATOR_ROW_INVALID",
      "Stored Generator metadata is invalid"
    );
  }

  return Object.freeze({
    generatorLocalId,
    accountId,
    providerStableId,
    currentSlug,
    createdAt,
    updatedAt,
    revision
  });
}

function isLocalIdConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "UNIQUE constraint failed: generators.generator_local_id"
    )
  );
}

function isProviderStableIdConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "UNIQUE constraint failed: generators.provider_stable_id"
    )
  );
}

export class GeneratorRepository {
  readonly #database: DatabaseSync;
  readonly #accounts: AccountRepository;
  readonly #now: () => Date;

  public constructor(options: GeneratorRepositoryOptions) {
    this.#database = options.database;
    this.#accounts = new AccountRepository({ database: options.database });
    this.#now = options.now ?? (() => new Date());
  }

  public create(input: CreateGeneratorInput): GeneratorRecord {
    assertGeneratorLocalId(input.generatorLocalId);
    this.#accounts.require(input.accountId);
    const providerStableId = normalizeProviderStableId(input.providerStableId);
    const currentSlug = normalizeCurrentSlug(input.currentSlug);
    const now = this.#now().toISOString();

    try {
      this.#database.prepare(`
        INSERT INTO generators (
          generator_local_id,
          account_id,
          provider_stable_id,
          current_slug,
          created_at,
          updated_at,
          revision
        ) VALUES (?, ?, ?, ?, ?, ?, 0)
      `).run(
        input.generatorLocalId,
        input.accountId,
        providerStableId,
        currentSlug,
        now,
        now
      );
    } catch (error: unknown) {
      if (isLocalIdConflict(error)) {
        throw new GeneratorRepositoryError(
          "GENERATOR_EXISTS",
          `Generator ${input.generatorLocalId} already exists`,
          error
        );
      }
      if (isProviderStableIdConflict(error)) {
        throw new GeneratorRepositoryError(
          "GENERATOR_PROVIDER_ID_CONFLICT",
          `Provider stable ID ${providerStableId ?? "<unknown>"} is already assigned to another Generator`,
          error
        );
      }
      throw error;
    }

    return this.require(input.generatorLocalId);
  }

  public get(generatorLocalId: string): GeneratorRecord | null {
    assertGeneratorLocalId(generatorLocalId);
    const row = this.#database.prepare(`
      SELECT
        generator_local_id,
        account_id,
        provider_stable_id,
        current_slug,
        created_at,
        updated_at,
        revision
      FROM generators
      WHERE generator_local_id = ?
    `).get(generatorLocalId) as unknown as GeneratorRow | undefined;

    return parseGenerator(row);
  }

  public require(generatorLocalId: string): GeneratorRecord {
    const generator = this.get(generatorLocalId);
    if (generator === null) {
      throw new GeneratorRepositoryError(
        "GENERATOR_NOT_FOUND",
        `Generator ${generatorLocalId} does not exist`
      );
    }
    return generator;
  }

  public list(): readonly GeneratorRecord[] {
    const rows = this.#database.prepare(`
      SELECT
        generator_local_id,
        account_id,
        provider_stable_id,
        current_slug,
        created_at,
        updated_at,
        revision
      FROM generators
      ORDER BY generator_local_id
    `).all() as unknown as GeneratorRow[];

    return Object.freeze(rows.map((row) => {
      const parsed = parseGenerator(row);
      if (parsed === null) {
        throw new GeneratorRepositoryError(
          "GENERATOR_ROW_INVALID",
          "Stored Generator metadata unexpectedly disappeared"
        );
      }
      return parsed;
    }));
  }
}
