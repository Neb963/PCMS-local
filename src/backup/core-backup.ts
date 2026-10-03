import { createHash, randomUUID } from "node:crypto";
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
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import {
  parseModuleManifest,
  type ModuleManifestV1
} from "../modules/manifest.js";
import { parsePcmsModulePackage } from "../modules/package.js";
import { PCMS_APPLICATION_ID } from "../storage/migrations.js";
import { workspaceMetadata } from "../workspace.js";

const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BACKUP_ID =
  /^core-[0-9]{1,16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MANIFEST_MAX_BYTES = 1024 * 1024;

export const CORE_BACKUP_FORMAT = "pcms-core-backup-v1" as const;

export interface CoreBackupFile {
  readonly path: string;
  readonly kind: "database" | "module-package";
  readonly bytes: number;
  readonly sha256: string;
}

export interface CoreBackupModule {
  readonly moduleId: string;
  readonly version: string;
  readonly sha256: string;
  readonly path: string;
  readonly manifest: ModuleManifestV1;
}

export interface CoreBackupManifest {
  readonly format: typeof CORE_BACKUP_FORMAT;
  readonly backupId: string;
  readonly createdAt: string;
  readonly appVersion: string;
  readonly baseline: string;
  readonly applicationId: number;
  readonly schemaVersion: number;
  readonly migrationHistorySha256: string;
  readonly profiles: Readonly<{
    included: false;
    reason: "core-backup-excludes-browser-profiles";
  }>;
  readonly files: readonly CoreBackupFile[];
  readonly modules: readonly CoreBackupModule[];
}

export interface CreateCoreStateBackupOptions {
  readonly database: DatabaseSync;
  readonly liveDataRoot: string;
  readonly modulePackageRoot: string;
  readonly backupRoot: string;
  readonly now?: () => Date;
}

export interface CoreStateBackupResult {
  readonly directory: string;
  readonly manifest: CoreBackupManifest;
}

export interface CreateAutomaticCoreStateBackupOptions
  extends CreateCoreStateBackupOptions {
  readonly retentionCount?: number;
}

export interface AutomaticCoreStateBackupResult
  extends CoreStateBackupResult {
  readonly prunedBackupIds: readonly string[];
}

export class CoreBackupError extends Error {
  public readonly code: string;

  public constructor(
    code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CoreBackupError";
    this.code = code;
  }
}

interface ModuleVersionRef {
  readonly moduleId: string;
  readonly version: string;
}

function fail(
  code: string,
  message: string,
  cause?: unknown
): never {
  throw new CoreBackupError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function isWithin(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return (
    nested !== "" &&
    !isAbsolute(nested) &&
    nested !== ".." &&
    !nested.startsWith("../")
  );
}

function validateRoots(
  liveDataRoot: string,
  modulePackageRoot: string,
  backupRoot: string
): Readonly<{
  liveDataRoot: string;
  modulePackageRoot: string;
  backupRoot: string;
}> {
  for (const [label, path] of [
    ["liveDataRoot", liveDataRoot],
    ["modulePackageRoot", modulePackageRoot],
    ["backupRoot", backupRoot]
  ] as const) {
    if (!isAbsolute(path)) {
      fail(
        "INVALID_BACKUP_ROOT",
        `${label} must be an absolute path`
      );
    }
  }

  const live = resolve(liveDataRoot);
  const modules = resolve(modulePackageRoot);
  const backups = resolve(backupRoot);
  if (!isWithin(live, modules)) {
    fail(
      "INVALID_BACKUP_ROOT",
      "module package root must be strictly beneath live data root"
    );
  }
  if (
    live === backups ||
    isWithin(live, backups) ||
    isWithin(backups, live)
  ) {
    fail(
      "INVALID_BACKUP_ROOT",
      "backup root must not overlap live data root"
    );
  }
  return Object.freeze({
    liveDataRoot: live,
    modulePackageRoot: modules,
    backupRoot: backups
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateBackupId(value: unknown): string {
  if (typeof value !== "string" || !BACKUP_ID.test(value)) {
    fail("INVALID_BACKUP_MANIFEST", "backupId has invalid syntax");
  }
  return value;
}

function validateIsoTimestamp(
  value: unknown,
  label: string
): string {
  if (typeof value !== "string") {
    fail(
      "INVALID_BACKUP_MANIFEST",
      `${label} must be an ISO timestamp`
    );
  }
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== value
  ) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      `${label} must use canonical ISO timestamp syntax`
    );
  }
  return value;
}

function validateModuleId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !MODULE_ID.test(value)
  ) {
    fail("INVALID_BACKUP_MANIFEST", "moduleId has invalid syntax");
  }
  return value;
}

function validateVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !SEMVER.test(value)
  ) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "module version has invalid syntax"
    );
  }
  return value;
}

function validateDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      `${label} must be a lowercase SHA-256 digest`
    );
  }
  return value;
}

function validateNonNegativeInteger(
  value: unknown,
  label: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      `${label} must be a non-negative safe integer`
    );
  }
  return value;
}

function requireRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      `${label} must be an object`
    );
  }
  return value as Record<string, unknown>;
}

function moduleRelativePath(
  moduleId: string,
  version: string,
  digest: string
): string {
  return `modules/${moduleId}/${version}/${digest}/package.pcmsmod`;
}

function parseFile(value: unknown): CoreBackupFile {
  const record = requireRecord(value, "backup file");
  const path = record["path"];
  const kind = record["kind"];
  if (typeof path !== "string") {
    fail("INVALID_BACKUP_MANIFEST", "backup file path must be text");
  }
  if (kind !== "database" && kind !== "module-package") {
    fail("INVALID_BACKUP_MANIFEST", "backup file kind is unsupported");
  }
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".."
    )
  ) {
    fail("INVALID_BACKUP_MANIFEST", "backup file path is unsafe");
  }
  if (
    (kind === "database" && path !== "pcms.db") ||
    (kind === "module-package" &&
      !path.startsWith("modules/"))
  ) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "backup file path does not match its kind"
    );
  }
  return Object.freeze({
    path,
    kind,
    bytes: validateNonNegativeInteger(
      record["bytes"],
      "backup file bytes"
    ),
    sha256: validateDigest(
      record["sha256"],
      "backup file sha256"
    )
  });
}

function parseModule(value: unknown): CoreBackupModule {
  const record = requireRecord(value, "backup module");
  const moduleId = validateModuleId(record["moduleId"]);
  const version = validateVersion(record["version"]);
  const digest = validateDigest(
    record["sha256"],
    "module sha256"
  );
  const expectedPath = moduleRelativePath(
    moduleId,
    version,
    digest
  );
  if (record["path"] !== expectedPath) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "module package path does not match module identity"
    );
  }

  let manifest: ModuleManifestV1;
  try {
    manifest = parseModuleManifest(record["manifest"]);
  } catch (error: unknown) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "stored module manifest is invalid",
      error
    );
  }
  if (
    manifest.id !== moduleId ||
    manifest.version !== version
  ) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "stored module manifest identity does not match module entry"
    );
  }

  return Object.freeze({
    moduleId,
    version,
    sha256: digest,
    path: expectedPath,
    manifest
  });
}

