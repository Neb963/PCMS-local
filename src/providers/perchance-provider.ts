import type {
  BrowserDriverCommandOptions,
  BrowserPage
} from "../browser/browser-driver.js";

const MAX_IDENTITY_LENGTH = 320;
const MAX_BROWSER_ARTIFACT_EXPRESSION_LENGTH = 32 * 1024;
const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

export type PerchanceSessionIdentityStatus = "EXPECTED" | "MISMATCH" | "UNKNOWN";
export type PerchanceGeneratorIdentityStatus = "VERIFIED" | "MISMATCH" | "UNKNOWN";
export type PerchanceGeneratorSlugStatus = "CURRENT" | "CHANGED" | "UNKNOWN";
export type ProviderEvidenceFreshness = "CURRENT" | "STALE";

export type PerchanceProbeReasonCode =
  | "SESSION_VERIFIED"
  | "SESSION_MATERIAL_UNAVAILABLE"
  | "SESSION_IDENTITY_MISMATCH"
  | "SESSION_EVIDENCE_CONFLICT"
  | "SESSION_PAIRING_REJECTED"
  | "PROVIDER_TRANSPORT_UNKNOWN"
  | "PROVIDER_ACCESS_BLOCKED"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_PROTOCOL_UNKNOWN"
  | "GENERATOR_VERIFIED"
  | "GENERATOR_SLUG_CHANGED"
  | "GENERATOR_STABLE_ID_UNKNOWN"
  | "GENERATOR_STABLE_ID_UNOBSERVED"
  | "GENERATOR_STABLE_ID_MISMATCH"
  | "GENERATOR_NOT_OWNED";

export interface PerchanceBrowserReadProfile {
  /**
   * Trusted provider-compatibility artifact expression evaluated in the provider
   * page. It may return { identity, sessionToken }, but the adapter wrapper keeps
   * sessionToken page-local and never returns it through BrowserDriver.
   */
  readonly sessionStateExpression: string;
}

export interface PerchanceProviderOptions {
  readonly browserProfile: PerchanceBrowserReadProfile;
  readonly now?: () => Date;
}

export interface PerchanceGeneratorRef {
  readonly publicId: string | null;
  readonly slug: string;
}

export interface PerchanceSessionIdentityEvidence {
  readonly status: PerchanceSessionIdentityStatus;
  readonly reasonCode: PerchanceProbeReasonCode;
  readonly observedIdentity: string | null;
  readonly generatorCount: number | null;
  readonly observedAt: string;
}

export interface PerchanceGeneratorExpectation {
  readonly generatorLocalId: string;
  readonly providerStableId: string | null;
  readonly currentSlug: string;
}

export interface PerchanceGeneratorIdentityEvidence {
  readonly generatorLocalId: string;
  readonly sessionStatus: PerchanceSessionIdentityStatus;
  readonly identityStatus: PerchanceGeneratorIdentityStatus;
  readonly slugStatus: PerchanceGeneratorSlugStatus;
  readonly expectedProviderStableId: string | null;
  readonly expectedSlug: string;
  readonly observedProviderStableId: string | null;
  readonly observedSlug: string | null;
  readonly reasonCode: PerchanceProbeReasonCode;
  readonly observedAt: string;
}

interface ProviderPageProbeResult {
  readonly kind?: unknown;
  readonly observedIdentity?: unknown;
  readonly httpStatus?: unknown;
  readonly contentType?: unknown;
  readonly jsonParsed?: unknown;
  readonly status?: unknown;
  readonly generators?: unknown;
  readonly generatorFolderMapValid?: unknown;
}

interface OwnedGeneratorProbe {
  readonly session: PerchanceSessionIdentityEvidence;
  readonly generators: readonly PerchanceGeneratorRef[];
}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
  );
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32)
  );
}

export function perchanceIdentityMatches(
  expectedIdentity: string,
  observedIdentity: string
): boolean {
  return asciiLowercase(expectedIdentity) === asciiLowercase(observedIdentity);
}

function validateIdentity(identity: string): void {
  if (!boundedText(identity, MAX_IDENTITY_LENGTH)) {
    throw new TypeError(
      `Perchance provider identity must contain 1-${MAX_IDENTITY_LENGTH} characters`
    );
  }
}

function validateBrowserProfile(profile: PerchanceBrowserReadProfile): void {
  if (
    profile.sessionStateExpression.trim().length === 0 ||
    profile.sessionStateExpression.length > MAX_BROWSER_ARTIFACT_EXPRESSION_LENGTH
  ) {
    throw new TypeError(
      "Perchance session-state compatibility expression must be non-empty and bounded"
    );
  }
}

