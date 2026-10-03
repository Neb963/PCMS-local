import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OperationalStatistics
} from "../../dist/statistics/operational-statistics.js";
import {
  openPcmsDatabase
} from "../../dist/storage/database.js";

function insertOperation(
  database,
  {
    id,
    state,
    operationKind,
    targetKey,
    createdAt,
    updatedAt,
    dispatchAuthorizedAt = null,
    terminalAt = null
  }
) {
  database.prepare(`
    INSERT INTO operations (
      operation_id,
      idempotency_key,
      state,
      target_key,
      operation_kind,
      schema_version,
      owner_kind,
      actor_source,
      desired_fingerprint,
      provenance_json,
      preconditions_json,
      attempt,
      claim_epoch,
      dispatch_authorized_at,
      created_at,
      updated_at,
      terminal_at
    ) VALUES (?, ?, ?, ?, ?, 1, 'CORE', 'p041-test',
      ?, '{}', '[]', 1, 1, ?, ?, ?, ?)
  `).run(
    id,
    `idempotency-${id}`,
    state,
    targetKey,
    operationKind,
    "a".repeat(64),
    dispatchAuthorizedAt,
    createdAt,
    updatedAt,
    terminalAt
  );
}

test("Statistics derives read-only aggregates from authoritative operation facts", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "pcms-p041-statistics-")
  );
  const databasePath = join(root, "pcms.db");
  const database = openPcmsDatabase(databasePath);

  try {
    insertOperation(database.connection, {
      id: "op-success",
      state: "SUCCEEDED",
      operationKind: "deploy",
      targetKey: "generator:success",
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:01:00.000Z",
      dispatchAuthorizedAt: "2026-10-04T00:00:30.000Z",
      terminalAt: "2026-10-04T00:01:00.000Z"
    });
    insertOperation(database.connection, {
      id: "op-failed-safe",
      state: "FAILED_SAFE",
      operationKind: "deploy",
      targetKey: "generator:failed",
      createdAt: "2026-10-04T00:02:00.000Z",
      updatedAt: "2026-10-04T00:03:00.000Z",
      terminalAt: "2026-10-04T00:03:00.000Z"
    });
    insertOperation(database.connection, {
      id: "op-uncertain",
      state: "UNCERTAIN",
      operationKind: "refresh",
      targetKey: "generator:uncertain",
      createdAt: "2026-10-04T00:04:00.000Z",
      updatedAt: "2026-10-04T00:05:00.000Z",
      dispatchAuthorizedAt: "2026-10-04T00:04:30.000Z"
    });
    insertOperation(database.connection, {
      id: "op-prepared",
      state: "PREPARED",
      operationKind: "provision",
      targetKey: "account:prepared",
      createdAt: "2026-10-04T00:06:00.000Z",
      updatedAt: "2026-10-04T00:06:00.000Z"
    });

    const before = database.connection.prepare(`
      SELECT operation_id, state, revision
      FROM operations
      ORDER BY operation_id
    `).all();

    const statistics =
      new OperationalStatistics(databasePath);
    try {
      const snapshot = statistics.snapshot();
      assert.equal(snapshot.totalOperations, 4);
      assert.equal(snapshot.unresolvedOperations, 2);
      assert.equal(snapshot.terminalOperations, 2);
      assert.deepEqual(snapshot.byState, [
        { state: "FAILED_SAFE", count: 1 },
        { state: "PREPARED", count: 1 },
        { state: "SUCCEEDED", count: 1 },
        { state: "UNCERTAIN", count: 1 }
      ]);
      assert.deepEqual(snapshot.byOperationKind, [
        { operationKind: "deploy", count: 2 },
        { operationKind: "provision", count: 1 },
        { operationKind: "refresh", count: 1 }
      ]);
      assert.deepEqual(snapshot.byOwnerKind, [
        { ownerKind: "CORE", count: 4 }
      ]);
      assert.equal(
        snapshot.oldestCreatedAt,
        "2026-10-04T00:00:00.000Z"
      );
      assert.equal(
        snapshot.latestUpdatedAt,
        "2026-10-04T00:06:00.000Z"
      );
    } finally {
      statistics.close();
    }

    assert.deepEqual(
      database.connection.prepare(`
        SELECT operation_id, state, revision
        FROM operations
        ORDER BY operation_id
      `).all(),
      before
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
