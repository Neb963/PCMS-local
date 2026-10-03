import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OperationCoordinator,
  OperationCoordinatorError,
  generatorOperationTargetKey
} from "../../dist/operations/operation-coordinator.js";
import {
  ModuleLifecycleStore
} from "../../dist/modules/lifecycle-store.js";
import {
  ModuleStateStore
} from "../../dist/modules/state-store.js";
import {
  ensurePcmsDirectories,
  resolvePcmsPaths
} from "../../dist/config/paths.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const paths = resolvePcmsPaths({
    env: {
      PCMS_CONFIG_ROOT: join(root, "config"),
      PCMS_DATA_ROOT: join(root, "data"),
      PCMS_CACHE_ROOT: join(root, "cache")
    },
    homeDir: root
  });
  await ensurePcmsDirectories(paths);
  const database = openConfiguredSqliteDatabase(paths.databasePath);
  applyPcmsMigrations(database);
  let nowMs = Date.parse("2026-10-03T14:00:00.000Z");
  const coordinator = new OperationCoordinator({
    database,
    now: () => new Date(nowMs)
  });
  return {
    root,
    database,
    coordinator,
    now() {
      return new Date(nowMs);
    },
    advance(milliseconds) {
      nowMs += milliseconds;
    }
  };
}

function precondition(observedAt, maxAgeMs = 60_000) {
  return {
    key: "provider-session",
    observedAt,
    maxAgeMs,
    evidenceRef: "session-evidence-1"
  };
}

function input({
  operationId = "operation-1",
  idempotencyKey = "request-1",
  targetKey = generatorOperationTargetKey("generator-1"),
  preconditions = [precondition("2026-10-03T14:00:00.000Z")]
} = {}) {
  return {
    operationId,
    idempotencyKey,
    owner: { kind: "CORE" },
    actorSource: "operator",
    targetKey,
    operationKind: "generator-update",
    schemaVersion: 1,
    desiredFingerprint: "a".repeat(64),
    provenance: {
      source: "p027-test",
      version: 1
    },
    preconditions
  };
}