function parseCoreBackupManifest(
  value: unknown
): CoreBackupManifest {
  const record = requireRecord(value, "backup manifest");
  if (record["format"] !== CORE_BACKUP_FORMAT) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "backup manifest format is unsupported"
    );
  }
  const backupId = validateBackupId(record["backupId"]);
  const createdAt = validateIsoTimestamp(
    record["createdAt"],
    "createdAt"
  );
  const appVersion = record["appVersion"];
  const baseline = record["baseline"];
  if (
    typeof appVersion !== "string" ||
    appVersion.length < 1 ||
    typeof baseline !== "string" ||
    baseline.length < 1
  ) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "backup app version metadata is invalid"
    );
  }

  const applicationId = validateNonNegativeInteger(
    record["applicationId"],
    "applicationId"
  );
  const schemaVersion = validateNonNegativeInteger(
    record["schemaVersion"],
    "schemaVersion"
  );
  const migrationHistorySha256 = validateDigest(
    record["migrationHistorySha256"],
    "migrationHistorySha256"
  );

  const profiles = requireRecord(
    record["profiles"],
    "profiles"
  );
  if (
    profiles["included"] !== false ||
    profiles["reason"] !==
      "core-backup-excludes-browser-profiles"
  ) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "Core backup must explicitly exclude browser profiles"
    );
  }

  if (!Array.isArray(record["files"])) {
    fail("INVALID_BACKUP_MANIFEST", "files must be an array");
  }
  const files = Object.freeze(record["files"].map(parseFile));
  const filePaths = new Set<string>();
  for (const file of files) {
    if (filePaths.has(file.path)) {
      fail(
        "INVALID_BACKUP_MANIFEST",
        "backup manifest contains duplicate file paths"
      );
    }
    filePaths.add(file.path);
  }
  if (
    files.filter((file) => file.kind === "database").length !== 1
  ) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "backup manifest must contain exactly one database"
    );
  }

  if (!Array.isArray(record["modules"])) {
    fail("INVALID_BACKUP_MANIFEST", "modules must be an array");
  }
  const modules = Object.freeze(
    record["modules"].map(parseModule)
  );
  const moduleKeys = new Set<string>();
  for (const module of modules) {
    const key = `${module.moduleId}@${module.version}`;
    if (moduleKeys.has(key)) {
      fail(
        "INVALID_BACKUP_MANIFEST",
        "backup manifest contains duplicate module versions"
      );
    }
    moduleKeys.add(key);
    if (!filePaths.has(module.path)) {
      fail(
        "INVALID_BACKUP_MANIFEST",
        "module entry does not have a matching file"
      );
    }
  }
  if (
    files.filter((file) => file.kind === "module-package").length !==
    modules.length
  ) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "module package file count does not match module entries"
    );
  }

  return Object.freeze({
    format: CORE_BACKUP_FORMAT,
    backupId,
    createdAt,
    appVersion,
    baseline,
    applicationId,
    schemaVersion,
    migrationHistorySha256,
    profiles: Object.freeze({
      included: false,
      reason: "core-backup-excludes-browser-profiles"
    }),
    files,
    modules
  });
}

function pragmaInteger(
  database: DatabaseSync,
  sql: string,
  column: string
): number {
  const row = database.prepare(sql).get();
  const value = row?.[column];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail(
      "BACKUP_DATABASE_INVALID",
      `database returned invalid ${column}`
    );
  }
  return value;
}

function migrationHistorySha256(
  database: DatabaseSync
): string {
  const rows = database.prepare(`
    SELECT version, migration_id, checksum
    FROM schema_migrations
    ORDER BY version
  `).all() as unknown as readonly Record<string, unknown>[];
  const canonical = rows.map((row) => {
    const version = row["version"];
    const migrationId = row["migration_id"];
    const checksum = row["checksum"];
    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      typeof migrationId !== "string" ||
      typeof checksum !== "string" ||
      !SHA256.test(checksum)
    ) {
      fail(
        "BACKUP_DATABASE_INVALID",
        "migration history contains invalid metadata"
      );
    }
    return `${version}\0${migrationId}\0${checksum}\n`;
  }).join("");
  return sha256(Buffer.from(canonical, "utf8"));
}

