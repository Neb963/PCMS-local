import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRefresherBudgetEvent,
  createRefresherBudgetState,
  evaluateRefresherPolicy,
  selectRefresherCohort
} from "../../dist/refresher/policy.js";

test("P035 cohort size is configurable beyond recent-page capacity", () => {
  const candidates = Array.from({ length: 500 }, (_, index) => ({
    generatorLocalId:
      "generator-" + String(index).padStart(3, "0"),
    eligible: true,
    rotationDebt: index,
    priorityWeight: index % 7,
    lastCohortedAt:
      index % 3 === 0
        ? null
        : new Date(
            Date.UTC(2026, 9, 1, 0, index % 60)
          ).toISOString()
  }));

  const selected = selectRefresherCohort(
    { cohortSize: 360 },
    candidates,
    284
  );

  assert.equal(selected.requestedSize, 360);
  assert.equal(selected.eligiblePoolSize, 500);
  assert.equal(selected.recentPageCapacity, 284);
  assert.equal(selected.selectedGeneratorIds.length, 360);
  assert.equal(selected.exceedsRecentPageCapacity, true);
  assert.equal(
    new Set(selected.selectedGeneratorIds).size,
    360
  );

  const smallerPool = selectRefresherCohort(
    { cohortSize: 360 },
    candidates.slice(0, 200),
    284
  );
  assert.equal(smallerPool.selectedGeneratorIds.length, 200);
  assert.equal(smallerPool.exceedsRecentPageCapacity, false);
});

test("P035 cohort selection is deterministic and fair by debt, prior participation and stable identity", () => {
  const selected = selectRefresherCohort(
    { cohortSize: 3 },
    [
      {
        generatorLocalId: "generator-b",
        eligible: true,
        rotationDebt: 5,
        priorityWeight: 1,
        lastCohortedAt: "2026-10-02T10:00:00.000Z"
      },
      {
        generatorLocalId: "generator-a",
        eligible: true,
        rotationDebt: 5,
        priorityWeight: 1,
        lastCohortedAt: "2026-10-02T10:00:00.000Z"
      },
      {
        generatorLocalId: "generator-never",
        eligible: true,
        rotationDebt: 5,
        priorityWeight: 0,
        lastCohortedAt: null
      },
      {
        generatorLocalId: "generator-disabled",
        eligible: false,
        rotationDebt: 999,
        priorityWeight: 999,
        lastCohortedAt: null
      }
    ],
    2
  );

  assert.deepEqual(selected.selectedGeneratorIds, [
    "generator-never",
    "generator-a",
    "generator-b"
  ]);
  assert.equal(selected.exceedsRecentPageCapacity, true);
});

test("P035 local active window survives spring-forward DST without inventing a missed interval", () => {
  const policy = {
    timeZone: "America/New_York",
    activeStartMinute: 90,
    activeDurationMinutes: 120,
    dailyMutationBudget: 4
  };
  let state = createRefresherBudgetState(
    policy,
    "2026-03-08T06:45:00.000Z"
  );

  const beforeSkip = evaluateRefresherPolicy(
    policy,
    state,
    "2026-03-08T06:45:00.000Z"
  );
  assert.equal(beforeSkip.localDate, "2026-03-08");
  assert.equal(beforeSkip.localMinute, 105);
  assert.equal(beforeSkip.phase, "ACTIVE");

  state = applyRefresherBudgetEvent(
    policy,
    state,
    "2026-03-08T06:45:00.000Z",
    "CONFIRM_MUTATION"
  );

  const afterSkip = evaluateRefresherPolicy(
    policy,
    state,
    "2026-03-08T07:15:00.000Z"
  );
  assert.equal(afterSkip.localMinute, 195);
  assert.equal(afterSkip.phase, "ACTIVE");
  assert.equal(afterSkip.budgetUsed, 1);
  assert.equal(afterSkip.budgetRemaining, 3);

  const afterWindow = evaluateRefresherPolicy(
    policy,
    afterSkip.state,
    "2026-03-08T07:31:00.000Z"
  );
  assert.equal(afterWindow.localMinute, 211);
  assert.equal(afterWindow.phase, "SLEEP");
  assert.equal(afterWindow.budgetUsed, 1);
});

