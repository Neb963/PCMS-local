import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BrowserDriver
} from "../../dist/browser/browser-driver.js";
import {
  ChromiumBrowserManager
} from "../../dist/personas/chromium-browser.js";
import {
  ensurePcmsDirectories,
  resolvePcmsPaths
} from "../../dist/config/paths.js";
import {
  PerchanceProvider,
  providerEvidenceFreshness
} from "../../dist/providers/perchance-provider.js";
import {
  PersonaProfileLifecycle
} from "../../dist/personas/profile-lifecycle.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";
import {
  startPerchanceEmulator
} from "../helpers/perchance-emulator.mjs";

const SESSION_STORAGE_KEY = "pcms.perchance.emulator.session";
const SESSION_STATE_EXPRESSION = `(() => {
  const raw = sessionStorage.getItem("${SESSION_STORAGE_KEY}");
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    return {
      identity: typeof value.identity === "string" ? value.identity : null,
      sessionToken:
        typeof value.sessionToken === "string" ? value.sessionToken : null
    };
  } catch {
    return null;
  }
})()`;

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

async function selectLoadedPage(connection, url) {
  const deadline = Date.now() + 5_000;
  let page;
  while (Date.now() < deadline) {
    const targets = await connection.listPages();
    const target = targets.find((candidate) => candidate.url === url);
    if (target !== undefined) {
      page = await connection.selectPage({ targetId: target.targetId });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(page, "emulator page target must become available");

  while (Date.now() < deadline) {
    const readyState = await page.evaluate("document.readyState");
    if (readyState === "complete" || readyState === "interactive") {
      return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("emulator page did not become ready");
}

async function setBrowserSession(page, session) {
  if (session === null) {
    await page.evaluate(
      `sessionStorage.removeItem(${JSON.stringify(SESSION_STORAGE_KEY)})`
    );
    return;
  }
  const value = JSON.stringify(session);
  await page.evaluate(
    `sessionStorage.setItem(${JSON.stringify(SESSION_STORAGE_KEY)}, ${JSON.stringify(value)})`
  );
}

test("P026 Perchance identity and GeneratorRef probes run through the owned real BrowserDriver", async () => {
  const emulator = await startPerchanceEmulator({
    accounts: [
      {
        identity: "Owner@Example.test",
        sessionToken: "fixture-session-owner",
        generators: [
          { publicId: "public-stable-1", slug: "alpha-generator" }
        ]
      },
      {
        identity: "Other@Example.test",
        sessionToken: "fixture-session-other",
        generators: [
          { publicId: "public-other-1", slug: "other-generator" }
        ]
      }
    ]
  });
  const f = await fixture("pcms-perchance-provider-");
  const personaUid = "persona_perchance_provider";
  let session;
  let connection;
  let nowMs = Date.parse("2026-10-03T13:00:00.000Z");

  try {
    session = await f.manager.launch(personaUid, {
      initialUrl: emulator.origin,
      headless: true,
      disableSandboxForTesting: true
    });
    connection = await f.driver.connect(personaUid);
    const page = await selectLoadedPage(connection, emulator.origin);
    const provider = new PerchanceProvider({
      browserProfile: {
        sessionStateExpression: SESSION_STATE_EXPRESSION
      },
      now: () => new Date(nowMs)
    });

    await setBrowserSession(page, emulator.sessionFor("owner@example.test"));
    const expected = await provider.probeSessionIdentity(
      page,
      "owner@example.test"
    );
    assert.deepEqual(expected, {
      status: "EXPECTED",
      reasonCode: "SESSION_VERIFIED",
      observedIdentity: "Owner@Example.test",
      generatorCount: 1,
      observedAt: "2026-10-03T13:00:00.000Z"
    });
    assert.equal(JSON.stringify(expected).includes("fixture-session-owner"), false);
    assert.equal(JSON.stringify(expected).includes("sessionToken"), false);

    await setBrowserSession(page, emulator.sessionFor("other@example.test"));
    const mismatch = await provider.probeSessionIdentity(
      page,
      "owner@example.test"
    );
    assert.equal(mismatch.status, "MISMATCH");
    assert.equal(mismatch.reasonCode, "SESSION_IDENTITY_MISMATCH");
    assert.equal(mismatch.observedIdentity, "Other@Example.test");

    await setBrowserSession(page, null);
    const noSession = await provider.probeSessionIdentity(
      page,
      "owner@example.test"
    );
    assert.equal(noSession.status, "UNKNOWN");
    assert.equal(noSession.reasonCode, "SESSION_MATERIAL_UNAVAILABLE");

    await setBrowserSession(page, emulator.sessionFor("owner@example.test"));
    emulator.setScenario("UNKNOWN_STATUS");
    const drift = await provider.probeSessionIdentity(
      page,
      "owner@example.test"
    );
    assert.equal(drift.status, "UNKNOWN");
    assert.equal(drift.reasonCode, "PROVIDER_PROTOCOL_UNKNOWN");

    emulator.setScenario("PERIMETER_HTML");
    const perimeter = await provider.probeSessionIdentity(
      page,
      "owner@example.test"
    );
    assert.equal(perimeter.status, "UNKNOWN");
    assert.equal(perimeter.reasonCode, "PROVIDER_ACCESS_BLOCKED");

    emulator.setScenario("NORMAL");
    const expectedGenerator = {
      generatorLocalId: "generator_local_1",
      providerStableId: "public-stable-1",
      currentSlug: "alpha-generator"
    };
    const current = await provider.probeGeneratorIdentity(
      page,
      "owner@example.test",
      expectedGenerator
    );
    assert.equal(current.sessionStatus, "EXPECTED");
    assert.equal(current.identityStatus, "VERIFIED");
    assert.equal(current.slugStatus, "CURRENT");
    assert.equal(current.observedProviderStableId, "public-stable-1");
    assert.equal(current.observedSlug, "alpha-generator");

    emulator.renameGenerator("public-stable-1", "renamed-generator");
    const renamed = await provider.probeGeneratorIdentity(
      page,
      "owner@example.test",
      expectedGenerator
    );
    assert.equal(renamed.identityStatus, "VERIFIED");
    assert.equal(renamed.slugStatus, "CHANGED");
    assert.equal(renamed.observedProviderStableId, "public-stable-1");
    assert.equal(renamed.observedSlug, "renamed-generator");
    assert.equal(renamed.reasonCode, "GENERATOR_SLUG_CHANGED");

    assert.equal(
      providerEvidenceFreshness(renamed.observedAt, new Date(nowMs), 60_000),
      "CURRENT"
    );
    nowMs += 61_000;
    assert.equal(
      providerEvidenceFreshness(renamed.observedAt, new Date(nowMs), 60_000),
      "STALE"
    );

    emulator.replaceGeneratorStableId(
      "public-stable-1",
      "public-stable-replacement"
    );
    const stableMismatch = await provider.probeGeneratorIdentity(
      page,
      "owner@example.test",
      {
        ...expectedGenerator,
        currentSlug: "renamed-generator"
      }
    );
    assert.equal(stableMismatch.sessionStatus, "EXPECTED");
    assert.equal(stableMismatch.identityStatus, "MISMATCH");
    assert.equal(stableMismatch.slugStatus, "CURRENT");
    assert.equal(
      stableMismatch.observedProviderStableId,
      "public-stable-replacement"
    );
    assert.equal(
      stableMismatch.reasonCode,
      "GENERATOR_STABLE_ID_MISMATCH"
    );

    const unknownStable = await provider.probeGeneratorIdentity(
      page,
      "owner@example.test",
      {
        generatorLocalId: "generator_unbound_1",
        providerStableId: null,
        currentSlug: "renamed-generator"
      }
    );
    assert.equal(unknownStable.identityStatus, "UNKNOWN");
    assert.equal(unknownStable.slugStatus, "CURRENT");
    assert.equal(
      unknownStable.observedProviderStableId,
      "public-stable-replacement"
    );

    const requests = emulator.requests();
    assert.ok(requests.length >= 8);
    assert.ok(requests.every((request) => request.path === "/api/getGeneratorsByUser"));
    assert.equal(JSON.stringify(requests).includes("fixture-session"), false);
    assert.equal(f.lifecycle.get(personaUid).profileState, "OPEN");
  } finally {
    if (connection !== undefined) {
      await connection.disconnect();
    }
    if (session !== undefined) {
      await session.close();
    }
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
    await emulator.close();
  }
});
