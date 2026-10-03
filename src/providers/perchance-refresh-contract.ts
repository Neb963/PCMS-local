const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export type PerchanceObservationCompatibility =
  | "VERIFIED"
  | "UNKNOWN";

export type PerchanceObservationReasonCode =
  | "PUBLIC_LIBRARY_VERIFIED"
  | "RECENT_OBSERVATION_VERIFIED"
  | "REFRESH_EFFECT_VERIFIED"
  | "PROVIDER_PROTOCOL_UNKNOWN"
  | "PROVIDER_SEMANTICS_UNKNOWN";

export interface PerchanceObservedGenerator {
  readonly slug: string;
  readonly publicId: string | null;
}

export interface PerchancePublicListingObservation {
  readonly semantic: "PUBLIC_LIBRARY";
  readonly compatibility: PerchanceObservationCompatibility;
  readonly reasonCode: PerchanceObservationReasonCode;
  readonly complete: boolean;
  readonly items: readonly PerchanceObservedGenerator[];
  readonly observedAt: string;
}

export interface PerchanceRecentObservation {
  readonly semantic: "RECENTLY_UPDATED";
  readonly compatibility: PerchanceObservationCompatibility;
  readonly reasonCode: PerchanceObservationReasonCode;
  readonly complete: boolean;
  readonly credibleAbsence: boolean;
  readonly observedSlotCount: number | null;
  readonly items: readonly PerchanceObservedGenerator[];
  readonly observedAt: string;
}

export type PerchanceRefreshEffectState =
  | "NONE"
  | "PENDING"
  | "VISIBLE"
  | "UNKNOWN";

export interface PerchanceRefreshEffectObservation {
  readonly semantic: "REFRESH_EFFECT";
  readonly compatibility: PerchanceObservationCompatibility;
  readonly reasonCode: PerchanceObservationReasonCode;
  readonly state: PerchanceRefreshEffectState;
  readonly publicId: string | null;
  readonly markerStrategyId: "PCMS_MARKER_BOTH_V1" | null;
  readonly refreshToken: string | null;
  readonly refreshSequence: number | null;
  readonly recentRank: number | null;
  readonly observedAt: string;
}

function plainObject(
  value: unknown
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(
  value: unknown,
  maximum: number
): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum
  );
}

function timestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("Provider observation timestamp is invalid");
  }
  return new Date(milliseconds).toISOString();
}

function parseItems(
  value: unknown
): readonly PerchanceObservedGenerator[] | null {
  if (!Array.isArray(value) || value.length > 10_000) {
    return null;
  }
  const output: PerchanceObservedGenerator[] = [];
  const identities = new Set<string>();
  for (const raw of value) {
    if (!plainObject(raw) || !boundedText(raw["slug"], 512)) {
      return null;
    }
    const publicId = raw["publicId"];
    if (
      publicId !== null &&
      publicId !== undefined &&
      !boundedText(publicId, 256)
    ) {
      return null;
    }
    const item = Object.freeze({
      slug: raw["slug"],
      publicId:
        publicId === null || publicId === undefined
          ? null
          : publicId
    });
    const identity =
      item.publicId === null
        ? `slug:${item.slug}`
        : `id:${item.publicId}`;
    if (identities.has(identity)) {
      return null;
    }
    identities.add(identity);
    output.push(item);
  }
  return Object.freeze(output);
}

function unknownPublicListing(
  observedAt: string,
  reasonCode: PerchanceObservationReasonCode
): PerchancePublicListingObservation {
  return Object.freeze({
    semantic: "PUBLIC_LIBRARY",
    compatibility: "UNKNOWN",
    reasonCode,
    complete: false,
    items: Object.freeze([]),
    observedAt
  });
}

function unknownRecent(
  observedAt: string,
  reasonCode: PerchanceObservationReasonCode
): PerchanceRecentObservation {
  return Object.freeze({
    semantic: "RECENTLY_UPDATED",
    compatibility: "UNKNOWN",
    reasonCode,
    complete: false,
    credibleAbsence: false,
    observedSlotCount: null,
    items: Object.freeze([]),
    observedAt
  });
}

function unknownRefreshEffect(
  observedAt: string,
  reasonCode: PerchanceObservationReasonCode
): PerchanceRefreshEffectObservation {
  return Object.freeze({
    semantic: "REFRESH_EFFECT",
    compatibility: "UNKNOWN",
    reasonCode,
    state: "UNKNOWN",
    publicId: null,
    markerStrategyId: null,
    refreshToken: null,
    refreshSequence: null,
    recentRank: null,
    observedAt
  });
}