test("P035 fall-back DST repeats wall time without resetting the daily budget", () => {
  const policy = {
    timeZone: "America/New_York",
    activeStartMinute: 60,
    activeDurationMinutes: 60,
    dailyMutationBudget: 2
  };
  let state = createRefresherBudgetState(
    policy,
    "2026-11-01T05:30:00.000Z"
  );
  state = applyRefresherBudgetEvent(
    policy,
    state,
    "2026-11-01T05:30:00.000Z",
    "CONFIRM_MUTATION"
  );

  const firstOneThirty = evaluateRefresherPolicy(
    policy,
    state,
    "2026-11-01T05:30:00.000Z"
  );
  const secondOneThirty = evaluateRefresherPolicy(
    policy,
    firstOneThirty.state,
    "2026-11-01T06:30:00.000Z"
  );

  assert.equal(firstOneThirty.localMinute, 90);
  assert.equal(secondOneThirty.localMinute, 90);
  assert.equal(firstOneThirty.phase, "ACTIVE");
  assert.equal(secondOneThirty.phase, "ACTIVE");
  assert.equal(secondOneThirty.localDate, "2026-11-01");
  assert.equal(secondOneThirty.budgetUsed, 1);
  assert.equal(secondOneThirty.budgetRemaining, 1);
});

test("P035 rollback high-water and forward jumps preserve conservative budget semantics", () => {
  const policy = {
    timeZone: "America/Chicago",
    activeStartMinute: 0,
    activeDurationMinutes: 1440,
    dailyMutationBudget: 2
  };
  let state = createRefresherBudgetState(
    policy,
    "2026-10-03T18:00:00.000Z"
  );
  state = applyRefresherBudgetEvent(
    policy,
    state,
    "2026-10-03T18:00:00.000Z",
    "RESERVE_UNCERTAIN"
  );
  state = applyRefresherBudgetEvent(
    policy,
    state,
    "2026-10-03T18:05:00.000Z",
    "CONFIRM_MUTATION"
  );

  const rolledBack = evaluateRefresherPolicy(
    policy,
    state,
    "2026-10-03T17:00:00.000Z"
  );
  assert.equal(rolledBack.clockRollbackProtected, true);
  assert.equal(
    rolledBack.effectiveNow,
    "2026-10-03T18:05:00.000Z"
  );
  assert.equal(rolledBack.budgetUsed, 1);
  assert.equal(rolledBack.budgetRemaining, 1);

  const nextLocalDay = evaluateRefresherPolicy(
    policy,
    rolledBack.state,
    "2026-10-04T18:05:00.000Z"
  );
  assert.equal(nextLocalDay.localDate, "2026-10-04");
  assert.equal(nextLocalDay.budgetUsed, 0);
  assert.equal(nextLocalDay.budgetRemaining, 2);

  const repeatedForwardObservation = evaluateRefresherPolicy(
    policy,
    nextLocalDay.state,
    "2026-10-04T22:05:00.000Z"
  );
  assert.equal(repeatedForwardObservation.localDate, "2026-10-04");
  assert.equal(repeatedForwardObservation.budgetUsed, 0);
  assert.equal(repeatedForwardObservation.budgetRemaining, 2);
});

test("P035 uncertain mutations reserve budget until reconciled", () => {
  const policy = {
    timeZone: "UTC",
    activeStartMinute: 0,
    activeDurationMinutes: 1440,
    dailyMutationBudget: 1
  };
  let state = createRefresherBudgetState(
    policy,
    "2026-10-03T00:00:00.000Z"
  );
  state = applyRefresherBudgetEvent(
    policy,
    state,
    "2026-10-03T00:01:00.000Z",
    "RESERVE_UNCERTAIN"
  );
  const reserved = evaluateRefresherPolicy(
    policy,
    state,
    "2026-10-03T00:02:00.000Z"
  );
  assert.equal(reserved.budgetReserved, 1);
  assert.equal(reserved.budgetRemaining, 0);
  assert.equal(reserved.budgetAvailable, false);

  state = applyRefresherBudgetEvent(
    policy,
    state,
    "2026-10-03T00:03:00.000Z",
    "RESOLVE_UNCERTAIN_NO_COMMIT"
  );
  const released = evaluateRefresherPolicy(
    policy,
    state,
    "2026-10-03T00:04:00.000Z"
  );
  assert.equal(released.budgetReserved, 0);
  assert.equal(released.budgetRemaining, 1);
});
