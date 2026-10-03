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
    assert.deepEqual(f.bindings.listHistory("account_alpha").map((event) => ({
      eventKind: event.eventKind,
      previousPersonaUid: event.previousPersonaUid,
      nextPersonaUid: event.nextPersonaUid,
      reason: event.reason,
      accountRevision: event.accountRevision
    })), [{
      eventKind: "BIND",
      previousPersonaUid: null,
      nextPersonaUid: "persona_alpha",
      reason: "Initial dedicated Persona allocation",
      accountRevision: 1
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
    assert.deepEqual(f.bindings.listHistory("account_two"), []);
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
    assert.deepEqual(f.bindings.listHistory("account_active"), []);
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
    assert.equal(f.bindings.listHistory("account_same").length, 1);
  } finally {
    await cleanup(f);
  }
});

test("explicit rebind and unbind preserve understandable append-only history", async () => {
  const f = await fixture("pcms-binding-history-");
  try {
    insertPersona(f.database, "persona_original");
    insertPersona(f.database, "persona_replacement");
    f.accounts.create({ accountId: "account_history", displayName: "History" });

    f.bindings.bind({
      accountId: "account_history",
      personaUid: "persona_original",
      expectedRevision: 0,
      reason: "Initial allocation"
    });
    const rebound = f.bindings.rebind({
      accountId: "account_history",
      personaUid: "persona_replacement",
      expectedRevision: 1,
      reason: "Persona replacement after repair"
    });
    assert.equal(rebound.personaUid, "persona_replacement");
    assert.equal(rebound.revision, 2);

    const unbound = f.bindings.unbind({
      accountId: "account_history",
      expectedRevision: 2,
      reason: "Account recovery requires a fresh Persona"
    });
    assert.equal(unbound.personaUid, null);
    assert.equal(unbound.revision, 3);

    assert.deepEqual(f.bindings.listHistory("account_history").map((event) => ({
      eventKind: event.eventKind,
      previousPersonaUid: event.previousPersonaUid,
      nextPersonaUid: event.nextPersonaUid,
      reason: event.reason,
      accountRevision: event.accountRevision
    })), [
      {
        eventKind: "BIND",
        previousPersonaUid: null,
        nextPersonaUid: "persona_original",
        reason: "Initial allocation",
        accountRevision: 1
      },
      {
        eventKind: "REBIND",
        previousPersonaUid: "persona_original",
        nextPersonaUid: "persona_replacement",
        reason: "Persona replacement after repair",
        accountRevision: 2
      },
      {
        eventKind: "UNBIND",
        previousPersonaUid: "persona_replacement",
        nextPersonaUid: null,
        reason: "Account recovery requires a fresh Persona",
        accountRevision: 3
      }
    ]);
  } finally {
    await cleanup(f);
  }
});

test("rebind conflict leaves original binding, revision and history unchanged", async () => {
  const f = await fixture("pcms-rebind-conflict-");
  try {
    insertPersona(f.database, "persona_one");
    insertPersona(f.database, "persona_two");
    f.accounts.create({ accountId: "account_one", displayName: "One" });
    f.accounts.create({ accountId: "account_two", displayName: "Two" });

    f.bindings.bind({
      accountId: "account_one",
      personaUid: "persona_one",
      expectedRevision: 0,
      reason: "One allocation"
    });
    f.bindings.bind({
      accountId: "account_two",
      personaUid: "persona_two",
      expectedRevision: 0,
      reason: "Two allocation"
    });

    assert.throws(
      () => f.bindings.rebind({
        accountId: "account_one",
        personaUid: "persona_two",
        expectedRevision: 1,
        reason: "Conflicting replacement"
      }),
      (error) =>
        error instanceof PersonaBindingError &&
        error.code === "PERSONA_ALREADY_BOUND"
    );

    const unchanged = f.accounts.require("account_one");
    assert.equal(unchanged.personaUid, "persona_one");
    assert.equal(unchanged.revision, 1);
    assert.equal(f.bindings.listHistory("account_one").length, 1);
  } finally {
    await cleanup(f);
  }
});

test("rebind history failure rolls back the Account mutation atomically", async () => {
  const f = await fixture("pcms-rebind-rollback-");
  try {
    insertPersona(f.database, "persona_before");
    insertPersona(f.database, "persona_after");
    f.accounts.create({ accountId: "account_rollback", displayName: "Rollback" });
    f.bindings.bind({
      accountId: "account_rollback",
      personaUid: "persona_before",
      expectedRevision: 0,
      reason: "Initial allocation"
    });

    f.database.exec(`
      CREATE TRIGGER fail_rebind_history
      BEFORE INSERT ON persona_bindings_history
      WHEN NEW.event_kind = 'REBIND'
      BEGIN
        SELECT RAISE(ABORT, 'injected rebind history failure');
      END;
    `);

    assert.throws(
      () => f.bindings.rebind({
        accountId: "account_rollback",
        personaUid: "persona_after",
        expectedRevision: 1,
        reason: "Injected rollback check"
      }),
      /injected rebind history failure/u
    );

    const unchanged = f.accounts.require("account_rollback");
    assert.equal(unchanged.personaUid, "persona_before");
    assert.equal(unchanged.revision, 1);
    assert.equal(f.bindings.listHistory("account_rollback").length, 1);
  } finally {
    await cleanup(f);
  }
});

test("binding history rejects update and delete mutation", async () => {
  const f = await fixture("pcms-binding-append-only-");
  try {
    insertPersona(f.database, "persona_immutable");
    f.accounts.create({ accountId: "account_immutable", displayName: "Immutable" });
    f.bindings.bind({
      accountId: "account_immutable",
      personaUid: "persona_immutable",
      expectedRevision: 0,
      reason: "Immutable audit event"
    });

    assert.throws(
      () => f.database.prepare(
        "UPDATE persona_bindings_history SET reason = 'tampered'"
      ).run(),
      /persona binding history is append-only/u
    );
    assert.throws(
      () => f.database.prepare(
        "DELETE FROM persona_bindings_history"
      ).run(),
      /persona binding history is append-only/u
    );
    assert.equal(
      f.bindings.listHistory("account_immutable")[0].reason,
      "Immutable audit event"
    );
  } finally {
    await cleanup(f);
  }
});
