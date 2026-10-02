import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ModuleManager
} from "../../dist/modules/manager.js";
import {
  ModulePackageStoreError
} from "../../dist/modules/package-store.js";
import {
  ModuleRuntimeError
} from "../../dist/modules/runner.js";
import {
  ModuleStateError
} from "../../dist/modules/state-store.js";
import {
  ModuleUiHost
} from "../../dist/modules/ui-host.js";
import {
  applyPcmsMigrations
} from "../../dist/storage/migrations.js";
import {
  openConfiguredSqliteDatabase
} from "../../dist/storage/sqlite.js";
import {
  createReferenceModulePackage,
  REFERENCE_MODULE_ID
} from "../helpers/reference-module-fixture.mjs";

async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), "pcms-reference-module-")
  );
  const database = openConfiguredSqliteDatabase(
    join(root, "pcms.db")
  );
  applyPcmsMigrations(database);
  let tick = 0;
  const now = () =>
    new Date(Date.UTC(2026, 9, 3, 1, 0, tick++));
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

test("reference .pcmsmod installs, updates and rolls back through the shared module path", async () => {
  const f = await fixture();
  const host = new ModuleUiHost();
  const runtimes = [];

  try {
    const v1Bytes =
      createReferenceModulePackage("1.0.0");
    const installedV1 =
      await f.manager.installPackage(v1Bytes);

    assert.equal(
      installedV1.package.moduleId,
      REFERENCE_MODULE_ID
    );
    assert.equal(installedV1.package.version, "1.0.0");
    assert.equal(
      installedV1.registration.activeVersion,
      "1.0.0"
    );
    assert.equal(
      installedV1.registration.runtimeGeneration,
      1
    );

    const archiveV1 = await readFile(
      join(
        dirname(installedV1.package.packageRoot),
        "package.pcmsmod"
      )
    );
    assert.deepEqual(archiveV1, v1Bytes);

    const replay =
      await f.manager.packageStore.install(v1Bytes);
    assert.equal(
      replay.sha256,
      installedV1.package.sha256
    );
    assert.equal(
      replay.packageRoot,
      installedV1.package.packageRoot
    );

    const runtimeV1 =
      await f.manager.startActiveRuntime(
        REFERENCE_MODULE_ID
      );
    runtimes.push(runtimeV1);
    assert.deepEqual(
      await runtimeV1.request("describe", {}),
      {
        id: REFERENCE_MODULE_ID,
        version: "1.0.0",
        runtimeGeneration: 1
      }
    );
    assert.deepEqual(
      await runtimeV1.request("store", {
        key: "marker",
        value: "persisted-v1"
      }),
      { stateRevision: 1 }
    );

    const uiV1 = await f.manager.mountActiveUi(
      REFERENCE_MODULE_ID,
      host
    );
    assert.equal(uiV1.version, "1.0.0");
    assert.equal(uiV1.runtimeGeneration, 1);
    assert.match(
      (
        await host.readAsset(
          uiV1.sessionId,
          uiV1.uiGeneration
        )
      ).bytes.toString("utf8"),
      /Reference module 1\.0\.0/
    );

    const v2Bytes =
      createReferenceModulePackage("1.1.0");
    const updated =
      await f.manager.updatePackage(v2Bytes);
    assert.equal(updated.status, "ACTIVE");
    assert.equal(updated.package.version, "1.1.0");
    assert.equal(
      updated.registration.activeVersion,
      "1.1.0"
    );
    assert.equal(
      updated.registration.runtimeGeneration,
      2
    );
    assert.equal(updated.stateGeneration, 2);

    await assert.rejects(
      () =>
        runtimeV1.request("store", {
          key: "stale",
          value: true
        }),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RUNTIME_STALE"
    );
    await assert.rejects(
      () =>
        host.callSdk(
          uiV1.sessionId,
          uiV1.uiGeneration,
          "storage.get",
          { key: "marker" }
        ),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_RUNTIME_STALE"
    );

    const retainedV1 =
      await f.manager.packageStore.getInstalled(
        REFERENCE_MODULE_ID,
        "1.0.0"
      );
    const activeV2 =
      await f.manager.packageStore.getInstalled(
        REFERENCE_MODULE_ID,
        "1.1.0"
      );
    assert.equal(
      retainedV1.sha256,
      installedV1.package.sha256
    );
    assert.equal(activeV2.sha256, updated.package.sha256);

    const runtimeV2 =
      await f.manager.startActiveRuntime(
        REFERENCE_MODULE_ID
      );
    runtimes.push(runtimeV2);
    assert.deepEqual(
      await runtimeV2.request("describe", {}),
      {
        id: REFERENCE_MODULE_ID,
        version: "1.1.0",
        runtimeGeneration: 2
      }
    );
    assert.deepEqual(
      await runtimeV2.request("load", {
        key: "marker"
      }),
      {
        found: true,
        value: "persisted-v1"
      }
    );

    const uiV2 = await f.manager.mountActiveUi(
      REFERENCE_MODULE_ID,
      host
    );
    assert.match(
      (
        await host.readAsset(
          uiV2.sessionId,
          uiV2.uiGeneration
        )
      ).bytes.toString("utf8"),
      /Reference module 1\.1\.0/
    );

    const rollback =
      f.manager.lifecycleStore
        .rollbackToRetainedGeneration(
          REFERENCE_MODULE_ID,
          1,
          2
        );
    assert.equal(rollback.activeVersion, "1.0.0");
    assert.equal(rollback.runtimeGeneration, 3);

    await assert.rejects(
      () =>
        runtimeV2.request("store", {
          key: "stale-v2",
          value: true
        }),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RUNTIME_STALE"
    );

    const runtimeRolledBack =
      await f.manager.startActiveRuntime(
        REFERENCE_MODULE_ID
      );
    runtimes.push(runtimeRolledBack);
    assert.deepEqual(
      await runtimeRolledBack.request("describe", {}),
      {
        id: REFERENCE_MODULE_ID,
        version: "1.0.0",
        runtimeGeneration: 3
      }
    );
    assert.deepEqual(
      await runtimeRolledBack.request("load", {
        key: "marker"
      }),
      {
        found: true,
        value: "persisted-v1"
      }
    );

    const uiRolledBack =
      await f.manager.mountActiveUi(
        REFERENCE_MODULE_ID,
        host
      );
    assert.equal(uiRolledBack.runtimeGeneration, 3);
    assert.match(
      (
        await host.readAsset(
          uiRolledBack.sessionId,
          uiRolledBack.uiGeneration
        )
      ).bytes.toString("utf8"),
      /Reference module 1\.0\.0/
    );
  } finally {
    for (const runtime of runtimes.reverse()) {
      await runtime.stop();
    }
    await f.cleanup();
  }
});

