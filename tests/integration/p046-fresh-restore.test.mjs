import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCoreStateBackup
} from "../../dist/backup/core-backup.js";
import {
  restoreCoreStateBackup
} from "../../dist/backup/core-restore.js";
import {
  HumanTaskStore,
  HumanTaskStoreError
} from "../../dist/human-tasks/human-task-store.js";
import {
  OperationCoordinator,
  generatorOperationTargetKey
} from "../../dist/operations/operation-coordinator.js";
import {
  readRecoveryControl
} from "../../dist/recovery/recovery-control.js";
import {
  openPcmsDatabase
} from "../../dist/storage/database.js";

const NOW = "2026-10-04T02:30:00.000Z";

function operationInput(operationId, targetId) {
  return {
    operationId,
    idempotencyKey: "request-" + operationId,
    owner: { kind: "CORE" },
    actorSource: "p046-fresh-restore",
    targetKey: generatorOperationTargetKey(targetId),
    operationKind: "p046.release-restore",
    schemaVersion: 1,
    desiredFingerprint: "6".repeat(64),
    provenance: {
      source: "p046-release-drill"
    },
    preconditions: [{
      key: "provider-state",
      observedAt: NOW,
      maxAgeMs: 60_000,
      evidenceRef: operationId + ":provider-state"
    }]
  };
}

