import type { AccountRecord } from "../accounts/account-repository.js";

export type EvidenceFreshness = "CURRENT" | "STALE" | "UNKNOWN";
export type HealthEvidenceBasis =
  | "UNKNOWN"
  | "CONFIGURED"
  | "OBSERVED"
  | "VERIFIED";

export type ConfiguredRouteMode = "DIRECT" | "BLOCK" | "PROTECTED";

export type RouteObservedState =
  | "PREPARING"
  | "READY_UNVERIFIED"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "BLOCKED";

export type RouteVerifiedState =
  | "HEALTHY"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "BLOCKED";

export type SessionState =
  | "AUTHENTICATED"
  | "UNAUTHENTICATED"
  | "CHALLENGE"
  | "UNAVAILABLE";

export type AccountHealthState =
  | "HEALTHY"
  | "OBSERVED"
  | "DEGRADED"
  | "UNKNOWN"
  | "STALE"
  | "UNBOUND"
  | "INACTIVE";

export interface RouteHealthEvidence {
  readonly configuredMode: ConfiguredRouteMode | null;
  readonly configuredRouteId?: string | null;
  readonly observedState?: RouteObservedState | null;
  readonly observedAt?: string | null;
  readonly verifiedState?: RouteVerifiedState | null;
  readonly verifiedAt?: string | null;
}

export interface SessionHealthEvidence {
  readonly observedState?: SessionState | null;
  readonly observedAccountId?: string | null;
  readonly observedAt?: string | null;
  readonly verifiedState?: SessionState | null;
  readonly verifiedAccountId?: string | null;
  readonly verifiedAt?: string | null;
}

export interface HealthProjectionOptions {
  readonly now?: () => Date;
  readonly staleAfterMs?: number;
}

export interface RouteHealthProjection {
  readonly configuredMode: ConfiguredRouteMode | null;
  readonly configuredRouteId: string | null;
  readonly state: "UNKNOWN" | "CONFIGURED" | RouteObservedState | RouteVerifiedState;
  readonly basis: HealthEvidenceBasis;
  readonly evidenceAt: string | null;
  readonly ageMs: number | null;
  readonly freshness: EvidenceFreshness;
}

export interface SessionHealthProjection {
  readonly state: "UNKNOWN" | SessionState;
  readonly basis: Exclude<HealthEvidenceBasis, "CONFIGURED">;
  readonly accountId: string | null;
  readonly evidenceAt: string | null;
  readonly ageMs: number | null;
  readonly freshness: EvidenceFreshness;
}

export interface AccountHealthProjection {
  readonly accountId: string;
  readonly personaUid: string | null;
  readonly state: AccountHealthState;
  readonly expectedAccountId: string;
  readonly observedAccountId: string | null;
  readonly sessionBasis: SessionHealthProjection["basis"];
  readonly evidenceAt: string | null;
  readonly ageMs: number | null;
  readonly freshness: EvidenceFreshness;
}

export interface InventoryHealthProjection {
  readonly route: RouteHealthProjection;
  readonly session: SessionHealthProjection;
  readonly account: AccountHealthProjection;
}

export class HealthProjectionError extends Error {
  public readonly code = "HEALTH_EVIDENCE_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "HealthProjectionError";
  }
}

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

function optionalValue<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function requireEvidencePair(
  state: unknown,
  at: string | null,
  label: string
): void {
  if ((state === null) !== (at === null)) {
    throw new HealthProjectionError(
      `${label} state and timestamp must either both be present or both be absent`
    );
  }
}

function evidenceAge(timestamp: string, nowMs: number): number {
  const observedMs = Date.parse(timestamp);
  if (!Number.isFinite(observedMs)) {
    throw new HealthProjectionError(
      "Health evidence timestamp must be a valid ISO-compatible timestamp"
    );
  }
  return Math.max(0, nowMs - observedMs);
}

function freshness(ageMs: number, staleAfterMs: number): EvidenceFreshness {
  return ageMs > staleAfterMs ? "STALE" : "CURRENT";
}

