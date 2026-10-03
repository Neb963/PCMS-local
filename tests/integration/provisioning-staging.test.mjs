import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import {
  ProvisioningStagingError,
  ProvisioningStagingService
} from "../../dist/provisioning/staging.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database, {
    now: () => new Date("2026-10-03T21:00:00.000Z")
  });
  return {
    root,
    database,
    accounts: new AccountRepository({ database }),
    staging: new ProvisioningStagingService({ database })
  };
}

async function cleanup(value) {
  value.database.close();
  await rm(value.root, { recursive: true, force: true });
}

test("P038 provisioning validates the full staged batch before Account side effects", async () => {
  const f = await fixture("pcms-p038-stage-batch-");
  try {
    f.database.exec(`
      CREATE TRIGGER reject_any_provisioning_account
      BEFORE INSERT ON accounts
      BEGIN
        SELECT RAISE(ABORT, 'staging must not write Accounts');
      END;
    `);

    assert.throws(
      () => f.staging.stageBatch([
        {
          accountId: "account_alpha",
          displayName: "Alpha",
          providerIdentity: "Operator@Example.test",
          credentialSecretRef: "secret:accounts/alpha"
        },
        {
          accountId: "account_beta",
          displayName: "Beta",
          providerIdentity: "operator@example.test",
          credentialSecretRef: "secret:accounts/beta"
        }
      ]),
      (error) =>
        error instanceof ProvisioningStagingError &&
        error.code === "PROVISIONING_DUPLICATE_PROVIDER_IDENTITY"
    );

    assert.equal(f.accounts.list().length, 0);
    assert.equal(f.staging.list().length, 0);
  } finally {
    await cleanup(f);
  }
});

test("P038 staging rejects existing and previously staged identities before allocation", async () => {
  const f = await fixture("pcms-p038-stage-conflicts-");
  try {
    f.accounts.create({
      accountId: "account_existing",
      displayName: "Existing",
      lifecycleStatus: "INACTIVE"
    });

    assert.throws(
      () => f.staging.stageBatch([{
        accountId: "account_existing",
        displayName: "Replacement",
        providerIdentity: "replacement@example.test",
        credentialSecretRef: "secret:accounts/replacement"
      }]),
      (error) =>
        error instanceof ProvisioningStagingError &&
        error.code === "PROVISIONING_ACCOUNT_EXISTS"
    );

    const [staged] = f.staging.stageBatch([{
      accountId: "account_new",
      displayName: "  New Account  ",
      providerIdentity: " New.User@Example.test ",
      credentialSecretRef: " secret:accounts/new "
    }]);
    assert.deepEqual(staged, {
      accountId: "account_new",
      displayName: "New Account",
      providerIdentity: "New.User@Example.test",
      providerIdentityKey: "new.user@example.test",
      credentialSecretRef: "secret:accounts/new",
      lifecycleStatus: "INACTIVE"
    });

    assert.throws(
      () => f.staging.stageBatch([{
        accountId: "account_other",
        displayName: "Other",
        providerIdentity: "NEW.USER@example.test",
        credentialSecretRef: "secret:accounts/other"
      }]),
      (error) =>
        error instanceof ProvisioningStagingError &&
        error.code === "PROVISIONING_DUPLICATE_PROVIDER_IDENTITY"
    );

    assert.equal(f.staging.list().length, 1);
    assert.equal(f.accounts.list().length, 1);
  } finally {
    await cleanup(f);
  }
});
