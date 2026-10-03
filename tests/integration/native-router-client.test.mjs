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

const STATUS_RESPONSE = Object.freeze({
  ok: true,
  version: "0.3.0",
  selected_entry: "pl-waw",
  interface: "prm-mv",
  interface_up: true,
  base_proxy_reachable: true,
  base_route_bound: true,
  latest_handshake_epoch: 1_770_000_000,
  latest_handshake_age_seconds: 3,
  ready: true,
  mullvad_app_connected: false,
  active_exits: [
    {
      route_id: "route-1",
      relay_ip: "10.124.0.7",
      relay_port: 1080,
      local_host: "127.0.0.1",
      local_port: 41001
    }
  ]
});

async function startFixture(handler) {
  const root = await mkdtemp(join(tmpdir(), "pcms-router-client-"));
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
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await rm(root, { recursive: true, force: true });
    }
  };
}

function reply(socket, request, payload) {
  socket.end(`${JSON.stringify({ ...payload, id: request.id })}\n`);
}

function sequentialIds() {
  let value = 0;
  return () => `test-${++value}`;
}

test("bounded native router client exposes only typed baseline control methods", async () => {
  const fixture = await startFixture((request, socket) => {
    switch (request.command) {
      case "ping":
        reply(socket, request, { ok: true, version: "0.3.0" });
        return;
      case "list_entries":
        reply(socket, request, {
          ok: true,
          entries: ["pl-waw", "al-tia"],
          selected_entry: "pl-waw"
        });
        return;
      case "status":
      case "ensure_up":
      case "stop":
      case "restart":
      case "set_entry":
        reply(socket, request, STATUS_RESPONSE);
        return;
      default:
        reply(socket, request, { ok: false, error: "unsupported command" });
    }
  });
  const client = createNativeRouterClient({
    socketPath: fixture.socketPath,
    requestIdFactory: sequentialIds()
  });

  try {
    assert.deepEqual(await client.ping(), { version: "0.3.0" });
    assert.deepEqual(await client.listEntries(), {
      entries: ["pl-waw", "al-tia"],
      selectedEntry: "pl-waw"
    });

    const status = await client.status();
    assert.deepEqual(status, {
      version: "0.3.0",
      selectedEntry: "pl-waw",
      interfaceName: "prm-mv",
      interfaceUp: true,
      baseProxyReachable: true,
      baseRouteBound: true,
      latestHandshakeEpoch: 1_770_000_000,
      latestHandshakeAgeSeconds: 3,
      ready: true,
      mullvadAppConnected: false,
      activeExits: [
        {
          routeId: "route-1",
          relayIp: "10.124.0.7",
          relayPort: 1080,
          localHost: "127.0.0.1",
          localPort: 41001
        }
      ]
    });

    await client.ensureUp();
    await client.stop();
    await client.restart();
    await client.setEntry("al-tia", false);

    assert.deepEqual(
      fixture.requests.map((request) => request.command),
      [
        "ping",
        "list_entries",
        "status",
        "ensure_up",
        "stop",
        "restart",
        "set_entry"
      ]
    );
    assert.equal(fixture.requests.at(-1).entry_id, "al-tia");
    assert.equal(fixture.requests.at(-1).start, false);
    assert.equal(
      typeof client.prepareExit,
      "undefined",
      "Firefox prepare_exit is deliberately not exposed by the P016 Core client"
    );
  } finally {
    await fixture.close();
  }
});

test("router client maps daemon rejection and unavailable sockets to typed errors", async () => {
  const fixture = await startFixture((request, socket) => {
    reply(socket, request, { ok: false, error: "synthetic route unavailable" });
  });
  const client = createNativeRouterClient({
    socketPath: fixture.socketPath,
    requestIdFactory: () => "remote-error"
  });

  try {
    await assert.rejects(
      () => client.ensureUp(),
      (error) =>
        error instanceof NativeRouterClientError &&
        error.code === "ROUTER_REJECTED" &&
        error.operation === "ensure_up" &&
        error.retryable === false &&
        error.message === "synthetic route unavailable"
    );
  } finally {
    await fixture.close();
  }

  const root = await mkdtemp(join(tmpdir(), "pcms-router-missing-"));
  try {
    const unavailable = createNativeRouterClient({
      socketPath: join(root, "missing.sock"),
      requestIdFactory: () => "missing-socket"
    });
    await assert.rejects(
      () => unavailable.ping(),
      (error) =>
        error instanceof NativeRouterClientError &&
        error.code === "ROUTER_UNAVAILABLE" &&
        error.operation === "ping" &&
        error.retryable === true
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("router client rejects mismatched, oversized and stalled responses within bounds", async () => {
  const mismatched = await startFixture((request, socket) => {
    socket.end(JSON.stringify({
      ok: true,
      id: `${request.id}-wrong`,
      version: "0.3.0"
    }) + "\n");
  });
  try {
    const client = createNativeRouterClient({
      socketPath: mismatched.socketPath,
      requestIdFactory: () => "correlation"
    });
    await assert.rejects(
      () => client.ping(),
      (error) =>
        error instanceof NativeRouterClientError &&
        error.code === "ROUTER_PROTOCOL_ERROR"
    );
  } finally {
    await mismatched.close();
  }

  const oversized = await startFixture((_request, socket) => {
    socket.write("x".repeat(512));
  });
  try {
    const client = createNativeRouterClient({
      socketPath: oversized.socketPath,
      maxResponseBytes: 128,
      requestIdFactory: () => "oversized"
    });
    await assert.rejects(
      () => client.ping(),
      (error) =>
        error instanceof NativeRouterClientError &&
        error.code === "ROUTER_RESPONSE_TOO_LARGE"
    );
  } finally {
    await oversized.close();
  }

  const stalled = await startFixture(() => {
    // Deliberately leave the request unanswered until the bounded client times out.
  });
  try {
    const client = createNativeRouterClient({
      socketPath: stalled.socketPath,
      timeoutMs: 25,
      requestIdFactory: () => "timeout"
    });
    await assert.rejects(
      () => client.ping(),
      (error) =>
        error instanceof NativeRouterClientError &&
        error.code === "ROUTER_TIMEOUT" &&
        error.retryable === true
    );
  } finally {
    await stalled.close();
  }
});

test("router client validates local boundary configuration and set-entry input before I/O", async () => {
  assert.throws(
    () => createNativeRouterClient({ socketPath: "relative.sock" }),
    (error) =>
      error instanceof NativeRouterClientError &&
      error.code === "INVALID_ROUTER_CLIENT_CONFIG"
  );

  const root = await mkdtemp(join(tmpdir(), "pcms-router-validation-"));
  try {
    const client = createNativeRouterClient({
      socketPath: join(root, "missing.sock")
    });
    await assert.rejects(
      () => client.setEntry("../../escape"),
      (error) =>
        error instanceof NativeRouterClientError &&
        error.code === "INVALID_ROUTER_REQUEST" &&
        error.operation === "set_entry"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
