import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolvePcmsPaths } from "../../dist/config/paths.js";
import { startPcmsd } from "../../dist/daemon/server.js";
import {
  ModuleUiHost,
  ModuleUiHostError
} from "../../dist/modules/ui-host.js";

async function fixturePaths() {
  const root = await mkdtemp(join(tmpdir(), "pcms-module-ui-"));
  return {
    root,
    paths: resolvePcmsPaths({
      env: {
        PCMS_CONFIG_ROOT: join(root, "config"),
        PCMS_DATA_ROOT: join(root, "data"),
        PCMS_CACHE_ROOT: join(root, "cache")
      },
      homeDir: root
    })
  };
}

function uiPackage() {
  const files = new Map([
    [
      "ui/index.html",
      Buffer.from(
        '<!doctype html><html><body><script src="assets/app.js"></script><p>Reference UI</p></body></html>'
      )
    ],
    [
      "ui/assets/app.js",
      Buffer.from('document.body.dataset.loaded = "yes";')
    ]
  ]);
  return {
    moduleId: "fixture.ui",
    version: "1.0.0",
    uiEntry: "ui/index.html",
    readFile(path) {
      const bytes = files.get(path);
      if (bytes === undefined) {
        throw new Error(`missing fixture asset: ${path}`);
      }
      return Buffer.from(bytes);
    }
  };
}

