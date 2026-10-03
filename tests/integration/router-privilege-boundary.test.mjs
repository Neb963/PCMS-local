import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNativeRouterClient
} from "../../dist/routing/native-router-client.js";

const CAP_NET_ADMIN = 12n;

function effectiveCapabilities(statusText) {
  const match = /^CapEff:\s*([0-9a-fA-F]+)$/m.exec(statusText);
  assert.ok(match, "Linux /proc/self/status must expose CapEff");
  return BigInt(`0x${match[1]}`);
}

test(
  "pcmsd control path works as an unprivileged user without CAP_NET_ADMIN",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pcms-router-unprivileged-"));
    const socketPath = join(root, "control.sock");
    const server = createServer((socket) => {
      let input = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        input += chunk;
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(input.slice(0, newline));
        socket.end(`${JSON.stringify({
          ok: true,
          id: request.id,
          version: "0.3.0"
        })}\n`);
      });
    });

    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });

      await chmod(socketPath, 0o600);
      const socketStat = await stat(socketPath);
      assert.equal(socketStat.mode & 0o777, 0o600);
      assert.equal(socketStat.uid, process.getuid());

      if (process.env.GITHUB_ACTIONS === "true") {
        assert.notEqual(
          process.getuid(),
          0,
          "GitHub Actions integration must exercise the Core path as non-root"
        );
        assert.notEqual(
          process.geteuid(),
          0,
          "GitHub Actions integration must not acquire effective root"
        );

        const procStatus = await readFile("/proc/self/status", "utf8");
        const capEff = effectiveCapabilities(procStatus);
        assert.equal(
          capEff & (1n << CAP_NET_ADMIN),
          0n,
          "Core integration process must not hold effective CAP_NET_ADMIN"
        );
      }

      const client = createNativeRouterClient({
        socketPath,
        requestIdFactory: () => "unprivileged-core"
      });
      assert.deepEqual(await client.ping(), { version: "0.3.0" });
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await rm(root, { recursive: true, force: true });
    }
  }
);
