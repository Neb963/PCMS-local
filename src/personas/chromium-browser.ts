import { constants as fsConstants } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { PersonaProfileLifecycle } from "./profile-lifecycle.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const MAX_STDERR_BYTES = 8 * 1024;
const DEVTOOLS_ACTIVE_PORT = "DevToolsActivePort";

export type ChromiumBrowserErrorCode =
  | "CHROMIUM_EXECUTABLE_INVALID"
  | "PERSONA_BROWSER_ALREADY_ACTIVE"
  | "CHROMIUM_INITIAL_URL_INVALID"
  | "CHROMIUM_LAUNCH_FAILED"
  | "CHROMIUM_DEVTOOLS_TIMEOUT"
  | "CHROMIUM_DEVTOOLS_INVALID"
  | "CHROMIUM_CLOSE_TIMEOUT";

export class ChromiumBrowserError extends Error {
  public constructor(
    public readonly code: ChromiumBrowserErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ChromiumBrowserError";
  }
}

export interface ChromiumExecutableProbe {
  readonly executablePath: string;
  readonly version: string;
}

export interface ChromiumDevToolsEndpoint {
  readonly port: number;
  readonly httpOrigin: string;
  readonly webSocketUrl: string;
}

export interface ChromiumLaunchOptions {
  readonly initialUrl?: string;
  readonly headless?: boolean;
  /**
   * CI-only escape hatch for Linux runners where the Chrome sandbox cannot start.
   * Production callers should leave this false/undefined.
   */
  readonly disableSandboxForTesting?: boolean;
}

export interface ChromiumBrowserSession {
  readonly personaUid: string;
  readonly pid: number;
  readonly profilePath: string;
  readonly executablePath: string;
  readonly browserVersion: string;
  readonly devTools: ChromiumDevToolsEndpoint;
  close(): Promise<void>;
}

export interface ChromiumBrowserManagerOptions {
  readonly lifecycle: PersonaProfileLifecycle;
  readonly executablePath: string;
  readonly startupTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

interface RuntimeWebSocket {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
}

type RuntimeWebSocketConstructor = new (url: string) => RuntimeWebSocket;

interface DevToolsVersionPayload {
  readonly webSocketDebuggerUrl?: unknown;
}

function systemErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateTimeout(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 120_000) {
    throw new RangeError(`${label} must be an integer between 1 and 120000 ms`);
  }
}

function validateInitialUrl(value: string | undefined): string {
  if (value === undefined || value === "about:blank") {
    return "about:blank";
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error: unknown) {
    throw new ChromiumBrowserError(
      "CHROMIUM_INITIAL_URL_INVALID",
      "Chromium initial URL must be a valid absolute http(s) URL or about:blank",
      error
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ChromiumBrowserError(
      "CHROMIUM_INITIAL_URL_INVALID",
      "Chromium initial URL must use http or https"
    );
  }
  return parsed.href;
}

async function probeExecutable(executablePath: string): Promise<ChromiumExecutableProbe> {
  if (!isAbsolute(executablePath)) {
    throw new ChromiumBrowserError(
      "CHROMIUM_EXECUTABLE_INVALID",
      "Chromium executable path must be absolute"
    );
  }

  try {
    await access(executablePath, fsConstants.X_OK);
  } catch (error: unknown) {
    throw new ChromiumBrowserError(
      "CHROMIUM_EXECUTABLE_INVALID",
      "Configured Chromium executable is not executable",
      error
    );
  }

  const version = await new Promise<string>((resolve, reject) => {
    execFile(
      executablePath,
      ["--version"],
      {
        timeout: 5_000,
        maxBuffer: 8 * 1024,
        encoding: "utf8"
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        const normalized = stdout.trim();
        if (normalized === "") {
          reject(new Error("Chromium --version returned empty output"));
          return;
        }
        resolve(normalized);
      }
    );
  }).catch((error: unknown) => {
    throw new ChromiumBrowserError(
      "CHROMIUM_EXECUTABLE_INVALID",
      "Configured Chromium executable failed capability probing",
      error
    );
  });

  return Object.freeze({ executablePath, version });
}

function collectBoundedStderr(child: ChildProcess): () => string {
  let stderr = "";
  if (child.stderr !== null) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length >= MAX_STDERR_BYTES) {
        return;
      }
      stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
    });
  }
  return () => stderr.trim();
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateOwnedProcess(
  child: ChildProcess,
  timeoutMs: number
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  if (await waitForExit(child, timeoutMs)) {
    return;
  }

  child.kill("SIGKILL");
  if (await waitForExit(child, timeoutMs)) {
    return;
  }

  throw new ChromiumBrowserError(
    "CHROMIUM_CLOSE_TIMEOUT",
    "Owned Chromium process did not exit after SIGTERM/SIGKILL"
  );
}