test("module UI SDK authority is fenced across disable and re-enable", async () => {
  const f = await fixture();
  const host = new ModuleUiHost();

  try {
    await f.manager.installPackage(
      createReferenceModulePackage("1.0.0")
    );
    const first = await f.manager.mountActiveUi(
      REFERENCE_MODULE_ID,
      host
    );
    assert.equal(first.runtimeGeneration, 1);

    const disabled =
      f.manager.lifecycleStore.disableModule(
        REFERENCE_MODULE_ID,
        1
      );
    assert.equal(disabled.status, "DISABLED");
    assert.equal(disabled.runtimeGeneration, 2);

    await assert.rejects(
      () =>
        host.callSdk(
          first.sessionId,
          first.uiGeneration,
          "storage.get",
          { key: "marker" }
        ),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_RUNTIME_STALE"
    );
    await assert.rejects(
      () =>
        f.manager.mountActiveUi(
          REFERENCE_MODULE_ID,
          host
        ),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_RUNTIME_DISABLED"
    );

    const enabled =
      f.manager.lifecycleStore.enableModule(
        REFERENCE_MODULE_ID,
        2
      );
    assert.equal(enabled.status, "ENABLED");
    assert.equal(enabled.runtimeGeneration, 3);

    await assert.rejects(
      () =>
        host.callSdk(
          first.sessionId,
          first.uiGeneration,
          "storage.get",
          { key: "marker" }
        ),
      (error) =>
        error instanceof ModuleStateError &&
        error.code === "MODULE_RUNTIME_STALE"
    );

    const remounted =
      await f.manager.mountActiveUi(
        REFERENCE_MODULE_ID,
        host
      );
    assert.equal(remounted.runtimeGeneration, 3);
    assert.deepEqual(
      await host.callSdk(
        remounted.sessionId,
        remounted.uiGeneration,
        "storage.set",
        {
          key: "after-reenable",
          value: "accepted"
        }
      ),
      { stateRevision: 1 }
    );
    assert.deepEqual(
      f.manager.stateStore.readActiveState(
        REFERENCE_MODULE_ID
      ).state,
      {
        "after-reenable": "accepted"
      }
    );
  } finally {
    await f.cleanup();
  }
});

test("installed package runtime tree must match its immutable archive", async () => {
  const f = await fixture();

  try {
    const installed = await f.manager.installPackage(
      createReferenceModulePackage("1.0.0")
    );
    await writeFile(
      join(
        installed.package.packageRoot,
        "backend",
        "injected.mjs"
      ),
      "export const injected = true;\n"
    );

    await assert.rejects(
      () =>
        f.manager.packageStore.getInstalled(
          REFERENCE_MODULE_ID,
          "1.0.0"
        ),
      (error) =>
        error instanceof ModulePackageStoreError &&
        error.code === "MODULE_PACKAGE_STORE_CORRUPT" &&
        /unexpected file/.test(error.message)
    );
  } finally {
    await f.cleanup();
  }
});
