const SAFE_GENERATOR_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_COHORT_SIZE = 10_000;
const MAX_DAILY_BUDGET = 100_000;
const MINUTES_PER_DAY = 24 * 60;

export type RefresherClockPhase = "ACTIVE" | "SLEEP";

export interface RefresherCohortCandidate {
  readonly generatorLocalId: string;
  readonly eligible: boolean;
  readonly rotationDebt: number;
  readonly priorityWeight: number;
  readonly lastCohortedAt: string | null;
}

export interface RefresherCohortPolicy {
  readonly cohortSize: number;
}

export interface RefresherCohortSelection {
  readonly requestedSize: number;
  readonly eligiblePoolSize: number;
  readonly recentPageCapacity: number;
  readonly exceedsRecentPageCapacity: boolean;
  readonly selectedGeneratorIds: readonly string[];
}

export interface RefresherTimePolicy {
  readonly timeZone: string;
  readonly activeStartMinute: number;
  readonly activeDurationMinutes: number;
  readonly dailyMutationBudget: number;
}

export interface RefresherBudgetState {
  readonly localDate: string;
  readonly confirmedMutations: number;
  readonly pendingUncertainMutations: number;
  readonly highWaterObservedAt: string;
}

export interface RefresherPolicySnapshot {
  readonly phase: RefresherClockPhase;
  readonly localDate: string;
  readonly localMinute: number;
  readonly budgetLimit: number;
  readonly budgetUsed: number;
  readonly budgetReserved: number;
  readonly budgetRemaining: number;
  readonly budgetAvailable: boolean;
  readonly effectiveNow: string;
  readonly clockRollbackProtected: boolean;
  readonly state: RefresherBudgetState;
}

export type RefresherBudgetEvent =
  | "RESERVE_UNCERTAIN"
  | "RESOLVE_UNCERTAIN_NO_COMMIT"
  | "CONFIRM_MUTATION";

export class RefresherPolicyError extends Error {
  public constructor(
    public readonly code:
      | "REFRESHER_POLICY_INVALID_INPUT"
      | "REFRESHER_POLICY_BUDGET_EXHAUSTED"
      | "REFRESHER_POLICY_STATE_INVALID",
    message: string
  ) {
    super(message);
    this.name = "RefresherPolicyError";
  }
}

function fail(
  code: RefresherPolicyError["code"],
  message: string
): never {
  throw new RefresherPolicyError(code, message);
}

function validTimeZone(value: string): string {
  if (value.length < 1 || value.length > 128) {
    fail(
      "REFRESHER_POLICY_INVALID_INPUT",
      "timeZone must contain 1-128 characters"
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(
      new Date(0)
    );
  } catch {
    fail(
      "REFRESHER_POLICY_INVALID_INPUT",
      "timeZone must be a supported IANA timezone"
    );
  }
  return value;
}

function positiveBoundedInteger(
  value: number,
  maximum: number,
  label: string
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    fail(
      "REFRESHER_POLICY_INVALID_INPUT",
      `${label} must be an integer between 1 and ${maximum}`
    );
  }
  return value;
}

function boundedMinute(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= MINUTES_PER_DAY
  ) {
    fail(
      "REFRESHER_POLICY_INVALID_INPUT",
      `${label} must be an integer between 0 and 1439`
    );
  }
  return value;
}

function normalizeTimePolicy(
  policy: RefresherTimePolicy
): Readonly<RefresherTimePolicy> {
  return Object.freeze({
    timeZone: validTimeZone(policy.timeZone),
    activeStartMinute: boundedMinute(
      policy.activeStartMinute,
      "activeStartMinute"
    ),
    activeDurationMinutes: positiveBoundedInteger(
      policy.activeDurationMinutes,
      MINUTES_PER_DAY,
      "activeDurationMinutes"
    ),
    dailyMutationBudget: positiveBoundedInteger(
      policy.dailyMutationBudget,
      MAX_DAILY_BUDGET,
      "dailyMutationBudget"
    )
  });
}

function parseTimestamp(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    fail(
      "REFRESHER_POLICY_INVALID_INPUT",
      `${label} must be a valid timestamp`
    );
  }
  return milliseconds;
}

function normalizeCandidate(
  value: RefresherCohortCandidate
): Readonly<RefresherCohortCandidate> {
  if (!SAFE_GENERATOR_ID.test(value.generatorLocalId)) {
    fail(
      "REFRESHER_POLICY_INVALID_INPUT",
      "generatorLocalId has invalid syntax"
    );
  }
  if (
    typeof value.eligible !== "boolean" ||
    !Number.isFinite(value.rotationDebt) ||
    !Number.isFinite(value.priorityWeight)
  ) {
    fail(
      "REFRESHER_POLICY_INVALID_INPUT",
      "cohort candidate has invalid eligibility or score"
    );
  }
  if (value.lastCohortedAt !== null) {
    parseTimestamp(value.lastCohortedAt, "lastCohortedAt");
  }
  return Object.freeze({ ...value });
}

