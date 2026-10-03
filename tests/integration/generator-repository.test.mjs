import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import {
  GeneratorRepository,
  GeneratorRepositoryError
} from "../../dist/generators/generator-repository.js";
import { CORE_MIGRATIONS } from "../../dist/storage/core-migrations.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database, {
    now: () => new Date("2026-10-03T10:20:00.000Z")
  });
  const accounts = new AccountRepository({
    database,
    now: () => new Date("2026-10-03T10:21:00.000Z")
  });
  const generators = new GeneratorRepository({
    database,
    now: () => new Date("2026-10-03T10:22:00.000Z")
  });
  return { root, database, accounts, generators };
}

async function cleanup(value) {
  value.database.close();
  await rm(value.root, { recursive: true, force: true });
}

test("P022 migration creates stable Generator identity schema", async () => {
  const f = await fixture("pcms-generator-schema-");
  try {
    assert.ok(
      CORE_MIGRATIONS.some((migration) =>
        migration.id === "0008-generator-identity"
      )
    );

    const objects = f.database.prepare(`
      SELECT type, name
      FROM sqlite_schema
      WHERE name IN (
        'generators',
        'generators_provider_stable_id_unique',
        'generators_account_lookup',
        'generators_current_slug_lookup'
      )
      ORDER BY name
    `).all().map((row) => ({ ...row }));

    assert.deepEqual(objects, [
      { type: "table", name: "generators" },
      { type: "index", name: "generators_account_lookup" },
      { type: "index", name: "generators_current_slug_lookup" },
      { type: "index", name: "generators_provider_stable_id_unique" }
    ]);
  } finally {
    await cleanup(f);
  }
});

test("Generator local identity is independent of mutable slug metadata", async () => {
  const f = await fixture("pcms-generator-identity-");
  try {
    f.accounts.create({ accountId: "account_one", displayName: "One" });

    const first = f.generators.create({
      generatorLocalId: "generator_one",
      accountId: "account_one",
      providerStableId: "provider-123",
      currentSlug: "  mutable-slug  "
    });
    const second = f.generators.create({
      generatorLocalId: "generator_two",
      accountId: "account_one",
      currentSlug: "mutable-slug"
    });

    assert.deepEqual(first, {
      generatorLocalId: "generator_one",
      accountId: "account_one",
      providerStableId: "provider-123",
      currentSlug: "mutable-slug",
      createdAt: "2026-10-03T10:22:00.000Z",
      updatedAt: "2026-10-03T10:22:00.000Z",
      revision: 0
    });
    assert.equal(second.generatorLocalId, "generator_two");
    assert.equal(second.providerStableId, null);
    assert.deepEqual(
      f.generators.list().map((generator) => generator.generatorLocalId),
      ["generator_one", "generator_two"]
    );
  } finally {
    await cleanup(f);
  }
});

