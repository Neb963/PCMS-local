#!/usr/bin/env node
import { readLocalApiToken } from "../auth/local-api.js";
import {
  DEFAULT_PCMSD_PORT,
  PCMSD_LOOPBACK_HOST,
  resolvePcmsdPort
} from "../config/daemon.js";
import { resolvePcmsPaths } from "../config/paths.js";
import { PcmsApiError, createPcmsApiClient } from "../client/api-client.js";

interface CliArguments {
  readonly command: "status";
  readonly json: boolean;
}

class CliUsageError extends Error {
  public readonly code = "CLI_USAGE";

  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function parseArguments(argv: readonly string[]): CliArguments {
  const json = argv.includes("--json");
  const positional = argv.filter((value) => value !== "--json");

  if (positional.length !== 1 || positional[0] !== "status") {
    throw new CliUsageError("Usage: pcms status [--json]");
  }

  return Object.freeze({ command: "status", json });
}

function safeError(error: unknown): Readonly<{ code: string; message: string }> {
  if (error instanceof PcmsApiError || error instanceof CliUsageError) {
    return Object.freeze({ code: error.code, message: error.message });
  }
  if (error instanceof Error) {
    const code =
      typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    return Object.freeze({
      code: typeof code === "string" ? code : "PCMS_CLI_FAILED",
      message: error.message
    });
  }
  return Object.freeze({
    code: "PCMS_CLI_FAILED",
    message: "Unknown CLI failure"
  });
}

async function run(): Promise<void> {
  let args: CliArguments;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error: unknown) {
    const safe = safeError(error);
    process.stderr.write(`${safe.message}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const paths = resolvePcmsPaths();
    const token = await readLocalApiToken(paths.apiTokenFile);
    const port = resolvePcmsdPort();
    const client = createPcmsApiClient({
      origin: `http://${PCMSD_LOOPBACK_HOST}:${port}`,
      token
    });

    const status = await client.status();
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, status })}\n`);
      return;
    }

    process.stdout.write(
      [
        "PCMS Local",
        `Service: ${status.service}`,
        `Status: ${status.status}`,
        `Version: ${status.version}`,
        `Schema: ${status.database.schemaVersion}`
      ].join("\n") + "\n"
    );
  } catch (error: unknown) {
    const safe = safeError(error);
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: safe })}\n`
      );
    } else {
      process.stderr.write(`${safe.code}: ${safe.message}\n`);
    }
    process.exitCode = 1;
  }
}

await run();
