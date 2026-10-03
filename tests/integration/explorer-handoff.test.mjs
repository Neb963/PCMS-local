import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import { PersonaBindingService } from "../../dist/accounts/persona-binding.js";
import {
  ExplorerClaimService,
  ExplorerReservationLedger
} from "../../dist/explorer/claim.js";
import {
  ExplorerHandoffService
} from "../../dist/explorer/handoff.js";
import {
  GeneratorRepository
} from "../../dist/generators/generator-repository.js";
import {
  OperationCoordinator
} from "../../dist/operations/operation-coordinator.js";
import {
  ProjectRepository
} from "../../dist/projects/project-repository.js";
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
  const root = await mkdtemp(join(tmpdir(), "pcms-explorer-handoff-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  const now = () => new Date("2026-10-03T20:20:00.000Z");

  database.prepare(`
    INSERT INTO personas (
      persona_uid, lifecycle_status, profile_state, browser_backend,
      profile_relative_path, profile_delete_state, profile_deleted_at,
      profile_backup_decision, created_at, updated_at, retired_at, revision
    ) VALUES (?, 'ACTIVE', 'CLOSED', 'chromium-v1', ?, 'PRESENT',
      NULL, NULL, ?, ?, NULL, 0)
  `).run(
    "persona-p037-handoff",
    "personas/persona-p037-handoff/chromium",
    now().toISOString(),
    now().toISOString()
  );

  const accounts = new AccountRepository({ database, now });
  accounts.create({
    accountId: "account-p037-handoff",
    displayName: "P037 handoff fixture"
  });
  new PersonaBindingService({ database, now }).bind({
    accountId: "account-p037-handoff",
    personaUid: "persona-p037-handoff",
    expectedRevision: 0,
    reason: "P037 stable handoff fixture"
  });

  const coordinator = new OperationCoordinator({
    database,
    now
  });
  const reservations = new ExplorerReservationLedger();
  return {
    root,
    database,
    coordinator,
    claim: new ExplorerClaimService({
      database,
      coordinator,
      reservations,
      now
    }),
    handoff: new ExplorerHandoffService({ database, now }),
    generators: new GeneratorRepository({ database, now }),
    projects: new ProjectRepository({ database, now }),
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function remote(emulator) {
  const email = "owner@example.test";
  const sessionToken = "fixture-session-p037-handoff";
  return {
    async readAvailability(slug) {
      const response = await fetch(
        new URL(
          "/__pcms_emulator__/explorer/availability?slug=" +
            encodeURIComponent(slug),
          emulator.origin
        )
      );
      return response.json();
    },
    async claim(slug) {
      const response = await fetch(
        new URL("/__pcms_emulator__/explorer/claim", emulator.origin),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, sessionToken, slug })
        }
      );
      const body = await response.json();
      if (body.status !== "claimed") {
        throw new Error("claim failed");
      }
    },
    async observeOwnership(slug) {
      const response = await fetch(
        new URL("/api/getGeneratorsByUser", emulator.origin),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, sessionToken })
        }
      );
      const body = await response.json();
      const matches = Array.isArray(body.generators)
        ? body.generators.filter((item) =>
            item?.generatorName === slug &&
            typeof item?.publicId === "string"
          )
        : [];
      if (body.status !== "success" || matches.length !== 1) {
        return {
          compatibility: "UNKNOWN",
          owned: null,
          providerStableId: null,
          slug: null,
          observedAt: "2026-10-03T20:20:01.000Z"
        };
      }
      return {
        compatibility: "VERIFIED",
        owned: true,
        providerStableId: matches[0].publicId,
        slug,
        observedAt: "2026-10-03T20:20:01.000Z"
      };
    }
  };
}

