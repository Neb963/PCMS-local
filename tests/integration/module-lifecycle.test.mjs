import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
  const root = await mkdtemp(join(tmpdir(), "pcms-module-lifecycle-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let tick = 0;
  const now = () =>
    new Date(Date.UTC(2026, 9, 2, 23, 0, tick++));
  const state = new ModuleStateStore(database, { now });
  const lifecycle = new ModuleLifecycleStore(database, { now });

  return {
    root,
    database,
    state,
    lifecycle,
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("disable and re-enable fence runtimes while preserving state and unresolved Core evidence", async () => {
  const f = await fixture();
  try {
    f.state.registerModule(
      "fixture.lifecycle",
      "1.0.0",
      1,
      {
        durable: {
          counter: 7,
          marker: "keep"
        }
      }
    );

    const operation = f.lifecycle.recordUnresolvedEvidence(
      "fixture.lifecycle",
      "OPERATION",
      "operation-001"
    );
    const humanTask = f.lifecycle.recordUnresolvedEvidence(
      "fixture.lifecycle",
      "HUMAN_TASK",
      "task-001"
    );
    assert.equal(operation.unresolved, true);
    assert.equal(humanTask.unresolved, true);

    const initial = f.lifecycle.getLifecycle("fixture.lifecycle");
    assert.equal(initial.status, "ENABLED");
    assert.equal(initial.runtimeGeneration, 1);
    assert.equal(initial.runtimeEnabled, true);

    const disabled = f.lifecycle.disableModule(
      "fixture.lifecycle",
      1
    );
    assert.equal(disabled.status, "DISABLED");
    assert.equal(disabled.runtimeGeneration, 2);
    assert.equal(disabled.runtimeEnabled, false);
    assert.deepEqual(
      f.state.readActiveState("fixture.lifecycle").state,
      {
        durable: {
          counter: 7,
          marker: "keep"
        }
      }
    );
    assert.deepEqual(
      f.lifecycle.listUnresolvedEvidence("fixture.lifecycle")
        .map((entry) => [entry.kind, entry.evidenceId]),
      [
        ["HUMAN_TASK", "task-001"],
        ["OPERATION", "operation-001"]
      ]
    );

    assert.throws(
      () =>
        f.state.assertRuntimeCurrent(
          "fixture.lifecycle",
          1
        ),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_RUNTIME_STALE"
    );
    assert.throws(
      () =>
        f.state.assertRuntimeCurrent(
          "fixture.lifecycle",
          2
        ),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_RUNTIME_DISABLED"
    );

    const duplicateDisable = f.lifecycle.disableModule(
      "fixture.lifecycle",
      2
    );
    assert.equal(duplicateDisable.runtimeGeneration, 2);

    const enabled = f.lifecycle.enableModule(
      "fixture.lifecycle",
      2
    );
    assert.equal(enabled.status, "ENABLED");
    assert.equal(enabled.runtimeGeneration, 3);
    assert.equal(enabled.runtimeEnabled, true);
    assert.equal(
      f.state.assertRuntimeCurrent(
        "fixture.lifecycle",
        3
      ).runtimeGeneration,
      3
    );
    assert.deepEqual(
      f.state.readActiveState("fixture.lifecycle").state,
      {
        durable: {
          counter: 7,
          marker: "keep"
        }
      }
    );
    assert.equal(
      f.lifecycle.listUnresolvedEvidence("fixture.lifecycle").length,
      2
    );

    const duplicateEnable = f.lifecycle.enableModule(
      "fixture.lifecycle",
      3
    );
    assert.equal(duplicateEnable.runtimeGeneration, 3);
  } finally {
    await f.cleanup();
  }
});
