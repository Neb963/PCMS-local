import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OperationCoordinator
} from "../../dist/operations/operation-coordinator.js";
import {
  ProviderGateError
} from "../../dist/operations/provider-gate.js";
import { applyPcmsMigrations } from "../../dist/storage/migrations.js";
import { openConfiguredSqliteDatabase } from "../../dist/storage/sqlite.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-provider-gate-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let nowMs = Date.parse("2026-10-03T15:00:00.000Z");
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
    advance(ms) {
      nowMs += ms;
    },
    now
  };
}

test("P028 ProviderGate serializes shared provider mutation producers without queueing", async () => {
  const f = await fixture();
  try {
    const first = f.coordinator.providerGate.acquire({
      provider: "perchance",
      accountId: "account-a",
      personaUid: "persona-a"
    });
    assert.equal(first.provider, "perchance");

    assert.throws(
      () => f.coordinator.providerGate.acquire({
        provider: "perchance",
        accountId: "account-b",
        personaUid: "persona-b"
      }),
      (error) => {
        assert.ok(error instanceof ProviderGateError);
        assert.equal(error.code, "PROVIDER_GATE_BUSY");
        assert.equal(error.retryable, true);
        return true;
      }
    );

    first.release();
    first.release();

    const second = f.coordinator.providerGate.acquire({
      provider: "perchance",
      accountId: "account-b",
      personaUid: "persona-b"
    });
    second.release();
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P028 unknown-scope rate limit persists as provider-wide cooldown across coordinator restart", async () => {
  const f = await fixture();
  try {
    const observed = f.coordinator.providerGate.observeSignal({
      provider: "perchance",
      accountId: "account-a",
      personaUid: "persona-a",
      kind: "RATE_LIMIT",
      cooldownMs: 30_000,
      reason: "emulated-rate-limit"
    });
    assert.equal(observed.scopeKind, "PROVIDER");
    assert.equal(observed.scopeKey, "perchance");
    assert.equal(
      observed.cooldownUntil,
      "2026-10-03T15:00:30.000Z"
    );

    const restarted = new OperationCoordinator({
      database: f.database,
      now: f.now,
      providerGate: {
        maxGlobalMutations: 4,
        maxProviderMutations: 2,
        maxAccountMutations: 1,
        maxPersonaMutations: 1
      }
    });

    for (const accountId of ["account-a", "account-b"]) {
      assert.throws(
        () => restarted.providerGate.acquire({
          provider: "perchance",
          accountId,
          personaUid: `persona-${accountId}`
        }),
        (error) => {
          assert.ok(error instanceof ProviderGateError);
          assert.equal(error.code, "PROVIDER_GATE_COOLDOWN");
          assert.equal(error.retryAt, "2026-10-03T15:00:30.000Z");
          return true;
        }
      );
    }

    f.advance(30_001);
    const afterCooldown = restarted.providerGate.acquire({
      provider: "perchance",
      accountId: "account-b",
      personaUid: "persona-b"
    });
    afterCooldown.release();
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("P028 explicitly narrow account cooldown does not block unrelated accounts", async () => {
  const f = await fixture();
  try {
    f.coordinator.providerGate.observeSignal({
      provider: "perchance",
      accountId: "account-a",
      personaUid: "persona-a",
      kind: "CHALLENGE",
      cooldownMs: 10_000,
      reason: "emulated-account-challenge",
      scopeKind: "ACCOUNT"
    });

    assert.throws(
      () => f.coordinator.providerGate.acquire({
        provider: "perchance",
        accountId: "account-a",
        personaUid: "persona-a"
      }),
      (error) => {
        assert.ok(error instanceof ProviderGateError);
        assert.equal(error.code, "PROVIDER_GATE_COOLDOWN");
        return true;
      }
    );

    const unrelated = f.coordinator.providerGate.acquire({
      provider: "perchance",
      accountId: "account-b",
      personaUid: "persona-b"
    });
    unrelated.release();
  } finally {
    f.database.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
