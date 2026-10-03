import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import { PersonaBindingService } from "../../dist/accounts/persona-binding.js";
import {
  ExplorerClaimMutationError,
  ExplorerClaimService,
  ExplorerReservationLedger
} from "../../dist/explorer/claim.js";
import {
  OperationCoordinator
} from "../../dist/operations/operation-coordinator.js";
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
  const root = await mkdtemp(join(tmpdir(), "pcms-explorer-claim-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let nowMs = Date.parse("2026-10-03T20:10:00.000Z");
  const now = () => new Date(nowMs);

  database.prepare(`
    INSERT INTO personas (
      persona_uid, lifecycle_status, profile_state, browser_backend,
      profile_relative_path, profile_delete_state, profile_deleted_at,
      profile_backup_decision, created_at, updated_at, retired_at, revision
    ) VALUES (?, 'ACTIVE', 'CLOSED', 'chromium-v1', ?, 'PRESENT',
      NULL, NULL, ?, ?, NULL, 0)
  `).run(
    "persona-p037",
    "personas/persona-p037/chromium",
    now().toISOString(),
    now().toISOString()
  );
  const accounts = new AccountRepository({ database, now });
  accounts.create({
    accountId: "account-p037",
    displayName: "P037 Explorer fixture"
  });
  new PersonaBindingService({ database, now }).bind({
    accountId: "account-p037",
    personaUid: "persona-p037",
    expectedRevision: 0,
    reason: "P037 Explorer claim fixture"
  });

  const coordinator = new OperationCoordinator({
    database,
    now,
    providerGate: {
      maxGlobalMutations: 4,
      maxProviderMutations: 2,
      maxAccountMutations: 1,
      maxPersonaMutations: 1
    }
  });
  const reservations = new ExplorerReservationLedger();
  const service = new ExplorerClaimService({
    database,
    coordinator,
    reservations,
    now
  });

  return {
    root,
    database,
    coordinator,
    reservations,
    service,
    now,
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function remote(emulator, options = {}) {
  const identity = "owner@example.test";
  const sessionToken = "fixture-session-p037";
  return {
    async readAvailability(slug) {
      const response = await fetch(
        new URL(
          "/__pcms_emulator__/explorer/availability?slug=" +
            encodeURIComponent(slug),
          emulator.origin
        )
      );
      assert.equal(response.status, 200);
      return response.json();
    },
    async claim(slug) {
      const signal = options.abortAfterMs === undefined
        ? undefined
        : AbortSignal.timeout(options.abortAfterMs);
      let response;
      try {
        response = await fetch(
          new URL("/__pcms_emulator__/explorer/claim", emulator.origin),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            ...(signal === undefined ? {} : { signal }),
            body: JSON.stringify({ email: identity, sessionToken, slug })
          }
        );
      } catch (error) {
        throw new ExplorerClaimMutationError(
          "Explorer claim transport lost",
          "MAY_HAVE_OCCURRED",
          error
        );
      }
      const body = await response.json();
      if (body.status === "claimed") return;
      if (body.status === "unavailable") {
        throw new ExplorerClaimMutationError(
          "Explorer candidate became unavailable",
          "NOT_DISPATCHED"
        );
      }
      throw new ExplorerClaimMutationError(
        "Explorer claim returned unknown status",
        "MAY_HAVE_OCCURRED"
      );
    },
    async observeOwnership(slug) {
      const response = await fetch(
        new URL("/api/getGeneratorsByUser", emulator.origin),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: identity, sessionToken })
        }
      );
      if (response.status !== 200) {
        return {
          compatibility: "UNKNOWN",
          owned: null,
          providerStableId: null,
          slug: null,
          observedAt: "2026-10-03T20:10:01.000Z"
        };
      }
      const body = await response.json();
      if (
        body?.status !== "success" ||
        !Array.isArray(body.generators)
      ) {
        return {
          compatibility: "UNKNOWN",
          owned: null,
          providerStableId: null,
          slug: null,
          observedAt: "2026-10-03T20:10:01.000Z"
        };
      }
      const matches = body.generators.filter((generator) =>
        generator?.generatorName === slug &&
        typeof generator?.publicId === "string"
      );
      if (matches.length === 0) {
        return {
          compatibility: "VERIFIED",
          owned: false,
          providerStableId: null,
          slug,
          observedAt: "2026-10-03T20:10:01.000Z"
        };
      }
      if (matches.length !== 1) {
        return {
          compatibility: "UNKNOWN",
          owned: null,
          providerStableId: null,
          slug: null,
          observedAt: "2026-10-03T20:10:01.000Z"
        };
      }
      return {
        compatibility: "VERIFIED",
        owned: true,
        providerStableId: matches[0].publicId,
        slug,
        observedAt: "2026-10-03T20:10:01.000Z"
      };
    }
  };
}

function claimInput(emulator, overrides = {}) {
  return {
    operationId: overrides.operationId ?? "operation-p037-claim",
    idempotencyKey:
      overrides.idempotencyKey ?? "idempotency-p037-claim",
    candidateId: overrides.candidateId ?? "candidate-p037",
    slug: overrides.slug ?? "open-name",
    accountId: "account-p037",
    personaUid: "persona-p037",
    owner: { kind: "CORE" },
    actorSource: "p037-explorer-test",
    remote: remote(emulator, overrides.remoteOptions)
  };
}

