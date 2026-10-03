import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  statfs,
  writeFile
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import type { DatabaseSync } from "node:sqlite";

const SAFE_PERSONA_UID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const PROFILE_BACKUP_ID =
  /^profile-[0-9]{1,16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILE_COUNT = 100_000;
const DEFAULT_MAX_PROFILE_BYTES = 8 * 1024 * 1024 * 1024;
const ABSOLUTE_MAX_PROFILE_BYTES = 64 * 1024 * 1024 * 1024;
const PROFILE_MARKER = ".pcms-persona-profile.json";

export const PROFILE_BACKUP_FORMAT = "pcms-profile-backup-v1" as const;

export interface ProfileBackupFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mode: number;
}

export interface ProfileBackupManifest {
  readonly format: typeof PROFILE_BACKUP_FORMAT;
  readonly backupId: string;
  readonly createdAt: string;
  readonly personaUid: string;
  readonly browserBackend: "chromium-v1";
  readonly chromiumVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly profileRelativePath: string;
  readonly totalBytes: number;
  readonly files: readonly ProfileBackupFile[];
}

export interface CreatePersonaProfileBackupOptions {
  readonly database: DatabaseSync;
  readonly personasRoot: string;
  readonly backupRoot: string;
  readonly personaUid: string;
  readonly chromiumVersion: string;
  readonly maxBytes?: number;
  readonly now?: () => Date;
}

export interface ProfileBackupResult {
  readonly directory: string;
  readonly manifest: ProfileBackupManifest;
}

export interface ProfileCompatibilityTarget {
  readonly chromiumVersion: string;
  readonly platform?: string;
  readonly arch?: string;
}

export interface ProfileCompatibility {
  readonly compatible: boolean;
  readonly reason:
    | "EXACT_RUNTIME_MATCH"
    | "CHROMIUM_VERSION_MISMATCH"
    | "PLATFORM_MISMATCH"
    | "ARCH_MISMATCH";
}

export interface RestorePersonaProfileBackupOptions
  extends ProfileCompatibilityTarget {
  readonly backupDirectory: string;
  readonly destinationPersonasRoot: string;
  readonly expectedPersonaUid?: string;
  readonly maxBytes?: number;
}

export interface RestorePersonaProfileBackupResult {
  readonly status: "RESTORED" | "INCOMPATIBLE";
  readonly manifest: ProfileBackupManifest;
  readonly compatibility: ProfileCompatibility;
  readonly profilePath: string | null;
}

export type ProfileBackupErrorCode =
  | "PROFILE_BACKUP_INVALID_INPUT"
  | "PROFILE_BACKUP_PERSONA_NOT_FOUND"
  | "PROFILE_BACKUP_PERSONA_OPEN"
  | "PROFILE_BACKUP_PROFILE_UNAVAILABLE"
  | "PROFILE_BACKUP_PROFILE_UNSAFE"
  | "PROFILE_BACKUP_TOO_LARGE"
  | "PROFILE_BACKUP_NO_SPACE"
  | "PROFILE_BACKUP_CHANGED_DURING_COPY"
  | "PROFILE_BACKUP_MANIFEST_INVALID"
  | "PROFILE_BACKUP_CONTENT_INVALID"
  | "PROFILE_BACKUP_HASH_MISMATCH"
  | "PROFILE_RESTORE_DESTINATION_NOT_EMPTY";

export class ProfileBackupError extends Error {
  public constructor(
    public readonly code: ProfileBackupErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ProfileBackupError";
  }
}

interface PersonaBackupRow {
  readonly profile_state: unknown;
  readonly browser_backend: unknown;
  readonly profile_relative_path: unknown;
  readonly profile_delete_state: unknown;
  readonly revision: unknown;
}

