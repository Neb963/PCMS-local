import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  validateCoreStateBackup,
  type CoreBackupManifest
} from "./core-backup.js";
import {
  checkPersonaProfileCompatibility,
  restorePersonaProfileBackup,
  validatePersonaProfileBackup,
  type ProfileBackupManifest,
  type RestorePersonaProfileBackupResult
} from "./profile-backup.js";
import {
  enterRecoveryHold,
  readRecoveryControl
} from "../recovery/recovery-control.js";
import { openPcmsDatabase } from "../storage/database.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const UNRESOLVED_OPERATION_STATES = Object.freeze([
  "PREPARED",
  "RUNNING",
  "VERIFYING",
  "UNCERTAIN",
  "NEEDS_HUMAN"
]);

export interface RecoveryProfileAssessment {
  readonly personaUid: string;
  readonly status: "AVAILABLE" | "MISSING" | "UNSAFE";
}

export interface RecoveryModuleAssessment {
  readonly moduleId: string;
  readonly version: string;
  readonly status: "AVAILABLE" | "MISSING" | "INVALID";
}

export interface RecoveryAssessment {
  readonly mode: "NORMAL" | "RECOVERY_HOLD";
  readonly sourceBackupId: string | null;
  readonly localState: "AVAILABLE" | "DEGRADED";
  readonly externalState: "UNKNOWN_RECONCILIATION_REQUIRED";
  readonly profiles: readonly RecoveryProfileAssessment[];
  readonly modules: readonly RecoveryModuleAssessment[];
  readonly unresolvedOperationIds: readonly string[];
}

export interface RestoreCoreStateBackupOptions {
  readonly backupDirectory: string;
  readonly liveDataRoot: string;
  readonly profileBackups?: readonly string[];
  readonly targetChromiumVersion?: string;
  readonly now?: () => Date;
}

export interface CoreStateRestoreResult {
  readonly sourceManifest: CoreBackupManifest;
  readonly safetyDirectory: string | null;
  readonly profileRestores: readonly RestorePersonaProfileBackupResult[];
  readonly assessment: RecoveryAssessment;
}

export type CoreRestoreErrorCode =
  | "RESTORE_INVALID_INPUT"
  | "RESTORE_PROFILE_DUPLICATE"
  | "RESTORE_PROFILE_TARGET_VERSION_REQUIRED"
  | "RESTORE_PROFILE_NOT_IN_DATABASE"
  | "RESTORE_PROFILE_NOT_CLOSED"
  | "RESTORE_LIVE_ROOT_UNSAFE"
  | "RESTORE_ACTIVATION_FAILED";

export class CoreRestoreError extends Error {
  public constructor(
    public readonly code: CoreRestoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CoreRestoreError";
  }
}

function fail(
  code: CoreRestoreErrorCode,
  message: string,
  cause?: unknown
): never {
  throw new CoreRestoreError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function strictDescendant(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return (
    nested !== "" &&
    !isAbsolute(nested) &&
    nested !== ".." &&
    !nested.startsWith("../")
  );
}

function absoluteRoot(path: string, label: string): string {
  if (!isAbsolute(path)) {
    fail(
      "RESTORE_INVALID_INPUT",
      `${label} must be an absolute path`
    );
  }
  return resolve(path);
}

function currentDate(now: (() => Date) | undefined): Date {
  const value = now?.() ?? new Date();
  if (!Number.isFinite(value.getTime())) {
    fail(
      "RESTORE_INVALID_INPUT",
      "restore clock returned an invalid time"
    );
  }
  return value;
}

async function writeCoreFile(
  path: string,
  bytes: Uint8Array,
  mode: number
): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
    mode: 0o700
  });
  await writeFile(path, bytes, {
    flag: "wx",
    mode
  });
  await chmod(path, mode);
}