test("P037 Explorer reserves only emulator claims with verified ownership", async () => {
  const f = await fixture();
  const emulator = await startPerchanceEmulator({
    explorerAvailableSlugs: ["open-name"],
    accounts: [{
      identity: "owner@example.test",
      sessionToken: "fixture-session-p037",
      generators: []
    }]
  });

  try {
    assert.equal(f.reservations.list().length, 0);
    const result = await f.service.claim(claimInput(emulator));
    assert.equal(result.disposition, "APPLIED");
    assert.equal(result.operation.state, "SUCCEEDED");
    assert.equal(result.reservation.ownership, "VERIFIED");
    assert.equal(result.reservation.slug, "open-name");
    assert.equal(
      result.reservation.providerStableId,
      "explorer-claim-1"
    );
    assert.equal(f.reservations.list().length, 1);

    const repeat = await f.service.claim(claimInput(emulator));
    assert.equal(repeat.disposition, "ALREADY_VERIFIED");
    assert.equal(
      emulator.requests().filter((entry) =>
        entry.path === "/__pcms_emulator__/explorer/claim"
      ).length,
      1
    );
  } finally {
    await emulator.close();
    await f.cleanup();
  }
});

test("P037 response loss reconciles ownership before any Explorer redispatch", async () => {
  const f = await fixture();
  const emulator = await startPerchanceEmulator({
    explorerAvailableSlugs: ["ambiguous-name"],
    accounts: [{
      identity: "owner@example.test",
      sessionToken: "fixture-session-p037",
      generators: []
    }]
  });

  try {
    emulator.setScenario("RESPONSE_LOSS_AFTER_EFFECT");
    const result = await f.service.claim(
      claimInput(emulator, {
        operationId: "operation-p037-ambiguous",
        idempotencyKey: "idempotency-p037-ambiguous",
        candidateId: "candidate-ambiguous",
        slug: "ambiguous-name",
        remoteOptions: { abortAfterMs: 25 }
      })
    );

    assert.equal(result.disposition, "RECONCILED_APPLIED");
    assert.equal(result.operation.state, "SUCCEEDED");
    assert.equal(result.reservation.ownership, "VERIFIED");
    assert.equal(
      emulator.requests().filter((entry) =>
        entry.path === "/__pcms_emulator__/explorer/claim"
      ).length,
      1
    );
  } finally {
    await emulator.close();
    await f.cleanup();
  }
});

test("P037 completed claim reconstructs verified reservation after process-local ledger loss", async () => {
  const f = await fixture();
  const emulator = await startPerchanceEmulator({
    explorerAvailableSlugs: ["restart-safe-name"],
    accounts: [{
      identity: "owner@example.test",
      sessionToken: "fixture-session-p037",
      generators: []
    }]
  });

  try {
    const input = claimInput(emulator, {
      operationId: "operation-p037-restart",
      idempotencyKey: "idempotency-p037-restart",
      candidateId: "candidate-restart",
      slug: "restart-safe-name"
    });
    const first = await f.service.claim(input);
    assert.equal(first.operation.state, "SUCCEEDED");
    assert.equal(first.reservation.providerStableId, "explorer-claim-1");

    const restartedReservations = new ExplorerReservationLedger();
    const restarted = new ExplorerClaimService({
      database: f.database,
      reservations: restartedReservations,
      now: f.now
    });
    const recovered = await restarted.claim(input);

    assert.equal(recovered.disposition, "ALREADY_VERIFIED");
    assert.equal(recovered.operation.state, "SUCCEEDED");
    assert.equal(
      recovered.reservation.providerStableId,
      "explorer-claim-1"
    );
    assert.equal(restartedReservations.list().length, 1);
    assert.equal(
      emulator.requests().filter((entry) =>
        entry.path === "/__pcms_emulator__/explorer/claim"
      ).length,
      1
    );
  } finally {
    await emulator.close();
    await f.cleanup();
  }
});

test("P037 unavailable observation cannot become a claim or reservation", async () => {
  const f = await fixture();
  const emulator = await startPerchanceEmulator({
    explorerAvailableSlugs: [],
    accounts: [{
      identity: "owner@example.test",
      sessionToken: "fixture-session-p037",
      generators: [{
        publicId: "existing-public",
        slug: "taken-name",
        isPublic: false
      }]
    }]
  });

  try {
    await assert.rejects(
      () => f.service.claim(
        claimInput(emulator, {
          operationId: "operation-p037-unavailable",
          idempotencyKey: "idempotency-p037-unavailable",
          candidateId: "candidate-taken",
          slug: "taken-name"
        })
      ),
      (error) => error?.code === "EXPLORER_CLAIM_NOT_AVAILABLE"
    );
    assert.equal(f.reservations.list().length, 0);
    assert.equal(
      f.coordinator.get("operation-p037-unavailable"),
      null
    );
  } finally {
    await emulator.close();
    await f.cleanup();
  }
});
