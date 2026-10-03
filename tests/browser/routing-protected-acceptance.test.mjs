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
  ChromiumRoutingManager
} from "../../dist/routing/chromium-routing.js";
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
  assert.ok(value, "PCMS_CHROMIUM_BINARY is required");
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
  return { database, browser };
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
      request.reject(new Error(JSON.stringify(message.error)));
    } else {
      request.resolve(message.result);
    }
  });

  function send(method, params = {}, sessionId) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}`));
      }, 8_000);
      pending.set(id, { resolve, reject, timer });
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
      socket.close(1000, "P020 egress verifier detach");
    });
  }

  return { send, disconnect };
}

async function observeBrowserEgress(session, path) {
  const client = await connectCdp(session.devTools.webSocketUrl);
  let targetId;
  let targetSessionId;

  try {
    const created = await client.send("Target.createTarget", {
      url: `http://pcms-egress.invalid${path}`
    });
    targetId = created.targetId;
    const attached = await client.send("Target.attachToTarget", {
      targetId,
      flatten: true
    });
    targetSessionId = attached.sessionId;

    const deadline = Date.now() + 8_000;
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
          try {
            const parsed = JSON.parse(value);
            if (typeof parsed.routeIdentity === "string") {
              return {
                routeIdentity: parsed.routeIdentity,
                checkedAt: Date.now()
              };
            }
          } catch {
            // Navigation may still be committing.
          }
        }
      } catch {
        // Execution context may change during navigation.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for protected browser egress");
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

function protectedRoutingFixture({ browser, router, exitsByRoute }) {
  let pendingRouteId = null;
  const protectedChromium = new ProtectedChromiumManager({
    router,
    browser,
    verifier: {
      async verifyForwarder(lease) {
        pendingRouteId = lease.routeId;
        const selected = exitsByRoute.get(lease.routeId);
        assert.ok(selected, `missing synthetic exit for ${lease.routeId}`);
        const observed = await observeSyntheticSocksEgress({
          proxyHost: lease.localHost,
          proxyPort: lease.localPort,
          targetPath: `/preflight-${lease.routeId}`
        });
        return {
          routeIdentity: observed.routeIdentity,
          checkedAt: Date.now()
        };
      },
      async verifyBrowser(session) {
        assert.ok(pendingRouteId !== null, "browser verification needs route");
        const routeId = pendingRouteId;
        pendingRouteId = null;
        return observeBrowserEgress(session, `/browser-${routeId}`);
      }
    }
  });

  return new ChromiumRoutingManager({
    browser,
    protectedChromium
  });
}

test("protected route switch closes old browser and verifies fresh egress before admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-route-switch-"));
  const alpha = await startSyntheticSocksExit({
    routeIdentity: "synthetic-exit-alpha"
  });
  const beta = await startSyntheticSocksExit({
    routeIdentity: "synthetic-exit-beta"
  });
  const exitsByRoute = new Map([
    ["route-alpha", alpha],
    ["route-beta", beta]
  ]);
  const routerFixture = await startRouterControlFixture(root, exitsByRoute);
  const profile = await profileFixture(root);
  let requestId = 0;
  const router = createNativeRouterClient({
    socketPath: routerFixture.socketPath,
    requestIdFactory: () => `p020-switch-${++requestId}`
  });
  const routing = protectedRoutingFixture({
    browser: profile.browser,
    router,
    exitsByRoute
  });
  let session;

  try {
    session = await routing.launch({
      mode: "PROTECTED",
      personaUid: "persona_switch",
      routeId: "route-alpha",
      relayIp: "10.124.0.9",
      leaseId: "lease-alpha",
      leaseGeneration: 1,
      leaseTtlSeconds: 60,
      expectedEgressIdentity: "synthetic-exit-alpha",
      browser: {
        headless: true,
        disableSandboxForTesting: true
      }
    });
    const alphaPid = session.browser.pid;

    assert.deepEqual(routing.mutationAdmission("persona_switch"), {
      allowed: true,
      mode: "PROTECTED",
      routeId: "route-alpha",
      reason: "PROTECTED_VERIFIED"
    });
    assert.ok(
      alpha.observations.some(
        (value) => value.requestedPath === "/preflight-route-alpha"
      )
    );
    assert.ok(
      alpha.observations.some(
        (value) => value.requestedPath === "/browser-route-alpha"
      )
    );

    session = await routing.switchProtectedRoute("persona_switch", {
      mode: "PROTECTED",
      personaUid: "persona_switch",
      routeId: "route-beta",
      relayIp: "10.124.0.10",
      leaseId: "lease-beta",
      leaseGeneration: 2,
      leaseTtlSeconds: 60,
      expectedEgressIdentity: "synthetic-exit-beta",
      browser: {
        headless: true,
        disableSandboxForTesting: true
      }
    });

    assert.equal(session.mode, "PROTECTED");
    assert.equal(session.routeId, "route-beta");
    assert.notEqual(
      session.browser.pid,
      alphaPid,
      "route switch must relaunch Chromium because proxy configuration is immutable"
    );
    assert.deepEqual(routing.mutationAdmission("persona_switch"), {
      allowed: true,
      mode: "PROTECTED",
      routeId: "route-beta",
      reason: "PROTECTED_VERIFIED"
    });
    assert.ok(
      beta.observations.some(
        (value) => value.requestedPath === "/preflight-route-beta"
      )
    );
    assert.ok(
      beta.observations.some(
        (value) => value.requestedPath === "/browser-route-beta"
      )
    );
    assert.deepEqual(
      routerFixture.requests.map((request) => [
        request.command,
        request.route_id
      ]),
      [
        ["prepare_chromium_exit", "route-alpha"],
        ["release_chromium_exit", "route-alpha"],
        ["prepare_chromium_exit", "route-beta"]
      ]
    );

    await session.close();
    session = undefined;
    assert.deepEqual(
      routerFixture.requests.map((request) => [
        request.command,
        request.route_id
      ]),
      [
        ["prepare_chromium_exit", "route-alpha"],
        ["release_chromium_exit", "route-alpha"],
        ["prepare_chromium_exit", "route-beta"],
        ["release_chromium_exit", "route-beta"]
      ]
    );
  } finally {
    if (session !== undefined) await session.close();
    profile.database.close();
    await routerFixture.close();
    await Promise.all([alpha.close(), beta.close()]);
    await rm(root, { recursive: true, force: true });
  }
});