function listModuleVersionRefs(
  database: DatabaseSync
): readonly ModuleVersionRef[] {
  const rows = database.prepare(`
    SELECT DISTINCT module_id, module_version
    FROM module_state_generations
    ORDER BY module_id, module_version
  `).all() as unknown as readonly Record<string, unknown>[];
  return Object.freeze(
    rows.map((row): ModuleVersionRef =>
      Object.freeze({
        moduleId: validateModuleId(row["module_id"]),
        version: validateVersion(row["module_version"])
      })
    )
  );
}

async function readInstalledModuleArchive(
  packageRoot: string,
  reference: ModuleVersionRef
): Promise<Readonly<{
  bytes: Buffer;
  digest: string;
  manifest: ModuleManifestV1;
}>> {
  const versionRoot = join(
    packageRoot,
    reference.moduleId,
    reference.version
  );
  let entries;
  try {
    entries = await readdir(versionRoot, {
      withFileTypes: true
    });
  } catch (error: unknown) {
    fail(
      "BACKUP_MODULE_PACKAGE_MISSING",
      `module package is missing: ${reference.moduleId}@${reference.version}`,
      error
    );
  }
  if (
    entries.length !== 1 ||
    !entries[0]?.isDirectory() ||
    !SHA256.test(entries[0].name)
  ) {
    fail(
      "BACKUP_MODULE_PACKAGE_INVALID",
      `module version store is not a single immutable digest: ${reference.moduleId}@${reference.version}`
    );
  }

  const digest = entries[0].name;
  const archivePath = join(
    versionRoot,
    digest,
    "package.pcmsmod"
  );
  const metadata = await lstat(archivePath).catch(() => null);
  if (metadata === null || !metadata.isFile()) {
    fail(
      "BACKUP_MODULE_PACKAGE_MISSING",
      `module artifact is missing: ${reference.moduleId}@${reference.version}`
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(archivePath);
  } catch (error: unknown) {
    fail(
      "BACKUP_MODULE_PACKAGE_MISSING",
      `module artifact cannot be read: ${reference.moduleId}@${reference.version}`,
      error
    );
  }

  let parsed;
  try {
    parsed = parsePcmsModulePackage(bytes);
  } catch (error: unknown) {
    fail(
      "BACKUP_MODULE_PACKAGE_INVALID",
      `module artifact is invalid: ${reference.moduleId}@${reference.version}`,
      error
    );
  }
  if (
    parsed.sha256 !== digest ||
    parsed.manifest.id !== reference.moduleId ||
    parsed.manifest.version !== reference.version
  ) {
    fail(
      "BACKUP_MODULE_PACKAGE_INVALID",
      `module artifact identity is inconsistent: ${reference.moduleId}@${reference.version}`
    );
  }

  return Object.freeze({
    bytes,
    digest,
    manifest: parsed.manifest
  });
}

async function writePrivateFile(
  path: string,
  bytes: Uint8Array
): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
    mode: 0o700
  });
  await writeFile(path, bytes, {
    mode: 0o600,
    flag: "wx"
  });
  await chmod(path, 0o400);
}

function backupPath(
  root: string,
  relativePath: string
): string {
  const target = resolve(root, relativePath);
  if (!isWithin(resolve(root), target)) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "backup manifest path escapes backup root"
    );
  }
  return target;
}

async function listBackupFiles(
  root: string
): Promise<readonly string[]> {
  const output: string[] = [];

  const walk = async (
    directory: string,
    relativeDirectory: string
  ): Promise<void> => {
    const entries = await readdir(directory, {
      withFileTypes: true
    });
    for (const entry of entries) {
      const relativePath =
        relativeDirectory === ""
          ? entry.name
          : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(
          join(directory, entry.name),
          relativePath
        );
        continue;
      }
      if (!entry.isFile()) {
        fail(
          "BACKUP_CONTENT_INVALID",
          `backup contains unsafe filesystem entry: ${relativePath}`
        );
      }
      output.push(relativePath);
    }
  };

  await walk(root, "");
  return Object.freeze(output.sort());
}

