#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  resolvePcmsInstallPaths
} from "./layout.js";

class DesktopLaunchError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(
      message,
      cause === undefined ? undefined : { cause }
    );
    this.name = "DesktopLaunchError";
  }
}

function runSystemctlStart(): void {
  const result = spawnSync(
    "systemctl",
    ["--user", "start", "pcmsd.service"],
    { stdio: "inherit" }
  );
  if (result.error !== undefined) {
    throw new DesktopLaunchError(
      "systemctl could not start PCMS Local",
      result.error
    );
  }
  if (result.status !== 0) {
    throw new DesktopLaunchError(
      `systemctl start failed with status ${result.status ?? "unknown"}`
    );
  }
}

function diagnosticOrigin(
  cliPath: string
): string | null {
  const result = spawnSync(
    cliPath,
    ["diagnostics", "--json"],
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
    return null;
  }

  try {
    const payload = JSON.parse(result.stdout) as unknown;
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      !("ok" in payload) ||
      payload.ok !== true ||
      !("diagnostics" in payload) ||
      typeof payload.diagnostics !== "object" ||
      payload.diagnostics === null ||
      Array.isArray(payload.diagnostics) ||
      !("localApi" in payload.diagnostics) ||
      typeof payload.diagnostics.localApi !== "object" ||
      payload.diagnostics.localApi === null ||
      Array.isArray(payload.diagnostics.localApi) ||
      !("origin" in payload.diagnostics.localApi) ||
      typeof payload.diagnostics.localApi.origin !== "string"
    ) {
      return null;
    }
    const origin = new URL(
      payload.diagnostics.localApi.origin
    );
    if (
      origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== ""
    ) {
      return null;
    }
    return origin.origin;
  } catch {
    return null;
  }
}

async function waitForOrigin(
  cliPath: string
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const origin = diagnosticOrigin(cliPath);
    if (origin !== null) return origin;
    await new Promise<void>((resolveSleep) => {
      setTimeout(resolveSleep, 100);
    });
  }
  throw new DesktopLaunchError(
    "PCMS Local did not become ready for desktop launch"
  );
}

function openBrowser(origin: string): void {
  const result = spawnSync(
    "xdg-open",
    [origin],
    {
      stdio: "ignore",
      env: process.env
    }
  );
  if (result.error !== undefined) {
    throw new DesktopLaunchError(
      "xdg-open is unavailable; open the PCMS Local URL from pcms diagnostics",
      result.error
    );
  }
  if (result.status !== 0) {
    throw new DesktopLaunchError(
      `xdg-open failed with status ${result.status ?? "unknown"}`
    );
  }
}

try {
  const paths = resolvePcmsInstallPaths(homedir());
  runSystemctlStart();
  const origin = await waitForOrigin(
    join(paths.currentLink, "bin", "pcms")
  );
  openBrowser(origin);
} catch (error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : "unknown desktop launch failure";
  process.stderr.write(
    `PCMS desktop launch failed: ${message}\n`
  );
  process.exitCode = 1;
}
