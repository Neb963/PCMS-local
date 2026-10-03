import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import { PersonaBindingService } from "../../dist/accounts/persona-binding.js";
import { GeneratorRepository } from "../../dist/generators/generator-repository.js";
import {
  InventorySearchError,
  InventorySearchService
} from "../../dist/inventory/search.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database, {
    now: () => new Date("2026-10-03T11:20:00.000Z")
  });
  return { root, database };
}

async function cleanup(value) {
  value.database.close();
  await rm(value.root, { recursive: true, force: true });
}

function insertPersona(database, personaUid) {
  const now = "2026-10-03T11:21:00.000Z";
  database.prepare(`
    INSERT INTO personas (
      persona_uid,
      lifecycle_status,
      profile_state,
      browser_backend,
      profile_relative_path,
      profile_delete_state,
      profile_deleted_at,
      profile_backup_decision,
      created_at,
      updated_at,
      retired_at,
      revision
    ) VALUES (?, 'ACTIVE', 'CLOSED', 'chromium-v1', ?, 'PRESENT', NULL, NULL, ?, ?, NULL, 0)
  `).run(
    personaUid,
    `personas/${personaUid}/chromium`,
    now,
    now
  );
}

test("metadata search returns stable identity regardless of the matching display field", async () => {
  const f = await fixture("pcms-inventory-search-");
  try {
    insertPersona(f.database, "persona_primary");
    const accounts = new AccountRepository({
      database: f.database,
      now: () => new Date("2026-10-03T11:22:00.000Z")
    });
    accounts.create({
      accountId: "account_primary",
      displayName: "Moonlight Operator"
    });
    new PersonaBindingService({
      database: f.database,
      now: () => new Date("2026-10-03T11:23:00.000Z")
    }).bind({
      accountId: "account_primary",
      personaUid: "persona_primary",
      expectedRevision: 0,
      reason: "search fixture"
    });

    const generators = new GeneratorRepository({
      database: f.database,
      now: () => new Date("2026-10-03T11:24:00.000Z")
    });
    generators.create({
      generatorLocalId: "generator_alpha",
      accountId: "account_primary",
      providerStableId: "provider-123",
      currentSlug: "mutable-moon"
    });
    generators.create({
      generatorLocalId: "generator_beta",
      accountId: "account_primary",
      providerStableId: "provider-456",
      currentSlug: "mutable-moon"
    });

    const search = new InventorySearchService({ database: f.database });

    assert.deepEqual(search.search("Moonlight Operator"), [
      {
        entityType: "ACCOUNT",
        entityId: "account_primary",
        label: "Moonlight Operator",
        matchedField: "displayName",
        accountId: "account_primary",
        personaUid: "persona_primary"
      }
    ]);

    assert.deepEqual(search.search("persona_primary"), [
      {
        entityType: "PERSONA",
        entityId: "persona_primary",
        label: "persona_primary",
        matchedField: "personaUid",
        accountId: "account_primary",
        personaUid: "persona_primary"
      }
    ]);

    assert.deepEqual(
      search.search("mutable-moon").map((result) => ({
        entityId: result.entityId,
        matchedField: result.matchedField
      })),
      [
        { entityId: "generator_alpha", matchedField: "currentSlug" },
        { entityId: "generator_beta", matchedField: "currentSlug" }
      ]
    );

    assert.deepEqual(search.search("provider-456"), [
      {
        entityType: "GENERATOR",
        entityId: "generator_beta",
        label: "mutable-moon",
        matchedField: "providerStableId",
        accountId: "account_primary",
        personaUid: "persona_primary"
      }
    ]);
  } finally {
    await cleanup(f);
  }
});

test("search result identity survives mutable Generator slug changes", async () => {
  const f = await fixture("pcms-inventory-search-slug-");
  try {
    const accounts = new AccountRepository({
      database: f.database,
      now: () => new Date("2026-10-03T11:25:00.000Z")
    });
    accounts.create({
      accountId: "account_slug",
      displayName: "Slug account"
    });
    const generators = new GeneratorRepository({
      database: f.database,
      now: () => new Date("2026-10-03T11:26:00.000Z")
    });
    generators.create({
      generatorLocalId: "generator_stable",
      accountId: "account_slug",
      currentSlug: "old-display-slug"
    });

    const search = new InventorySearchService({ database: f.database });
    const before = search.search("old-display-slug");
    assert.equal(before[0]?.entityId, "generator_stable");

    generators.updateIdentity({
      generatorLocalId: "generator_stable",
      expectedRevision: 0,
      providerStableId: null,
      currentSlug: "new-display-slug"
    });

    assert.deepEqual(search.search("old-display-slug"), []);
    const after = search.search("new-display-slug");
    assert.equal(after[0]?.entityId, "generator_stable");
    assert.equal(after[0]?.matchedField, "currentSlug");
  } finally {
    await cleanup(f);
  }
});

test("search treats wildcard-looking input literally and bounds query/limit", async () => {
  const f = await fixture("pcms-inventory-search-literal-");
  try {
    const accounts = new AccountRepository({ database: f.database });
    accounts.create({
      accountId: "account_percent",
      displayName: "Percent % literal"
    });
    accounts.create({
      accountId: "account_plain",
      displayName: "Plain account"
    });
    const search = new InventorySearchService({ database: f.database });

    assert.deepEqual(
      search.search("%").map((result) => result.entityId),
      ["account_percent"]
    );
    assert.throws(
      () => search.search("   "),
      (error) =>
        error instanceof InventorySearchError &&
        error.code === "SEARCH_QUERY_INVALID"
    );
    assert.throws(
      () => search.search("account", { limit: 101 }),
      (error) =>
        error instanceof InventorySearchError &&
        error.code === "SEARCH_LIMIT_INVALID"
    );
  } finally {
    await cleanup(f);
  }
});
