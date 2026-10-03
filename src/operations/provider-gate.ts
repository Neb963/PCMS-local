import type { DatabaseSync } from "node:sqlite";

const PROVIDER_ID = /^[a-z][a-z0-9.-]{0,63}$/u;
const SAFE_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type ProviderGateSignalKind =
  | "RATE_LIMIT"
  | "CHALLENGE"
  | "OUTAGE";

export type ProviderGateScopeKind =
  | "PROVIDER"
  | "ACCOUNT"
  | "PERSONA";

export interface ProviderGateScope {
  readonly provider: string;
  readonly accountId?: string | null;
  readonly personaUid?: string | null;
}

export interface ProviderGateSignal extends ProviderGateScope {
  readonly kind: ProviderGateSignalKind;
  readonly cooldownMs: number;
  readonly reason: string;
  readonly scopeKind?: ProviderGateScopeKind;
}

export interface ProviderGateLimits {
  readonly maxGlobalMutations?: number;
  readonly maxProviderMutations?: number;
  readonly maxAccountMutations?: number;
  readonly maxPersonaMutations?: number;
}

export interface ProviderGateOptions extends ProviderGateLimits {
  readonly database: DatabaseSync;
  readonly now?: () => Date;
}

export interface ProviderGateCooldown {
  readonly provider: string;
  readonly scopeKind: ProviderGateScopeKind;
  readonly scopeKey: string;
  readonly signalKind: ProviderGateSignalKind;
  readonly cooldownUntil: string;
  readonly reason: string;
  readonly observedAt: string;
  readonly revision: number;
}

export interface ProviderGatePermit {
  readonly provider: string;
  readonly accountId: string | null;
  readonly personaUid: string | null;
  readonly admittedAt: string;
  release(): void;
}

export type ProviderGateErrorCode =
  | "PROVIDER_GATE_INVALID_INPUT"
  | "PROVIDER_GATE_BUSY"
  | "PROVIDER_GATE_COOLDOWN"
  | "PROVIDER_GATE_STATE_INVALID";

export class ProviderGateError extends Error {
  public constructor(
    public readonly code: ProviderGateErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAt: string | null = null
  ) {
    super(message);
    this.name = "ProviderGateError";
  }
}

interface ProviderStateRow {
  readonly provider_id: unknown;
  readonly scope_kind: unknown;
  readonly scope_key: unknown;
  readonly signal_kind: unknown;
  readonly cooldown_until: unknown;
  readonly reason: unknown;
  readonly observed_at: unknown;
  readonly revision: unknown;
}

function fail(
  code: ProviderGateErrorCode,
  message: string,
  retryable = false,
  retryAt: string | null = null
): never {
  throw new ProviderGateError(code, message, retryable, retryAt);
}

function validatePositiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1024) {
    fail(
      "PROVIDER_GATE_INVALID_INPUT",
      `${label} must be an integer between 1 and 1024`
    );
  }
  return value;
}

function normalizeProvider(provider: string): string {
  if (!PROVIDER_ID.test(provider)) {
    fail(
      "PROVIDER_GATE_INVALID_INPUT",
      "provider ID has invalid syntax"
    );
  }
  return provider;
}

function normalizeScopeId(
  value: string | null | undefined,
  label: string
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!SAFE_SCOPE_ID.test(value)) {
    fail(
      "PROVIDER_GATE_INVALID_INPUT",
      `${label} has invalid syntax`
    );
  }
  return value;
}

function normalizeScope(scope: ProviderGateScope): Readonly<{
  provider: string;
  accountId: string | null;
  personaUid: string | null;
}> {
  return Object.freeze({
    provider: normalizeProvider(scope.provider),
    accountId: normalizeScopeId(scope.accountId, "accountId"),
    personaUid: normalizeScopeId(scope.personaUid, "personaUid")
  });
}

function validateSignalKind(
  kind: ProviderGateSignalKind
): ProviderGateSignalKind {
  if (
    kind !== "RATE_LIMIT" &&
    kind !== "CHALLENGE" &&
    kind !== "OUTAGE"
  ) {
    fail(
      "PROVIDER_GATE_INVALID_INPUT",
      "provider signal kind is invalid"
    );
  }
  return kind;
}

function normalizeReason(reason: string): string {
  const value = reason.trim();
  if (value.length < 1 || value.length > 256) {
    fail(
      "PROVIDER_GATE_INVALID_INPUT",
      "provider signal reason must contain 1-256 characters"
    );
  }
  return value;
}

function parseScopeKind(value: unknown): ProviderGateScopeKind {
  if (
    value === "PROVIDER" ||
    value === "ACCOUNT" ||
    value === "PERSONA"
  ) {
    return value;
  }
  fail(
    "PROVIDER_GATE_STATE_INVALID",
    "stored provider scope kind is invalid"
  );
}

function parseSignalKind(value: unknown): ProviderGateSignalKind {
  if (
    value === "RATE_LIMIT" ||
    value === "CHALLENGE" ||
    value === "OUTAGE"
  ) {
    return value;
  }
  fail(
    "PROVIDER_GATE_STATE_INVALID",
    "stored provider signal kind is invalid"
  );
}

