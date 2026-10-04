import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ChromiumBrowserError,
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

  function manager(maxActivePersonas = 8) {
    return new ChromiumBrowserManager({
      lifecycle,
      database,
      executablePath: requiredChromiumBinary(),
      startupTimeoutMs: 20_000,
      closeTimeoutMs: 8_000,
      maxActivePersonas
    });
  }

  return { root, paths, database, lifecycle, manager };
}

async function endpointHealthy(session) {
  const response = await fetch(`${session.devTools.httpOrigin}/json/version`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.webSocketDebuggerUrl, session.devTools.webSocketUrl);
}

async function waitForProcessExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && error.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} did not exit within ${timeoutMs} ms`);
}

test("fresh BrowserManager safely reconnects a persisted owned Chromium Persona", async () => {
  const f = await fixture("pcms-chromium-restart-");
  const firstManager = f.manager();
  const secondManager = f.manager();
  let firstSession;
  let reconciled;

  try {
    firstSession = await firstManager.launch("persona_restart", {
      headless: true,
      disableSandboxForTesting: true
    });
    await endpointHealthy(firstSession);

    const before = f.database.prepare(`
      SELECT state, pid, process_start_ticks, executable_real_path, devtools_port, devtools_path
      FROM persona_browser_runtime
      WHERE persona_uid = ?
    `).get("persona_restart");
    assert.equal(before.state, "RUNNING");
    assert.equal(before.pid, firstSession.pid);
    assert.match(before.process_start_ticks, /^\d+$/u);
    assert.equal(typeof before.executable_real_path, "string");
    assert.equal(before.devtools_port, firstSession.devTools.port);
    assert.equal(
      before.devtools_path,
      new URL(firstSession.devTools.webSocketUrl).pathname
    );

    reconciled = await secondManager.reconcile("persona_restart");
    assert.ok(reconciled);
    assert.equal(reconciled.pid, firstSession.pid);
    assert.equal(reconciled.profilePath, firstSession.profilePath);
    assert.equal(
      reconciled.devTools.webSocketUrl,
      firstSession.devTools.webSocketUrl
    );
    assert.equal(f.lifecycle.get("persona_restart").profileState, "OPEN");
    await endpointHealthy(reconciled);

    await reconciled.close();
    reconciled = undefined;
    await firstSession.close();
    firstSession = undefined;
    assert.equal(f.lifecycle.get("persona_restart").profileState, "CLOSED");
    assert.equal(
      f.database.prepare(`
        SELECT COUNT(*) AS count
        FROM persona_browser_runtime
        WHERE persona_uid = ?
      `).get("persona_restart").count,
      0
    );
  } finally {
    if (reconciled !== undefined) {
      await reconciled.close();
    } else if (firstSession !== undefined) {
      await firstSession.close();
    }
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Chromium crash preserves Persona profile and reconciles runtime to CLOSED", async () => {
  const f = await fixture("pcms-chromium-crash-");
  const manager = f.manager();
  let session;

  try {
    session = await manager.launch("persona_crash", {
      headless: true,
      disableSandboxForTesting: true
    });
    const profilePath = session.profilePath;
    const pid = session.pid;

    process.kill(pid, "SIGKILL");
    await waitForProcessExit(pid);

    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      f.lifecycle.get("persona_crash").profileState !== "CLOSED"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(f.lifecycle.get("persona_crash").profileState, "CLOSED");
    assert.equal(
      f.database.prepare(`
        SELECT COUNT(*) AS count
        FROM persona_browser_runtime
        WHERE persona_uid = ?
      `).get("persona_crash").count,
      0
    );
    assert.equal(
      join(f.paths.personasRoot, "persona_crash", "chromium"),
      profilePath
    );

    const reopened = await manager.launch("persona_crash", {
      headless: true,
      disableSandboxForTesting: true
    });
    session = reopened;
    assert.equal(reopened.profilePath, profilePath);
    assert.notEqual(reopened.pid, pid);
    await endpointHealthy(reopened);
    await reopened.close();
    session = undefined;
  } finally {
    if (session !== undefined) {
      await session.close();
    }
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("ambiguous persisted ownership refuses attach and second launch", async () => {
  const f = await fixture("pcms-chromium-ambiguous-");
  const firstManager = f.manager();
  const secondManager = f.manager();
  let session;

  try {
    session = await firstManager.launch("persona_ambiguous", {
      headless: true,
      disableSandboxForTesting: true
    });

    f.database.prepare(`
      UPDATE persona_browser_runtime
      SET process_start_ticks = '0'
      WHERE persona_uid = ?
    `).run("persona_ambiguous");

    await assert.rejects(
      () => secondManager.launch("persona_ambiguous", {
        headless: true,
        disableSandboxForTesting: true
      }),
      (error) => {
        assert.ok(error instanceof ChromiumBrowserError);
        assert.equal(error.code, "PERSONA_BROWSER_OWNERSHIP_AMBIGUOUS");
        return true;
      }
    );

    assert.equal(
      f.database.prepare(`
        SELECT state
        FROM persona_browser_runtime
        WHERE persona_uid = ?
      `).get("persona_ambiguous").state,
      "DEGRADED"
    );
    process.kill(session.pid, 0);
    await endpointHealthy(session);

    await session.close();
    session = undefined;
  } finally {
    if (session !== undefined) {
      await session.close();
    }
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("active Persona cap rejects excess work without killing the running Persona", async () => {
  const f = await fixture("pcms-chromium-cap-");
  const manager = f.manager(1);
  let alpha;
  let beta;

  try {
    for (let index = 0; index < 52; index += 1) {
      await f.lifecycle.allocate(`dormant_${index}`);
    }

    alpha = await manager.launch("persona_cap_alpha", {
      headless: true,
      disableSandboxForTesting: true
    });

    await assert.rejects(
      () => manager.launch("persona_cap_beta", {
        headless: true,
        disableSandboxForTesting: true
      }),
      (error) => {
        assert.ok(error instanceof ChromiumBrowserError);
        assert.equal(error.code, "PERSONA_BROWSER_CAPACITY_EXCEEDED");
        return true;
      }
    );

    process.kill(alpha.pid, 0);
    await endpointHealthy(alpha);
    assert.equal(f.lifecycle.get("persona_cap_alpha").profileState, "OPEN");
    assert.equal(f.lifecycle.get("persona_cap_beta").profileState, "CLOSED");

    await alpha.close();
    alpha = undefined;

    beta = await manager.launch("persona_cap_beta", {
      headless: true,
      disableSandboxForTesting: true
    });
    await endpointHealthy(beta);
    await beta.close();
    beta = undefined;
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


test("P045 Chromium crash matrix preserves unrelated running Persona", async () => {
  const f = await fixture("pcms-p045-chromium-isolation-");
  const manager = f.manager(2);
  let alpha;
  let beta;

  try {
    alpha = await manager.launch("persona_p045_alpha", {
      headless: true,
      disableSandboxForTesting: true
    });
    beta = await manager.launch("persona_p045_beta", {
      headless: true,
      disableSandboxForTesting: true
    });
    await endpointHealthy(alpha);
    await endpointHealthy(beta);

    const alphaPid = alpha.pid;
    const betaPid = beta.pid;
    process.kill(alphaPid, "SIGKILL");
    await waitForProcessExit(alphaPid);

    const deadline = Date.now() + 5_000;
    while (
      Date.now() < deadline &&
      f.lifecycle.get("persona_p045_alpha").profileState !== "CLOSED"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(
      f.lifecycle.get("persona_p045_alpha").profileState,
      "CLOSED"
    );
    assert.equal(
      f.database.prepare(`
        SELECT COUNT(*) AS count
        FROM persona_browser_runtime
        WHERE persona_uid = ?
      `).get("persona_p045_alpha").count,
      0
    );

    process.kill(betaPid, 0);
    await endpointHealthy(beta);
    assert.equal(
      f.lifecycle.get("persona_p045_beta").profileState,
      "OPEN"
    );
    assert.equal(
      f.database.prepare(`
        SELECT state
        FROM persona_browser_runtime
        WHERE persona_uid = ?
      `).get("persona_p045_beta").state,
      "RUNNING"
    );

    const reopened = await manager.launch(
      "persona_p045_alpha",
      {
        headless: true,
        disableSandboxForTesting: true
      }
    );
    alpha = reopened;
    assert.notEqual(alpha.pid, alphaPid);
    await endpointHealthy(alpha);
    await endpointHealthy(beta);

    await alpha.close();
    alpha = undefined;
    await beta.close();
    beta = undefined;
  } finally {
    if (alpha !== undefined) {
      await alpha.close().catch(() => undefined);
    }
    if (beta !== undefined) {
      await beta.close().catch(() => undefined);
    }
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
