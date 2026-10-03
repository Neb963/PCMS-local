import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import {
  PersonaBindingError,
  PersonaBindingService
} from "../../dist/accounts/persona-binding.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database, {
    now: () => new Date("2026-10-03T09:40:00.000Z")
  });
  const accounts = new AccountRepository({
    database,
    now: () => new Date("2026-10-03T09:41:00.000Z")
  });
  const bindings = new PersonaBindingService({
    database,
    now: () => new Date("2026-10-03T09:42:00.000Z")
  });
  return { root, database, accounts, bindings };
}

async function cleanup(value) {
  value.database.close();
  await rm(value.root, { recursive: true, force: true });
}

function insertPersona(database, personaUid, lifecycleStatus = "ACTIVE") {
  const now = "2026-10-03T09:40:30.000Z";
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

test("active Account binds transactionally to one active dedicated Persona", async () => {
  const f = await fixture("pcms-binding-active-");
  try {
    insertPersona(f.database, "persona_alpha");
    f.accounts.create({ accountId: "account_alpha", displayName: "Alpha" });

    const bound = f.bindings.bind({
      accountId: "account_alpha",
      personaUid: "persona_alpha",
      expectedRevision: 0,
      reason: "Initial dedicated Persona allocation"
    });

    assert.equal(bound.personaUid, "persona_alpha");
    assert.equal(bound.revision, 1);

    const history = f.database.prepare(`
      SELECT
        event_kind,
        previous_persona_uid,
        next_persona_uid,
        reason,
        account_revision
      FROM persona_bindings_history
      WHERE account_id = ?
    `).all("account_alpha").map((row) => ({ ...row }));

    assert.deepEqual(history, [{
      event_kind: "BIND",
      previous_persona_uid: null,
      next_persona_uid: "persona_alpha",
      reason: "Initial dedicated Persona allocation",
      account_revision: 1
    }]);
  } finally {
    await cleanup(f);
  }
});

test("one active Persona cannot be bound to two ACTIVE Accounts", async () => {
  const f = await fixture("pcms-binding-unique-");
  try {
    insertPersona(f.database, "persona_shared");
    f.accounts.create({ accountId: "account_one", displayName: "One" });
    f.accounts.create({ accountId: "account_two", displayName: "Two" });

    f.bindings.bind({
      accountId: "account_one",
      personaUid: "persona_shared",
      expectedRevision: 0,
      reason: "Initial allocation"
    });

    assert.throws(
      () => f.bindings.bind({
        accountId: "account_two",
        personaUid: "persona_shared",
        expectedRevision: 0,
        reason: "Conflicting allocation"
      }),
      (error) =>
        error instanceof PersonaBindingError &&
        error.code === "PERSONA_ALREADY_BOUND"
    );

    assert.equal(f.accounts.require("account_two").personaUid, null);
    assert.equal(f.accounts.require("account_two").revision, 0);
    assert.equal(
      f.database.prepare(`
        SELECT count(*) AS count
        FROM persona_bindings_history
        WHERE account_id = 'account_two'
      `).get().count,
      0
    );
  } finally {
    await cleanup(f);
  }
});

test("SQLite partial uniqueness structurally rejects duplicate active bindings", async () => {
  const f = await fixture("pcms-binding-structural-");
  try {
    insertPersona(f.database, "persona_guarded");
    f.accounts.create({ accountId: "account_one", displayName: "One" });
    f.accounts.create({ accountId: "account_two", displayName: "Two" });

    f.database.prepare(
      "UPDATE accounts SET persona_uid = ? WHERE account_id = ?"
    ).run("persona_guarded", "account_one");

    assert.throws(
      () => f.database.prepare(
        "UPDATE accounts SET persona_uid = ? WHERE account_id = ?"
      ).run("persona_guarded", "account_two"),
      /UNIQUE constraint failed: accounts\.persona_uid/u
    );
  } finally {
    await cleanup(f);
  }
});

test("binding rejects inactive Accounts, retired Personas and stale revisions without partial history", async () => {
  const f = await fixture("pcms-binding-guards-");
  try {
    insertPersona(f.database, "persona_active");
    insertPersona(f.database, "persona_retired", "RETIRED");
    f.accounts.create({
      accountId: "account_inactive",
      displayName: "Inactive",
      lifecycleStatus: "INACTIVE"
    });
    f.accounts.create({ accountId: "account_active", displayName: "Active" });

    assert.throws(
      () => f.bindings.bind({
        accountId: "account_inactive",
        personaUid: "persona_active",
        expectedRevision: 0,
        reason: "Not allowed"
      }),
      (error) =>
        error instanceof PersonaBindingError &&
        error.code === "ACCOUNT_NOT_ACTIVE"
    );

    assert.throws(
      () => f.bindings.bind({
        accountId: "account_active",
        personaUid: "persona_retired",
        expectedRevision: 0,
        reason: "Not allowed"
      }),
      (error) =>
        error instanceof PersonaBindingError &&
        error.code === "PERSONA_NOT_ACTIVE"
    );

    assert.throws(
      () => f.bindings.bind({
        accountId: "account_active",
        personaUid: "persona_active",
        expectedRevision: 7,
        reason: "Stale caller"
      }),
      (error) =>
        error instanceof PersonaBindingError &&
        error.code === "ACCOUNT_REVISION_CONFLICT"
    );

    assert.equal(f.accounts.require("account_active").personaUid, null);
    assert.equal(
      f.database.prepare(
        "SELECT count(*) AS count FROM persona_bindings_history"
      ).get().count,
      0
    );
  } finally {
    await cleanup(f);
  }
});

test("repeating the same binding at the current revision is idempotent", async () => {
  const f = await fixture("pcms-binding-idempotent-");
  try {
    insertPersona(f.database, "persona_same");
    f.accounts.create({ accountId: "account_same", displayName: "Same" });

    const first = f.bindings.bind({
      accountId: "account_same",
      personaUid: "persona_same",
      expectedRevision: 0,
      reason: "Initial allocation"
    });
    const second = f.bindings.bind({
      accountId: "account_same",
      personaUid: "persona_same",
      expectedRevision: 1,
      reason: "Retry after acknowledged commit"
    });

    assert.deepEqual(second, first);
    assert.equal(
      f.database.prepare(
        "SELECT count(*) AS count FROM persona_bindings_history"
      ).get().count,
      1
    );
  } finally {
    await cleanup(f);
  }
});