function parseStateRow(row: ProviderStateRow): ProviderGateCooldown {
  if (
    typeof row.provider_id !== "string" ||
    typeof row.scope_key !== "string" ||
    typeof row.cooldown_until !== "string" ||
    typeof row.reason !== "string" ||
    typeof row.observed_at !== "string" ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    fail(
      "PROVIDER_GATE_STATE_INVALID",
      "stored provider gate state is invalid"
    );
  }
  return Object.freeze({
    provider: row.provider_id,
    scopeKind: parseScopeKind(row.scope_kind),
    scopeKey: row.scope_key,
    signalKind: parseSignalKind(row.signal_kind),
    cooldownUntil: row.cooldown_until,
    reason: row.reason,
    observedAt: row.observed_at,
    revision: row.revision
  });
}

function decrement(map: Map<string, number>, key: string): void {
  const count = map.get(key) ?? 0;
  if (count <= 1) {
    map.delete(key);
  } else {
    map.set(key, count - 1);
  }
}

export class ProviderGate {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;
  readonly #maxGlobalMutations: number;
  readonly #maxProviderMutations: number;
  readonly #maxAccountMutations: number;
  readonly #maxPersonaMutations: number;
  #globalActive = 0;
  readonly #providerActive = new Map<string, number>();
  readonly #accountActive = new Map<string, number>();
  readonly #personaActive = new Map<string, number>();

