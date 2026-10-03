import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BatchStore
} from "../../dist/batches/batch-store.js";
import {
  OperationCoordinator,
  generatorOperationTargetKey
} from "../../dist/operations/operation-coordinator.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-batch-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  const now = () => new Date("2026-10-03T16:00:00.000Z");
  const coordinator = new OperationCoordinator({ database, now });
  const batches = new BatchStore({
    database,
    coordinator,
    now
  });
  return { root, database, coordinator, batches, now };
}

function prepare(
  coordinator,
  operationId,
  targetSuffix
) {
  return coordinator.prepare({
    operationId,
    idempotencyKey: "request-" + operationId,
    owner: { kind: "CORE" },
    actorSource: "p029-batch-test",
    targetKey: generatorOperationTargetKey(targetSuffix),
    operationKind: "synthetic-batch-child",
    schemaVersion: 1,
    desiredFingerprint: "a".repeat(64),
    provenance: { source: "p029-batch-test" },
    preconditions: [{
      key: "provider-session",
      observedAt: "2026-10-03T16:00:00.000Z",
      maxAgeMs: 60_000,
      evidenceRef: "batch-session-" + targetSuffix
    }]
  });
}

function dispatch(coordinator, operation) {
  coordinator.authorizeDispatch({
    operationId: operation.operationId,
    expectedClaimEpoch: operation.claimEpoch,
    evidence: { step: "batch-child" }
  });
}

test("P029 batch children keep independent results and cancellation semantics", async () => {
  const f = await fixture();
  try {
    const succeeded = prepare(
      f.coordinator,
      "operation-batch-success",
      "generator-batch-success"
    );
    dispatch(f.coordinator, succeeded);
    f.coordinator.beginVerification(
      succeeded.operationId,
      succeeded.claimEpoch
    );
    f.coordinator.markSucceeded(
      succeeded.operationId,
      succeeded.claimEpoch
    );

    const failed = prepare(
      f.coordinator,
      "operation-batch-failed",
      "generator-batch-failed"
    );
    dispatch(f.coordinator, failed);
    f.coordinator.markFailedSafe(
      failed.operationId,
      failed.claimEpoch,
      "synthetic-safe-failure"
    );

    const prepared = prepare(
      f.coordinator,
      "operation-batch-prepared",
      "generator-batch-prepared"
    );

    const running = prepare(
      f.coordinator,
      "operation-batch-running",
      "generator-batch-running"
    );
    dispatch(f.coordinator, running);

    const created = f.batches.create({
      batchId: "batch-independent-results",
      actorSource: "operator",
      label: "Independent result fixture",
      operationIds: [
        succeeded.operationId,
        failed.operationId,
        prepared.operationId,
        running.operationId
      ]
    });

    assert.equal(created.status, "ACTIVE");
    assert.deepEqual(created.counts, {
      PREPARED: 1,
      RUNNING: 1,
      VERIFYING: 0,
      SUCCEEDED: 1,
      FAILED_SAFE: 1,
      UNCERTAIN: 0,
      CANCELLED: 0,
      NEEDS_HUMAN: 0
    });

    const cancellation = f.batches.requestCancellation(
      created.batchId
    );
    assert.equal(cancellation.attemptedChildren, 2);
    assert.equal(cancellation.errorChildren, 0);

    const after = cancellation.batch;
    assert.equal(after.status, "NEEDS_ATTENTION");
    assert.equal(
      f.coordinator.require(succeeded.operationId).state,
      "SUCCEEDED"
    );
    assert.equal(
      f.coordinator.require(failed.operationId).state,
      "FAILED_SAFE"
    );
    assert.equal(
      f.coordinator.require(prepared.operationId).state,
      "CANCELLED"
    );
    assert.equal(
      f.coordinator.require(running.operationId).state,
      "UNCERTAIN"
    );

    assert.deepEqual(
      after.children.map((child) => [
        child.operation.operationId,
        child.operation.state,
        child.cancellationOutcome
      ]),
      [
        [
          succeeded.operationId,
          "SUCCEEDED",
          "TERMINAL_UNCHANGED"
        ],
        [
          failed.operationId,
          "FAILED_SAFE",
          "TERMINAL_UNCHANGED"
        ],
        [
          prepared.operationId,
          "CANCELLED",
          "CANCELLED_CLEAN"
        ],
        [
          running.operationId,
          "UNCERTAIN",
          "UNCERTAIN"
        ]
      ]
    );

    f.coordinator.beginReconciliation(
      running.operationId,
      running.claimEpoch,
      "batch-test-reconciliation"
    );
    f.coordinator.markFailedSafe(
      running.operationId,
      running.claimEpoch,
      "batch-test-reconciled-failed-safe"
    );

    const terminal = f.batches.require(created.batchId);
    assert.equal(terminal.status, "COMPLETE");
    assert.equal(terminal.counts.SUCCEEDED, 1);
    assert.equal(terminal.counts.FAILED_SAFE, 2);
    assert.equal(terminal.counts.CANCELLED, 1);
    assert.equal(
      terminal.children[0]?.operation.operationId,
      succeeded.operationId
    );
    assert.equal(
      terminal.children[0]?.operation.state,
      "SUCCEEDED"
    );
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
