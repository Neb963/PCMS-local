import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, get } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
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
import {
  startSyntheticSocksExit
} from "./synthetic-protected-egress-fixture.mjs";

function requiredChromiumBinary() {
  const value = process.env.PCMS_CHROMIUM_BINARY;
  assert.ok(value, "PCMS_CHROMIUM_BINARY is required");
  return value;
}

function nonLoopbackIpv4() {
  for (const values of Object.values(networkInterfaces())) {
    for (const value of values ?? []) {
      if (
        (value.family === "IPv4" || value.family === 4) &&
        value.internal === false
      ) {
        return value.address;
      }
    }
  }
  assert.fail("A non-loopback IPv4 address is required for escape detection");
}

async function startHttpCanary(bindHost, body) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? ""
    });
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    host: bindHost,
    port: address.port,
    requests,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  };
}

async function probeDirectCanary(host, port) {
  const body = await new Promise((resolve, reject) => {
    const request = get(
      {
        host,
        port,
        path: "/node-reachability",
        timeout: 2_000
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => resolve(data));
      }
    );
    request.on("timeout", () => {
      request.destroy(new Error("Direct canary probe timed out"));
    });
    request.on("error", reject);
  });
  return body;
}

async function browserFixture(root) {
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

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out connecting CDP")),
      5_000
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP WebSocket connection failed"));
    }, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data);
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

  async function close() {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
      socket.close(1000, "P019 route-loss verifier detach");
    });
  }

  return { send, close };
}

async function openTarget(client, url) {
  const created = await client.send("Target.createTarget", { url });
  const attached = await client.send("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true
  });
  assert.equal(typeof created.targetId, "string");
  assert.equal(typeof attached.sessionId, "string");
  return {
    targetId: created.targetId,
    sessionId: attached.sessionId
  };
}

async function waitForIdentity(client, sessionId) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const evaluated = await client.send(
        "Runtime.evaluate",
        {
          expression: "document.body ? document.body.innerText : ''",
          returnByValue: true
        },
        sessionId
      );
      const text = evaluated?.result?.value;
      if (typeof text === "string" && text !== "") {
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed.routeIdentity === "string") return parsed;
        } catch {
          // The target may still be navigating.
        }
      }
    } catch {
      // Navigation can replace the execution context.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for initial protected route identity");
}

async function waitForBody(client, sessionId, expectedBody) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const evaluated = await client.send(
        "Runtime.evaluate",
        {
          expression: "document.body ? document.body.innerText : ''",
          returnByValue: true
        },
        sessionId
      );
      if (evaluated?.result?.value === expectedBody) {
        return;
      }
    } catch {
      // Navigation can replace the execution context.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for body ${expectedBody}`);
}

async function closeTarget(client, target) {
  await client.send("Target.detachFromTarget", {
    sessionId: target.sessionId
  }).catch(() => undefined);
  await client.send("Target.closeTarget", {
    targetId: target.targetId
  }).catch(() => undefined);
}

test("protected Chromium fails requests after its synthetic forwarder disappears", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-protected-route-loss-"));
  const targetHost = "pcms-egress.invalid";
  const socks = await startSyntheticSocksExit({
    routeIdentity: "synthetic-route-loss",
    expectedHost: targetHost
  });
  const profile = await browserFixture(root);
  const hostIp = nonLoopbackIpv4();
  const directCanary = await startHttpCanary("0.0.0.0", "DIRECT_ESCAPE");
  const controlCanary = await startHttpCanary("127.0.0.1", "CONTROL_OK");
  assert.equal(
    await probeDirectCanary(hostIp, directCanary.port),
    "DIRECT_ESCAPE",
    "non-loopback Direct canary must be independently reachable"
  );
  directCanary.requests.length = 0;

  let socksClosed = false;
  let session;
  let client;
  let target;
  let directTarget;
  let controlTarget;

  try {
    session = await profile.browser.launch("persona_protected_route_loss", {
      headless: true,
      disableSandboxForTesting: true,
      protectedProxy: {
        host: "127.0.0.1",
        port: socks.port
      }
    });

    client = await connectCdp(session.devTools.webSocketUrl);
    target = await openTarget(
      client,
      `http://${targetHost}/before-forwarder-loss`
    );
    const beforeLoss = await waitForIdentity(client, target.sessionId);
    assert.equal(beforeLoss.routeIdentity, "synthetic-route-loss");
    assert.ok(
      socks.observations.some(
        (value) => value.requestedPath === "/before-forwarder-loss"
      )
    );

    await socks.close();
    socksClosed = true;

    const afterLoss = await client.send(
      "Runtime.evaluate",
      {
        expression: `(async () => {
          try {
            const response = await fetch(
              "http://${targetHost}/after-forwarder-loss",
              {
                cache: "no-store",
                signal: AbortSignal.timeout(4000)
              }
            );
            return {
              ok: true,
              status: response.status,
              text: await response.text()
            };
          } catch (error) {
            return {
              ok: false,
              name: error && error.name ? error.name : "",
              message: String(error && error.message ? error.message : error)
            };
          }
        })()`,
        awaitPromise: true,
        returnByValue: true
      },
      target.sessionId
    );

    assert.equal(
      afterLoss.result.value.ok,
      false,
      "protected request must fail after the forwarder disappears"
    );
    assert.equal(
      socks.observations.some(
        (value) => value.requestedPath === "/after-forwarder-loss"
      ),
      false
    );

    directTarget = await openTarget(
      client,
      `http://${hostIp}:${directCanary.port}/direct-after-loss`
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.deepEqual(
      directCanary.requests,
      [],
      "protected Chromium must not fall back to the host Direct path after route loss"
    );

    controlTarget = await openTarget(
      client,
      `http://127.0.0.1:${controlCanary.port}/control-after-loss`
    );
    await waitForBody(client, controlTarget.sessionId, "CONTROL_OK");
    assert.ok(
      controlCanary.requests.some(
        (request) => request.url === "/control-after-loss"
      ),
      "intentional loopback control traffic must remain reachable"
    );
  } finally {
    if (client !== undefined && directTarget !== undefined) {
      await closeTarget(client, directTarget);
    }
    if (client !== undefined && controlTarget !== undefined) {
      await closeTarget(client, controlTarget);
    }
    if (client !== undefined && target !== undefined) {
      await closeTarget(client, target);
    }
    if (client !== undefined) await client.close();
    if (session !== undefined) await session.close();
    profile.database.close();
    if (!socksClosed) await socks.close();
    await Promise.all([directCanary.close(), controlCanary.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