  public constructor(options: ProviderGateOptions) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#maxGlobalMutations = validatePositiveLimit(
      options.maxGlobalMutations ?? 4,
      "maxGlobalMutations"
    );
    this.#maxProviderMutations = validatePositiveLimit(
      options.maxProviderMutations ?? 2,
      "maxProviderMutations"
    );
    this.#maxAccountMutations = validatePositiveLimit(
      options.maxAccountMutations ?? 1,
      "maxAccountMutations"
    );
    this.#maxPersonaMutations = validatePositiveLimit(
      options.maxPersonaMutations ?? 1,
      "maxPersonaMutations"
    );
  }

  public acquire(scope: ProviderGateScope): ProviderGatePermit {
    const normalized = normalizeScope(scope);
    const admittedAt = this.#currentDate();
    const cooldown = this.#blockingCooldown(normalized, admittedAt);
    if (cooldown !== null) {
      fail(
        "PROVIDER_GATE_COOLDOWN",
        `provider mutation admission is cooling down after ${cooldown.signalKind.toLowerCase()}: ${cooldown.reason}`,
        true,
        cooldown.cooldownUntil
      );
    }

    const providerCount =
      this.#providerActive.get(normalized.provider) ?? 0;
    const accountKey =
      normalized.accountId === null
        ? null
        : `${normalized.provider}:account:${normalized.accountId}`;
    const personaKey =
      normalized.personaUid === null
        ? null
        : `${normalized.provider}:persona:${normalized.personaUid}`;

    if (
      this.#globalActive >= this.#maxGlobalMutations ||
      providerCount >= this.#maxProviderMutations ||
      (
        accountKey !== null &&
        (this.#accountActive.get(accountKey) ?? 0) >=
          this.#maxAccountMutations
      ) ||
      (
        personaKey !== null &&
        (this.#personaActive.get(personaKey) ?? 0) >=
          this.#maxPersonaMutations
      )
    ) {
      fail(
        "PROVIDER_GATE_BUSY",
        "provider mutation concurrency is at capacity",
        true
      );
    }

    this.#globalActive += 1;
    this.#providerActive.set(
      normalized.provider,
      providerCount + 1
    );
    if (accountKey !== null) {
      this.#accountActive.set(
        accountKey,
        (this.#accountActive.get(accountKey) ?? 0) + 1
      );
    }
    if (personaKey !== null) {
      this.#personaActive.set(
        personaKey,
        (this.#personaActive.get(personaKey) ?? 0) + 1
      );
    }

    let released = false;
    return Object.freeze({
      provider: normalized.provider,
      accountId: normalized.accountId,
      personaUid: normalized.personaUid,
      admittedAt: admittedAt.toISOString(),
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#globalActive -= 1;
        decrement(this.#providerActive, normalized.provider);
        if (accountKey !== null) {
          decrement(this.#accountActive, accountKey);
        }
        if (personaKey !== null) {
          decrement(this.#personaActive, personaKey);
        }
      }
    });
  }

  public observeSignal(
    signal: ProviderGateSignal
  ): ProviderGateCooldown {
    const normalized = normalizeScope(signal);
    const kind = validateSignalKind(signal.kind);
    if (
      !Number.isSafeInteger(signal.cooldownMs) ||
      signal.cooldownMs < 1 ||
      signal.cooldownMs > MAX_COOLDOWN_MS
    ) {
      fail(
        "PROVIDER_GATE_INVALID_INPUT",
        `cooldownMs must be between 1 and ${MAX_COOLDOWN_MS}`
      );
    }
    const reason = normalizeReason(signal.reason);
    const scopeKind = signal.scopeKind ?? "PROVIDER";
    if (
      scopeKind !== "PROVIDER" &&
      scopeKind !== "ACCOUNT" &&
      scopeKind !== "PERSONA"
    ) {
      fail(
        "PROVIDER_GATE_INVALID_INPUT",
        "provider signal scopeKind is invalid"
      );
    }

    let scopeKey: string;
    if (scopeKind === "PROVIDER") {
      scopeKey = normalized.provider;
    } else if (scopeKind === "ACCOUNT") {
      if (normalized.accountId === null) {
        fail(
          "PROVIDER_GATE_INVALID_INPUT",
          "account-scoped provider signal requires accountId"
        );
      }
      scopeKey = normalized.accountId;
    } else {
      if (normalized.personaUid === null) {
        fail(
          "PROVIDER_GATE_INVALID_INPUT",
          "Persona-scoped provider signal requires personaUid"
        );
      }
      scopeKey = normalized.personaUid;
    }

    const observedAt = this.#currentDate();
    const cooldownUntil = new Date(
      observedAt.getTime() + signal.cooldownMs
    ).toISOString();

    this.#database.prepare(`
      INSERT INTO provider_state (
        provider_id,
        scope_kind,
        scope_key,
        signal_kind,
        cooldown_until,
        reason,
        observed_at,
        revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(provider_id, scope_kind, scope_key)
      DO UPDATE SET
        signal_kind = CASE
          WHEN provider_state.cooldown_until > excluded.cooldown_until
            THEN provider_state.signal_kind
          ELSE excluded.signal_kind
        END,
        cooldown_until = CASE
          WHEN provider_state.cooldown_until > excluded.cooldown_until
            THEN provider_state.cooldown_until
          ELSE excluded.cooldown_until
        END,
        reason = CASE
          WHEN provider_state.cooldown_until > excluded.cooldown_until
            THEN provider_state.reason
          ELSE excluded.reason
        END,
        observed_at = excluded.observed_at,
        revision = provider_state.revision + 1
    `).run(
      normalized.provider,
      scopeKind,
      scopeKey,
      kind,
      cooldownUntil,
      reason,
      observedAt.toISOString()
    );

    return this.#requireState(
      normalized.provider,
      scopeKind,
      scopeKey
    );
  }

  public activeCooldowns(
    scope: ProviderGateScope
  ): readonly ProviderGateCooldown[] {
    const normalized = normalizeScope(scope);
    const now = this.#currentDate();
    return Object.freeze(
      this.#candidateStates(normalized)
        .filter((state) =>
          Date.parse(state.cooldownUntil) > now.getTime()
        )
    );
  }

  #blockingCooldown(
    scope: Readonly<{
      provider: string;
      accountId: string | null;
      personaUid: string | null;
    }>,
    now: Date
  ): ProviderGateCooldown | null {
    const active = this.#candidateStates(scope)
      .filter((state) =>
        Date.parse(state.cooldownUntil) > now.getTime()
      )
      .sort((left, right) =>
        Date.parse(right.cooldownUntil) -
        Date.parse(left.cooldownUntil)
      );
    return active[0] ?? null;
  }

  #candidateStates(
    scope: Readonly<{
      provider: string;
      accountId: string | null;
      personaUid: string | null;
    }>
  ): ProviderGateCooldown[] {
    const candidates: Array<readonly [ProviderGateScopeKind, string]> = [
      ["PROVIDER", scope.provider]
    ];
    if (scope.accountId !== null) {
      candidates.push(["ACCOUNT", scope.accountId]);
    }
    if (scope.personaUid !== null) {
      candidates.push(["PERSONA", scope.personaUid]);
    }

    const states: ProviderGateCooldown[] = [];
    for (const [kind, key] of candidates) {
      const row = this.#database.prepare(`
        SELECT
          provider_id,
          scope_kind,
          scope_key,
          signal_kind,
          cooldown_until,
          reason,
          observed_at,
          revision
        FROM provider_state
        WHERE provider_id = ?
          AND scope_kind = ?
          AND scope_key = ?
      `).get(scope.provider, kind, key) as
        | Record<string, unknown>
        | undefined;
      if (row !== undefined) {
        states.push(parseStateRow(row as unknown as ProviderStateRow));
      }
    }
    return states;
  }

  #requireState(
    provider: string,
    scopeKind: ProviderGateScopeKind,
    scopeKey: string
  ): ProviderGateCooldown {
    const row = this.#database.prepare(`
      SELECT
        provider_id,
        scope_kind,
        scope_key,
        signal_kind,
        cooldown_until,
        reason,
        observed_at,
        revision
      FROM provider_state
      WHERE provider_id = ?
        AND scope_kind = ?
        AND scope_key = ?
    `).get(provider, scopeKind, scopeKey) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) {
      fail(
        "PROVIDER_GATE_STATE_INVALID",
        "provider gate state disappeared after update"
      );
    }
    return parseStateRow(row as unknown as ProviderStateRow);
  }

  #currentDate(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      fail(
        "PROVIDER_GATE_INVALID_INPUT",
        "provider gate clock returned an invalid time"
      );
    }
    return value;
  }
}
