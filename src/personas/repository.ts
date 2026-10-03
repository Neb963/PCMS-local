import type { DatabaseSync } from "node:sqlite";

export type PersonaLifecycleStatus = "ACTIVE" | "RETIRED";
export type PersonaProfileState = "CLOSED" | "OPEN";

export interface PersonaInventoryRecord {
  readonly personaUid: string;
  readonly lifecycleStatus: PersonaLifecycleStatus;
  readonly profileState: PersonaProfileState;
  readonly browserBackend: "chromium-v1";
  readonly profileRelativePath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface PersonaRepositoryOptions {
  readonly database: DatabaseSync;
}

export class PersonaRepositoryError extends Error {
  public readonly code = "PERSONA_ROW_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "PersonaRepositoryError";
  }
}

interface PersonaRow {
  readonly persona_uid: unknown;
  readonly lifecycle_status: unknown;
  readonly profile_state: unknown;
  readonly browser_backend: unknown;
  readonly profile_relative_path: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly revision: unknown;
}

function parsePersona(row: PersonaRow | undefined): PersonaInventoryRecord | null {
  if (row === undefined) {
    return null;
  }

  const {
    persona_uid: personaUid,
    lifecycle_status: lifecycleStatus,
    profile_state: profileState,
    browser_backend: browserBackend,
    profile_relative_path: profileRelativePath,
    created_at: createdAt,
    updated_at: updatedAt,
    revision
  } = row;

  if (
    typeof personaUid !== "string" ||
    (lifecycleStatus !== "ACTIVE" && lifecycleStatus !== "RETIRED") ||
    (profileState !== "CLOSED" && profileState !== "OPEN") ||
    browserBackend !== "chromium-v1" ||
    typeof profileRelativePath !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new PersonaRepositoryError("Stored Persona inventory metadata is invalid");
  }

  return Object.freeze({
    personaUid,
    lifecycleStatus,
    profileState,
    browserBackend,
    profileRelativePath,
    createdAt,
    updatedAt,
    revision
  });
}

export class PersonaRepository {
  readonly #database: DatabaseSync;

  public constructor(options: PersonaRepositoryOptions) {
    this.#database = options.database;
  }

  public get(personaUid: string): PersonaInventoryRecord | null {
    const row = this.#database.prepare(`
      SELECT
        persona_uid,
        lifecycle_status,
        profile_state,
        browser_backend,
        profile_relative_path,
        created_at,
        updated_at,
        revision
      FROM personas
      WHERE persona_uid = ?
    `).get(personaUid) as unknown as PersonaRow | undefined;

    return parsePersona(row);
  }

  public list(): readonly PersonaInventoryRecord[] {
    const rows = this.#database.prepare(`
      SELECT
        persona_uid,
        lifecycle_status,
        profile_state,
        browser_backend,
        profile_relative_path,
        created_at,
        updated_at,
        revision
      FROM personas
      ORDER BY persona_uid
    `).all() as unknown as PersonaRow[];

    return Object.freeze(rows.map((row) => {
      const parsed = parsePersona(row);
      if (parsed === null) {
        throw new PersonaRepositoryError(
          "Stored Persona inventory metadata unexpectedly disappeared"
        );
      }
      return parsed;
    }));
  }
}
