import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BrowserDriver,
  BrowserDriverError
} from "../../dist/browser/browser-driver.js";
import {
  ChromiumBrowserManager
} from "../../dist/personas/chromium-browser.js";
import {
  ensurePcmsDirectories,
  resolvePcmsPaths
} from "../../dist/config/paths.js";
import {
  PersonaProfileLifecycle
} from "../../dist/personas/profile-lifecycle.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

function requiredChromiumBinary() {
  const value = process.env.PCMS_CHROMIUM_BINARY;
  assert.ok(value, "PCMS_CHROMIUM_BINARY is required for real-browser acceptance");
  return value;
}

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const paths = resolvePcmsPaths({
    env: {
      PCMS_CONFIG_ROOT: join(root, "config"),
      PCMS_DATA_ROOT: join(root, "data"),
      PCMS_CACHE_ROOT: join(root, "cache")
    },
    homeDir: root
  });
  await ensurePcmsDirectories(paths);
  const database = openConfiguredSqliteDatabase(paths.databasePath);
  applyPcmsMigrations(database);
  const lifecycle = new PersonaProfileLifecycle({
    database,
    personasRoot: paths.personasRoot
  });
  const manager = new ChromiumBrowserManager({
    lifecycle,
    database,
    executablePath: requiredChromiumBinary(),
    startupTimeoutMs: 20_000,
    closeTimeoutMs: 8_000
  });
  const driver = new BrowserDriver({
    browserManager: manager,
    connectTimeoutMs: 5_000,
    commandTimeoutMs: 5_000
  });
  return { root, database, lifecycle, manager, driver };
}


