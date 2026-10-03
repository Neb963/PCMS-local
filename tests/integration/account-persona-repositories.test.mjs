import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AccountRepository,
  AccountRepositoryError
} from "../../dist/accounts/account-repository.js";
import { PersonaRepository } from "../../dist/personas/repository.js";
import { CORE_MIGRATIONS } from "../../dist/storage/core-migrations.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database, {
    now: () => new Date("2026-10-03T09:30:00.000Z")
  });
  return { root, database };
}

async function cleanup(value) {
  value.database.close();
  await rm(value.root, { recursive: true, force: true });
}

function insertPersona(database, personaUid, lifecycleStatus = "ACTIVE") {
  const now = "2026-10-03T09:31:00.000Z";
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
    ) VALUES (?, ?, 'CLOSED', 'chromium-v1', ?, 'PRESENT', NULL, NULL, ?, ?, ?, 0)
  `).run(
    personaUid,
    lifecycleStatus,
    `personas/${personaUid}/chromium`,
    now,
    now,
    lifecycleStatus === "RETIRED" ? now : null
  );
}

test("P021 inventory migration creates Account and append-only binding schema", async () => {
  const f = await fixture("pcms-account-schema-");
  try {
    assert.equal(CORE_MIGRATIONS.at(-1).id, "0007-account-persona-inventory");

    const objects = f.database.prepare(`
      SELECT type, name
      FROM sqlite_schema
      WHERE name IN (
        'accounts',
        'accounts_one_active_account_per_persona',
        'persona_bindings_history',
        'persona_bindings_history_append_only_update',
        'persona_bindings_history_append_only_delete'
      )
      ORDER BY name
    `).all().map((row) => ({ ...row }));

    assert.deepEqual(objects, [
      { type: "table", name: "accounts" },
      { type: "index", name: "accounts_one_active_account_per_persona" },
      { type: "table", name: "persona_bindings_history" },
      { type: "trigger", name: "persona_bindings_history_append_only_delete" },
      { type: "trigger", name: "persona_bindings_history_append_only_update" }
    ]);
  } finally {
    await cleanup(f);
  }
});

test("Account and Persona repositories expose stable domain identity without browser runtime identity", async () => {
  const f = await fixture("pcms-account-repositories-");
  try {
    insertPersona(f.database, "persona_001");
    insertPersona(f.database, "persona_retired", "RETIRED");

    const accounts = new AccountRepository({
      database: f.database,
      now: () => new Date("2026-10-03T09:32:00.000Z")
    });
    const personas = new PersonaRepository({ database: f.database });

    const created = accounts.create({
      accountId: "account_001",
      displayName: "  Primary account  "
    });
    accounts.create({
      accountId: "account_inactive",
      displayName: "Dormant",
      lifecycleStatus: "INACTIVE"
    });

    assert.deepEqual(created, {
      accountId: "account_001",
      displayName: "Primary account",
      lifecycleStatus: "ACTIVE",
      personaUid: null,
      createdAt: "2026-10-03T09:32:00.000Z",
      updatedAt: "2026-10-03T09:32:00.000Z",
      revision: 0
    });
    assert.deepEqual(accounts.list().map((account) => account.accountId), [
      "account_001",
      "account_inactive"
    ]);

    const persona = personas.get("persona_001");
    assert.equal(persona.personaUid, "persona_001");
    assert.equal(persona.lifecycleStatus, "ACTIVE");
    assert.equal(persona.browserBackend, "chromium-v1");
    assert.equal("pid" in persona, false);
    assert.equal("devtoolsPort" in persona, false);

    assert.deepEqual(personas.list().map((item) => item.personaUid), [
      "persona_001",
      "persona_retired"
    ]);
  } finally {
    await cleanup(f);
  }
});

test("Account repository rejects invalid identity, display metadata and duplicates", async () => {
  const f = await fixture("pcms-account-validation-");
  try {
    const accounts = new AccountRepository({ database: f.database });

    assert.throws(
      () => accounts.create({ accountId: "../escape", displayName: "bad" }),
      (error) =>
        error instanceof AccountRepositoryError &&
        error.code === "ACCOUNT_ID_INVALID"
    );
    assert.throws(
      () => accounts.create({ accountId: "account_empty", displayName: "   " }),
      (error) =>
        error instanceof AccountRepositoryError &&
        error.code === "ACCOUNT_DISPLAY_NAME_INVALID"
    );

    accounts.create({ accountId: "account_duplicate", displayName: "first" });
    assert.throws(
      () => accounts.create({ accountId: "account_duplicate", displayName: "second" }),
      (error) =>
        error instanceof AccountRepositoryError &&
        error.code === "ACCOUNT_EXISTS"
    );
  } finally {
    await cleanup(f);
  }
});
