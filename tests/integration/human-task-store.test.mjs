import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HumanTaskStore,
  HumanTaskStoreError
} from "../../dist/human-tasks/human-task-store.js";
import {
  OperationCoordinator,
  personaControlOperationTargetKey
} from "../../dist/operations/operation-coordinator.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-human-task-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let nowMs = Date.parse("2026-10-03T15:30:00.000Z");
  const now = () => new Date(nowMs);

  database.prepare(`
    INSERT INTO personas (
      persona_uid,
      lifecycle_status,
      profile_state,
      browser_backend,
      profile_relative_path,
      created_at,
      updated_at,
      revision
    ) VALUES (?, 'ACTIVE', 'CLOSED', 'chromium-v1', ?, ?, ?, 0)
  `).run(
    "persona-human-1",
    "personas/persona-human-1/chromium",
    now().toISOString(),
    now().toISOString()
  );

  const coordinator = new OperationCoordinator({ database, now });
  const operation = coordinator.prepare({
    operationId: "operation-human-1",
    idempotencyKey: "request-human-1",
    owner: { kind: "CORE" },
    actorSource: "p028-integration-test",
    targetKey: personaControlOperationTargetKey("persona-human-1"),
    operationKind: "provider-human-continuation",
    schemaVersion: 1,
    personaUid: "persona-human-1",
    desiredFingerprint: "e".repeat(64),
    provenance: { source: "human-task-test" },
    preconditions: [{
      key: "provider-session",
      observedAt: now().toISOString(),
      maxAgeMs: 60000,
      evidenceRef: "human-session-1"
    }]
  });
  coordinator.authorizeDispatch({
    operationId: operation.operationId,
    expectedClaimEpoch: operation.claimEpoch,
    evidence: { step: "challenge-probe" }
  });
  coordinator.beginVerification(
    operation.operationId,
    operation.claimEpoch
  );
  coordinator.markNeedsHuman(
    operation.operationId,
    operation.claimEpoch,
    "provider-challenge"
  );

  return {
    root,
    database,
    coordinator,
    operation,
    now,
    advance(ms) {
      nowMs += ms;
    }
  };
}

function createTask(store, operation, now) {
  return store.create({
    taskId: "human-task-1",
    taskType: "VERIFICATION_REQUIRED",
    personaUid: "persona-human-1",
    operationId: operation.operationId,
    title: "Verification required",
    explanation: "Enter the one-time verification value to continue.",
    requiredActionKind: "ENTER_VERIFICATION_CODE",
    continuation: {
      kind: "PROVIDER_CHALLENGE",
      version: 1,
      ref: "operation-human-1:challenge-1"
    },
    evidence: {
      challengeKind: "verification",
      provider: "perchance"
    },
    expiresAt: new Date(now().getTime() + 60_000).toISOString()
  });
}

test("P028 HumanTask persists while transient input is process-local, single-use and expiring", async () => {
  const f = await fixture();
  try {
    const firstStore = new HumanTaskStore({
      database: f.database,
      now: f.now
    });
    const task = createTask(firstStore, f.operation, f.now);
    assert.equal(task.status, "OPEN");
    assert.equal(task.operationId, f.operation.operationId);
    assert.equal(task.personaUid, "persona-human-1");

    const receipt = firstStore.submitTransientInput(
      task.taskId,
      "VERIFICATION_CODE",
      "synthetic-123456",
      5_000
    );
    assert.equal(
      receipt.expiresAt,
      "2026-10-03T15:30:05.000Z"
    );

    const persisted = f.database.prepare(`
      SELECT evidence_json, continuation_ref, title, explanation
      FROM human_tasks
      WHERE task_id = ?
    `).get(task.taskId);
    assert.equal(
      JSON.stringify(persisted).includes("synthetic-123456"),
      false
    );

    const restartedStore = new HumanTaskStore({
      database: f.database,
      now: f.now
    });
    assert.equal(restartedStore.require(task.taskId).status, "OPEN");
    assert.throws(
      () => restartedStore.consumeTransientInput(
        task.taskId,
        "VERIFICATION_CODE"
      ),
      (error) => {
        assert.ok(error instanceof HumanTaskStoreError);
        assert.equal(error.code, "HUMAN_INPUT_UNAVAILABLE");
        return true;
      }
    );

    firstStore.submitTransientInput(
      task.taskId,
      "VERIFICATION_CODE",
      "synthetic-654321",
      1_000
    );
    f.advance(1_001);
    assert.throws(
      () => firstStore.consumeTransientInput(
        task.taskId,
        "VERIFICATION_CODE"
      ),
      (error) => {
        assert.ok(error instanceof HumanTaskStoreError);
        assert.equal(error.code, "HUMAN_INPUT_UNAVAILABLE");
        return true;
      }
    );
    assert.equal(firstStore.require(task.taskId).status, "OPEN");

    firstStore.submitTransientInput(
      task.taskId,
      "VERIFICATION_CODE",
      "synthetic-final",
      5_000
    );
    assert.equal(
      firstStore.consumeTransientInput(
        task.taskId,
        "VERIFICATION_CODE"
      ),
      "synthetic-final"
    );
    assert.throws(
      () => firstStore.consumeTransientInput(
        task.taskId,
        "VERIFICATION_CODE"
      ),
      (error) => {
        assert.ok(error instanceof HumanTaskStoreError);
        assert.equal(error.code, "HUMAN_INPUT_UNAVAILABLE");
        return true;
      }
    );
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P028 durable task expiry is explicit and does not invent operation completion", async () => {
  const f = await fixture();
  try {
    const store = new HumanTaskStore({
      database: f.database,
      now: f.now
    });
    const task = createTask(store, f.operation, f.now);
    f.advance(60_001);
    assert.deepEqual(store.expireDue(), [task.taskId]);
    assert.equal(store.require(task.taskId).status, "EXPIRED");
    assert.equal(
      f.coordinator.require(f.operation.operationId).state,
      "NEEDS_HUMAN"
    );
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
