import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ModuleActivationStore
} from "../../dist/modules/activation-store.js";
import {
  ModuleLifecycleStore
} from "../../dist/modules/lifecycle-store.js";
import {
  ModuleStateError,
  ModuleStateStore
} from "../../dist/modules/state-store.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-module-rollback-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let tick = 0;
  const now = () =>
    new Date(Date.UTC(2026, 9, 2, 23, 30, tick++));
  return {
    root,
    database,
    state: new ModuleStateStore(database, { now }),
    activation: new ModuleActivationStore(database, { now }),
    lifecycle: new ModuleLifecycleStore(database, { now }),
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("rollback reactivates retained prior version/state through a new runtime generation", async () => {
  const f = await fixture();
  try {
    f.state.registerModule(
      "fixture.rollback",
      "1.0.0",
      1,
      {
        durable: "version-1",
        counter: 1
      }
    );

    const candidate = await f.state.prepareCandidateState({
      moduleId: "fixture.rollback",
      version: "2.0.0",
      stateSchemaVersion: 2,
      migrate: () => ({
        durable: "version-2",
        counter: 2
      }),
      healthCheck: () => true
    });
    const authority = f.activation.stageCandidateAuthority(
      "fixture.rollback",
      candidate.stateGeneration,
      {
        capabilities: [],
        requiredServices: []
      }
    );
    assert.equal(authority.approvalStatus, "NOT_REQUIRED");

    const activated = f.activation.activateReadyCandidate(
      "fixture.rollback",
      candidate.stateGeneration
    );
    assert.equal(activated.activeVersion, "2.0.0");
    assert.equal(activated.runtimeGeneration, 2);
    assert.deepEqual(
      f.state.readActiveState("fixture.rollback").state,
      {
        counter: 2,
        durable: "version-2"
      }
    );

    const rollback = f.lifecycle.rollbackToRetainedGeneration(
      "fixture.rollback",
      1,
      2
    );
    assert.equal(rollback.previousVersion, "2.0.0");
    assert.equal(rollback.activeVersion, "1.0.0");
    assert.equal(
      rollback.previousStateGeneration,
      candidate.stateGeneration
    );
    assert.equal(rollback.activeStateGeneration, 1);
    assert.equal(rollback.runtimeGeneration, 3);
    assert.deepEqual(rollback.approvedAuthority, {
      capabilities: [],
      requiredServices: []
    });

    const active = f.state.readActiveState("fixture.rollback");
    assert.equal(active.registration.activeVersion, "1.0.0");
    assert.equal(active.registration.activeStateGeneration, 1);
    assert.equal(active.registration.runtimeGeneration, 3);
    assert.equal(active.registration.stateSchemaVersion, 1);
    assert.equal(active.registration.stateRevision, 0);
    assert.deepEqual(active.state, {
      counter: 1,
      durable: "version-1"
    });

    assert.throws(
      () =>
        f.state.assertRuntimeCurrent(
          "fixture.rollback",
          2
        ),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_RUNTIME_STALE"
    );
    assert.equal(
      f.state.assertRuntimeCurrent(
        "fixture.rollback",
        3
      ).runtimeGeneration,
      3
    );

    const generations = f.database.prepare(`
      SELECT state_generation, module_version, status
      FROM module_state_generations
      WHERE module_id = ?
      ORDER BY state_generation
    `).all("fixture.rollback");
    assert.deepEqual(
      generations.map((row) => ({ ...row })),
      [
        {
          state_generation: 1,
          module_version: "1.0.0",
          status: "ACTIVE"
        },
        {
          state_generation: candidate.stateGeneration,
          module_version: "2.0.0",
          status: "RETAINED"
        }
      ]
    );
  } finally {
    await f.cleanup();
  }
});