function fail(
  code: ProfileBackupErrorCode,
  message: string,
  cause?: unknown
): never {
  throw new ProfileBackupError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function strictDescendant(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return (
    nested !== "" &&
    !isAbsolute(nested) &&
    nested !== ".." &&
    !nested.startsWith(`..${sep}`)
  );
}

function validateAbsoluteRoot(path: string, label: string): string {
  if (!isAbsolute(path)) {
    fail(
      "PROFILE_BACKUP_INVALID_INPUT",
      `${label} must be an absolute path`
    );
  }
  return resolve(path);
}

function validatePersonaUid(value: string): string {
  if (!SAFE_PERSONA_UID.test(value)) {
    fail(
      "PROFILE_BACKUP_INVALID_INPUT",
      "personaUid has invalid syntax"
    );
  }
  return value;
}

function validateRuntimeText(value: string, label: string): string {
  if (
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value
  ) {
    fail(
      "PROFILE_BACKUP_INVALID_INPUT",
      `${label} must contain 1-256 trimmed characters`
    );
  }
  return value;
}

function boundedMaxBytes(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_PROFILE_BYTES;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > ABSOLUTE_MAX_PROFILE_BYTES
  ) {
    fail(
      "PROFILE_BACKUP_INVALID_INPUT",
      "maxBytes must be a positive bounded safe integer"
    );
  }
  return normalized;
}

function readPersonaRow(
  database: DatabaseSync,
  personaUid: string
): PersonaBackupRow {
  const row = database.prepare(`
    SELECT
      profile_state,
      browser_backend,
      profile_relative_path,
      profile_delete_state,
      revision
    FROM personas
    WHERE persona_uid = ?
  `).get(personaUid) as PersonaBackupRow | undefined;
  if (row === undefined) {
    fail(
      "PROFILE_BACKUP_PERSONA_NOT_FOUND",
      `Persona ${personaUid} does not exist`
    );
  }
  return row;
}

function requireClosedProfile(
  database: DatabaseSync,
  personaUid: string
): Readonly<{
  relativePath: string;
  revision: number;
}> {
  const row = readPersonaRow(database, personaUid);
  if (row.profile_state !== "CLOSED") {
    fail(
      "PROFILE_BACKUP_PERSONA_OPEN",
      "Persona profile must be closed before backup"
    );
  }
  if (
    row.browser_backend !== "chromium-v1" ||
    row.profile_delete_state !== "PRESENT" ||
    typeof row.profile_relative_path !== "string" ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    fail(
      "PROFILE_BACKUP_PROFILE_UNAVAILABLE",
      "Persona profile metadata is not available for backup"
    );
  }
  const expected = `personas/${personaUid}/chromium`;
  if (row.profile_relative_path !== expected) {
    fail(
      "PROFILE_BACKUP_PROFILE_UNSAFE",
      "Persona profile path does not match its durable identity"
    );
  }
  const runtime = database.prepare(`
    SELECT state
    FROM persona_browser_runtime
    WHERE persona_uid = ?
  `).get(personaUid);
  if (runtime !== undefined) {
    fail(
      "PROFILE_BACKUP_PERSONA_OPEN",
      "Persona has browser runtime state and is not quiesced"
    );
  }
  return Object.freeze({
    relativePath: expected,
    revision: row.revision
  });
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

async function safeProfileRoot(
  personasRoot: string,
  personaUid: string
): Promise<string> {
  const rootInfo = await lstat(personasRoot).catch(() => null);
  if (
    rootInfo === null ||
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink()
  ) {
    fail(
      "PROFILE_BACKUP_PROFILE_UNSAFE",
      "Persona root is missing or unsafe"
    );
  }
  const canonicalRoot = await realpath(personasRoot);
  const profilePath = join(personasRoot, personaUid, "chromium");
  const profileInfo = await lstat(profilePath).catch(() => null);
  if (
    profileInfo === null ||
    !profileInfo.isDirectory() ||
    profileInfo.isSymbolicLink()
  ) {
    fail(
      "PROFILE_BACKUP_PROFILE_UNAVAILABLE",
      "Persona Chromium profile is missing or unsafe"
    );
  }
  const canonicalProfile = await realpath(profilePath);
  if (!strictDescendant(canonicalRoot, canonicalProfile)) {
    fail(
      "PROFILE_BACKUP_PROFILE_UNSAFE",
      "Persona Chromium profile escapes the configured Persona root"
    );
  }
  return canonicalProfile;
}

function portablePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function scanProfile(
  profileRoot: string,
  maxBytes: number
): Promise<Readonly<{
  files: readonly ProfileBackupFile[];
  bytesByPath: ReadonlyMap<string, Buffer>;
  totalBytes: number;
}>> {
  const files: ProfileBackupFile[] = [];
  const bytesByPath = new Map<string, Buffer>();
  let totalBytes = 0;

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, {
      withFileTypes: true
    });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        fail(
          "PROFILE_BACKUP_PROFILE_UNSAFE",
          `profile contains symbolic link: ${portablePath(profileRoot, absolute)}`
        );
      }
      if (metadata.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!metadata.isFile()) {
        fail(
          "PROFILE_BACKUP_PROFILE_UNSAFE",
          `profile contains unsupported filesystem entry: ${portablePath(profileRoot, absolute)}`
        );
      }
      if (files.length >= MAX_FILE_COUNT) {
        fail(
          "PROFILE_BACKUP_TOO_LARGE",
          "profile contains too many files for the bounded backup format"
        );
      }
      const bytes = await readFile(absolute);
      totalBytes += bytes.length;
      if (totalBytes > maxBytes) {
        fail(
          "PROFILE_BACKUP_TOO_LARGE",
          "profile exceeds configured backup byte limit"
        );
      }
      const path = `profile/${portablePath(profileRoot, absolute)}`;
      files.push(Object.freeze({
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
        mode: metadata.mode & 0o777
      }));
      bytesByPath.set(path, bytes);
    }
  };

  await walk(profileRoot);
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (!files.some((file) => file.path === `profile/${PROFILE_MARKER}`)) {
    fail(
      "PROFILE_BACKUP_PROFILE_UNSAFE",
      "profile ownership marker is missing"
    );
  }
  return Object.freeze({
    files: Object.freeze(files),
    bytesByPath,
    totalBytes
  });
}

