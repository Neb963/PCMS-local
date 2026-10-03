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


test("protected route switch blocks mutation admission until verified relaunch completes", async () => {
  const events = [];
  let secondResolve;
  const secondLaunch = new Promise((resolve) => {
    secondResolve = resolve;
  });
  let launchCount = 0;

  const protectedChromium = {
    async launch(request) {
      launchCount += 1;
      events.push(`protected.launch:${request.routeId}`);
      assert.equal("mode" in request, false);

      if (launchCount === 2) {
        await secondLaunch;
      }

      const browser = fakeBrowserSession(request.personaUid, events);
      return {
        personaUid: request.personaUid,
        routeId: request.routeId,
        lease: {
          routeId: request.routeId,
          relayIp: request.relayIp,
          relayPort: request.relayPort ?? 1080,
          localHost: "127.0.0.1",
          localPort: launchCount === 1 ? 43001 : 43002,
          leaseId: request.leaseId,
          leaseGeneration: request.leaseGeneration,
          leaseTtlSeconds: request.leaseTtlSeconds ?? 60,
          selectedEntry: "synthetic"
        },
        browser,
        forwarderEgress: {
          routeIdentity: request.expectedEgressIdentity,
          checkedAt: Date.now()
        },
        browserEgress: {
          routeIdentity: request.expectedEgressIdentity,
          checkedAt: Date.now()
        },
        async close() {
          events.push(`protected.close:${request.routeId}`);
          await browser.close();
        }
      };
    }
  };

  const manager = new ChromiumRoutingManager({
    browser: {
      async reconcile() {
        return null;
      },
      async launch() {
        throw new Error("raw browser launch must not run for protected mode");
      }
    },
    protectedChromium
  });

  const alpha = await manager.launch({
    mode: "PROTECTED",
    personaUid: "persona-switch",
    routeId: "route-alpha",
    relayIp: "10.124.0.9",
    leaseId: "lease-alpha",
    leaseGeneration: 1,
    expectedEgressIdentity: "synthetic-alpha"
  });

  assert.equal(alpha.mode, "PROTECTED");
  assert.deepEqual(manager.mutationAdmission("persona-switch"), {
    allowed: true,
    mode: "PROTECTED",
    routeId: "route-alpha",
    reason: "PROTECTED_VERIFIED"
  });

  const switching = manager.switchProtectedRoute("persona-switch", {
    mode: "PROTECTED",
    personaUid: "persona-switch",
    routeId: "route-beta",
    relayIp: "10.124.0.10",
    leaseId: "lease-beta",
    leaseGeneration: 2,
    expectedEgressIdentity: "synthetic-beta"
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(manager.mutationAdmission("persona-switch"), {
    allowed: false,
    mode: null,
    routeId: null,
    reason: "ROUTE_TRANSITION"
  });
  assert.deepEqual(events, [
    "protected.launch:route-alpha",
    "protected.close:route-alpha",
    "browser.close:persona-switch",
    "protected.launch:route-beta"
  ]);

  secondResolve();
  const beta = await switching;

  assert.equal(beta.mode, "PROTECTED");
  assert.equal(beta.routeId, "route-beta");
  assert.equal(beta.expectedEgressIdentity, "synthetic-beta");
  assert.deepEqual(manager.mutationAdmission("persona-switch"), {
    allowed: true,
    mode: "PROTECTED",
    routeId: "route-beta",
    reason: "PROTECTED_VERIFIED"
  });

  await beta.close();
});
