import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MODULE_RPC_PROTOCOL_VERSION,
  ModuleRpcFrameDecoder,
  ModuleRpcProtocolError,
  encodeModuleRpcFrame,
  isModuleRpcMethod,
  type ModuleRpcEnvelope,
  type ModuleRpcErrorPayload,
  type ModuleRpcRequest,
  type ModuleRpcResponse
} from "./rpc.js";

interface RunnerConfig {
  readonly packageRoot: string;
  readonly backendEntry: string;
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly runtimeGeneration: number;
  readonly startupNonce: string;
  readonly maxFrameBytes: number;
  readonly maxOutstandingRequests: number;
}

export interface ModuleRunnerSdk {
  call(method: string, params?: unknown): Promise<unknown>;
}

export interface ModuleBackendContext {
  readonly module: Readonly<{
    id: string;
    version: string;
    runtimeGeneration: number;
  }>;
  readonly sdk: ModuleRunnerSdk;
}

export interface ModuleBackend {
  handle(method: string, params: unknown): unknown | Promise<unknown>;
  shutdown?(): unknown | Promise<unknown>;
}

type ModuleBackendFactory = (
  context: ModuleBackendContext
) => ModuleBackend | Promise<ModuleBackend>;

interface PendingCoreRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: RunnerSdkError) => void;
}

class RunnerSdkError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(payload: ModuleRpcErrorPayload) {
    super(payload.message);
    this.name = "RunnerSdkError";
    this.code = payload.code;
    this.retryable = payload.retryable;
  }
}

function parseArgs(argv: readonly string[]): RunnerConfig {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !key.startsWith("--") ||
      values.has(key)
    ) {
      throw new Error("invalid module-runner arguments");
    }
    values.set(key, value);
  }

  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value.length === 0) {
      throw new Error(`missing module-runner argument: ${name}`);
    }
    return value;
  };
  const positiveInteger = (name: string): number => {
    const raw = required(name);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`invalid positive integer argument: ${name}`);
    }
    return value;
  };

  return Object.freeze({
    packageRoot: required("--package-root"),
    backendEntry: required("--backend-entry"),
    moduleId: required("--module-id"),
    moduleVersion: required("--module-version"),
    runtimeGeneration: positiveInteger("--runtime-generation"),
    startupNonce: required("--startup-nonce"),
    maxFrameBytes: positiveInteger("--max-frame-bytes"),
    maxOutstandingRequests: positiveInteger("--max-outstanding-requests")
  });
}

function resolveEntry(config: RunnerConfig): string {
  if (!isAbsolute(config.packageRoot)) {
    throw new Error("module package root must be absolute");
  }
  if (
    config.backendEntry.startsWith("/") ||
    config.backendEntry.includes("\\") ||
    config.backendEntry.split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    throw new Error("module backend entry must be a normalized relative path");
  }
  const root = resolve(config.packageRoot);
  const entry = resolve(root, config.backendEntry);
  const within = relative(root, entry);
  if (within.startsWith("..") || isAbsolute(within)) {
    throw new Error("module backend entry escapes package root");
  }
  return entry;
}

function errorPayload(error: unknown): ModuleRpcErrorPayload {
  const candidate =
    typeof error === "object" && error !== null
      ? error as { readonly code?: unknown; readonly retryable?: unknown }
      : null;
  return Object.freeze({
    code:
      typeof candidate?.code === "string" &&
      /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate.code)
        ? candidate.code
        : "MODULE_REQUEST_FAILED",
    message: "Module request failed",
    retryable:
      typeof candidate?.retryable === "boolean"
        ? candidate.retryable
        : false
  });
}

