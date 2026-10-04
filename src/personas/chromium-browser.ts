import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";

import { PersonaProfileLifecycle } from "./profile-lifecycle.js";
import {
  ChromiumRuntimeRegistry,
  captureChromiumProcessFingerprint,
  inspectChromiumProcessOwnership
} from "./chromium-runtime.js";
import type {
  ChromiumProcessFingerprint,
  ChromiumRuntimeRecord
} from "./chromium-runtime.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const MAX_STDERR_BYTES = 8 * 1024;
const DEVTOOLS_ACTIVE_PORT = "DevToolsActivePort";
const PROTECTED_HOST_RESOLVER_RULES =
  "MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1";
const PROTECTED_WEBRTC_IP_POLICY = "disable_non_proxied_udp";

export type ChromiumBrowserErrorCode =
  | "CHROMIUM_EXECUTABLE_INVALID"
  | "PERSONA_BROWSER_ALREADY_ACTIVE"
  | "PERSONA_BROWSER_OWNERSHIP_AMBIGUOUS"
  | "PERSONA_BROWSER_CAPACITY_EXCEEDED"
  | "CHROMIUM_PROXY_INVALID"
  | "CHROMIUM_PROFILE_PREFERENCES_INVALID"
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

export interface ChromiumProtectedProxy {
  readonly host: "127.0.0.1";
  readonly port: number;
}

export interface ChromiumLaunchOptions {
  readonly initialUrl?: string;
  readonly headless?: boolean;
  readonly protectedProxy?: ChromiumProtectedProxy;
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
  readonly database: DatabaseSync;
  readonly executablePath: string;
  readonly startupTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly maxActivePersonas?: number;
}