test("multiple protected Personas remain isolated on independent synthetic exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-multi-protected-"));
  const alpha = await startSyntheticSocksExit({
    routeIdentity: "synthetic-exit-alpha"
  });
  const beta = await startSyntheticSocksExit({
    routeIdentity: "synthetic-exit-beta"
  });
  const exitsByRoute = new Map([
    ["route-alpha", alpha],
    ["route-beta", beta]
  ]);
  const routerFixture = await startRouterControlFixture(root, exitsByRoute);
  const profile = await profileFixture(root);
  let requestId = 0;
  const router = createNativeRouterClient({
    socketPath: routerFixture.socketPath,
    requestIdFactory: () => `p020-multi-${++requestId}`
  });
  const routing = protectedRoutingFixture({
    browser: profile.browser,
    router,
    exitsByRoute
  });
  let alphaSession;
  let betaSession;

  try {
    alphaSession = await routing.launch({
      mode: "PROTECTED",
      personaUid: "persona_multi_alpha",
      routeId: "route-alpha",
      relayIp: "10.124.0.9",
      leaseId: "lease-multi-alpha",
      leaseGeneration: 1,
      leaseTtlSeconds: 60,
      expectedEgressIdentity: "synthetic-exit-alpha",
      browser: {
        headless: true,
        disableSandboxForTesting: true
      }
    });

    betaSession = await routing.launch({
      mode: "PROTECTED",
      personaUid: "persona_multi_beta",
      routeId: "route-beta",
      relayIp: "10.124.0.10",
      leaseId: "lease-multi-beta",
      leaseGeneration: 1,
      leaseTtlSeconds: 60,
      expectedEgressIdentity: "synthetic-exit-beta",
      browser: {
        headless: true,
        disableSandboxForTesting: true
      }
    });

    assert.notEqual(alphaSession.browser.pid, betaSession.browser.pid);
    assert.notEqual(
      alphaSession.browser.profilePath,
      betaSession.browser.profilePath
    );
    assert.notEqual(
      alphaSession.browser.devTools.port,
      betaSession.browser.devTools.port
    );
    assert.deepEqual(routing.mutationAdmission("persona_multi_alpha"), {
      allowed: true,
      mode: "PROTECTED",
      routeId: "route-alpha",
      reason: "PROTECTED_VERIFIED"
    });
    assert.deepEqual(routing.mutationAdmission("persona_multi_beta"), {
      allowed: true,
      mode: "PROTECTED",
      routeId: "route-beta",
      reason: "PROTECTED_VERIFIED"
    });

    const alphaObserved = await observeBrowserEgress(
      alphaSession.browser,
      "/active-alpha"
    );
    const betaObserved = await observeBrowserEgress(
      betaSession.browser,
      "/active-beta"
    );
    assert.equal(alphaObserved.routeIdentity, "synthetic-exit-alpha");
    assert.equal(betaObserved.routeIdentity, "synthetic-exit-beta");

    assert.ok(
      alpha.observations.some(
        (value) => value.requestedPath === "/active-alpha"
      )
    );
    assert.equal(
      alpha.observations.some(
        (value) => value.requestedPath === "/active-beta"
      ),
      false,
      "alpha synthetic exit must not observe beta Persona traffic"
    );
    assert.ok(
      beta.observations.some(
        (value) => value.requestedPath === "/active-beta"
      )
    );
    assert.equal(
      beta.observations.some(
        (value) => value.requestedPath === "/active-alpha"
      ),
      false,
      "beta synthetic exit must not observe alpha Persona traffic"
    );

    assert.deepEqual(
      routerFixture.requests.map((request) => [
        request.command,
        request.route_id
      ]),
      [
        ["prepare_chromium_exit", "route-alpha"],
        ["prepare_chromium_exit", "route-beta"]
      ]
    );

    await alphaSession.close();
    alphaSession = undefined;
    await betaSession.close();
    betaSession = undefined;

    assert.deepEqual(
      routerFixture.requests.map((request) => [
        request.command,
        request.route_id
      ]),
      [
        ["prepare_chromium_exit", "route-alpha"],
        ["prepare_chromium_exit", "route-beta"],
        ["release_chromium_exit", "route-alpha"],
        ["release_chromium_exit", "route-beta"]
      ]
    );
  } finally {
    if (alphaSession !== undefined) await alphaSession.close();
    if (betaSession !== undefined) await betaSession.close();
    profile.database.close();
    await routerFixture.close();
    await Promise.all([alpha.close(), beta.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
