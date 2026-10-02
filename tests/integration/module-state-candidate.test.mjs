import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ModuleStateError,
  ModuleStateStore
} from "../../dist/modules/state-store.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  const store = new ModuleStateStore(database, {
    now: () => new Date("2026-10-02T21:00:00.000Z")
  });
  return {
    database,
    store,
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function assertActive(store, moduleId, expectedState) {
  const active = store.readActiveState(moduleId);
  assert.equal(active.registration.activeVersion, "1.0.0");
  assert.equal(active.registration.activeStateGeneration, 1);
  assert.equal(active.registration.stateSchemaVersion, 1);
  assert.deepEqual(active.state, expectedState);
}

test("successful candidate migration is staged without switching active state", async () => {
  const f = await fixture("pcms-module-candidate-success-");
  try {
    f.store.registerModule(
      "fixture.candidate",
      "1.0.0",
      1,
      { counter: 1, nested: { source: "active" } }
    );

    const candidate = await f.store.prepareCandidateState({
      moduleId: "fixture.candidate",
      version: "2.0.0",
      stateSchemaVersion: 2,
      migrate: (context) => {
        assert.equal(Object.isFrozen(context), true);
        assert.equal(Object.isFrozen(context.state), true);
        assert.equal(context.fromVersion, "1.0.0");
        assert.equal(context.toVersion, "2.0.0");
        return {
          counter: 2,
          migrated: true,
          nested: context.state.nested
        };
      },
      healthCheck: (context) => {
        assert.equal(context.version, "2.0.0");
        assert.equal(context.stateSchemaVersion, 2);
        return context.state.migrated === true;
      }
    });

    assert.equal(candidate.status, "READY_TO_SWITCH");
    assert.equal(candidate.stateGeneration, 2);
    assert.equal(candidate.baseStateGeneration, 1);
    assert.equal(candidate.baseStateRevision, 0);
    assert.deepEqual(candidate.state, {
      counter: 2,
      migrated: true,
      nested: { source: "active" }
    });

    assertActive(
      f.store,
      "fixture.candidate",
      { counter: 1, nested: { source: "active" } }
    );
    assert.deepEqual(
      f.store.getReadyCandidate("fixture.candidate"),
      candidate
    );
  } finally {
    await f.cleanup();
  }
});

test("migration failure leaves last-known-good version and state active", async () => {
  const f = await fixture("pcms-module-candidate-migration-fail-");
  try {
    f.store.registerModule(
      "fixture.migration-fail",
      "1.0.0",
      1,
      { stable: { value: 7 } }
    );
    let healthCalled = false;

    await assert.rejects(
      () => f.store.prepareCandidateState({
        moduleId: "fixture.migration-fail",
        version: "2.0.0",
        stateSchemaVersion: 2,
        migrate: () => {
          throw new Error("synthetic migration failure");
        },
        healthCheck: () => {
          healthCalled = true;
          return true;
        }
      }),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_CANDIDATE_MIGRATION_FAILED"
    );

    assert.equal(healthCalled, false);
    assertActive(
      f.store,
      "fixture.migration-fail",
      { stable: { value: 7 } }
    );
    assert.equal(
      f.store.getReadyCandidate("fixture.migration-fail"),
      null
    );
  } finally {
    await f.cleanup();
  }
});

test("health failure leaves last-known-good version and state active", async () => {
  const f = await fixture("pcms-module-candidate-health-fail-");
  try {
    f.store.registerModule(
      "fixture.health-fail",
      "1.0.0",
      1,
      { stable: true }
    );

    await assert.rejects(
      () => f.store.prepareCandidateState({
        moduleId: "fixture.health-fail",
        version: "2.0.0",
        stateSchemaVersion: 2,
        migrate: () => ({ stable: false, candidate: true }),
        healthCheck: () => false
      }),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_CANDIDATE_HEALTH_FAILED"
    );

    assertActive(
      f.store,
      "fixture.health-fail",
      { stable: true }
    );
    assert.equal(
      f.store.getReadyCandidate("fixture.health-fail"),
      null
    );
  } finally {
    await f.cleanup();
  }
});

test("candidate commit fails closed if active state changes during migration", async () => {
  const f = await fixture("pcms-module-candidate-race-");
  try {
    f.store.registerModule(
      "fixture.race",
      "1.0.0",
      1,
      { value: "before" }
    );

    let releaseMigration;
    let signalStarted;
    const started = new Promise((resolve) => {
      signalStarted = resolve;
    });
    const waitForRelease = new Promise((resolve) => {
      releaseMigration = resolve;
    });

    const candidate = f.store.prepareCandidateState({
      moduleId: "fixture.race",
      version: "2.0.0",
      stateSchemaVersion: 2,
      migrate: async (context) => {
        signalStarted();
        await waitForRelease;
        return { value: context.state.value, migrated: true };
      },
      healthCheck: () => true
    });

    await started;
    const mutated = f.store.setActiveValue(
      "fixture.race",
      1,
      "value",
      "changed"
    );
    assert.equal(mutated.stateRevision, 1);
    releaseMigration();

    await assert.rejects(
      () => candidate,
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_ACTIVE_STATE_CHANGED" &&
        error.retryable === true
    );

    assertActive(
      f.store,
      "fixture.race",
      { value: "changed" }
    );
    assert.equal(f.store.getReadyCandidate("fixture.race"), null);
  } finally {
    await f.cleanup();
  }
});

test("candidate migration timeout persists no candidate state", async () => {
  const f = await fixture("pcms-module-candidate-timeout-");
  try {
    f.store.registerModule(
      "fixture.timeout",
      "1.0.0",
      1,
      { stable: true }
    );

    await assert.rejects(
      () => f.store.prepareCandidateState({
        moduleId: "fixture.timeout",
        version: "2.0.0",
        stateSchemaVersion: 2,
        timeoutMs: 25,
        migrate: () => new Promise(() => {}),
        healthCheck: () => true
      }),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_CANDIDATE_MIGRATION_FAILED"
    );

    assertActive(
      f.store,
      "fixture.timeout",
      { stable: true }
    );
    assert.equal(f.store.getReadyCandidate("fixture.timeout"), null);
  } finally {
    await f.cleanup();
  }
});