function parseGeneratorRef(value: unknown): PerchanceGeneratorRef | null {
  if (typeof value === "string") {
    return boundedText(value, 512)
      ? Object.freeze({ publicId: null, slug: value })
      : null;
  }
  if (!plainObject(value)) {
    return null;
  }

  const slug =
    value["slug"] ??
    value["name"] ??
    value["generatorName"] ??
    value["generator_url_name"];
  const publicId = value["publicId"] ?? value["generatorPublicId"];

  if (!boundedText(slug, 512)) {
    return null;
  }
  if (
    publicId !== undefined &&
    publicId !== null &&
    !boundedText(publicId, 256)
  ) {
    return null;
  }

  return Object.freeze({
    publicId:
      publicId === undefined || publicId === null
        ? null
        : publicId,
    slug
  });
}

function parseGeneratorList(value: unknown): readonly PerchanceGeneratorRef[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const generators: PerchanceGeneratorRef[] = [];
  const stableIds = new Set<string>();

  for (const raw of value) {
    const generator = parseGeneratorRef(raw);
    if (generator === null) {
      return null;
    }
    if (generator.publicId !== null) {
      if (stableIds.has(generator.publicId)) {
        return null;
      }
      stableIds.add(generator.publicId);
    }
    generators.push(generator);
  }
  return Object.freeze(generators);
}

function buildProbeExpression(
  sessionStateExpression: string,
  expectedIdentity: string
): string {
  const expected = JSON.stringify(expectedIdentity);
  return `(async () => {
    let sessionState;
    try {
      sessionState = await Promise.resolve((${sessionStateExpression}));
    } catch {
      return { kind: "SESSION_UNAVAILABLE", observedIdentity: null };
    }

    const observedIdentity =
      sessionState && typeof sessionState === "object" &&
      typeof sessionState.identity === "string"
        ? sessionState.identity
        : null;
    const sessionToken =
      sessionState && typeof sessionState === "object" &&
      typeof sessionState.sessionToken === "string" &&
      sessionState.sessionToken.length > 0
        ? sessionState.sessionToken
        : null;

    if (sessionToken === null) {
      return { kind: "SESSION_UNAVAILABLE", observedIdentity };
    }

    let response;
    try {
      response = await fetch("/api/getGeneratorsByUser", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          email: ${expected},
          sessionToken
        })
      });
    } catch {
      return { kind: "TRANSPORT_UNKNOWN", observedIdentity };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      try { await response.arrayBuffer(); } catch {}
      return {
        kind: "RESPONSE",
        observedIdentity,
        httpStatus: response.status,
        contentType,
        jsonParsed: false,
        status: null,
        generators: null,
        generatorFolderMapValid: false
      };
    }

    let body;
    try {
      body = await response.json();
    } catch {
      return {
        kind: "RESPONSE",
        observedIdentity,
        httpStatus: response.status,
        contentType,
        jsonParsed: false,
        status: null,
        generators: null,
        generatorFolderMapValid: false
      };
    }

    const bodyIsObject =
      body !== null && typeof body === "object" && !Array.isArray(body);
    const folderMap =
      bodyIsObject ? body.generatorFolderMap : null;
    return {
      kind: "RESPONSE",
      observedIdentity,
      httpStatus: response.status,
      contentType,
      jsonParsed: true,
      status:
        bodyIsObject && typeof body.status === "string"
          ? body.status
          : null,
      generators:
        bodyIsObject && Array.isArray(body.generators)
          ? body.generators
          : null,
      generatorFolderMapValid:
        folderMap !== null &&
        typeof folderMap === "object" &&
        !Array.isArray(folderMap)
    };
  })()`;
}

function evidence(
  status: PerchanceSessionIdentityStatus,
  reasonCode: PerchanceProbeReasonCode,
  observedIdentity: string | null,
  generatorCount: number | null,
  observedAt: string
): PerchanceSessionIdentityEvidence {
  return Object.freeze({
    status,
    reasonCode,
    observedIdentity,
    generatorCount,
    observedAt
  });
}

