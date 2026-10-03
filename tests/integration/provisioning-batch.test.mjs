import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import {
  ProvisioningBatchError,
  ProvisioningBatchService
} from "../../dist/provisioning/batch.js";
import {
  PROVISIONING_OPERATION_KIND
} from "../../dist/provisioning/operation.js";
import {
  OperationCoordinator,
  accountOperationTargetKey
} from "../../dist/operations/operation-coordinator.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-provisioning-batch-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let tick = 0;
  const now = () =>
    new Date(Date.UTC(2026, 9, 4, 1, 0, tick++));
  const accounts = new AccountRepository({
    database,
    now
  });
  const coordinator = new OperationCoordinator({
    database,
    now
  });
  const batches = new ProvisioningBatchService({
    database,
    coordinator,
    now
  });
  return {
    root,
    database,
    accounts,
    coordinator,
    batches,
    now,
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function prepareProvisioning(
  f,
  suffix
) {
  const accountId = "account-" + suffix;
  const personaUid = "persona-" + suffix;
  const providerIdentity = suffix + "@example.test";
  const credentialRef = "secret:accounts/" + suffix;
  f.database.prepare(`
    INSERT INTO personas (
      persona_uid, lifecycle_status, profile_state, browser_backend,
      profile_relative_path, profile_delete_state, profile_deleted_at,
      profile_backup_decision, created_at, updated_at, retired_at, revision
    ) VALUES (?, 'ACTIVE', 'CLOSED', 'chromium-v1', ?, 'PRESENT',
      NULL, NULL, ?, ?, NULL, 0)
  `).run(
    personaUid,
    "personas/" + personaUid + "/chromium",
    f.now().toISOString(),
    f.now().toISOString()
  );
  f.accounts.create({
    accountId,
    displayName: "P040 " + suffix
  });
  const operation = f.coordinator.prepare({
    operationId: "operation-provisioning-" + suffix,
    idempotencyKey: "request-provisioning-" + suffix,
    owner: { kind: "CORE" },
    actorSource: "p040-provisioning-batch-test",
    targetKey: accountOperationTargetKey(accountId),
    operationKind: PROVISIONING_OPERATION_KIND,
    schemaVersion: 1,
    accountId,
    personaUid,
    desiredFingerprint: suffix[0].repeat(64),
    provenance: {
      source: "provisioning",
      expectedIdentity: providerIdentity,
      credentialRef
    },
    preconditions: [{
      key: "accountBinding",
      observedAt: "2026-10-04T01:00:00.000Z",
      maxAgeMs: 60_000,
      evidenceRef: "binding-" + suffix
    }]
  });
  return {
    operation,
    accountId,
    personaUid,
    providerIdentity,
    credentialRef
  };
}

function dispatch(f, operation) {
  f.coordinator.authorizeDispatch({
    operationId: operation.operationId,
    expectedClaimEpoch: operation.claimEpoch,
    evidence: {
      provider: "perchance",
      action: "signup"
    }
  });
}

test("P040 provisioning batch isolates per-account input state result and cancellation", async () => {
  const f = await fixture();
  try {
    const succeeded = prepareProvisioning(f, "a");
    const failed = prepareProvisioning(f, "b");
    const cancelled = prepareProvisioning(f, "c");
    const uncertain = prepareProvisioning(f, "d");

    dispatch(f, succeeded.operation);
    f.coordinator.beginVerification(
      succeeded.operation.operationId,
      succeeded.operation.claimEpoch
    );
    f.coordinator.markSucceeded(
      succeeded.operation.operationId,
      succeeded.operation.claimEpoch
    );

    dispatch(f, failed.operation);
    f.coordinator.markFailedSafe(
      failed.operation.operationId,
      failed.operation.claimEpoch,
      "synthetic-provider-rejection"
    );

    dispatch(f, uncertain.operation);

    const created = f.batches.create({
      batchId: "batch-provisioning-p040",
      actorSource: "operator",
      label: "P040 provisioning batch",
      operationIds: [
        succeeded.operation.operationId,
        failed.operation.operationId,
        cancelled.operation.operationId,
        uncertain.operation.operationId
      ]
    });

    assert.deepEqual(
      created.children.map((child) => ({
        accountId: child.input.accountId,
        personaUid: child.input.personaUid,
        providerIdentity: child.input.providerIdentity,
        credentialRef: child.input.credentialRef,
        state: child.state,
        result: child.result
      })),
      [
        {
          accountId: succeeded.accountId,
          personaUid: succeeded.personaUid,
          providerIdentity: succeeded.providerIdentity,
          credentialRef: succeeded.credentialRef,
          state: "SUCCEEDED",
          result: "SUCCEEDED"
        },
        {
          accountId: failed.accountId,
          personaUid: failed.personaUid,
          providerIdentity: failed.providerIdentity,
          credentialRef: failed.credentialRef,
          state: "FAILED_SAFE",
          result: "FAILED_SAFE"
        },
        {
          accountId: cancelled.accountId,
          personaUid: cancelled.personaUid,
          providerIdentity: cancelled.providerIdentity,
          credentialRef: cancelled.credentialRef,
          state: "PREPARED",
          result: null
        },
        {
          accountId: uncertain.accountId,
          personaUid: uncertain.personaUid,
          providerIdentity: uncertain.providerIdentity,
          credentialRef: uncertain.credentialRef,
          state: "RUNNING",
          result: null
        }
      ]
    );

    const afterSingle = f.batches.requestAccountCancellation(
      created.batchId,
      cancelled.accountId
    );
    assert.equal(
      afterSingle.children.find(
        (child) => child.input.accountId === cancelled.accountId
      )?.state,
      "CANCELLED"
    );
    assert.equal(
      afterSingle.children.find(
        (child) => child.input.accountId === succeeded.accountId
      )?.state,
      "SUCCEEDED"
    );
    assert.equal(
      afterSingle.children.find(
        (child) => child.input.accountId === failed.accountId
      )?.state,
      "FAILED_SAFE"
    );
    assert.equal(
      afterSingle.children.find(
        (child) => child.input.accountId === uncertain.accountId
      )?.state,
      "RUNNING"
    );

    const afterBatchCancel = f.batches.requestCancellation(
      created.batchId
    );
    assert.equal(
      afterBatchCancel.children.find(
        (child) => child.input.accountId === uncertain.accountId
      )?.state,
      "UNCERTAIN"
    );
    assert.equal(
      afterBatchCancel.children.find(
        (child) => child.input.accountId === cancelled.accountId
      )?.state,
      "CANCELLED"
    );
    assert.equal(
      afterBatchCancel.children.find(
        (child) => child.input.accountId === succeeded.accountId
      )?.state,
      "SUCCEEDED"
    );
    assert.equal(
      afterBatchCancel.children.find(
        (child) => child.input.accountId === failed.accountId
      )?.state,
      "FAILED_SAFE"
    );

    await assert.rejects(
      async () => f.batches.requestAccountCancellation(
        created.batchId,
        "account-not-in-batch"
      ),
      (error) =>
        error instanceof ProvisioningBatchError &&
        error.code === "PROVISIONING_BATCH_ACCOUNT_NOT_FOUND"
    );
  } finally {
    await f.cleanup();
  }
});

test("P040 provisioning batch rejects duplicate Account membership before durable batch creation", async () => {
  const f = await fixture();
  try {
    const first = prepareProvisioning(f, "e");
    f.database.prepare(`
      INSERT INTO personas (
        persona_uid, lifecycle_status, profile_state, browser_backend,
        profile_relative_path, profile_delete_state, profile_deleted_at,
        profile_backup_decision, created_at, updated_at, retired_at, revision
      ) VALUES (?, 'ACTIVE', 'CLOSED', 'chromium-v1', ?, 'PRESENT',
        NULL, NULL, ?, ?, NULL, 0)
    `).run(
      "persona-e-2",
      "personas/persona-e-2/chromium",
      f.now().toISOString(),
      f.now().toISOString()
    );
    const duplicate = f.coordinator.prepare({
      operationId: "operation-provisioning-e-duplicate",
      idempotencyKey: "request-provisioning-e-duplicate",
      owner: { kind: "CORE" },
      actorSource: "p040-provisioning-batch-test",
      targetKey: accountOperationTargetKey("account-e-other-target"),
      operationKind: PROVISIONING_OPERATION_KIND,
      schemaVersion: 1,
      accountId: first.accountId,
      personaUid: "persona-e-2",
      desiredFingerprint: "f".repeat(64),
      provenance: {
        source: "provisioning",
        expectedIdentity: "e-duplicate@example.test",
        credentialRef: "secret:accounts/e-duplicate"
      },
      preconditions: [{
        key: "accountBinding",
        observedAt: "2026-10-04T01:00:00.000Z",
        maxAgeMs: 60_000,
        evidenceRef: "binding-e-duplicate"
      }]
    });

    assert.throws(
      () => f.batches.create({
        batchId: "batch-provisioning-duplicate-account",
        actorSource: "operator",
        operationIds: [
          first.operation.operationId,
          duplicate.operationId
        ]
      }),
      (error) =>
        error instanceof ProvisioningBatchError &&
        error.code === "PROVISIONING_BATCH_DUPLICATE_ACCOUNT"
    );
    assert.equal(
      f.batches.get("batch-provisioning-duplicate-account"),
      null
    );
  } finally {
    await f.cleanup();
  }
});
