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
  createRefresherModulePackage,
  REFRESHER_MODULE_ID
} from "../helpers/refresher-module-fixture.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-refresher-module-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let tick = 0;
  const now = () =>
    new Date(Date.UTC(2026, 9, 3, 20, 0, tick++));
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

const HISTORY_V1 = Object.freeze({
  version: 1,
  generators: {
    "generator-p036": [{
      operationId: "operation-p036-v1",
      mode: "MANUAL",
      refreshToken: "refresh-v1",
      effectState: "PENDING",
      verifiedAt: "2026-10-03T20:00:00.000Z"
    }]
  }
});

const HISTORY_V2 = Object.freeze({
  version: 1,
  generators: {
    "generator-p036": [
      ...HISTORY_V1.generators["generator-p036"],
      {
        operationId: "operation-p036-v2",
        mode: "SCHEDULED",
        refreshToken: "refresh-v2",
        effectState: "VISIBLE",
        verifiedAt: "2026-10-03T20:05:00.000Z"
      }
    ]
  }
});

test("P036 Refresher .pcmsmod updates and rolls back through the standard module lifecycle", async () => {
  const f = await fixture();
  const runtimes = [];
  try {
    const installed = await f.manager.installPackage(
      createRefresherModulePackage("1.0.0")
    );
    assert.equal(
      installed.package.moduleId,
      REFRESHER_MODULE_ID
    );
    assert.equal(installed.package.version, "1.0.0");
    assert.equal(installed.registration.runtimeGeneration, 1);

    const runtimeV1 = await f.manager.startActiveRuntime(
      REFRESHER_MODULE_ID
    );
    runtimes.push(runtimeV1);
    assert.deepEqual(
      await runtimeV1.request("describe", {}),
      {
        id: REFRESHER_MODULE_ID,
        version: "1.0.0",
        runtimeGeneration: 1
      }
    );
    await runtimeV1.request("store", {
      key: "verified-history",
      value: HISTORY_V1
    });
    await runtimeV1.request("store", {
      key: "policy",
      value: {
        cohortSize: 360,
        timeZone: "America/Chicago",
        dailyMutationBudget: 24
      }
    });

    const updated = await f.manager.updatePackage(
      createRefresherModulePackage("1.1.0")
    );
    assert.equal(updated.status, "ACTIVE");
    assert.equal(
      updated.registration.activeVersion,
      "1.1.0"
    );
    assert.equal(updated.registration.runtimeGeneration, 2);
    assert.equal(updated.stateGeneration, 2);

    await assert.rejects(
      () => runtimeV1.request("load", {
        key: "verified-history"
      }),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RUNTIME_STALE"
    );

    const runtimeV2 = await f.manager.startActiveRuntime(
      REFRESHER_MODULE_ID
    );
    runtimes.push(runtimeV2);
    assert.deepEqual(
      await runtimeV2.request("load", {
        key: "verified-history"
      }),
      {
        found: true,
        value: HISTORY_V1
      }
    );
    assert.deepEqual(
      await runtimeV2.request("load", { key: "policy" }),
      {
        found: true,
        value: {
          cohortSize: 360,
          dailyMutationBudget: 24,
          timeZone: "America/Chicago"
        }
      }
    );

    await runtimeV2.request("store", {
      key: "verified-history",
      value: HISTORY_V2
    });
    assert.deepEqual(
      f.manager.stateStore.readActiveState(
        REFRESHER_MODULE_ID
      ).state["verified-history"],
      HISTORY_V2
    );

    const rollback =
      f.manager.lifecycleStore.rollbackToRetainedGeneration(
        REFRESHER_MODULE_ID,
        1,
        2
      );
    assert.equal(rollback.activeVersion, "1.0.0");
    assert.equal(rollback.runtimeGeneration, 3);
    assert.deepEqual(
      f.manager.stateStore.readActiveState(
        REFRESHER_MODULE_ID
      ).state["verified-history"],
      HISTORY_V1
    );

    await assert.rejects(
      () => runtimeV2.request("load", {
        key: "verified-history"
      }),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RUNTIME_STALE"
    );

    const rolledBackRuntime =
      await f.manager.startActiveRuntime(
        REFRESHER_MODULE_ID
      );
    runtimes.push(rolledBackRuntime);
    assert.deepEqual(
      await rolledBackRuntime.request("describe", {}),
      {
        id: REFRESHER_MODULE_ID,
        version: "1.0.0",
        runtimeGeneration: 3
      }
    );
    assert.deepEqual(
      await rolledBackRuntime.request("load", {
        key: "verified-history"
      }),
      {
        found: true,
        value: HISTORY_V1
      }
    );
  } finally {
    for (const runtime of runtimes.reverse()) {
      await runtime.stop().catch(() => undefined);
    }
    await f.cleanup();
  }
});
