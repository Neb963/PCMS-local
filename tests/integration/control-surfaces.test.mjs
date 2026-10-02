import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { readLocalApiToken } from "../../dist/auth/local-api.js";
import { resolvePcmsPaths } from "../../dist/config/paths.js";
import { startPcmsd } from "../../dist/daemon/server.js";
import { CORE_MIGRATIONS } from "../../dist/storage/core-migrations.js";

const execFileAsync = promisify(execFile);

async function createFixturePaths(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    paths: resolvePcmsPaths({
      env: {
        PCMS_CONFIG_ROOT: join(root, "config"),
        PCMS_DATA_ROOT: join(root, "data"),
        PCMS_CACHE_ROOT: join(root, "cache")
      },
      homeDir: root
    })
  };
}

function requestWithHost(port, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: "/",
      method: "GET",
      headers: {
        host: hostHeader
      }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    req.once("error", reject);
    req.end();
  });
}

test("Web UI shell bootstraps authenticated same-origin Core status", async () => {
  const fixture = await createFixturePaths("pcms-control-ui-");
  const daemon = await startPcmsd({ paths: fixture.paths, port: 0 });

  try {
    const token = await readLocalApiToken(fixture.paths.apiTokenFile);

    const shell = await fetch(daemon.origin);
    assert.equal(shell.status, 200);
    assert.match(
      shell.headers.get("content-security-policy") ?? "",
      /default-src 'none'/
    );
    assert.equal(shell.headers.get("referrer-policy"), "no-referrer");
    assert.equal(shell.headers.get("x-frame-options"), "DENY");

    const html = await shell.text();
    assert.match(html, /<title>PCMS Local<\/title>/);
    assert.ok(html.includes(`name="pcms-api-token" content="${token}"`));
    assert.equal(html.includes(`?${token}`), false);

    const appJs = await fetch(`${daemon.origin}/app.js`);
    assert.equal(appJs.status, 200);
    assert.equal((await appJs.text()).includes(token), false);

    const unauthorized = await fetch(`${daemon.origin}/api/v1/status`);
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error.code, "UNAUTHORIZED");

    const crossOrigin = await fetch(`${daemon.origin}/api/v1/status`, {
      headers: {
        authorization: `Bearer ${token}`,
        origin: "https://example.invalid"
      }
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).error.code, "INVALID_ORIGIN");

    const sameOrigin = await fetch(`${daemon.origin}/api/v1/status`, {
      headers: {
        authorization: `Bearer ${token}`,
        origin: daemon.origin
      }
    });
    assert.equal(sameOrigin.status, 200);
    assert.deepEqual(await sameOrigin.json(), {
      service: "pcmsd",
      status: "ready",
      version: "0.0.0",
      baseline: "0.1",
      database: {
        status: "ok",
        schemaVersion: CORE_MIGRATIONS.length
      }
    });

    assert.equal(
      await requestWithHost(daemon.port, "example.invalid"),
      400
    );
  } finally {
    await daemon.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("CLI status uses the same authenticated Core API and emits stable JSON", async () => {
  const fixture = await createFixturePaths("pcms-control-cli-");
  const daemon = await startPcmsd({ paths: fixture.paths, port: 0 });

  try {
    const token = await readLocalApiToken(fixture.paths.apiTokenFile);
    const env = {
      ...process.env,
      PCMS_CONFIG_ROOT: fixture.paths.configRoot,
      PCMS_DATA_ROOT: fixture.paths.dataRoot,
      PCMS_CACHE_ROOT: fixture.paths.cacheRoot,
      PCMS_PORT: String(daemon.port)
    };

    const jsonResult = await execFileAsync(
      process.execPath,
      ["dist/cli/main.js", "status", "--json"],
      { cwd: process.cwd(), env }
    );
    assert.equal(jsonResult.stderr, "");
    assert.equal(jsonResult.stdout.includes(token), false);
    assert.deepEqual(JSON.parse(jsonResult.stdout), {
      ok: true,
      status: {
        service: "pcmsd",
        status: "ready",
        version: "0.0.0",
        baseline: "0.1",
        database: {
          status: "ok",
          schemaVersion: CORE_MIGRATIONS.length
        }
      }
    });

    const humanResult = await execFileAsync(
      process.execPath,
      ["dist/cli/main.js", "status"],
      { cwd: process.cwd(), env }
    );
    assert.equal(humanResult.stderr, "");
    assert.match(humanResult.stdout, /^PCMS Local\n/m);
    assert.match(humanResult.stdout, /^Status: ready$/m);
    assert.match(
      humanResult.stdout,
      new RegExp("^Schema: " + CORE_MIGRATIONS.length + "$", "m")
    );
    assert.equal(humanResult.stdout.includes(token), false);
  } finally {
    await daemon.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