function decodeOwnedGeneratorProbe(
  raw: unknown,
  expectedIdentity: string,
  observedAt: string
): OwnedGeneratorProbe {
  if (!plainObject(raw)) {
    return Object.freeze({
      session: evidence(
        "UNKNOWN",
        "PROVIDER_PROTOCOL_UNKNOWN",
        null,
        null,
        observedAt
      ),
      generators: Object.freeze([])
    });
  }

  const result = raw as ProviderPageProbeResult;
  const observedIdentity =
    result.observedIdentity === null ||
    typeof result.observedIdentity === "string"
      ? result.observedIdentity
      : null;

  if (result.kind === "SESSION_UNAVAILABLE") {
    return Object.freeze({
      session: evidence(
        "UNKNOWN",
        "SESSION_MATERIAL_UNAVAILABLE",
        observedIdentity,
        null,
        observedAt
      ),
      generators: Object.freeze([])
    });
  }
  if (result.kind === "TRANSPORT_UNKNOWN") {
    return Object.freeze({
      session: evidence(
        "UNKNOWN",
        "PROVIDER_TRANSPORT_UNKNOWN",
        observedIdentity,
        null,
        observedAt
      ),
      generators: Object.freeze([])
    });
  }
  if (result.kind !== "RESPONSE") {
    return Object.freeze({
      session: evidence(
        "UNKNOWN",
        "PROVIDER_PROTOCOL_UNKNOWN",
        observedIdentity,
        null,
        observedAt
      ),
      generators: Object.freeze([])
    });
  }

  if (
    typeof result.httpStatus !== "number" ||
    !Number.isSafeInteger(result.httpStatus) ||
    typeof result.contentType !== "string"
  ) {
    return Object.freeze({
      session: evidence(
        "UNKNOWN",
        "PROVIDER_PROTOCOL_UNKNOWN",
        observedIdentity,
        null,
        observedAt
      ),
      generators: Object.freeze([])
    });
  }

  if (
    result.httpStatus === 403 &&
    !result.contentType.toLowerCase().includes("application/json")
  ) {
    return Object.freeze({
      session: evidence(
        "UNKNOWN",
        "PROVIDER_ACCESS_BLOCKED",
        observedIdentity,
        null,
        observedAt
      ),
      generators: Object.freeze([])
    });
  }
  if (result.httpStatus < 200 || result.httpStatus > 299) {
    return Object.freeze({
      session: evidence(
        "UNKNOWN",
        "PROVIDER_HTTP_ERROR",
        observedIdentity,
        null,
        observedAt
      ),
      generators: Object.freeze([])
    });
  }
  if (
    result.jsonParsed !== true ||
    !result.contentType.toLowerCase().includes("application/json") ||
    typeof result.status !== "string"
  ) {
    return Object.freeze({
      session: evidence(
        "UNKNOWN",
        "PROVIDER_PROTOCOL_UNKNOWN",
        observedIdentity,
        null,
        observedAt
      ),
      generators: Object.freeze([])
    });
  }

  if (result.status === "session-token-error") {
    const mismatch =
      observedIdentity !== null &&
      !perchanceIdentityMatches(expectedIdentity, observedIdentity);
    return Object.freeze({
      session: evidence(
        mismatch ? "MISMATCH" : "UNKNOWN",
        mismatch
          ? "SESSION_IDENTITY_MISMATCH"
          : "SESSION_PAIRING_REJECTED",
        observedIdentity,
        null,
        observedAt
      ),
      generators: Object.freeze([])
    });
  }

  if (result.status !== "success") {
    return Object.freeze({
      session: evidence(
        "UNKNOWN",
        "PROVIDER_PROTOCOL_UNKNOWN",
        observedIdentity,
        null,
        observedAt
      ),
      generators: Object.freeze([])
    });
  }

  const generators = parseGeneratorList(result.generators);
  if (generators === null || result.generatorFolderMapValid !== true) {
    return Object.freeze({
      session: evidence(
        "UNKNOWN",
        "PROVIDER_PROTOCOL_UNKNOWN",
        observedIdentity,
        null,
        observedAt
      ),
      generators: Object.freeze([])
    });
  }

  if (observedIdentity === null) {
    return Object.freeze({
      session: evidence(
        "UNKNOWN",
        "SESSION_MATERIAL_UNAVAILABLE",
        null,
        generators.length,
        observedAt
      ),
      generators
    });
  }

  if (!perchanceIdentityMatches(expectedIdentity, observedIdentity)) {
    return Object.freeze({
      session: evidence(
        "UNKNOWN",
        "SESSION_EVIDENCE_CONFLICT",
        observedIdentity,
        generators.length,
        observedAt
      ),
      generators
    });
  }

  return Object.freeze({
    session: evidence(
      "EXPECTED",
      "SESSION_VERIFIED",
      observedIdentity,
      generators.length,
      observedAt
    ),
    generators
  });
}

export function providerEvidenceFreshness(
  observedAt: string,
  now: Date,
  staleAfterMs = DEFAULT_STALE_AFTER_MS
): ProviderEvidenceFreshness {
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new RangeError("Provider evidence stale threshold must be a positive safe integer");
  }
  const observedMs = Date.parse(observedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs)) {
    throw new TypeError("Provider evidence timestamps must be valid");
  }
  return Math.max(0, nowMs - observedMs) > staleAfterMs
    ? "STALE"
    : "CURRENT";
}

export class PerchanceProvider {
  readonly #browserProfile: PerchanceBrowserReadProfile;
  readonly #now: () => Date;

