#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";

import {
  verifyPcmsBundle,
  type VerifiedPcmsBundle
} from "./bundle.js";
import {
  PCMS_INSTALL_MARKER,
  renderPcmsDesktopEntry,
  resolvePcmsInstallPaths,
  type PcmsInstallPaths
} from "./layout.js";

const MANAGED_CLI_TARGET =
  "../lib/pcms-local/current/bin/pcms";
const MANAGED_OPEN_TARGET =
  "../lib/pcms-local/current/bin/pcms-open";
const MANAGED_UNINSTALL_TARGET =
  "../lib/pcms-local/current/bin/pcms-uninstall";

class InstallerError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(
      message,
      cause === undefined ? undefined : { cause }
    );
    this.name = "InstallerError";
  }
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error)
  ) {
    return undefined;
  }
  const value = (error as { readonly code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

async function pathInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function assertManagedReleasePath(
  paths: PcmsInstallPaths,
  target: string
): void {
  const resolved = resolve(paths.installRoot, target);
  const nested = relative(paths.releasesRoot, resolved);
  if (
    nested === "" ||
    nested.startsWith("..") ||
    isAbsolute(nested)
  ) {
    throw new InstallerError(
      "existing current link does not point at a managed PCMS release"
    );
  }
}

async function preflightManagedFile(
  path: string,
  label: string
): Promise<void> {
  const info = await pathInfo(path);
  if (info === null) return;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new InstallerError(
      `${label} path exists and is not a managed regular file: ${path}`
    );
  }
  const content = await readFile(path, "utf8");
  if (!content.startsWith(`${PCMS_INSTALL_MARKER}\n`)) {
    throw new InstallerError(
      `${label} path exists but is not managed by PCMS: ${path}`
    );
  }
}

async function preflightManagedLink(
  path: string,
  expectedTarget: string,
  label: string
): Promise<void> {
  const info = await pathInfo(path);
  if (info === null) return;
  if (!info.isSymbolicLink()) {
    throw new InstallerError(
      `${label} path exists and is not a managed symlink: ${path}`
    );
  }
  const target = await readlink(path);
  if (target !== expectedTarget) {
    throw new InstallerError(
      `${label} path points somewhere unexpected: ${path}`
    );
  }
}

async function preflightCurrent(
  paths: PcmsInstallPaths
): Promise<string | null> {
  const info = await pathInfo(paths.currentLink);
  if (info === null) return null;
  if (!info.isSymbolicLink()) {
    throw new InstallerError(
      `install current path exists and is not a symlink: ${paths.currentLink}`
    );
  }
  const target = await readlink(paths.currentLink);
  assertManagedReleasePath(paths, target);
  return target;
}

async function ensureRelease(
  bundle: VerifiedPcmsBundle,
  paths: PcmsInstallPaths
): Promise<string> {
  await mkdir(paths.releasesRoot, {
    recursive: true,
    mode: 0o755
  });
  const destination = join(
    paths.releasesRoot,
    bundle.releaseId
  );
  const existing = await pathInfo(destination);
  if (existing !== null) {
    if (
      !existing.isDirectory() ||
      existing.isSymbolicLink()
    ) {
      throw new InstallerError(
        `release path is unsafe: ${destination}`
      );
    }
    const verified = await verifyPcmsBundle(destination);
    if (verified.releaseId !== bundle.releaseId) {
      throw new InstallerError(
        "existing release directory does not match requested bundle"
      );
    }
    return destination;
  }

  const staging = join(
    paths.releasesRoot,
    `.install-${process.pid}-${Date.now()}`
  );
  try {
    await cp(bundle.root, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true
    });
    const copied = await verifyPcmsBundle(staging);
    if (copied.releaseId !== bundle.releaseId) {
      throw new InstallerError(
        "copied release does not match source bundle"
      );
    }
    await rename(staging, destination);
  } finally {
    await rm(staging, {
      recursive: true,
      force: true
    }).catch(() => undefined);
  }
  return destination;
}

async function atomicSymlink(
  path: string,
  target: string
): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
    mode: 0o755
  });
  const temporary =
    `${path}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporary, { force: true });
  try {
    await symlink(target, temporary);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true })
      .catch(() => undefined);
  }
}

async function atomicManagedFile(
  path: string,
  content: string
): Promise<void> {
  await mkdir(dirname(path), {
    recursive: true,
    mode: 0o755
  });
  const temporary =
    `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, {
      mode: 0o644,
      flag: "wx"
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true })
      .catch(() => undefined);
  }
}

function runSystemctl(
  args: readonly string[],
  allowFailure = false
): void {
  const result = spawnSync(
    "systemctl",
    ["--user", ...args],
    {
      encoding: "utf8",
      stdio: allowFailure
        ? ["ignore", "pipe", "pipe"]
        : "inherit"
    }
  );
  if (result.error !== undefined) {
    throw new InstallerError(
      "systemctl could not be executed",
      result.error
    );
  }
  if (result.status !== 0 && !allowFailure) {
    throw new InstallerError(
      `systemctl --user ${args.join(" ")} failed with status ${result.status ?? "unknown"}`
    );
  }
}