async function sendRootCdpCommand(webSocketUrl, method, params = {}) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out opening root CDP socket")),
      5_000
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Root CDP socket failed"));
    }, { once: true });
  });

  try {
    const result = await new Promise((resolve, reject) => {
      const id = 1;
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for CDP ${method}`)),
        5_000
      );
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        const message = JSON.parse(event.data);
        if (message.id !== id) {
          return;
        }
        clearTimeout(timer);
        if (message.error !== undefined) {
          reject(new Error(`CDP ${method} failed: ${JSON.stringify(message.error)}`));
          return;
        }
        resolve(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    return result;
  } finally {
    socket.close(1000, "P025 target-loss fixture complete");
  }
}

test("BrowserDriver attaches to and selects a page from an already-running owned Persona", async () => {
  const f = await fixture("pcms-browser-driver-connect-");
  const personaUid = "persona_browser_driver_connect";
  let session;
  let connection;

  try {
    await assert.rejects(
      () => f.driver.connect(personaUid),
      (error) => {
        assert.ok(error instanceof BrowserDriverError);
        assert.equal(error.code, "BROWSER_DRIVER_PERSONA_NOT_RUNNING");
        assert.equal(error.personaUid, personaUid);
        assert.equal(error.operation, "connect");
        return true;
      }
    );

    session = await f.manager.launch(personaUid, {
      headless: true,
      disableSandboxForTesting: true
    });
    const runtimeBefore = f.database.prepare(`
      SELECT state, pid, devtools_port, devtools_path
      FROM persona_browser_runtime
      WHERE persona_uid = ?
    `).get(personaUid);

    connection = await f.driver.connect(personaUid);
    assert.deepEqual(connection.endpoint, session.devTools);
    const pages = await connection.listPages();
    assert.ok(pages.length >= 1);
    assert.ok(pages.some((page) => page.url === "about:blank"));

    const page = await connection.selectPage({ url: "about:blank" });
    assert.equal(page.personaUid, personaUid);
    assert.equal(page.url, "about:blank");
    assert.equal(await page.evaluate("6 * 7"), 42);

    const runtimeAfter = f.database.prepare(`
      SELECT state, pid, devtools_port, devtools_path
      FROM persona_browser_runtime
      WHERE persona_uid = ?
    `).get(personaUid);
    assert.deepEqual(runtimeAfter, runtimeBefore);
    assert.equal(f.lifecycle.get(personaUid).profileState, "OPEN");

    await connection.disconnect();
    connection = undefined;
    assert.equal(f.lifecycle.get(personaUid).profileState, "OPEN");
    assert.ok(await f.manager.resolveDevToolsEndpoint(personaUid));
  } finally {
    if (connection !== undefined) {
      await connection.disconnect();
    }
    if (session !== undefined) {
      await session.close();
    }
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});


test("BrowserDriver cancellation and command timeout are structured and bounded", async () => {
  const f = await fixture("pcms-browser-driver-bounds-");
  const personaUid = "persona_browser_driver_bounds";
  let session;
  let connection;

  try {
    session = await f.manager.launch(personaUid, {
      headless: true,
      disableSandboxForTesting: true
    });

    const preCancelled = new AbortController();
    preCancelled.abort(new Error("fixture cancellation"));
    await assert.rejects(
      () => f.driver.connect(personaUid, { signal: preCancelled.signal }),
      (error) => {
        assert.ok(error instanceof BrowserDriverError);
        assert.equal(error.code, "BROWSER_DRIVER_CANCELLED");
        assert.equal(error.operation, "connect");
        return true;
      }
    );

    connection = await f.driver.connect(personaUid);
    const page = await connection.selectPage({ url: "about:blank" });

    const timeoutStarted = Date.now();
    await assert.rejects(
      () => page.evaluate(
        "new Promise((resolve) => setTimeout(() => resolve(1), 1000))",
        { timeoutMs: 75 }
      ),
      (error) => {
        assert.ok(error instanceof BrowserDriverError);
        assert.equal(error.code, "BROWSER_DRIVER_COMMAND_TIMEOUT");
        assert.equal(error.operation, "Runtime.evaluate");
        assert.equal(error.targetId, page.targetId);
        return true;
      }
    );
    assert.ok(
      Date.now() - timeoutStarted < 1_000,
      "command timeout must reject well before the remote promise completes"
    );

    const controller = new AbortController();
    const cancelled = page.evaluate(
      "new Promise((resolve) => setTimeout(() => resolve(2), 1000))",
      { signal: controller.signal, timeoutMs: 5_000 }
    );
    setTimeout(() => controller.abort(new Error("operator cancelled")), 50);
    await assert.rejects(
      () => cancelled,
      (error) => {
        assert.ok(error instanceof BrowserDriverError);
        assert.equal(error.code, "BROWSER_DRIVER_CANCELLED");
        assert.equal(error.operation, "Runtime.evaluate");
        assert.equal(error.targetId, page.targetId);
        return true;
      }
    );

    assert.equal(f.lifecycle.get(personaUid).profileState, "OPEN");
    assert.ok(await f.manager.resolveDevToolsEndpoint(personaUid));
  } finally {
    if (connection !== undefined) {
      await connection.disconnect();
    }
    if (session !== undefined) {
      await session.close();
    }
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("BrowserDriver reports selected page target loss without closing the Persona", async () => {
  const f = await fixture("pcms-browser-driver-target-loss-");
  const personaUid = "persona_browser_driver_target_loss";
  let session;
  let connection;

  try {
    session = await f.manager.launch(personaUid, {
      headless: true,
      disableSandboxForTesting: true
    });
    connection = await f.driver.connect(personaUid);
    const page = await connection.selectPage({ url: "about:blank" });

    const closeResult = await sendRootCdpCommand(
      session.devTools.webSocketUrl,
      "Target.closeTarget",
      { targetId: page.targetId }
    );
    assert.equal(closeResult.success, true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await assert.rejects(
      () => page.evaluate("1 + 1"),
      (error) => {
        assert.ok(error instanceof BrowserDriverError);
        assert.equal(error.code, "BROWSER_DRIVER_TARGET_LOST");
        assert.equal(error.targetId, page.targetId);
        return true;
      }
    );

    assert.equal(f.lifecycle.get(personaUid).profileState, "OPEN");
    assert.ok(await f.manager.resolveDevToolsEndpoint(personaUid));
  } finally {
    if (connection !== undefined) {
      await connection.disconnect();
    }
    if (session !== undefined) {
      await session.close();
    }
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