  public constructor(options: PerchanceProviderOptions) {
    validateBrowserProfile(options.browserProfile);
    this.#browserProfile = Object.freeze({
      sessionStateExpression: options.browserProfile.sessionStateExpression
    });
    this.#now = options.now ?? (() => new Date());
  }

  async #probeOwnedGenerators(
    page: BrowserPage,
    expectedIdentity: string,
    commandOptions: BrowserDriverCommandOptions
  ): Promise<OwnedGeneratorProbe> {
    validateIdentity(expectedIdentity);
    const observedAt = this.#now().toISOString();
    const raw = await page.evaluate(
      buildProbeExpression(
        this.#browserProfile.sessionStateExpression,
        expectedIdentity
      ),
      commandOptions
    );
    return decodeOwnedGeneratorProbe(raw, expectedIdentity, observedAt);
  }

  public async probeSessionIdentity(
    page: BrowserPage,
    expectedIdentity: string,
    commandOptions: BrowserDriverCommandOptions = {}
  ): Promise<PerchanceSessionIdentityEvidence> {
    const probe = await this.#probeOwnedGenerators(
      page,
      expectedIdentity,
      commandOptions
    );
    return probe.session;
  }

  public async probeGeneratorIdentity(
    page: BrowserPage,
    expectedIdentity: string,
    generator: PerchanceGeneratorExpectation,
    commandOptions: BrowserDriverCommandOptions = {}
  ): Promise<PerchanceGeneratorIdentityEvidence> {
    if (!boundedText(generator.generatorLocalId, 128)) {
      throw new TypeError("Generator local ID must be a non-empty bounded string");
    }
    if (
      generator.providerStableId !== null &&
      !boundedText(generator.providerStableId, 256)
    ) {
      throw new TypeError("Generator provider stable ID must be null or a non-empty bounded string");
    }
    if (!boundedText(generator.currentSlug, 512)) {
      throw new TypeError("Generator current slug must be a non-empty bounded string");
    }

    const probe = await this.#probeOwnedGenerators(
      page,
      expectedIdentity,
      commandOptions
    );
    const base = {
      generatorLocalId: generator.generatorLocalId,
      sessionStatus: probe.session.status,
      expectedProviderStableId: generator.providerStableId,
      expectedSlug: generator.currentSlug,
      observedAt: probe.session.observedAt
    };

    if (probe.session.status !== "EXPECTED") {
      return Object.freeze({
        ...base,
        identityStatus: "UNKNOWN",
        slugStatus: "UNKNOWN",
        observedProviderStableId: null,
        observedSlug: null,
        reasonCode: probe.session.reasonCode
      });
    }

    if (generator.providerStableId === null) {
      const slugMatches = probe.generators.filter(
        (candidate) => candidate.slug === generator.currentSlug
      );
      const candidate = slugMatches.length === 1 ? slugMatches[0] : undefined;
      return Object.freeze({
        ...base,
        identityStatus: "UNKNOWN",
        slugStatus: candidate === undefined ? "UNKNOWN" : "CURRENT",
        observedProviderStableId: candidate?.publicId ?? null,
        observedSlug: candidate?.slug ?? null,
        reasonCode:
          candidate?.publicId === null || candidate === undefined
            ? "GENERATOR_STABLE_ID_UNKNOWN"
            : "GENERATOR_STABLE_ID_UNOBSERVED"
      });
    }

    const stableMatch = probe.generators.find(
      (candidate) => candidate.publicId === generator.providerStableId
    );
    if (stableMatch !== undefined) {
      const slugStatus: PerchanceGeneratorSlugStatus =
        stableMatch.slug === generator.currentSlug ? "CURRENT" : "CHANGED";
      return Object.freeze({
        ...base,
        identityStatus: "VERIFIED",
        slugStatus,
        observedProviderStableId: stableMatch.publicId,
        observedSlug: stableMatch.slug,
        reasonCode:
          slugStatus === "CURRENT"
            ? "GENERATOR_VERIFIED"
            : "GENERATOR_SLUG_CHANGED"
      });
    }

    const slugMatches = probe.generators.filter(
      (candidate) => candidate.slug === generator.currentSlug
    );
    const sameSlug = slugMatches.length === 1 ? slugMatches[0] : undefined;
    if (sameSlug !== undefined && sameSlug.publicId !== null) {
      return Object.freeze({
        ...base,
        identityStatus: "MISMATCH",
        slugStatus: "CURRENT",
        observedProviderStableId: sameSlug.publicId,
        observedSlug: sameSlug.slug,
        reasonCode: "GENERATOR_STABLE_ID_MISMATCH"
      });
    }

    return Object.freeze({
      ...base,
      identityStatus: "MISMATCH",
      slugStatus: "UNKNOWN",
      observedProviderStableId: null,
      observedSlug: null,
      reasonCode: "GENERATOR_NOT_OWNED"
    });
  }
}
