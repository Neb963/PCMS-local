#!/usr/bin/env node
import { readLocalApiToken } from "../auth/local-api.js";
import {
  PCMSD_LOOPBACK_HOST,
  resolvePcmsdPort
} from "../config/daemon.js";
import { resolvePcmsPaths } from "../config/paths.js";
import { PcmsApiError, createPcmsApiClient } from "../client/api-client.js";

type CliArguments =
  | Readonly<{ command: "status"; json: boolean }>
  | Readonly<{ command: "diagnostics"; json: boolean }>
  | Readonly<{ command: "accounts-list"; json: boolean }>
  | Readonly<{
      command: "account-persona";
      accountId: string;
      json: boolean;
    }>
  | Readonly<{
      command: "search";
      query: string;
      json: boolean;
    }>;

class CliUsageError extends Error {
  public readonly code = "CLI_USAGE";

  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const USAGE = [
  "Usage:",
  "  pcms status [--json]",
  "  pcms diagnostics [--json]",
  "  pcms accounts list [--json]",
  "  pcms accounts persona <account-id> [--json]",
  "  pcms search <query> [--json]"
].join("\n");

function parseArguments(argv: readonly string[]): CliArguments {
  const json = argv.includes("--json");
  const positional = argv.filter((value) => value !== "--json");

  if (positional.length === 1 && positional[0] === "status") {
    return Object.freeze({ command: "status", json });
  }
  if (positional.length === 1 && positional[0] === "diagnostics") {
    return Object.freeze({ command: "diagnostics", json });
  }
  if (
    positional.length === 2 &&
    positional[0] === "accounts" &&
    positional[1] === "list"
  ) {
    return Object.freeze({ command: "accounts-list", json });
  }
  if (
    positional.length === 3 &&
    positional[0] === "accounts" &&
    positional[1] === "persona" &&
    positional[2] !== undefined &&
    positional[2].length > 0
  ) {
    return Object.freeze({
      command: "account-persona",
      accountId: positional[2],
      json
    });
  }
  if (
    positional.length === 2 &&
    positional[0] === "search" &&
    positional[1] !== undefined &&
    positional[1].trim().length > 0
  ) {
    return Object.freeze({
      command: "search",
      query: positional[1],
      json
    });
  }

  throw new CliUsageError(USAGE);
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

    if (args.command === "status") {
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
      return;
    }

    if (args.command === "diagnostics") {
      const diagnostics = await client.diagnostics();
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, diagnostics })}\n`
        );
        return;
      }

      process.stdout.write(
        [
          "PCMS Local diagnostics",
          `Status: ${diagnostics.status}`,
          `Node: ${diagnostics.runtime.node}`,
          `Schema: ${diagnostics.database.schemaVersion}`,
          `API: ${diagnostics.localApi.origin}`,
          `Config: ${diagnostics.paths.configRoot}`,
          `Data: ${diagnostics.paths.dataRoot}`,
          `Cache: ${diagnostics.paths.cacheRoot}`
        ].join("\n") + "\n"
      );
      return;
    }

    if (args.command === "accounts-list") {
      const accounts = await client.accounts();
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, accounts })}\n`
        );
        return;
      }

      if (accounts.length === 0) {
        process.stdout.write("No Accounts.\n");
        return;
      }
      for (const account of accounts) {
        process.stdout.write(
          `${account.accountId}\t${account.displayName}\tPersona: ${account.personaUid ?? "unbound"}\n`
        );
      }
      return;
    }

    if (args.command === "account-persona") {
      const navigation = await client.accountPersona(args.accountId);
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, navigation })}\n`
        );
        return;
      }

      if (navigation.persona === null) {
        process.stdout.write(
          `Account: ${navigation.accountId}\nPersona: unbound\n`
        );
        return;
      }
      process.stdout.write(
        [
          `Account: ${navigation.accountId}`,
          `Persona: ${navigation.persona.personaUid}`,
          `Lifecycle: ${navigation.persona.lifecycleStatus}`,
          `Profile: ${navigation.persona.profileState}`,
          `Backend: ${navigation.persona.browserBackend}`
        ].join("\n") + "\n"
      );
      return;
    }

    const results = await client.search(args.query);
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, results })}\n`
      );
      return;
    }
    if (results.length === 0) {
      process.stdout.write("No matches.\n");
      return;
    }
    for (const result of results) {
      process.stdout.write(
        `${result.entityType}\t${result.entityId}\t${result.label}\tmatched: ${result.matchedField}\n`
      );
    }
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