async function requireFreeSpace(
  root: string,
  requiredBytes: number
): Promise<void> {
  const stats = await statfs(root);
  const available = stats.bavail * stats.bsize;
  if (
    !Number.isFinite(available) ||
    available < requiredBytes
  ) {
    fail(
      "PROFILE_BACKUP_NO_SPACE",
      "destination filesystem does not have enough free space"
    );
  }
}

async function writePrivateFile(
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
    mode: mode & 0o777
  });
  await chmod(path, mode & 0o777);
}

function parseManifestFile(value: unknown): ProfileBackupFile {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    fail(
      "PROFILE_BACKUP_MANIFEST_INVALID",
      "profile file entry must be an object"
    );
  }
  const record = value as Record<string, unknown>;
  const path = record["path"];
  const bytes = record["bytes"];
  const digest = record["sha256"];
  const mode = record["mode"];
  if (
    typeof path !== "string" ||
    !path.startsWith("profile/") ||
    path.includes("\\") ||
    path.split("/").some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".."
    ) ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    typeof digest !== "string" ||
    !SHA256.test(digest) ||
    typeof mode !== "number" ||
    !Number.isSafeInteger(mode) ||
    mode < 0 ||
    mode > 0o777
  ) {
    fail(
      "PROFILE_BACKUP_MANIFEST_INVALID",
      "profile file entry is invalid"
    );
  }
  return Object.freeze({
    path,
    bytes,
    sha256: digest,
    mode
  });
}