export interface ChromiumReconcileResult {
  readonly personaUid: string;
  readonly state: "RUNNING" | "CLOSED" | "DEGRADED";
  readonly session: ChromiumBrowserSession | null;
  readonly detail: string | null;
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

function validateProtectedProxy(
  value: ChromiumProtectedProxy | undefined
): readonly string[] | null {
  if (value === undefined) {
    return null;
  }
  if (
    value.host !== "127.0.0.1" ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535
  ) {
    throw new ChromiumBrowserError(
      "CHROMIUM_PROXY_INVALID",
      "Protected Chromium proxy must be an IPv4 loopback endpoint with a valid port"
    );
  }
  return Object.freeze([
    `--proxy-server=socks5://127.0.0.1:${value.port}`,
    `--host-resolver-rules=${PROTECTED_HOST_RESOLVER_RULES}`,
    "--disable-quic",
    `--force-webrtc-ip-handling-policy=${PROTECTED_WEBRTC_IP_POLICY}`
  ]);
}

async function applyProtectedProfilePreferences(
  profilePath: string
): Promise<void> {
  const defaultProfilePath = join(profilePath, "Default");
  const preferencesPath = join(defaultProfilePath, "Preferences");
  let preferences: Record<string, unknown> = {};

  try {
    const parsed: unknown = JSON.parse(await readFile(preferencesPath, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("Chromium Preferences root is not an object");
    }
    preferences = parsed as Record<string, unknown>;
  } catch (error: unknown) {
    if (systemErrorCode(error) !== "ENOENT") {
      throw new ChromiumBrowserError(
        "CHROMIUM_PROFILE_PREFERENCES_INVALID",
        "Protected Chromium launch cannot safely update profile network preferences",
        error
      );
    }
  }

  const currentWebRtc = preferences["webrtc"];
  if (
    currentWebRtc !== undefined &&
    (typeof currentWebRtc !== "object" ||
      currentWebRtc === null ||
      Array.isArray(currentWebRtc))
  ) {
    throw new ChromiumBrowserError(
      "CHROMIUM_PROFILE_PREFERENCES_INVALID",
      "Protected Chromium launch found an invalid WebRTC preference object"
    );
  }

  preferences["webrtc"] = {
    ...((currentWebRtc ?? {}) as Record<string, unknown>),
    "ip_handling_policy": PROTECTED_WEBRTC_IP_POLICY,
    "multiple_routes_enabled": false,
    "nonproxied_udp_enabled": false
  };

  await mkdir(defaultProfilePath, { recursive: true, mode: 0o700 });
  const temporaryPath = `${preferencesPath}.pcms-${process.pid}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(preferences)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await rename(temporaryPath, preferencesPath);
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new ChromiumBrowserError(
      "CHROMIUM_PROFILE_PREFERENCES_INVALID",
      "Protected Chromium launch could not persist fail-closed WebRTC preferences",
      error
    );
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


async function readProfileDevToolsEndpoint(
  profilePath: string,
  expectedPort?: number,
  expectedPath?: string
): Promise<ChromiumDevToolsEndpoint | null> {
  let parsed: { port: number; browserPath: string } | null;
  try {
    parsed = parseActivePort(
      await readFile(join(profilePath, DEVTOOLS_ACTIVE_PORT), "utf8")
    );
  } catch (error: unknown) {
    if (systemErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }

  if (parsed === null) {
    return null;
  }
  if (
    (expectedPort !== undefined && parsed.port !== expectedPort) ||
    (expectedPath !== undefined && parsed.browserPath !== expectedPath)
  ) {
    throw new ChromiumBrowserError(
      "PERSONA_BROWSER_OWNERSHIP_AMBIGUOUS",
      "Persisted Chromium DevTools evidence does not match the profile-scoped endpoint"
    );
  }

  const httpOrigin = `http://127.0.0.1:${parsed.port}`;
  let response: Response;
  try {
    response = await fetch(`${httpOrigin}/json/version`, {
      signal: AbortSignal.timeout(500)
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
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
  return Object.freeze({
    port: parsed.port,
    httpOrigin,
    webSocketUrl
  });
}

async function waitForFingerprintGone(
  fingerprint: ChromiumProcessFingerprint,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // While Chrome tears itself down, a single /proc evidence read can observe
  // a transient mismatch (the process title churns as the process dies).
  // Tolerate a short bounded window of mismatched reads: the pid is never
  // signalled while evidence is ambiguous, and a mismatch that outlasts the
  // window still fails closed.
  const mismatchGraceMs = 2_000;
  let firstMismatchAt: number | null = null;
  while (Date.now() < deadline) {
    const ownership = await inspectChromiumProcessOwnership(fingerprint);
    if (ownership === "GONE") {
      return true;
    }
    if (ownership === "MISMATCH") {
      if (firstMismatchAt === null) {
        firstMismatchAt = Date.now();
      } else if (Date.now() - firstMismatchAt > mismatchGraceMs) {
        throw new ChromiumBrowserError(
          "PERSONA_BROWSER_OWNERSHIP_AMBIGUOUS",
          "Chromium PID no longer matches persisted ownership evidence"
        );
      }
    } else {
      firstMismatchAt = null;
    }
    await sleep(25);
  }
  if (firstMismatchAt !== null) {
    throw new ChromiumBrowserError(
      "PERSONA_BROWSER_OWNERSHIP_AMBIGUOUS",
      "Chromium PID no longer matches persisted ownership evidence"
    );
  }
  return false;
}

async function signalFingerprint(
  fingerprint: ChromiumProcessFingerprint,
  signal: NodeJS.Signals
): Promise<void> {
  const ownership = await inspectChromiumProcessOwnership(fingerprint);
  if (ownership === "GONE") {
    return;
  }
  if (ownership === "MISMATCH") {
    throw new ChromiumBrowserError(
      "PERSONA_BROWSER_OWNERSHIP_AMBIGUOUS",
      "Refusing to signal a PID that no longer matches persisted Chromium ownership evidence"
    );
  }
  process.kill(fingerprint.pid, signal);
}

async function closeReconciledBrowser(
  fingerprint: ChromiumProcessFingerprint,
  webSocketUrl: string,
  timeoutMs: number
): Promise<void> {
  try {
    await requestBrowserClose(webSocketUrl, timeoutMs);
    if (await waitForFingerprintGone(fingerprint, timeoutMs)) {
      return;
    }
  } catch (error: unknown) {
    if (
      error instanceof ChromiumBrowserError &&
      error.code === "PERSONA_BROWSER_OWNERSHIP_AMBIGUOUS"
    ) {
      throw error;
    }
  }

  await signalFingerprint(fingerprint, "SIGTERM");
  if (await waitForFingerprintGone(fingerprint, timeoutMs)) {
    return;
  }
  await signalFingerprint(fingerprint, "SIGKILL");
  if (await waitForFingerprintGone(fingerprint, timeoutMs)) {
    return;
  }

  throw new ChromiumBrowserError(
    "CHROMIUM_CLOSE_TIMEOUT",
    "Owned reconciled Chromium process did not exit after Browser.close/SIGTERM/SIGKILL"
  );
}

function runtimeFingerprint(
  runtime: ChromiumRuntimeRecord,
  profilePath: string
): ChromiumProcessFingerprint | null {
  if (
    runtime.pid === null ||
    runtime.processStartTicks === null ||
    runtime.executableRealPath === null
  ) {
    return null;
  }
  return Object.freeze({
    pid: runtime.pid,
    processStartTicks: runtime.processStartTicks,
    executableRealPath: runtime.executableRealPath,
    profilePath
  });
}

function devToolsPath(webSocketUrl: string): string {
  return new URL(webSocketUrl).pathname;
}

export class ChromiumBrowserManager {
  readonly #lifecycle: PersonaProfileLifecycle;
  readonly #runtime: ChromiumRuntimeRegistry;
  readonly #executablePath: string;
  readonly #startupTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #maxActivePersonas: number;
  readonly #sessions = new Map<string, ChromiumBrowserSession>();
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
    const maxActivePersonas = options.maxActivePersonas ?? 8;
    if (
      !Number.isSafeInteger(maxActivePersonas) ||
      maxActivePersonas < 1 ||
      maxActivePersonas > 128
    ) {
      throw new RangeError(
        "maxActivePersonas must be an integer between 1 and 128"
      );
    }

    this.#lifecycle = options.lifecycle;
    this.#runtime = new ChromiumRuntimeRegistry(options.database);
    this.#executablePath = options.executablePath;
    this.#startupTimeoutMs =
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#maxActivePersonas = maxActivePersonas;
  }

  public probe(): Promise<ChromiumExecutableProbe> {
    this.#probe ??= probeExecutable(this.#executablePath);
    return this.#probe;
  }

  public async resolveDevToolsEndpoint(
    personaUid: string
  ): Promise<ChromiumDevToolsEndpoint | null> {
    const session = await this.reconcile(personaUid);
    if (session === null) {
      return null;
    }

    const runtime = this.#runtime.get(personaUid);
    const fingerprint =
      runtime === null ? null : runtimeFingerprint(runtime, session.profilePath);
    if (
      runtime === null ||
      fingerprint === null ||
      runtime.devToolsPort === null ||
      runtime.devToolsPath === null
    ) {
      throw this.#ownershipAmbiguous(
        personaUid,
        "Running Persona is missing complete persisted DevTools ownership evidence"
      );
    }

    const ownership = await inspectChromiumProcessOwnership(fingerprint);
    if (ownership === "GONE") {
      this.#runtime.clear(personaUid);
      this.#lifecycle.close(personaUid);
      this.#sessions.delete(personaUid);
      return null;
    }
    if (ownership === "MISMATCH") {
      throw this.#ownershipAmbiguous(
        personaUid,
        "Persisted Chromium process evidence no longer identifies the running Persona"
      );
    }

    const endpoint = await readProfileDevToolsEndpoint(
      session.profilePath,
      runtime.devToolsPort,
      runtime.devToolsPath
    );
    if (endpoint === null) {
      throw this.#ownershipAmbiguous(
        personaUid,
        "Owned Chromium process is alive but its profile-scoped DevTools endpoint is unavailable"
      );
    }

    return endpoint;
  }

  #ownershipAmbiguous(personaUid: string, detail: string): ChromiumBrowserError {
    this.#runtime.markDegraded(personaUid, detail);
    return new ChromiumBrowserError(
      "PERSONA_BROWSER_OWNERSHIP_AMBIGUOUS",
      detail
    );
  }