function cliHealthy(
  paths: PcmsInstallPaths
): boolean {
  const result = spawnSync(
    join(paths.currentLink, "bin", "pcms"),
    ["status", "--json"],
    {
      encoding: "utf8",
      timeout: 2_000,
      env: process.env
    }
  );
  if (
    result.error !== undefined ||
    result.status !== 0
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "ok" in parsed &&
      parsed.ok === true
    );
  } catch {
    return false;
  }
}

async function waitForHealth(
  paths: PcmsInstallPaths
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (cliHealthy(paths)) return;
    await new Promise<void>((resolveSleep) => {
      setTimeout(resolveSleep, 100);
    });
  }
  throw new InstallerError(
    "pcmsd did not become healthy after service restart"
  );
}

async function previousSchemaVersion(
  paths: PcmsInstallPaths,
  currentTarget: string | null
): Promise<number | null> {
  if (currentTarget === null) return null;
  try {
    const previous = await verifyPcmsBundle(
      resolve(paths.installRoot, currentTarget)
    );
    return previous.manifest.schemaVersion;
  } catch {
    return null;
  }
}

async function install(
  bundleRoot: string,
  homeDir: string
): Promise<void> {
  const bundle = await verifyPcmsBundle(bundleRoot);
  const paths = resolvePcmsInstallPaths(homeDir);

  if (
    process.platform !== "linux" ||
    bundle.manifest.platform !== "linux"
  ) {
    throw new InstallerError(
      "PCMS Local installer currently supports Linux only"
    );
  }
  if (bundle.manifest.arch !== process.arch) {
    throw new InstallerError(
      `bundle architecture ${bundle.manifest.arch} does not match host ${process.arch}`
    );
  }

  const previousCurrent = await preflightCurrent(paths);
  await Promise.all([
    preflightManagedFile(
      paths.servicePath,
      "systemd service"
    ),
    preflightManagedFile(
      paths.desktopPath,
      "desktop entry"
    ),
    preflightManagedLink(
      paths.cliLink,
      MANAGED_CLI_TARGET,
      "CLI"
    ),
    preflightManagedLink(
      paths.openLink,
      MANAGED_OPEN_TARGET,
      "desktop launcher"
    ),
    preflightManagedLink(
      paths.uninstallLink,
      MANAGED_UNINSTALL_TARGET,
      "uninstaller"
    )
  ]);

  const priorSchema = await previousSchemaVersion(
    paths,
    previousCurrent
  );
  const release = await ensureRelease(bundle, paths);
  const releaseTarget = relative(
    paths.installRoot,
    release
  );

  await mkdir(paths.installRoot, {
    recursive: true,
    mode: 0o755
  });
  await atomicSymlink(
    paths.currentLink,
    releaseTarget
  );

  const service = await readFile(
    join(
      release,
      bundle.manifest.entries.systemdUserService
    ),
    "utf8"
  );
  if (!service.startsWith(`${PCMS_INSTALL_MARKER}\n`)) {
    throw new InstallerError(
      "bundle systemd service is not marked as PCMS-managed"
    );
  }

  await atomicManagedFile(
    paths.servicePath,
    service
  );
  await atomicManagedFile(
    paths.desktopPath,
    renderPcmsDesktopEntry(
      join(paths.currentLink, "bin", "pcms-open")
    )
  );
  await atomicSymlink(
    paths.cliLink,
    MANAGED_CLI_TARGET
  );
  await atomicSymlink(
    paths.openLink,
    MANAGED_OPEN_TARGET
  );
  await atomicSymlink(
    paths.uninstallLink,
    MANAGED_UNINSTALL_TARGET
  );

  runSystemctl(["daemon-reload"]);
  runSystemctl(["enable", "pcmsd.service"]);
  runSystemctl(["restart", "pcmsd.service"]);

  try {
    await waitForHealth(paths);
  } catch (error: unknown) {
    if (
      previousCurrent !== null &&
      priorSchema === bundle.manifest.schemaVersion
    ) {
      await atomicSymlink(
        paths.currentLink,
        previousCurrent
      );
      runSystemctl(
        ["restart", "pcmsd.service"],
        true
      );
      throw new InstallerError(
        "new PCMS release failed health check; previous compatible release was restored",
        error
      );
    }
    throw error;
  }

  process.stdout.write(
    [
      `Installed PCMS Local ${bundle.manifest.packageVersion}`,
      `Release: ${release}`,
      `CLI: ${paths.cliLink}`,
      `Desktop: ${paths.desktopPath}`
    ].join("\n") + "\n"
  );
}

async function main(): Promise<void> {
  if (
    process.argv.length > 2 &&
    !(
      process.argv.length === 3 &&
      process.argv[2] === "--help"
    )
  ) {
    throw new InstallerError(
      "Usage: install.sh [--help]"
    );
  }
  if (process.argv[2] === "--help") {
    process.stdout.write(
      "Install or update PCMS Local for the current Linux user.\n"
    );
    return;
  }

  const bundleRoot =
    process.env["PCMS_BUNDLE_ROOT"];
  if (
    bundleRoot === undefined ||
    bundleRoot === "" ||
    !isAbsolute(bundleRoot)
  ) {
    throw new InstallerError(
      "PCMS_BUNDLE_ROOT must identify the release bundle"
    );
  }
  await install(bundleRoot, homedir());
}

try {
  await main();
} catch (error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : "unknown installer failure";
  process.stderr.write(
    `PCMS install failed: ${message}\n`
  );
  process.exitCode = 1;
}
