#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  lstat,
  readFile,
  readlink,
  rm
} from "node:fs/promises";
import { homedir } from "node:os";

import {
  resolvePcmsPaths
} from "../config/paths.js";
import {
  PCMS_INSTALL_MARKER,
  resolvePcmsInstallPaths
} from "./layout.js";

const MANAGED_CLI_TARGET =
  "../lib/pcms-local/current/bin/pcms";
const MANAGED_OPEN_TARGET =
  "../lib/pcms-local/current/bin/pcms-open";
const MANAGED_UNINSTALL_TARGET =
  "../lib/pcms-local/current/bin/pcms-uninstall";

class UninstallError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UninstallError";
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

async function assertManagedFile(
  path: string,
  label: string
): Promise<void> {
  const info = await pathInfo(path);
  if (info === null) return;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new UninstallError(
      `${label} path is not a managed regular file: ${path}`
    );
  }
  const content = await readFile(path, "utf8");
  if (!content.startsWith(`${PCMS_INSTALL_MARKER}\n`)) {
    throw new UninstallError(
      `${label} path is not managed by PCMS: ${path}`
    );
  }
}

async function assertManagedLink(
  path: string,
  expectedTarget: string,
  label: string
): Promise<void> {
  const info = await pathInfo(path);
  if (info === null) return;
  if (!info.isSymbolicLink()) {
    throw new UninstallError(
      `${label} path is not a managed symlink: ${path}`
    );
  }
  if (await readlink(path) !== expectedTarget) {
    throw new UninstallError(
      `${label} path points somewhere unexpected: ${path}`
    );
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
    if (allowFailure) return;
    throw new UninstallError(
      "systemctl could not be executed"
    );
  }
  if (result.status !== 0 && !allowFailure) {
    throw new UninstallError(
      `systemctl --user ${args.join(" ")} failed with status ${result.status ?? "unknown"}`
    );
  }
}

interface UninstallOptions {
  readonly purgeData: boolean;
  readonly confirmed: boolean;
}

function parseArguments(
  argv: readonly string[]
): UninstallOptions | "help" {
  if (argv.length === 1 && argv[0] === "--help") {
    return "help";
  }
  const known = new Set(["--purge-data", "--yes"]);
  for (const arg of argv) {
    if (!known.has(arg)) {
      throw new UninstallError(
        "Usage: pcms-uninstall [--purge-data --yes]"
      );
    }
  }
  const purgeData = argv.includes("--purge-data");
  const confirmed = argv.includes("--yes");
  if (purgeData && !confirmed) {
    throw new UninstallError(
      "Refusing to purge PCMS data without both --purge-data and --yes"
    );
  }
  if (!purgeData && confirmed) {
    throw new UninstallError(
      "--yes is only valid together with --purge-data"
    );
  }
  return Object.freeze({ purgeData, confirmed });
}

async function uninstall(
  options: UninstallOptions
): Promise<void> {
  const home = homedir();
  const installPaths = resolvePcmsInstallPaths(home);
  const pcmsPaths = resolvePcmsPaths({
    homeDir: home
  });

  await Promise.all([
    assertManagedFile(
      installPaths.servicePath,
      "systemd service"
    ),
    assertManagedFile(
      installPaths.desktopPath,
      "desktop entry"
    ),
    assertManagedLink(
      installPaths.cliLink,
      MANAGED_CLI_TARGET,
      "CLI"
    ),
    assertManagedLink(
      installPaths.openLink,
      MANAGED_OPEN_TARGET,
      "desktop launcher"
    ),
    assertManagedLink(
      installPaths.uninstallLink,
      MANAGED_UNINSTALL_TARGET,
      "uninstaller"
    )
  ]);

  runSystemctl(["stop", "pcmsd.service"]);
  runSystemctl(
    ["disable", "pcmsd.service"],
    true
  );

  await rm(installPaths.servicePath, {
    force: true
  });
  await rm(installPaths.desktopPath, {
    force: true
  });
  await rm(installPaths.cliLink, {
    force: true
  });
  await rm(installPaths.openLink, {
    force: true
  });
  await rm(installPaths.uninstallLink, {
    force: true
  });

  runSystemctl(["daemon-reload"], true);

  await rm(installPaths.installRoot, {
    recursive: true,
    force: true
  });

  if (options.purgeData) {
    const roots = new Set([
      pcmsPaths.dataRoot,
      pcmsPaths.configRoot,
      pcmsPaths.cacheRoot
    ]);
    for (const root of roots) {
      await rm(root, {
        recursive: true,
        force: true
      });
    }
  }

  process.stdout.write(
    options.purgeData
      ? "PCMS Local application and user data removed. Privileged router configuration was not modified.\n"
      : "PCMS Local application removed. User data, Persona profiles and router configuration were preserved.\n"
  );
}

try {
  const args = parseArguments(
    process.argv.slice(2)
  );
  if (args === "help") {
    process.stdout.write(
      [
        "Usage: pcms-uninstall [--purge-data --yes]",
        "",
        "Default uninstall preserves PCMS data and Persona profiles.",
        "Use --purge-data --yes to explicitly delete PCMS user data.",
        "Privileged router configuration is never removed by this command."
      ].join("\n") + "\n"
    );
  } else {
    await uninstall(args);
  }
} catch (error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : "unknown uninstall failure";
  process.stderr.write(
    `PCMS uninstall failed: ${message}\n`
  );
  process.exitCode = 1;
}
