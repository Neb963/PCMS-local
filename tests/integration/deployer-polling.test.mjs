import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeployerPollExecutor } from "../../dist/deployer/polling.js";
import { OperationCoordinator } from "../../dist/operations/operation-coordinator.js";
import { DurableScheduler } from "../../dist/scheduler/durable-scheduler.js";
import { BoundedWorkQueue } from "../../dist/scheduler/work-queue.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-deployer-polling-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let nowMs = Date.parse("2026-10-03T17:30:00.000Z");
  let dispatch = 0;
  const now = () => new Date(nowMs);
  const queue = new BoundedWorkQueue(2);
  const scheduler = new DurableScheduler({
    database,
    queue,
    now,
    dispatchId: () => `deployer-poll-${++dispatch}`
  });
  const coordinator = new OperationCoordinator({
    database,
    now,
    providerGate: {
      maxGlobalMutations: 2,
      maxProviderMutations: 1,
      maxAccountMutations: 1,
      maxPersonaMutations: 1
    }
  });
  const executor = new DeployerPollExecutor({
    scheduler,
    providerGate: coordinator.providerGate
  });
  return {
    root,
    database,
    queue,
    scheduler,
    coordinator,
    executor,
    now,
    advance(ms) {
      nowMs += ms;
    }
  };
}

test("P033 Deployer polling coalesces wakeups and reuses one durable dispatch under shared provider backpressure", async () => {
  const f = await fixture();
  try {
    f.scheduler.create({
      scheduleId: "deployer-poll-generator-a",
      ownerModuleId: "deployer",
      operationKind: "deployer.poll",
      schemaVersion: 1,
      targetRef: "perchance:generator:generator-a",
      intervalMs: 60_000,
      timeZone: "UTC",
      priority: "BACKGROUND",
      fairnessKey: "deployer",
      nextDueAt: f.now().toISOString()
    });

    const firstWake = f.scheduler.wake();
    assert.equal(firstWake.enqueued, 1);
    assert.equal(firstWake.coalesced, 0);
    assert.equal(f.queue.size, 1);

    const duplicateWake = f.scheduler.wake();
    assert.equal(duplicateWake.enqueued, 0);
    assert.equal(duplicateWake.coalesced, 1);
    assert.equal(f.queue.size, 1);

    const firstIntent = f.scheduler.claimNext();
    assert.ok(firstIntent);
    const held = f.coordinator.providerGate.acquire({
      provider: "perchance",
      accountId: "account-other",
      personaUid: "persona-other"
    });

    let polls = 0;
    const blocked = await f.executor.execute({
      intent: firstIntent,
      scope: {
        provider: "perchance",
        accountId: "account-a",
        personaUid: "persona-a"
      },
      poll: async () => {
        polls += 1;
      }
    });
    assert.deepEqual(blocked, {
      status: "BACKPRESSURED",
      retryAt: null,
      reason: "PROVIDER_BUSY"
    });
    assert.equal(polls, 0);
    assert.equal(f.queue.size, 0);

    const pendingAfterBusy = f.scheduler.require(
      "deployer-poll-generator-a"
    );
    assert.equal(
      pendingAfterBusy.pendingDispatchId,
      firstIntent.dispatchId
    );

    held.release();
    const retryWake = f.scheduler.wake();
    assert.equal(retryWake.enqueued, 1);
    const retryIntent = f.scheduler.claimNext();
    assert.ok(retryIntent);
    assert.equal(retryIntent.dispatchId, firstIntent.dispatchId);

    const completed = await f.executor.execute({
      intent: retryIntent,
      scope: {
        provider: "perchance",
        accountId: "account-a",
        personaUid: "persona-a"
      },
      poll: async () => {
        polls += 1;
      }
    });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(polls, 1);
    assert.equal(completed.schedule.pendingDispatchId, null);
    assert.equal(f.queue.size, 0);

    f.advance(60_000);
    const nextWake = f.scheduler.wake();
    assert.equal(nextWake.enqueued, 1);
    const cooldownIntent = f.scheduler.claimNext();
    assert.ok(cooldownIntent);

    f.coordinator.providerGate.observeSignal({
      provider: "perchance",
      kind: "RATE_LIMIT",
      cooldownMs: 30_000,
      reason: "p033-emulated-rate-limit"
    });
    const cooled = await f.executor.execute({
      intent: cooldownIntent,
      scope: {
        provider: "perchance",
        accountId: "account-a",
        personaUid: "persona-a"
      },
      poll: async () => {
        polls += 1;
      }
    });
    assert.equal(cooled.status, "BACKPRESSURED");
    assert.equal(cooled.reason, "PROVIDER_COOLDOWN");
    assert.equal(cooled.retryAt, "2026-10-03T17:31:30.000Z");
    assert.equal(polls, 1);

    f.advance(30_001);
    const afterCooldownWake = f.scheduler.wake();
    assert.equal(afterCooldownWake.enqueued, 1);
    const afterCooldownIntent = f.scheduler.claimNext();
    assert.ok(afterCooldownIntent);
    assert.equal(
      afterCooldownIntent.dispatchId,
      cooldownIntent.dispatchId
    );
    const afterCooldown = await f.executor.execute({
      intent: afterCooldownIntent,
      scope: {
        provider: "perchance",
        accountId: "account-a",
        personaUid: "persona-a"
      },
      poll: async () => {
        polls += 1;
      }
    });
    assert.equal(afterCooldown.status, "COMPLETED");
    assert.equal(polls, 2);
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
