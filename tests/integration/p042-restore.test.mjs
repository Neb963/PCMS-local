import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCoreStateBackup
} from "../../dist/backup/core-backup.js";
import {
  assessRecoveryState,
  restoreCoreStateBackup
} from "../../dist/backup/core-restore.js";
import {
  ProfileBackupError,
  checkPersonaProfileCompatibility,
  createPersonaProfileBackup,
  restorePersonaProfileBackup,
  validatePersonaProfileBackup
} from "../../dist/backup/profile-backup.js";
import { ModuleManager } from "../../dist/modules/manager.js";
import {
  OperationCoordinator,
  generatorOperationTargetKey
} from "../../dist/operations/operation-coordinator.js";
import {
  PersonaProfileLifecycle
} from "../../dist/personas/profile-lifecycle.js";
import {
  DurableScheduler
} from "../../dist/scheduler/durable-scheduler.js";
import {
  BoundedWorkQueue
} from "../../dist/scheduler/work-queue.js";
import { openPcmsDatabase } from "../../dist/storage/database.js";
import {
  createReferenceModulePackage,
  REFERENCE_MODULE_ID
} from "../helpers/reference-module-fixture.mjs";

const CHROMIUM_VERSION = "Chrome/154.0.8037.92";

test("P042 restore keeps overdue schedules held and reports missing local/external state", async () => {
  const outer = await mkdtemp(
    join(tmpdir(), "pcms-p042-restore-")
  );
  const sourceRoot = join(outer, "source");
  const coreBackupRoot = join(outer, "core-backups");
  const profileBackupRoot = join(outer, "profile-backups");
  const restoredRoot = join(outer, "restored");
  const moduleRoot = join(sourceRoot, "modules");
  const personasRoot = join(sourceRoot, "personas");
  await mkdir(sourceRoot, { recursive: true });

  const source = openPcmsDatabase(
    join(sourceRoot, "pcms.db"),
    {
      now: () => new Date("2026-10-04T00:00:00.000Z")
    }
  );

  try {
    const modules = new ModuleManager(source.connection, {
      packageRoot: moduleRoot,
      now: () => new Date("2026-10-04T00:01:00.000Z")
    });
    const installed = await modules.installPackage(
      createReferenceModulePackage("1.0.0")
    );

    const lifecycle = new PersonaProfileLifecycle({
      database: source.connection,
      personasRoot,
      now: () => new Date("2026-10-04T00:02:00.000Z")
    });
    const allocated = await lifecycle.allocate("persona-p042");
    const statePath = join(
      allocated.profilePath,
      "Default",
      "pcms-state.txt"
    );
    await mkdir(join(statePath, ".."), {
      recursive: true
    });
    await writeFile(statePath, "profile-state-round-trip");

    await lifecycle.open("persona-p042");
    await assert.rejects(
      () =>
        createPersonaProfileBackup({
          database: source.connection,
          personasRoot,
          backupRoot: profileBackupRoot,
          personaUid: "persona-p042",
          chromiumVersion: CHROMIUM_VERSION
        }),
      (error) =>
        error instanceof ProfileBackupError &&
        error.code === "PROFILE_BACKUP_PERSONA_OPEN"
    );
    lifecycle.close("persona-p042");

    const profileBackup = await createPersonaProfileBackup({
      database: source.connection,
      personasRoot,
      backupRoot: profileBackupRoot,
      personaUid: "persona-p042",
      chromiumVersion: CHROMIUM_VERSION,
      now: () => new Date("2026-10-04T00:03:00.000Z")
    });
    const profileManifest =
      await validatePersonaProfileBackup(
        profileBackup.directory
      );
    assert.equal(
      checkPersonaProfileCompatibility(profileManifest, {
        chromiumVersion: CHROMIUM_VERSION
      }).reason,
      "EXACT_RUNTIME_MATCH"
    );
    assert.deepEqual(
      checkPersonaProfileCompatibility(profileManifest, {
        chromiumVersion: "Chrome/155.0.0.0"
      }),
      {
        compatible: false,
        reason: "CHROMIUM_VERSION_MISMATCH"
      }
    );
    const incompatibleRestore =
      await restorePersonaProfileBackup({
        backupDirectory: profileBackup.directory,
        destinationPersonasRoot: join(
          outer,
          "incompatible-personas"
        ),
        expectedPersonaUid: "persona-p042",
        chromiumVersion: "Chrome/155.0.0.0"
      });
    assert.deepEqual(
      {
        status: incompatibleRestore.status,
        compatibility: incompatibleRestore.compatibility,
        profilePath: incompatibleRestore.profilePath
      },
      {
        status: "INCOMPATIBLE",
        compatibility: {
          compatible: false,
          reason: "CHROMIUM_VERSION_MISMATCH"
        },
        profilePath: null
      }
    );

    const sourceQueue = new BoundedWorkQueue(4);
    const sourceScheduler = new DurableScheduler({
      database: source.connection,
      queue: sourceQueue,
      now: () => new Date("2026-10-04T00:04:00.000Z")
    });
    sourceScheduler.create({
      scheduleId: "overdue-after-restore",
      operationKind: "provider-mutation",
      schemaVersion: 1,
      targetRef: "generator:restore-target",
      intervalMs: 60_000,
      timeZone: "UTC",
      nextDueAt: "2026-10-01T00:00:00.000Z"
    });

    const coreBackup = await createCoreStateBackup({
      database: source.connection,
      liveDataRoot: sourceRoot,
      modulePackageRoot: moduleRoot,
      backupRoot: coreBackupRoot,
      now: () => new Date("2026-10-04T00:05:00.000Z")
    });

    await mkdir(restoredRoot, { recursive: true });
    await writeFile(
      join(restoredRoot, "old-state.txt"),
      "pre-restore-state"
    );

    const restored = await restoreCoreStateBackup({
      backupDirectory: coreBackup.directory,
      liveDataRoot: restoredRoot,
      profileBackups: [profileBackup.directory],
      targetChromiumVersion: CHROMIUM_VERSION,
      now: () => new Date("2026-10-04T00:06:00.000Z")
    });

    assert.equal(restored.assessment.mode, "RECOVERY_HOLD");
    assert.equal(
      restored.assessment.sourceBackupId,
      coreBackup.manifest.backupId
    );
    assert.equal(
      restored.assessment.externalState,
      "UNKNOWN_RECONCILIATION_REQUIRED"
    );
    assert.deepEqual(restored.assessment.profiles, [{
      personaUid: "persona-p042",
      status: "AVAILABLE"
    }]);
    assert.deepEqual(restored.assessment.modules, [{
      moduleId: REFERENCE_MODULE_ID,
      version: "1.0.0",
      status: "AVAILABLE"
    }]);
    assert.ok(restored.safetyDirectory);
    assert.equal(
      await readFile(
        join(restored.safetyDirectory, "old-state.txt"),
        "utf8"
      ),
      "pre-restore-state"
    );
    assert.equal(
      await readFile(
        join(
          restoredRoot,
          "personas",
          "persona-p042",
          "chromium",
          "Default",
          "pcms-state.txt"
        ),
        "utf8"
      ),
      "profile-state-round-trip"
    );

    const activated = openPcmsDatabase(
      join(restoredRoot, "pcms.db")
    );
    try {
      const queue = new BoundedWorkQueue(4);
      const scheduler = new DurableScheduler({
        database: activated.connection,
        queue,
        now: () => new Date("2026-10-04T12:00:00.000Z")
      });
      const before = scheduler.require("overdue-after-restore");
      const wake = scheduler.wake();
      const after = scheduler.require("overdue-after-restore");
      assert.equal(wake.scanned, 0);
      assert.equal(wake.enqueued, 0);
      assert.equal(queue.size, 0);
      assert.equal(scheduler.claimNext(), null);
      assert.equal(after.nextDueAt, before.nextDueAt);
      assert.equal(after.pendingDispatchId, null);

      const coordinator = new OperationCoordinator({
        database: activated.connection,
        now: () => new Date("2026-10-04T12:00:00.000Z")
      });
      const heldOperation = coordinator.prepare({
        operationId: "operation-recovery-hold",
        idempotencyKey: "recovery-hold-dispatch",
        owner: { kind: "CORE" },
        actorSource: "p042-recovery-test",
        targetKey: generatorOperationTargetKey(
          "recovery-hold-target"
        ),
        operationKind: "provider-mutation",
        schemaVersion: 1,
        desiredFingerprint: "c".repeat(64),
        provenance: { source: "p042" },
        preconditions: [{
          key: "recoveryHold",
          observedAt: "2026-10-04T12:00:00.000Z",
          maxAgeMs: 60_000,
          evidenceRef: "recovery-hold-evidence"
        }]
      });
      assert.throws(
        () => coordinator.authorizeDispatch({
          operationId: heldOperation.operationId,
          expectedClaimEpoch: heldOperation.claimEpoch,
          evidence: { source: "p042" }
        }),
        (error) =>
          error?.code === "OPERATION_RECOVERY_HOLD" &&
          error.retryable === true
      );

      await rm(
        join(
          restoredRoot,
          "personas",
          "persona-p042",
          "chromium"
        ),
        { recursive: true, force: true }
      );
      await rm(
        join(
          restoredRoot,
          "modules",
          REFERENCE_MODULE_ID,
          "1.0.0",
          installed.package.sha256
        ),
        { recursive: true, force: true }
      );
      const degraded = await assessRecoveryState(
        activated.connection,
        restoredRoot
      );
      assert.equal(degraded.localState, "DEGRADED");
      assert.deepEqual(degraded.profiles, [{
        personaUid: "persona-p042",
        status: "MISSING"
      }]);
      assert.deepEqual(degraded.modules, [{
        moduleId: REFERENCE_MODULE_ID,
        version: "1.0.0",
        status: "MISSING"
      }]);
      assert.equal(
        degraded.externalState,
        "UNKNOWN_RECONCILIATION_REQUIRED"
      );
    } finally {
      activated.close();
    }
  } finally {
    source.close();
    await rm(outer, { recursive: true, force: true });
  }
});