test("failed module UI resets independently while pcmsd remains healthy", async () => {
  const sensitiveValue =
    "P040-SENSITIVE-UI-SDK-ERROR-DO-NOT-ECHO";
  const fixture = await fixturePaths();
  const host = new ModuleUiHost();
  const sdkCalls = [];
  const session = host.mount({
    package: uiPackage(),
    runtimeGeneration: 7,
    approvedAuthority: {
      capabilities: ["accounts.read"],
      requiredServices: []
    },
    authorizeSdkRequest(context) {
      assert.equal(context.moduleId, "fixture.ui");
      assert.equal(context.runtimeGeneration, 7);
      sdkCalls.push(context.method);
    },
    sdkHandlers: {
      "accounts.read": (params) => {
        if (
          typeof params === "object" &&
          params !== null &&
          params.triggerSensitiveFailure === true
        ) {
          const error = new Error(sensitiveValue);
          error.code = "SENSITIVE_UI_FAILURE";
          throw error;
        }
        return {
          accepted: true,
          params
        };
      }
    }
  });
  const daemon = await startPcmsd({
    paths: fixture.paths,
    port: 0,
    moduleUiHost: host
  });

  try {
    assert.equal(session.state, "READY");
    assert.equal(session.uiGeneration, 1);
    assert.deepEqual(session.approvedAuthority, {
      capabilities: ["accounts.read"],
      requiredServices: []
    });

    const wrapper = await fetch(
      `${daemon.origin}${session.hostPath}`
    );
    assert.equal(wrapper.status, 200);
    assert.match(
      wrapper.headers.get("content-security-policy") ?? "",
      /frame-src 'self'/
    );
    const wrapperHtml = await wrapper.text();
    assert.match(wrapperHtml, /sandbox="allow-scripts"/);
    assert.doesNotMatch(wrapperHtml, /allow-same-origin/);
    assert.match(
      wrapperHtml,
      new RegExp(
        `src="${session.assetPath.replaceAll("/", "\\/")}"`
      )
    );
    assert.match(wrapperHtml, /src="\/module-ui-host\.js"/);

    const bridge = await fetch(
      `${daemon.origin}/module-ui-host.js`
    );
    assert.equal(bridge.status, 200);
    const bridgeJs = await bridge.text();
    assert.match(bridgeJs, /event\.source !== frame\.contentWindow/);
    assert.match(bridgeJs, /pcms\.moduleSdk\.request/);

    const deniedOpaqueOrigin = await fetch(
      `${daemon.origin}/module-ui-sdk/${session.sessionId}/1`,
      {
        method: "POST",
        headers: {
          origin: "null",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          method: "accounts.read",
          params: { scope: "summary" }
        })
      }
    );
    assert.equal(deniedOpaqueOrigin.status, 403);
    assert.equal(
      (await deniedOpaqueOrigin.json()).error.code,
      "INVALID_ORIGIN"
    );

    const initial = await fetch(
      `${daemon.origin}/module-ui/${session.sessionId}/1/`
    );
    assert.equal(initial.status, 200);
    assert.match(
      initial.headers.get("content-security-policy") ?? "",
      /connect-src 'none'/
    );
    assert.equal(initial.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(await initial.text(), /Reference UI/);

    const asset = await fetch(
      `${daemon.origin}/module-ui/${session.sessionId}/1/assets/app.js`
    );
    assert.equal(asset.status, 200);
    assert.match(
      asset.headers.get("content-type") ?? "",
      /^text\/javascript/
    );

    const sdk = await fetch(
      `${daemon.origin}/module-ui-sdk/${session.sessionId}/1`,
      {
        method: "POST",
        headers: {
          origin: daemon.origin,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          method: "accounts.read",
          params: { scope: "summary" }
        })
      }
    );
    assert.equal(sdk.status, 200);
    assert.deepEqual(await sdk.json(), {
      result: {
        accepted: true,
        params: { scope: "summary" }
      }
    });
    assert.deepEqual(sdkCalls, ["accounts.read"]);

    const sensitiveFailure = await fetch(
      `${daemon.origin}/module-ui-sdk/${session.sessionId}/1`,
      {
        method: "POST",
        headers: {
          origin: daemon.origin,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          method: "accounts.read",
          params: { triggerSensitiveFailure: true }
        })
      }
    );
    assert.equal(sensitiveFailure.status, 500);
    const sensitiveFailureBody =
      await sensitiveFailure.json();
    assert.deepEqual(sensitiveFailureBody, {
      error: {
        code: "SENSITIVE_UI_FAILURE",
        message: "Module UI SDK request failed"
      }
    });
    assert.equal(
      JSON.stringify(sensitiveFailureBody).includes(
        sensitiveValue
      ),
      false
    );

    host.markFailed(session.sessionId, 1);

    const failedSdk = await fetch(
      `${daemon.origin}/module-ui-sdk/${session.sessionId}/1`,
      {
        method: "POST",
        headers: {
          origin: daemon.origin,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          method: "accounts.read",
          params: {}
        })
      }
    );
    assert.equal(failedSdk.status, 409);
    assert.equal(
      (await failedSdk.json()).error.code,
      "MODULE_UI_FAILED"
    );

    const failed = await fetch(
      `${daemon.origin}/module-ui/${session.sessionId}/1/`
    );
    assert.equal(failed.status, 409);
    assert.equal(
      (await failed.json()).error.code,
      "MODULE_UI_FAILED"
    );

    await assert.rejects(
      () =>
        host.callSdk(
          session.sessionId,
          1,
          "accounts.read",
          {}
        ),
      (error) =>
        error instanceof ModuleUiHostError &&
        error.code === "MODULE_UI_FAILED"
    );

    const health = await fetch(`${daemon.origin}/api/v1/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");

    const reset = host.reset(session.sessionId);
    assert.equal(reset.state, "READY");
    assert.equal(reset.uiGeneration, 2);
    assert.equal(reset.runtimeGeneration, 7);

    const stale = await fetch(
      `${daemon.origin}/module-ui/${session.sessionId}/1/`
    );
    assert.equal(stale.status, 409);
    assert.equal(
      (await stale.json()).error.code,
      "MODULE_UI_STALE"
    );

    const staleWrapper = await fetch(
      `${daemon.origin}${session.hostPath}`
    );
    assert.equal(staleWrapper.status, 409);

    const recoveredWrapperResponse = await fetch(
      `${daemon.origin}${reset.hostPath}`
    );
    assert.equal(recoveredWrapperResponse.status, 200);
    assert.doesNotMatch(
      await recoveredWrapperResponse.text(),
      /allow-same-origin/
    );

    const recovered = await fetch(
      `${daemon.origin}/module-ui/${session.sessionId}/2/`
    );
    assert.equal(recovered.status, 200);
    assert.match(await recovered.text(), /Reference UI/);

    const traversal = await fetch(
      `${daemon.origin}/module-ui/${session.sessionId}/2/%2e%2e/manifest.json`
    );
    assert.ok(traversal.status === 400 || traversal.status === 404);
  } finally {
    await daemon.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
