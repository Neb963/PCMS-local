import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import { PersonaBindingService } from "../../dist/accounts/persona-binding.js";
import {
  HealthProjectionError,
  projectInventoryHealth
} from "../../dist/inventory/health-projection.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database, {
    now: () => new Date("2026-10-03T10:00:00.000Z")
  });
  return { root, database };
}

async function cleanup(value) {
  value.database.close();
  await rm(value.root, { recursive: true, force: true });
}

function insertPersona(database, personaUid) {
  const now = "2026-10-03T10:01:00.000Z";
  database.prepare(`
    INSERT INTO personas (
      persona_uid,
      lifecycle_status,
      profile_state,
      browser_backend,
      profile_relative_path,
      profile_delete_state,
      profile_deleted_at,
      profile_backup_decision,
      created_at,
      updated_at,
      retired_at,
      revision
    ) VALUES (?, 'ACTIVE', 'CLOSED', 'chromium-v1', ?, 'PRESENT', NULL, NULL, ?, ?, NULL, 0)
  `).run(
    personaUid,
    `personas/${personaUid}/chromium`,
    now,
    now
  );
}

test("health projections keep configured, observed and verified facts distinct", async () => {
  const f = await fixture("pcms-health-projection-");
  try {
    insertPersona(f.database, "persona_health");
    const accounts = new AccountRepository({
      database: f.database,
      now: () => new Date("2026-10-03T10:02:00.000Z")
    });
    accounts.create({
      accountId: "account_health",
      displayName: "Health account"
    });
    const binding = new PersonaBindingService({
      database: f.database,
      now: () => new Date("2026-10-03T10:03:00.000Z")
    });
    const account = binding.bind({
      accountId: "account_health",
      personaUid: "persona_health",
      expectedRevision: 0,
      reason: "health fixture"
    });

    const now = () => new Date("2026-10-03T12:00:00.000Z");
    const current = projectInventoryHealth(
      account,
      {
        configuredMode: "PROTECTED",
        configuredRouteId: "route_alpha",
        observedState: "READY_UNVERIFIED",
        observedAt: "2026-10-03T11:59:30.000Z",
        verifiedState: "HEALTHY",
        verifiedAt: "2026-10-03T11:58:00.000Z"
      },
      {
        observedState: "AUTHENTICATED",
        observedAccountId: "account_health",
        observedAt: "2026-10-03T11:59:00.000Z",
        verifiedState: "AUTHENTICATED",
        verifiedAccountId: "account_health",
        verifiedAt: "2026-10-03T11:58:30.000Z"
      },
      { now, staleAfterMs: 5 * 60 * 1000 }
    );

    assert.deepEqual(current.route, {
      configuredMode: "PROTECTED",
      configuredRouteId: "route_alpha",
      state: "HEALTHY",
      basis: "VERIFIED",
      evidenceAt: "2026-10-03T11:58:00.000Z",
      ageMs: 120000,
      freshness: "CURRENT"
    });
    assert.equal(current.session.basis, "VERIFIED");
    assert.equal(current.session.accountId, "account_health");
    assert.equal(current.session.ageMs, 90000);
    assert.equal(current.account.state, "HEALTHY");

    const configuredOnly = projectInventoryHealth(
      account,
      {
        configuredMode: "PROTECTED",
        configuredRouteId: "route_alpha"
      },
      null,
      { now, staleAfterMs: 5 * 60 * 1000 }
    );
    assert.equal(configuredOnly.route.state, "CONFIGURED");
    assert.equal(configuredOnly.route.basis, "CONFIGURED");
    assert.equal(configuredOnly.route.freshness, "UNKNOWN");
    assert.equal(configuredOnly.session.state, "UNKNOWN");
    assert.equal(configuredOnly.account.state, "UNKNOWN");

    const observedOnly = projectInventoryHealth(
      account,
      {
        configuredMode: "DIRECT"
      },
      {
        observedState: "AUTHENTICATED",
        observedAccountId: "account_health",
        observedAt: "2026-10-03T11:59:00.000Z"
      },
      { now, staleAfterMs: 5 * 60 * 1000 }
    );
    assert.equal(observedOnly.session.basis, "OBSERVED");
    assert.equal(observedOnly.account.state, "OBSERVED");
  } finally {
    await cleanup(f);
  }
});

test("health projections surface stale and mismatched evidence without treating it as current truth", async () => {
  const f = await fixture("pcms-health-stale-");
  try {
    insertPersona(f.database, "persona_stale");
    const accounts = new AccountRepository({
      database: f.database,
      now: () => new Date("2026-10-03T10:02:00.000Z")
    });
    accounts.create({
      accountId: "account_expected",
      displayName: "Expected"
    });
    const account = new PersonaBindingService({
      database: f.database,
      now: () => new Date("2026-10-03T10:03:00.000Z")
    }).bind({
      accountId: "account_expected",
      personaUid: "persona_stale",
      expectedRevision: 0,
      reason: "stale fixture"
    });

    const stale = projectInventoryHealth(
      account,
      {
        configuredMode: "PROTECTED",
        configuredRouteId: "route_stale",
        verifiedState: "HEALTHY",
        verifiedAt: "2026-10-03T11:00:00.000Z"
      },
      {
        verifiedState: "AUTHENTICATED",
        verifiedAccountId: "account_expected",
        verifiedAt: "2026-10-03T11:00:00.000Z"
      },
      {
        now: () => new Date("2026-10-03T12:00:00.000Z"),
        staleAfterMs: 5 * 60 * 1000
      }
    );
    assert.equal(stale.route.basis, "VERIFIED");
    assert.equal(stale.route.freshness, "STALE");
    assert.equal(stale.session.freshness, "STALE");
    assert.equal(stale.account.state, "STALE");

    const mismatch = projectInventoryHealth(
      account,
      { configuredMode: "DIRECT" },
      {
        verifiedState: "AUTHENTICATED",
        verifiedAccountId: "different_provider_identity",
        verifiedAt: "2026-10-03T11:59:30.000Z"
      },
      {
        now: () => new Date("2026-10-03T12:00:00.000Z"),
        staleAfterMs: 5 * 60 * 1000
      }
    );
    assert.equal(mismatch.session.basis, "VERIFIED");
    assert.equal(mismatch.session.accountId, "different_provider_identity");
    assert.equal(mismatch.account.state, "DEGRADED");
    assert.equal(mismatch.account.expectedAccountId, "account_expected");
  } finally {
    await cleanup(f);
  }
});

test("health projection rejects structurally ambiguous evidence", () => {
  assert.throws(
    () => projectInventoryHealth(
      {
        accountId: "account_1",
        displayName: "Account",
        lifecycleStatus: "ACTIVE",
        personaUid: "persona_1",
        createdAt: "2026-10-03T10:00:00.000Z",
        updatedAt: "2026-10-03T10:00:00.000Z",
        revision: 0
      },
      {
        configuredMode: "PROTECTED",
        configuredRouteId: "route_1",
        verifiedState: "HEALTHY"
      },
      null
    ),
    (error) =>
      error instanceof HealthProjectionError &&
      error.code === "HEALTH_EVIDENCE_INVALID"
  );
});