function requestBrowserClose(
  webSocketUrl: string,
  timeoutMs: number
): Promise<void> {
  const constructor = (
    globalThis as unknown as { WebSocket?: RuntimeWebSocketConstructor }
  ).WebSocket;
  if (constructor === undefined) {
    return Promise.reject(new Error("Node runtime does not provide WebSocket"));
  }

  return new Promise((resolve, reject) => {
    const socket = new constructor(webSocketUrl);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.onopen = null;
      socket.onerror = null;
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out opening DevTools WebSocket")),
      Math.min(timeoutMs, 2_000)
    );

    socket.onerror = () => {
      finish(new Error("DevTools WebSocket failed before Browser.close"));
    };
    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
        finish();
      } catch (error: unknown) {
        finish(
          error instanceof Error
            ? error
            : new Error("Failed to send Browser.close")
        );
      }
    };
  });
}

async function closeOwnedBrowser(
  child: ChildProcess,
  webSocketUrl: string,
  timeoutMs: number
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    await requestBrowserClose(webSocketUrl, timeoutMs);
    if (await waitForExit(child, timeoutMs)) {
      return;
    }
  } catch {
    // Bounded signal escalation below remains restricted to our known child.
  }

  await terminateOwnedProcess(child, timeoutMs);
}

function parseActivePort(content: string): { port: number; browserPath: string } | null {
  const [portLine, browserPath] = content.trim().split(/\r?\n/u);
  if (portLine === undefined || browserPath === undefined) {
    return null;
  }

  const port = Number(portLine);
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !browserPath.startsWith("/devtools/browser/")
  ) {
    return null;
  }

  return { port, browserPath };
}

function validateWebSocketUrl(
  raw: string,
  expectedPort: number,
  expectedPath: string
): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error: unknown) {
    throw new ChromiumBrowserError(
      "CHROMIUM_DEVTOOLS_INVALID",
      "Chromium reported an invalid DevTools WebSocket URL",
      error
    );
  }

  if (
    parsed.protocol !== "ws:" ||
    parsed.hostname !== "127.0.0.1" ||
    Number(parsed.port) !== expectedPort ||
    parsed.pathname !== expectedPath
  ) {
    throw new ChromiumBrowserError(
      "CHROMIUM_DEVTOOLS_INVALID",
      "Chromium DevTools endpoint is not the expected loopback/profile-scoped endpoint"
    );
  }

  return parsed.href;
}

async function discoverDevToolsEndpoint(
  child: ChildProcess,
  profilePath: string,
  startupTimeoutMs: number,
  stderr: () => string
): Promise<ChromiumDevToolsEndpoint> {
  const activePortPath = join(profilePath, DEVTOOLS_ACTIVE_PORT);
  const deadline = Date.now() + startupTimeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new ChromiumBrowserError(
        "CHROMIUM_LAUNCH_FAILED",
        `Chromium exited before DevTools became ready${stderr() === "" ? "" : `: ${stderr()}`}`
      );
    }

    try {
      const parsed = parseActivePort(await readFile(activePortPath, "utf8"));
      if (parsed !== null) {
        const httpOrigin = `http://127.0.0.1:${parsed.port}`;
        const response = await fetch(`${httpOrigin}/json/version`, {
          signal: AbortSignal.timeout(500)
        });
        if (!response.ok) {
          throw new Error(`DevTools version endpoint returned HTTP ${response.status}`);
        }

        const payload = await response.json() as DevToolsVersionPayload;
        if (typeof payload.webSocketDebuggerUrl !== "string") {
          throw new ChromiumBrowserError(
            "CHROMIUM_DEVTOOLS_INVALID",
            "Chromium DevTools version payload omitted webSocketDebuggerUrl"
          );
        }

        const webSocketUrl = validateWebSocketUrl(
          payload.webSocketDebuggerUrl,
          parsed.port,
          parsed.browserPath
        );
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new ChromiumBrowserError(
            "CHROMIUM_LAUNCH_FAILED",
            "Chromium exited while its DevTools endpoint was being verified"
          );
        }

        return Object.freeze({
          port: parsed.port,
          httpOrigin,
          webSocketUrl
        });
      }
    } catch (error: unknown) {
      if (systemErrorCode(error) !== "ENOENT") {
        lastError = error;
      }
    }

    await sleep(25);
  }

  throw new ChromiumBrowserError(
    "CHROMIUM_DEVTOOLS_TIMEOUT",
    `Timed out waiting for profile-scoped DevTools endpoint${stderr() === "" ? "" : `: ${stderr()}`}`,
    lastError
  );
}