test("P027 target claims are exclusive, idempotent and monotonically fenced", async () => {
  const f = await fixture("pcms-operation-claim-");
  const targetKey = generatorOperationTargetKey("generator-1");

  try {
    const first = f.coordinator.prepare(input());
    assert.equal(first.state, "PREPARED");
    assert.equal(first.claimEpoch, 1);
    assert.equal(first.targetKey, targetKey);

    const retried = f.coordinator.prepare(input({
      operationId: "different-operation-id",
      idempotencyKey: "request-1"
    }));
    assert.equal(retried.operationId, first.operationId);
    assert.equal(retried.claimEpoch, 1);

    assert.throws(
      () => f.coordinator.prepare(input({
        operationId: "operation-2",
        idempotencyKey: "request-2"
      })),
      (error) => {
        assert.ok(error instanceof OperationCoordinatorError);
        assert.equal(error.code, "OPERATION_TARGET_CLAIMED");
        return true;
      }
    );

    const permit = f.coordinator.authorizeDispatch({
      operationId: first.operationId,
      expectedClaimEpoch: first.claimEpoch,
      evidence: {
        step: "save",
        providerProfile: "emulator"
      }
    });
    assert.equal(permit.claimEpoch, 1);
    assert.equal(f.coordinator.require(first.operationId).state, "RUNNING");

    const verifying = f.coordinator.beginVerification(
      first.operationId,
      first.claimEpoch
    );
    assert.equal(verifying.state, "VERIFYING");

    const succeeded = f.coordinator.markSucceeded(
      first.operationId,
      first.claimEpoch
    );
    assert.equal(succeeded.state, "SUCCEEDED");

    const second = f.coordinator.prepare(input({
      operationId: "operation-2",
      idempotencyKey: "request-2"
    }));
    assert.equal(second.claimEpoch, 2);

    assert.throws(
      () => f.coordinator.authorizeDispatch({
        operationId: second.operationId,
        expectedClaimEpoch: first.claimEpoch,
        evidence: { step: "stale-dispatch" }
      }),
      (error) => {
        assert.ok(error instanceof OperationCoordinatorError);
        assert.equal(error.code, "OPERATION_CLAIM_STALE");
        return true;
      }
    );
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P027 dispatch authorization refuses stale preflight and accepts refreshed durable evidence", async () => {
  const f = await fixture("pcms-operation-preflight-");

  try {
    const operation = f.coordinator.prepare(input({
      operationId: "operation-stale",
      idempotencyKey: "request-stale",
      preconditions: [
        precondition("2026-10-03T13:58:00.000Z", 60_000)
      ]
    }));

    assert.throws(
      () => f.coordinator.authorizeDispatch({
        operationId: operation.operationId,
        expectedClaimEpoch: operation.claimEpoch,
        evidence: { step: "save" }
      }),
      (error) => {
        assert.ok(error instanceof OperationCoordinatorError);
        assert.equal(error.code, "OPERATION_PREFLIGHT_STALE");
        return true;
      }
    );
    assert.equal(
      f.coordinator.require(operation.operationId).state,
      "PREPARED"
    );

    const refreshed = f.coordinator.refreshPreconditions(
      operation.operationId,
      operation.claimEpoch,
      [precondition(f.now().toISOString(), 60_000)]
    );
    assert.equal(refreshed.state, "PREPARED");
    assert.equal(refreshed.revision, 1);

    const permit = f.coordinator.authorizeDispatch({
      operationId: operation.operationId,
      expectedClaimEpoch: operation.claimEpoch,
      evidence: {
        step: "save",
        capability: "generator-save"
      }
    });
    assert.equal(permit.authorizedAt, f.now().toISOString());

    const running = f.coordinator.require(operation.operationId);
    assert.equal(running.state, "RUNNING");
    assert.equal(running.dispatchAuthorizedAt, f.now().toISOString());
    assert.deepEqual(running.dispatchEvidence, {
      capability: "generator-save",
      step: "save"
    });

    f.advance(61_000);
    assert.equal(
      f.coordinator.require(operation.operationId).state,
      "RUNNING",
      "preconditions are checked at the dispatch boundary, not retroactively"
    );
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});


test("P027 possible-dispatch loss becomes UNCERTAIN while proven non-dispatch is FAILED_SAFE", async () => {
  const f = await fixture("pcms-operation-loss-");

  try {
    const uncertain = f.coordinator.prepare(input({
      operationId: "operation-loss-uncertain",
      idempotencyKey: "request-loss-uncertain"
    }));
    f.coordinator.authorizeDispatch({
      operationId: uncertain.operationId,
      expectedClaimEpoch: uncertain.claimEpoch,
      evidence: { step: "save" }
    });
    const lost = f.coordinator.recordExecutionLoss({
      operationId: uncertain.operationId,
      expectedClaimEpoch: uncertain.claimEpoch,
      source: "BROWSER",
      effectState: "MAY_HAVE_OCCURRED"
    });
    assert.equal(lost.state, "UNCERTAIN");
    assert.equal(
      lost.lastTransitionReason,
      "browser-loss-after-possible-dispatch"
    );
    assert.equal(
      f.coordinator.getUnresolvedClaim(uncertain.targetKey)?.operationId,
      uncertain.operationId
    );

    assert.throws(
      () => f.coordinator.prepare(input({
        operationId: "operation-loss-blocked",
        idempotencyKey: "request-loss-blocked"
      })),
      (error) => {
        assert.ok(error instanceof OperationCoordinatorError);
        assert.equal(error.code, "OPERATION_TARGET_CLAIMED");
        return true;
      }
    );
    assert.throws(
      () => f.coordinator.authorizeDispatch({
        operationId: uncertain.operationId,
        expectedClaimEpoch: uncertain.claimEpoch,
        evidence: { step: "blind-retry" }
      }),
      (error) => {
        assert.ok(error instanceof OperationCoordinatorError);
        assert.equal(error.code, "OPERATION_INVALID_TRANSITION");
        return true;
      }
    );

    const moduleTarget = generatorOperationTargetKey("generator-module-loss");
    const moduleLost = f.coordinator.prepare(input({
      operationId: "operation-module-loss",
      idempotencyKey: "request-module-loss",
      targetKey: moduleTarget
    }));
    f.coordinator.authorizeDispatch({
      operationId: moduleLost.operationId,
      expectedClaimEpoch: moduleLost.claimEpoch,
      evidence: { step: "save" }
    });
    assert.equal(
      f.coordinator.recordExecutionLoss({
        operationId: moduleLost.operationId,
        expectedClaimEpoch: moduleLost.claimEpoch,
        source: "MODULE",
        effectState: "MAY_HAVE_OCCURRED"
      }).state,
      "UNCERTAIN"
    );

    const safeTarget = generatorOperationTargetKey("generator-safe");
    const safe = f.coordinator.prepare(input({
      operationId: "operation-loss-safe",
      idempotencyKey: "request-loss-safe",
      targetKey: safeTarget
    }));
    f.coordinator.authorizeDispatch({
      operationId: safe.operationId,
      expectedClaimEpoch: safe.claimEpoch,
      evidence: { step: "save" }
    });
    const failedSafe = f.coordinator.recordExecutionLoss({
      operationId: safe.operationId,
      expectedClaimEpoch: safe.claimEpoch,
      source: "BROWSER",
      effectState: "NOT_DISPATCHED"
    });
    assert.equal(failedSafe.state, "FAILED_SAFE");
    assert.equal(f.coordinator.getUnresolvedClaim(safeTarget), null);
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P027 cancellation is clean only before dispatch and becomes UNCERTAIN afterwards", async () => {
  const f = await fixture("pcms-operation-cancel-");

  try {
    const prepared = f.coordinator.prepare(input({
      operationId: "operation-cancel-prepared",
      idempotencyKey: "request-cancel-prepared"
    }));
    const cancelled = f.coordinator.requestCancellation(
      prepared.operationId,
      prepared.claimEpoch
    );
    assert.equal(cancelled.state, "CANCELLED");
    assert.ok(cancelled.cancellationRequestedAt);
    assert.ok(cancelled.terminalAt);

    const dispatchedTarget = generatorOperationTargetKey("generator-dispatched");
    const dispatched = f.coordinator.prepare(input({
      operationId: "operation-cancel-dispatched",
      idempotencyKey: "request-cancel-dispatched",
      targetKey: dispatchedTarget
    }));
    f.coordinator.authorizeDispatch({
      operationId: dispatched.operationId,
      expectedClaimEpoch: dispatched.claimEpoch,
      evidence: { step: "save" }
    });
    const uncertain = f.coordinator.requestCancellation(
      dispatched.operationId,
      dispatched.claimEpoch
    );
    assert.equal(uncertain.state, "UNCERTAIN");
    assert.equal(uncertain.terminalAt, null);
    assert.ok(uncertain.cancellationRequestedAt);
    assert.equal(
      f.coordinator.getUnresolvedClaim(dispatchedTarget)?.operationId,
      dispatched.operationId
    );

    const repeated = f.coordinator.requestCancellation(
      dispatched.operationId,
      dispatched.claimEpoch,
      "operator-cancelled-again"
    );
    assert.equal(repeated.state, "UNCERTAIN");
    assert.equal(repeated.terminalAt, null);
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P027 explicit startup recovery converts interrupted dispatched states to UNCERTAIN", async () => {
  const f = await fixture("pcms-operation-recover-");

  try {
    const running = f.coordinator.prepare(input({
      operationId: "operation-recover-running",
      idempotencyKey: "request-recover-running",
      targetKey: generatorOperationTargetKey("generator-running")
    }));
    f.coordinator.authorizeDispatch({
      operationId: running.operationId,
      expectedClaimEpoch: running.claimEpoch,
      evidence: { step: "save" }
    });

    const verifying = f.coordinator.prepare(input({
      operationId: "operation-recover-verifying",
      idempotencyKey: "request-recover-verifying",
      targetKey: generatorOperationTargetKey("generator-verifying")
    }));
    f.coordinator.authorizeDispatch({
      operationId: verifying.operationId,
      expectedClaimEpoch: verifying.claimEpoch,
      evidence: { step: "save" }
    });
    f.coordinator.beginVerification(
      verifying.operationId,
      verifying.claimEpoch
    );

    const untouched = f.coordinator.prepare(input({
      operationId: "operation-recover-prepared",
      idempotencyKey: "request-recover-prepared",
      targetKey: generatorOperationTargetKey("generator-prepared")
    }));

    const recovered = f.coordinator.recoverInterrupted();
    assert.deepEqual(
      recovered.map((item) => item.operationId).sort(),
      [running.operationId, verifying.operationId].sort()
    );
    assert.equal(
      f.coordinator.require(running.operationId).state,
      "UNCERTAIN"
    );
    assert.equal(
      f.coordinator.require(verifying.operationId).state,
      "UNCERTAIN"
    );
    assert.equal(
      f.coordinator.require(untouched.operationId).state,
      "PREPARED"
    );
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});


test("P027 module runtime generation is revalidated immediately before dispatch", async () => {
  const f = await fixture("pcms-operation-module-fence-");
  const state = new ModuleStateStore(f.database, {
    now: () => f.now()
  });
  const lifecycle = new ModuleLifecycleStore(f.database, {
    now: () => f.now()
  });

  try {
    state.registerModule("fixture.operation", "1.0.0", 1, {});
    const operation = f.coordinator.prepare({
      ...input({
        operationId: "operation-module-fence",
        idempotencyKey: "request-module-fence",
        targetKey: generatorOperationTargetKey("generator-module-fence")
      }),
      owner: {
        kind: "MODULE",
        moduleId: "fixture.operation",
        moduleVersion: "1.0.0",
        runtimeGeneration: 1
      }
    });

    assert.deepEqual(
      lifecycle.listUnresolvedEvidence("fixture.operation")
        .map((entry) => [entry.kind, entry.evidenceId]),
      [["OPERATION", operation.operationId]]
    );

    const disabled = lifecycle.disableModule("fixture.operation", 1);
    assert.equal(disabled.runtimeGeneration, 2);
    assert.equal(disabled.status, "DISABLED");

    assert.throws(
      () => f.coordinator.authorizeDispatch({
        operationId: operation.operationId,
        expectedClaimEpoch: operation.claimEpoch,
        evidence: { step: "save" }
      }),
      (error) => {
        assert.ok(error instanceof OperationCoordinatorError);
        assert.equal(error.code, "OPERATION_MODULE_OWNER_STALE");
        return true;
      }
    );
    assert.equal(
      f.coordinator.require(operation.operationId).state,
      "PREPARED"
    );
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