test("P046 fresh-install restore preserves unresolved operation and HumanTask state without replay", async () => {
  const outer = await mkdtemp(
    join(tmpdir(), "pcms-p046-fresh-restore-")
  );
  const sourceRoot = join(outer, "source");
  const backupRoot = join(outer, "backups");
  const freshRoot = join(outer, "fresh-install");
  const now = () => new Date(NOW);
  await mkdir(join(sourceRoot, "modules"), {
    recursive: true
  });

  const source = openPcmsDatabase(
    join(sourceRoot, "pcms.db"),
    { now }
  );
  let sourceClosed = false;

  try {
    const coordinator = new OperationCoordinator({
      database: source.connection,
      now
    });

    const uncertain = coordinator.prepare(
      operationInput(
        "operation-p046-uncertain",
        "generator-p046-uncertain"
      )
    );
    coordinator.authorizeDispatch({
      operationId: uncertain.operationId,
      expectedClaimEpoch: uncertain.claimEpoch,
      evidence: {
        step: "provider-mutation"
      }
    });
    const uncertainAfterLoss =
      coordinator.recordExecutionLoss({
        operationId: uncertain.operationId,
        expectedClaimEpoch: uncertain.claimEpoch,
        source: "NETWORK",
        effectState: "MAY_HAVE_OCCURRED"
      });
    assert.equal(
      uncertainAfterLoss.state,
      "UNCERTAIN"
    );

    const needsHuman = coordinator.prepare(
      operationInput(
        "operation-p046-human",
        "generator-p046-human"
      )
    );
    coordinator.authorizeDispatch({
      operationId: needsHuman.operationId,
      expectedClaimEpoch: needsHuman.claimEpoch,
      evidence: {
        step: "provider-verification"
      }
    });
    coordinator.beginVerification(
      needsHuman.operationId,
      needsHuman.claimEpoch
    );
    const humanOperation = coordinator.markNeedsHuman(
      needsHuman.operationId,
      needsHuman.claimEpoch,
      "verification-required"
    );
    assert.equal(humanOperation.state, "NEEDS_HUMAN");

    const tasks = new HumanTaskStore({
      database: source.connection,
      now
    });
    const task = tasks.create({
      taskId: "human-task-p046-restore",
      taskType: "VERIFICATION_REQUIRED",
      operationId: needsHuman.operationId,
      title: "Verification required",
      explanation:
        "Re-enter the verification value after recovery.",
      requiredActionKind: "ENTER_VERIFICATION_CODE",
      continuation: {
        kind: "PROVIDER_VERIFICATION",
        version: 1,
        ref: "operation-p046-human:verification"
      },
      evidence: {
        provider: "perchance",
        challengeKind: "verification"
      },
      expiresAt: "2026-10-04T02:45:00.000Z"
    });
    assert.equal(task.status, "OPEN");
    tasks.submitTransientInput(
      task.taskId,
      "VERIFICATION_CODE",
      "P046-TRANSIENT-DO-NOT-BACKUP",
      10 * 60 * 1000
    );

    const backup = await createCoreStateBackup({
      database: source.connection,
      liveDataRoot: sourceRoot,
      modulePackageRoot: join(sourceRoot, "modules"),
      backupRoot,
      now
    });

    source.close();
    sourceClosed = true;

    const restored = await restoreCoreStateBackup({
      backupDirectory: backup.directory,
      liveDataRoot: freshRoot,
      now
    });
    assert.equal(restored.safetyDirectory, null);
    assert.equal(
      restored.assessment.mode,
      "RECOVERY_HOLD"
    );
    assert.deepEqual(
      restored.assessment.unresolvedOperationIds,
      [
        "operation-p046-human",
        "operation-p046-uncertain"
      ]
    );
    assert.equal(
      restored.assessment.externalState,
      "UNKNOWN_RECONCILIATION_REQUIRED"
    );

    const database = openPcmsDatabase(
      join(freshRoot, "pcms.db"),
      { now }
    );
    try {
      assert.equal(
        readRecoveryControl(database.connection).mode,
        "RECOVERY_HOLD"
      );

      const restoredCoordinator =
        new OperationCoordinator({
          database: database.connection,
          now
        });
      const restoredHuman = restoredCoordinator.require(
        "operation-p046-human"
      );
      const restoredUncertain =
        restoredCoordinator.require(
          "operation-p046-uncertain"
        );
      assert.equal(
        restoredHuman.state,
        "NEEDS_HUMAN"
      );
      assert.equal(
        restoredUncertain.state,
        "UNCERTAIN"
      );
      assert.equal(
        restoredCoordinator.getUnresolvedClaim(
          generatorOperationTargetKey(
            "generator-p046-human"
          )
        )?.operationId,
        restoredHuman.operationId
      );
      assert.equal(
        restoredCoordinator.getUnresolvedClaim(
          generatorOperationTargetKey(
            "generator-p046-uncertain"
          )
        )?.operationId,
        restoredUncertain.operationId
      );

      const restoredTasks = new HumanTaskStore({
        database: database.connection,
        now
      });
      assert.deepEqual(
        restoredTasks.require(
          "human-task-p046-restore"
        ),
        {
          taskId: "human-task-p046-restore",
          taskType: "VERIFICATION_REQUIRED",
          status: "OPEN",
          accountId: null,
          personaUid: null,
          operationId: "operation-p046-human",
          title: "Verification required",
          explanation:
            "Re-enter the verification value after recovery.",
          requiredActionKind:
            "ENTER_VERIFICATION_CODE",
          continuation: {
            kind: "PROVIDER_VERIFICATION",
            version: 1,
            ref: "operation-p046-human:verification"
          },
          evidence: {
            challengeKind: "verification",
            provider: "perchance"
          },
          expiresAt:
            "2026-10-04T02:45:00.000Z",
          createdAt: NOW,
          updatedAt: NOW,
          resolvedAt: null,
          revision: 0
        }
      );
      assert.throws(
        () =>
          restoredTasks.consumeTransientInput(
            "human-task-p046-restore",
            "VERIFICATION_CODE"
          ),
        (error) =>
          error instanceof HumanTaskStoreError &&
          error.code === "HUMAN_INPUT_UNAVAILABLE"
      );

      assert.equal(
        restoredCoordinator.require(
          "operation-p046-human"
        ).state,
        "NEEDS_HUMAN"
      );
      assert.equal(
        restoredCoordinator.require(
          "operation-p046-uncertain"
        ).state,
        "UNCERTAIN"
      );
    } finally {
      database.close();
    }
  } finally {
    if (!sourceClosed && source.connection.isOpen) {
      source.close();
    }
    await rm(outer, {
      recursive: true,
      force: true
    });
  }
});