function compareModuleRefs(
  expected: readonly ModuleVersionRef[],
  modules: readonly CoreBackupModule[]
): void {
  const expectedKeys = expected.map(
    (entry) => `${entry.moduleId}@${entry.version}`
  );
  const actualKeys = modules.map(
    (entry) => `${entry.moduleId}@${entry.version}`
  );
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some(
      (value, index) => value !== actualKeys[index]
    )
  ) {
    fail(
      "BACKUP_MODULE_SET_MISMATCH",
      "backup module artifacts do not match the module state referenced by the database snapshot"
    );
  }
}

export async function validateCoreStateBackup(
  directory: string
): Promise<CoreBackupManifest> {
  if (!isAbsolute(directory)) {
    fail(
      "INVALID_BACKUP_ROOT",
      "backup directory must be absolute"
    );
  }
  const root = resolve(directory);
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(join(root, "manifest.json"));
  } catch (error: unknown) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "backup manifest is missing",
      error
    );
  }
  if (
    manifestBytes.length === 0 ||
    manifestBytes.length > MANIFEST_MAX_BYTES
  ) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "backup manifest size is invalid"
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error: unknown) {
    fail(
      "INVALID_BACKUP_MANIFEST",
      "backup manifest is not valid JSON",
      error
    );
  }
  const manifest = parseCoreBackupManifest(value);

  const expectedFiles = [
    "manifest.json",
    ...manifest.files.map((file) => file.path)
  ].sort();
  const actualFiles = await listBackupFiles(root);
  if (
    expectedFiles.length !== actualFiles.length ||
    expectedFiles.some(
      (path, index) => path !== actualFiles[index]
    )
  ) {
    fail(
      "BACKUP_CONTENT_INVALID",
      "backup filesystem contents do not exactly match the manifest"
    );
  }

  for (const file of manifest.files) {
    const path = backupPath(root, file.path);
    const metadata = await lstat(path).catch(() => null);
    if (
      metadata === null ||
      !metadata.isFile() ||
      metadata.size !== file.bytes
    ) {
      fail(
        "BACKUP_HASH_MISMATCH",
        `backup file size differs from manifest: ${file.path}`
      );
    }
    const bytes = await readFile(path);
    if (sha256(bytes) !== file.sha256) {
      fail(
        "BACKUP_HASH_MISMATCH",
        `backup file digest differs from manifest: ${file.path}`
      );
    }
  }

  const databasePath = backupPath(root, "pcms.db");
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, {
      readOnly: true,
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: 5_000
    });
    database.enableLoadExtension(false);
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");

    const applicationId = pragmaInteger(
      database,
      "PRAGMA application_id",
      "application_id"
    );
    const schemaVersion = pragmaInteger(
      database,
      "PRAGMA user_version",
      "user_version"
    );
    const quickCheck = database.prepare(
      "PRAGMA quick_check"
    ).get()?.["quick_check"];
    if (quickCheck !== "ok") {
      fail(
        "BACKUP_DATABASE_INVALID",
        "database snapshot failed SQLite quick_check"
      );
    }
    if (
      applicationId !== PCMS_APPLICATION_ID ||
      applicationId !== manifest.applicationId ||
      schemaVersion !== manifest.schemaVersion
    ) {
      fail(
        "BACKUP_DATABASE_INVALID",
        "database identity/schema does not match backup manifest"
      );
    }
    if (
      migrationHistorySha256(database) !==
      manifest.migrationHistorySha256
    ) {
      fail(
        "BACKUP_HASH_MISMATCH",
        "migration history digest differs from backup manifest"
      );
    }
    compareModuleRefs(
      listModuleVersionRefs(database),
      manifest.modules
    );
  } catch (error: unknown) {
    if (error instanceof CoreBackupError) throw error;
    fail(
      "BACKUP_DATABASE_INVALID",
      "database snapshot could not be validated",
      error
    );
  } finally {
    database?.close();
  }

  for (const module of manifest.modules) {
    const bytes = await readFile(
      backupPath(root, module.path)
    );
    let parsed;
    try {
      parsed = parsePcmsModulePackage(bytes);
    } catch (error: unknown) {
      fail(
        "BACKUP_MODULE_PACKAGE_INVALID",
        `backed-up module package is invalid: ${module.moduleId}@${module.version}`,
        error
      );
    }
    if (
      parsed.sha256 !== module.sha256 ||
      parsed.manifest.id !== module.moduleId ||
      parsed.manifest.version !== module.version ||
      JSON.stringify(parsed.manifest) !==
        JSON.stringify(module.manifest)
    ) {
      fail(
        "BACKUP_MODULE_PACKAGE_INVALID",
        `backed-up module identity/manifest differs: ${module.moduleId}@${module.version}`
      );
    }
  }

  return manifest;
}

