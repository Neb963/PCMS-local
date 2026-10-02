import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ModuleActivationError,
  ModuleActivationStore
} from "../../dist/modules/activation-store.js";
import {
  normalizeModuleAuthorityEnvelope
} from "../../dist/modules/authority.js";
import { ModuleStateStore } from "../../dist/modules/state-store.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let tick = 0;
  const now = () =>
    new Date(Date.UTC(2026, 9, 2, 22, 0, tick++));
  const state = new ModuleStateStore(database, { now });
  const activation = new ModuleActivationStore(database, { now });
  return {
    root,
    database,
    state,
    activation,
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

const baseAuthority = normalizeModuleAuthorityEnvelope({
  capabilities: ["accounts.read", "provider.read"],
  requiredServices: ["fixture.shared@1"]
});

async function candidate(
  fixture,
  moduleId,
  version,
  stateSchemaVersion = 2
) {
  return fixture.state.prepareCandidateState({
    moduleId,
    version,
    stateSchemaVersion,
    migrate: (context) => ({
      version,
      previous: context.state.value ?? null
    }),
    healthCheck: () => true
  });
}

test("capability expansion cannot activate before explicit approval", async () => {
  const f = await fixture("pcms-module-approval-expansion-");
  try {
    f.state.registerModule(
      "fixture.expansion",
      "1.0.0",
      1,
      { value: "stable" },
      baseAuthority
    );
    const prepared = await candidate(
      f,
      "fixture.expansion",
      "2.0.0"
    );
    const expanded = normalizeModuleAuthorityEnvelope({
      capabilities: [
        "accounts.read",
        "provider.read",
        "provider.mutate"
      ],
      requiredServices: [
        "fixture.other@2",
        "fixture.shared@1"
      ]
    });

    const staged = f.activation.stageCandidateAuthority(
      "fixture.expansion",
      prepared.stateGeneration,
      expanded
    );
    assert.equal(staged.approvalStatus, "AWAITING_APPROVAL");
    assert.equal(staged.delta.expands, true);
    assert.deepEqual(staged.delta.addedCapabilities, [
      "provider.mutate"
    ]);
    assert.deepEqual(staged.delta.addedRequiredServices, [
      "fixture.other@2"
    ]);

    assert.throws(
      () =>
        f.activation.activateReadyCandidate(
          "fixture.expansion",
          prepared.stateGeneration
        ),
      (error) =>
        error instanceof ModuleActivationError &&
        error.code === "MODULE_CAPABILITY_APPROVAL_REQUIRED"
    );

    const before = f.state.readActiveState("fixture.expansion");
    assert.equal(before.registration.activeVersion, "1.0.0");
    assert.equal(before.registration.activeStateGeneration, 1);
    assert.equal(before.registration.runtimeGeneration, 1);
    assert.deepEqual(before.state, { value: "stable" });

    const approved = f.activation.approveCandidateAuthority(
      "fixture.expansion",
      prepared.stateGeneration
    );
    assert.equal(approved.approvalStatus, "APPROVED");
    assert.equal(typeof approved.decidedAt, "string");

    const activated = f.activation.activateReadyCandidate(
      "fixture.expansion",
      prepared.stateGeneration
    );
    assert.equal(activated.previousVersion, "1.0.0");
    assert.equal(activated.activeVersion, "2.0.0");
    assert.equal(activated.previousStateGeneration, 1);
    assert.equal(
      activated.activeStateGeneration,
      prepared.stateGeneration
    );
    assert.equal(activated.runtimeGeneration, 2);
    assert.deepEqual(
      activated.approvedAuthority,
      expanded
    );

    const active = f.state.readActiveState("fixture.expansion");
    assert.equal(active.registration.activeVersion, "2.0.0");
    assert.equal(
      active.registration.activeStateGeneration,
      prepared.stateGeneration
    );
    assert.equal(active.registration.runtimeGeneration, 2);
    assert.equal(active.registration.stateSchemaVersion, 2);
    assert.equal(active.registration.stateRevision, 0);
    assert.deepEqual(active.state, {
      previous: "stable",
      version: "2.0.0"
    });
    assert.deepEqual(
      f.activation.getApprovedAuthority("fixture.expansion"),
      expanded
    );

    assert.throws(
      () => f.state.assertRuntimeCurrent("fixture.expansion", 1),
      (error) =>
        error.code === "MODULE_RUNTIME_STALE"
    );

    const rows = f.database.prepare(`
      SELECT state_generation, status
      FROM module_state_generations
      WHERE module_id = ?
      ORDER BY state_generation
    `).all("fixture.expansion");
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { state_generation: 1, status: "RETAINED" },
        {
          state_generation: prepared.stateGeneration,
          status: "ACTIVE"
        }
      ]
    );

    const authority = f.activation.getCandidateAuthority(
      "fixture.expansion",
      prepared.stateGeneration
    );
    assert.equal(authority.approvalStatus, "APPROVED");
    assert.equal(typeof authority.activatedAt, "string");
  } finally {
    await f.cleanup();
  }
});

