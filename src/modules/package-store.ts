import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
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

import {
  parsePcmsModulePackage,
  type ParsedModulePackage
} from "./package.js";
import type { ModuleManifestV1 } from "./manifest.js";

const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface InstalledModulePackage {
  readonly moduleId: string;
  readonly version: string;
  readonly sha256: string;
  readonly packageRoot: string;
  readonly backendEntry: string;
  readonly uiEntry?: string;
  readonly manifest: ModuleManifestV1;
  readFile(path: string): Promise<Buffer>;
}

export class ModulePackageStoreError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(
    code: string,
    message: string,
    retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ModulePackageStoreError";
    this.code = code;
    this.retryable = retryable;
  }
}

function fail(
  code: string,
  message: string,
  retryable = false,
  cause?: unknown
): never {
  throw new ModulePackageStoreError(
    code,
    message,
    retryable,
    cause === undefined ? undefined : { cause }
  );
}

function validateModuleId(moduleId: string): void {
  if (moduleId.length > 64 || !MODULE_ID.test(moduleId)) {
    fail(
      "INVALID_MODULE_PACKAGE_IDENTITY",
      "moduleId has invalid syntax"
    );
  }
}

function validateVersion(version: string): void {
  if (version.length > 128 || !SEMVER.test(version)) {
    fail(
      "INVALID_MODULE_PACKAGE_IDENTITY",
      "module version must use semantic version syntax"
    );
  }
}

function packagePath(root: string, entryPath: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, entryPath);
  const within = relative(resolvedRoot, resolved);
  if (
    within === "" ||
    within.startsWith("..") ||
    isAbsolute(within)
  ) {
    fail(
      "MODULE_PACKAGE_STORE_CORRUPT",
      "validated package entry escaped installed package root"
    );
  }
  return resolved;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function extractParsedPackage(
  parsed: ParsedModulePackage,
  targetRoot: string
): Promise<void> {
  const filesRoot = join(targetRoot, "files");
  await ensurePrivateDirectory(filesRoot);

  for (const entry of parsed.entries) {
    const target = packagePath(filesRoot, entry.path);
    if (entry.kind === "directory") {
      await mkdir(target, { recursive: true, mode: 0o700 });
      continue;
    }
    const parent = dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await writeFile(target, parsed.readFile(entry.path), {
      mode: 0o600,
      flag: "wx"
    });
    await chmod(target, 0o400);
  }

}

async function verifyExtractedFiles(
  parsed: ParsedModulePackage,
  filesRoot: string
): Promise<void> {
  for (const entry of parsed.entries) {
    const target = packagePath(filesRoot, entry.path);
    const metadata = await lstat(target).catch(() => null);
    if (metadata === null) {
      fail(
        "MODULE_PACKAGE_STORE_CORRUPT",
        `installed package entry is missing: ${entry.path}`
      );
    }
    if (entry.kind === "directory") {
      if (!metadata.isDirectory()) {
        fail(
          "MODULE_PACKAGE_STORE_CORRUPT",
          `installed package directory changed type: ${entry.path}`
        );
      }
      continue;
    }
    if (!metadata.isFile()) {
      fail(
        "MODULE_PACKAGE_STORE_CORRUPT",
        `installed package file changed type: ${entry.path}`
      );
    }
    const bytes = await readFile(target);
    if (!bytes.equals(parsed.readFile(entry.path))) {
      fail(
        "MODULE_PACKAGE_STORE_CORRUPT",
        `installed package file differs from immutable artifact: ${entry.path}`
      );
    }
  }
}

function descriptor(
  parsed: ParsedModulePackage,
  packageRoot: string
): InstalledModulePackage {
  const filesRoot = join(packageRoot, "files");
  const files = new Set(
    parsed.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.path)
  );
  return Object.freeze({
    moduleId: parsed.manifest.id,
    version: parsed.manifest.version,
    sha256: parsed.sha256,
    packageRoot: filesRoot,
    backendEntry: parsed.manifest.backend,
    ...(parsed.manifest.ui === undefined
      ? {}
      : { uiEntry: parsed.manifest.ui }),
    manifest: parsed.manifest,
    async readFile(path: string): Promise<Buffer> {
      if (!files.has(path)) {
        fail(
          "MODULE_PACKAGE_FILE_NOT_FOUND",
          `package file not found: ${path}`
        );
      }
      return readFile(packagePath(filesRoot, path));
    }
  });
}

export class ModulePackageStore {
  readonly #root: string;

  public constructor(root: string) {
    if (!isAbsolute(root)) {
      throw new ModulePackageStoreError(
        "INVALID_MODULE_PACKAGE_STORE",
        "module package store root must be absolute"
      );
    }
    this.#root = resolve(root);
  }

