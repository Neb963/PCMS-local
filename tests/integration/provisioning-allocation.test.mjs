import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import { PersonaBindingService } from "../../dist/accounts/persona-binding.js";
import {
  ProvisioningAllocationError,
  ProvisioningAllocationService
} from "../../dist/provisioning/allocation.js";
import { ProvisioningStagingService } from "../../dist/provisioning/staging.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database, {
    now: () => new Date("2026-10-03T21:10:00.000Z")
  });
  const now = () => new Date("2026-10-03T21:11:00.000Z");
  return {
    root,
    database,
    accounts: new AccountRepository({ database, now }),
    bindings: new PersonaBindingService({ database, now }),
    staging: new ProvisioningStagingService({ database }),
    allocation: new ProvisioningAllocationService({
      database,
      personasRoot: join(root, "persona-data"),
      now
    })
  };
}

async function cleanup(value) {
  value.database.close();
  await rm(value.root, { recursive: true, force: true });
}

test("P038 allocates and binds a dedicated Persona while Account stays INACTIVE", async () => {
  const f = await fixture("pcms-p038-allocation-");
  try {
    const [staged] = f.staging.stageBatch([{
      accountId: "account_staged",
      displayName: "Staged Account",
      providerIdentity: "staged@example.test",
      credentialSecretRef: "secret:accounts/staged"
    }]);

    const result = await f.allocation.allocate(staged, "persona_staged");
    assert.equal(result.account.lifecycleStatus, "INACTIVE");
    assert.equal(result.account.personaUid, "persona_staged");
    assert.equal(result.persona.record.personaUid, "persona_staged");
    assert.equal(result.persona.record.lifecycleStatus, "ACTIVE");
    assert.equal(result.persona.record.profileState, "CLOSED");

    assert.deepEqual(
      f.bindings.listHistory("account_staged").map((event) => ({
        eventKind: event.eventKind,
        previousPersonaUid: event.previousPersonaUid,
        nextPersonaUid: event.nextPersonaUid
      })),
      [{
        eventKind: "BIND",
        previousPersonaUid: null,
        nextPersonaUid: "persona_staged"
      }]
    );

    const retried = await f.allocation.allocate(staged, "persona_staged");
    assert.equal(retried.account.personaUid, "persona_staged");
    assert.equal(f.bindings.listHistory("account_staged").length, 1);
  } finally {
    await cleanup(f);
  }
});

test("P038 provisioning refuses to share a dedicated Persona before creating the second Account", async () => {
  const f = await fixture("pcms-p038-allocation-conflict-");
  try {
    const [first, second] = f.staging.stageBatch([
      {
        accountId: "account_one",
        displayName: "One",
        providerIdentity: "one@example.test",
        credentialSecretRef: "secret:accounts/one"
      },
      {
        accountId: "account_two",
        displayName: "Two",
        providerIdentity: "two@example.test",
        credentialSecretRef: "secret:accounts/two"
      }
    ]);

    await f.allocation.allocate(first, "persona_dedicated");
    await assert.rejects(
      () => f.allocation.allocate(second, "persona_dedicated"),
      (error) =>
        error instanceof ProvisioningAllocationError &&
        error.code === "PROVISIONING_PERSONA_ALREADY_ALLOCATED"
    );

    assert.equal(f.accounts.get("account_two"), null);
    assert.equal(
      f.accounts.require("account_one").personaUid,
      "persona_dedicated"
    );
  } finally {
    await cleanup(f);
  }
});