export async function createCoreStateBackup(
  options: CreateCoreStateBackupOptions
): Promise<CoreStateBackupResult> {
  if (!options.database.isOpen) {
    fail(
      "BACKUP_DATABASE_INVALID",
      "source database must be open"
    );
  }
  const roots = validateRoots(
    options.liveDataRoot,
    options.modulePackageRoot,
    options.backupRoot
  );
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    fail("INVALID_BACKUP_TIME", "backup clock returned invalid time");
  }

  const createdAt = now.toISOString();
  const backupId =
    `core-${now.getTime()}-${randomUUID()}`;
  validateBackupId(backupId);
  await mkdir(roots.backupRoot, {
    recursive: true,
    mode: 0o700
  });
  await chmod(roots.backupRoot, 0o700);

  const staging = join(
    roots.backupRoot,
    `.staging-${backupId}`
  );
  const destination = join(roots.backupRoot, backupId);
  await mkdir(staging, { mode: 0o700 });

  try {
    const snapshotPath = join(staging, "pcms.db");
    try {
      await backup(options.database, snapshotPath);
      await chmod(snapshotPath, 0o400);
    } catch (error: unknown) {
      fail(
        "BACKUP_DATABASE_FAILED",
        "SQLite coherent backup failed",
        error
      );
    }

    const snapshot = new DatabaseSync(snapshotPath, {
      readOnly: true,
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: 5_000
    });

    let applicationId: number;
    let schemaVersion: number;
    let migrationDigest: string;
    let moduleRefs: readonly ModuleVersionRef[];
    try {
      snapshot.enableLoadExtension(false);
      snapshot.exec(
        "PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;"
      );
      applicationId = pragmaInteger(
        snapshot,
        "PRAGMA application_id",
        "application_id"
      );
      schemaVersion = pragmaInteger(
        snapshot,
        "PRAGMA user_version",
        "user_version"
      );
      if (applicationId !== PCMS_APPLICATION_ID) {
        fail(
          "BACKUP_DATABASE_INVALID",
          "source snapshot is not a PCMS database"
        );
      }
      migrationDigest = migrationHistorySha256(snapshot);
      moduleRefs = listModuleVersionRefs(snapshot);
    } finally {
      snapshot.close();
    }

    const databaseBytes = await readFile(snapshotPath);
    const files: CoreBackupFile[] = [
      Object.freeze({
        path: "pcms.db",
        kind: "database",
        bytes: databaseBytes.length,
        sha256: sha256(databaseBytes)
      })
    ];
    const modules: CoreBackupModule[] = [];

    for (const reference of moduleRefs) {
      const installed = await readInstalledModuleArchive(
        roots.modulePackageRoot,
        reference
      );
      const path = moduleRelativePath(
        reference.moduleId,
        reference.version,
        installed.digest
      );
      await writePrivateFile(
        join(staging, ...path.split("/")),
        installed.bytes
      );
      files.push(
        Object.freeze({
          path,
          kind: "module-package",
          bytes: installed.bytes.length,
          sha256: installed.digest
        })
      );
      modules.push(
        Object.freeze({
          moduleId: reference.moduleId,
          version: reference.version,
          sha256: installed.digest,
          path,
          manifest: installed.manifest
        })
      );
    }

    const manifest: CoreBackupManifest = Object.freeze({
      format: CORE_BACKUP_FORMAT,
      backupId,
      createdAt,
      appVersion: workspaceMetadata.version,
      baseline: workspaceMetadata.baseline,
      applicationId,
      schemaVersion,
      migrationHistorySha256: migrationDigest,
      profiles: Object.freeze({
        included: false,
        reason: "core-backup-excludes-browser-profiles"
      }),
      files: Object.freeze(files),
      modules: Object.freeze(modules)
    });
    await writePrivateFile(
      join(staging, "manifest.json"),
      Buffer.from(
        JSON.stringify(manifest, null, 2) + "\n",
        "utf8"
      )
    );

    const validated = await validateCoreStateBackup(staging);
    await rename(staging, destination);
    return Object.freeze({
      directory: destination,
      manifest: validated
    });
  } catch (error: unknown) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof CoreBackupError) throw error;
    fail(
      "BACKUP_FAILED",
      "Core state backup failed",
      error
    );
  }
}

