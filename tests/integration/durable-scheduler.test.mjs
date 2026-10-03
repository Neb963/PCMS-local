import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OperationCoordinator,
  generatorOperationTargetKey
} from "../../dist/operations/operation-coordinator.js";
import {
  BoundedWorkQueue
} from "../../dist/scheduler/work-queue.js";
import {
  DurableScheduler
} from "../../dist/scheduler/durable-scheduler.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(capacity = 4) {
  const root = await mkdtemp(join(tmpdir(), "pcms-scheduler-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let nowMs = Date.parse("2026-10-03T16:30:00.000Z");
  let dispatchSequence = 0;
  const now = () => new Date(nowMs);
  const queue = new BoundedWorkQueue(capacity);
  const scheduler = new DurableScheduler({
    database,
    queue,
    now,
    dispatchId: () => {
      dispatchSequence += 1;
      return "dispatch-" + dispatchSequence;
    }
  });
  const coordinator = new OperationCoordinator({ database, now });
  return {
    root,
    database,
    queue,
    scheduler,
    coordinator,
    now,
    advance(ms) {
      nowMs += ms;
    },
    setNow(value) {
      nowMs = Date.parse(value);
    }
  };
}

function prepareScheduledOperation(
  coordinator,
  intent,
  suffix
) {
  return coordinator.prepare({
    operationId: "operation-" + suffix,
    idempotencyKey: intent.dispatchId,
    owner: { kind: "CORE" },
    actorSource: "p029-scheduler-test",
    targetKey: generatorOperationTargetKey(
      "generator-" + suffix
    ),
    operationKind: intent.operationKind,
    schemaVersion: intent.schemaVersion,
    desiredFingerprint: suffix
      .padEnd(64, "b")
      .slice(0, 64),
    provenance: {
      scheduleId: intent.scheduleId,
      source: "p029-scheduler-test"
    },
    preconditions: [{
      key: "scheduler-dispatch",
      observedAt: intent.createdAt,
      maxAgeMs: 60_000,
      evidenceRef: intent.dispatchId
    }]
  });
}

test("P029 scheduler coalesces duplicate wakeups and persists conservative budget/time state", async () => {
  const f = await fixture();
  try {
    const schedule = f.scheduler.create({
      scheduleId: "schedule-coalesce",
      operationKind: "synthetic-scheduled-mutation",
      schemaVersion: 1,
      targetRef: "perchance:generator:scheduled-1",
      intervalMs: 60_000,
      timeZone: "America/Chicago",
      nextDueAt: f.now().toISOString(),
      budget: {
        limit: 2,
        windowMs: 5 * 60_000
      }
    });
    assert.equal(schedule.budget?.used, 0);

    const firstWake = f.scheduler.wake();
    assert.equal(firstWake.enqueued, 1);
    assert.equal(firstWake.backpressured, 0);
    assert.equal(f.queue.size, 1);

    const duplicateWake = f.scheduler.wake();
    assert.equal(duplicateWake.enqueued, 0);
    assert.equal(duplicateWake.coalesced, 1);
    assert.equal(f.queue.size, 1);

    const firstIntent = f.scheduler.claimNext();
    assert.ok(firstIntent);
    const firstOperation = prepareScheduledOperation(
      f.coordinator,
      firstIntent,
      "scheduled-1"
    );
    f.scheduler.acknowledgeDispatch(
      firstIntent.scheduleId,
      firstIntent.dispatchId,
      firstOperation.operationId
    );
    assert.equal(f.queue.size, 0);

    f.advance(60_000);
    const secondWake = f.scheduler.wake();
    assert.equal(secondWake.enqueued, 1);
    const secondIntent = f.scheduler.claimNext();
    assert.ok(secondIntent);
    const secondOperation = prepareScheduledOperation(
      f.coordinator,
      secondIntent,
      "scheduled-2"
    );
    f.scheduler.acknowledgeDispatch(
      secondIntent.scheduleId,
      secondIntent.dispatchId,
      secondOperation.operationId
    );

    f.advance(60_000);
    const budgetBlocked = f.scheduler.wake();
    assert.equal(budgetBlocked.enqueued, 0);
    assert.equal(budgetBlocked.budgetBlocked, 1);
    const blockedRecord = f.scheduler.require(
      "schedule-coalesce"
    );
    assert.equal(blockedRecord.budget?.used, 2);
    assert.equal(
      blockedRecord.nextDueAt,
      "2026-10-03T16:35:00.000Z"
    );

    // A wall-clock rollback cannot reopen the persisted budget window.
    f.setNow("2026-10-03T16:31:00.000Z");
    const rollbackWake = f.scheduler.wake();
    assert.equal(rollbackWake.enqueued, 0);
    assert.equal(
      f.scheduler.require("schedule-coalesce").budget?.used,
      2
    );

    // A large forward jump creates only one current dispatch, not one per
    // missed cadence interval.
    f.setNow("2026-10-03T18:00:00.000Z");
    const forwardWake = f.scheduler.wake();
    assert.equal(forwardWake.enqueued, 1);
    assert.equal(f.queue.size, 1);
    const forwardRecord = f.scheduler.require(
      "schedule-coalesce"
    );
    assert.equal(
      forwardRecord.nextDueAt,
      "2026-10-03T18:01:00.000Z"
    );
    assert.equal(
      forwardRecord.budget?.windowStartedAt,
      "2026-10-03T18:00:00.000Z"
    );
    assert.equal(forwardRecord.budget?.used, 1);

    const repeatedForwardWake = f.scheduler.wake();
    assert.equal(repeatedForwardWake.enqueued, 0);
    assert.equal(repeatedForwardWake.coalesced, 1);
    assert.equal(f.queue.size, 1);
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P029 bounded queue prioritizes recovery and rotates same-priority fairness groups", () => {
  const queue = new BoundedWorkQueue(8);
  const createdAt = "2026-10-03T16:30:00.000Z";
  queue.enqueue({
    key: "scheduled-a-1",
    priority: "SCHEDULED",
    fairnessKey: "module-a",
    createdAt,
    value: "a1"
  });
  queue.enqueue({
    key: "scheduled-a-2",
    priority: "SCHEDULED",
    fairnessKey: "module-a",
    createdAt,
    value: "a2"
  });
  queue.enqueue({
    key: "scheduled-b-1",
    priority: "SCHEDULED",
    fairnessKey: "module-b",
    createdAt,
    value: "b1"
  });
  queue.enqueue({
    key: "recovery-1",
    priority: "RECOVERY",
    fairnessKey: "recovery",
    createdAt,
    value: "recovery"
  });

  const first = queue.claimNext(new Date(createdAt));
  assert.equal(first?.value, "recovery");
  assert.ok(first);
  queue.complete(first.key);

  const second = queue.claimNext(new Date(createdAt));
  assert.equal(second?.value, "a1");
  assert.ok(second);
  queue.complete(second.key);

  const third = queue.claimNext(new Date(createdAt));
  assert.equal(third?.value, "b1");
  assert.ok(third);
  queue.complete(third.key);

  const fourth = queue.claimNext(new Date(createdAt));
  assert.equal(fourth?.value, "a2");
  assert.ok(fourth);
  queue.complete(fourth.key);
});
