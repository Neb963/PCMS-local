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
  PerchanceProvider,
  providerEvidenceFreshness
} from "../../dist/providers/perchance-provider.js";
import {
  OperationCoordinator,
  generatorOperationTargetKey
} from "../../dist/operations/operation-coordinator.js";
import {
  HumanTaskStore
} from "../../dist/human-tasks/human-task-store.js";
import {
  HumanContinuationService
} from "../../dist/human-tasks/human-continuation.js";
import {
  OperationReconciler
} from "../../dist/operations/reconciliation.js";
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

const CHALLENGE_STATE_EXPRESSION =
  `fetch("/__pcms_emulator__/challenge", { cache: "no-store" })
    .then((response) => response.json())`;

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


test("P028 response loss after committed emulator effect reconciles read-first without redispatch", async () => {
  const emulator = await startPerchanceEmulator({
    accounts: [{
      identity: "Owner@Example.test",
      sessionToken: "fixture-session-reconcile",
      generators: [
        { publicId: "public-reconcile-1", slug: "before-reconcile" }
      ]
    }]
  });
  const f = await fixture("pcms-perchance-reconcile-");
  const personaUid = "persona_perchance_reconcile";
  let session;
  let connection;

  try {
    session = await f.manager.launch(personaUid, {
      initialUrl: emulator.origin,
      headless: true,
      disableSandboxForTesting: true
    });
    connection = await f.driver.connect(personaUid);
    const page = await selectLoadedPage(connection, emulator.origin);
    await setBrowserSession(
      page,
      emulator.sessionFor("owner@example.test")
    );

    const provider = new PerchanceProvider({
      browserProfile: {
        sessionStateExpression: SESSION_STATE_EXPRESSION
      },
      now: () => new Date("2026-10-03T14:30:00.000Z")
    });
    const coordinator = new OperationCoordinator({
      database: f.database,
      now: () => new Date("2026-10-03T14:30:00.000Z")
    });
    const reconciler = new OperationReconciler(coordinator);
    const operation = coordinator.prepare({
      operationId: "operation-response-loss-1",
      idempotencyKey: "request-response-loss-1",
      owner: { kind: "CORE" },
      actorSource: "p028-browser-test",
      targetKey: generatorOperationTargetKey("generator-reconcile-1"),
      operationKind: "synthetic-generator-rename",
      schemaVersion: 1,
      desiredFingerprint: "c".repeat(64),
      provenance: { source: "perchance-emulator" },
      preconditions: [{
        key: "provider-session",
        observedAt: "2026-10-03T14:30:00.000Z",
        maxAgeMs: 60000,
        evidenceRef: "session-reconcile-1"
      }]
    });
    coordinator.authorizeDispatch({
      operationId: operation.operationId,
      expectedClaimEpoch: operation.claimEpoch,
      evidence: { step: "synthetic-rename" }
    });

    emulator.setScenario("RESPONSE_LOSS_AFTER_EFFECT");
    await assert.rejects(
      () => page.evaluate(`
        fetch("/__pcms_emulator__/renameGenerator", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            publicId: "public-reconcile-1",
            newSlug: "after-reconcile"
          })
        }).then(() => ({ kind: "response" }))
      `, { timeoutMs: 200 }),
      (error) => {
        assert.ok(error instanceof BrowserDriverError);
        assert.equal(error.code, "BROWSER_DRIVER_COMMAND_TIMEOUT");
        assert.equal(error.effectState, "MAY_HAVE_OCCURRED");
        return true;
      }
    );

    const uncertain = coordinator.recordExecutionLoss({
      operationId: operation.operationId,
      expectedClaimEpoch: operation.claimEpoch,
      source: "NETWORK",
      effectState: "MAY_HAVE_OCCURRED"
    });
    assert.equal(uncertain.state, "UNCERTAIN");

    const result = await reconciler.reconcile({
      operationId: operation.operationId,
      expectedClaimEpoch: operation.claimEpoch,
      read: async () => {
        const observed = await provider.probeGeneratorIdentity(
          page,
          "owner@example.test",
          {
            generatorLocalId: "generator-reconcile-1",
            providerStableId: "public-reconcile-1",
            currentSlug: "before-reconcile"
          }
        );
        return observed.identityStatus === "VERIFIED" &&
          observed.observedSlug === "after-reconcile"
          ? {
              kind: "CONFIRMED_APPLIED",
              reason: "reconciliation-read-confirmed-effect"
            }
          : {
              kind: "UNKNOWN",
              reason: "reconciliation-read-inconclusive"
            };
      }
    });

    assert.equal(result.operation.operationId, operation.operationId);
    assert.equal(result.operation.state, "SUCCEEDED");
    const requests = emulator.requests();
    const mutations = requests.filter((entry) =>
      entry.path === "/__pcms_emulator__/renameGenerator"
    );
    assert.equal(mutations.length, 1);
    const mutationIndex = requests.findIndex((entry) =>
      entry.path === "/__pcms_emulator__/renameGenerator"
    );
    const readIndex = requests.findIndex((entry, index) =>
      index > mutationIndex &&
      entry.path === "/api/getGeneratorsByUser"
    );
    assert.ok(mutationIndex >= 0);
    assert.ok(readIndex > mutationIndex);
  } finally {
    if (connection !== undefined) await connection.disconnect();
    if (session !== undefined) await session.close();
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
    await emulator.close();
  }
});


