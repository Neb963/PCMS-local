export type ExplorerAvailabilityCompatibility =
  | "VERIFIED"
  | "UNKNOWN";

export type ExplorerAvailabilityState =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "UNKNOWN";

export interface ExplorerAvailabilityEvidence {
  readonly compatibility: ExplorerAvailabilityCompatibility;
  readonly slug: string | null;
  readonly available: boolean | null;
  readonly observedAt: string;
}

export interface ExplorerAvailabilityRecord {
  readonly candidateId: string;
  readonly slug: string;
  readonly availability: ExplorerAvailabilityState;
  readonly ownership: "UNVERIFIED";
  readonly compatibility: ExplorerAvailabilityCompatibility;
  readonly observedAt: string;
}

export interface ExplorerAvailabilityRemote {
  readAvailability(slug: string): Promise<unknown>;
}

export interface ExplorerObservationInput {
  readonly candidateId: string;
  readonly slug: string;
  readonly remote: ExplorerAvailabilityRemote;
}

export interface ExplorerObservationSnapshot {
  readonly version: 1;
  readonly candidates: Readonly<
    Record<string, readonly ExplorerAvailabilityRecord[]>
  >;
}

const SAFE_CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_SLUG_LENGTH = 512;
const MAX_HISTORY_PER_CANDIDATE = 64;

function isPlainObject(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function normalizedObservedAt(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("Explorer observedAt must be a valid timestamp");
  }
  return new Date(milliseconds).toISOString();
}

function normalizeCandidateId(candidateId: string): string {
  if (!SAFE_CANDIDATE_ID.test(candidateId)) {
    throw new TypeError(
      "Explorer candidateId must be a safe opaque identifier"
    );
  }
  return candidateId;
}

function normalizeSlug(slug: string): string {
  const normalized = slug.trim();
  if (
    normalized.length < 1 ||
    normalized.length > MAX_SLUG_LENGTH
  ) {
    throw new TypeError(
      `Explorer candidate slug must contain 1-${MAX_SLUG_LENGTH} characters`
    );
  }
  return normalized;
}

export function decodeExplorerAvailabilityContract(
  raw: unknown,
  observedAt: string
): ExplorerAvailabilityEvidence {
  const normalizedTime = normalizedObservedAt(observedAt);
  if (
    !isPlainObject(raw) ||
    raw["contractVersion"] !== 1 ||
    raw["semantic"] !== "EXPLORER_AVAILABILITY" ||
    typeof raw["slug"] !== "string" ||
    raw["slug"].length < 1 ||
    raw["slug"].length > MAX_SLUG_LENGTH ||
    typeof raw["available"] !== "boolean"
  ) {
    return Object.freeze({
      compatibility: "UNKNOWN",
      slug: null,
      available: null,
      observedAt: normalizedTime
    });
  }

  return Object.freeze({
    compatibility: "VERIFIED",
    slug: raw["slug"],
    available: raw["available"],
    observedAt: normalizedTime
  });
}

export class ExplorerObservationLedger {
  readonly #records = new Map<
    string,
    ExplorerAvailabilityRecord[]
  >();

  public append(
    record: ExplorerAvailabilityRecord
  ): ExplorerAvailabilityRecord {
    const current = this.#records.get(record.candidateId) ?? [];
    const next = [...current, Object.freeze({ ...record })];
    if (next.length > MAX_HISTORY_PER_CANDIDATE) {
      next.splice(0, next.length - MAX_HISTORY_PER_CANDIDATE);
    }
    this.#records.set(record.candidateId, next);
    return next[next.length - 1] as ExplorerAvailabilityRecord;
  }

  public list(
    candidateId: string
  ): readonly ExplorerAvailabilityRecord[] {
    normalizeCandidateId(candidateId);
    return Object.freeze([
      ...(this.#records.get(candidateId) ?? [])
    ]);
  }

  public snapshot(): ExplorerObservationSnapshot {
    const candidates: Record<
      string,
      readonly ExplorerAvailabilityRecord[]
    > = {};
    for (
      const [candidateId, records]
      of [...this.#records.entries()].sort(([left], [right]) =>
        left.localeCompare(right, "en")
      )
    ) {
      candidates[candidateId] = Object.freeze(
        records.map((record) => Object.freeze({ ...record }))
      );
    }
    return Object.freeze({
      version: 1,
      candidates: Object.freeze(candidates)
    });
  }
}

export class ExplorerObservationService {
  readonly #history: ExplorerObservationLedger;
  readonly #now: () => Date;

  public constructor(options: Readonly<{
    history: ExplorerObservationLedger;
    now?: () => Date;
  }>) {
    this.#history = options.history;
    this.#now = options.now ?? (() => new Date());
  }

  public async observe(
    input: ExplorerObservationInput
  ): Promise<ExplorerAvailabilityRecord> {
    const candidateId = normalizeCandidateId(input.candidateId);
    const slug = normalizeSlug(input.slug);

    let evidence: ExplorerAvailabilityEvidence;
    const observedAt = this.#now().toISOString();
    try {
      evidence = decodeExplorerAvailabilityContract(
        await input.remote.readAvailability(slug),
        observedAt
      );
    } catch {
      evidence = Object.freeze({
        compatibility: "UNKNOWN",
        slug: null,
        available: null,
        observedAt
      });
    }

    const availability: ExplorerAvailabilityState =
      evidence.compatibility === "VERIFIED" &&
      evidence.slug === slug
        ? evidence.available === true
          ? "AVAILABLE"
          : "UNAVAILABLE"
        : "UNKNOWN";

    return this.#history.append(Object.freeze({
      candidateId,
      slug,
      availability,
      ownership: "UNVERIFIED",
      compatibility: evidence.compatibility,
      observedAt: evidence.observedAt
    }));
  }
}
