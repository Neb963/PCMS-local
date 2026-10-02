import { randomBytes } from "node:crypto";
import {
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MODULE_RPC_LIMITS,
  MODULE_RPC_PROTOCOL_VERSION,
  ModuleRpcFrameDecoder,
  ModuleRpcProtocolError,
  encodeModuleRpcFrame,
  isModuleRpcMethod,
  type ModuleRpcEnvelope,
  type ModuleRpcErrorPayload,
  type ModuleRpcLimits,
  type ModuleRpcRequest,
  type ModuleRpcResponse
} from "./rpc.js";

export type ModuleRuntimeState =
  | "STARTING"
  | "RUNNING"
  | "DEGRADED"
  | "STOPPED";

export type ModuleSdkHandler = (params: unknown) => unknown | Promise<unknown>;

export interface StartModuleRuntimeOptions {
  readonly moduleId: string;
  readonly version: string;
  readonly packageRoot: string;
  readonly backendEntry: string;
  readonly runtimeGeneration: number;
  readonly startupNonce?: string;
  readonly sdkHandlers?: Readonly<Record<string, ModuleSdkHandler>>;
  readonly limits?: Partial<ModuleRpcLimits>;
  readonly runnerPath?: string;
}

export class ModuleRuntimeError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(
    code: string,
    message: string,
    retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ModuleRuntimeError";
    this.code = code;
    this.retryable = retryable;
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: ModuleRuntimeError) => void;
  readonly timer: NodeJS.Timeout;
}

const SUPPORTED_SDK_DOMAINS = new Set([
  "accounts",
  "personas",
  "generators",
  "browser",
  "provider",
  "operations",
  "schedules",
  "humanTasks",
  "secrets",
  "http",
  "github",
  "services"
]);

const FORBIDDEN_SDK_SEGMENTS = new Set([
  "raw",
  "db",
  "database",
  "sqlite",
  "router",
  "cdp",
  "process",
  "handle"
]);

export function isSupportedModuleSdkMethod(method: string): boolean {
  if (!isModuleRpcMethod(method)) return false;
  const segments = method.split(/[._-]/);
  const domain = segments[0];
  if (domain === undefined || !SUPPORTED_SDK_DOMAINS.has(domain)) return false;
  return !segments.some((segment) =>
    FORBIDDEN_SDK_SEGMENTS.has(segment.toLowerCase())
  );
}

