import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensurePcmsDirectories,
  resolvePcmsPaths
} from "../../dist/config/paths.js";
import {
  OperationCoordinator,
  generatorOperationTargetKey
} from "../../dist/operations/operation-coordinator.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      { host: "127.0.0.1", port: 0 },
      resolve
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) =>
      error ? reject(error) : resolve()
    );
  });
  return port;
}

async function startDaemon(paths, port) {
  const child = spawn(
    process.execPath,
    ["dist/daemon/main.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PCMS_CONFIG_ROOT: paths.configRoot,
        PCMS_DATA_ROOT: paths.dataRoot,
        PCMS_CACHE_ROOT: paths.cacheRoot,
        PCMS_PORT: String(port)
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const started = await Promise.race([
    new Promise((resolve, reject) => {
      const onData = (chunk) => {
        const text = String(chunk);
        for (const line of text.split("\n")) {
          if (line.includes('"event":"pcmsd.started"')) {
            child.stdout.off("data", onData);
            resolve();
            return;
          }
        }
      };
      child.stdout.on("data", onData);
      child.once("exit", (code, signal) => {
        reject(
          new Error(
            "pcmsd exited before startup: code=" +
              String(code) +
              " signal=" +
              String(signal) +
              " stderr=" +
              stderr
          )
        );
      });
    }),
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("pcmsd startup timed out")),
        10_000
      );
    })
  ]);
  void started;

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    async kill(signal = "SIGTERM") {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill(signal);
      await new Promise((resolve) => {
        child.once("exit", resolve);
      });
    }
  };
}

function prepare(coordinator, suffix) {
  return coordinator.prepare({
    operationId: "p045-op-" + suffix,
    idempotencyKey: "p045-key-" + suffix,
    owner: { kind: "CORE" },
    actorSource: "p045-crash-matrix",
    targetKey: generatorOperationTargetKey(
      "p045-generator-" + suffix
    ),
    operationKind: "p045-synthetic-mutation",
    schemaVersion: 1,
    desiredFingerprint: "c".repeat(64),
    provenance: {
      source: "p045-process-recovery"
    },
    preconditions: [{
      key: "session",
      observedAt: new Date().toISOString(),
      maxAgeMs: 60_000,
      evidenceRef: "p045-evidence-" + suffix
    }]
  });
}

test("P045 pcmsd SIGKILL matrix preserves claims and recovers dispatched phases as UNCERTAIN", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "pcms-p045-daemon-kill-")
  );
  const paths = resolvePcmsPaths({
    env: {
      PCMS_CONFIG_ROOT: join(root, "config"),
      PCMS_DATA_ROOT: join(root, "data"),
      PCMS_CACHE_ROOT: join(root, "cache")
    },
    homeDir: root
  });
  await ensurePcmsDirectories(paths);
  const port = await freePort();
  let daemon = await startDaemon(paths, port);

  try {
    const database = openConfiguredSqliteDatabase(
      paths.databasePath
    );
    const coordinator = new OperationCoordinator({
      database
    });
    try {
      const prepared = prepare(coordinator, "prepared");

      const running = prepare(coordinator, "running");
      coordinator.authorizeDispatch({
        operationId: running.operationId,
        expectedClaimEpoch: running.claimEpoch,
        evidence: { step: "remote-save" }
      });

      const verifying = prepare(
        coordinator,
        "verifying"
      );
      coordinator.authorizeDispatch({
        operationId: verifying.operationId,
        expectedClaimEpoch: verifying.claimEpoch,
        evidence: { step: "remote-save" }
      });
      coordinator.beginVerification(
        verifying.operationId,
        verifying.claimEpoch
      );

      const uncertain = prepare(
        coordinator,
        "uncertain"
      );
      coordinator.authorizeDispatch({
        operationId: uncertain.operationId,
        expectedClaimEpoch: uncertain.claimEpoch,
        evidence: { step: "remote-save" }
      });
      coordinator.recordExecutionLoss({
        operationId: uncertain.operationId,
        expectedClaimEpoch: uncertain.claimEpoch,
        source: "BROWSER",
        effectState: "MAY_HAVE_OCCURRED"
      });

      const succeeded = prepare(
        coordinator,
        "succeeded"
      );
      coordinator.authorizeDispatch({
        operationId: succeeded.operationId,
        expectedClaimEpoch: succeeded.claimEpoch,
        evidence: { step: "remote-save" }
      });
      coordinator.beginVerification(
        succeeded.operationId,
        succeeded.claimEpoch
      );
      coordinator.markSucceeded(
        succeeded.operationId,
        succeeded.claimEpoch
      );

      assert.equal(
        coordinator.require(prepared.operationId).state,
        "PREPARED"
      );
      assert.equal(
        coordinator.require(running.operationId).state,
        "RUNNING"
      );
      assert.equal(
        coordinator.require(verifying.operationId).state,
        "VERIFYING"
      );
      assert.equal(
        coordinator.require(uncertain.operationId).state,
        "UNCERTAIN"
      );
      assert.equal(
        coordinator.require(succeeded.operationId).state,
        "SUCCEEDED"
      );
    } finally {
      database.close();
    }

    await daemon.kill("SIGKILL");
    daemon = await startDaemon(paths, port);

    const response = await fetch(
      "http://127.0.0.1:" + String(port) + "/api/v1/health"
    );
    assert.equal(response.status, 200);

    const recoveredDb = openConfiguredSqliteDatabase(
      paths.databasePath
    );
    const recovered = new OperationCoordinator({
      database: recoveredDb
    });
    try {
      const expected = new Map([
        ["prepared", "PREPARED"],
        ["running", "UNCERTAIN"],
        ["verifying", "UNCERTAIN"],
        ["uncertain", "UNCERTAIN"],
        ["succeeded", "SUCCEEDED"]
      ]);

      for (const [suffix, state] of expected) {
        const operation = recovered.require(
          "p045-op-" + suffix
        );
        assert.equal(operation.state, state);
        const claim = recovered.getUnresolvedClaim(
          operation.targetKey
        );
        if (state === "SUCCEEDED") {
          assert.equal(claim, null);
        } else {
          assert.equal(
            claim?.operationId,
            operation.operationId
          );
        }
      }

      assert.equal(
        recovered.require("p045-op-running")
          .lastTransitionReason,
        "startup-recovery-after-possible-dispatch"
      );
      assert.equal(
        recovered.require("p045-op-verifying")
          .lastTransitionReason,
        "startup-recovery-after-possible-dispatch"
      );
    } finally {
      recoveredDb.close();
    }
  } finally {
    await daemon.kill().catch(() => undefined);
    await rm(root, {
      recursive: true,
      force: true
    });
  }
});
