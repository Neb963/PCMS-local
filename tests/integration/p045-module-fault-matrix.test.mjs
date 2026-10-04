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
  createReferenceModulePackage,
  REFERENCE_MODULE_ID
} from "../helpers/reference-module-fixture.mjs";

function operationInput(suffix, owner) {
  return {
    operationId: "p045-module-op-" + suffix,
    idempotencyKey: "p045-module-key-" + suffix,
    owner,
    actorSource: "p045-module-matrix",
    targetKey: generatorOperationTargetKey(
      "p045-module-generator-" + suffix
    ),
    operationKind: "p045-module-fault-matrix",
    schemaVersion: 1,
    desiredFingerprint: "d".repeat(64),
    provenance: { source: "p045-module-matrix" },
    preconditions: [{
      key: "session",
      observedAt: new Date().toISOString(),
      maxAgeMs: 60_000,
      evidenceRef: "p045-module-evidence-" + suffix
    }]
  };
}

function completeCoreOperation(coordinator, suffix) {
  const operation = coordinator.prepare(
    operationInput(suffix, { kind: "CORE" })
  );
  coordinator.authorizeDispatch({
    operationId: operation.operationId,
    expectedClaimEpoch: operation.claimEpoch,
    evidence: { step: "synthetic" }
  });
  coordinator.beginVerification(
    operation.operationId,
    operation.claimEpoch
  );
  return coordinator.markSucceeded(
    operation.operationId,
    operation.claimEpoch
  );
}

test("P045 module crash update and disable preserve evidence and unrelated Core work", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "pcms-p045-module-matrix-")
  );
  const database = openConfiguredSqliteDatabase(
    join(root, "pcms.db")
  );
  applyPcmsMigrations(database);
  const manager = new ModuleManager(database, {
    packageRoot: join(root, "modules")
  });
  const coordinator = new OperationCoordinator({
    database
  });
  let runtime;

  try {
    const installed = await manager.installPackage(
      createReferenceModulePackage("1.0.0", {
        backendSource: `
          export function createModule(context) {
            return {
              handle(method) {
                if (method === "describe") {
                  return {
                    id: context.module.id,
                    version: context.module.version,
                    runtimeGeneration:
                      context.module.runtimeGeneration
                  };
                }
                if (method === "crash") {
                  process.exit(23);
                }
                throw new Error("unsupported");
              }
            };
          }
        `
      })
    );
    runtime = await manager.startActiveRuntime(
      REFERENCE_MODULE_ID
    );
    assert.equal(
      (await runtime.request("describe", {})).runtimeGeneration,
      1
    );

    await assert.rejects(
      () => runtime.request("crash", {}),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RUNTIME_LOST"
    );
    assert.equal(runtime.state, "DEGRADED");

    const afterCrash = completeCoreOperation(
      coordinator,
      "after-crash"
    );
    assert.equal(afterCrash.state, "SUCCEEDED");

    const updated = await manager.updatePackage(
      createReferenceModulePackage("1.1.0")
    );
    assert.equal(updated.status, "ACTIVE");
    assert.equal(
      updated.registration.runtimeGeneration,
      2
    );

    const unresolved = coordinator.prepare(
      operationInput(
        "module-unresolved",
        {
          kind: "MODULE",
          moduleId: REFERENCE_MODULE_ID,
          moduleVersion: "1.1.0",
          runtimeGeneration: 2
        }
      )
    );
    assert.equal(unresolved.state, "PREPARED");

    const disabled =
      manager.lifecycleStore.disableModule(
        REFERENCE_MODULE_ID,
        2
      );
    assert.equal(disabled.status, "DISABLED");
    assert.equal(disabled.runtimeGeneration, 3);

    assert.equal(
      coordinator.require(unresolved.operationId).state,
      "PREPARED"
    );
    assert.equal(
      coordinator.getUnresolvedClaim(
        unresolved.targetKey
      )?.operationId,
      unresolved.operationId
    );

    const afterDisable = completeCoreOperation(
      coordinator,
      "after-disable"
    );
    assert.equal(afterDisable.state, "SUCCEEDED");
  } finally {
    if (runtime !== undefined) {
      await runtime.stop().catch(() => undefined);
    }
    database.close();
    await rm(root, {
      recursive: true,
      force: true
    });
  }
});
