import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ChromiumBrowserManager
} from "../../dist/personas/chromium-browser.js";
import {
  ensurePcmsDirectories,
  resolvePcmsPaths
} from "../../dist/config/paths.js";
import {
  PersonaProfileLifecycle
} from "../../dist/personas/profile-lifecycle.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

function requiredChromiumBinary() {
  const value = process.env.PCMS_CHROMIUM_BINARY;
  assert.ok(
    value,
    "PCMS_CHROMIUM_BINARY is required for real-browser acceptance"
  );
  return value;
}

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
  const lifecycle = new PersonaProfileLifecycle({
    database,
    personasRoot: paths.personasRoot
  });
  const manager = new ChromiumBrowserManager({
    lifecycle,
    database,
    executablePath: requiredChromiumBinary(),
    startupTimeoutMs: 20_000,
    closeTimeoutMs: 8_000
  });
  return { root, database, lifecycle, manager };
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out connecting generic CDP client")),
      5_000
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Generic CDP WebSocket connection failed"));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    const message = JSON.parse(event.data);
    if (typeof message.id !== "number") {
      return;
    }
    const request = pending.get(message.id);
    if (request === undefined) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error !== undefined) {
      request.reject(
        new Error(
          `CDP ${request.method} failed: ${JSON.stringify(message.error)}`
        )
      );
      return;
    }
    request.resolve(message.result);
  });

  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new Error(`CDP socket closed while waiting for ${request.method}`)
      );
    }
    pending.clear();
  });

  function send(method, params = {}, sessionId) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}`));
      }, 5_000);
      pending.set(id, { method, resolve, reject, timer });
      socket.send(JSON.stringify({
        id,
        method,
        params,
        ...(sessionId === undefined ? {} : { sessionId })
      }));
    });
  }

  function disconnect() {
    if (socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
      socket.close(1000, "P015 generic client detach");
    });
  }

  return Object.freeze({ send, disconnect });
}

test("generic CDP client attaches, interacts and detaches from the running Persona", async () => {
  const f = await fixture("pcms-chromium-cdp-attach-");
  const personaUid = "persona_cdp_attach";
  let session;
  let client;

  try {
    session = await f.manager.launch(personaUid, {
      headless: true,
      disableSandboxForTesting: true
    });

    const runtimeBefore = f.database.prepare(`
      SELECT state, pid, devtools_port, devtools_path
      FROM persona_browser_runtime
      WHERE persona_uid = ?
    `).get(personaUid);
    assert.equal(runtimeBefore.state, "RUNNING");
    assert.equal(runtimeBefore.pid, session.pid);
    assert.equal((await stat(session.profilePath)).isDirectory(), true);

    const endpoint = await f.manager.resolveDevToolsEndpoint(personaUid);
    assert.ok(endpoint);
    assert.deepEqual(endpoint, session.devTools);
    assert.match(endpoint.httpOrigin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.match(
      endpoint.webSocketUrl,
      /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//u
    );

    client = await connectCdp(endpoint.webSocketUrl);
    const created = await client.send("Target.createTarget", {
      url: "about:blank"
    });
    assert.equal(typeof created.targetId, "string");

    const attached = await client.send("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true
    });
    assert.equal(typeof attached.sessionId, "string");

    const evaluated = await client.send(
      "Runtime.evaluate",
      {
        expression: "40 + 2",
        returnByValue: true
      },
      attached.sessionId
    );
    assert.equal(evaluated.result.value, 42);

    await client.send("Target.detachFromTarget", {
      sessionId: attached.sessionId
    });
    await client.send("Target.closeTarget", {
      targetId: created.targetId
    });
    await client.disconnect();
    client = undefined;

    assert.equal(f.lifecycle.get(personaUid).profileState, "OPEN");
    assert.equal((await stat(session.profilePath)).isDirectory(), true);

    const runtimeAfter = f.database.prepare(`
      SELECT state, pid, devtools_port, devtools_path
      FROM persona_browser_runtime
      WHERE persona_uid = ?
    `).get(personaUid);
    assert.deepEqual(runtimeAfter, runtimeBefore);

    const rediscovered = await f.manager.resolveDevToolsEndpoint(personaUid);
    assert.ok(rediscovered);
    assert.deepEqual(rediscovered, endpoint);

    const version = await fetch(`${rediscovered.httpOrigin}/json/version`);
    assert.equal(version.status, 200);
    const versionPayload = await version.json();
    assert.equal(
      versionPayload.webSocketDebuggerUrl,
      rediscovered.webSocketUrl
    );

    const reattached = await connectCdp(rediscovered.webSocketUrl);
    const browserVersion = await reattached.send("Browser.getVersion");
    assert.equal(typeof browserVersion.product, "string");
    await reattached.disconnect();

    assert.equal(f.lifecycle.get(personaUid).profileState, "OPEN");
  } finally {
    if (client !== undefined) {
      await client.disconnect();
    }
    if (session !== undefined) {
      await session.close();
    }
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
