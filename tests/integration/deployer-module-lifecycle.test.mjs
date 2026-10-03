import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModuleManager } from "../../dist/modules/manager.js";
import { ModuleRuntimeError } from "../../dist/modules/runner.js";
import {
  OperationCoordinator,
  generatorOperationTargetKey
} from "../../dist/operations/operation-coordinator.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";
import {
  createDeployerModulePackage,
  DEPLOYER_MODULE_ID
} from "../helpers/deployer-module-fixture.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-deployer-module-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let tick = 0;
  const now = () =>
    new Date(Date.UTC(2026, 9, 3, 18, 0, tick++));
  const manager = new ModuleManager(database, {
    packageRoot: join(root, "modules"),
    now
  });
  const coordinator = new OperationCoordinator({
    database,
    now
  });
  return {
    root,
    database,
    manager,
    coordinator,
    now,
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function operationSdkHandler(
  f,
  owner
) {
  return async (params) => {
    assert.equal(typeof params, "object");
    assert.ok(params !== null);
    const operationId = params.operationId;
    const idempotencyKey = params.idempotencyKey;
    const generatorLocalId = params.generatorLocalId;
    assert.equal(typeof operationId, "string");
    assert.equal(typeof idempotencyKey, "string");
    assert.equal(typeof generatorLocalId, "string");

    const operation = f.coordinator.prepare({
      operationId,
      idempotencyKey,
      owner,
      actorSource: "deployer-module",
      targetKey: generatorOperationTargetKey(generatorLocalId),
      operationKind: "deployer.module-lifecycle-fixture",
      schemaVersion: 1,
      desiredFingerprint: "d".repeat(64),
      provenance: {
        source: "p033-deployer-module"
      },
      preconditions: [{
        key: "module-lifecycle",
        observedAt: f.now().toISOString(),
        maxAgeMs: 60_000,
        evidenceRef: operationId
      }]
    });
    f.manager.lifecycleStore.recordUnresolvedEvidence(
      DEPLOYER_MODULE_ID,
      "OPERATION",
      operation.operationId
    );
    return {
      operationId: operation.operationId,
      state: operation.state,
      claimEpoch: operation.claimEpoch
    };
  };
}

function runtimeOwner(registration) {
  return {
    kind: "MODULE",
    moduleId: DEPLOYER_MODULE_ID,
    moduleVersion: registration.activeVersion,
    runtimeGeneration: registration.runtimeGeneration
  };
}

test("P033 Deployer .pcmsmod update disable crash and rollback preserve Core operation evidence", async () => {
  const f = await fixture();
  const runtimes = [];
  try {
    const installed = await f.manager.installPackage(
      createDeployerModulePackage("1.0.0")
    );
    assert.equal(installed.package.moduleId, DEPLOYER_MODULE_ID);
    assert.equal(installed.package.version, "1.0.0");
    assert.equal(installed.registration.runtimeGeneration, 1);

    const runtimeV1 = await f.manager.startActiveRuntime(
      DEPLOYER_MODULE_ID,
      {
        sdkHandlers: {
          "operations.deployer.prepare":
            operationSdkHandler(
              f,
              runtimeOwner(installed.registration)
            )
        }
      }
    );
    runtimes.push(runtimeV1);
    assert.deepEqual(
      await runtimeV1.request("describe", {}),
      {
        id: DEPLOYER_MODULE_ID,
        version: "1.0.0",
        runtimeGeneration: 1
      }
    );
    await runtimeV1.request("store", {
      key: "release-marker",
      value: "state-v1"
    });

    const first = await runtimeV1.request("beginOperation", {
      operationId: "operation-p033-before-update",
      idempotencyKey: "request-p033-before-update",
      generatorLocalId: "generator-p033-before-update"
    });
    assert.equal(first.state, "PREPARED");
    assert.equal(
      f.coordinator.require(first.operationId).owner.runtimeGeneration,
      1
    );

    const updated = await f.manager.updatePackage(
      createDeployerModulePackage("1.1.0")
    );
    assert.equal(updated.status, "ACTIVE");
    assert.equal(updated.registration.activeVersion, "1.1.0");
    assert.equal(updated.registration.runtimeGeneration, 2);
    assert.equal(updated.stateGeneration, 2);
    assert.equal(
      f.coordinator.require(first.operationId).state,
      "PREPARED"
    );
    assert.equal(
      f.coordinator.getUnresolvedClaim(
        generatorOperationTargetKey(
          "generator-p033-before-update"
        )
      )?.operationId,
      first.operationId
    );
    assert.deepEqual(
      f.manager.lifecycleStore
        .listUnresolvedEvidence(DEPLOYER_MODULE_ID)
        .map((entry) => entry.evidenceId),
      [first.operationId]
    );

    await assert.rejects(
      () => runtimeV1.request("beginOperation", {
        operationId: "operation-p033-stale-runtime",
        idempotencyKey: "request-p033-stale-runtime",
        generatorLocalId: "generator-p033-stale-runtime"
      }),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RUNTIME_STALE"
    );

    const runtimeV2 = await f.manager.startActiveRuntime(
      DEPLOYER_MODULE_ID,
      {
        sdkHandlers: {
          "operations.deployer.prepare":
            operationSdkHandler(
              f,
              runtimeOwner(updated.registration)
            )
        }
      }
    );
    runtimes.push(runtimeV2);
    await runtimeV2.request("store", {
      key: "release-marker",
      value: "state-v2"
    });
    const second = await runtimeV2.request("beginOperation", {
      operationId: "operation-p033-before-crash",
      idempotencyKey: "request-p033-before-crash",
      generatorLocalId: "generator-p033-before-crash"
    });
    assert.equal(second.state, "PREPARED");

    await assert.rejects(
      () => runtimeV2.request("crash", {}),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RUNTIME_LOST"
    );
    assert.equal(runtimeV2.state, "DEGRADED");
    assert.equal(
      f.coordinator.require(second.operationId).state,
      "PREPARED"
    );
    assert.equal(
      f.coordinator.getUnresolvedClaim(
        generatorOperationTargetKey(
          "generator-p033-before-crash"
        )
      )?.operationId,
      second.operationId
    );

    const disabled =
      f.manager.lifecycleStore.disableModule(
        DEPLOYER_MODULE_ID,
        2
      );
    assert.equal(disabled.status, "DISABLED");
    assert.equal(disabled.runtimeGeneration, 3);
    assert.equal(
      f.coordinator.require(first.operationId).state,
      "PREPARED"
    );
    assert.equal(
      f.coordinator.require(second.operationId).state,
      "PREPARED"
    );
    assert.deepEqual(
      f.manager.lifecycleStore
        .listUnresolvedEvidence(DEPLOYER_MODULE_ID)
        .map((entry) => entry.evidenceId)
        .sort(),
      [first.operationId, second.operationId].sort()
    );

    const enabled =
      f.manager.lifecycleStore.enableModule(
        DEPLOYER_MODULE_ID,
        3
      );
    assert.equal(enabled.status, "ENABLED");
    assert.equal(enabled.runtimeGeneration, 4);

    const rollback =
      f.manager.lifecycleStore.rollbackToRetainedGeneration(
        DEPLOYER_MODULE_ID,
        1,
        4
      );
    assert.equal(rollback.activeVersion, "1.0.0");
    assert.equal(rollback.runtimeGeneration, 5);
    assert.deepEqual(
      f.manager.stateStore.readActiveState(
        DEPLOYER_MODULE_ID
      ).state,
      {
        "release-marker": "state-v1"
      }
    );
    assert.equal(
      f.coordinator.require(first.operationId).state,
      "PREPARED"
    );
    assert.equal(
      f.coordinator.require(second.operationId).state,
      "PREPARED"
    );
    assert.equal(
      f.manager.lifecycleStore
        .listUnresolvedEvidence(DEPLOYER_MODULE_ID)
        .length,
      2
    );

    const rolledBackRuntime =
      await f.manager.startActiveRuntime(
        DEPLOYER_MODULE_ID
      );
    runtimes.push(rolledBackRuntime);
    assert.deepEqual(
      await rolledBackRuntime.request("describe", {}),
      {
        id: DEPLOYER_MODULE_ID,
        version: "1.0.0",
        runtimeGeneration: 5
      }
    );
    assert.deepEqual(
      await rolledBackRuntime.request("load", {
        key: "release-marker"
      }),
      {
        found: true,
        value: "state-v1"
      }
    );
  } finally {
    for (const runtime of runtimes.reverse()) {
      await runtime.stop().catch(() => undefined);
    }
    await f.cleanup();
  }
});