function retentionCount(value: number | undefined): number {
  const resolved = value ?? 7;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > 365
  ) {
    fail(
      "INVALID_BACKUP_RETENTION",
      "retentionCount must be an integer between 1 and 365"
    );
  }
  return resolved;
}

async function readManagedBackupManifest(
  root: string,
  directoryName: string
): Promise<CoreBackupManifest | null> {
  if (!BACKUP_ID.test(directoryName)) return null;
  let bytes: Buffer;
  try {
    bytes = await readFile(
      join(root, directoryName, "manifest.json")
    );
  } catch {
    return null;
  }
  if (
    bytes.length === 0 ||
    bytes.length > MANIFEST_MAX_BYTES
  ) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }

  try {
    const manifest = parseCoreBackupManifest(value);
    return manifest.backupId === directoryName
      ? manifest
      : null;
  } catch (error: unknown) {
    if (error instanceof CoreBackupError) return null;
    throw error;
  }
}

async function applyAutomaticRetention(
  backupRoot: string,
  keepCount: number,
  protectedBackupId: string
): Promise<readonly string[]> {
  const entries = await readdir(backupRoot, {
    withFileTypes: true
  });
  const managed: Array<{
    readonly backupId: string;
    readonly createdAt: string;
  }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readManagedBackupManifest(
      backupRoot,
      entry.name
    );
    if (manifest === null) continue;
    managed.push({
      backupId: manifest.backupId,
      createdAt: manifest.createdAt
    });
  }

  managed.sort((left, right) => {
    const byTime = right.createdAt.localeCompare(left.createdAt);
    return byTime !== 0
      ? byTime
      : right.backupId.localeCompare(left.backupId);
  });

  const keep = new Set<string>([protectedBackupId]);
  for (const entry of managed) {
    if (keep.size >= keepCount) break;
    keep.add(entry.backupId);
  }

  const pruned: string[] = [];
  for (const entry of managed) {
    if (keep.has(entry.backupId)) continue;
    await rm(join(backupRoot, entry.backupId), {
      recursive: true,
      force: false
    });
    pruned.push(entry.backupId);
  }
  return Object.freeze(pruned.sort());
}

export async function createAutomaticCoreStateBackup(
  options: CreateAutomaticCoreStateBackupOptions
): Promise<AutomaticCoreStateBackupResult> {
  const keepCount = retentionCount(options.retentionCount);
  const created = await createCoreStateBackup(options);
  const prunedBackupIds = await applyAutomaticRetention(
    resolve(options.backupRoot),
    keepCount,
    created.manifest.backupId
  );
  return Object.freeze({
    directory: created.directory,
    manifest: created.manifest,
    prunedBackupIds
  });
}
