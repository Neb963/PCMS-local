import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRepository } from "../../dist/accounts/account-repository.js";
import { PersonaBindingService } from "../../dist/accounts/persona-binding.js";
import {
  OperationCoordinator,
  OperationCoordinatorError
} from "../../dist/operations/operation-coordinator.js";
import {
  PerchanceMutationError
} from "../../dist/providers/perchance-provider.js";
import {
  decodePerchancePublicListingContract,
  decodePerchanceRecentObservationContract,
  decodePerchanceRefreshEffectContract
} from "../../dist/providers/perchance-refresh-contract.js";
import {
  RefresherExecutionService,
  RefresherHistoryLedger
} from "../../dist/refresher/execution.js";
import {
  DurableScheduler
} from "../../dist/scheduler/durable-scheduler.js";
import {
  BoundedWorkQueue
} from "../../dist/scheduler/work-queue.js";
import {
  applyPcmsMigrations
} from "../../dist/storage/migrations.js";
import {
  openConfiguredSqliteDatabase
} from "../../dist/storage/sqlite.js";
import {
  startPerchanceEmulator
} from "../helpers/perchance-emulator.mjs";

function file(path, content) {
  return {
    path,
    contentBase64: Buffer.from(content, "utf8").toString("base64")
  };
}

async function getJson(origin, path) {
  const response = await fetch(new URL(path, origin));
  assert.equal(response.status, 200);
  return response.json();
}

