import type {
  ProviderGateSignalKind,
  ProviderGateScopeKind
} from "../operations/provider-gate.js";

const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface PerchanceGateSignalPolicy {
  readonly rateLimitCooldownMs: number;
  readonly challengeCooldownMs: number;
}

export interface PerchanceGateSignal {
  readonly kind: ProviderGateSignalKind;
  readonly scopeKind: ProviderGateScopeKind;
  readonly cooldownMs: number;
  readonly reason: string;
}

export interface PerchanceGateSignalEvidence {
  readonly compatibility: "VERIFIED" | "UNKNOWN";
  readonly providerStatus: string | null;
  readonly signal: PerchanceGateSignal | null;
}

function validCooldown(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_COOLDOWN_MS
  ) {
    throw new TypeError(
      `${label} must be an integer between 1 and ${MAX_COOLDOWN_MS}`
    );
  }
  return value;
}

export function normalizePerchanceGateSignal(
  providerStatus: unknown,
  policy: PerchanceGateSignalPolicy
): PerchanceGateSignalEvidence {
  const rateLimitCooldownMs = validCooldown(
    policy.rateLimitCooldownMs,
    "rateLimitCooldownMs"
  );
  const challengeCooldownMs = validCooldown(
    policy.challengeCooldownMs,
    "challengeCooldownMs"
  );

  if (providerStatus === "too-many-requests") {
    return Object.freeze({
      compatibility: "VERIFIED",
      providerStatus,
      signal: Object.freeze({
        kind: "RATE_LIMIT",
        scopeKind: "PROVIDER",
        cooldownMs: rateLimitCooldownMs,
        reason: "perchance-rate-limit"
      })
    });
  }

  if (providerStatus === "captcha-needed") {
    return Object.freeze({
      compatibility: "VERIFIED",
      providerStatus,
      signal: Object.freeze({
        kind: "CHALLENGE",
        scopeKind: "ACCOUNT",
        cooldownMs: challengeCooldownMs,
        reason: "perchance-account-challenge"
      })
    });
  }

  if (
    providerStatus === "saved" ||
    providerStatus === "success"
  ) {
    return Object.freeze({
      compatibility: "VERIFIED",
      providerStatus,
      signal: null
    });
  }

  return Object.freeze({
    compatibility: "UNKNOWN",
    providerStatus:
      typeof providerStatus === "string"
        ? providerStatus
        : null,
    signal: null
  });
}
