import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolvePcmsPaths } from "../../dist/config/paths.js";
import { startPcmsd } from "../../dist/daemon/server.js";
import {
  ModuleRuntimeError,
  startModuleRuntime
} from "../../dist/modules/runner.js";

async function daemonFixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-module-daemon-"));
  const paths = resolvePcmsPaths({
    env: {
      PCMS_CONFIG_ROOT: join(root, "config"),
      PCMS_DATA_ROOT: join(root, "data"),
      PCMS_CACHE_ROOT: join(root, "cache")
    },
    homeDir: root
  });
  const daemon = await startPcmsd({ paths, port: 0 });
  return {
    root,
    daemon,
    async assertHealthy() {
      const response = await fetch(`${daemon.origin}/api/v1/health`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.service, "pcmsd");
      assert.equal(body.status, "ok");
    },
    async cleanup() {
      await daemon.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function moduleFixture(source) {
  const root = await mkdtemp(join(tmpdir(), "pcms-module-runner-"));
  const backendDir = join(root, "backend");
  await mkdir(backendDir, { recursive: true });
  await writeFile(join(backendDir, "index.mjs"), source, { mode: 0o600 });
  return {
    root,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("module-runner loads exactly one backend and exchanges bounded typed RPC", async () => {
  const fixture = await moduleFixture(`
    export function createModule(context) {
      return {
        handle(method, params) {
          if (method !== "describe") throw new Error("unknown method");
          return {
            params,
            module: context.module,
            contextKeys: Object.keys(context).sort(),
            sdkKeys: Object.keys(context.sdk).sort()
          };
        }
      };
    }
  `);

  const runtime = await startModuleRuntime({
    moduleId: "fixture.basic",
    version: "1.0.0",
    packageRoot: fixture.root,
    backendEntry: "backend/index.mjs",
    runtimeGeneration: 7
  });

  try {
    assert.equal(runtime.state, "RUNNING");
    assert.ok(runtime.pid > 0);
    assert.equal(runtime.runtimeGeneration, 7);
    assert.deepEqual(
      await runtime.request("describe", { hello: "world" }),
      {
        params: { hello: "world" },
        module: {
          id: "fixture.basic",
          version: "1.0.0",
          runtimeGeneration: 7
        },
        contextKeys: ["module", "sdk"],
        sdkKeys: ["call"]
      }
    );
  } finally {
    await runtime.stop();
    await fixture.cleanup();
  }
  assert.equal(runtime.state, "STOPPED");
});

test("module-runner surfaces structured backend errors without terminating", async () => {
  const fixture = await moduleFixture(`
    export function createModule() {
      return {
        handle(method) {
          if (method === "fail") {
            const error = new Error("fixture failure");
            error.code = "FIXTURE_FAILED";
            throw error;
          }
          return "ok";
        }
      };
    }
  `);
  const runtime = await startModuleRuntime({
    moduleId: "fixture.errors",
    version: "1.0.0",
    packageRoot: fixture.root,
    backendEntry: "backend/index.mjs",
    runtimeGeneration: 1
  });

  try {
    await assert.rejects(
      () => runtime.request("fail", null),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "FIXTURE_FAILED" &&
        error.message === "fixture failure"
    );
    assert.equal(await runtime.request("ok", null), "ok");
    assert.equal(runtime.state, "RUNNING");
  } finally {
    await runtime.stop();
    await fixture.cleanup();
  }
});

test("module SDK exposes semantic serialized calls and rejects raw Core authority", async () => {
  const fixture = await moduleFixture(`
    export function createModule(context) {
      return {
        async handle(method, params) {
          if (method === "sdk") {
            return context.sdk.call(params.method, params.payload);
          }
          if (method === "authority") {
            return {
              contextKeys: Object.keys(context).sort(),
              moduleKeys: Object.keys(context.module).sort(),
              sdkKeys: Object.keys(context.sdk).sort(),
              hasDb: Object.hasOwn(context, "db"),
              hasRouter: Object.hasOwn(context, "router"),
              hasCdp: Object.hasOwn(context, "cdp")
            };
          }
          throw new Error("unknown method");
        }
      };
    }
  `);

  const runtime = await startModuleRuntime({
    moduleId: "fixture.authority",
    version: "1.0.0",
    packageRoot: fixture.root,
    backendEntry: "backend/index.mjs",
    runtimeGeneration: 2,
    sdkHandlers: {
      "accounts.read": async (params) => ({
        source: "core-semantic-handler",
        params
      })
    }
  });

  try {
    assert.deepEqual(await runtime.request("authority", null), {
      contextKeys: ["module", "sdk"],
      moduleKeys: ["id", "runtimeGeneration", "version"],
      sdkKeys: ["call"],
      hasDb: false,
      hasRouter: false,
      hasCdp: false
    });

    assert.deepEqual(
      await runtime.request("sdk", {
        method: "accounts.read",
        payload: { accountUid: "acct-fixture" }
      }),
      {
        source: "core-semantic-handler",
        params: { accountUid: "acct-fixture" }
      }
    );

    for (const method of ["db.query", "router.raw", "browser.cdp.send"]) {
      await assert.rejects(
        () => runtime.request("sdk", { method, payload: null }),
        (error) =>
          error instanceof ModuleRuntimeError &&
          error.code === "MODULE_SDK_METHOD_DENIED" &&
          error.message.includes(method)
      );
      assert.equal(runtime.state, "RUNNING");
    }
  } finally {
    await runtime.stop();
    await fixture.cleanup();
  }
});

test("Core refuses to configure raw DB/router/CDP SDK method names", async () => {
  const fixture = await moduleFixture(`
    export function createModule() {
      return { handle() { return "unused"; } };
    }
  `);

  try {
    for (const method of ["db.query", "router.open", "browser.cdp.send"]) {
      await assert.rejects(
        () => startModuleRuntime({
          moduleId: "fixture.invalid-authority",
          version: "1.0.0",
          packageRoot: fixture.root,
          backendEntry: "backend/index.mjs",
          runtimeGeneration: 1,
          sdkHandlers: {
            [method]: () => null
          }
        }),
        (error) =>
          error instanceof ModuleRuntimeError &&
          error.code === "INVALID_MODULE_SDK_METHOD" &&
          error.message.includes(method)
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("timeout, crash and oversize faults remain isolated from Core and unrelated modules", async () => {
  const daemon = await daemonFixture();
  const healthyFixture = await moduleFixture(`
    export function createModule() {
      return {
        handle(method, params) {
          if (method !== "echo") throw new Error("unknown method");
          return params;
        }
      };
    }
  `);
  const faultFixture = await moduleFixture(`
    export function createModule() {
      return {
        handle(method, params) {
          if (method === "echo") return params;
          if (method === "hang") return new Promise(() => {});
          if (method === "crash") process.exit(41);
          if (method === "emitOversize") {
            const header = Buffer.alloc(4);
            header.writeUInt32BE(70 * 1024);
            process.stdout.write(header);
            return new Promise(() => {});
          }
          throw new Error("unknown method");
        }
      };
    }
  `);

  const healthy = await startModuleRuntime({
    moduleId: "fixture.healthy",
    version: "1.0.0",
    packageRoot: healthyFixture.root,
    backendEntry: "backend/index.mjs",
    runtimeGeneration: 1
  });
  const fault = await startModuleRuntime({
    moduleId: "fixture.fault",
    version: "1.0.0",
    packageRoot: faultFixture.root,
    backendEntry: "backend/index.mjs",
    runtimeGeneration: 2,
    limits: {
      maxOutstandingRequests: 1,
      requestTimeoutMs: 150
    }
  });

  let oversizeRuntime = null;
  try {
    const hanging = fault.request("hang", null, 150);
    await assert.rejects(
      () => fault.request("echo", "blocked"),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RPC_BACKPRESSURE" &&
        error.retryable === true
    );
    await assert.rejects(
      () => hanging,
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RPC_TIMEOUT" &&
        error.retryable === true
    );

    assert.equal(await fault.request("echo", "after-timeout"), "after-timeout");
    assert.equal(await healthy.request("echo", "still-running"), "still-running");
    await daemon.assertHealthy();

    await assert.rejects(
      () => healthy.request("echo", "x".repeat(80 * 1024)),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RPC_PAYLOAD_TOO_LARGE"
    );
    assert.equal(healthy.state, "RUNNING");
    assert.equal(await healthy.request("echo", "after-local-oversize"), "after-local-oversize");
    await daemon.assertHealthy();

    await assert.rejects(
      () => fault.request("crash", null, 1_000),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RUNTIME_LOST" &&
        error.retryable === false
    );
    assert.equal(fault.state, "DEGRADED");
    assert.equal(await healthy.request("echo", "after-crash"), "after-crash");
    await daemon.assertHealthy();

    oversizeRuntime = await startModuleRuntime({
      moduleId: "fixture.oversize",
      version: "1.0.0",
      packageRoot: faultFixture.root,
      backendEntry: "backend/index.mjs",
      runtimeGeneration: 3
    });

    await assert.rejects(
      () => oversizeRuntime.request("emitOversize", null, 1_000),
      (error) =>
        error instanceof ModuleRuntimeError &&
        error.code === "MODULE_RUNTIME_LOST"
    );
    assert.equal(oversizeRuntime.state, "DEGRADED");
    assert.equal(await healthy.request("echo", "after-wire-oversize"), "after-wire-oversize");
    await daemon.assertHealthy();
  } finally {
    await oversizeRuntime?.stop();
    await fault.stop();
    await healthy.stop();
    await faultFixture.cleanup();
    await healthyFixture.cleanup();
    await daemon.cleanup();
  }
});