test("known provider stable ID uniqueness is enforced by repository and SQLite", async () => {
  const f = await fixture("pcms-generator-provider-id-");
  try {
    f.accounts.create({ accountId: "account_one", displayName: "One" });
    f.accounts.create({ accountId: "account_two", displayName: "Two" });
    f.generators.create({
      generatorLocalId: "generator_one",
      accountId: "account_one",
      providerStableId: "provider-shared",
      currentSlug: "first-slug"
    });

    assert.throws(
      () => f.generators.create({
        generatorLocalId: "generator_two",
        accountId: "account_two",
        providerStableId: "provider-shared",
        currentSlug: "second-slug"
      }),
      (error) =>
        error instanceof GeneratorRepositoryError &&
        error.code === "GENERATOR_PROVIDER_ID_CONFLICT"
    );

    assert.throws(
      () => f.database.prepare(`
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
        "generator_direct",
        "account_two",
        "provider-shared",
        "direct-slug",
        "2026-10-03T10:23:00.000Z",
        "2026-10-03T10:23:00.000Z"
      ),
      /UNIQUE constraint failed: generators\.provider_stable_id/u
    );

    assert.equal(f.generators.get("generator_two"), null);
    assert.equal(f.generators.list().length, 1);
  } finally {
    await cleanup(f);
  }
});

test("Generator repository validates local identity, provider ID, slug and Account ownership", async () => {
  const f = await fixture("pcms-generator-validation-");
  try {
    f.accounts.create({ accountId: "account_one", displayName: "One" });

    assert.throws(
      () => f.generators.create({
        generatorLocalId: "../escape",
        accountId: "account_one",
        currentSlug: "valid"
      }),
      (error) =>
        error instanceof GeneratorRepositoryError &&
        error.code === "GENERATOR_LOCAL_ID_INVALID"
    );
    assert.throws(
      () => f.generators.create({
        generatorLocalId: "generator_empty_slug",
        accountId: "account_one",
        currentSlug: "   "
      }),
      (error) =>
        error instanceof GeneratorRepositoryError &&
        error.code === "GENERATOR_SLUG_INVALID"
    );
    assert.throws(
      () => f.generators.create({
        generatorLocalId: "generator_empty_provider",
        accountId: "account_one",
        providerStableId: "   ",
        currentSlug: "valid"
      }),
      (error) =>
        error instanceof GeneratorRepositoryError &&
        error.code === "GENERATOR_PROVIDER_ID_INVALID"
    );
    assert.throws(
      () => f.generators.create({
        generatorLocalId: "generator_missing_owner",
        accountId: "missing_account",
        currentSlug: "valid"
      }),
      /Account missing_account does not exist/u
    );

    f.generators.create({
      generatorLocalId: "generator_duplicate",
      accountId: "account_one",
      currentSlug: "first"
    });
    assert.throws(
      () => f.generators.create({
        generatorLocalId: "generator_duplicate",
        accountId: "account_one",
        currentSlug: "second"
      }),
      (error) =>
        error instanceof GeneratorRepositoryError &&
        error.code === "GENERATOR_EXISTS"
    );
  } finally {
    await cleanup(f);
  }
});


test("slug and provider identity updates preserve Generator local identity and Account ownership", async () => {
  const f = await fixture("pcms-generator-update-");
  try {
    f.accounts.create({ accountId: "account_owner", displayName: "Owner" });
    const created = f.generators.create({
      generatorLocalId: "generator_stable",
      accountId: "account_owner",
      currentSlug: "old-slug"
    });

    const learned = f.generators.updateIdentity({
      generatorLocalId: "generator_stable",
      expectedRevision: created.revision,
      providerStableId: "provider-stable-777",
      currentSlug: "new-slug"
    });

    assert.equal(learned.generatorLocalId, "generator_stable");
    assert.equal(learned.accountId, "account_owner");
    assert.equal(learned.providerStableId, "provider-stable-777");
    assert.equal(learned.currentSlug, "new-slug");
    assert.equal(learned.revision, 1);
    assert.equal(learned.createdAt, created.createdAt);

    const renamed = f.generators.updateIdentity({
      generatorLocalId: "generator_stable",
      expectedRevision: 1,
      providerStableId: "provider-stable-777",
      currentSlug: "renamed-again"
    });
    assert.equal(renamed.generatorLocalId, "generator_stable");
    assert.equal(renamed.accountId, "account_owner");
    assert.equal(renamed.providerStableId, "provider-stable-777");
    assert.equal(renamed.currentSlug, "renamed-again");
    assert.equal(renamed.revision, 2);
  } finally {
    await cleanup(f);
  }
});

test("Generator identity update is idempotent at the current revision", async () => {
  const f = await fixture("pcms-generator-update-idempotent-");
  try {
    f.accounts.create({ accountId: "account_owner", displayName: "Owner" });
    const created = f.generators.create({
      generatorLocalId: "generator_same",
      accountId: "account_owner",
      providerStableId: "provider-same",
      currentSlug: "same-slug"
    });

    const repeated = f.generators.updateIdentity({
      generatorLocalId: "generator_same",
      expectedRevision: 0,
      providerStableId: "provider-same",
      currentSlug: "same-slug"
    });

    assert.deepEqual(repeated, created);
    assert.equal(f.generators.require("generator_same").revision, 0);
  } finally {
    await cleanup(f);
  }
});

test("stale Generator revision rejects slug/provider update without mutation", async () => {
  const f = await fixture("pcms-generator-update-stale-");
  try {
    f.accounts.create({ accountId: "account_owner", displayName: "Owner" });
    f.generators.create({
      generatorLocalId: "generator_revision",
      accountId: "account_owner",
      currentSlug: "initial"
    });
    f.generators.updateIdentity({
      generatorLocalId: "generator_revision",
      expectedRevision: 0,
      providerStableId: "provider-revision",
      currentSlug: "current"
    });

    assert.throws(
      () => f.generators.updateIdentity({
        generatorLocalId: "generator_revision",
        expectedRevision: 0,
        providerStableId: "provider-stale",
        currentSlug: "stale"
      }),
      (error) =>
        error instanceof GeneratorRepositoryError &&
        error.code === "GENERATOR_REVISION_CONFLICT"
    );

    const unchanged = f.generators.require("generator_revision");
    assert.equal(unchanged.providerStableId, "provider-revision");
    assert.equal(unchanged.currentSlug, "current");
    assert.equal(unchanged.revision, 1);
  } finally {
    await cleanup(f);
  }
});

test("provider stable ID conflict during update leaves Generator identity unchanged", async () => {
  const f = await fixture("pcms-generator-update-conflict-");
  try {
    f.accounts.create({ accountId: "account_owner", displayName: "Owner" });
    f.generators.create({
      generatorLocalId: "generator_one",
      accountId: "account_owner",
      providerStableId: "provider-one",
      currentSlug: "one"
    });
    f.generators.create({
      generatorLocalId: "generator_two",
      accountId: "account_owner",
      providerStableId: "provider-two",
      currentSlug: "two"
    });

    assert.throws(
      () => f.generators.updateIdentity({
        generatorLocalId: "generator_two",
        expectedRevision: 0,
        providerStableId: "provider-one",
        currentSlug: "two-renamed"
      }),
      (error) =>
        error instanceof GeneratorRepositoryError &&
        error.code === "GENERATOR_PROVIDER_ID_CONFLICT"
    );

    const unchanged = f.generators.require("generator_two");
    assert.equal(unchanged.generatorLocalId, "generator_two");
    assert.equal(unchanged.providerStableId, "provider-two");
    assert.equal(unchanged.currentSlug, "two");
    assert.equal(unchanged.revision, 0);
  } finally {
    await cleanup(f);
  }
});
