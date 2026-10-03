import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import {
  InventoryImportError,
  InventoryImportService
} from "../../dist/accounts/inventory-import.js";
import { GeneratorRepository } from "../../dist/generators/generator-repository.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database, {
    now: () => new Date("2026-10-03T10:30:00.000Z")
  });
  const now = () => new Date("2026-10-03T10:31:00.000Z");
  return {
    root,
    database,
    accounts: new AccountRepository({ database, now }),
    generators: new GeneratorRepository({ database, now }),
    importer: new InventoryImportService({ database, now })
  };
}

async function cleanup(value) {
  value.database.close();
  await rm(value.root, { recursive: true, force: true });
}

test("valid Account/Generator import applies the complete normalized batch atomically", async () => {
  const f = await fixture("pcms-inventory-import-valid-");
  try {
    f.accounts.create({ accountId: "account_existing", displayName: "Existing" });

    const result = f.importer.importBatch({
      accounts: [
        { accountId: "account_alpha", displayName: "  Alpha  " },
        {
          accountId: "account_beta",
          displayName: "Beta",
          lifecycleStatus: "INACTIVE"
        }
      ],
      generators: [
        {
          generatorLocalId: "generator_alpha",
          accountId: "account_alpha",
          providerStableId: " provider-alpha ",
          currentSlug: " alpha-slug "
        },
        {
          generatorLocalId: "generator_existing_owner",
          accountId: "account_existing",
          currentSlug: "existing-owner-slug"
        }
      ]
    });

    assert.deepEqual(result.accounts.map((item) => ({
      accountId: item.accountId,
      displayName: item.displayName,
      lifecycleStatus: item.lifecycleStatus
    })), [
      { accountId: "account_alpha", displayName: "Alpha", lifecycleStatus: "ACTIVE" },
      { accountId: "account_beta", displayName: "Beta", lifecycleStatus: "INACTIVE" }
    ]);
    assert.deepEqual(result.generators.map((item) => ({
      generatorLocalId: item.generatorLocalId,
      accountId: item.accountId,
      providerStableId: item.providerStableId,
      currentSlug: item.currentSlug
    })), [
      {
        generatorLocalId: "generator_alpha",
        accountId: "account_alpha",
        providerStableId: "provider-alpha",
        currentSlug: "alpha-slug"
      },
      {
        generatorLocalId: "generator_existing_owner",
        accountId: "account_existing",
        providerStableId: null,
        currentSlug: "existing-owner-slug"
      }
    ]);

    assert.deepEqual(
      f.accounts.list().map((item) => item.accountId),
      ["account_alpha", "account_beta", "account_existing"]
    );
    assert.deepEqual(
      f.generators.list().map((item) => item.generatorLocalId),
      ["generator_alpha", "generator_existing_owner"]
    );
  } finally {
    await cleanup(f);
  }
});

test("full-batch duplicate validation happens before any Account write", async () => {
  const f = await fixture("pcms-inventory-import-validate-first-");
  try {
    f.database.exec(`
      CREATE TRIGGER reject_any_import_account
      BEFORE INSERT ON accounts
      BEGIN
        SELECT RAISE(ABORT, 'account write should not start');
      END;
    `);

    assert.throws(
      () => f.importer.importBatch({
        accounts: [
          { accountId: "account_new", displayName: "New" }
        ],
        generators: [
          {
            generatorLocalId: "generator_one",
            accountId: "account_new",
            providerStableId: "provider-duplicate",
            currentSlug: "one"
          },
          {
            generatorLocalId: "generator_two",
            accountId: "account_new",
            providerStableId: "provider-duplicate",
            currentSlug: "two"
          }
        ]
      }),
      (error) =>
        error instanceof InventoryImportError &&
        error.code === "IMPORT_DUPLICATE_PROVIDER_ID"
    );

    assert.deepEqual(f.accounts.list(), []);
    assert.deepEqual(f.generators.list(), []);
  } finally {
    await cleanup(f);
  }
});

