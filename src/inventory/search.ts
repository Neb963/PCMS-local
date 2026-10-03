import type { DatabaseSync } from "node:sqlite";

const MAX_QUERY_LENGTH = 256;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export type InventorySearchEntityType = "ACCOUNT" | "PERSONA" | "GENERATOR";
export type InventorySearchMatchedField =
  | "accountId"
  | "displayName"
  | "personaUid"
  | "generatorLocalId"
  | "providerStableId"
  | "currentSlug";

export interface InventorySearchResult {
  readonly entityType: InventorySearchEntityType;
  readonly entityId: string;
  readonly label: string;
  readonly matchedField: InventorySearchMatchedField;
  readonly accountId: string | null;
  readonly personaUid: string | null;
}

export interface InventorySearchOptions {
  readonly database: DatabaseSync;
}

export interface InventorySearchQueryOptions {
  readonly limit?: number;
}

export class InventorySearchError extends Error {
  public readonly code:
    | "SEARCH_QUERY_INVALID"
    | "SEARCH_LIMIT_INVALID"
    | "SEARCH_ROW_INVALID";

  public constructor(
    code:
      | "SEARCH_QUERY_INVALID"
      | "SEARCH_LIMIT_INVALID"
      | "SEARCH_ROW_INVALID",
    message: string
  ) {
    super(message);
    this.name = "InventorySearchError";
    this.code = code;
  }
}

interface SearchRow {
  readonly entity_type: unknown;
  readonly entity_id: unknown;
  readonly label: unknown;
  readonly matched_field: unknown;
  readonly account_id: unknown;
  readonly persona_uid: unknown;
  readonly exact_identity_match: unknown;
}

function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (normalized.length === 0 || normalized.length > MAX_QUERY_LENGTH) {
    throw new InventorySearchError(
      "SEARCH_QUERY_INVALID",
      `Search query must contain 1-${MAX_QUERY_LENGTH} characters`
    );
  }
  return normalized;
}

function normalizeLimit(limit: number | undefined): number {
  const normalized = limit ?? DEFAULT_LIMIT;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_LIMIT
  ) {
    throw new InventorySearchError(
      "SEARCH_LIMIT_INVALID",
      `Search limit must be an integer between 1 and ${MAX_LIMIT}`
    );
  }
  return normalized;
}

function parseResult(row: SearchRow): InventorySearchResult & {
  readonly exactIdentityMatch: number;
} {
  const {
    entity_type: entityType,
    entity_id: entityId,
    label,
    matched_field: matchedField,
    account_id: accountId,
    persona_uid: personaUid,
    exact_identity_match: exactIdentityMatch
  } = row;

  if (
    (entityType !== "ACCOUNT" &&
      entityType !== "PERSONA" &&
      entityType !== "GENERATOR") ||
    typeof entityId !== "string" ||
    typeof label !== "string" ||
    (matchedField !== "accountId" &&
      matchedField !== "displayName" &&
      matchedField !== "personaUid" &&
      matchedField !== "generatorLocalId" &&
      matchedField !== "providerStableId" &&
      matchedField !== "currentSlug") ||
    (accountId !== null && typeof accountId !== "string") ||
    (personaUid !== null && typeof personaUid !== "string") ||
    (exactIdentityMatch !== 0 && exactIdentityMatch !== 1)
  ) {
    throw new InventorySearchError(
      "SEARCH_ROW_INVALID",
      "Stored inventory search metadata is invalid"
    );
  }

  return Object.freeze({
    entityType,
    entityId,
    label,
    matchedField,
    accountId,
    personaUid,
    exactIdentityMatch
  });
}

export class InventorySearchService {
  readonly #database: DatabaseSync;

  public constructor(options: InventorySearchOptions) {
    this.#database = options.database;
  }

  public search(
    query: string,
    options: InventorySearchQueryOptions = {}
  ): readonly InventorySearchResult[] {
    const normalized = normalizeQuery(query);
    const limit = normalizeLimit(options.limit);
    const rows = this.#database.prepare(`
      WITH matches AS (
        SELECT
          'ACCOUNT' AS entity_type,
          a.account_id AS entity_id,
          a.display_name AS label,
          CASE
            WHEN instr(lower(a.account_id), lower(?)) > 0 THEN 'accountId'
            ELSE 'displayName'
          END AS matched_field,
          a.account_id AS account_id,
          a.persona_uid AS persona_uid,
          CASE WHEN lower(a.account_id) = lower(?) THEN 1 ELSE 0 END
            AS exact_identity_match
        FROM accounts AS a
        WHERE
          instr(lower(a.account_id), lower(?)) > 0 OR
          instr(lower(a.display_name), lower(?)) > 0

        UNION ALL

        SELECT
          'PERSONA' AS entity_type,
          p.persona_uid AS entity_id,
          p.persona_uid AS label,
          'personaUid' AS matched_field,
          a.account_id AS account_id,
          p.persona_uid AS persona_uid,
          CASE WHEN lower(p.persona_uid) = lower(?) THEN 1 ELSE 0 END
            AS exact_identity_match
        FROM personas AS p
        LEFT JOIN accounts AS a ON a.persona_uid = p.persona_uid
        WHERE instr(lower(p.persona_uid), lower(?)) > 0

        UNION ALL

        SELECT
          'GENERATOR' AS entity_type,
          g.generator_local_id AS entity_id,
          g.current_slug AS label,
          CASE
            WHEN instr(lower(g.generator_local_id), lower(?)) > 0
              THEN 'generatorLocalId'
            WHEN
              g.provider_stable_id IS NOT NULL AND
              instr(lower(g.provider_stable_id), lower(?)) > 0
              THEN 'providerStableId'
            ELSE 'currentSlug'
          END AS matched_field,
          g.account_id AS account_id,
          a.persona_uid AS persona_uid,
          CASE WHEN lower(g.generator_local_id) = lower(?) THEN 1 ELSE 0 END
            AS exact_identity_match
        FROM generators AS g
        LEFT JOIN accounts AS a ON a.account_id = g.account_id
        WHERE
          instr(lower(g.generator_local_id), lower(?)) > 0 OR
          (
            g.provider_stable_id IS NOT NULL AND
            instr(lower(g.provider_stable_id), lower(?)) > 0
          ) OR
          instr(lower(g.current_slug), lower(?)) > 0
      )
      SELECT
        entity_type,
        entity_id,
        label,
        matched_field,
        account_id,
        persona_uid,
        exact_identity_match
      FROM matches
      ORDER BY
        exact_identity_match DESC,
        CASE entity_type
          WHEN 'ACCOUNT' THEN 0
          WHEN 'PERSONA' THEN 1
          ELSE 2
        END,
        entity_id
      LIMIT ?
    `).all(
      normalized,
      normalized,
      normalized,
      normalized,
      normalized,
      normalized,
      normalized,
      normalized,
      normalized,
      normalized,
      normalized,
      normalized,
      limit
    ) as unknown as SearchRow[];

    return Object.freeze(
      rows.map((row) => {
        const parsed = parseResult(row);
        return Object.freeze({
          entityType: parsed.entityType,
          entityId: parsed.entityId,
          label: parsed.label,
          matchedField: parsed.matchedField,
          accountId: parsed.accountId,
          personaUid: parsed.personaUid
        });
      })
    );
  }
}
