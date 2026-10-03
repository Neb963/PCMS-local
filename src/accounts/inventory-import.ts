import type { DatabaseSync } from "node:sqlite";

import {
  AccountRepository,
  prepareCreateAccountInput,
  type AccountRecord,
  type CreateAccountInput,
  type PreparedCreateAccountInput
} from "./account-repository.js";
import {
  GeneratorRepository,
  prepareCreateGeneratorInput,
  type CreateGeneratorInput,
  type GeneratorRecord,
  type PreparedCreateGeneratorInput
} from "../generators/generator-repository.js";

export interface InventoryImportBatch {
  readonly accounts: readonly CreateAccountInput[];
  readonly generators: readonly CreateGeneratorInput[];
}

export interface InventoryImportResult {
  readonly accounts: readonly AccountRecord[];
  readonly generators: readonly GeneratorRecord[];
}

export interface InventoryImportServiceOptions {
  readonly database: DatabaseSync;
  readonly now?: () => Date;
}

export type InventoryImportErrorCode =
  | "IMPORT_DUPLICATE_ACCOUNT_ID"
  | "IMPORT_DUPLICATE_GENERATOR_ID"
  | "IMPORT_DUPLICATE_PROVIDER_ID"
  | "IMPORT_ACCOUNT_EXISTS"
  | "IMPORT_GENERATOR_EXISTS"
  | "IMPORT_PROVIDER_ID_CONFLICT"
  | "IMPORT_ACCOUNT_NOT_FOUND";

export class InventoryImportError extends Error {
  public constructor(
    public readonly code: InventoryImportErrorCode,
    message: string
  ) {
    super(message);
    this.name = "InventoryImportError";
  }
}

interface PreparedInventoryImport {
  readonly accounts: readonly PreparedCreateAccountInput[];
  readonly generators: readonly PreparedCreateGeneratorInput[];
}

interface ExistingGeneratorRow {
  readonly generator_local_id: unknown;
  readonly provider_stable_id: unknown;
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

function assertUniqueBatchIdentity(plan: PreparedInventoryImport): void {
  const accountIds = new Set<string>();
  for (const account of plan.accounts) {
    if (accountIds.has(account.accountId)) {
      throw new InventoryImportError(
        "IMPORT_DUPLICATE_ACCOUNT_ID",
        `Import contains duplicate Account ID ${account.accountId}`
      );
    }
    accountIds.add(account.accountId);
  }

  const generatorIds = new Set<string>();
  const providerIds = new Set<string>();
  for (const generator of plan.generators) {
    if (generatorIds.has(generator.generatorLocalId)) {
      throw new InventoryImportError(
        "IMPORT_DUPLICATE_GENERATOR_ID",
        `Import contains duplicate Generator local ID ${generator.generatorLocalId}`
      );
    }
    generatorIds.add(generator.generatorLocalId);

    if (generator.providerStableId !== null) {
      if (providerIds.has(generator.providerStableId)) {
        throw new InventoryImportError(
          "IMPORT_DUPLICATE_PROVIDER_ID",
          `Import contains duplicate provider stable ID ${generator.providerStableId}`
        );
      }
      providerIds.add(generator.providerStableId);
    }
  }
}

function existingAccountIds(database: DatabaseSync): ReadonlySet<string> {
  const rows = database.prepare("SELECT account_id FROM accounts").all();
  const ids = new Set<string>();
  for (const row of rows) {
    const accountId = row["account_id"];
    if (typeof accountId !== "string") {
      throw new Error("Stored Account ID is invalid");
    }
    ids.add(accountId);
  }
  return ids;
}

function existingGeneratorIdentity(database: DatabaseSync): {
  readonly generatorIds: ReadonlySet<string>;
  readonly providerIds: ReadonlySet<string>;
} {
  const rows = database.prepare(`
    SELECT generator_local_id, provider_stable_id
    FROM generators
  `).all() as unknown as ExistingGeneratorRow[];
  const generatorIds = new Set<string>();
  const providerIds = new Set<string>();

  for (const row of rows) {
    if (typeof row.generator_local_id !== "string") {
      throw new Error("Stored Generator local ID is invalid");
    }
    generatorIds.add(row.generator_local_id);
    if (row.provider_stable_id !== null) {
      if (typeof row.provider_stable_id !== "string") {
        throw new Error("Stored Generator provider stable ID is invalid");
      }
      providerIds.add(row.provider_stable_id);
    }
  }
  return Object.freeze({ generatorIds, providerIds });
}

function assertDatabaseCompatibility(
  database: DatabaseSync,
  plan: PreparedInventoryImport
): void {
  const currentAccountIds = existingAccountIds(database);
  const importedAccountIds = new Set(plan.accounts.map((account) => account.accountId));
  const currentGenerators = existingGeneratorIdentity(database);

  for (const account of plan.accounts) {
    if (currentAccountIds.has(account.accountId)) {
      throw new InventoryImportError(
        "IMPORT_ACCOUNT_EXISTS",
        `Account ${account.accountId} already exists`
      );
    }
  }

  for (const generator of plan.generators) {
    if (currentGenerators.generatorIds.has(generator.generatorLocalId)) {
      throw new InventoryImportError(
        "IMPORT_GENERATOR_EXISTS",
        `Generator ${generator.generatorLocalId} already exists`
      );
    }
    if (
      generator.providerStableId !== null &&
      currentGenerators.providerIds.has(generator.providerStableId)
    ) {
      throw new InventoryImportError(
        "IMPORT_PROVIDER_ID_CONFLICT",
        `Provider stable ID ${generator.providerStableId} already belongs to a managed Generator`
      );
    }
    if (
      !currentAccountIds.has(generator.accountId) &&
      !importedAccountIds.has(generator.accountId)
    ) {
      throw new InventoryImportError(
        "IMPORT_ACCOUNT_NOT_FOUND",
        `Generator ${generator.generatorLocalId} references missing Account ${generator.accountId}`
      );
    }
  }
}

function prepareBatch(batch: InventoryImportBatch): PreparedInventoryImport {
  const plan = Object.freeze({
    accounts: Object.freeze(batch.accounts.map(prepareCreateAccountInput)),
    generators: Object.freeze(batch.generators.map(prepareCreateGeneratorInput))
  });
  assertUniqueBatchIdentity(plan);
  return plan;
}

export class InventoryImportService {
  readonly #database: DatabaseSync;
  readonly #accounts: AccountRepository;
  readonly #generators: GeneratorRepository;

  public constructor(options: InventoryImportServiceOptions) {
    this.#database = options.database;
    const sharedOptions = {
      database: options.database,
      ...(options.now === undefined ? {} : { now: options.now })
    };
    this.#accounts = new AccountRepository(sharedOptions);
    this.#generators = new GeneratorRepository(sharedOptions);
  }

  public importBatch(batch: InventoryImportBatch): InventoryImportResult {
    // Pure/batch validation is complete before any write transaction begins.
    const plan = prepareBatch(batch);
    assertDatabaseCompatibility(this.#database, plan);

    return transaction(this.#database, () => {
      // Revalidate after taking the write lock so no stale preflight can be applied.
      assertDatabaseCompatibility(this.#database, plan);

      const accounts = plan.accounts.map((account) =>
        this.#accounts.create(account)
      );
      const generators = plan.generators.map((generator) =>
        this.#generators.create(generator)
      );

      return Object.freeze({
        accounts: Object.freeze(accounts),
        generators: Object.freeze(generators)
      });
    });
  }
}
