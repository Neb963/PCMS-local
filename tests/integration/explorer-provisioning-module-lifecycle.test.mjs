import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModuleManager } from "../../dist/modules/manager.js";
import { ModuleRuntimeError } from "../../dist/modules/runner.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";
import {
  createP040FeatureModulePackage,
  EXPLORER_MODULE_ID,
  PROVISIONING_MODULE_ID
} from "../helpers/p040-feature-module-fixture.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-p040-modules-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let tick = 0;
  const now = () =>
    new Date(Date.UTC(2026, 9, 4, 2, 0, tick++));
  const manager = new ModuleManager(database, {
    packageRoot: join(root, "modules"),
    now
  });
  return {
    root,
    database,
    manager,
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function installAndSeed(
  manager,
  moduleId,
  value
) {
  const installed = await manager.installPackage(
    createP040FeatureModulePackage(moduleId, "1.0.0")
  );
  const runtime = await manager.startActiveRuntime(moduleId);
  await runtime.request("store", {
    key: "state-marker",
    value
  });
  return { installed, runtime };
}

test("P040 Explorer and Provisioning update and roll back independently", async () => {
  const f = await fixture();
  const runtimes = [];
  try {
    const explorerV1 = await installAndSeed(
      f.manager,
      EXPLORER_MODULE_ID,
      "explorer-v1"
    );
    runtimes.push(explorerV1.runtime);
    const provisioningV1 = await installAndSeed(
      f.manager,
      PROVISIONING_MODULE_ID,
      "provisioning-v1"
    );
    runtimes.push(provisioningV1.runtime);

    const provisioningBeforeExplorerUpdate =
      f.manager.stateStore.readActiveState(
        PROVISIONING_MODULE_ID
      );
    const explorerUpdated = await f.manager.updatePackage(
      createP040FeatureModulePackage(
        EXPLORER_MODULE_ID,
        "1.1.0"
      )
    );
    assert.equal(explorerUpdated.status, "ACTIVE");
    assert.equal(
      explorerUpdated.registration.activeVersion,
      "1.1.0"
    );
    assert.equal(
      explorerUpdated.registration.runtimeGeneration,
      2
    );

    assert.deepEqual(
      f.manager.stateStore.readActiveState(
        PROVISIONING_MODULE_ID
      ),
      provisioningBeforeExplorerUpdate
    );
    assert.deepEqual(
      await provisioningV1.runtime.request(
        "load",
        { key: "state-marker" }
      ),
      {
        found: true,
        value: "provisioning-v1"
      }
    );
    await assert.rejects(
      () => explorerV1.runtime.request(
        "load",
        { key: "state-marker" }
      ),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RUNTIME_STALE"
    );

    const explorerV2Runtime =
      await f.manager.startActiveRuntime(
        EXPLORER_MODULE_ID
      );
    runtimes.push(explorerV2Runtime);
    assert.deepEqual(
      await explorerV2Runtime.request(
        "load",
        { key: "state-marker" }
      ),
      {
        found: true,
        value: "explorer-v1"
      }
    );
    await explorerV2Runtime.request("store", {
      key: "state-marker",
      value: "explorer-v2"
    });

    const explorerRollback =
      f.manager.lifecycleStore.rollbackToRetainedGeneration(
        EXPLORER_MODULE_ID,
        1,
        2
      );
    assert.equal(
      explorerRollback.activeVersion,
      "1.0.0"
    );
    assert.equal(
      explorerRollback.runtimeGeneration,
      3
    );
    assert.deepEqual(
      f.manager.stateStore.readActiveState(
        EXPLORER_MODULE_ID
      ).state,
      {
        "state-marker": "explorer-v1"
      }
    );
    assert.deepEqual(
      f.manager.stateStore.readActiveState(
        PROVISIONING_MODULE_ID
      ),
      provisioningBeforeExplorerUpdate
    );

    const explorerAfterRollback =
      f.manager.stateStore.readActiveState(
        EXPLORER_MODULE_ID
      );
    const provisioningUpdated =
      await f.manager.updatePackage(
        createP040FeatureModulePackage(
          PROVISIONING_MODULE_ID,
          "1.1.0"
        )
      );
    assert.equal(
      provisioningUpdated.status,
      "ACTIVE"
    );
    assert.equal(
      provisioningUpdated.registration.activeVersion,
      "1.1.0"
    );
    assert.equal(
      provisioningUpdated.registration.runtimeGeneration,
      2
    );
    assert.deepEqual(
      f.manager.stateStore.readActiveState(
        EXPLORER_MODULE_ID
      ),
      explorerAfterRollback
    );
    await assert.rejects(
      () => provisioningV1.runtime.request(
        "load",
        { key: "state-marker" }
      ),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RUNTIME_STALE"
    );

    const provisioningV2Runtime =
      await f.manager.startActiveRuntime(
        PROVISIONING_MODULE_ID
      );
    runtimes.push(provisioningV2Runtime);
    assert.deepEqual(
      await provisioningV2Runtime.request(
        "load",
        { key: "state-marker" }
      ),
      {
        found: true,
        value: "provisioning-v1"
      }
    );
    await provisioningV2Runtime.request("store", {
      key: "state-marker",
      value: "provisioning-v2"
    });

    const provisioningRollback =
      f.manager.lifecycleStore.rollbackToRetainedGeneration(
        PROVISIONING_MODULE_ID,
        1,
        2
      );
    assert.equal(
      provisioningRollback.activeVersion,
      "1.0.0"
    );
    assert.equal(
      provisioningRollback.runtimeGeneration,
      3
    );
    assert.deepEqual(
      f.manager.stateStore.readActiveState(
        PROVISIONING_MODULE_ID
      ).state,
      {
        "state-marker": "provisioning-v1"
      }
    );
    assert.deepEqual(
      f.manager.stateStore.readActiveState(
        EXPLORER_MODULE_ID
      ),
      explorerAfterRollback
    );
  } finally {
    for (const runtime of runtimes.reverse()) {
      await runtime.stop().catch(() => undefined);
    }
    await f.cleanup();
  }
});
