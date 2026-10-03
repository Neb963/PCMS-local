import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OperationCoordinator,
  OperationCoordinatorError,
  generatorOperationTargetKey
} from "../../dist/operations/operation-coordinator.js";
import {
  ProviderGateError
} from "../../dist/operations/provider-gate.js";
import {
  normalizePerchanceGateSignal
} from "../../dist/providers/perchance-gate-signal.js";
import {
  RefresherAdmission
} from "../../dist/refresher/admission.js";
import {
  applyRefresherBudgetEvent,
  createRefresherBudgetState,
  evaluateRefresherPolicy
} from "../../dist/refresher/policy.js";
import {
  applyPcmsMigrations
} from "../../dist/storage/migrations.js";
import {
  openConfiguredSqliteDatabase
} from "../../dist/storage/sqlite.js";
import {
  startPerchanceEmulator
} from "../helpers/perchance-emulator.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-refresher-admission-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let nowMs = Date.parse("2026-10-03T19:00:00.000Z");
  const now = () => new Date(nowMs);
  const coordinator = new OperationCoordinator({
    database,
    now,
    providerGate: {
      maxGlobalMutations: 4,
      maxProviderMutations: 1,
      maxAccountMutations: 1,
      maxPersonaMutations: 1
    }
  });
  return {
    root,
    database,
    coordinator,
    admission: new RefresherAdmission(coordinator),
    now,
    advance(milliseconds) {
      nowMs += milliseconds;
    },
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function precondition(now, suffix) {
  return [{
    key: "refresher-policy",
    observedAt: now().toISOString(),
    maxAgeMs: 60_000,
    evidenceRef: "p035:" + suffix
  }];
}

function deploymentFile(path, value) {
  return {
    path,
    contentBase64: Buffer.from(value, "utf8").toString("base64")
  };
}

async function saveStatus(emulator, identity, sessionToken, publicId, slug) {
  const response = await fetch(new URL("/api/save", emulator.origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: identity,
      sessionToken,
      publicId,
      slug,
      artifactSha256: "a".repeat(64),
      files: [
        deploymentFile("index.html", "<main>P035</main>")
      ],
      isPublic: true
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body, "object");
  assert.ok(body !== null);
  return body.status;
}

test("P035 Refresher and Deployer share the same stable Generator mutation claim", async () => {
  const f = await fixture();
  try {
    const generatorLocalId = "generator-p035-shared";
    const deployer = f.coordinator.prepare({
      operationId: "operation-p035-deployer",
      idempotencyKey: "idempotency-p035-deployer",
      owner: { kind: "CORE" },
      actorSource: "deployer",
      targetKey: generatorOperationTargetKey(generatorLocalId),
      operationKind: "deployer.synthetic",
      schemaVersion: 1,
      desiredFingerprint: "d".repeat(64),
      provenance: { source: "p035-collision-test" },
      preconditions: precondition(f.now, "deployer")
    });

    assert.throws(
      () => f.admission.prepareMutation({
        operationId: "operation-p035-refresher-blocked",
        idempotencyKey: "idempotency-p035-refresher-blocked",
        generatorLocalId,
        owner: { kind: "CORE" },
        actorSource: "refresher",
        desiredFingerprint: "e".repeat(64),
        provenance: { source: "p035-collision-test" },
        preconditions: precondition(f.now, "refresher-blocked")
      }),
      (error) => {
        assert.ok(error instanceof OperationCoordinatorError);
        assert.equal(error.code, "OPERATION_TARGET_CLAIMED");
        assert.equal(error.retryable, true);
        return true;
      }
    );

    f.coordinator.requestCancellation(
      deployer.operationId,
      deployer.claimEpoch,
      "p035-release-deployer-claim"
    );

    const refresher = f.admission.prepareMutation({
      operationId: "operation-p035-refresher",
      idempotencyKey: "idempotency-p035-refresher",
      generatorLocalId,
      owner: { kind: "CORE" },
      actorSource: "refresher",
      accountId: "account-p035",
      personaUid: "persona-p035",
      desiredFingerprint: "e".repeat(64),
      provenance: { source: "p035-refresher" },
      preconditions: precondition(f.now, "refresher")
    });

    assert.equal(refresher.state, "PREPARED");
    assert.equal(
      refresher.targetKey,
      generatorOperationTargetKey(generatorLocalId)
    );
    assert.equal(refresher.operationKind, "refresher.refresh");
    assert.equal(refresher.claimEpoch, deployer.claimEpoch + 1);
  } finally {
    await f.cleanup();
  }
});

test("P035 emulated rate-limit and challenge evidence propagates through the shared ProviderGate", async () => {
  const f = await fixture();
  const emulator = await startPerchanceEmulator({
    accounts: [
      {
        identity: "owner-a@example.test",
        sessionToken: "fixture-session-p035-a",
        generators: [{
          publicId: "public-p035-a",
          slug: "generator-a",
          isPublic: true
        }]
      },
      {
        identity: "owner-b@example.test",
        sessionToken: "fixture-session-p035-b",
        generators: [{
          publicId: "public-p035-b",
          slug: "generator-b",
          isPublic: true
        }]
      }
    ]
  });

  try {
    emulator.setScenario("RATE_LIMIT");
    const rateStatus = await saveStatus(
      emulator,
      "owner-a@example.test",
      "fixture-session-p035-a",
      "public-p035-a",
      "generator-a"
    );
    const rateEvidence = normalizePerchanceGateSignal(
      rateStatus,
      {
        rateLimitCooldownMs: 30_000,
        challengeCooldownMs: 10_000
      }
    );
    assert.equal(rateEvidence.compatibility, "VERIFIED");
    assert.equal(rateEvidence.signal?.kind, "RATE_LIMIT");
    assert.equal(rateEvidence.signal?.scopeKind, "PROVIDER");

    const rateRecorded = f.admission.recordProviderSignal({
      scope: {
        provider: "perchance",
        accountId: "account-a",
        personaUid: "persona-a"
      },
      evidence: rateEvidence
    });
    assert.equal(rateRecorded.status, "RECORDED");

    assert.throws(
      () => f.coordinator.providerGate.acquire({
        provider: "perchance",
        accountId: "account-b",
        personaUid: "persona-b"
      }),
      (error) => {
        assert.ok(error instanceof ProviderGateError);
        assert.equal(error.code, "PROVIDER_GATE_COOLDOWN");
        assert.equal(
          error.retryAt,
          "2026-10-03T19:00:30.000Z"
        );
        return true;
      }
    );

    f.advance(30_001);
    const afterRateLimit = f.coordinator.providerGate.acquire({
      provider: "perchance",
      accountId: "account-b",
      personaUid: "persona-b"
    });
    afterRateLimit.release();

    emulator.setScenario("CHALLENGE");
    const challengeStatus = await saveStatus(
      emulator,
      "owner-a@example.test",
      "fixture-session-p035-a",
      "public-p035-a",
      "generator-a"
    );
    const challengeEvidence = normalizePerchanceGateSignal(
      challengeStatus,
      {
        rateLimitCooldownMs: 30_000,
        challengeCooldownMs: 10_000
      }
    );
    assert.equal(challengeEvidence.compatibility, "VERIFIED");
    assert.equal(challengeEvidence.signal?.kind, "CHALLENGE");
    assert.equal(challengeEvidence.signal?.scopeKind, "ACCOUNT");

    const challengeRecorded = f.admission.recordProviderSignal({
      scope: {
        provider: "perchance",
        accountId: "account-a",
        personaUid: "persona-a"
      },
      evidence: challengeEvidence
    });
    assert.equal(challengeRecorded.status, "RECORDED");

    assert.throws(
      () => f.admission.acquireProviderPermit({
        provider: "perchance",
        accountId: "account-a",
        personaUid: "persona-a"
      }),
      (error) => {
        assert.ok(error instanceof ProviderGateError);
        assert.equal(error.code, "PROVIDER_GATE_COOLDOWN");
        assert.equal(
          error.retryAt,
          "2026-10-03T19:00:40.001Z"
        );
        return true;
      }
    );

    const unrelatedAccount =
      f.coordinator.providerGate.acquire({
        provider: "perchance",
        accountId: "account-b",
        personaUid: "persona-b"
      });
    unrelatedAccount.release();

    assert.equal(
      JSON.stringify(emulator.requests()).includes(
        "fixture-session-p035"
      ),
      false
    );
  } finally {
    await emulator.close();
    await f.cleanup();
  }
});

test("P035 serialized budget state remains conservative across restart-style roundtrip and clock rollback", async () => {
  const policy = {
    timeZone: "America/Chicago",
    activeStartMinute: 8 * 60,
    activeDurationMinutes: 8 * 60,
    dailyMutationBudget: 3
  };
  let state = createRefresherBudgetState(
    policy,
    "2026-11-01T14:00:00.000Z"
  );
  state = applyRefresherBudgetEvent(
    policy,
    state,
    "2026-11-01T14:05:00.000Z",
    "CONFIRM_MUTATION"
  );
  state = applyRefresherBudgetEvent(
    policy,
    state,
    "2026-11-01T14:06:00.000Z",
    "RESERVE_UNCERTAIN"
  );

  const restored = JSON.parse(JSON.stringify(state));
  const rolledBack = evaluateRefresherPolicy(
    policy,
    restored,
    "2026-11-01T13:00:00.000Z"
  );

  assert.equal(rolledBack.clockRollbackProtected, true);
  assert.equal(rolledBack.budgetUsed, 1);
  assert.equal(rolledBack.budgetReserved, 1);
  assert.equal(rolledBack.budgetRemaining, 1);
  assert.equal(
    rolledBack.effectiveNow,
    "2026-11-01T14:06:00.000Z"
  );
});
