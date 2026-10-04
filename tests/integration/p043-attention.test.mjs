import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { readLocalApiToken } from "../../dist/auth/local-api.js";
import { resolvePcmsPaths } from "../../dist/config/paths.js";
import { startPcmsd } from "../../dist/daemon/server.js";
import { HumanTaskStore } from "../../dist/human-tasks/human-task-store.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

const execFileAsync = promisify(execFile);

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-p043-attention-"));
  const paths = resolvePcmsPaths({
    env: {
      PCMS_CONFIG_ROOT: join(root, "config"),
      PCMS_DATA_ROOT: join(root, "data"),
      PCMS_CACHE_ROOT: join(root, "cache")
    },
    homeDir: root
  });
  await mkdir(dirname(paths.databasePath), { recursive: true });

  const database = openConfiguredSqliteDatabase(paths.databasePath);
  applyPcmsMigrations(database, {
    now: () => new Date("2026-10-04T01:00:00.000Z")
  });
  const tasks = new HumanTaskStore({
    database,
    now: () => new Date("2026-10-04T01:01:00.000Z")
  });
  tasks.create({
    taskId: "attention-recovery-conflict",
    taskType: "RECOVERY_CONFLICT",
    title: "Review restored provider state",
    explanation:
      "Provider-owned state is unknown after restore and requires reconciliation.",
    requiredActionKind: "REVIEW_RECOVERY",
    continuation: {
      kind: "RECOVERY_REVIEW",
      version: 1,
      ref: "recovery:attention"
    },
    evidence: {
      source: "restore",
      recoveryHold: true
    }
  });
  database.close();

  return { root, paths };
}

function auth(token) {
  return {
    authorization: `Bearer ${token}`
  };
}

test("P043 Attention survives daemon restart and is exposed independently of notifications", async () => {
  const fixture = await createFixture();
  let daemon = await startPcmsd({
    paths: fixture.paths,
    port: 0
  });

  try {
    const token = await readLocalApiToken(
      fixture.paths.apiTokenFile
    );

    const readAttention = async () => {
      const response = await fetch(
        `${daemon.origin}/api/v1/attention`,
        { headers: auth(token) }
      );
      assert.equal(response.status, 200);
      return response.json();
    };

    const first = await readAttention();
    assert.deepEqual(first, {
      attention: [{
        taskId: "attention-recovery-conflict",
        taskType: "RECOVERY_CONFLICT",
        title: "Review restored provider state",
        explanation:
          "Provider-owned state is unknown after restore and requires reconciliation.",
        requiredActionKind: "REVIEW_RECOVERY",
        accountId: null,
        personaUid: null,
        operationId: null,
        createdAt: "2026-10-04T01:01:00.000Z",
        updatedAt: "2026-10-04T01:01:00.000Z",
        expiresAt: null
      }]
    });

    const shell = await fetch(daemon.origin);
    const html = await shell.text();
    assert.match(html, /id="attention-heading"/);
    assert.match(html, />Attention</);

    const appJs = await fetch(`${daemon.origin}/app.js`);
    const source = await appJs.text();
    assert.match(source, /\/api\/v1\/attention/);
    assert.match(source, /requiredActionKind/);
    assert.equal(source.includes(token), false);

    const env = {
      ...process.env,
      PCMS_CONFIG_ROOT: fixture.paths.configRoot,
      PCMS_DATA_ROOT: fixture.paths.dataRoot,
      PCMS_CACHE_ROOT: fixture.paths.cacheRoot,
      PCMS_PORT: String(daemon.port)
    };
    const cli = await execFileAsync(
      process.execPath,
      [
        "dist/cli/main.js",
        "attention",
        "list",
        "--json"
      ],
      {
        cwd: process.cwd(),
        env
      }
    );
    assert.equal(cli.stderr, "");
    assert.deepEqual(JSON.parse(cli.stdout), {
      ok: true,
      attention: first.attention
    });

    await daemon.close();
    daemon = await startPcmsd({
      paths: fixture.paths,
      port: 0
    });

    const afterRestart = await readAttention();
    assert.deepEqual(afterRestart, first);

    const database = openConfiguredSqliteDatabase(
      fixture.paths.databasePath
    );
    try {
      const row = database.prepare(`
        SELECT status, title, required_action_kind
        FROM human_tasks
        WHERE task_id = ?
      `).get("attention-recovery-conflict");
      assert.deepEqual({ ...row }, {
        status: "OPEN",
        title: "Review restored provider state",
        required_action_kind: "REVIEW_RECOVERY"
      });
    } finally {
      database.close();
    }
  } finally {
    await daemon.close();
    await rm(fixture.root, {
      recursive: true,
      force: true
    });
  }
});
