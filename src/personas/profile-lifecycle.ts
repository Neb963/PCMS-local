import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const PROFILE_MARKER = ".pcms-persona-profile.json";
const BACKEND = "chromium-v1" as const;
const SAFE_PERSONA_UID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export type PersonaLifecycleStatus = "ACTIVE" | "RETIRED";
export type PersonaProfileState = "CLOSED" | "OPEN";
export type PersonaProfileDeleteState = "PRESENT" | "DELETE_STAGED" | "DELETED";
export type PersonaProfileBackupDecision = "BACKED_UP" | "SKIPPED";

export interface PersonaProfileRecord {
  readonly personaUid: string;
  readonly lifecycleStatus: PersonaLifecycleStatus;
  readonly profileState: PersonaProfileState;
  readonly browserBackend: typeof BACKEND;
  readonly profileRelativePath: string;
  readonly profileDeleteState: PersonaProfileDeleteState;
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

export interface PersonaProfileDeleteOptions {
  readonly confirmed: boolean;
  readonly browserClosed: boolean;
  readonly unresolvedOperations: number;
  readonly unresolvedHumanTasks: number;
  readonly backupDecision?: PersonaProfileBackupDecision;
}

export type PersonaProfileErrorCode =
  | "PERSONA_UID_INVALID"
  | "PERSONA_NOT_FOUND"
  | "PERSONA_PROFILE_PATH_MISMATCH"
  | "PERSONA_PROFILE_UNSAFE"
  | "PERSONA_PROFILE_INCOMPATIBLE"
  | "PERSONA_PROFILE_DELETED"
  | "PERSONA_PROFILE_DELETE_STAGED"
  | "PERSONA_RETIRED"
  | "PERSONA_PROFILE_OPEN"
  | "PERSONA_NOT_RETIRED"
  | "PERSONA_DELETE_CONFIRMATION_REQUIRED"
  | "PERSONA_DELETE_BROWSER_NOT_CLOSED"
  | "PERSONA_DELETE_UNRESOLVED_EVIDENCE"
  | "PERSONA_DELETE_BACKUP_DECISION_REQUIRED"
  | "PERSONA_DELETE_BACKUP_DECISION_MISMATCH";

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
  readonly profile_delete_state: unknown;
  readonly profile_deleted_at: unknown;
  readonly profile_backup_decision: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly retired_at: unknown;
  readonly revision: unknown;
}

