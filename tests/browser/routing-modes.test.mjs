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
import {
  ChromiumRoutingManager
} from "../../dist/routing/chromium-routing.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

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
  assert.fail("A non-loopback IPv4 address is required");
}

async function startHttpCanary(body) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store"
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    port: address.port,
    requests,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  };
}

async function probeHttp(host, port) {
  return new Promise((resolve, reject) => {
    const request = get(
      { host, port, path: "/node-probe", timeout: 2_000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve(body));
      }
    );
    request.on("timeout", () => request.destroy(new Error("probe timeout")));
    request.on("error", reject);
  });
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
  const routing = new ChromiumRoutingManager({
    browser,
    protectedChromium: {
      async launch() {
        throw new Error("protected launch not used by routing-mode acceptance");
      }
    }
  });
  return { database, routing };
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP connect timeout")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP connection failed"));
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
        reject(new Error(`Timed out waiting for ${method}`));
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
      socket.close(1000, "P020 routing-mode verifier detach");
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
  return {
    targetId: created.targetId,
    sessionId: attached.sessionId
  };
}

async function waitForBody(client, sessionId, expected) {
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
      if (evaluated?.result?.value === expected) return;
    } catch {
      // Navigation can replace the execution context.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for body ${expected}`);
}

async function closeTarget(client, target) {
  await client.send("Target.detachFromTarget", {
    sessionId: target.sessionId
  }).catch(() => undefined);
  await client.send("Target.closeTarget", {
    targetId: target.targetId
  }).catch(() => undefined);
}

test("explicit Direct reaches external canary while Block prevents external Chrome networking", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-routing-modes-"));
  const hostIp = nonLoopbackIpv4();
  const canary = await startHttpCanary("ROUTING_CANARY");
  const f = await browserFixture(root);
  let direct;
  let block;
  let client;
  let target;

  try {
    assert.equal(
      await probeHttp(hostIp, canary.port),
      "ROUTING_CANARY",
      "external-path canary must be independently reachable"
    );
    canary.requests.length = 0;

    direct = await f.routing.launch({
      mode: "DIRECT",
      personaUid: "persona_direct_mode",
      browser: {
        headless: true,
        disableSandboxForTesting: true
      }
    });
    assert.equal(direct.mode, "DIRECT");
    assert.equal(
      f.routing.mutationAdmission("persona_direct_mode").reason,
      "DIRECT_SELECTED"
    );

    client = await connectCdp(direct.browser.devTools.webSocketUrl);
    target = await openTarget(
      client,
      `http://${hostIp}:${canary.port}/direct-browser`
    );
    await waitForBody(client, target.sessionId, "ROUTING_CANARY");
    assert.ok(canary.requests.includes("/direct-browser"));
    await closeTarget(client, target);
    target = undefined;
    await client.close();
    client = undefined;
    await direct.close();
    direct = undefined;

    canary.requests.length = 0;
    block = await f.routing.launch({
      mode: "BLOCK",
      personaUid: "persona_block_mode",
      browser: {
        headless: true,
        disableSandboxForTesting: true
      }
    });
    assert.equal(block.mode, "BLOCK");
    assert.equal(
      f.routing.mutationAdmission("persona_block_mode").reason,
      "BLOCK_MODE"
    );

    client = await connectCdp(block.browser.devTools.webSocketUrl);
    target = await openTarget(
      client,
      `http://${hostIp}:${canary.port}/blocked-browser`
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.deepEqual(
      canary.requests,
      [],
      "Block mode must not let Chrome reach the known-reachable external canary"
    );
  } finally {
    if (client !== undefined && target !== undefined) {
      await closeTarget(client, target);
    }
    if (client !== undefined) await client.close();
    if (block !== undefined) await block.close();
    if (direct !== undefined) await direct.close();
    f.database.close();
    await canary.close();
    await rm(root, { recursive: true, force: true });
  }
});
