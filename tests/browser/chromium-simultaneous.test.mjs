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
    database,
    executablePath: requiredChromiumBinary(),
    startupTimeoutMs: 20_000,
    closeTimeoutMs: 8_000
  });
  return { root, paths, database, lifecycle, manager };
}

async function assertEndpointHealthy(session) {
  const response = await fetch(`${session.devTools.httpOrigin}/json/version`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.webSocketDebuggerUrl, session.devTools.webSocketUrl);
}

test("two simultaneous Personas have distinct process, profile and DevTools ownership", async () => {
  const f = await fixture("pcms-chromium-simultaneous-");
  let alpha;
  let beta;

  try {
    alpha = await f.manager.launch("persona_live_alpha", {
      headless: true,
      disableSandboxForTesting: true
    });
    beta = await f.manager.launch("persona_live_beta", {
      headless: true,
      disableSandboxForTesting: true
    });

    assert.notEqual(alpha.pid, beta.pid);
    assert.notEqual(alpha.profilePath, beta.profilePath);
    assert.notEqual(alpha.devTools.port, beta.devTools.port);
    assert.notEqual(alpha.devTools.httpOrigin, beta.devTools.httpOrigin);
    assert.notEqual(alpha.devTools.webSocketUrl, beta.devTools.webSocketUrl);

    assert.equal(
      alpha.profilePath,
      join(f.paths.personasRoot, "persona_live_alpha", "chromium")
    );
    assert.equal(
      beta.profilePath,
      join(f.paths.personasRoot, "persona_live_beta", "chromium")
    );

    process.kill(alpha.pid, 0);
    process.kill(beta.pid, 0);
    await Promise.all([
      assertEndpointHealthy(alpha),
      assertEndpointHealthy(beta)
    ]);

    assert.equal(f.lifecycle.get("persona_live_alpha").profileState, "OPEN");
    assert.equal(f.lifecycle.get("persona_live_beta").profileState, "OPEN");

    await alpha.close();
    alpha = undefined;

    assert.equal(
      f.lifecycle.get("persona_live_alpha").profileState,
      "CLOSED"
    );
    assert.equal(f.lifecycle.get("persona_live_beta").profileState, "OPEN");
    process.kill(beta.pid, 0);
    await assertEndpointHealthy(beta);

    await beta.close();
    beta = undefined;
    assert.equal(
      f.lifecycle.get("persona_live_beta").profileState,
      "CLOSED"
    );
  } finally {
    if (alpha !== undefined) {
      await alpha.close();
    }
    if (beta !== undefined) {
      await beta.close();
    }
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
