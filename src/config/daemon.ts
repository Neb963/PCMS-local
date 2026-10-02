import { ConfigurationError } from "./paths.js";

export const PCMSD_LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_PCMSD_PORT = 17_380;

export function resolvePcmsdPort(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const raw = env.PCMS_PORT;
  if (raw === undefined || raw === "") {
    return DEFAULT_PCMSD_PORT;
  }

  if (!/^\d+$/u.test(raw)) {
    throw new ConfigurationError("PCMS_PORT must be an integer between 1 and 65535");
  }

  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError("PCMS_PORT must be an integer between 1 and 65535");
  }
  return port;
}