function cohortTimestamp(value: string | null): number {
  return value === null
    ? Number.NEGATIVE_INFINITY
    : Date.parse(value);
}

export function selectRefresherCohort(
  policy: RefresherCohortPolicy,
  candidatesInput: readonly RefresherCohortCandidate[],
  recentPageCapacity: number
): RefresherCohortSelection {
  const requestedSize = positiveBoundedInteger(
    policy.cohortSize,
    MAX_COHORT_SIZE,
    "cohortSize"
  );
  if (
    !Number.isSafeInteger(recentPageCapacity) ||
    recentPageCapacity < 0 ||
    recentPageCapacity > MAX_COHORT_SIZE
  ) {
    fail(
      "REFRESHER_POLICY_INVALID_INPUT",
      "recentPageCapacity must be an integer between 0 and 10000"
    );
  }
  if (candidatesInput.length > MAX_COHORT_SIZE) {
    fail(
      "REFRESHER_POLICY_INVALID_INPUT",
      "candidate pool exceeds the supported bound"
    );
  }
  const candidates = candidatesInput.map(normalizeCandidate);
  const identities = new Set<string>();
  for (const candidate of candidates) {
    if (identities.has(candidate.generatorLocalId)) {
      fail(
        "REFRESHER_POLICY_INVALID_INPUT",
        "cohort candidate identities must be unique"
      );
    }
    identities.add(candidate.generatorLocalId);
  }

  const eligible = candidates
    .filter((candidate) => candidate.eligible)
    .sort((left, right) =>
      right.rotationDebt - left.rotationDebt ||
      cohortTimestamp(left.lastCohortedAt) -
        cohortTimestamp(right.lastCohortedAt) ||
      right.priorityWeight - left.priorityWeight ||
      left.generatorLocalId.localeCompare(
        right.generatorLocalId,
        "en"
      )
    );
  const selected = eligible
    .slice(0, requestedSize)
    .map((candidate) => candidate.generatorLocalId);

  return Object.freeze({
    requestedSize,
    eligiblePoolSize: eligible.length,
    recentPageCapacity,
    exceedsRecentPageCapacity:
      selected.length > recentPageCapacity,
    selectedGeneratorIds: Object.freeze(selected)
  });
}

interface LocalCalendar {
  readonly localDate: string;
  readonly localMinute: number;
}

function localCalendar(
  instant: Date,
  timeZone: string
): LocalCalendar {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) {
      fail(
        "REFRESHER_POLICY_STATE_INVALID",
        "timezone formatter omitted required calendar data"
      );
    }
    return value;
  };
  const year = read("year");
  const month = read("month");
  const day = read("day");
  const hour = Number.parseInt(read("hour"), 10);
  const minute = Number.parseInt(read("minute"), 10);
  if (
    !Number.isSafeInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isSafeInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    fail(
      "REFRESHER_POLICY_STATE_INVALID",
      "timezone formatter returned invalid local time"
    );
  }
  return Object.freeze({
    localDate: `${year}-${month}-${day}`,
    localMinute: hour * 60 + minute
  });
}

function normalizeBudgetState(
  state: RefresherBudgetState
): RefresherBudgetState {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(state.localDate)) {
    fail(
      "REFRESHER_POLICY_STATE_INVALID",
      "budget state localDate is invalid"
    );
  }
  for (const [label, value] of [
    ["confirmedMutations", state.confirmedMutations],
    ["pendingUncertainMutations", state.pendingUncertainMutations]
  ] as const) {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > MAX_DAILY_BUDGET
    ) {
      fail(
        "REFRESHER_POLICY_STATE_INVALID",
        `budget state ${label} is invalid`
      );
    }
  }
  const highWater = parseTimestamp(
    state.highWaterObservedAt,
    "highWaterObservedAt"
  );
  return Object.freeze({
    localDate: state.localDate,
    confirmedMutations: state.confirmedMutations,
    pendingUncertainMutations: state.pendingUncertainMutations,
    highWaterObservedAt: new Date(highWater).toISOString()
  });
}

function phaseFor(
  policy: RefresherTimePolicy,
  localMinute: number
): RefresherClockPhase {
  const elapsed =
    (
      localMinute -
      policy.activeStartMinute +
      MINUTES_PER_DAY
    ) % MINUTES_PER_DAY;
  return elapsed < policy.activeDurationMinutes
    ? "ACTIVE"
    : "SLEEP";
}