function normalizeRouteConfiguration(
  evidence: RouteHealthEvidence
): Readonly<{
  mode: ConfiguredRouteMode | null;
  routeId: string | null;
}> {
  const routeId = optionalValue(evidence.configuredRouteId);
  if (evidence.configuredMode === null) {
    if (routeId !== null) {
      throw new HealthProjectionError(
        "Route ID cannot exist without a configured route mode"
      );
    }
    return Object.freeze({ mode: null, routeId: null });
  }

  if (evidence.configuredMode === "PROTECTED") {
    if (
      routeId === null ||
      routeId.trim().length === 0 ||
      routeId.length > 256
    ) {
      throw new HealthProjectionError(
        "Protected route health requires a bounded configured route ID"
      );
    }
    return Object.freeze({
      mode: evidence.configuredMode,
      routeId: routeId.trim()
    });
  }

  if (routeId !== null) {
    throw new HealthProjectionError(
      "Direct and Block route modes must not carry a protected route ID"
    );
  }
  return Object.freeze({ mode: evidence.configuredMode, routeId: null });
}

export function projectRouteHealth(
  evidence: RouteHealthEvidence | null | undefined,
  options: HealthProjectionOptions = {}
): RouteHealthProjection {
  if (evidence === null || evidence === undefined) {
    return Object.freeze({
      configuredMode: null,
      configuredRouteId: null,
      state: "UNKNOWN",
      basis: "UNKNOWN",
      evidenceAt: null,
      ageMs: null,
      freshness: "UNKNOWN"
    });
  }

  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new HealthProjectionError(
      "Health stale threshold must be a positive safe integer"
    );
  }

  const configured = normalizeRouteConfiguration(evidence);
  const observedState = optionalValue(evidence.observedState);
  const observedAt = optionalValue(evidence.observedAt);
  const verifiedState = optionalValue(evidence.verifiedState);
  const verifiedAt = optionalValue(evidence.verifiedAt);
  requireEvidencePair(observedState, observedAt, "Observed route");
  requireEvidencePair(verifiedState, verifiedAt, "Verified route");

  if (verifiedState !== null && verifiedAt !== null) {
    const ageMs = evidenceAge(verifiedAt, nowMs);
    return Object.freeze({
      configuredMode: configured.mode,
      configuredRouteId: configured.routeId,
      state: verifiedState,
      basis: "VERIFIED",
      evidenceAt: verifiedAt,
      ageMs,
      freshness: freshness(ageMs, staleAfterMs)
    });
  }

  if (observedState !== null && observedAt !== null) {
    const ageMs = evidenceAge(observedAt, nowMs);
    return Object.freeze({
      configuredMode: configured.mode,
      configuredRouteId: configured.routeId,
      state: observedState,
      basis: "OBSERVED",
      evidenceAt: observedAt,
      ageMs,
      freshness: freshness(ageMs, staleAfterMs)
    });
  }

  if (configured.mode !== null) {
    return Object.freeze({
      configuredMode: configured.mode,
      configuredRouteId: configured.routeId,
      state: configured.mode === "BLOCK" ? "BLOCKED" : "CONFIGURED",
      basis: "CONFIGURED",
      evidenceAt: null,
      ageMs: null,
      freshness: "UNKNOWN"
    });
  }

  return Object.freeze({
    configuredMode: null,
    configuredRouteId: null,
    state: "UNKNOWN",
    basis: "UNKNOWN",
    evidenceAt: null,
    ageMs: null,
    freshness: "UNKNOWN"
  });
}

function validateSessionIdentity(
  state: SessionState | null,
  accountId: string | null,
  label: string
): void {
  if (state === "AUTHENTICATED") {
    if (
      accountId === null ||
      accountId.trim().length === 0 ||
      accountId.length > 256
    ) {
      throw new HealthProjectionError(
        `${label} authenticated session evidence requires a bounded provider account identity`
      );
    }
    return;
  }

  if (accountId !== null) {
    throw new HealthProjectionError(
      `${label} provider account identity is only valid for AUTHENTICATED session evidence`
    );
  }
}