function systemErrorCode(error: unknown): string | undefined {
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
    if (systemErrorCode(error) === "ENOENT") {
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
    profile_delete_state: profileDeleteState,
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
    (profileDeleteState !== "PRESENT" &&
      profileDeleteState !== "DELETE_STAGED" &&
      profileDeleteState !== "DELETED") ||
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
    profileDeleteState,
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
    if (systemErrorCode(error) !== "EEXIST") {
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
          profile_delete_state,
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

  #requireRecord(personaUid: string): PersonaProfileRecord {
    const record = this.get(personaUid);
    if (record === null) {
      throw new PersonaProfileError(
        "PERSONA_NOT_FOUND",
        `Persona ${personaUid} does not exist`
      );
    }
    return record;
  }

  async #validateExistingProfileRoot(personaUid: string): Promise<string> {
    const rootInfo = await lstatOrNull(this.#personasRoot);
    if (rootInfo === null || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_INCOMPATIBLE",
        "Configured Persona root is missing or unsafe"
      );
    }

    const canonicalRoot = await realpath(this.#personasRoot);
    const personaDir = join(this.#personasRoot, personaUid);
    const personaInfo = await lstatOrNull(personaDir);
    if (personaInfo === null || !personaInfo.isDirectory() || personaInfo.isSymbolicLink()) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_INCOMPATIBLE",
        "Owned Persona directory is missing or unsafe"
      );
    }

    const canonicalPersona = await realpath(personaDir);
    if (!isStrictDescendant(canonicalRoot, canonicalPersona)) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_UNSAFE",
        "Persona directory escapes the configured Persona root"
      );
    }

    const profilePath = join(personaDir, "chromium");
    const profileInfo = await lstatOrNull(profilePath);
    if (profileInfo === null || !profileInfo.isDirectory() || profileInfo.isSymbolicLink()) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_INCOMPATIBLE",
        "Owned Persona Chromium profile is missing or unsafe"
      );
    }

    const canonicalProfile = await realpath(profilePath);
    if (!isStrictDescendant(canonicalRoot, canonicalProfile)) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_UNSAFE",
        "Persona Chromium profile escapes the configured Persona root"
      );
    }

    await validateMarker(join(profilePath, PROFILE_MARKER), personaUid);
    return canonicalProfile;
  }

  public listOpen(): readonly PersonaProfileRecord[] {
    const rows = this.#database.prepare(`
      SELECT
        persona_uid,
        lifecycle_status,
        profile_state,
        browser_backend,
        profile_relative_path,
        profile_delete_state,
        profile_deleted_at,
        profile_backup_decision,
        created_at,
        updated_at,
        retired_at,
        revision
      FROM personas
      WHERE profile_state = 'OPEN'
      ORDER BY persona_uid
    `).all() as unknown as PersonaRow[];

    return Object.freeze(
      rows.map((row) => {
        const record = parseRecord(row);
        if (record === null) {
          throw new PersonaProfileError(
            "PERSONA_PROFILE_INCOMPATIBLE",
            "Open Persona profile row unexpectedly disappeared"
          );
        }
        return record;
      })
    );
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
      if (existing.profileDeleteState !== "PRESENT") {
        throw new PersonaProfileError(
          existing.profileDeleteState === "DELETED"
            ? "PERSONA_PROFILE_DELETED"
            : "PERSONA_PROFILE_DELETE_STAGED",
          existing.profileDeleteState === "DELETED"
            ? "Persona profile was explicitly deleted and will not be auto-recreated"
            : "Persona profile deletion is staged and must be reconciled before reuse"
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
        profilePath: await this.#validateExistingProfileRoot(personaUid)
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
        profile_delete_state,
        profile_deleted_at,
        profile_backup_decision,
        created_at,
        updated_at,
        retired_at,
        revision
      ) VALUES (?, 'ACTIVE', 'CLOSED', ?, ?, 'PRESENT', NULL, NULL, ?, ?, NULL, 0)
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

  public async open(personaUid: string): Promise<AllocatedPersonaProfile> {
    const allocated = await this.allocate(personaUid);
    if (allocated.record.profileState === "OPEN") {
      return allocated;
    }

    const now = this.#now().toISOString();
    this.#database.prepare(`
      UPDATE personas
      SET
        profile_state = 'OPEN',
        updated_at = ?,
        revision = revision + 1
      WHERE
        persona_uid = ? AND
        lifecycle_status = 'ACTIVE' AND
        profile_deleted_at IS NULL AND
        profile_state = 'CLOSED'
    `).run(now, personaUid);

    const record = this.#requireRecord(personaUid);
    if (
      record.lifecycleStatus !== "ACTIVE" ||
      record.profileDeleteState !== "PRESENT"
    ) {
      throw new PersonaProfileError(
        record.profileDeleteState !== "PRESENT" ? "PERSONA_PROFILE_DELETED" : "PERSONA_RETIRED",
        "Persona became unavailable while opening its persistent profile"
      );
    }
    if (record.profileState !== "OPEN") {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_INCOMPATIBLE",
        "Persona profile did not enter OPEN state"
      );
    }

    return Object.freeze({
      record,
      profilePath: allocated.profilePath
    });
  }

  public close(personaUid: string): PersonaProfileRecord {
    const current = this.#requireRecord(personaUid);
    if (current.profileState === "CLOSED") {
      return current;
    }

    const now = this.#now().toISOString();
    this.#database.prepare(`
      UPDATE personas
      SET
        profile_state = 'CLOSED',
        updated_at = ?,
        revision = revision + 1
      WHERE persona_uid = ? AND profile_state = 'OPEN'
    `).run(now, personaUid);

    const record = this.#requireRecord(personaUid);
    if (record.profileState !== "CLOSED") {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_INCOMPATIBLE",
        "Persona profile did not enter CLOSED state"
      );
    }
    return record;
  }

  public retire(personaUid: string): PersonaProfileRecord {
    const current = this.#requireRecord(personaUid);
    if (current.lifecycleStatus === "RETIRED") {
      return current;
    }
    if (current.profileState !== "CLOSED") {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_OPEN",
        "Persona must be closed before retirement"
      );
    }

    const now = this.#now().toISOString();
    this.#database.prepare(`
      UPDATE personas
      SET
        lifecycle_status = 'RETIRED',
        retired_at = ?,
        updated_at = ?,
        revision = revision + 1
      WHERE
        persona_uid = ? AND
        lifecycle_status = 'ACTIVE' AND
        profile_state = 'CLOSED'
    `).run(now, now, personaUid);

    const record = this.#requireRecord(personaUid);
    if (record.lifecycleStatus !== "RETIRED") {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_INCOMPATIBLE",
        "Persona did not enter RETIRED state"
      );
    }
    return record;
  }

  public async deleteProfile(
    personaUid: string,
    options: PersonaProfileDeleteOptions
  ): Promise<PersonaProfileRecord> {
    assertPersonaUid(personaUid);

    if (!options.confirmed) {
      throw new PersonaProfileError(
        "PERSONA_DELETE_CONFIRMATION_REQUIRED",
        "Destructive Persona profile deletion requires explicit confirmation"
      );
    }
    if (!options.browserClosed) {
      throw new PersonaProfileError(
        "PERSONA_DELETE_BROWSER_NOT_CLOSED",
        "Persona browser must be confirmed closed before deleting its profile"
      );
    }
    if (
      !Number.isSafeInteger(options.unresolvedOperations) ||
      options.unresolvedOperations < 0 ||
      !Number.isSafeInteger(options.unresolvedHumanTasks) ||
      options.unresolvedHumanTasks < 0
    ) {
      throw new RangeError("Unresolved evidence counts must be non-negative integers");
    }
    if (
      options.unresolvedOperations !== 0 ||
      options.unresolvedHumanTasks !== 0
    ) {
      throw new PersonaProfileError(
        "PERSONA_DELETE_UNRESOLVED_EVIDENCE",
        "Persona profile deletion is blocked by unresolved operation or HumanTask evidence"
      );
    }
    if (options.backupDecision === undefined) {
      throw new PersonaProfileError(
        "PERSONA_DELETE_BACKUP_DECISION_REQUIRED",
        "Persona profile deletion requires an explicit backup decision"
      );
    }

    const current = this.#requireRecord(personaUid);
    if (current.lifecycleStatus !== "RETIRED") {
      throw new PersonaProfileError(
        "PERSONA_NOT_RETIRED",
        "Persona must be retired before destructive profile deletion"
      );
    }
    if (current.profileState !== "CLOSED") {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_OPEN",
        "Persona profile must be closed before deletion"
      );
    }
    if (current.profileRelativePath !== expectedRelativePath(personaUid)) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_PATH_MISMATCH",
        "Stored Persona profile path does not match its durable Persona UID"
      );
    }
    if (current.profileDeleteState === "DELETED") {
      return current;
    }

    let staged = current;
    if (current.profileDeleteState === "PRESENT") {
      await this.#validateExistingProfileRoot(personaUid);
      const stagedAt = this.#now().toISOString();
      this.#database.prepare(`
        UPDATE personas
        SET
          profile_delete_state = 'DELETE_STAGED',
          profile_backup_decision = ?,
          updated_at = ?,
          revision = revision + 1
        WHERE
          persona_uid = ? AND
          lifecycle_status = 'RETIRED' AND
          profile_state = 'CLOSED' AND
          profile_delete_state = 'PRESENT'
      `).run(options.backupDecision, stagedAt, personaUid);
      staged = this.#requireRecord(personaUid);
    }

    if (staged.profileDeleteState !== "DELETE_STAGED") {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_INCOMPATIBLE",
        "Persona profile deletion is not in a recoverable staged state"
      );
    }
    if (staged.profileBackupDecision !== options.backupDecision) {
      throw new PersonaProfileError(
        "PERSONA_DELETE_BACKUP_DECISION_MISMATCH",
        "Persona profile deletion was already staged with a different backup decision"
      );
    }

    const expectedProfilePath = join(this.#personasRoot, personaUid, "chromium");
    const profileInfo = await lstatOrNull(expectedProfilePath);
    if (profileInfo !== null) {
      const profilePath = await this.#validateExistingProfileRoot(personaUid);
      await rm(profilePath, { recursive: true, force: false });
    }

    const deletedAt = this.#now().toISOString();
    this.#database.prepare(`
      UPDATE personas
      SET
        profile_delete_state = 'DELETED',
        profile_deleted_at = ?,
        updated_at = ?,
        revision = revision + 1
      WHERE
        persona_uid = ? AND
        lifecycle_status = 'RETIRED' AND
        profile_state = 'CLOSED' AND
        profile_delete_state = 'DELETE_STAGED'
    `).run(deletedAt, deletedAt, personaUid);

    const record = this.#requireRecord(personaUid);
    if (
      record.profileDeleteState !== "DELETED" ||
      record.profileDeletedAt === null
    ) {
      throw new PersonaProfileError(
        "PERSONA_PROFILE_INCOMPATIBLE",
        "Persona profile deletion did not reach durable DELETED state"
      );
    }
    return record;
  }
}