function parseManifest(value: unknown): ProfileBackupManifest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    fail(
      "PROFILE_BACKUP_MANIFEST_INVALID",
      "profile backup manifest must be an object"
    );
  }
  const record = value as Record<string, unknown>;
  if (
    record["format"] !== PROFILE_BACKUP_FORMAT ||
    typeof record["backupId"] !== "string" ||
    !PROFILE_BACKUP_ID.test(record["backupId"]) ||
    typeof record["createdAt"] !== "string" ||
    new Date(record["createdAt"]).toISOString() !== record["createdAt"] ||
    typeof record["personaUid"] !== "string" ||
    !SAFE_PERSONA_UID.test(record["personaUid"]) ||
    record["browserBackend"] !== "chromium-v1" ||
    typeof record["chromiumVersion"] !== "string" ||
    record["chromiumVersion"].length < 1 ||
    typeof record["platform"] !== "string" ||
    record["platform"].length < 1 ||
    typeof record["arch"] !== "string" ||
    record["arch"].length < 1 ||
    record["profileRelativePath"] !==
      `personas/${String(record["personaUid"])}/chromium` ||
    typeof record["totalBytes"] !== "number" ||
    !Number.isSafeInteger(record["totalBytes"]) ||
    record["totalBytes"] < 0 ||
    !Array.isArray(record["files"]) ||
    record["files"].length > MAX_FILE_COUNT
  ) {
    fail(
      "PROFILE_BACKUP_MANIFEST_INVALID",
      "profile backup manifest metadata is invalid"
    );
  }
  const files = Object.freeze(
    record["files"].map(parseManifestFile)
  );
  const paths = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (paths.has(file.path)) {
      fail(
        "PROFILE_BACKUP_MANIFEST_INVALID",
        "profile backup manifest contains duplicate file paths"
      );
    }
    paths.add(file.path);
    total += file.bytes;
  }
  if (
    total !== record["totalBytes"] ||
    !paths.has(`profile/${PROFILE_MARKER}`)
  ) {
    fail(
      "PROFILE_BACKUP_MANIFEST_INVALID",
      "profile backup manifest byte total or ownership marker is invalid"
    );
  }

  return Object.freeze({
    format: PROFILE_BACKUP_FORMAT,
    backupId: record["backupId"],
    createdAt: record["createdAt"],
    personaUid: record["personaUid"],
    browserBackend: "chromium-v1",
    chromiumVersion: record["chromiumVersion"],
    platform: record["platform"],
    arch: record["arch"],
    profileRelativePath: record["profileRelativePath"],
    totalBytes: record["totalBytes"],
    files
  }) as ProfileBackupManifest;
}

async function listBackupFiles(root: string): Promise<readonly string[]> {
  const output: string[] = [];
  const walk = async (
    directory: string,
    relativeDirectory: string
  ): Promise<void> => {
    for (const entry of await readdir(directory, {
      withFileTypes: true
    })) {
      const absolute = join(directory, entry.name);
      const portable =
        relativeDirectory === ""
          ? entry.name
          : `${relativeDirectory}/${entry.name}`;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        fail(
          "PROFILE_BACKUP_CONTENT_INVALID",
          `profile backup contains symbolic link: ${portable}`
        );
      }
      if (metadata.isDirectory()) {
        await walk(absolute, portable);
      } else if (metadata.isFile()) {
        output.push(portable);
      } else {
        fail(
          "PROFILE_BACKUP_CONTENT_INVALID",
          `profile backup contains unsupported entry: ${portable}`
        );
      }
    }
  };
  await walk(root, "");
  return Object.freeze(output.sort());
}

