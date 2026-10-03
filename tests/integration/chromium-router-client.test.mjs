import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  NativeRouterClientError,
  createNativeRouterClient
} from "../../dist/routing/native-router-client.js";

async function fixture(handler) {
  const root = await mkdtemp(join(tmpdir(), "pcms-chromium-router-client-"));
  const socketPath = join(root, "control.sock");
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
      handler(request, socket);
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
        server.close((error) => error ? reject(error) : resolve());
      });
      await rm(root, { recursive: true, force: true });
    }
  };
}

function reply(socket, request, payload) {
  socket.end(`${JSON.stringify({ ...payload, id: request.id })}\n`);
}

test("typed Core client uses the distinct Chromium lease commands", async () => {
  const f = await fixture((request, socket) => {
    if (request.command === "prepare_chromium_exit") {
      reply(socket, request, {
        ok: true,
        ready: true,
        route_id: request.route_id,
        relay_ip: request.relay_ip,
        relay_port: request.relay_port,
        local_host: "127.0.0.1",
        local_port: 43210,
        lease_id: request.lease_id,
        lease_generation: request.lease_generation,
        lease_ttl_seconds: request.lease_ttl_seconds,
        selected_entry: "pl-waw"
      });
      return;
    }
    if (request.command === "release_chromium_exit") {
      reply(socket, request, { ok: true, released: true });
      return;
    }
    reply(socket, request, { ok: false, error: "unsupported command" });
  });
  const client = createNativeRouterClient({
    socketPath: f.socketPath,
    requestIdFactory: (() => {
      let id = 0;
      return () => `chromium-${++id}`;
    })()
  });

  try {
    assert.deepEqual(
      await client.prepareChromiumExit({
        routeId: "route-1",
        relayIp: "10.124.0.9",
        leaseId: "persona-runtime",
        leaseGeneration: 7,
        leaseTtlSeconds: 45
      }),
      {
        ready: true,
        routeId: "route-1",
        relayIp: "10.124.0.9",
        relayPort: 1080,
        localHost: "127.0.0.1",
        localPort: 43210,
        leaseId: "persona-runtime",
        leaseGeneration: 7,
        leaseTtlSeconds: 45,
        selectedEntry: "pl-waw"
      }
    );
    assert.deepEqual(
      await client.releaseChromiumExit("route-1", "persona-runtime", 7),
      { released: true }
    );
    assert.deepEqual(
      f.requests.map((request) => request.command),
      ["prepare_chromium_exit", "release_chromium_exit"]
    );
    assert.equal(typeof client.prepareExit, "undefined");
  } finally {
    await f.close();
  }
});

test("Chromium lease identifiers and generations are rejected before socket I/O", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcms-chromium-client-validation-"));
  try {
    const client = createNativeRouterClient({
      socketPath: join(root, "missing.sock")
    });
    await assert.rejects(
      () => client.prepareChromiumExit({
        routeId: "../route",
        relayIp: "10.124.0.9",
        leaseId: "lease",
        leaseGeneration: 1
      }),
      (error) =>
        error instanceof NativeRouterClientError &&
        error.code === "INVALID_ROUTER_REQUEST"
    );
    await assert.rejects(
      () => client.releaseChromiumExit("route-1", "lease", 0),
      (error) =>
        error instanceof NativeRouterClientError &&
        error.code === "INVALID_ROUTER_REQUEST"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