async function copyCoreBackupToStaging(
  backupRoot: string,
  manifest: CoreBackupManifest,
  staging: string
): Promise<void> {
  for (const file of manifest.files) {
    const source = resolve(backupRoot, file.path);
    if (!strictDescendant(backupRoot, source)) {
      fail(
        "RESTORE_INVALID_INPUT",
        "Core backup file escapes backup root"
      );
    }
    const destination = join(
      staging,
      ...file.path.split("/")
    );
    await writeCoreFile(
      destination,
      await readFile(source),
      file.kind === "database" ? 0o600 : 0o400
    );
  }
}

function profileMarkerMatches(
  bytes: Uint8Array,
  personaUid: string
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return false;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    "format" in parsed &&
    parsed.format === 1 &&
    "personaUid" in parsed &&
    parsed.personaUid === personaUid &&
    "backend" in parsed &&
    parsed.backend === "chromium-v1"
  );
}

async function profileAssessment(
  database: DatabaseSync,
  liveDataRoot: string
): Promise<readonly RecoveryProfileAssessment[]> {
  const rows = database.prepare(`
    SELECT persona_uid
    FROM personas
    WHERE profile_delete_state = 'PRESENT'
    ORDER BY persona_uid
  `).all() as unknown as readonly Record<string, unknown>[];

  const assessments: RecoveryProfileAssessment[] = [];
  for (const row of rows) {
    const personaUid = row["persona_uid"];
    if (typeof personaUid !== "string") {
      assessments.push(Object.freeze({
        personaUid: "<invalid>",
        status: "UNSAFE"
      }));
      continue;
    }
    const profilePath = join(
      liveDataRoot,
      "personas",
      personaUid,
      "chromium"
    );
    const markerPath = join(
      profilePath,
      ".pcms-persona-profile.json"
    );
    const profile = await lstat(profilePath).catch(() => null);
    const marker = await lstat(markerPath).catch(() => null);
    if (profile === null || marker === null) {
      assessments.push(Object.freeze({
        personaUid,
        status: "MISSING"
      }));
      continue;
    }
    const structurallySafe =
      profile.isDirectory() &&
      !profile.isSymbolicLink() &&
      marker.isFile() &&
      !marker.isSymbolicLink();
    const markerMatches =
      structurallySafe &&
      profileMarkerMatches(
        await readFile(markerPath),
        personaUid
      );
    assessments.push(Object.freeze({
      personaUid,
      status: markerMatches ? "AVAILABLE" : "UNSAFE"
    }));
  }
  return Object.freeze(assessments);
}

async function moduleAssessment(
  database: DatabaseSync,
  liveDataRoot: string
): Promise<readonly RecoveryModuleAssessment[]> {
  const rows = database.prepare(`
    SELECT DISTINCT module_id, module_version
    FROM module_state_generations
    ORDER BY module_id, module_version
  `).all() as unknown as readonly Record<string, unknown>[];

  const assessments: RecoveryModuleAssessment[] = [];
  for (const row of rows) {
    const moduleId = row["module_id"];
    const version = row["module_version"];
    if (
      typeof moduleId !== "string" ||
      typeof version !== "string"
    ) {
      assessments.push(Object.freeze({
        moduleId: String(moduleId),
        version: String(version),
        status: "INVALID"
      }));
      continue;
    }
    const versionRoot = join(
      liveDataRoot,
      "modules",
      moduleId,
      version
    );
    let entries;
    try {
      entries = await readdir(versionRoot, {
        withFileTypes: true
      });
    } catch {
      assessments.push(Object.freeze({
        moduleId,
        version,
        status: "MISSING"
      }));
      continue;
    }
    if (entries.length === 0) {
      assessments.push(Object.freeze({
        moduleId,
        version,
        status: "MISSING"
      }));
      continue;
    }
    if (
      entries.length !== 1 ||
      !entries[0]?.isDirectory() ||
      !SHA256.test(entries[0].name)
    ) {
      assessments.push(Object.freeze({
        moduleId,
        version,
        status: "INVALID"
      }));
      continue;
    }
    const archive = join(
      versionRoot,
      entries[0].name,
      "package.pcmsmod"
    );
    const metadata = await lstat(archive).catch(() => null);
    assessments.push(Object.freeze({
      moduleId,
      version,
      status:
        metadata !== null &&
        metadata.isFile() &&
        !metadata.isSymbolicLink()
          ? "AVAILABLE"
          : "MISSING"
    }));
  }
  return Object.freeze(assessments);
}

