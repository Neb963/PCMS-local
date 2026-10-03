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
