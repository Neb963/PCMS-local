import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  SensitiveAccountAdmissionError,
  evaluateSensitiveAccountAdmission,
  requireSensitiveAccountAdmission
} from "../../dist/inventory/sensitive-account-admission.js";
import { projectSessionHealth } from "../../dist/inventory/health-projection.js";

const account = Object.freeze({
  accountId: "account_expected",
  displayName: "Expected Account",
  lifecycleStatus: "ACTIVE",
  personaUid: "persona_expected",
  createdAt: "2026-10-03T10:00:00.000Z",
  updatedAt: "2026-10-03T10:00:00.000Z",
  revision: 1
});

async function loadCases() {
  const raw = await readFile(
    join(process.cwd(), "tests", "fixtures", "inventory-session-observations.json"),
    "utf8"
  );
  return JSON.parse(raw).cases;
}

function sessionFromEvidence(evidence) {
  return projectSessionHealth(evidence, {
    now: () => new Date("2026-10-03T12:01:00.000Z"),
    staleAfterMs: 5 * 60 * 1000
  });
}

test("sensitive Account admission requires current verified matching provider identity", async () => {
  const cases = await loadCases();
  const byName = new Map(cases.map((entry) => [entry.name, entry]));

  const expected = evaluateSensitiveAccountAdmission(
    account,
    sessionFromEvidence(byName.get("expected-current-verified").evidence)
  );
  assert.deepEqual(expected, {
    status: "ALLOWED",
    accountId: "account_expected",
    personaUid: "persona_expected",
    verifiedAccountId: "account_expected",
    verifiedAt: "2026-10-03T12:00:00.000Z"
  });

  const blocked = [
    ["wrong-current-verified", "WRONG_ACCOUNT"],
    ["expected-observed-only", "SESSION_UNVERIFIED"],
    ["unknown-session", "SESSION_UNVERIFIED"],
    ["expected-stale-verified", "SESSION_STALE"],
    ["verified-unauthenticated", "SESSION_NOT_AUTHENTICATED"]
  ];

  for (const [name, reason] of blocked) {
    const decision = evaluateSensitiveAccountAdmission(
      account,
      sessionFromEvidence(byName.get(name).evidence)
    );
    assert.equal(decision.status, "BLOCKED", name);
    assert.equal(decision.reason, reason, name);
    assert.equal(decision.needsAttention, true, name);
  }
});

test("wrong or ambiguous session evidence blocks before a sensitive effect can dispatch", async () => {
  const cases = await loadCases();
  const byName = new Map(cases.map((entry) => [entry.name, entry]));

  for (const name of [
    "wrong-current-verified",
    "expected-observed-only",
    "unknown-session"
  ]) {
    let dispatched = false;
    assert.throws(
      () => {
        requireSensitiveAccountAdmission(
          account,
          sessionFromEvidence(byName.get(name).evidence)
        );
        dispatched = true;
      },
      (error) =>
        error instanceof SensitiveAccountAdmissionError &&
        error.code === "SENSITIVE_ACCOUNT_ADMISSION_BLOCKED" &&
        error.decision.status === "BLOCKED" &&
        error.decision.needsAttention === true,
      name
    );
    assert.equal(dispatched, false, name);
  }
});

test("inactive or unbound Accounts are denied independently of provider identity", async () => {
  const cases = await loadCases();
  const expectedSession = sessionFromEvidence(
    cases.find((entry) => entry.name === "expected-current-verified").evidence
  );

  const inactive = evaluateSensitiveAccountAdmission(
    { ...account, lifecycleStatus: "INACTIVE" },
    expectedSession
  );
  assert.equal(inactive.status, "BLOCKED");
  assert.equal(inactive.reason, "ACCOUNT_INACTIVE");
  assert.equal(inactive.needsAttention, false);

  const unbound = evaluateSensitiveAccountAdmission(
    { ...account, personaUid: null },
    expectedSession
  );
  assert.equal(unbound.status, "BLOCKED");
  assert.equal(unbound.reason, "ACCOUNT_UNBOUND");
  assert.equal(unbound.needsAttention, false);
});
