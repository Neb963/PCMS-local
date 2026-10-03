import type { AccountRecord } from "../accounts/account-repository.js";
import type { SessionHealthProjection } from "./health-projection.js";

export type SensitiveAccountAdmissionBlockReason =
  | "ACCOUNT_INACTIVE"
  | "ACCOUNT_UNBOUND"
  | "SESSION_UNVERIFIED"
  | "SESSION_STALE"
  | "SESSION_NOT_AUTHENTICATED"
  | "SESSION_IDENTITY_UNKNOWN"
  | "WRONG_ACCOUNT";

export interface SensitiveAccountAdmissionAllowed {
  readonly status: "ALLOWED";
  readonly accountId: string;
  readonly personaUid: string;
  readonly verifiedAccountId: string;
  readonly verifiedAt: string;
}

export interface SensitiveAccountAdmissionBlocked {
  readonly status: "BLOCKED";
  readonly reason: SensitiveAccountAdmissionBlockReason;
  readonly accountId: string;
  readonly personaUid: string | null;
  readonly observedAccountId: string | null;
  readonly evidenceAt: string | null;
  readonly needsAttention: boolean;
}

export type SensitiveAccountAdmissionDecision =
  | SensitiveAccountAdmissionAllowed
  | SensitiveAccountAdmissionBlocked;

export class SensitiveAccountAdmissionError extends Error {
  public readonly code = "SENSITIVE_ACCOUNT_ADMISSION_BLOCKED";

  public constructor(
    public readonly decision: SensitiveAccountAdmissionBlocked
  ) {
    super(
      `Sensitive Account action blocked for ${decision.accountId}: ${decision.reason}`
    );
    this.name = "SensitiveAccountAdmissionError";
  }
}

function blocked(
  account: AccountRecord,
  session: SessionHealthProjection,
  reason: SensitiveAccountAdmissionBlockReason,
  needsAttention: boolean
): SensitiveAccountAdmissionBlocked {
  return Object.freeze({
    status: "BLOCKED",
    reason,
    accountId: account.accountId,
    personaUid: account.personaUid,
    observedAccountId: session.accountId,
    evidenceAt: session.evidenceAt,
    needsAttention
  });
}

export function evaluateSensitiveAccountAdmission(
  account: AccountRecord,
  session: SessionHealthProjection
): SensitiveAccountAdmissionDecision {
  if (account.lifecycleStatus !== "ACTIVE") {
    return blocked(account, session, "ACCOUNT_INACTIVE", false);
  }

  if (account.personaUid === null) {
    return blocked(account, session, "ACCOUNT_UNBOUND", false);
  }

  if (session.basis !== "VERIFIED") {
    return blocked(account, session, "SESSION_UNVERIFIED", true);
  }

  if (session.freshness !== "CURRENT") {
    return blocked(account, session, "SESSION_STALE", true);
  }

  if (session.state !== "AUTHENTICATED") {
    return blocked(account, session, "SESSION_NOT_AUTHENTICATED", true);
  }

  if (session.accountId === null || session.evidenceAt === null) {
    return blocked(account, session, "SESSION_IDENTITY_UNKNOWN", true);
  }

  if (session.accountId !== account.accountId) {
    return blocked(account, session, "WRONG_ACCOUNT", true);
  }

  return Object.freeze({
    status: "ALLOWED",
    accountId: account.accountId,
    personaUid: account.personaUid,
    verifiedAccountId: session.accountId,
    verifiedAt: session.evidenceAt
  });
}

export function requireSensitiveAccountAdmission(
  account: AccountRecord,
  session: SessionHealthProjection
): SensitiveAccountAdmissionAllowed {
  const decision = evaluateSensitiveAccountAdmission(account, session);
  if (decision.status === "BLOCKED") {
    throw new SensitiveAccountAdmissionError(decision);
  }
  return decision;
}