test("missing Account reference and existing identity conflicts reject without partial import", async () => {
  const f = await fixture("pcms-inventory-import-conflicts-");
  try {
    f.accounts.create({ accountId: "account_existing", displayName: "Existing" });
    f.generators.create({
      generatorLocalId: "generator_existing",
      accountId: "account_existing",
      providerStableId: "provider-existing",
      currentSlug: "existing"
    });

    assert.throws(
      () => f.importer.importBatch({
        accounts: [
          { accountId: "account_new", displayName: "New" }
        ],
        generators: [
          {
            generatorLocalId: "generator_missing_owner",
            accountId: "account_missing",
            currentSlug: "missing-owner"
          }
        ]
      }),
      (error) =>
        error instanceof InventoryImportError &&
        error.code === "IMPORT_ACCOUNT_NOT_FOUND"
    );
    assert.equal(f.accounts.get("account_new"), null);

    assert.throws(
      () => f.importer.importBatch({
        accounts: [
          { accountId: "account_other", displayName: "Other" }
        ],
        generators: [
          {
            generatorLocalId: "generator_other",
            accountId: "account_other",
            providerStableId: "provider-existing",
            currentSlug: "other"
          }
        ]
      }),
      (error) =>
        error instanceof InventoryImportError &&
        error.code === "IMPORT_PROVIDER_ID_CONFLICT"
    );

    assert.equal(f.accounts.get("account_other"), null);
    assert.equal(f.generators.get("generator_other"), null);
    assert.equal(f.accounts.list().length, 1);
    assert.equal(f.generators.list().length, 1);
  } finally {
    await cleanup(f);
  }
});

test("apply-time failure rolls back all Account and Generator rows in the import transaction", async () => {
  const f = await fixture("pcms-inventory-import-rollback-");
  try {
    f.database.exec(`
      CREATE TRIGGER fail_second_generator
      BEFORE INSERT ON generators
      WHEN NEW.generator_local_id = 'generator_fail'
      BEGIN
        SELECT RAISE(ABORT, 'injected Generator import failure');
      END;
    `);

    assert.throws(
      () => f.importer.importBatch({
        accounts: [
          { accountId: "account_one", displayName: "One" },
          { accountId: "account_two", displayName: "Two" }
        ],
        generators: [
          {
            generatorLocalId: "generator_ok",
            accountId: "account_one",
            providerStableId: "provider-ok",
            currentSlug: "ok"
          },
          {
            generatorLocalId: "generator_fail",
            accountId: "account_two",
            providerStableId: "provider-fail",
            currentSlug: "fail"
          }
        ]
      }),
      /injected Generator import failure/u
    );

    assert.deepEqual(f.accounts.list(), []);
    assert.deepEqual(f.generators.list(), []);
  } finally {
    await cleanup(f);
  }
});

test("duplicate local IDs are rejected as batch invariants without mutation", async () => {
  const f = await fixture("pcms-inventory-import-duplicates-");
  try {
    assert.throws(
      () => f.importer.importBatch({
        accounts: [
          { accountId: "account_duplicate", displayName: "One" },
          { accountId: "account_duplicate", displayName: "Two" }
        ],
        generators: []
      }),
      (error) =>
        error instanceof InventoryImportError &&
        error.code === "IMPORT_DUPLICATE_ACCOUNT_ID"
    );

    assert.throws(
      () => f.importer.importBatch({
        accounts: [
          { accountId: "account_owner", displayName: "Owner" }
        ],
        generators: [
          {
            generatorLocalId: "generator_duplicate",
            accountId: "account_owner",
            currentSlug: "one"
          },
          {
            generatorLocalId: "generator_duplicate",
            accountId: "account_owner",
            currentSlug: "two"
          }
        ]
      }),
      (error) =>
        error instanceof InventoryImportError &&
        error.code === "IMPORT_DUPLICATE_GENERATOR_ID"
    );

    assert.deepEqual(f.accounts.list(), []);
    assert.deepEqual(f.generators.list(), []);
  } finally {
    await cleanup(f);
  }
});