function resolveLimits(partial: Partial<ModuleRpcLimits> | undefined): ModuleRpcLimits {
  const limits = {
    ...DEFAULT_MODULE_RPC_LIMITS,
    ...partial
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
}

function safePackageEntry(packageRoot: string, backendEntry: string): string {
  if (!isAbsolute(packageRoot)) {
    throw new ModuleRuntimeError(
      "INVALID_MODULE_RUNTIME_CONFIG",
      "packageRoot must be an absolute path"
    );
  }
  if (
    backendEntry.length < 1 ||
    backendEntry.startsWith("/") ||
    backendEntry.includes("\\") ||
    backendEntry.split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new ModuleRuntimeError(
      "INVALID_MODULE_RUNTIME_CONFIG",
      "backendEntry must be a normalized relative package path"
    );
  }
  const root = resolve(packageRoot);
  const entry = resolve(root, backendEntry);
  const within = relative(root, entry);
  if (within.startsWith("..") || isAbsolute(within)) {
    throw new ModuleRuntimeError(
      "INVALID_MODULE_RUNTIME_CONFIG",
      "backendEntry escapes packageRoot"
    );
  }
  return entry;
}

function errorFromPayload(payload: ModuleRpcErrorPayload): ModuleRuntimeError {
  return new ModuleRuntimeError(payload.code, payload.message, payload.retryable);
}

function errorPayload(
  code: string,
  message: string,
  retryable = false
): ModuleRpcErrorPayload {
  return Object.freeze({ code, message, retryable });
}

function runtimeLost(message: string): ModuleRuntimeError {
  return new ModuleRuntimeError("MODULE_RUNTIME_LOST", message, false);
}

class ModuleRuntimeImpl {
  readonly #options: StartModuleRuntimeOptions;
  readonly #limits: ModuleRpcLimits;
  readonly #startupNonce: string;
  readonly #sdkHandlers: ReadonlyMap<string, ModuleSdkHandler>;
  readonly #decoder: ModuleRpcFrameDecoder;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exitPromise: Promise<void>;
  readonly #startupPromise: Promise<void>;
  #resolveExit!: () => void;
  #startupResolve!: () => void;
  #startupReject!: (error: ModuleRuntimeError) => void;
  #startupTimer: NodeJS.Timeout | null = null;
  #state: ModuleRuntimeState = "STARTING";
  #nextRequestId = 1;
  #activeSdkDispatches = 0;
  #intentionalStop = false;
  #stderr = "";

  public constructor(
    options: StartModuleRuntimeOptions,
    limits: ModuleRpcLimits,
    sdkHandlers: ReadonlyMap<string, ModuleSdkHandler>,
    startupNonce: string
  ) {
    this.#options = options;
    this.#limits = limits;
    this.#startupNonce = startupNonce;
    this.#sdkHandlers = sdkHandlers;
    this.#decoder = new ModuleRpcFrameDecoder(limits.maxFrameBytes);
    this.#startupPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.#startupResolve = resolveReady;
      this.#startupReject = rejectReady;
    });

    const runnerPath =
      options.runnerPath ??
      fileURLToPath(new URL("./runner-main.js", import.meta.url));

    this.#child = spawn(
      process.execPath,
      [
        runnerPath,
        "--package-root",
        options.packageRoot,
        "--backend-entry",
        options.backendEntry,
        "--module-id",
        options.moduleId,
        "--module-version",
        options.version,
        "--runtime-generation",
        String(options.runtimeGeneration),
        "--startup-nonce",
        startupNonce,
        "--max-frame-bytes",
        String(limits.maxFrameBytes),
        "--max-outstanding-requests",
        String(limits.maxOutstandingRequests)
      ],
      {
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    this.#exitPromise = new Promise((resolveExit) => {
      this.#resolveExit = resolveExit;
    });

    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#onData(chunk);
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      const next = this.#stderr + chunk.toString("utf8");
      this.#stderr = next.slice(-8_192);
    });
    this.#child.once("error", (error: Error) => {
      this.#onLost(
        new ModuleRuntimeError(
          "MODULE_RUNTIME_START_FAILED",
          `module-runner process error: ${error.message}`,
          false,
          { cause: error }
        )
      );
    });
    this.#startupTimer = setTimeout(() => {
      this.#startupTimer = null;
      this.#protocolFailure(
        new ModuleRuntimeError(
          "MODULE_RUNTIME_START_TIMEOUT",
          "module-runner did not complete startup handshake"
        )
      );
    }, this.#limits.startupTimeoutMs);

    this.#child.once("close", (code, signal) => {
      const detail =
        signal === null
          ? `exit code ${code ?? "unknown"}`
          : `signal ${signal}`;
      if (this.#intentionalStop) {
        this.#state = "STOPPED";
      } else {
        this.#state = "DEGRADED";
      }
      this.#rejectAll(runtimeLost(`module-runner exited with ${detail}`));
      if (this.#startupTimer !== null) {
        clearTimeout(this.#startupTimer);
        this.#startupTimer = null;
      }
      this.#startupReject(
        new ModuleRuntimeError(
          "MODULE_RUNTIME_START_FAILED",
          `module-runner exited before readiness with ${detail}${this.#stderr === "" ? "" : `: ${this.#stderr.trim()}`}`
        )
      );
      this.#resolveExit();
    });
  }

  public get state(): ModuleRuntimeState {
    return this.#state;
  }

  public get pid(): number | undefined {
    return this.#child.pid;
  }

  public get runtimeGeneration(): number {
    return this.#options.runtimeGeneration;
  }

  public async waitUntilReady(): Promise<void> {
    await this.#startupPromise;
  }

  public async request(
    method: string,
    params: unknown,
    timeoutMs = this.#limits.requestTimeoutMs
  ): Promise<unknown> {
    if (this.#state !== "RUNNING") {
      throw runtimeLost(`module runtime is not running (state=${this.#state})`);
    }
    if (!isModuleRpcMethod(method)) {
      throw new ModuleRuntimeError(
        "INVALID_MODULE_RPC_METHOD",
        "module RPC method has invalid syntax"
      );
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000
    ) {
      throw new RangeError("module RPC timeout must be between 1 and 60000 ms");
    }
    if (this.#pending.size >= this.#limits.maxOutstandingRequests) {
      throw new ModuleRuntimeError(
        "MODULE_RPC_BACKPRESSURE",
        "module runtime has reached its outstanding request limit",
        true
      );
    }

    const requestId = `core:${this.#nextRequestId++}`;
    const envelope: ModuleRpcRequest = Object.freeze({
      kind: "request",
      protocolVersion: MODULE_RPC_PROTOCOL_VERSION,
      runtimeGeneration: this.#options.runtimeGeneration,
      requestId,
      source: "core",
      method,
      params: params === undefined ? null : params
    });

    let frame: Buffer;
    try {
      frame = encodeModuleRpcFrame(envelope, this.#limits.maxFrameBytes);
    } catch (error: unknown) {
      if (error instanceof ModuleRpcProtocolError) {
        throw new ModuleRuntimeError(
          "MODULE_RPC_PAYLOAD_TOO_LARGE",
          error.message,
          false,
          { cause: error }
        );
      }
      throw error;
    }

    const result = new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        rejectRequest(
          new ModuleRuntimeError(
            "MODULE_RPC_TIMEOUT",
            `module RPC request timed out: ${method}`,
            true
          )
        );
      }, timeoutMs);
      this.#pending.set(requestId, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer
      });
    });

    try {
      await this.#writeFrame(frame);
    } catch (error: unknown) {
      const pending = this.#pending.get(requestId);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(requestId);
        pending.reject(runtimeLost("module-runner IPC write failed"));
      }
      throw error;
    }
    return result;
  }

  public async stop(): Promise<void> {
    if (this.#state === "STOPPED") return;
    this.#intentionalStop = true;
    this.#child.kill("SIGTERM");

    const timeout = new Promise<void>((resolveTimeout) => {
      setTimeout(() => {
        if (this.#state !== "STOPPED") {
          this.#child.kill("SIGKILL");
        }
        resolveTimeout();
      }, this.#limits.stopTimeoutMs);
    });
    await Promise.race([this.#exitPromise, timeout]);
    await this.#exitPromise;
  }

  #onData(chunk: Buffer): void {
    let envelopes: readonly ModuleRpcEnvelope[];
    try {
      envelopes = this.#decoder.push(chunk);
    } catch (error: unknown) {
      const protocolError =
        error instanceof Error ? error.message : "unknown RPC framing failure";
      this.#protocolFailure(
        new ModuleRuntimeError(
          "MODULE_RPC_PROTOCOL_ERROR",
          protocolError,
          false,
          error instanceof Error ? { cause: error } : undefined
        )
      );
      return;
    }
    for (const envelope of envelopes) {
      this.#onEnvelope(envelope);
    }
  }

  #onEnvelope(envelope: ModuleRpcEnvelope): void {
    if (envelope.runtimeGeneration !== this.#options.runtimeGeneration) {
      this.#protocolFailure(
        new ModuleRuntimeError(
          "MODULE_RPC_PROTOCOL_ERROR",
          "module-runner sent a mismatched runtime generation"
        )
      );
      return;
    }

    if (envelope.kind === "ready") {
      if (
        this.#state !== "STARTING" ||
        envelope.startupNonce !== this.#startupNonce
      ) {
        this.#protocolFailure(
          new ModuleRuntimeError(
            "MODULE_RPC_PROTOCOL_ERROR",
            "module-runner readiness handshake is invalid"
          )
        );
        return;
      }
      if (this.#startupTimer !== null) {
        clearTimeout(this.#startupTimer);
        this.#startupTimer = null;
      }
      this.#state = "RUNNING";
      this.#startupResolve();
      return;
    }

    if (envelope.kind === "response") {
      const pending = this.#pending.get(envelope.requestId);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(envelope.requestId);
      if (envelope.error !== undefined) {
        pending.reject(errorFromPayload(envelope.error));
      } else {
        pending.resolve(envelope.result);
      }
      return;
    }

    if (envelope.source !== "module") {
      this.#protocolFailure(
        new ModuleRuntimeError(
          "MODULE_RPC_PROTOCOL_ERROR",
          "module-runner may only originate module SDK requests"
        )
      );
      return;
    }
    void this.#dispatchSdkRequest(envelope);
  }

  async #dispatchSdkRequest(envelope: ModuleRpcRequest): Promise<void> {
    if (this.#activeSdkDispatches >= this.#limits.maxOutstandingRequests) {
      await this.#sendResponse(
        envelope.requestId,
        undefined,
        errorPayload(
          "MODULE_RPC_BACKPRESSURE",
          "Core SDK dispatch limit reached",
          true
        )
      );
      return;
    }

    const handler = this.#sdkHandlers.get(envelope.method);
    if (handler === undefined) {
      await this.#sendResponse(
        envelope.requestId,
        undefined,
        errorPayload(
          "MODULE_SDK_METHOD_DENIED",
          `module SDK method is not approved: ${envelope.method}`
        )
      );
      return;
    }

    this.#activeSdkDispatches += 1;
    try {
      const result = await handler(envelope.params);
      await this.#sendResponse(
        envelope.requestId,
        result === undefined ? null : result
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Core SDK handler failed";
      await this.#sendResponse(
        envelope.requestId,
        undefined,
        errorPayload("MODULE_SDK_REQUEST_FAILED", message)
      );
    } finally {
      this.#activeSdkDispatches -= 1;
    }
  }

  async #sendResponse(
    requestId: string,
    result?: unknown,
    error?: ModuleRpcErrorPayload
  ): Promise<void> {
    const envelope: ModuleRpcResponse = Object.freeze({
      kind: "response",
      protocolVersion: MODULE_RPC_PROTOCOL_VERSION,
      runtimeGeneration: this.#options.runtimeGeneration,
      requestId,
      ...(error === undefined
        ? { result: result === undefined ? null : result }
        : { error })
    });
    let frame: Buffer;
    try {
      frame = encodeModuleRpcFrame(envelope, this.#limits.maxFrameBytes);
    } catch (encodeError: unknown) {
      this.#protocolFailure(
        new ModuleRuntimeError(
          "MODULE_RPC_PROTOCOL_ERROR",
          "Core SDK response exceeded the RPC boundary",
          false,
          encodeError instanceof Error ? { cause: encodeError } : undefined
        )
      );
      return;
    }
    await this.#writeFrame(frame);
  }

  #writeFrame(frame: Buffer): Promise<void> {
    return new Promise((resolveWrite, rejectWrite) => {
      if (this.#child.stdin.destroyed) {
        rejectWrite(runtimeLost("module-runner IPC is closed"));
        return;
      }
      this.#child.stdin.write(frame, (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          rejectWrite(
            new ModuleRuntimeError(
              "MODULE_RUNTIME_LOST",
              `module-runner IPC write failed: ${error.message}`,
              false,
              { cause: error }
            )
          );
          return;
        }
        resolveWrite();
      });
    });
  }

  #protocolFailure(error: ModuleRuntimeError): void {
    if (this.#state === "STOPPED" || this.#state === "DEGRADED") return;
    this.#state = "DEGRADED";
    this.#rejectAll(runtimeLost(error.message));
    this.#startupReject(error);
    this.#child.kill("SIGKILL");
  }

  #onLost(error: ModuleRuntimeError): void {
    if (!this.#intentionalStop) this.#state = "DEGRADED";
    this.#rejectAll(error);
    this.#startupReject(error);
  }

  #rejectAll(error: ModuleRuntimeError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export interface ModuleRuntime {
  readonly state: ModuleRuntimeState;
  readonly pid: number | undefined;
  readonly runtimeGeneration: number;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  stop(): Promise<void>;
}