export class ChromiumBrowserManager {
  readonly #lifecycle: PersonaProfileLifecycle;
  readonly #executablePath: string;
  readonly #startupTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #claimedPersonas = new Set<string>();
  #probe: Promise<ChromiumExecutableProbe> | null = null;

  public constructor(options: ChromiumBrowserManagerOptions) {
    validateTimeout(
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      "startupTimeoutMs"
    );
    validateTimeout(
      options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      "closeTimeoutMs"
    );
    this.#lifecycle = options.lifecycle;
    this.#executablePath = options.executablePath;
    this.#startupTimeoutMs =
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  }

  public probe(): Promise<ChromiumExecutableProbe> {
    this.#probe ??= probeExecutable(this.#executablePath);
    return this.#probe;
  }

  public async launch(
    personaUid: string,
    options: ChromiumLaunchOptions = {}
  ): Promise<ChromiumBrowserSession> {
    if (this.#claimedPersonas.has(personaUid)) {
      throw new ChromiumBrowserError(
        "PERSONA_BROWSER_ALREADY_ACTIVE",
        `Persona ${personaUid} already has an active or starting Chromium process in this BrowserManager`
      );
    }
    this.#claimedPersonas.add(personaUid);

    let child: ChildProcess | null = null;
    let profileOpened = false;
    let processConfirmedStopped = true;

    try {
      const probe = await this.probe();
      const initialUrl = validateInitialUrl(options.initialUrl);
      const allocated = await this.#lifecycle.open(personaUid);
      profileOpened = true;

      await rm(join(allocated.profilePath, DEVTOOLS_ACTIVE_PORT), {
        force: true
      });

      const args = [
        `--user-data-dir=${allocated.profilePath}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-component-update",
        "--disable-sync",
        "--metrics-recording-only"
      ];
      if (options.headless === true) {
        args.push("--headless=new");
      }
      if (options.disableSandboxForTesting === true) {
        args.push("--no-sandbox");
      }
      args.push(initialUrl);

      child = spawn(probe.executablePath, args, {
        stdio: ["ignore", "ignore", "pipe"]
      });
      processConfirmedStopped = false;
      const stderr = collectBoundedStderr(child);
      await waitForSpawn(child);

      if (child.pid === undefined) {
        throw new ChromiumBrowserError(
          "CHROMIUM_LAUNCH_FAILED",
          "Chromium process spawned without a PID"
        );
      }

      const devTools = await discoverDevToolsEndpoint(
        child,
        allocated.profilePath,
        this.#startupTimeoutMs,
        stderr
      );

      const pid = child.pid;
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) {
          return;
        }
        await closeOwnedBrowser(
          child as ChildProcess,
          devTools.webSocketUrl,
          this.#closeTimeoutMs
        );
        processConfirmedStopped = true;
        this.#lifecycle.close(personaUid);
        this.#claimedPersonas.delete(personaUid);
        closed = true;
      };

      return Object.freeze({
        personaUid,
        pid,
        profilePath: allocated.profilePath,
        executablePath: probe.executablePath,
        browserVersion: probe.version,
        devTools,
        close
      });
    } catch (error: unknown) {
      if (child !== null && processConfirmedStopped === false) {
        try {
          await terminateOwnedProcess(child, this.#closeTimeoutMs);
          processConfirmedStopped = true;
        } catch (cleanupError: unknown) {
          throw new ChromiumBrowserError(
            "CHROMIUM_LAUNCH_FAILED",
            "Chromium launch failed and the owned process could not be confirmed stopped",
            new AggregateError([error, cleanupError])
          );
        }
      }

      if (profileOpened && processConfirmedStopped) {
        this.#lifecycle.close(personaUid);
      }
      if (processConfirmedStopped) {
        this.#claimedPersonas.delete(personaUid);
      }

      if (error instanceof ChromiumBrowserError) {
        throw error;
      }
      throw new ChromiumBrowserError(
        "CHROMIUM_LAUNCH_FAILED",
        "Chromium launch failed",
        error
      );
    }
  }
}
