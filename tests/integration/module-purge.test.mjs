import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ModuleLifecycleError,
  ModuleLifecycleStore
} from "../../dist/modules/lifecycle-store.js";
import {
  ModuleStateError,
  ModuleStateStore
} from "../../dist/modules/state-store.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-module-purge-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let tick = 0;
  const now = () =>
    new Date(Date.UTC(2026, 9, 2, 23, 45, tick++));
  return {
    root,
    database,
    state: new ModuleStateStore(database, { now }),
    lifecycle: new ModuleLifecycleStore(database, { now }),
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("remove preserves module data while purge is blocked by unresolved operation and HumanTask evidence", async () => {
  const f = await fixture();
  try {
    f.state.registerModule(
      "fixture.purge",
      "1.0.0",
      1,
      {
        durable: "preserve-until-safe"
      }
    );
    f.lifecycle.recordUnresolvedEvidence(
      "fixture.purge",
      "OPERATION",
      "operation-uncertain"
    );
    f.lifecycle.recordUnresolvedEvidence(
      "fixture.purge",
      "HUMAN_TASK",
      "task-reconcile"
    );

    const removed = f.lifecycle.removeModule(
      "fixture.purge",
      1
    );
    assert.equal(removed.status, "REMOVED");
    assert.equal(removed.runtimeEnabled, false);
    assert.equal(removed.runtimeGeneration, 2);
    assert.equal(typeof removed.removedAt, "string");

    assert.deepEqual(
      f.state.readActiveState("fixture.purge").state,
      {
        durable: "preserve-until-safe"
      }
    );
    assert.deepEqual(
      f.lifecycle.listUnresolvedEvidence("fixture.purge")
        .map((entry) => [entry.kind, entry.evidenceId]),
      [
        ["HUMAN_TASK", "task-reconcile"],
        ["OPERATION", "operation-uncertain"]
      ]
    );

    assert.throws(
      () =>
        f.lifecycle.purgeModule(
          "fixture.purge",
          { confirm: false }
        ),
      (error) =>
        error instanceof ModuleLifecycleError &&
        error.code ===
          "MODULE_PURGE_CONFIRMATION_REQUIRED"
    );
    assert.throws(
      () =>
        f.lifecycle.purgeModule(
          "fixture.purge",
          { confirm: true }
        ),
      (error) =>
        error instanceof ModuleLifecycleError &&
        error.code ===
          "MODULE_PURGE_BLOCKED_BY_EVIDENCE" &&
        error.message.includes("HUMAN_TASK") &&
        error.message.includes("OPERATION")
    );

    f.lifecycle.resolveEvidence(
      "fixture.purge",
      "OPERATION",
      "operation-uncertain"
    );
    assert.throws(
      () =>
        f.lifecycle.purgeModule(
          "fixture.purge",
          { confirm: true }
        ),
      (error) =>
        error instanceof ModuleLifecycleError &&
        error.code ===
          "MODULE_PURGE_BLOCKED_BY_EVIDENCE" &&
        error.message.includes("HUMAN_TASK")
    );

    f.lifecycle.resolveEvidence(
      "fixture.purge",
      "HUMAN_TASK",
      "task-reconcile"
    );
    assert.deepEqual(
      f.lifecycle.listUnresolvedEvidence("fixture.purge"),
      []
    );

    const purged = f.lifecycle.purgeModule(
      "fixture.purge",
      { confirm: true }
    );
    assert.equal(purged.moduleId, "fixture.purge");
    assert.equal(purged.deletedStateGenerations, 1);
    assert.equal(purged.deletedEvidenceRecords, 2);

    assert.throws(
      () => f.lifecycle.getLifecycle("fixture.purge"),
      (error) =>
        error instanceof ModuleLifecycleError &&
        error.code === "MODULE_NOT_REGISTERED"
    );
    assert.throws(
      () => f.state.readActiveState("fixture.purge"),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_NOT_REGISTERED"
    );

    assert.equal(
      f.database.prepare(`
        SELECT COUNT(*) AS count
        FROM module_state_generations
        WHERE module_id = ?
      `).get("fixture.purge").count,
      0
    );
    assert.equal(
      f.database.prepare(`
        SELECT COUNT(*) AS count
        FROM module_generation_authority
        WHERE module_id = ?
      `).get("fixture.purge").count,
      0
    );
    assert.equal(
      f.database.prepare(`
        SELECT COUNT(*) AS count
        FROM module_lifecycle_evidence
        WHERE module_id = ?
      `).get("fixture.purge").count,
      0
    );
  } finally {
    await f.cleanup();
  }
});

test("remove is idempotent and does not allow re-enable", async () => {
  const f = await fixture();
  try {
    f.state.registerModule(
      "fixture.removed",
      "1.0.0",
      1,
      { value: 1 }
    );
    const removed = f.lifecycle.removeModule(
      "fixture.removed",
      1
    );
    const again = f.lifecycle.removeModule(
      "fixture.removed",
      removed.runtimeGeneration
    );
    assert.equal(
      again.runtimeGeneration,
      removed.runtimeGeneration
    );

    assert.throws(
      () =>
        f.lifecycle.enableModule(
          "fixture.removed",
          removed.runtimeGeneration
        ),
      (error) =>
        error instanceof ModuleLifecycleError &&
        error.code === "MODULE_REMOVED"
    );
  } finally {
    await f.cleanup();
  }
});