test("P037 verified Explorer acquisition hands off to stable Generator and minimal Project identity", async () => {
  const f = await fixture();
  const emulator = await startPerchanceEmulator({
    explorerAvailableSlugs: ["shared-slug"],
    accounts: [{
      identity: "owner@example.test",
      sessionToken: "fixture-session-p037-handoff",
      generators: []
    }]
  });

  try {
    f.generators.create({
      generatorLocalId: "generator-existing-same-slug",
      accountId: "account-p037-handoff",
      providerStableId: "different-provider-id",
      currentSlug: "shared-slug"
    });

    const claim = await f.claim.claim({
      operationId: "operation-p037-handoff",
      idempotencyKey: "idempotency-p037-handoff",
      candidateId: "candidate-p037-handoff",
      slug: "shared-slug",
      accountId: "account-p037-handoff",
      personaUid: "persona-p037-handoff",
      owner: { kind: "CORE" },
      actorSource: "p037-handoff-test",
      remote: remote(emulator)
    });
    assert.equal(claim.operation.state, "SUCCEEDED");
    assert.equal(claim.reservation.ownership, "VERIFIED");

    const handedOff = f.handoff.handoff({
      claim,
      generatorLocalId: "generator-p037-claimed",
      projectId: "project-p037-claimed"
    });
    assert.equal(
      handedOff.generator.generatorLocalId,
      "generator-p037-claimed"
    );
    assert.equal(
      handedOff.generator.providerStableId,
      "explorer-claim-1"
    );
    assert.equal(
      handedOff.generator.currentSlug,
      "shared-slug"
    );
    assert.equal(
      handedOff.project.generatorLocalId,
      "generator-p037-claimed"
    );

    assert.equal(f.generators.list().length, 2);
    assert.equal(f.projects.list().length, 1);

    const repeated = f.handoff.handoff({
      claim,
      generatorLocalId: "generator-p037-claimed",
      projectId: "project-p037-claimed"
    });
    assert.deepEqual(repeated.generator, handedOff.generator);
    assert.deepEqual(repeated.project, handedOff.project);
    assert.equal(f.generators.list().length, 2);
    assert.equal(f.projects.list().length, 1);
  } finally {
    await emulator.close();
    await f.cleanup();
  }
});

test("P037 handoff rejects unverified claim evidence before creating stable targets", async () => {
  const f = await fixture();
  try {
    assert.throws(
      () => f.handoff.handoff({
        claim: {
          disposition: "APPLIED",
          operation: {
            operationId: "operation-forged",
            idempotencyKey: "idempotency-forged",
            state: "SUCCEEDED",
            targetKey: "perchance:account:account-p037-handoff",
            operationKind: "explorer.claim",
            schemaVersion: 1,
            owner: { kind: "CORE" },
            actorSource: "test",
            personaUid: "persona-p037-handoff",
            accountId: "account-p037-handoff",
            desiredFingerprint: "0".repeat(64),
            provenance: {},
            preconditions: [],
            attempt: 1,
            claimEpoch: 1,
            dispatchAuthorizedAt: null,
            dispatchEvidence: null,
            cancellationRequestedAt: null,
            lastTransitionReason: null,
            createdAt: "2026-10-03T20:20:00.000Z",
            updatedAt: "2026-10-03T20:20:00.000Z",
            terminalAt: "2026-10-03T20:20:00.000Z",
            revision: 0
          },
          reservation: {
            operationId: "operation-forged",
            claimEpoch: 1,
            candidateId: "candidate-forged",
            slug: "forged",
            accountId: "account-p037-handoff",
            personaUid: "persona-p037-handoff",
            providerStableId: "forged-provider",
            ownership: "UNVERIFIED",
            verifiedAt: "2026-10-03T20:20:00.000Z"
          }
        },
        generatorLocalId: "generator-forged",
        projectId: "project-forged"
      }),
      (error) => error?.code === "EXPLORER_HANDOFF_UNVERIFIED"
    );
    assert.equal(f.generators.list().length, 0);
    assert.equal(f.projects.list().length, 0);
  } finally {
    await f.cleanup();
  }
});
