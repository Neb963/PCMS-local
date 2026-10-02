export const MODULE_RPC_PROTOCOL_VERSION = 1 as const;

export interface ModuleRpcLimits {
  readonly maxFrameBytes: number;
  readonly maxOutstandingRequests: number;
  readonly requestTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly stopTimeoutMs: number;
}

export const DEFAULT_MODULE_RPC_LIMITS: ModuleRpcLimits = Object.freeze({
  maxFrameBytes: 64 * 1024,
  maxOutstandingRequests: 16,
  requestTimeoutMs: 5_000,
  startupTimeoutMs: 2_000,
  stopTimeoutMs: 1_000
});

export interface ModuleRpcErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ModuleRpcRequest {
  readonly kind: "request";
  readonly protocolVersion: typeof MODULE_RPC_PROTOCOL_VERSION;
  readonly runtimeGeneration: number;
  readonly requestId: string;
  readonly source: "core" | "module";
  readonly method: string;
  readonly params: unknown;
}

export interface ModuleRpcResponse {
  readonly kind: "response";
  readonly protocolVersion: typeof MODULE_RPC_PROTOCOL_VERSION;
  readonly runtimeGeneration: number;
  readonly requestId: string;
  readonly result?: unknown;
  readonly error?: ModuleRpcErrorPayload;
}

export interface ModuleRpcReady {
  readonly kind: "ready";
  readonly protocolVersion: typeof MODULE_RPC_PROTOCOL_VERSION;
  readonly runtimeGeneration: number;
  readonly startupNonce: string;
}

export type ModuleRpcEnvelope =
  | ModuleRpcRequest
  | ModuleRpcResponse
  | ModuleRpcReady;

export class ModuleRpcProtocolError extends Error {
  public readonly code = "MODULE_RPC_PROTOCOL_ERROR";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModuleRpcProtocolError";
  }
}

function fail(message: string, cause?: unknown): never {
  throw new ModuleRpcProtocolError(
    message,
    cause === undefined ? undefined : { cause }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail(`${label} contains unknown field: ${key}`);
    }
  }
}

function parseGeneration(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    fail("runtimeGeneration must be a positive safe integer");
  }
  return value;
}

function parseRequestId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 80 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    fail("requestId has invalid syntax");
  }
  return value;
}

export function isModuleRpcMethod(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/.test(value)
  );
}

function parseMethod(value: unknown): string {
  if (typeof value !== "string" || !isModuleRpcMethod(value)) {
    fail("RPC method has invalid syntax");
  }
  return value;
}

function parseError(value: unknown): ModuleRpcErrorPayload {
  if (!isRecord(value)) fail("RPC error must be an object");
  assertExactKeys(value, ["code", "message", "retryable"], "RPC error");
  const code = value["code"];
  const message = value["message"];
  const retryable = value["retryable"];
  if (
    typeof code !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,63}$/.test(code) ||
    typeof message !== "string" ||
    message.length > 512 ||
    typeof retryable !== "boolean"
  ) {
    fail("RPC error payload is invalid");
  }
  return Object.freeze({ code, message, retryable });
}