function remoteAdapter(
  emulator,
  identity,
  sessionToken,
  options = {}
) {
  return {
    async saveRefresh(input) {
      const signal =
        typeof options.abortAfterMs === "number"
          ? AbortSignal.timeout(options.abortAfterMs)
          : undefined;
      const response = await fetch(new URL("/api/save", emulator.origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(signal === undefined ? {} : { signal }),
        body: JSON.stringify({
          email: identity,
          sessionToken,
          publicId: input.providerStableId,
          slug: input.currentSlug,
          artifactSha256: "a".repeat(64),
          files: [
            file(
              "main.pjs",
              "title = Refresher fixture\n// pcms-refresh-marker:v1:" +
                input.refreshToken +
                "\n"
            ),
            file(
              "index.html",
              "<main>Refresher fixture</main>\n<!-- pcms-refresh-marker:v1:" +
                input.refreshToken +
                " -->\n"
            )
          ],
          isPublic: true
        })
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      if (body.status !== "saved") {
        throw new PerchanceMutationError(
          "PERCHANCE_MUTATION_REJECTED",
          "emulator rejected refresh save",
          "NOT_DISPATCHED"
        );
      }
      if (options.publishAfterSave === true) {
        emulator.publishRefreshEffect(input.providerStableId);
      }
    },
    async observePublicListing() {
      const raw = await getJson(
        emulator.origin,
        "/__pcms_emulator__/observations/public-listing"
      );
      return decodePerchancePublicListingContract(
        raw,
        "2026-10-03T19:00:01.000Z"
      );
    },
    async observeRefreshEffect(publicId) {
      const raw = await getJson(
        emulator.origin,
        "/__pcms_emulator__/observations/refresh-effect?publicId=" +
          encodeURIComponent(publicId)
      );
      return decodePerchanceRefreshEffectContract(
        raw,
        "2026-10-03T19:00:02.000Z"
      );
    },
    async observeRecent() {
      const raw = await getJson(
        emulator.origin,
        "/__pcms_emulator__/observations/recent"
      );
      return decodePerchanceRecentObservationContract(
        raw,
        "2026-10-03T19:00:03.000Z"
      );
    }
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pcms-refresher-execution-"));
  const database = openConfiguredSqliteDatabase(join(root, "pcms.db"));
  applyPcmsMigrations(database);
  let nowMs = Date.parse("2026-10-03T19:00:00.000Z");
  let dispatch = 0;
  const now = () => new Date(nowMs);

  database.prepare(`
    INSERT INTO personas (
      persona_uid, lifecycle_status, profile_state, browser_backend,
      profile_relative_path, profile_delete_state, profile_deleted_at,
      profile_backup_decision, created_at, updated_at, retired_at, revision
    ) VALUES (?, 'ACTIVE', 'CLOSED', 'chromium-v1', ?, 'PRESENT',
      NULL, NULL, ?, ?, NULL, 0)
  `).run(
    "persona-p036",
    "personas/persona-p036/chromium",
    now().toISOString(),
    now().toISOString()
  );
  const accounts = new AccountRepository({ database, now });
  accounts.create({
    accountId: "account-p036",
    displayName: "P036 Refresher fixture"
  });
  const bindings = new PersonaBindingService({ database, now });
  bindings.bind({
    accountId: "account-p036",
    personaUid: "persona-p036",
    expectedRevision: 0,
    reason: "P036 Refresher execution fixture"
  });

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
  const history = new RefresherHistoryLedger();
  const service = new RefresherExecutionService({
    coordinator,
    history
  });
  const queue = new BoundedWorkQueue(4);
  const scheduler = new DurableScheduler({
    database,
    queue,
    now,
    dispatchId: () => "refresher-dispatch-" + ++dispatch
  });
  return {
    root,
    database,
    coordinator,
    history,
    service,
    queue,
    scheduler,
    now,
    advance(ms) {
      nowMs += ms;
    },
    async cleanup() {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function preconditions(now, suffix) {
  return [{
    key: "refresher-execution",
    observedAt: now().toISOString(),
    maxAgeMs: 60_000,
    evidenceRef: "p036:" + suffix
  }];
}

function executionInput(
  f,
  emulator,
  mode,
  operationId,
  idempotencyKey,
  refreshToken,
  remoteOptions = {}
) {
  return {
    operationId,
    idempotencyKey,
    generatorLocalId: "generator-p036",
    providerStableId: "public-p036",
    currentSlug: "generator-p036",
    refreshToken,
    mode,
    owner: { kind: "CORE" },
    actorSource: "p036-refresher-test",
    personaUid: "persona-p036",
    accountId: "account-p036",
    preconditions: preconditions(f.now, operationId),
    remote: remoteAdapter(
      emulator,
      "owner@example.test",
      "fixture-session-p036",
      remoteOptions
    )
  };
}

test("P036 manual refresh verifies emulator effect and public state before recording history", async () => {
  const f = await fixture();
  const emulator = await startPerchanceEmulator({
    accounts: [{
      identity: "owner@example.test",
      sessionToken: "fixture-session-p036",
      generators: [{
        publicId: "public-p036",
        slug: "generator-p036",
        isPublic: true
      }]
    }]
  });

  try {
    const result = await f.service.execute(
      executionInput(
        f,
        emulator,
        "MANUAL",
        "operation-p036-manual",
        "idempotency-p036-manual",
        "refresh-manual"
      )
    );

    assert.equal(result.disposition, "APPLIED");
    assert.equal(result.operation.state, "SUCCEEDED");
    assert.equal(result.history.mode, "MANUAL");
    assert.equal(result.history.effectState, "PENDING");
    assert.equal(result.history.publicStateVerified, true);
    assert.equal(result.history.refreshToken, "refresh-manual");
    assert.deepEqual(
      f.history.list("generator-p036"),
      [result.history]
    );

    const effect = emulator.readRefreshEffect("public-p036");
    assert.equal(effect.state, "PENDING");
    assert.equal(effect.refreshToken, "refresh-manual");

    const repeated = await f.service.execute(
      executionInput(
        f,
        emulator,
        "MANUAL",
        "operation-p036-manual",
        "idempotency-p036-manual",
        "refresh-manual"
      )
    );
    assert.equal(repeated.disposition, "ALREADY_VERIFIED");
    assert.equal(
      emulator.requests().filter((request) =>
        request.path === "/api/save"
      ).length,
      1
    );
  } finally {
    await emulator.close();
    await f.cleanup();
  }
});

test("P036 uncertain refresh blocks duplicate target until read-first reconciliation", async () => {
  const f = await fixture();
  const emulator = await startPerchanceEmulator({
    accounts: [{
      identity: "owner@example.test",
      sessionToken: "fixture-session-p036",
      generators: [{
        publicId: "public-p036",
        slug: "generator-p036",
        isPublic: true
      }]
    }]
  });

  try {
    emulator.setScenario("RESPONSE_LOSS_AFTER_EFFECT");
    const uncertainInput = executionInput(
      f,
      emulator,
      "MANUAL",
      "operation-p036-uncertain",
      "idempotency-p036-uncertain",
      "refresh-uncertain",
      { abortAfterMs: 25 }
    );

    await assert.rejects(
      () => f.service.execute(uncertainInput),
      (error) =>
        error?.code === "REFRESHER_EXECUTION_MUTATION_FAILED"
    );
    assert.equal(
      f.coordinator.require("operation-p036-uncertain").state,
      "UNCERTAIN"
    );
    assert.equal(f.history.list("generator-p036").length, 0);

    await assert.rejects(
      () => f.service.execute(
        executionInput(
          f,
          emulator,
          "MANUAL",
          "operation-p036-duplicate",
          "idempotency-p036-duplicate",
          "refresh-duplicate"
        )
      ),
      (error) =>
        error instanceof OperationCoordinatorError &&
        error.code === "OPERATION_TARGET_CLAIMED"
    );

    const savesBeforeReconciliation =
      emulator.requests().filter((request) =>
        request.path === "/api/save"
      ).length;
    assert.equal(savesBeforeReconciliation, 1);

    emulator.setScenario("NORMAL");
    const reconciled = await f.service.execute(
      executionInput(
        f,
        emulator,
        "MANUAL",
        "operation-p036-uncertain",
        "idempotency-p036-uncertain",
        "refresh-uncertain"
      )
    );

    assert.equal(reconciled.disposition, "RECONCILED_APPLIED");
    assert.equal(reconciled.operation.state, "SUCCEEDED");
    assert.equal(reconciled.history.refreshToken, "refresh-uncertain");
    assert.equal(
      emulator.requests().filter((request) =>
        request.path === "/api/save"
      ).length,
      savesBeforeReconciliation
    );
    assert.equal(f.history.list("generator-p036").length, 1);
  } finally {
    await emulator.close();
    await f.cleanup();
  }
});

test("P036 scheduled and recent-visibility modes record per-generator verified emulator history", async () => {
  const f = await fixture();
  const emulator = await startPerchanceEmulator({
    accounts: [{
      identity: "owner@example.test",
      sessionToken: "fixture-session-p036",
      generators: [{
        publicId: "public-p036",
        slug: "generator-p036",
        isPublic: true
      }]
    }]
  });

  try {
    f.scheduler.create({
      scheduleId: "refresher-schedule-p036",
      ownerModuleId: "refresher",
      operationKind: "refresher.refresh",
      schemaVersion: 1,
      targetRef: "perchance:generator:generator-p036",
      intervalMs: 60_000,
      timeZone: "UTC",
      priority: "SCHEDULED",
      fairnessKey: "refresher",
      nextDueAt: f.now().toISOString()
    });
    const wake = f.scheduler.wake();
    assert.equal(wake.enqueued, 1);
    const intent = f.scheduler.claimNext();
    assert.ok(intent);

    const scheduled = await f.service.execute(
      executionInput(
        f,
        emulator,
        "SCHEDULED",
        "operation-" + intent.dispatchId,
        intent.dispatchId,
        "refresh-scheduled"
      )
    );
    f.scheduler.acknowledgeDispatch(
      intent.scheduleId,
      intent.dispatchId,
      scheduled.operation.operationId
    );
    f.scheduler.recordTerminal(
      intent.scheduleId,
      scheduled.operation.operationId
    );
    assert.equal(scheduled.history.mode, "SCHEDULED");
    assert.equal(
      f.scheduler.require(intent.scheduleId)
        .lastTerminalOperationId,
      scheduled.operation.operationId
    );

    f.advance(1_000);
    const recent = await f.service.execute(
      executionInput(
        f,
        emulator,
        "RECENT_VISIBILITY",
        "operation-p036-recent",
        "idempotency-p036-recent",
        "refresh-recent",
        { publishAfterSave: true }
      )
    );
    assert.equal(recent.history.mode, "RECENT_VISIBILITY");
    assert.equal(recent.history.effectState, "VISIBLE");
    assert.equal(recent.history.recentRank, 0);

    const history = f.history.list("generator-p036");
    assert.equal(history.length, 2);
    assert.deepEqual(
      history.map((entry) => entry.mode),
      ["SCHEDULED", "RECENT_VISIBILITY"]
    );
    assert.equal(
      f.history.snapshot().generators["generator-p036"]?.length,
      2
    );
  } finally {
    await emulator.close();
    await f.cleanup();
  }
});