test("declined capability expansion cannot activate or mutate active state", async () => {
  const f = await fixture("pcms-module-approval-decline-");
  try {
    f.state.registerModule(
      "fixture.decline",
      "1.0.0",
      1,
      { stable: true },
      baseAuthority
    );
    const prepared = await candidate(
      f,
      "fixture.decline",
      "2.0.0"
    );
    f.activation.stageCandidateAuthority(
      "fixture.decline",
      prepared.stateGeneration,
      normalizeModuleAuthorityEnvelope({
        capabilities: [
          "accounts.read",
          "provider.read",
          "secrets.use:deploy"
        ],
        requiredServices: ["fixture.shared@1"]
      })
    );

    const declined = f.activation.declineCandidateAuthority(
      "fixture.decline",
      prepared.stateGeneration
    );
    assert.equal(declined.approvalStatus, "DECLINED");

    assert.throws(
      () =>
        f.activation.activateReadyCandidate(
          "fixture.decline",
          prepared.stateGeneration
        ),
      (error) =>
        error instanceof ModuleActivationError &&
        error.code === "MODULE_CAPABILITY_APPROVAL_DECLINED"
    );

    const active = f.state.readActiveState("fixture.decline");
    assert.equal(active.registration.activeVersion, "1.0.0");
    assert.equal(active.registration.activeStateGeneration, 1);
    assert.equal(active.registration.runtimeGeneration, 1);
    assert.deepEqual(active.state, { stable: true });
    assert.deepEqual(
      f.activation.getApprovedAuthority("fixture.decline"),
      baseAuthority
    );
  } finally {
    await f.cleanup();
  }
});

test("reduced authority activates without a new approval", async () => {
  const f = await fixture("pcms-module-approval-reduced-");
  try {
    f.state.registerModule(
      "fixture.reduced",
      "1.0.0",
      1,
      { value: 1 },
      baseAuthority
    );
    const prepared = await candidate(
      f,
      "fixture.reduced",
      "1.1.0"
    );
    const reduced = normalizeModuleAuthorityEnvelope({
      capabilities: ["accounts.read"],
      requiredServices: []
    });

    const staged = f.activation.stageCandidateAuthority(
      "fixture.reduced",
      prepared.stateGeneration,
      reduced
    );
    assert.equal(staged.approvalStatus, "NOT_REQUIRED");
    assert.equal(staged.delta.expands, false);
    assert.deepEqual(staged.delta.removedCapabilities, [
      "provider.read"
    ]);
    assert.deepEqual(staged.delta.removedRequiredServices, [
      "fixture.shared@1"
    ]);

    const activated = f.activation.activateReadyCandidate(
      "fixture.reduced",
      prepared.stateGeneration
    );
    assert.equal(activated.activeVersion, "1.1.0");
    assert.deepEqual(
      f.activation.getApprovedAuthority("fixture.reduced"),
      reduced
    );
    assert.throws(
      () =>
        f.activation.approveCandidateAuthority(
          "fixture.reduced",
          prepared.stateGeneration
        ),
      (error) =>
        error instanceof ModuleActivationError &&
        error.code === "MODULE_CAPABILITY_APPROVAL_NOT_PENDING"
    );
  } finally {
    await f.cleanup();
  }
});

test("equal authority activates without approval and records no delta", async () => {
  const f = await fixture("pcms-module-approval-equal-");
  try {
    f.state.registerModule(
      "fixture.equal",
      "1.0.0",
      1,
      { value: 1 },
      baseAuthority
    );
    const prepared = await candidate(
      f,
      "fixture.equal",
      "1.0.1",
      1
    );

    const staged = f.activation.stageCandidateAuthority(
      "fixture.equal",
      prepared.stateGeneration,
      baseAuthority
    );
    assert.equal(staged.approvalStatus, "NOT_REQUIRED");
    assert.deepEqual(staged.delta, {
      addedCapabilities: [],
      removedCapabilities: [],
      addedRequiredServices: [],
      removedRequiredServices: [],
      expands: false
    });

    const activated = f.activation.activateReadyCandidate(
      "fixture.equal",
      prepared.stateGeneration
    );
    assert.equal(activated.activeVersion, "1.0.1");
    assert.equal(activated.runtimeGeneration, 2);
  } finally {
    await f.cleanup();
  }
});

test("activation fails atomically when prepared candidate becomes stale", async () => {
  const f = await fixture("pcms-module-activation-stale-");
  try {
    f.state.registerModule(
      "fixture.stale",
      "1.0.0",
      1,
      { value: "old" },
      baseAuthority
    );
    const prepared = await candidate(
      f,
      "fixture.stale",
      "2.0.0"
    );
    f.activation.stageCandidateAuthority(
      "fixture.stale",
      prepared.stateGeneration,
      baseAuthority
    );

    f.state.setActiveValue(
      "fixture.stale",
      1,
      "value",
      "newer"
    );

    assert.throws(
      () =>
        f.activation.activateReadyCandidate(
          "fixture.stale",
          prepared.stateGeneration
        ),
      (error) =>
        error instanceof ModuleActivationError &&
        error.code === "MODULE_CANDIDATE_STALE" &&
        error.retryable === true
    );

    const active = f.state.readActiveState("fixture.stale");
    assert.equal(active.registration.activeVersion, "1.0.0");
    assert.equal(active.registration.activeStateGeneration, 1);
    assert.equal(active.registration.runtimeGeneration, 1);
    assert.deepEqual(active.state, { value: "newer" });

    const candidateRow = f.database.prepare(`
      SELECT status
      FROM module_state_generations
      WHERE module_id = ? AND state_generation = ?
    `).get("fixture.stale", prepared.stateGeneration);
    assert.equal(candidateRow.status, "READY_TO_SWITCH");
  } finally {
    await f.cleanup();
  }
});
