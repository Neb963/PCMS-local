import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import test from "node:test";

import { readLocalApiToken } from "../../dist/auth/local-api.js";
import { resolvePcmsPaths } from "../../dist/config/paths.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

const execFileAsync = promisify(execFile);
const bundleRoot = join(process.cwd(), "build", "pcms-local-dev");

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function withTimeout(promise, label, timeoutMs = 10_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function startBundledDaemon(env) {
  const child = spawn(join(bundleRoot, "bin", "pcmsd"), [], {
    cwd: bundleRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  let buffer = "";
  const events = [];
  let resolveStarted;
  let rejectStarted;
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      const event = JSON.parse(line);
      events.push(event);
      if (event.event === "pcmsd.started") resolveStarted(event);
    }
  });

  child.once("exit", (code, signal) => {
    rejectStarted(
      new Error(
        `pcmsd exited before startup: code=${code}, signal=${signal}, stderr=${stderr}`
      )
    );
  });

  const event = await withTimeout(started, "pcmsd.started");
  return {
    child,
    event,
    events,
    stderr: () => stderr
  };
}

async function stopBundledDaemon(handle) {
  const exited = once(handle.child, "exit");
  assert.equal(handle.child.kill("SIGTERM"), true);
  const [code, signal] = await withTimeout(exited, "pcmsd exit");
  assert.equal(code, 0, handle.stderr());
  assert.equal(signal, null);
  assert.ok(
    handle.events.some((event) => event.event === "pcmsd.stopped"),
    "pcmsd must emit a graceful stop event"
  );
}

function readMigrationState(databasePath) {
  const database = openConfiguredSqliteDatabase(databasePath);
  try {
    const row = database.prepare(`
      SELECT version, migration_id, checksum, applied_at
      FROM schema_migrations
      ORDER BY version
    `).get();
    return { ...row };
  } finally {
    database.close();
  }
}

test("self-contained bundle stops cleanly and restarts without foundation-state loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-bundle-lifecycle-"));
  const paths = resolvePcmsPaths({
    env: {
      PCMS_CONFIG_ROOT: join(root, "config"),
      PCMS_DATA_ROOT: join(root, "data"),
      PCMS_CACHE_ROOT: join(root, "cache")
    },
    homeDir: root
  });
  const port = await getFreePort();
  const env = {
    ...process.env,
    PATH: "/definitely-not-a-package-manager-path",
    PCMS_CONFIG_ROOT: paths.configRoot,
    PCMS_DATA_ROOT: paths.dataRoot,
    PCMS_CACHE_ROOT: paths.cacheRoot,
    PCMS_PORT: String(port)
  };

  try {
    const first = await startBundledDaemon(env);
    assert.equal(first.event.host, "127.0.0.1");
    assert.equal(first.event.port, port);

    const tokenBefore = await readLocalApiToken(paths.apiTokenFile);
    const migrationBefore = readMigrationState(paths.databasePath);

    const diagnosticsBefore = await execFileAsync(
      join(bundleRoot, "bin", "pcms"),
      ["diagnostics", "--json"],
      { cwd: bundleRoot, env }
    );
    assert.equal(diagnosticsBefore.stderr, "");
    const parsedBefore = JSON.parse(diagnosticsBefore.stdout);
    assert.equal(parsedBefore.ok, true);
    assert.equal(parsedBefore.diagnostics.status, "ready");
    assert.equal(parsedBefore.diagnostics.database.schemaVersion, 3);
    assert.equal(parsedBefore.diagnostics.runtime.node, process.version);
    assert.equal(diagnosticsBefore.stdout.includes(tokenBefore), false);

    await stopBundledDaemon(first);
    await assert.rejects(() => stat(paths.instanceLockPath), { code: "ENOENT" });

    const second = await startBundledDaemon(env);
    const tokenAfter = await readLocalApiToken(paths.apiTokenFile);
    const migrationAfter = readMigrationState(paths.databasePath);

    assert.equal(tokenAfter, tokenBefore);
    assert.deepEqual(migrationAfter, migrationBefore);

    const statusAfter = await execFileAsync(
      join(bundleRoot, "bin", "pcms"),
      ["status", "--json"],
      { cwd: bundleRoot, env }
    );
    assert.equal(statusAfter.stderr, "");
    assert.equal(JSON.parse(statusAfter.stdout).status.database.schemaVersion, 3);
    assert.equal(statusAfter.stdout.includes(tokenAfter), false);

    await stopBundledDaemon(second);
    await assert.rejects(() => stat(paths.instanceLockPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
