import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import { BrowserDriver } from "../../dist/browser/browser-driver.js";
import {
  ensurePcmsDirectories,
  resolvePcmsPaths
} from "../../dist/config/paths.js";
import { ChromiumBrowserManager } from "../../dist/personas/chromium-browser.js";
import { PersonaProfileLifecycle } from "../../dist/personas/profile-lifecycle.js";
import { ProvisioningAllocationService } from "../../dist/provisioning/allocation.js";
import { ProvisioningBrowserFlow } from "../../dist/provisioning/browser-flow.js";
import { ProvisioningStagingService } from "../../dist/provisioning/staging.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";
import { startPerchanceEmulator } from "../helpers/perchance-emulator.mjs";

function requiredChromiumBinary() {
  const value = process.env.PCMS_CHROMIUM_BINARY;
  assert.ok(value, "PCMS_CHROMIUM_BINARY is required for real-browser acceptance");
  return value;
}

async function selectLoadedPage(connection, url) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const targets = await connection.listPages();
    const target = targets.find((candidate) => candidate.url === url);
    if (target !== undefined) {
      const page = await connection.selectPage({ targetId: target.targetId });
      const ready = await page.evaluate("document.readyState");
      if (ready === "complete" || ready === "interactive") {
        return page;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("provisioning emulator page did not become ready");
}

test("P038 signup and login operate the allocated Account's same managed Persona session", async () => {
  const emulator = await startPerchanceEmulator();
  const root = await mkdtemp(join(tmpdir(), "pcms-p038-browser-flow-"));
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
  const staging = new ProvisioningStagingService({ database });
  const allocation = new ProvisioningAllocationService({
    database,
    personasRoot: paths.personasRoot
  });
  const accounts = new AccountRepository({ database });
  const flow = new ProvisioningBrowserFlow();
  const personaUid = "persona_p038_provisioning";
  const provisioningUrl =
    new URL("/__pcms_emulator__/provisioning", emulator.origin).href;
  const password = "p038-transient-password";
  let browserSession;
  let connection;

  try {
    const [staged] = staging.stageBatch([{
      accountId: "account_p038_provisioning",
      displayName: "Provisioning Account",
      providerIdentity: "p038@example.test",
      credentialSecretRef: "secret:accounts/p038"
    }]);
    const allocated = await allocation.allocate(staged, personaUid);
    assert.equal(allocated.account.lifecycleStatus, "INACTIVE");
    assert.equal(allocated.account.personaUid, personaUid);

    browserSession = await manager.launch(personaUid, {
      initialUrl: provisioningUrl,
      headless: true,
      disableSandboxForTesting: true
    });
    const originalPid = browserSession.pid;
    const originalProfilePath = browserSession.profilePath;

    connection = await driver.connect(personaUid);
    const page = await selectLoadedPage(connection, provisioningUrl);
    const originalTargetId = page.targetId;

    const signup = await flow.signup(page, {
      providerIdentity: staged.providerIdentity,
      password
    });
    assert.deepEqual(signup, {
      action: "SIGNUP",
      providerStatus: "submitted",
      session: {
        authenticated: true,
        observedIdentity: "p038@example.test",
        verification: "UNVERIFIED"
      }
    });

    const login = await flow.login(page, {
      providerIdentity: staged.providerIdentity,
      password
    });
    assert.deepEqual(login, {
      action: "LOGIN",
      providerStatus: "authenticated",
      session: {
        authenticated: true,
        observedIdentity: "p038@example.test",
        verification: "UNVERIFIED"
      }
    });

    assert.equal(accounts.require(staged.accountId).lifecycleStatus, "INACTIVE");
    assert.equal(accounts.require(staged.accountId).personaUid, personaUid);

    await connection.disconnect();
    connection = undefined;

    const runtimeBeforeReconnect = database.prepare(`
      SELECT pid, profile_path
      FROM persona_browser_runtime
      WHERE persona_uid = ?
    `).get(personaUid);
    assert.equal(runtimeBeforeReconnect.pid, originalPid);
    assert.equal(runtimeBeforeReconnect.profile_path, originalProfilePath);

    connection = await driver.connect(personaUid);
    const reattachedPage = await selectLoadedPage(connection, provisioningUrl);
    assert.equal(reattachedPage.targetId, originalTargetId);
    assert.deepEqual(await flow.observeSession(reattachedPage), {
      authenticated: true,
      observedIdentity: "p038@example.test",
      verification: "UNVERIFIED"
    });
    assert.equal(browserSession.pid, originalPid);
    assert.equal(browserSession.profilePath, originalProfilePath);

    const provisioningRequests = emulator.requests().filter((entry) =>
      entry.path.startsWith("/__pcms_emulator__/provisioning/")
    );
    assert.deepEqual(
      provisioningRequests.map((entry) => entry.path),
      [
        "/__pcms_emulator__/provisioning/signup",
        "/__pcms_emulator__/provisioning/session",
        "/__pcms_emulator__/provisioning/login",
        "/__pcms_emulator__/provisioning/session",
        "/__pcms_emulator__/provisioning/session"
      ]
    );
    assert.equal(
      JSON.stringify(provisioningRequests).includes(password),
      false,
      "emulator request evidence must never contain transient password bytes"
    );
    assert.equal(
      provisioningRequests.filter((entry) => entry.passwordPresent === true).length,
      2
    );
  } finally {
    if (connection !== undefined) {
      await connection.disconnect().catch(() => {});
    }
    if (browserSession !== undefined) {
      await browserSession.close().catch(() => {});
    }
    database.close();
    await emulator.close();
    await rm(root, { recursive: true, force: true });
  }
});