function unresolvedOperations(
  database: DatabaseSync
): readonly string[] {
  const placeholders = UNRESOLVED_OPERATION_STATES
    .map(() => "?")
    .join(", ");
  const rows = database.prepare(`
    SELECT operation_id
    FROM operations
    WHERE state IN (${placeholders})
    ORDER BY operation_id
  `).all(
    ...UNRESOLVED_OPERATION_STATES
  ) as unknown as readonly Record<string, unknown>[];
  return Object.freeze(
    rows
      .map((row) => row["operation_id"])
      .filter(
        (value): value is string => typeof value === "string"
      )
  );
}

export async function assessRecoveryState(
  database: DatabaseSync,
  liveDataRoot: string
): Promise<RecoveryAssessment> {
  const root = absoluteRoot(liveDataRoot, "liveDataRoot");
  const control = readRecoveryControl(database);
  const profiles = await profileAssessment(database, root);
  const modules = await moduleAssessment(database, root);
  const unresolvedOperationIds = unresolvedOperations(database);
  const localState =
    profiles.some((entry) => entry.status !== "AVAILABLE") ||
    modules.some((entry) => entry.status !== "AVAILABLE")
      ? "DEGRADED"
      : "AVAILABLE";

  return Object.freeze({
    mode: control.mode,
    sourceBackupId: control.sourceBackupId,
    localState,
    externalState: "UNKNOWN_RECONCILIATION_REQUIRED",
    profiles,
    modules,
    unresolvedOperationIds
  });
}

async function validateProfileInputs(
  directories: readonly string[],
  targetChromiumVersion: string | undefined
): Promise<readonly ProfileBackupManifest[]> {
  if (
    directories.length > 0 &&
    targetChromiumVersion === undefined
  ) {
    fail(
      "RESTORE_PROFILE_TARGET_VERSION_REQUIRED",
      "targetChromiumVersion is required when restoring profile backups"
    );
  }
  const manifests: ProfileBackupManifest[] = [];
  const personas = new Set<string>();
  for (const directory of directories) {
    const manifest = await validatePersonaProfileBackup(directory);
    if (personas.has(manifest.personaUid)) {
      fail(
        "RESTORE_PROFILE_DUPLICATE",
        `multiple profile backups were supplied for ${manifest.personaUid}`
      );
    }
    personas.add(manifest.personaUid);
    if (targetChromiumVersion !== undefined) {
      checkPersonaProfileCompatibility(manifest, {
        chromiumVersion: targetChromiumVersion
      });
    }
    manifests.push(manifest);
  }
  return Object.freeze(manifests);
}

function validateRestoredPersona(
  database: DatabaseSync,
  manifest: ProfileBackupManifest
): void {
  const row = database.prepare(`
    SELECT
      profile_state,
      profile_delete_state,
      browser_backend,
      profile_relative_path
    FROM personas
    WHERE persona_uid = ?
  `).get(manifest.personaUid) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) {
    fail(
      "RESTORE_PROFILE_NOT_IN_DATABASE",
      `profile backup Persona ${manifest.personaUid} is absent from Core backup`
    );
  }
  if (
    row["profile_state"] !== "CLOSED" ||
    row["profile_delete_state"] !== "PRESENT"
  ) {
    fail(
      "RESTORE_PROFILE_NOT_CLOSED",
      `profile backup Persona ${manifest.personaUid} is not closed/present in Core backup`
    );
  }
  if (
    row["browser_backend"] !== "chromium-v1" ||
    row["profile_relative_path"] !== manifest.profileRelativePath
  ) {
    fail(
      "RESTORE_PROFILE_NOT_IN_DATABASE",
      `profile backup Persona ${manifest.personaUid} metadata differs from Core backup`
    );
  }
}

