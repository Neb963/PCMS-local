import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensurePcmsDirectories, resolvePcmsPaths } from "../../dist/config/paths.js";
import { startPcmsd } from "../../dist/daemon/server.js";
import { InstanceAlreadyRunningError } from "../../dist/runtime/instance-lock.js";
import { DatabaseSchemaError } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function createFixturePaths(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return resolvePcmsPaths({
    env: {
      PCMS_CONFIG_ROOT: join(root, "config"),
      PCMS_DATA_ROOT: join(root, "data"),
      PCMS_CACHE_ROOT: join(root, "cache")
    },
    homeDir: root
  });
}

async function getJson(origin, path) {
  const response = await fetch(`${origin}${path}`);
  return {
    status: response.status,
    body: await response.json()
  };
}

function listenBlocker() {
  const server = createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeBlocker(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test("pcmsd starts single-instance on IPv4 loopback and reports health/readiness/version", async () => {
  const paths = await createFixturePaths("pcmsd-integration-");
  const daemon = await startPcmsd({ paths, port: 0 });

  try {
    assert.equal(daemon.host, "127.0.0.1");
    assert.ok(daemon.port > 0);
    assert.equal(daemon.origin, `http://127.0.0.1:${daemon.port}`);
    assert.equal(daemon.schemaVersion, 1);

    const health = await getJson(daemon.origin, "/api/v1/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.service, "pcmsd");
    assert.equal(health.body.status, "ok");
    assert.equal(health.body.version, "0.0.0");
    assert.equal(typeof health.body.uptimeMs, "number");
    assert.deepEqual(health.body.database, {
      status: "ok",
      schemaVersion: 1
    });

    const ready = await getJson(daemon.origin, "/api/v1/ready");
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.body, {
      service: "pcmsd",
      status: "ready",
      ready: true,
      version: "0.0.0",
      schemaVersion: 1
    });

    const version = await getJson(daemon.origin, "/api/v1/version");
    assert.equal(version.status, 200);
    assert.deepEqual(version.body, {
      service: "pcmsd",
      version: "0.0.0",
      baseline: "0.1"
    });

    await assert.rejects(
      () => startPcmsd({ paths, port: 0 }),
      InstanceAlreadyRunningError
    );
  } finally {
    await daemon.close();
  }

  const restarted = await startPcmsd({ paths, port: 0 });
  await restarted.close();
});

test("bind failure releases instance ownership for a clean retry", async () => {
  const paths = await createFixturePaths("pcmsd-bind-failure-");
  const blocker = await listenBlocker();
  const address = blocker.address();
  assert.ok(address && typeof address !== "string");

  await assert.rejects(
    () => startPcmsd({ paths, port: address.port }),
    { code: "EADDRINUSE" }
  );

  await closeBlocker(blocker);

  const daemon = await startPcmsd({ paths, port: 0 });
  await daemon.close();
});

test("bootstrap endpoints reject unsupported methods and unknown paths", async () => {
  const paths = await createFixturePaths("pcmsd-http-errors-");
  const daemon = await startPcmsd({ paths, port: 0 });

  try {
    const method = await fetch(`${daemon.origin}/api/v1/health`, {
      method: "POST"
    });
    assert.equal(method.status, 405);

    const missing = await fetch(`${daemon.origin}/api/v1/missing`);
    assert.equal(missing.status, 404);
  } finally {
    await daemon.close();
  }
});


test("database bootstrap failure prevents readiness and releases instance ownership", async () => {
  const paths = await createFixturePaths("pcmsd-db-reject-");
  await ensurePcmsDirectories(paths);
  const raw = openConfiguredSqliteDatabase(paths.databasePath);
  raw.exec("PRAGMA application_id = 12345");
  raw.close();

  await assert.rejects(
    () => startPcmsd({ paths, port: 0 }),
    DatabaseSchemaError
  );

  await rm(paths.databasePath, { force: true });
  await rm(`${paths.databasePath}-wal`, { force: true });
  await rm(`${paths.databasePath}-shm`, { force: true });

  const daemon = await startPcmsd({ paths, port: 0 });
  await daemon.close();
});
