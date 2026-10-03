import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
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
import {
  createNativeRouterClient
} from "../../dist/routing/native-router-client.js";
import {
  ProtectedChromiumManager
} from "../../dist/routing/protected-chromium.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";
import {
  observeSyntheticSocksEgress,
  startSyntheticSocksExit
} from "./synthetic-protected-egress-fixture.mjs";

function requiredChromiumBinary() {
  const value = process.env.PCMS_CHROMIUM_BINARY;
  assert.ok(
    value,
    "PCMS_CHROMIUM_BINARY is required for real-browser acceptance"
  );
  return value;
}

async function profileFixture(root) {
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
  const browser = new ChromiumBrowserManager({
    lifecycle,
    database,
    executablePath: requiredChromiumBinary(),
    startupTimeoutMs: 20_000,
    closeTimeoutMs: 8_000
  });
  return { paths, database, lifecycle, browser };
}

async function startRouterControlFixture(root, exitsByRoute) {
  const socketPath = join(root, "router-control.sock");
  const requests = [];
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      requests.push(request);

      let payload;
      if (request.command === "prepare_chromium_exit") {
        const selected = exitsByRoute.get(request.route_id);
        if (selected === undefined) {
          payload = { ok: false, error: "synthetic route not found" };
        } else {
          payload = {
            ok: true,
            ready: true,
            route_id: request.route_id,
            relay_ip: request.relay_ip,
            relay_port: request.relay_port,
            local_host: "127.0.0.1",
            local_port: selected.port,
            lease_id: request.lease_id,
            lease_generation: request.lease_generation,
            lease_ttl_seconds: request.lease_ttl_seconds,
            selected_entry: "synthetic"
          };
        }
      } else if (request.command === "release_chromium_exit") {
        payload = { ok: true, released: true };
      } else {
        payload = { ok: false, error: "unsupported synthetic router command" };
      }
      socket.end(`${JSON.stringify({ ...payload, id: request.id })}\n`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    socketPath,
    requests,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  };
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out connecting egress CDP verifier")),
      5_000
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Egress CDP WebSocket connection failed"));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data);
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (request === undefined) return;
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
    const id = nextId++;
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

  async function disconnect() {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
      socket.close(1000, "P018 egress verifier detach");
    });
  }

  return Object.freeze({ send, disconnect });
}

async function observeBrowserEgress(session, path = "/browser") {
  const client = await connectCdp(session.devTools.webSocketUrl);
  let targetId;
  let targetSessionId;

  try {
    const created = await client.send("Target.createTarget", {
      url: `http://pcms-egress.invalid${path}`
    });
    targetId = created.targetId;
    assert.equal(typeof targetId, "string");

    const attached = await client.send("Target.attachToTarget", {
      targetId,
      flatten: true
    });
    targetSessionId = attached.sessionId;
    assert.equal(typeof targetSessionId, "string");

    const deadline = Date.now() + 8_000;
    let lastText = "";
    while (Date.now() < deadline) {
      try {
        const evaluated = await client.send(
          "Runtime.evaluate",
          {
            expression: "document.body ? document.body.innerText : ''",
            returnByValue: true
          },
          targetSessionId
        );
        const value = evaluated?.result?.value;
        if (typeof value === "string" && value !== "") {
          lastText = value;
          try {
            const parsed = JSON.parse(value);
            if (typeof parsed.routeIdentity === "string") {
              return {
                routeIdentity: parsed.routeIdentity,
                checkedAt: Date.now()
              };
            }
          } catch {
            // Navigation may still be displaying an intermediate browser page.
          }
        }
      } catch {
        // The execution context may be replaced while navigation commits.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Timed out waiting for browser egress identity; last body=${JSON.stringify(lastText.slice(0, 200))}`
    );
  } finally {
    if (targetSessionId !== undefined) {
      await client.send("Target.detachFromTarget", {
        sessionId: targetSessionId
      }).catch(() => undefined);
    }
    if (targetId !== undefined) {
      await client.send("Target.closeTarget", {
        targetId
      }).catch(() => undefined);
    }
    await client.disconnect();
  }
}

test("protected real Chromium egress matches the selected synthetic route independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-protected-egress-"));
  const alpha = await startSyntheticSocksExit({
    routeIdentity: "synthetic-exit-alpha"
  });
  const beta = await startSyntheticSocksExit({
    routeIdentity: "synthetic-exit-beta"
  });
  const routerFixture = await startRouterControlFixture(
    root,
    new Map([
      ["route-alpha", alpha],
      ["route-beta", beta]
    ])
  );
  const profile = await profileFixture(root);
  let protectedSession;

  let requestId = 0;
  const router = createNativeRouterClient({
    socketPath: routerFixture.socketPath,
    requestIdFactory: () => `p018-${++requestId}`
  });
  const manager = new ProtectedChromiumManager({
    router,
    browser: profile.browser,
    verifier: {
      async verifyForwarder(lease) {
        const observed = await observeSyntheticSocksEgress({
          proxyHost: lease.localHost,
          proxyPort: lease.localPort,
          targetPath: "/preflight"
        });
        return {
          routeIdentity: observed.routeIdentity,
          checkedAt: Date.now()
        };
      },
      async verifyBrowser(session) {
        return observeBrowserEgress(session, "/browser");
      }
    }
  });

  try {
    protectedSession = await manager.launch({
      personaUid: "persona_protected_alpha",
      routeId: "route-alpha",
      relayIp: "10.124.0.9",
      leaseId: "runtime-alpha",
      leaseGeneration: 1,
      leaseTtlSeconds: 60,
      expectedEgressIdentity: "synthetic-exit-alpha",
      browser: {
        headless: true,
        disableSandboxForTesting: true
      }
    });

    assert.ok(protectedSession.browser.pid > 0);
    assert.equal(protectedSession.routeId, "route-alpha");
    assert.equal(protectedSession.lease.localPort, alpha.port);
    assert.equal(
      protectedSession.forwarderEgress.routeIdentity,
      "synthetic-exit-alpha"
    );
    assert.equal(
      protectedSession.browserEgress.routeIdentity,
      "synthetic-exit-alpha"
    );

    assert.ok(
      alpha.observations.some((value) => value.requestedPath === "/preflight"),
      "forwarder preflight must observe the selected synthetic exit"
    );
    assert.ok(
      alpha.observations.some((value) => value.requestedPath === "/browser"),
      "browser request must be independently observed at the selected exit"
    );
    assert.equal(
      beta.observations.length,
      0,
      "unselected synthetic route must not observe protected browser traffic"
    );

    assert.deepEqual(
      routerFixture.requests.map((request) => request.command),
      ["prepare_chromium_exit"]
    );

    await protectedSession.close();
    protectedSession = undefined;

    assert.deepEqual(
      routerFixture.requests.map((request) => request.command),
      ["prepare_chromium_exit", "release_chromium_exit"]
    );
  } finally {
    if (protectedSession !== undefined) {
      await protectedSession.close();
    }
    profile.database.close();
    await routerFixture.close();
    await Promise.all([alpha.close(), beta.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
