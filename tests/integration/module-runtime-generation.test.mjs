import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createModuleStorageSdkHandlers,
  ModuleStateStore
} from "../../dist/modules/state-store.js";
import {
  ModuleRuntimeError,
  startModuleRuntime
} from "../../dist/modules/runner.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-module-generation-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  const store = new ModuleStateStore(database);
  const packageRoot = join(root, "module");
  const backendDir = join(packageRoot, "backend");
  await mkdir(backendDir, { recursive: true });
  await writeFile(
    join(backendDir, "index.mjs"),
    `
      export function createModule(context) {
        return {
          async handle(method, params) {
            if (method !== "sdk") throw new Error("unknown method");
            return context.sdk.call(params.method, params.payload);
          }
        };
      }
    `,
    { mode: 0o600 }
  );

  return {
    root,
    database,
    store,
    packageRoot,
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function runtimeOptions(f, runtimeGeneration, handlers) {
  return {
    moduleId: "fixture.generation",
    version: "1.0.0",
    packageRoot: f.packageRoot,
    backendEntry: "backend/index.mjs",
    runtimeGeneration,
    sdkHandlers: handlers,
    authorizeSdkRequest: ({ moduleId, runtimeGeneration: observed }) => {
      assert.equal(moduleId, "fixture.generation");
      f.store.assertRuntimeCurrent(moduleId, observed);
    }
  };
}

test("stale and disabled runtime generations cannot issue accepted SDK calls", async () => {
  const f = await fixture();
  let acceptedAccountReads = 0;
  let generation1 = null;
  let generation2 = null;
  let generation3 = null;

  try {
    f.store.registerModule(
      "fixture.generation",
      "1.0.0",
      1,
      { durable: "initial" }
    );

    const handlers1 = {
      ...createModuleStorageSdkHandlers(
        f.store,
        "fixture.generation",
        1
      ),
      "accounts.read": () => {
        acceptedAccountReads += 1;
        return { acceptedAccountReads };
      }
    };

    generation1 = await startModuleRuntime(
      runtimeOptions(f, 1, handlers1)
    );

    assert.deepEqual(
      await generation1.request("sdk", {
        method: "accounts.read",
        payload: null
      }),
      { acceptedAccountReads: 1 }
    );
    assert.deepEqual(
      await generation1.request("sdk", {
        method: "storage.set",
        payload: {
          key: "durable",
          value: "generation-1"
        }
      }),
      { stateRevision: 1 }
    );

    const fenced = f.store.advanceRuntimeGeneration(
      "fixture.generation",
      1,
      true
    );
    assert.equal(fenced.runtimeGeneration, 2);

    for (const request of [
      {
        method: "accounts.read",
        payload: null
      },
      {
        method: "storage.set",
        payload: {
          key: "durable",
          value: "stale-write"
        }
      }
    ]) {
      await assert.rejects(
        () => generation1.request("sdk", request),
        (error) =>
          error instanceof ModuleRuntimeError &&
          error.code === "MODULE_RUNTIME_STALE"
      );
    }

    assert.equal(acceptedAccountReads, 1);
    assert.deepEqual(
      f.store.readActiveState("fixture.generation").state,
      { durable: "generation-1" }
    );

    const handlers2 = {
      ...createModuleStorageSdkHandlers(
        f.store,
        "fixture.generation",
        2
      ),
      "accounts.read": () => {
        acceptedAccountReads += 1;
        return { acceptedAccountReads };
      }
    };

    generation2 = await startModuleRuntime(
      runtimeOptions(f, 2, handlers2)
    );
    assert.deepEqual(
      await generation2.request("sdk", {
        method: "accounts.read",
        payload: null
      }),
      { acceptedAccountReads: 2 }
    );

    const disabled = f.store.advanceRuntimeGeneration(
      "fixture.generation",
      2,
      false
    );
    assert.equal(disabled.runtimeGeneration, 3);
    assert.equal(disabled.runtimeEnabled, false);

    await assert.rejects(
      () => generation2.request("sdk", {
        method: "accounts.read",
        payload: null
      }),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RUNTIME_STALE"
    );

    const handlers3 = {
      ...createModuleStorageSdkHandlers(
        f.store,
        "fixture.generation",
        3
      ),
      "accounts.read": () => {
        acceptedAccountReads += 1;
        return { acceptedAccountReads };
      }
    };
    generation3 = await startModuleRuntime(
      runtimeOptions(f, 3, handlers3)
    );

    await assert.rejects(
      () => generation3.request("sdk", {
        method: "accounts.read",
        payload: null
      }),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RUNTIME_DISABLED"
    );

    assert.equal(acceptedAccountReads, 2);
  } finally {
    await generation3?.stop();
    await generation2?.stop();
    await generation1?.stop();
    await f.cleanup();
  }
});