export function parseModuleRpcEnvelope(value: unknown): ModuleRpcEnvelope {
  if (!isRecord(value)) fail("RPC envelope must be an object");

  const kind = value["kind"];
  if (kind === "ready") {
    assertExactKeys(
      value,
      ["kind", "protocolVersion", "runtimeGeneration", "startupNonce"],
      "ready envelope"
    );
    if (value["protocolVersion"] !== MODULE_RPC_PROTOCOL_VERSION) {
      fail("unsupported module RPC protocol version");
    }
    const startupNonce = value["startupNonce"];
    if (
      typeof startupNonce !== "string" ||
      startupNonce.length < 16 ||
      startupNonce.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(startupNonce)
    ) {
      fail("startupNonce has invalid syntax");
    }
    return Object.freeze({
      kind,
      protocolVersion: MODULE_RPC_PROTOCOL_VERSION,
      runtimeGeneration: parseGeneration(value["runtimeGeneration"]),
      startupNonce
    });
  }

  if (kind === "request") {
    assertExactKeys(
      value,
      [
        "kind",
        "protocolVersion",
        "runtimeGeneration",
        "requestId",
        "source",
        "method",
        "params"
      ],
      "request envelope"
    );
    if (value["protocolVersion"] !== MODULE_RPC_PROTOCOL_VERSION) {
      fail("unsupported module RPC protocol version");
    }
    const source = value["source"];
    if (source !== "core" && source !== "module") {
      fail("request source is invalid");
    }
    return Object.freeze({
      kind,
      protocolVersion: MODULE_RPC_PROTOCOL_VERSION,
      runtimeGeneration: parseGeneration(value["runtimeGeneration"]),
      requestId: parseRequestId(value["requestId"]),
      source,
      method: parseMethod(value["method"]),
      params: value["params"]
    });
  }

  if (kind === "response") {
    assertExactKeys(
      value,
      [
        "kind",
        "protocolVersion",
        "runtimeGeneration",
        "requestId",
        "result",
        "error"
      ],
      "response envelope"
    );
    if (value["protocolVersion"] !== MODULE_RPC_PROTOCOL_VERSION) {
      fail("unsupported module RPC protocol version");
    }
    const hasResult = Object.hasOwn(value, "result");
    const hasError = Object.hasOwn(value, "error");
    if (hasResult === hasError) {
      fail("response must contain exactly one of result or error");
    }
    return Object.freeze({
      kind,
      protocolVersion: MODULE_RPC_PROTOCOL_VERSION,
      runtimeGeneration: parseGeneration(value["runtimeGeneration"]),
      requestId: parseRequestId(value["requestId"]),
      ...(hasResult ? { result: value["result"] } : { error: parseError(value["error"]) })
    });
  }

  fail("RPC envelope kind is invalid");
}

export function encodeModuleRpcFrame(
  envelope: ModuleRpcEnvelope,
  maxFrameBytes: number
): Buffer {
  let json: string;
  try {
    json = JSON.stringify(envelope);
  } catch (error: unknown) {
    fail("RPC envelope is not JSON serializable", error);
  }
  const payload = Buffer.from(json, "utf8");
  if (payload.length < 1 || payload.length > maxFrameBytes) {
    fail(`RPC payload exceeds frame limit of ${maxFrameBytes} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class ModuleRpcFrameDecoder {
  readonly #maxFrameBytes: number;
  #buffer = Buffer.alloc(0);

  public constructor(maxFrameBytes: number) {
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes < 256 ||
      maxFrameBytes > 16 * 1024 * 1024
    ) {
      throw new RangeError("maxFrameBytes must be between 256 and 16777216");
    }
    this.#maxFrameBytes = maxFrameBytes;
  }

  public push(chunk: Uint8Array): readonly ModuleRpcEnvelope[] {
    if (chunk.byteLength === 0) return Object.freeze([]);
    const incoming = Buffer.from(chunk);
    if (this.#buffer.length + incoming.length > this.#maxFrameBytes + 4) {
      fail("RPC buffered bytes exceed frame limit");
    }
    this.#buffer = Buffer.concat([this.#buffer, incoming]);

    const envelopes: ModuleRpcEnvelope[] = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length < 1 || length > this.#maxFrameBytes) {
        fail(`RPC declared frame length ${length} is invalid`);
      }
      const frameEnd = 4 + length;
      if (this.#buffer.length < frameEnd) break;

      const payload = this.#buffer.subarray(4, frameEnd);
      this.#buffer = this.#buffer.subarray(frameEnd);

      let decoded: unknown;
      try {
        decoded = JSON.parse(payload.toString("utf8"));
      } catch (error: unknown) {
        fail("RPC frame contains invalid JSON", error);
      }
      envelopes.push(parseModuleRpcEnvelope(decoded));
    }
    return Object.freeze(envelopes);
  }
}
