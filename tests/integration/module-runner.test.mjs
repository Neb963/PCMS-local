import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ModuleRuntimeError,
  startModuleRuntime
} from "../../dist/modules/runner.js";

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