  #buildSession(
    runtime: ChromiumRuntimeRecord,
    profilePath: string,
    devTools: ChromiumDevToolsEndpoint,
    child: ChildProcess | null
  ): ChromiumBrowserSession {
    const fingerprint = runtimeFingerprint(runtime, profilePath);
    if (
      fingerprint === null ||
      runtime.executablePath === null ||
      runtime.browserVersion === null
    ) {
      throw this.#ownershipAmbiguous(
        runtime.personaUid,
        "Persisted Chromium runtime evidence is incomplete"
      );
    }

    let closed = false;
    let closing = false;
    const personaUid = runtime.personaUid;
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closing = true;
      try {
        if (child === null) {
          await closeReconciledBrowser(
            fingerprint,
            devTools.webSocketUrl,
            this.#closeTimeoutMs
          );
        } else {
          await closeOwnedBrowser(
            child,
            devTools.webSocketUrl,
            this.#closeTimeoutMs
          );
        }
      } catch (error: unknown) {
        closing = false;
        throw error;
      }

      this.#runtime.clear(personaUid);
      this.#lifecycle.close(personaUid);
      this.#sessions.delete(personaUid);
      closed = true;
    };

    const session = Object.freeze({
      personaUid,
      pid: fingerprint.pid,
      profilePath,
      executablePath: runtime.executablePath,
      browserVersion: runtime.browserVersion,
      devTools,
      close
    });

    this.#sessions.set(personaUid, session);

    if (child !== null) {
      child.once("exit", () => {
        if (closing || closed) {
          return;
        }
        const current = this.#runtime.get(personaUid);
        if (
          current !== null &&
          current.pid === fingerprint.pid &&
          current.processStartTicks === fingerprint.processStartTicks
        ) {
          this.#runtime.clear(personaUid);
          this.#lifecycle.close(personaUid);
        }
        this.#sessions.delete(personaUid);
        closed = true;
      });
    }

    return session;
  }

  public async reconcile(
    personaUid: string
  ): Promise<ChromiumBrowserSession | null> {
    const inMemory = this.#sessions.get(personaUid);
    if (inMemory !== undefined) {
      return inMemory;
    }

    const profile = this.#lifecycle.get(personaUid);
    const runtime = this.#runtime.get(personaUid);

    if (runtime === null) {
      if (profile?.profileState === "OPEN") {
        throw this.#ownershipAmbiguous(
          personaUid,
          "Persona profile is OPEN without persisted browser ownership evidence; refusing unsafe attach or relaunch"
        );
      }
      return null;
    }

    if (profile === null) {
      throw new ChromiumBrowserError(
        "PERSONA_BROWSER_OWNERSHIP_AMBIGUOUS",
        "Persisted Chromium runtime references a missing Persona"
      );
    }

    const allocated = await this.#lifecycle.allocate(personaUid);
    const fingerprint = runtimeFingerprint(runtime, allocated.profilePath);
    if (fingerprint === null) {
      if (runtime.state === "STARTING") {
        const liveEndpoint = await readProfileDevToolsEndpoint(
          allocated.profilePath
        );
        if (liveEndpoint === null) {
          this.#runtime.clear(personaUid);
          this.#lifecycle.close(personaUid);
          return null;
        }
      }
      throw this.#ownershipAmbiguous(
        personaUid,
        "Persisted Chromium runtime lacks a complete process fingerprint"
      );
    }

    const ownership = await inspectChromiumProcessOwnership(fingerprint);
    if (ownership === "GONE") {
      this.#runtime.clear(personaUid);
      this.#lifecycle.close(personaUid);
      return null;
    }
    if (ownership === "MISMATCH") {
      throw this.#ownershipAmbiguous(
        personaUid,
        "Persisted Chromium PID/start/executable/profile evidence no longer identifies the same process"
      );
    }

    let devTools: ChromiumDevToolsEndpoint | null;
    if (
      runtime.devToolsPort !== null &&
      runtime.devToolsPath !== null
    ) {
      devTools = await readProfileDevToolsEndpoint(
        allocated.profilePath,
        runtime.devToolsPort,
        runtime.devToolsPath
      );
    } else {
      devTools = await readProfileDevToolsEndpoint(allocated.profilePath);
    }

    if (devTools === null) {
      throw this.#ownershipAmbiguous(
        personaUid,
        "Owned Chromium process is alive but its expected profile-scoped DevTools endpoint is unavailable"
      );
    }

    const running = this.#runtime.markRunning(
      personaUid,
      devTools.port,
      devToolsPath(devTools.webSocketUrl)
    );
    await this.#lifecycle.open(personaUid);
    return this.#buildSession(
      running,
      allocated.profilePath,
      devTools,
      null
    );
  }

  public async reconcileAll(): Promise<readonly ChromiumReconcileResult[]> {
    const personaUids = new Set<string>();
    for (const runtime of this.#runtime.list()) {
      personaUids.add(runtime.personaUid);
    }
    for (const profile of this.#lifecycle.listOpen()) {
      personaUids.add(profile.personaUid);
    }

    const results: ChromiumReconcileResult[] = [];
    for (const personaUid of [...personaUids].sort()) {
      try {
        const session = await this.reconcile(personaUid);
        results.push(Object.freeze({
          personaUid,
          state: session === null ? "CLOSED" : "RUNNING",
          session,
          detail: null
        }));
      } catch (error: unknown) {
        if (
          error instanceof ChromiumBrowserError &&
          error.code === "PERSONA_BROWSER_OWNERSHIP_AMBIGUOUS"
        ) {
          results.push(Object.freeze({
            personaUid,
            state: "DEGRADED",
            session: null,
            detail: error.message
          }));
          continue;
        }
        throw error;
      }
    }
    return Object.freeze(results);
  }

  public async launch(
    personaUid: string,
    options: ChromiumLaunchOptions = {}
  ): Promise<ChromiumBrowserSession> {
    const protectedProxyArgument = validateProtectedProxy(options.protectedProxy);
    const existing = await this.reconcile(personaUid);
    if (existing !== null) {
      if (protectedProxyArgument !== null) {
        throw new ChromiumBrowserError(
          "PERSONA_BROWSER_ALREADY_ACTIVE",
          "Refusing to reuse an already-running Persona for a new protected proxy launch"
        );
      }
      return existing;
    }

    const allocated = await this.#lifecycle.allocate(personaUid);
    const liveUnownedEndpoint = await readProfileDevToolsEndpoint(
      allocated.profilePath
    );
    if (liveUnownedEndpoint !== null) {
      throw this.#ownershipAmbiguous(
        personaUid,
        "Persona profile already exposes a live DevTools endpoint without matching PCMS runtime ownership evidence"
      );
    }

    await this.reconcileAll();
    if (this.#runtime.countActive() >= this.#maxActivePersonas) {
      throw new ChromiumBrowserError(
        "PERSONA_BROWSER_CAPACITY_EXCEEDED",
        `Active Persona cap ${this.#maxActivePersonas} is reached; existing browser sessions were left running`
      );
    }

    let child: ChildProcess | null = null;
    let profileOpened = false;
    let processConfirmedStopped = true;
    let runtimeStarted = false;

    try {
      const probe = await this.probe();
      const initialUrl = validateInitialUrl(options.initialUrl);
      const opened = await this.#lifecycle.open(personaUid);
      profileOpened = true;

      if (protectedProxyArgument !== null) {
        await applyProtectedProfilePreferences(opened.profilePath);
      }

      await rm(join(opened.profilePath, DEVTOOLS_ACTIVE_PORT), {
        force: true
      });
      this.#runtime.begin(personaUid, probe.executablePath, probe.version);
      runtimeStarted = true;

      const args = [
        `--user-data-dir=${opened.profilePath}`,
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
      if (protectedProxyArgument !== null) {
        args.push(...protectedProxyArgument);
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

      const fingerprint = await captureChromiumProcessFingerprint(
        child.pid,
        probe.executablePath,
        opened.profilePath
      );
      this.#runtime.recordProcess(personaUid, fingerprint);

      const devTools = await discoverDevToolsEndpoint(
        child,
        opened.profilePath,
        this.#startupTimeoutMs,
        stderr
      );
      let runtime = this.#runtime.markRunning(
        personaUid,
        devTools.port,
        devToolsPath(devTools.webSocketUrl)
      );

      if (child.exitCode !== null || child.signalCode !== null) {
        this.#runtime.clear(personaUid);
        this.#lifecycle.close(personaUid);
        processConfirmedStopped = true;
        throw new ChromiumBrowserError(
          "CHROMIUM_LAUNCH_FAILED",
          "Chromium exited immediately after DevTools became ready"
        );
      }

      runtime = this.#runtime.get(personaUid) ?? runtime;
      return this.#buildSession(
        runtime,
        opened.profilePath,
        devTools,
        child
      );
    } catch (error: unknown) {
      if (child !== null && processConfirmedStopped === false) {
        try {
          await terminateOwnedProcess(child, this.#closeTimeoutMs);
          processConfirmedStopped = true;
        } catch (cleanupError: unknown) {
          if (runtimeStarted) {
            this.#runtime.markDegraded(
              personaUid,
              "Chromium launch failed and the spawned process could not be confirmed stopped"
            );
          }
          throw new ChromiumBrowserError(
            "CHROMIUM_LAUNCH_FAILED",
            "Chromium launch failed and the owned process could not be confirmed stopped",
            new AggregateError([error, cleanupError])
          );
        }
      }

      if (processConfirmedStopped && runtimeStarted) {
        this.#runtime.clear(personaUid);
      }
      if (profileOpened && processConfirmedStopped) {
        this.#lifecycle.close(personaUid);
      }
      if (processConfirmedStopped) {
        this.#sessions.delete(personaUid);
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