function evaluate(
  policyInput: RefresherTimePolicy,
  stateInput: RefresherBudgetState,
  nowInput: string | Date
): RefresherPolicySnapshot {
  const policy = normalizeTimePolicy(policyInput);
  const state = normalizeBudgetState(stateInput);
  const requestedNow =
    nowInput instanceof Date
      ? nowInput.getTime()
      : parseTimestamp(nowInput, "now");
  if (!Number.isFinite(requestedNow)) {
    fail(
      "REFRESHER_POLICY_INVALID_INPUT",
      "now must be a valid timestamp"
    );
  }
  const highWaterMs = Date.parse(state.highWaterObservedAt);
  const effectiveMs = Math.max(requestedNow, highWaterMs);
  const effectiveNow = new Date(effectiveMs);
  const calendar = localCalendar(
    effectiveNow,
    policy.timeZone
  );
  const crossedLocalDay =
    calendar.localDate !== state.localDate;
  const normalizedState: RefresherBudgetState = Object.freeze({
    localDate: calendar.localDate,
    confirmedMutations: crossedLocalDay
      ? 0
      : state.confirmedMutations,
    pendingUncertainMutations: crossedLocalDay
      ? 0
      : state.pendingUncertainMutations,
    highWaterObservedAt: effectiveNow.toISOString()
  });
  const budgetUsed = normalizedState.confirmedMutations;
  const budgetReserved =
    normalizedState.pendingUncertainMutations;
  const budgetRemaining = Math.max(
    0,
    policy.dailyMutationBudget -
      budgetUsed -
      budgetReserved
  );

  return Object.freeze({
    phase: phaseFor(policy, calendar.localMinute),
    localDate: calendar.localDate,
    localMinute: calendar.localMinute,
    budgetLimit: policy.dailyMutationBudget,
    budgetUsed,
    budgetReserved,
    budgetRemaining,
    budgetAvailable: budgetRemaining > 0,
    effectiveNow: effectiveNow.toISOString(),
    clockRollbackProtected: requestedNow < highWaterMs,
    state: normalizedState
  });
}

export function createRefresherBudgetState(
  policyInput: RefresherTimePolicy,
  nowInput: string | Date
): RefresherBudgetState {
  const policy = normalizeTimePolicy(policyInput);
  const milliseconds =
    nowInput instanceof Date
      ? nowInput.getTime()
      : parseTimestamp(nowInput, "now");
  if (!Number.isFinite(milliseconds)) {
    fail(
      "REFRESHER_POLICY_INVALID_INPUT",
      "now must be a valid timestamp"
    );
  }
  const instant = new Date(milliseconds);
  const calendar = localCalendar(
    instant,
    policy.timeZone
  );
  return Object.freeze({
    localDate: calendar.localDate,
    confirmedMutations: 0,
    pendingUncertainMutations: 0,
    highWaterObservedAt: instant.toISOString()
  });
}

export function evaluateRefresherPolicy(
  policy: RefresherTimePolicy,
  state: RefresherBudgetState,
  now: string | Date
): RefresherPolicySnapshot {
  return evaluate(policy, state, now);
}

export function applyRefresherBudgetEvent(
  policy: RefresherTimePolicy,
  state: RefresherBudgetState,
  now: string | Date,
  event: RefresherBudgetEvent
): RefresherBudgetState {
  const snapshot = evaluate(policy, state, now);
  const current = snapshot.state;

  if (event === "RESERVE_UNCERTAIN") {
    if (!snapshot.budgetAvailable) {
      fail(
        "REFRESHER_POLICY_BUDGET_EXHAUSTED",
        "refresh mutation budget is exhausted"
      );
    }
    return Object.freeze({
      ...current,
      pendingUncertainMutations:
        current.pendingUncertainMutations + 1
    });
  }

  if (event === "RESOLVE_UNCERTAIN_NO_COMMIT") {
    if (current.pendingUncertainMutations < 1) {
      fail(
        "REFRESHER_POLICY_STATE_INVALID",
        "no uncertain mutation is reserved"
      );
    }
    return Object.freeze({
      ...current,
      pendingUncertainMutations:
        current.pendingUncertainMutations - 1
    });
  }

  if (
    current.pendingUncertainMutations < 1 &&
    !snapshot.budgetAvailable
  ) {
    fail(
      "REFRESHER_POLICY_BUDGET_EXHAUSTED",
      "refresh mutation budget is exhausted"
    );
  }
  return Object.freeze({
    ...current,
    confirmedMutations: current.confirmedMutations + 1,
    pendingUncertainMutations:
      current.pendingUncertainMutations > 0
        ? current.pendingUncertainMutations - 1
        : 0
  });
}
