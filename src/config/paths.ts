import { chmod, mkdir } from "node:fs/promises";
import { homedir as systemHomeDir } from "node:os";
import { isAbsolute, join, normalize, parse } from "node:path";

const APP_DIR = "pcms-local";

export class ConfigurationError extends Error {
  public readonly code = "INVALID_CONFIGURATION";

  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface PcmsPaths {
  readonly configRoot: string;
  readonly dataRoot: string;
  readonly cacheRoot: string;
  readonly runtimeRoot: string;
  readonly personasRoot: string;
  readonly configFile: string;
  readonly databasePath: string;
  readonly apiTokenFile: string;
  readonly instanceLockPath: string;
}

export interface ResolvePcmsPathsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
}

function safeAbsoluteRoot(value: string, label: string): string {
  if (!isAbsolute(value)) {
    throw new ConfigurationError(`${label} must be an absolute path`);
  }

  const normalized = normalize(value);
  if (normalized === parse(normalized).root) {
    throw new ConfigurationError(`${label} must not be a filesystem root`);
  }
  return normalized;
}

function xdgBase(
  env: Readonly<Record<string, string | undefined>>,
  name: "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_CACHE_HOME",
  fallback: string
): string {
  const configured = env[name];
  if (configured === undefined || configured === "" || !isAbsolute(configured)) {
    return fallback;
  }
  return normalize(configured);
}

function explicitRoot(
  env: Readonly<Record<string, string | undefined>>,
  name: "PCMS_CONFIG_ROOT" | "PCMS_DATA_ROOT" | "PCMS_CACHE_ROOT",
  fallback: string
): string {
  const configured = env[name];
  if (configured === undefined || configured === "") {
    return fallback;
  }
  return safeAbsoluteRoot(configured, name);
}

export function resolvePcmsPaths(options: ResolvePcmsPathsOptions = {}): PcmsPaths {
  const env = options.env ?? process.env;
  const homeDir = safeAbsoluteRoot(options.homeDir ?? systemHomeDir(), "home directory");

  const configBase = xdgBase(env, "XDG_CONFIG_HOME", join(homeDir, ".config"));
  const dataBase = xdgBase(env, "XDG_DATA_HOME", join(homeDir, ".local", "share"));
  const cacheBase = xdgBase(env, "XDG_CACHE_HOME", join(homeDir, ".cache"));

  const configRoot = explicitRoot(env, "PCMS_CONFIG_ROOT", join(configBase, APP_DIR));
  const dataRoot = explicitRoot(env, "PCMS_DATA_ROOT", join(dataBase, APP_DIR));
  const cacheRoot = explicitRoot(env, "PCMS_CACHE_ROOT", join(cacheBase, APP_DIR));
  const runtimeRoot = join(dataRoot, "runtime");
  const personasRoot = join(dataRoot, "personas");

  return Object.freeze({
    configRoot,
    dataRoot,
    cacheRoot,
    runtimeRoot,
    personasRoot,
    configFile: join(configRoot, "config.json"),
    databasePath: join(dataRoot, "pcms.db"),
    apiTokenFile: join(configRoot, "api-token"),
    instanceLockPath: join(runtimeRoot, "pcmsd.lock")
  });
}

export async function ensurePcmsDirectories(paths: PcmsPaths): Promise<void> {
  for (const path of [
    paths.configRoot,
    paths.dataRoot,
    paths.cacheRoot,
    paths.runtimeRoot,
    paths.personasRoot
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
}
