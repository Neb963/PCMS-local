import { homedir as systemHomeDir } from "node:os";
import { isAbsolute, join, normalize, parse } from "node:path";

export const PCMS_INSTALL_MARKER =
  "# Managed by PCMS Local installer";

export interface PcmsInstallPaths {
  readonly homeDir: string;
  readonly installRoot: string;
  readonly releasesRoot: string;
  readonly currentLink: string;
  readonly userBinDir: string;
  readonly cliLink: string;
  readonly openLink: string;
  readonly systemdUserDir: string;
  readonly servicePath: string;
  readonly applicationsDir: string;
  readonly desktopPath: string;
}

function safeHome(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error("home directory must be absolute");
  }
  const normalized = normalize(path);
  if (normalized === parse(normalized).root) {
    throw new Error("home directory must not be a filesystem root");
  }
  return normalized;
}

export function resolvePcmsInstallPaths(
  homeDir = systemHomeDir()
): PcmsInstallPaths {
  const home = safeHome(homeDir);
  const localRoot = join(home, ".local");
  const installRoot = join(localRoot, "lib", "pcms-local");

  return Object.freeze({
    homeDir: home,
    installRoot,
    releasesRoot: join(installRoot, "releases"),
    currentLink: join(installRoot, "current"),
    userBinDir: join(localRoot, "bin"),
    cliLink: join(localRoot, "bin", "pcms"),
    openLink: join(localRoot, "bin", "pcms-open"),
    systemdUserDir: join(home, ".config", "systemd", "user"),
    servicePath: join(
      home,
      ".config",
      "systemd",
      "user",
      "pcmsd.service"
    ),
    applicationsDir: join(
      localRoot,
      "share",
      "applications"
    ),
    desktopPath: join(
      localRoot,
      "share",
      "applications",
      "pcms-local.desktop"
    )
  });
}

function desktopExecArgument(value: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("desktop executable path contains a newline");
  }
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$")}"`;
}

export function renderPcmsDesktopEntry(
  openExecutable: string
): string {
  if (!isAbsolute(openExecutable)) {
    throw new Error("desktop executable path must be absolute");
  }

  return [
    PCMS_INSTALL_MARKER,
    "[Desktop Entry]",
    "Type=Application",
    "Name=PCMS Local",
    "Comment=Open the PCMS Local control plane",
    `Exec=${desktopExecArgument(openExecutable)}`,
    "Terminal=false",
    "Categories=Utility;",
    "StartupNotify=true",
    "X-PCMS-Managed=true",
    ""
  ].join("\n");
}