export async function restoreCoreStateBackup(
  options: RestoreCoreStateBackupOptions
): Promise<CoreStateRestoreResult> {
  const backupRoot = absoluteRoot(
    options.backupDirectory,
    "backupDirectory"
  );
  const liveDataRoot = absoluteRoot(
    options.liveDataRoot,
    "liveDataRoot"
  );
  if (
    backupRoot === liveDataRoot ||
    strictDescendant(backupRoot, liveDataRoot) ||
    strictDescendant(liveDataRoot, backupRoot)
  ) {
    fail(
      "RESTORE_INVALID_INPUT",
      "backupDirectory must not overlap liveDataRoot"
    );
  }

  const manifest = await validateCoreStateBackup(backupRoot);
  const profileDirectories = options.profileBackups ?? [];
  const profileManifests = await validateProfileInputs(
    profileDirectories,
    options.targetChromiumVersion
  );
  const now = currentDate(options.now);
  const parent = dirname(liveDataRoot);
  await mkdir(parent, {
    recursive: true,
    mode: 0o700
  });

  const liveInfo = await lstat(liveDataRoot).catch(() => null);
  if (
    liveInfo !== null &&
    (!liveInfo.isDirectory() || liveInfo.isSymbolicLink())
  ) {
    fail(
      "RESTORE_LIVE_ROOT_UNSAFE",
      "liveDataRoot exists but is not a safe directory"
    );
  }

  const token = randomUUID();
  const staging = join(
    parent,
    `.${basename(liveDataRoot)}.restore-${token}`
  );
  const safetyDirectory =
    liveInfo === null
      ? null
      : join(
          parent,
          `.${basename(liveDataRoot)}.pre-restore-${now.getTime()}-${token}`
        );
  await mkdir(staging, { mode: 0o700 });

  let stagedDatabase:
    | ReturnType<typeof openPcmsDatabase>
    | null = null;
  const profileRestores: RestorePersonaProfileBackupResult[] = [];
  let assessment: RecoveryAssessment;

  try {
    await copyCoreBackupToStaging(
      backupRoot,
      manifest,
      staging
    );
    stagedDatabase = openPcmsDatabase(
      join(staging, "pcms.db"),
      options.now === undefined
        ? {}
        : { now: options.now }
    );

    for (let index = 0; index < profileManifests.length; index += 1) {
      const profileManifest = profileManifests[index]!;
      validateRestoredPersona(
        stagedDatabase.connection,
        profileManifest
      );
      profileRestores.push(
        await restorePersonaProfileBackup({
          backupDirectory: profileDirectories[index]!,
          destinationPersonasRoot: join(staging, "personas"),
          expectedPersonaUid: profileManifest.personaUid,
          chromiumVersion: options.targetChromiumVersion!
        })
      );
    }

    enterRecoveryHold(
      stagedDatabase.connection,
      options.now === undefined
        ? { sourceBackupId: manifest.backupId }
        : {
            sourceBackupId: manifest.backupId,
            now: options.now
          }
    );
    assessment = await assessRecoveryState(
      stagedDatabase.connection,
      staging
    );
    stagedDatabase.close();
    stagedDatabase = null;

    if (safetyDirectory !== null) {
      await rename(liveDataRoot, safetyDirectory);
    }
    try {
      await rename(staging, liveDataRoot);
    } catch (error: unknown) {
      if (safetyDirectory !== null) {
        await rename(safetyDirectory, liveDataRoot)
          .catch(() => undefined);
      }
      fail(
        "RESTORE_ACTIVATION_FAILED",
        "staged restore could not be atomically activated",
        error
      );
    }
  } catch (error: unknown) {
    stagedDatabase?.close();
    await rm(staging, {
      recursive: true,
      force: true
    }).catch(() => undefined);
    throw error;
  }

  return Object.freeze({
    sourceManifest: manifest,
    safetyDirectory,
    profileRestores: Object.freeze(profileRestores),
    assessment
  });
}
