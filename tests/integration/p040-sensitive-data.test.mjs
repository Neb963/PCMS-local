import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HumanTaskStore
} from "../../dist/human-tasks/human-task-store.js";
import { ModuleManager } from "../../dist/modules/manager.js";
import {
  OperationCoordinator,
  personaControlOperationTargetKey
} from "../../dist/operations/operation-coordinator.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";
import {
  createP040FeatureModulePackage,
  PROVISIONING_MODULE_ID
} from "../helpers/p040-feature-module-fixture.mjs";

async function filesUnder(root) {
  const result = [];
  async function visit(path) {
    const metadata = await stat(path);
    if (metadata.isDirectory()) {
      for (const name of await readdir(path)) {
        await visit(join(path, name));
      }
      return;
    }
    if (metadata.isFile()) result.push(path);
  }
  await visit(root);
  return result;
}

test("P040 sensitive transient input is absent from durable records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-p040-sensitive-"));
  const databasePath = join(root, "pcms.db");
  const database = openConfiguredSqliteDatabase(databasePath);
  let databaseClosed = false;
  applyPcmsMigrations(database);
  const sensitiveValue =
    "P040-SENSITIVE-SENTINEL-DO-NOT-PERSIST-90210";
  const now = () =>
    new Date("2026-10-04T03:00:00.000Z");
  let runtime = null;

  try {
    database.prepare(`
      INSERT INTO personas (
        persona_uid,
        lifecycle_status,
        profile_state,
        browser_backend,
        profile_relative_path,
        created_at,
        updated_at,
        revision
      ) VALUES (?, 'ACTIVE', 'CLOSED', 'chromium-v1', ?, ?, ?, 0)
    `).run(
      "persona-p040-sensitive",
      "personas/persona-p040-sensitive/chromium",
      now().toISOString(),
      now().toISOString()
    );

    const coordinator = new OperationCoordinator({
      database,
      now
    });
    const operation = coordinator.prepare({
      operationId: "operation-p040-sensitive",
      idempotencyKey: "request-p040-sensitive",
      owner: { kind: "CORE" },
      actorSource: "p040-sensitive-audit",
      targetKey:
        personaControlOperationTargetKey(
          "persona-p040-sensitive"
        ),
      operationKind: "provisioning.sensitive-audit",
      schemaVersion: 1,
      personaUid: "persona-p040-sensitive",
      desiredFingerprint: "9".repeat(64),
      provenance: {
        source: "p040-sensitive-hygiene",
        credentialRef: "opaque:accounts/p040"
      },
      preconditions: [{
        key: "provider-session",
        observedAt: now().toISOString(),
        maxAgeMs: 60_000,
        evidenceRef: "p040-sensitive-session"
      }]
    });
    coordinator.authorizeDispatch({
      operationId: operation.operationId,
      expectedClaimEpoch: operation.claimEpoch,
      evidence: { step: "verification-challenge" }
    });
    coordinator.beginVerification(
      operation.operationId,
      operation.claimEpoch
    );
    coordinator.markNeedsHuman(
      operation.operationId,
      operation.claimEpoch,
      "verification-code-required"
    );

    const tasks = new HumanTaskStore({
      database,
      now
    });
    const task = tasks.create({
      taskId: "human-task-p040-sensitive",
      taskType: "VERIFICATION_REQUIRED",
      personaUid: "persona-p040-sensitive",
      operationId: operation.operationId,
      title: "Verification required",
      explanation:
        "Enter the one-time verification value to continue.",
      requiredActionKind: "ENTER_VERIFICATION_CODE",
      continuation: {
        kind: "PROVISIONING_VERIFICATION",
        version: 1,
        ref: "operation-p040-sensitive:verification"
      },
      evidence: {
        provider: "perchance",
        challengeKind: "verification"
      },
      expiresAt:
        "2026-10-04T03:05:00.000Z"
    });
    tasks.submitTransientInput(
      task.taskId,
      "VERIFICATION_CODE",
      sensitiveValue,
      60_000
    );

    const manager = new ModuleManager(database, {
      packageRoot: join(root, "modules"),
      now
    });
    await manager.installPackage(
      createP040FeatureModulePackage(
        PROVISIONING_MODULE_ID,
        "1.0.0"
      )
    );
    runtime = await manager.startActiveRuntime(
      PROVISIONING_MODULE_ID
    );
    await runtime.request("store", {
      key: "credential-ref",
      value: "opaque:accounts/p040"
    });
    await runtime.request("store", {
      key: "history",
      value: {
        operationId: operation.operationId,
        state: "NEEDS_HUMAN"
      }
    });

    const durableRows = {
      operation: database.prepare(`
        SELECT provenance_json, dispatch_evidence_json,
               last_transition_reason
        FROM operations
        WHERE operation_id = ?
      `).get(operation.operationId),
      task: database.prepare(`
        SELECT title, explanation, evidence_json,
               continuation_ref
        FROM human_tasks
        WHERE task_id = ?
      `).get(task.taskId),
      moduleState: database.prepare(`
        SELECT state_key, value_json
        FROM module_state_entries
        WHERE module_id = ?
        ORDER BY state_key
      `).all(PROVISIONING_MODULE_ID)
    };
    assert.equal(
      JSON.stringify(durableRows).includes(sensitiveValue),
      false
    );

    await runtime.stop();
    runtime = null;
    database.close();
    databaseClosed = true;

    const needle = Buffer.from(sensitiveValue, "utf8");
    const leakedFiles = [];
    for (const path of await filesUnder(root)) {
      if ((await readFile(path)).includes(needle)) {
        leakedFiles.push(path);
      }
    }
    assert.deepEqual(leakedFiles, []);
  } finally {
    await runtime?.stop().catch(() => undefined);
    if (!databaseClosed) database.close();
    await rm(root, { recursive: true, force: true });
  }
});
