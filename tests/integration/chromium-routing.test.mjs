import assert from "node:assert/strict";
import test from "node:test";

import {
  ChromiumRoutingError,
  ChromiumRoutingManager
} from "../../dist/routing/chromium-routing.js";

function fakeBrowserSession(personaUid, events) {
  return {
    personaUid,
    pid: 1234,
    profilePath: `/tmp/${personaUid}`,
    executablePath: "/usr/bin/chromium",
    browserVersion: "Chromium test",
    devTools: {
      port: 9222,
      httpOrigin: "http://127.0.0.1:9222",
      webSocketUrl: "ws://127.0.0.1:9222/devtools/browser/test"
    },
    async close() {
      events.push(`browser.close:${personaUid}`);
    }
  };
}

test("routing coordinator requires an explicit mode and visibly classifies Direct", async () => {
  const events = [];
  const launches = [];
  const manager = new ChromiumRoutingManager({
    browser: {
      async reconcile() {
        return null;
      },
      async launch(personaUid, options = {}) {
        launches.push({ personaUid, options });
        return fakeBrowserSession(personaUid, events);
      }
    },
    protectedChromium: {
      async launch() {
        throw new Error("protected launcher must not run");
      }
    }
  });

  await assert.rejects(
    () => manager.launch({ personaUid: "persona-missing-mode" }),
    (error) => {
      assert.ok(error instanceof ChromiumRoutingError);
      assert.equal(error.code, "ROUTING_MODE_REQUIRED");
      return true;
    }
  );

  const session = await manager.launch({
    mode: "DIRECT",
    personaUid: "persona-direct"
  });

  assert.equal(session.mode, "DIRECT");
  assert.equal(session.routeId, null);
  assert.equal(session.expectedEgressIdentity, null);
  assert.deepEqual(launches, [
    {
      personaUid: "persona-direct",
      options: {}
    }
  ]);
  assert.deepEqual(manager.mutationAdmission("persona-direct"), {
    allowed: true,
    mode: "DIRECT",
    routeId: null,
    reason: "DIRECT_SELECTED"
  });

  await session.close();
  assert.deepEqual(events, ["browser.close:persona-direct"]);
  assert.equal(manager.get("persona-direct"), null);
});

test("Block is a distinct routed mode with its own owned loopback guard", async () => {
  const events = [];
  let launchOptions;
  const manager = new ChromiumRoutingManager({
    browser: {
      async reconcile() {
        return null;
      },
      async launch(personaUid, options = {}) {
        launchOptions = options;
        return fakeBrowserSession(personaUid, events);
      }
    },
    protectedChromium: {
      async launch() {
        throw new Error("protected launcher must not run");
      }
    }
  });

  const session = await manager.launch({
    mode: "BLOCK",
    personaUid: "persona-block"
  });

  assert.equal(session.mode, "BLOCK");
  assert.equal(session.routeId, null);
  assert.equal(session.expectedEgressIdentity, null);
  assert.equal(launchOptions.protectedProxy.host, "127.0.0.1");
  assert.ok(
    Number.isSafeInteger(launchOptions.protectedProxy.port) &&
      launchOptions.protectedProxy.port > 0
  );
  assert.deepEqual(manager.mutationAdmission("persona-block"), {
    allowed: false,
    mode: "BLOCK",
    routeId: null,
    reason: "BLOCK_MODE"
  });

  await session.close();
  assert.deepEqual(events, ["browser.close:persona-block"]);
});
