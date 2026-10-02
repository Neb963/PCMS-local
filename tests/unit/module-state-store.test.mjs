import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ModuleStateError,
  ModuleStateStore,
  createModuleStorageSdkHandlers
} from "../../dist/modules/state-store.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-module-state-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database, {
    now: () => new Date("2026-10-02T20:00:00.000Z")
  });
  const store = new ModuleStateStore(database, {
    now: () => new Date("2026-10-02T20:01:00.000Z")
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

test("module state is namespaced by module and active generation", async () => {
  const f = await fixture();
  try {
    const first = f.store.registerModule(
      "fixture.one",
      "1.0.0",
      1,
      { shared: { owner: "one" } }
    );
    const second = f.store.registerModule(
      "fixture.two",
      "1.0.0",
      1,
      { shared: { owner: "two" } }
    );

    assert.equal(first.runtimeGeneration, 1);
    assert.equal(first.activeStateGeneration, 1);
    assert.equal(first.stateRevision, 0);
    assert.equal(second.runtimeGeneration, 1);

    assert.deepEqual(f.store.readActiveState("fixture.one").state, {
      shared: { owner: "one" }
    });
    assert.deepEqual(f.store.readActiveState("fixture.two").state, {
      shared: { owner: "two" }
    });

    const updated = f.store.setActiveValue(
      "fixture.one",
      1,
      "counter",
      { value: 2 }
    );
    assert.equal(updated.stateRevision, 1);
    assert.deepEqual(
      f.store.getActiveValue("fixture.one", 1, "counter"),
      { found: true, value: { value: 2 } }
    );
    assert.deepEqual(
      f.store.getActiveValue("fixture.two", 1, "counter"),
      { found: false }
    );
  } finally {
    await f.cleanup();
  }
});

test("runtime generation fencing rejects stale and disabled module access", async () => {
  const f = await fixture();
  try {
    f.store.registerModule("fixture.fence", "1.0.0", 1, {
      value: 1
    });

    const generation2 = f.store.advanceRuntimeGeneration(
      "fixture.fence",
      1,
      true
    );
    assert.equal(generation2.runtimeGeneration, 2);
    assert.equal(generation2.runtimeEnabled, true);

    assert.throws(
      () => f.store.assertRuntimeCurrent("fixture.fence", 1),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_RUNTIME_STALE"
    );
    assert.equal(
      f.store.assertRuntimeCurrent("fixture.fence", 2)
        .runtimeGeneration,
      2
    );

    const disabled = f.store.advanceRuntimeGeneration(
      "fixture.fence",
      2,
      false
    );
    assert.equal(disabled.runtimeGeneration, 3);
    assert.equal(disabled.runtimeEnabled, false);

    assert.throws(
      () => f.store.assertRuntimeCurrent("fixture.fence", 2),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_RUNTIME_STALE"
    );
    assert.throws(
      () => f.store.assertRuntimeCurrent("fixture.fence", 3),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_RUNTIME_DISABLED"
    );
  } finally {
    await f.cleanup();
  }
});

test("storage SDK handlers expose only the module namespace and enforce generation", async () => {
  const f = await fixture();
  try {
    f.store.registerModule("fixture.sdk", "1.0.0", 1);
    const handlers = createModuleStorageSdkHandlers(
      f.store,
      "fixture.sdk",
      1
    );

    assert.deepEqual(Object.keys(handlers).sort(), [
      "storage.delete",
      "storage.get",
      "storage.set"
    ]);

    assert.deepEqual(
      await handlers["storage.set"]?.({
        key: "alpha",
        value: { ok: true }
      }),
      { stateRevision: 1 }
    );
    assert.deepEqual(
      await handlers["storage.get"]?.({ key: "alpha" }),
      { found: true, value: { ok: true } }
    );
    assert.deepEqual(
      await handlers["storage.delete"]?.({ key: "alpha" }),
      { stateRevision: 2 }
    );
    assert.deepEqual(
      await handlers["storage.get"]?.({ key: "alpha" }),
      { found: false }
    );

    f.store.advanceRuntimeGeneration("fixture.sdk", 1, true);
    await assert.rejects(
      async () => handlers["storage.get"]?.({ key: "alpha" }),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_RUNTIME_STALE"
    );
  } finally {
    await f.cleanup();
  }
});

test("module state rejects invalid keys, non-JSON values and oversize values", async () => {
  const f = await fixture();
  try {
    f.store.registerModule("fixture.bounds", "1.0.0", 1);

    assert.throws(
      () =>
        f.store.setActiveValue(
          "fixture.bounds",
          1,
          "../escape",
          1
        ),
      ModuleStateError
    );
    assert.throws(
      () =>
        f.store.setActiveValue(
          "fixture.bounds",
          1,
          "nan",
          Number.NaN
        ),
      ModuleStateError
    );
    assert.throws(
      () =>
        f.store.setActiveValue(
          "fixture.bounds",
          1,
          "large",
          "x".repeat(40 * 1024)
        ),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_STATE_LIMIT_EXCEEDED"
    );
  } finally {
    await f.cleanup();
  }
});
