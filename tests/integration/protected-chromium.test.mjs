import assert from "node:assert/strict";
import test from "node:test";

import {
  ProtectedChromiumError,
  ProtectedChromiumManager
} from "../../dist/routing/protected-chromium.js";

function lease() {
  return Object.freeze({
    ready: true,
    routeId: "route-alpha",
    relayIp: "10.124.0.9",
    relayPort: 1080,
    localHost: "127.0.0.1",
    localPort: 43123,
    leaseId: "runtime-alpha",
    leaseGeneration: 7,
    leaseTtlSeconds: 60,
    selectedEntry: "synthetic"
  });
}

function browserSession(events) {
  return Object.freeze({
    personaUid: "persona-protected",
    pid: 1234,
    profilePath: "/tmp/persona-protected",
    executablePath: "/opt/chrome",
    browserVersion: "Chromium synthetic",
    devTools: Object.freeze({
      port: 9222,
      httpOrigin: "http://127.0.0.1:9222",
      webSocketUrl: "ws://127.0.0.1:9222/devtools/browser/test"
    }),
    async close() {
      events.push("browser.close");
    }
  });
}

test("protected launch orders lease, preflight, proxy launch, browser verification and release", async () => {
  const events = [];
  const activeLease = lease();
  const session = browserSession(events);
  let launchOptions;

  const manager = new ProtectedChromiumManager({
    router: {
      async prepareChromiumExit(request) {
        events.push("router.prepare");
        assert.equal(request.routeId, "route-alpha");
        return activeLease;
      },
      async releaseChromiumExit(routeId, leaseId, leaseGeneration) {
        events.push("router.release");
        assert.deepEqual(
          [routeId, leaseId, leaseGeneration],
          ["route-alpha", "runtime-alpha", 7]
        );
        return { released: true };
      }
    },
    browser: {
      async reconcile() {
        events.push("browser.reconcile");
        return null;
      },
      async launch(_personaUid, options) {
        events.push("browser.launch");
        launchOptions = options;
        return session;
      }
    },
    verifier: {
      async verifyForwarder(value) {
        events.push("verify.forwarder");
        assert.equal(value.localPort, 43123);
        return {
          routeIdentity: "synthetic-exit-alpha",
          checkedAt: 100
        };
      },
      async verifyBrowser(value) {
        events.push("verify.browser");
        assert.equal(value, session);
        return {
          routeIdentity: "synthetic-exit-alpha",
          checkedAt: 101
        };
      }
    }
  });

  const protectedSession = await manager.launch({
    personaUid: "persona-protected",
    routeId: "route-alpha",
    relayIp: "10.124.0.9",
    leaseId: "runtime-alpha",
    leaseGeneration: 7,
    expectedEgressIdentity: "synthetic-exit-alpha",
    browser: {
      headless: true,
      disableSandboxForTesting: true
    }
  });

  assert.deepEqual(launchOptions.protectedProxy, {
    host: "127.0.0.1",
    port: 43123
  });
  assert.deepEqual(events, [
    "browser.reconcile",
    "router.prepare",
    "verify.forwarder",
    "browser.launch",
    "verify.browser"
  ]);

  await protectedSession.close();
  await protectedSession.close();
  assert.deepEqual(events.slice(-2), ["browser.close", "router.release"]);
  assert.equal(events.filter((value) => value === "router.release").length, 1);
});

test("protected launch rejects observed route mismatch and cleans up fail-closed", async () => {
  const events = [];
  const activeLease = lease();
  const manager = new ProtectedChromiumManager({
    router: {
      async prepareChromiumExit() {
        events.push("router.prepare");
        return activeLease;
      },
      async releaseChromiumExit() {
        events.push("router.release");
        return { released: true };
      }
    },
    browser: {
      async reconcile() {
        return null;
      },
      async launch() {
        events.push("browser.launch");
        return browserSession(events);
      }
    },
    verifier: {
      async verifyForwarder() {
        events.push("verify.forwarder");
        return { routeIdentity: "synthetic-exit-beta", checkedAt: 100 };
      },
      async verifyBrowser() {
        throw new Error("must not launch browser after preflight mismatch");
      }
    }
  });

  await assert.rejects(
    () => manager.launch({
      personaUid: "persona-protected",
      routeId: "route-alpha",
      relayIp: "10.124.0.9",
      leaseId: "runtime-alpha",
      leaseGeneration: 7,
      expectedEgressIdentity: "synthetic-exit-alpha"
    }),
    (error) =>
      error instanceof ProtectedChromiumError &&
      error.code === "PROTECTED_EGRESS_MISMATCH"
  );
  assert.deepEqual(events, [
    "router.prepare",
    "verify.forwarder",
    "router.release"
  ]);
});

test("browser verification mismatch closes browser before releasing its lease", async () => {
  const events = [];
  const activeLease = lease();
  const manager = new ProtectedChromiumManager({
    router: {
      async prepareChromiumExit() {
        events.push("router.prepare");
        return activeLease;
      },
      async releaseChromiumExit() {
        events.push("router.release");
        return { released: true };
      }
    },
    browser: {
      async reconcile() {
        return null;
      },
      async launch() {
        events.push("browser.launch");
        return browserSession(events);
      }
    },
    verifier: {
      async verifyForwarder() {
        return { routeIdentity: "synthetic-exit-alpha", checkedAt: 100 };
      },
      async verifyBrowser() {
        events.push("verify.browser");
        return { routeIdentity: "synthetic-exit-beta", checkedAt: 101 };
      }
    }
  });

  await assert.rejects(
    () => manager.launch({
      personaUid: "persona-protected",
      routeId: "route-alpha",
      relayIp: "10.124.0.9",
      leaseId: "runtime-alpha",
      leaseGeneration: 7,
      expectedEgressIdentity: "synthetic-exit-alpha"
    }),
    (error) =>
      error instanceof ProtectedChromiumError &&
      error.code === "PROTECTED_EGRESS_MISMATCH"
  );

  assert.ok(events.indexOf("browser.close") < events.indexOf("router.release"));
});

test("protected launch refuses to reuse a running Persona before allocating a lease", async () => {
  let prepared = false;
  const manager = new ProtectedChromiumManager({
    router: {
      async prepareChromiumExit() {
        prepared = true;
        return lease();
      },
      async releaseChromiumExit() {
        return { released: true };
      }
    },
    browser: {
      async reconcile() {
        return browserSession([]);
      },
      async launch() {
        throw new Error("must not relaunch running Persona");
      }
    },
    verifier: {
      async verifyForwarder() {
        throw new Error("must not verify");
      },
      async verifyBrowser() {
        throw new Error("must not verify");
      }
    }
  });

  await assert.rejects(
    () => manager.launch({
      personaUid: "persona-protected",
      routeId: "route-alpha",
      relayIp: "10.124.0.9",
      leaseId: "runtime-alpha",
      leaseGeneration: 7,
      expectedEgressIdentity: "synthetic-exit-alpha"
    }),
    (error) =>
      error instanceof ProtectedChromiumError &&
      error.code === "PROTECTED_PERSONA_ALREADY_RUNNING"
  );
  assert.equal(prepared, false);
});