export function projectSessionHealth(
  evidence: SessionHealthEvidence | null | undefined,
  options: HealthProjectionOptions = {}
): SessionHealthProjection {
  if (evidence === null || evidence === undefined) {
    return Object.freeze({
      state: "UNKNOWN",
      basis: "UNKNOWN",
      accountId: null,
      evidenceAt: null,
      ageMs: null,
      freshness: "UNKNOWN"
    });
  }

  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new HealthProjectionError(
      "Health stale threshold must be a positive safe integer"
    );
  }

  const observedState = optionalValue(evidence.observedState);
  const observedAccountId = optionalValue(evidence.observedAccountId);
  const observedAt = optionalValue(evidence.observedAt);
  const verifiedState = optionalValue(evidence.verifiedState);
  const verifiedAccountId = optionalValue(evidence.verifiedAccountId);
  const verifiedAt = optionalValue(evidence.verifiedAt);

  requireEvidencePair(observedState, observedAt, "Observed session");
  requireEvidencePair(verifiedState, verifiedAt, "Verified session");
  validateSessionIdentity(observedState, observedAccountId, "Observed");
  validateSessionIdentity(verifiedState, verifiedAccountId, "Verified");

  if (verifiedState !== null && verifiedAt !== null) {
    const ageMs = evidenceAge(verifiedAt, nowMs);
    return Object.freeze({
      state: verifiedState,
      basis: "VERIFIED",
      accountId: verifiedAccountId,
      evidenceAt: verifiedAt,
      ageMs,
      freshness: freshness(ageMs, staleAfterMs)
    });
  }

  if (observedState !== null && observedAt !== null) {
    const ageMs = evidenceAge(observedAt, nowMs);
    return Object.freeze({
      state: observedState,
      basis: "OBSERVED",
      accountId: observedAccountId,
      evidenceAt: observedAt,
      ageMs,
      freshness: freshness(ageMs, staleAfterMs)
    });
  }

  return Object.freeze({
    state: "UNKNOWN",
    basis: "UNKNOWN",
    accountId: null,
    evidenceAt: null,
    ageMs: null,
    freshness: "UNKNOWN"
  });
}

export function projectAccountHealth(
  account: AccountRecord,
  route: RouteHealthProjection,
  session: SessionHealthProjection
): AccountHealthProjection {
  let state: AccountHealthState;

  if (account.lifecycleStatus !== "ACTIVE") {
    state = "INACTIVE";
  } else if (account.personaUid === null) {
    state = "UNBOUND";
  } else if (
    route.freshness === "STALE" ||
    session.freshness === "STALE"
  ) {
    state = "STALE";
  } else if (
    route.state === "DEGRADED" ||
    route.state === "UNAVAILABLE" ||
    route.state === "BLOCKED" ||
    session.state === "UNAUTHENTICATED" ||
    session.state === "CHALLENGE" ||
    session.state === "UNAVAILABLE"
  ) {
    state = "DEGRADED";
  } else if (
    session.basis === "VERIFIED" &&
    session.state === "AUTHENTICATED"
  ) {
    if (session.accountId !== account.accountId) {
      state = "DEGRADED";
    } else if (
      route.configuredMode === "PROTECTED" &&
      !(route.basis === "VERIFIED" && route.state === "HEALTHY")
    ) {
      state =
        route.basis === "OBSERVED" || route.basis === "CONFIGURED"
          ? "OBSERVED"
          : "UNKNOWN";
    } else {
      state = "HEALTHY";
    }
  } else if (
    session.basis === "OBSERVED" &&
    session.state === "AUTHENTICATED"
  ) {
    state = "OBSERVED";
  } else {
    state = "UNKNOWN";
  }

  return Object.freeze({
    accountId: account.accountId,
    personaUid: account.personaUid,
    state,
    expectedAccountId: account.accountId,
    observedAccountId: session.accountId,
    sessionBasis: session.basis,
    evidenceAt: session.evidenceAt,
    ageMs: session.ageMs,
    freshness: session.freshness
  });
}

export function projectInventoryHealth(
  account: AccountRecord,
  routeEvidence: RouteHealthEvidence | null | undefined,
  sessionEvidence: SessionHealthEvidence | null | undefined,
  options: HealthProjectionOptions = {}
): InventoryHealthProjection {
  const route = projectRouteHealth(routeEvidence, options);
  const session = projectSessionHealth(sessionEvidence, options);
  return Object.freeze({
    route,
    session,
    account: projectAccountHealth(account, route, session)
  });
}
