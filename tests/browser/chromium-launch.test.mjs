import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
  assert.ok(
    value,
    "PCMS_CHROMIUM_BINARY is required for real-browser acceptance"
  );
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
    executablePath: requiredChromiumBinary(),
    startupTimeoutMs: 20_000,
    closeTimeoutMs: 8_000
  });
  return { root, paths, database, lifecycle, manager };
}

test("launches real Chromium on an owned non-default profile with loopback DevTools", async () => {
  const f = await fixture("pcms-chromium-launch-");
  let session;
  try {
    const probe = await f.manager.probe();
    assert.match(probe.version, /(Chrome|Chromium)/u);

    session = await f.manager.launch("persona_browser_launch", {
      headless: true,
      disableSandboxForTesting: true
    });

    assert.ok(session.pid > 0);
    assert.equal(
      session.profilePath,
      join(f.paths.personasRoot, "persona_browser_launch", "chromium")
    );
    assert.equal(session.executablePath, probe.executablePath);
    assert.equal(session.browserVersion, probe.version);
    assert.match(session.devTools.httpOrigin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.match(
      session.devTools.webSocketUrl,
      /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//u
    );

    const version = await fetch(`${session.devTools.httpOrigin}/json/version`);
    assert.equal(version.status, 200);
    const versionPayload = await version.json();
    assert.equal(
      versionPayload.webSocketDebuggerUrl,
      session.devTools.webSocketUrl
    );
    assert.equal(f.lifecycle.get("persona_browser_launch").profileState, "OPEN");

    await session.close();
    session = undefined;
    assert.equal(
      f.lifecycle.get("persona_browser_launch").profileState,
      "CLOSED"
    );
  } finally {
    if (session !== undefined) {
      await session.close();
    }
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