function logFailure(event: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      event,
      error: {
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof (error as { readonly code?: unknown }).code === "string"
            ? (error as { readonly code: string }).code
            : "MODULE_RUNNER_FAILURE",
        message: "Module runner failure"
      }
    })}\n`
  );
}

async function run(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const entryPath = resolveEntry(config);
  const decoder = new ModuleRpcFrameDecoder(config.maxFrameBytes);
  const pendingCore = new Map<string, PendingCoreRequest>();
  let nextRequestId = 1;
  let backend: ModuleBackend | null = null;
  let shuttingDown = false;

  const writeEnvelope = (envelope: ModuleRpcEnvelope): Promise<void> => {
    const frame = encodeModuleRpcFrame(envelope, config.maxFrameBytes);
    return new Promise((resolveWrite, rejectWrite) => {
      process.stdout.write(frame, (error?: Error | null) => {
        if (error !== undefined && error !== null) rejectWrite(error);
        else resolveWrite();
      });
    });
  };

  const sdk: ModuleRunnerSdk = Object.freeze({
    async call(method: string, params: unknown = null): Promise<unknown> {
      if (!isModuleRpcMethod(method)) {
        throw new RunnerSdkError({
          code: "INVALID_MODULE_RPC_METHOD",
          message: "module SDK method has invalid syntax",
          retryable: false
        });
      }
      if (pendingCore.size >= config.maxOutstandingRequests) {
        throw new RunnerSdkError({
          code: "MODULE_RPC_BACKPRESSURE",
          message: "module SDK outstanding request limit reached",
          retryable: true
        });
      }

      const requestId = `module:${nextRequestId++}`;
      const request: ModuleRpcRequest = Object.freeze({
        kind: "request",
        protocolVersion: MODULE_RPC_PROTOCOL_VERSION,
        runtimeGeneration: config.runtimeGeneration,
        requestId,
        source: "module",
        method,
        params: params === undefined ? null : params
      });

      const response = new Promise<unknown>((resolveRequest, rejectRequest) => {
        pendingCore.set(requestId, {
          resolve: resolveRequest,
          reject: rejectRequest
        });
      });

      try {
        await writeEnvelope(request);
      } catch (error: unknown) {
        pendingCore.delete(requestId);
        throw error;
      }
      return response;
    }
  });

  const context: ModuleBackendContext = Object.freeze({
    module: Object.freeze({
      id: config.moduleId,
      version: config.moduleVersion,
      runtimeGeneration: config.runtimeGeneration
    }),
    sdk
  });

  const imported = await import(
    `${pathToFileURL(entryPath).href}?pcms_runtime=${encodeURIComponent(config.startupNonce)}`
  ) as { readonly createModule?: unknown };
  if (typeof imported.createModule !== "function") {
    throw new Error("module backend must export createModule(context)");
  }
  const factory = imported.createModule as ModuleBackendFactory;
  const created = await factory(context);
  if (
    typeof created !== "object" ||
    created === null ||
    typeof created.handle !== "function"
  ) {
    throw new Error("createModule(context) must return a backend with handle()");
  }
  backend = created;

  await writeEnvelope(Object.freeze({
    kind: "ready",
    protocolVersion: MODULE_RPC_PROTOCOL_VERSION,
    runtimeGeneration: config.runtimeGeneration,
    startupNonce: config.startupNonce
  }));

  const respond = async (
    requestId: string,
    result?: unknown,
    error?: ModuleRpcErrorPayload
  ): Promise<void> => {
    const response: ModuleRpcResponse = Object.freeze({
      kind: "response",
      protocolVersion: MODULE_RPC_PROTOCOL_VERSION,
      runtimeGeneration: config.runtimeGeneration,
      requestId,
      ...(error === undefined
        ? { result: result === undefined ? null : result }
        : { error })
    });
    await writeEnvelope(response);
  };

  process.stdin.on("data", (chunk: Buffer) => {
    let envelopes: readonly ModuleRpcEnvelope[];
    try {
      envelopes = decoder.push(chunk);
    } catch (error: unknown) {
      logFailure("module_runner.protocol_error", error);
      process.exit(70);
    }

    for (const envelope of envelopes) {
      if (envelope.runtimeGeneration !== config.runtimeGeneration) {
        logFailure(
          "module_runner.protocol_error",
          new ModuleRpcProtocolError("runtime generation mismatch")
        );
        process.exit(70);
      }

      if (envelope.kind === "response") {
        const pending = pendingCore.get(envelope.requestId);
        if (pending === undefined) continue;
        pendingCore.delete(envelope.requestId);
        if (envelope.error !== undefined) {
          pending.reject(new RunnerSdkError(envelope.error));
        } else {
          pending.resolve(envelope.result);
        }
        continue;
      }

      if (envelope.kind !== "request" || envelope.source !== "core") {
        logFailure(
          "module_runner.protocol_error",
          new ModuleRpcProtocolError("Core sent an invalid runner envelope")
        );
        process.exit(70);
      }

      const currentBackend = backend;
      if (currentBackend === null) {
        void respond(
          envelope.requestId,
          undefined,
          {
            code: "MODULE_RUNTIME_NOT_READY",
            message: "module backend is not ready",
            retryable: true
          }
        );
        continue;
      }

      void Promise.resolve()
        .then(() => currentBackend.handle(envelope.method, envelope.params))
        .then(
          (result) => respond(envelope.requestId, result),
          (error: unknown) => respond(
            envelope.requestId,
            undefined,
            errorPayload(error)
          )
        )
        .catch((error: unknown) => {
          logFailure("module_runner.response_failure", error);
          process.exit(70);
        });
    }
  });

  process.stdin.on("end", () => {
    process.exit(0);
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await backend?.shutdown?.();
      process.exit(0);
    } catch (error: unknown) {
      logFailure("module_runner.shutdown_failed", error);
      process.exit(1);
    }
  };

  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.stdin.resume();
}

try {
  await run();
} catch (error: unknown) {
  logFailure("module_runner.start_failed", error);
  process.exitCode = 1;
}