export function decodePerchancePublicListingContract(
  raw: unknown,
  observedAtInput: string
): PerchancePublicListingObservation {
  const observedAt = timestamp(observedAtInput);
  if (!plainObject(raw) || raw["contractVersion"] !== 1) {
    return unknownPublicListing(
      observedAt,
      "PROVIDER_PROTOCOL_UNKNOWN"
    );
  }
  if (raw["semantic"] !== "PUBLIC_LIBRARY") {
    return unknownPublicListing(
      observedAt,
      "PROVIDER_SEMANTICS_UNKNOWN"
    );
  }
  if (typeof raw["complete"] !== "boolean") {
    return unknownPublicListing(
      observedAt,
      "PROVIDER_PROTOCOL_UNKNOWN"
    );
  }
  const items = parseItems(raw["items"]);
  if (items === null) {
    return unknownPublicListing(
      observedAt,
      "PROVIDER_PROTOCOL_UNKNOWN"
    );
  }
  return Object.freeze({
    semantic: "PUBLIC_LIBRARY",
    compatibility: "VERIFIED",
    reasonCode: "PUBLIC_LIBRARY_VERIFIED",
    complete: raw["complete"],
    items,
    observedAt
  });
}

export function decodePerchanceRecentObservationContract(
  raw: unknown,
  observedAtInput: string
): PerchanceRecentObservation {
  const observedAt = timestamp(observedAtInput);
  if (!plainObject(raw) || raw["contractVersion"] !== 1) {
    return unknownRecent(
      observedAt,
      "PROVIDER_PROTOCOL_UNKNOWN"
    );
  }
  if (raw["semantic"] !== "RECENTLY_UPDATED") {
    return unknownRecent(
      observedAt,
      "PROVIDER_SEMANTICS_UNKNOWN"
    );
  }
  if (
    typeof raw["complete"] !== "boolean" ||
    !Number.isSafeInteger(raw["observedSlotCount"]) ||
    (raw["observedSlotCount"] as number) < 0
  ) {
    return unknownRecent(
      observedAt,
      "PROVIDER_PROTOCOL_UNKNOWN"
    );
  }
  const items = parseItems(raw["items"]);
  if (
    items === null ||
    raw["observedSlotCount"] !== items.length
  ) {
    return unknownRecent(
      observedAt,
      "PROVIDER_PROTOCOL_UNKNOWN"
    );
  }
  return Object.freeze({
    semantic: "RECENTLY_UPDATED",
    compatibility: "VERIFIED",
    reasonCode: "RECENT_OBSERVATION_VERIFIED",
    complete: raw["complete"],
    credibleAbsence: raw["complete"],
    observedSlotCount: raw["observedSlotCount"] as number,
    items,
    observedAt
  });
}

export function decodePerchanceRefreshEffectContract(
  raw: unknown,
  observedAtInput: string
): PerchanceRefreshEffectObservation {
  const observedAt = timestamp(observedAtInput);
  if (!plainObject(raw) || raw["contractVersion"] !== 1) {
    return unknownRefreshEffect(
      observedAt,
      "PROVIDER_PROTOCOL_UNKNOWN"
    );
  }
  if (raw["semantic"] !== "REFRESH_EFFECT") {
    return unknownRefreshEffect(
      observedAt,
      "PROVIDER_SEMANTICS_UNKNOWN"
    );
  }
  if (!boundedText(raw["publicId"], 256)) {
    return unknownRefreshEffect(
      observedAt,
      "PROVIDER_PROTOCOL_UNKNOWN"
    );
  }
  const state = raw["state"];
  if (state === "NONE") {
    return Object.freeze({
      semantic: "REFRESH_EFFECT",
      compatibility: "VERIFIED",
      reasonCode: "REFRESH_EFFECT_VERIFIED",
      state,
      publicId: raw["publicId"],
      markerStrategyId: null,
      refreshToken: null,
      refreshSequence: null,
      recentRank: null,
      observedAt
    });
  }
  if (state !== "PENDING" && state !== "VISIBLE") {
    return unknownRefreshEffect(
      observedAt,
      "PROVIDER_PROTOCOL_UNKNOWN"
    );
  }
  const refreshToken = raw["refreshToken"];
  const refreshSequence = raw["refreshSequence"];
  const recentRank = raw["recentRank"];
  if (
    raw["markerStrategyId"] !== "PCMS_MARKER_BOTH_V1" ||
    typeof refreshToken !== "string" ||
    !TOKEN.test(refreshToken) ||
    !Number.isSafeInteger(refreshSequence) ||
    (refreshSequence as number) < 1 ||
    (
      recentRank !== null &&
      (
        !Number.isSafeInteger(recentRank) ||
        (recentRank as number) < 0
      )
    ) ||
    (state === "VISIBLE" && recentRank === null)
  ) {
    return unknownRefreshEffect(
      observedAt,
      "PROVIDER_PROTOCOL_UNKNOWN"
    );
  }
  return Object.freeze({
    semantic: "REFRESH_EFFECT",
    compatibility: "VERIFIED",
    reasonCode: "REFRESH_EFFECT_VERIFIED",
    state,
    publicId: raw["publicId"],
    markerStrategyId: "PCMS_MARKER_BOTH_V1",
    refreshToken,
    refreshSequence: refreshSequence as number,
    recentRank: recentRank as number | null,
    observedAt
  });
}