export async function validatePersonaProfileBackup(
  directory: string
): Promise<ProfileBackupManifest> {
  const root = validateAbsoluteRoot(directory, "backupDirectory");
  let bytes: Buffer;
  try {
    bytes = await readFile(join(root, "manifest.json"));
  } catch (error: unknown) {
    fail(
      "PROFILE_BACKUP_MANIFEST_INVALID",
      "profile backup manifest is missing",
      error
    );
  }
  if (
    bytes.length < 2 ||
    bytes.length > MANIFEST_MAX_BYTES
  ) {
    fail(
      "PROFILE_BACKUP_MANIFEST_INVALID",
      "profile backup manifest size is invalid"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error: unknown) {
    fail(
      "PROFILE_BACKUP_MANIFEST_INVALID",
      "profile backup manifest is not valid JSON",
      error
    );
  }
  const manifest = parseManifest(parsed);
  const expected = [
    "manifest.json",
    ...manifest.files.map((file) => file.path)
  ].sort();
  const actual = await listBackupFiles(root);
  if (
    expected.length !== actual.length ||
    expected.some((path, index) => path !== actual[index])
  ) {
    fail(
      "PROFILE_BACKUP_CONTENT_INVALID",
      "profile backup filesystem does not exactly match its manifest"
    );
  }

  for (const file of manifest.files) {
    const path = resolve(root, file.path);
    if (!strictDescendant(root, path)) {
      fail(
        "PROFILE_BACKUP_CONTENT_INVALID",
        "profile backup file escapes backup root"
      );
    }
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== file.bytes
    ) {
      fail(
        "PROFILE_BACKUP_HASH_MISMATCH",
        `profile backup file size differs: ${file.path}`
      );
    }
    const fileBytes = await readFile(path);
    if (sha256(fileBytes) !== file.sha256) {
      fail(
        "PROFILE_BACKUP_HASH_MISMATCH",
        `profile backup digest differs: ${file.path}`
      );
    }
  }
  return manifest;
}

export function checkPersonaProfileCompatibility(
  manifest: ProfileBackupManifest,
  target: ProfileCompatibilityTarget
): ProfileCompatibility {
  const targetVersion = validateRuntimeText(
    target.chromiumVersion,
    "chromiumVersion"
  );
  const platform = target.platform ?? process.platform;
  const arch = target.arch ?? process.arch;
  if (manifest.platform !== platform) {
    return Object.freeze({
      compatible: false,
      reason: "PLATFORM_MISMATCH"
    });
  }
  if (manifest.arch !== arch) {
    return Object.freeze({
      compatible: false,
      reason: "ARCH_MISMATCH"
    });
  }
  if (manifest.chromiumVersion !== targetVersion) {
    return Object.freeze({
      compatible: false,
      reason: "CHROMIUM_VERSION_MISMATCH"
    });
  }
  return Object.freeze({
    compatible: true,
    reason: "EXACT_RUNTIME_MATCH"
  });
}

export async function createPersonaProfileBackup(
  options: CreatePersonaProfileBackupOptions
): Promise<ProfileBackupResult> {
  const personasRoot = validateAbsoluteRoot(
    options.personasRoot,
    "personasRoot"
  );
  const backupRoot = validateAbsoluteRoot(
    options.backupRoot,
    "backupRoot"
  );
  if (
    personasRoot === backupRoot ||
    strictDescendant(personasRoot, backupRoot) ||
    strictDescendant(backupRoot, personasRoot)
  ) {
    fail(
      "PROFILE_BACKUP_INVALID_INPUT",
      "backupRoot must not overlap personasRoot"
    );
  }
  const personaUid = validatePersonaUid(options.personaUid);
  const chromiumVersion = validateRuntimeText(
    options.chromiumVersion,
    "chromiumVersion"
  );
  const maxBytes = boundedMaxBytes(options.maxBytes);
  const initial = requireClosedProfile(
    options.database,
    personaUid
  );
  const profileRoot = await safeProfileRoot(
    personasRoot,
    personaUid
  );
  const scanned = await scanProfile(profileRoot, maxBytes);

  const after = requireClosedProfile(
    options.database,
    personaUid
  );
  if (after.revision !== initial.revision) {
    fail(
      "PROFILE_BACKUP_CHANGED_DURING_COPY",
      "Persona profile lifecycle changed during backup"
    );
  }

  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    fail(
      "PROFILE_BACKUP_INVALID_INPUT",
      "backup clock returned invalid time"
    );
  }
  await mkdir(backupRoot, {
    recursive: true,
    mode: 0o700
  });
  await chmod(backupRoot, 0o700);
  await requireFreeSpace(backupRoot, scanned.totalBytes);

  const backupId = `profile-${now.getTime()}-${randomUUID()}`;
  const staging = join(backupRoot, `.staging-${backupId}`);
  const destination = join(backupRoot, backupId);
  await mkdir(staging, { mode: 0o700 });

  try {
    for (const file of scanned.files) {
      const fileBytes = scanned.bytesByPath.get(file.path);
      if (fileBytes === undefined) {
        fail(
          "PROFILE_BACKUP_CHANGED_DURING_COPY",
          "profile scan lost captured file bytes"
        );
      }
      await writePrivateFile(
        join(staging, ...file.path.split("/")),
        fileBytes,
        file.mode
      );
    }
    const manifest: ProfileBackupManifest = Object.freeze({
      format: PROFILE_BACKUP_FORMAT,
      backupId,
      createdAt: now.toISOString(),
      personaUid,
      browserBackend: "chromium-v1",
      chromiumVersion,
      platform: process.platform,
      arch: process.arch,
      profileRelativePath: initial.relativePath,
      totalBytes: scanned.totalBytes,
      files: scanned.files
    });
    await writeFile(
      join(staging, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600, flag: "wx" }
    );
    await validatePersonaProfileBackup(staging);
    await import("node:fs/promises").then(({ rename }) =>
      rename(staging, destination)
    );
    return Object.freeze({
      directory: destination,
      manifest
    });
  } catch (error: unknown) {
    await rm(staging, {
      recursive: true,
      force: true
    }).catch(() => undefined);
    throw error;
  }
}

