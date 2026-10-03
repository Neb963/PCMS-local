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
