import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
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
  assert.fail("A non-loopback IPv4 address is required for network leak acceptance");
}

async function startUdpCanary() {
  const socket = createSocket("udp4");
  const packets = [];
  socket.on("message", (message, remote) => {
    packets.push({
      bytes: message.length,
      address: remote.address,
      port: remote.port
    });
  });
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "0.0.0.0", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  const address = socket.address();
  assert.equal(typeof address, "object");
  return {
    port: address.port,
    packets,
    async close() {
      await new Promise((resolve) => socket.close(resolve));
    }
  };
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
      socket.close(1000, "P019 network verifier detach");
    });
  }

  return { send, close };
}

async function openTarget(client, url) {
  const created = await client.send("Target.createTarget", { url });
  assert.equal(typeof created.targetId, "string");
  const attached = await client.send("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true
  });
  assert.equal(typeof attached.sessionId, "string");
  return {
    targetId: created.targetId,
    sessionId: attached.sessionId
  };
}

async function waitForRouteIdentity(client, sessionId) {
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
      const value = evaluated?.result?.value;
      if (typeof value === "string" && value !== "") {
        try {
          const parsed = JSON.parse(value);
          if (typeof parsed.routeIdentity === "string") return parsed;
        } catch {
          // Navigation has not committed the synthetic identity document yet.
        }
      }
    } catch {
      // Execution context can be replaced during navigation.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for protected DNS-path identity");
}

async function closeTarget(client, target) {
  await client.send("Target.detachFromTarget", {
    sessionId: target.sessionId
  }).catch(() => undefined);
  await client.send("Target.closeTarget", {
    targetId: target.targetId
  }).catch(() => undefined);
}

test("protected Chromium enforces DNS, QUIC and WebRTC network hardening", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-protected-hardening-"));
  const targetHost = "dns-proxy-only.invalid";
  const socks = await startSyntheticSocksExit({
    routeIdentity: "synthetic-hardening",
    expectedHost: targetHost
  });
  const udp = await startUdpCanary();
  const hostIp = nonLoopbackIpv4();
  const profile = await profileFixture(root);
  let session;
  let client;
  let target;

  try {
    session = await profile.browser.launch("persona_protected_hardening", {
      headless: true,
      disableSandboxForTesting: true,
      protectedProxy: {
        host: "127.0.0.1",
        port: socks.port
      }
    });

    // Chromium rewrites /proc/<pid>/cmdline into one space-joined entry on
    // hosts that permit the process-title rewrite, and a read racing that
    // rewrite can observe a torn mixture (joined content plus leftover NUL
    // bytes). Match against the NUL-normalized content with substrings:
    // joined form word-splitting cannot preserve flags that embed spaces,
    // and the expected flag strings are unique per launch.
    const expectedFlags = [
      `--proxy-server=socks5://127.0.0.1:${socks.port}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"
    ];
    let normalizedCommandLine = "";
    const flagsDeadline = Date.now() + 5_000;
    while (Date.now() < flagsDeadline) {
      const rawCommandLine = (await readFile(`/proc/${session.pid}/cmdline`))
        .toString("utf8");
      normalizedCommandLine = rawCommandLine.replaceAll("\0", " ");
      if (expectedFlags.every((flag) => normalizedCommandLine.includes(flag))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const flag of expectedFlags) {
      assert.ok(
        normalizedCommandLine.includes(flag),
        `launched Chromium must carry ${flag}; observed ${JSON.stringify(normalizedCommandLine)}`
      );
    }

    client = await connectCdp(session.devTools.webSocketUrl);
    target = await openTarget(client, `http://${targetHost}/dns-through-socks`);
    const observed = await waitForRouteIdentity(client, target.sessionId);
    assert.equal(observed.routeIdentity, "synthetic-hardening");
    assert.equal(observed.requestedHost, targetHost);
    assert.ok(
      socks.observations.some(
        (value) =>
          value.requestedHost === targetHost &&
          value.requestedPath === "/dns-through-socks"
      ),
      "hostname must reach the SOCKS5 exit unresolved by the host"
    );

    const rtc = await client.send(
      "Runtime.evaluate",
      {
        expression: `(async () => {
          if (typeof RTCPeerConnection !== "function") {
            return { supported: false, candidates: [] };
          }
          const pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:${hostIp}:${udp.port}" }]
          });
          const candidates = [];
          pc.onicecandidate = (event) => {
            if (event.candidate) candidates.push(event.candidate.candidate);
          };
          pc.createDataChannel("pcms");
          await pc.setLocalDescription(await pc.createOffer());
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 1500);
            pc.onicegatheringstatechange = () => {
              if (pc.iceGatheringState === "complete") {
                clearTimeout(timer);
                resolve();
              }
            };
          });
          pc.close();
          return { supported: true, candidates };
        })()`,
        awaitPromise: true,
        returnByValue: true
      },
      target.sessionId
    );
    assert.equal(rtc.result.value.supported, true);
    assert.ok(
      rtc.result.value.candidates.every(
        (candidate) => !candidate.includes(hostIp)
      ),
      "WebRTC candidates must not expose the non-proxied host interface"
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(
      udp.packets,
      [],
      "WebRTC must not send non-proxied UDP to the controlled STUN canary"
    );
    assert.deepEqual(socks.clientErrors, []);
  } finally {
    if (client !== undefined && target !== undefined) {
      await closeTarget(client, target);
    }
    if (client !== undefined) await client.close();
    if (session !== undefined) await session.close();
    profile.database.close();
    await Promise.all([socks.close(), udp.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