export async function startModuleRuntime(
  options: StartModuleRuntimeOptions
): Promise<ModuleRuntime> {
  if (
    !Number.isSafeInteger(options.runtimeGeneration) ||
    options.runtimeGeneration < 1
  ) {
    throw new ModuleRuntimeError(
      "INVALID_MODULE_RUNTIME_CONFIG",
      "runtimeGeneration must be a positive safe integer"
    );
  }
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(options.moduleId)) {
    throw new ModuleRuntimeError(
      "INVALID_MODULE_RUNTIME_CONFIG",
      "moduleId has invalid syntax"
    );
  }
  if (options.version.length < 1 || options.version.length > 128) {
    throw new ModuleRuntimeError(
      "INVALID_MODULE_RUNTIME_CONFIG",
      "module version is invalid"
    );
  }

  const backendPath = safePackageEntry(options.packageRoot, options.backendEntry);
  const backendStat = await stat(backendPath);
  if (!backendStat.isFile()) {
    throw new ModuleRuntimeError(
      "INVALID_MODULE_RUNTIME_CONFIG",
      "module backend entry is not a regular file"
    );
  }

  const handlers = new Map<string, ModuleSdkHandler>();
  for (const [method, handler] of Object.entries(options.sdkHandlers ?? {})) {
    if (!isSupportedModuleSdkMethod(method)) {
      throw new ModuleRuntimeError(
        "INVALID_MODULE_SDK_METHOD",
        `unsupported module SDK method: ${method}`
      );
    }
    if (typeof handler !== "function") {
      throw new ModuleRuntimeError(
        "INVALID_MODULE_SDK_METHOD",
        `module SDK handler must be callable: ${method}`
      );
    }
    handlers.set(method, handler);
  }

  const startupNonce =
    options.startupNonce ?? randomBytes(24).toString("base64url");
  if (
    startupNonce.length < 16 ||
    startupNonce.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(startupNonce)
  ) {
    throw new ModuleRuntimeError(
      "INVALID_MODULE_RUNTIME_CONFIG",
      "startupNonce has invalid syntax"
    );
  }

  const runtime = new ModuleRuntimeImpl(
    options,
    resolveLimits(options.limits),
    handlers,
    startupNonce
  );
  await runtime.waitUntilReady();
  return runtime;
}
