import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const PROFILE_MARKER = ".pcms-persona-profile.json";
const BACKEND = "chromium-v1" as const;
const SAFE_PERSONA_UID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export type PersonaLifecycleStatus = "ACTIVE" | "RETIRED";
export type PersonaProfileState = "CLOSED" | "OPEN";
export type PersonaProfileBackupDecision = "BACKED_UP" | "SKIPPED";

export interface PersonaProfileRecord {
  readonly personaUid: string;
  readonly lifecycleStatus: PersonaLifecycleStatus;
  readonly profileState: PersonaProfileState;
  readonly browserBackend: typeof BACKEND;
  readonly profileRelativePath: string;
  readonly profileDeletedAt: string | null;
  readonly profileBackupDecision: PersonaProfileBackupDecision | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retiredAt: string | null;
  readonly revision: number;
}

export interface AllocatedPersonaProfile {
  readonly record: PersonaProfileRecord;
  readonly profilePath: string;
}

export interface PersonaProfileLifecycleOptions {
  readonly database: DatabaseSync;
  readonly personasRoot: string;
  readonly now?: () => Date;
}

export type PersonaProfileErrorCode =
  | "PERSONA_UID_INVALID"
  | "PERSONA_NOT_FOUND"
  | "PERSONA_PROFILE_PATH_MISMATCH"
  | "PERSONA_PROFILE_UNSAFE"
  | "PERSONA_PROFILE_INCOMPATIBLE"
  | "PERSONA_PROFILE_DELETED"
  | "PERSONA_RETIRED";

export class PersonaProfileError extends Error {
  public constructor(
    public readonly code: PersonaProfileErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PersonaProfileError";
  }
}

interface PersonaRow {
  readonly persona_uid: unknown;
  readonly lifecycle_status: unknown;
  readonly profile_state: unknown;
  readonly browser_backend: unknown;
  readonly profile_relative_path: unknown;
  readonly profile_deleted_at: unknown;
  readonly profile_backup_decision: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly retired_at: unknown;
  readonly revision: unknown;
}

function sqliteErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (sqliteErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertPersonaUid(personaUid: string): void {
  if (!SAFE_PERSONA_UID.test(personaUid)) {
    throw new PersonaProfileError(
      "PERSONA_UID_INVALID",
      "Persona UID must be a safe opaque identifier using only letters, digits, underscore or hyphen"
    );
  }
}

function expectedRelativePath(personaUid: string): string {
  return `personas/${personaUid}/chromium`;
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function parseRecord(row: PersonaRow | undefined): PersonaProfileRecord | null {
  if (row === undefined) {
    return null;
  }

  const {
    persona_uid: personaUid,
    lifecycle_status: lifecycleStatus,
    profile_state: profileState,
    browser_backend: browserBackend,
    profile_relative_path: profileRelativePath,
    profile_deleted_at: profileDeletedAt,
    profile_backup_decision: profileBackupDecision,
    created_at: createdAt,
    updated_at: updatedAt,
    retired_at: retiredAt,
    revision
  } = row;

  if (
    typeof personaUid !== "string" ||
    (lifecycleStatus !== "ACTIVE" && lifecycleStatus !== "RETIRED") ||
    (profileState !== "CLOSED" && profileState !== "OPEN") ||
    browserBackend !== BACKEND ||
    typeof profileRelativePath !== "string" ||
    (profileDeletedAt !== null && typeof profileDeletedAt !== "string") ||
    (profileBackupDecision !== null &&
      profileBackupDecision !== "BACKED_UP" &&
      profileBackupDecision !== "SKIPPED") ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string" ||
    (retiredAt !== null && typeof retiredAt !== "string") ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision)
  ) {
    throw new PersonaProfileError(
      "PERSONA_PROFILE_INCOMPATIBLE",
      "Persona profile metadata in SQLite is invalid"
    );
  }

  return Object.freeze({
    personaUid,
    lifecycleStatus,
    profileState,
    browserBackend,
    profileRelativePath,
    profileDeletedAt,
    profileBackupDecision,
    createdAt,
    updatedAt,
    retiredAt,
    revision
  });
}

async function writeMarker(markerPath: string, personaUid: string): Promise<void> {
  const payload = JSON.stringify(
    {
      format: 1,
      personaUid,
      backend: BACKEND
    },
    null,
    2
  ) + "\n";

  try {
    const handle = await open(markerPath, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (sqliteErrorCode(error) !== "EEXIST") {
      throw error;
    }
  }
}

async function validateMarker(markerPath: string, personaUid: string): Promise<void> {
  const markerInfo = await lstatOrNull(markerPath);
  if (markerInfo === null || !markerInfo.isFile() || markerInfo.isSymbolicLink()) {
    throw new PersonaProfileError(
      "PERSONA_PROFILE_INCOMPATIBLE",
      "Persona profile ownership marker is missing or unsafe"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error: unknown) {
    throw new PersonaProfileError(
      "PERSONA_PROFILE_INCOMPATIBLE",
      "Persona profile ownership marker is not valid JSON",
      error
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("format" in parsed) ||
    parsed.format !== 1 ||
    !("personaUid" in parsed) ||
    parsed.personaUid !== personaUid ||
    !("backend" in parsed) ||
    parsed.backend !== BACKEND
  ) {
    throw new PersonaProfileError(
      "PERSONA_PROFILE_INCOMPATIBLE",
      "Persona profile ownership marker does not match the requested Persona"
    );
  }
}

export class PersonaProfileLifecycle {
  readonly #database: DatabaseSync;
  readonly #personasRoot: string;
  readonly #now: () => Date;

  public constructor(options: PersonaProfileLifecycleOptions) {
    if (!isAbsolute(options.personasRoot)) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_UNSAFE",
        "Persona root must be an absolute path"
      );
    }
    this.#database = options.database;
    this.#personasRoot = options.personasRoot;
    this.#now = options.now ?? (() => new Date());
  }

  public get(personaUid: string): PersonaProfileRecord | null {
    assertPersonaUid(personaUid);
    return parseRecord(
      this.#database.prepare(`
        SELECT
          persona_uid,
          lifecycle_status,
          profile_state,
          browser_backend,
          profile_relative_path,
          profile_deleted_at,
          profile_backup_decision,
          created_at,
          updated_at,
          retired_at,
          revision
        FROM personas
        WHERE persona_uid = ?
      `).get(personaUid) as PersonaRow | undefined
    );
  }

  async #ensureCompatibleProfileRoot(personaUid: string): Promise<string> {
    await mkdir(this.#personasRoot, { recursive: true, mode: 0o700 });
    await chmod(this.#personasRoot, 0o700);

    const rootInfo = await lstat(this.#personasRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_UNSAFE",
        "Configured Persona root is not a safe directory"
      );
    }

    const canonicalRoot = await realpath(this.#personasRoot);
    const personaDir = join(this.#personasRoot, personaUid);
    const existingPersona = await lstatOrNull(personaDir);

    if (existingPersona === null) {
      await mkdir(personaDir, { mode: 0o700 });
    } else if (!existingPersona.isDirectory() || existingPersona.isSymbolicLink()) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_UNSAFE",
        "Persona directory is not a safe owned directory"
      );
    }

    await chmod(personaDir, 0o700);
    const canonicalPersona = await realpath(personaDir);
    if (!isStrictDescendant(canonicalRoot, canonicalPersona)) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_UNSAFE",
        "Persona directory escapes the configured Persona root"
      );
    }

    const profilePath = join(personaDir, "chromium");
    const existingProfile = await lstatOrNull(profilePath);
    if (existingProfile === null) {
      const personaEntries = await readdir(personaDir);
      if (personaEntries.length !== 0) {
        throw new PersonaProfileError(
          "PERSONA_PROFILE_INCOMPATIBLE",
          "Refusing to create a profile inside a nonempty unowned Persona directory"
        );
      }
      await mkdir(profilePath, { mode: 0o700 });
    } else if (!existingProfile.isDirectory() || existingProfile.isSymbolicLink()) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_UNSAFE",
        "Persona Chromium profile path is not a safe directory"
      );
    }

    await chmod(profilePath, 0o700);
    const canonicalProfile = await realpath(profilePath);
    if (!isStrictDescendant(canonicalRoot, canonicalProfile)) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_UNSAFE",
        "Persona Chromium profile escapes the configured Persona root"
      );
    }

    const markerPath = join(profilePath, PROFILE_MARKER);
    const markerInfo = await lstatOrNull(markerPath);
    if (markerInfo === null) {
      const profileEntries = await readdir(profilePath);
      if (profileEntries.length !== 0) {
        throw new PersonaProfileError(
          "PERSONA_PROFILE_INCOMPATIBLE",
          "Refusing to adopt a nonempty Chromium profile without a PCMS ownership marker"
        );
      }
      await writeMarker(markerPath, personaUid);
    }
    await validateMarker(markerPath, personaUid);
    return canonicalProfile;
  }

  public async allocate(personaUid: string): Promise<AllocatedPersonaProfile> {
    assertPersonaUid(personaUid);
    const expectedPath = expectedRelativePath(personaUid);
    const existing = this.get(personaUid);

    if (existing !== null) {
      if (existing.profileRelativePath !== expectedPath) {
        throw new PersonaProfileError(
          "PERSONA_PROFILE_PATH_MISMATCH",
          "Stored Persona profile path does not match its durable Persona UID"
        );
      }
      if (existing.profileDeletedAt !== null) {
        throw new PersonaProfileError(
          "PERSONA_PROFILE_DELETED",
          "Persona profile was explicitly deleted and will not be auto-recreated"
        );
      }
      if (existing.lifecycleStatus === "RETIRED") {
        throw new PersonaProfileError(
          "PERSONA_RETIRED",
          "Retired Persona profiles cannot be allocated for use"
        );
      }
      return Object.freeze({
        record: existing,
        profilePath: await this.#ensureCompatibleProfileRoot(personaUid)
      });
    }

    const profilePath = await this.#ensureCompatibleProfileRoot(personaUid);
    const now = this.#now().toISOString();
    this.#database.prepare(`
      INSERT INTO personas (
        persona_uid,
        lifecycle_status,
        profile_state,
        browser_backend,
        profile_relative_path,
        profile_deleted_at,
        profile_backup_decision,
        created_at,
        updated_at,
        retired_at,
        revision
      ) VALUES (?, 'ACTIVE', 'CLOSED', ?, ?, NULL, NULL, ?, ?, NULL, 0)
      ON CONFLICT(persona_uid) DO NOTHING
    `).run(personaUid, BACKEND, expectedPath, now, now);

    const record = this.get(personaUid);
    if (record === null) {
      throw new PersonaProfileError(
        "PERSONA_NOT_FOUND",
        "Persona metadata could not be created"
      );
    }
    if (record.profileRelativePath !== expectedPath) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_PATH_MISMATCH",
        "Stored Persona profile path does not match its durable Persona UID"
      );
    }

    return Object.freeze({ record, profilePath });
  }
}