export async function restorePersonaProfileBackup(
  options: RestorePersonaProfileBackupOptions
): Promise<RestorePersonaProfileBackupResult> {
  const manifest = await validatePersonaProfileBackup(
    options.backupDirectory
  );
  if (
    options.expectedPersonaUid !== undefined &&
    manifest.personaUid !==
      validatePersonaUid(options.expectedPersonaUid)
  ) {
    fail(
      "PROFILE_BACKUP_INVALID_INPUT",
      "profile backup Persona does not match expectedPersonaUid"
    );
  }
  const compatibility = checkPersonaProfileCompatibility(
    manifest,
    options
  );
  if (!compatibility.compatible) {
    return Object.freeze({
      status: "INCOMPATIBLE",
      manifest,
      compatibility,
      profilePath: null
    });
  }
  const maxBytes = boundedMaxBytes(options.maxBytes);
  if (manifest.totalBytes > maxBytes) {
    fail(
      "PROFILE_BACKUP_TOO_LARGE",
      "profile backup exceeds configured restore byte limit"
    );
  }
  const personasRoot = validateAbsoluteRoot(
    options.destinationPersonasRoot,
    "destinationPersonasRoot"
  );
  await mkdir(personasRoot, {
    recursive: true,
    mode: 0o700
  });
  await requireFreeSpace(personasRoot, manifest.totalBytes);
  const personaRoot = join(personasRoot, manifest.personaUid);
  const profilePath = join(personaRoot, "chromium");
  const existing = await lstat(profilePath).catch((error: unknown) => {
    if (systemErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    if (
      !existing.isDirectory() ||
      existing.isSymbolicLink() ||
      (await readdir(profilePath)).length !== 0
    ) {
      fail(
        "PROFILE_RESTORE_DESTINATION_NOT_EMPTY",
        "profile restore destination already contains state"
      );
    }
  } else {
    await mkdir(profilePath, {
      recursive: true,
      mode: 0o700
    });
  }

  try {
    const backupRoot = resolve(options.backupDirectory);
    for (const file of manifest.files) {
      const source = resolve(backupRoot, file.path);
      if (!strictDescendant(backupRoot, source)) {
        fail(
          "PROFILE_BACKUP_CONTENT_INVALID",
          "profile backup file escapes backup root"
        );
      }
      const relativePath = file.path.slice("profile/".length);
      const destination = join(
        profilePath,
        ...relativePath.split("/")
      );
      await writePrivateFile(
        destination,
        await readFile(source),
        file.mode
      );
    }
  } catch (error: unknown) {
    await rm(personaRoot, {
      recursive: true,
      force: true
    }).catch(() => undefined);
    throw error;
  }

  return Object.freeze({
    status: "RESTORED",
    manifest,
    compatibility,
    profilePath
  });
}