test("P028 emulated challenge focuses the same Persona and resumes the same logical operation", async () => {
  const emulator = await startPerchanceEmulator({
    accounts: [{
      identity: "Owner@Example.test",
      sessionToken: "fixture-session-human",
      generators: [
        { publicId: "public-human-1", slug: "human-generator" }
      ]
    }]
  });
  const f = await fixture("pcms-perchance-human-continuation-");
  const personaUid = "persona_perchance_human";
  let session;
  let connection;

  try {
    session = await f.manager.launch(personaUid, {
      initialUrl: emulator.origin,
      headless: true,
      disableSandboxForTesting: true
    });
    connection = await f.driver.connect(personaUid);
    const page = await selectLoadedPage(connection, emulator.origin);
    await setBrowserSession(
      page,
      emulator.sessionFor("owner@example.test")
    );

    const provider = new PerchanceProvider({
      browserProfile: {
        sessionStateExpression: SESSION_STATE_EXPRESSION,
        challengeStateExpression: CHALLENGE_STATE_EXPRESSION
      },
      now: () => new Date("2026-10-03T15:45:00.000Z")
    });
    emulator.setScenario("CHALLENGE");
    const challenge = await provider.probeHumanChallenge(page);
    assert.deepEqual(challenge, {
      status: "REQUIRED",
      kind: "CAPTCHA",
      challengeId: "synthetic-challenge-1",
      observedAt: "2026-10-03T15:45:00.000Z"
    });

    const coordinator = new OperationCoordinator({
      database: f.database,
      now: () => new Date("2026-10-03T15:45:00.000Z")
    });
    const operation = coordinator.prepare({
      operationId: "operation-human-browser-1",
      idempotencyKey: "request-human-browser-1",
      owner: { kind: "CORE" },
      actorSource: "p028-browser-test",
      targetKey: generatorOperationTargetKey("generator-human-1"),
      operationKind: "synthetic-human-challenge",
      schemaVersion: 1,
      personaUid,
      desiredFingerprint: "f".repeat(64),
      provenance: { source: "perchance-emulator" },
      preconditions: [{
        key: "provider-session",
        observedAt: "2026-10-03T15:45:00.000Z",
        maxAgeMs: 60000,
        evidenceRef: "session-human-browser-1"
      }]
    });
    coordinator.authorizeDispatch({
      operationId: operation.operationId,
      expectedClaimEpoch: operation.claimEpoch,
      evidence: { step: "challenge-probe" }
    });
    coordinator.beginVerification(
      operation.operationId,
      operation.claimEpoch
    );
    coordinator.markNeedsHuman(
      operation.operationId,
      operation.claimEpoch,
      "provider-challenge"
    );

    const tasks = new HumanTaskStore({
      database: f.database,
      now: () => new Date("2026-10-03T15:45:00.000Z")
    });
    const task = tasks.create({
      taskId: "human-task-browser-1",
      taskType: "PROVIDER_CHALLENGE",
      personaUid,
      operationId: operation.operationId,
      title: "Complete provider challenge",
      explanation:
        "Complete the provider challenge in the existing Persona, then continue.",
      requiredActionKind: "COMPLETE_BROWSER_CHALLENGE",
      continuation: {
        kind: "PROVIDER_CHALLENGE",
        version: 1,
        ref: "operation-human-browser-1:challenge-1"
      },
      evidence: {
        challengeKind: "CAPTCHA",
        challengeRef: "synthetic-challenge-1",
        provider: "perchance"
      }
    });
    assert.equal(task.status, "OPEN");

    // The emulator models the human completing the challenge externally. PCMS
    // does not solve or bypass it.
    emulator.setScenario("NORMAL");
    const focusedPersonas = [];
    const continuation = new HumanContinuationService({
      tasks,
      coordinator,
      focusPersona: async (candidatePersonaUid) => {
        focusedPersonas.push(candidatePersonaUid);
        assert.equal(candidatePersonaUid, personaUid);
        assert.equal(page.personaUid, personaUid);
        await page.focus();
      }
    });

    const resumed = await continuation.resume({
      taskId: task.taskId,
      expectedOperationId: operation.operationId,
      expectedClaimEpoch: operation.claimEpoch,
      expectedContinuationRef:
        "operation-human-browser-1:challenge-1"
    });
    assert.equal(resumed.personaUid, personaUid);
    assert.equal(resumed.operation.operationId, operation.operationId);
    assert.equal(resumed.operation.state, "VERIFYING");
    assert.equal(resumed.task.status, "RESOLVED");
    assert.deepEqual(focusedPersonas, [personaUid]);

    const afterHuman = await provider.probeHumanChallenge(page);
    assert.equal(afterHuman.status, "NONE");
    const terminal = coordinator.markSucceeded(
      operation.operationId,
      operation.claimEpoch,
      "challenge-cleared-and-revalidated"
    );
    assert.equal(terminal.operationId, operation.operationId);
    assert.equal(terminal.state, "SUCCEEDED");
  } finally {
    if (connection !== undefined) await connection.disconnect();
    if (session !== undefined) await session.close();
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
    await emulator.close();
  }
});