  public get root(): string {
    return this.#root;
  }

  public async install(
    input: Uint8Array
  ): Promise<InstalledModulePackage> {
    const bytes = Buffer.from(input);
    const parsed = parsePcmsModulePackage(bytes);
    const { id: moduleId, version } = parsed.manifest;
    validateModuleId(moduleId);
    validateVersion(version);

    await ensurePrivateDirectory(this.#root);
    const moduleRoot = join(this.#root, moduleId);
    const versionRoot = join(moduleRoot, version);
    await ensurePrivateDirectory(moduleRoot);
    await ensurePrivateDirectory(versionRoot);

    const existing = await this.#versionDigests(versionRoot);
    const different = existing.find(
      (digest) => digest !== parsed.sha256
    );
    if (different !== undefined) {
      fail(
        "MODULE_PACKAGE_VERSION_CONFLICT",
        `module ${moduleId}@${version} is already installed with a different immutable digest`
      );
    }
    if (existing.includes(parsed.sha256)) {
      return this.#loadExact(
        moduleId,
        version,
        parsed.sha256
      );
    }

    const stagingRoot = join(this.#root, ".staging");
    await ensurePrivateDirectory(stagingRoot);
    const staging = await mkdtemp(
      join(stagingRoot, "install-")
    );

    try {
      await writeFile(
        join(staging, "package.pcmsmod"),
        bytes,
        { mode: 0o600, flag: "wx" }
      );
      await extractParsedPackage(parsed, staging);
      await chmod(join(staging, "package.pcmsmod"), 0o400);

      const destination = join(versionRoot, parsed.sha256);
      try {
        await rename(staging, destination);
        await chmod(destination, 0o700);
      } catch (error: unknown) {
        const raced = await lstat(destination).catch(() => null);
        if (raced === null) throw error;
      }

      const installed = await this.#loadExact(
        moduleId,
        version,
        parsed.sha256
      );
      return installed;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  public async getInstalled(
    moduleId: string,
    version: string
  ): Promise<InstalledModulePackage> {
    validateModuleId(moduleId);
    validateVersion(version);
    const versionRoot = join(this.#root, moduleId, version);
    const digests = await this.#versionDigests(versionRoot);
    if (digests.length === 0) {
      fail(
        "MODULE_PACKAGE_NOT_INSTALLED",
        `module package is not installed: ${moduleId}@${version}`
      );
    }
    if (digests.length !== 1) {
      fail(
        "MODULE_PACKAGE_STORE_CORRUPT",
        `module version has multiple installed digests: ${moduleId}@${version}`
      );
    }
    const digest = digests[0];
    if (digest === undefined) {
      fail(
        "MODULE_PACKAGE_STORE_CORRUPT",
        "installed module digest disappeared"
      );
    }
    return this.#loadExact(moduleId, version, digest);
  }

  async #versionDigests(versionRoot: string): Promise<string[]> {
    const entries = await readdir(
      versionRoot,
      { withFileTypes: true }
    ).catch((error: unknown) => {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code === "ENOENT") return [];
      throw error;
    });
    const digests: string[] = [];
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !SHA256.test(entry.name)
      ) {
        fail(
          "MODULE_PACKAGE_STORE_CORRUPT",
          `unexpected entry in module version store: ${entry.name}`
        );
      }
      digests.push(entry.name);
    }
    return digests.sort();
  }

  async #loadExact(
    moduleId: string,
    version: string,
    sha256: string
  ): Promise<InstalledModulePackage> {
    if (!SHA256.test(sha256)) {
      fail(
        "MODULE_PACKAGE_STORE_CORRUPT",
        "installed module digest has invalid syntax"
      );
    }
    const packageRoot = join(
      this.#root,
      moduleId,
      version,
      sha256
    );
    const archivePath = join(packageRoot, "package.pcmsmod");
    let bytes: Buffer;
    try {
      bytes = await readFile(archivePath);
    } catch (error: unknown) {
      fail(
        "MODULE_PACKAGE_STORE_CORRUPT",
        "installed immutable module artifact is missing",
        false,
        error
      );
    }
    const parsed = parsePcmsModulePackage(bytes);
    if (
      parsed.sha256 !== sha256 ||
      parsed.manifest.id !== moduleId ||
      parsed.manifest.version !== version
    ) {
      fail(
        "MODULE_PACKAGE_STORE_CORRUPT",
        "installed module artifact identity does not match its content-addressed path"
      );
    }

    await verifyExtractedFiles(
      parsed,
      join(packageRoot, "files")
    );
    return descriptor(parsed, packageRoot);
  }
}
