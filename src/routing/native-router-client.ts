import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";

export const DEFAULT_NATIVE_ROUTER_SOCKET_PATH =
  "/run/persona-mullvad-router/control.sock";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const ENTRY_ID_RE = /^[A-Za-z0-9._-]{1,140}$/;
const ROUTE_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const CHROMIUM_LEASE_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const CHROMIUM_LEASE_TTL_MIN_SECONDS = 1;
const CHROMIUM_LEASE_TTL_MAX_SECONDS = 5 * 60;
const CHROMIUM_LEASE_GENERATION_MAX = 2 ** 31 - 1;

type RouterCommand =
  | "ping"
  | "status"
  | "list_entries"
  | "ensure_up"
  | "stop"
  | "restart"
  | "set_entry"
  | "prepare_chromium_exit"
  | "release_chromium_exit";

export type NativeRouterClientErrorCode =
  | "INVALID_ROUTER_CLIENT_CONFIG"
  | "INVALID_ROUTER_REQUEST"
  | "ROUTER_UNAVAILABLE"
  | "ROUTER_ACCESS_DENIED"
  | "ROUTER_TIMEOUT"
  | "ROUTER_RESPONSE_TOO_LARGE"
  | "ROUTER_PROTOCOL_ERROR"
  | "ROUTER_REJECTED";

export class NativeRouterClientError extends Error {
  public readonly code: NativeRouterClientErrorCode;
  public readonly retryable: boolean;
  public readonly operation: RouterCommand | null;

  public constructor(
    code: NativeRouterClientErrorCode,
    message: string,
    retryable: boolean,
    operation: RouterCommand | null,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "NativeRouterClientError";
    this.code = code;
    this.retryable = retryable;
    this.operation = operation;
  }
}

export interface RouterPing {
  readonly version: string;
}

export interface RouterExitStatus {
  readonly routeId: string;
  readonly relayIp: string;
  readonly relayPort: number;
  readonly localHost: "127.0.0.1";
  readonly localPort: number;
}

export interface RouterStatus {
  readonly version: string;
  readonly selectedEntry: string | null;
  readonly interfaceName: string;
  readonly interfaceUp: boolean;
  readonly baseProxyReachable: boolean;
  readonly baseRouteBound: boolean;
  readonly latestHandshakeEpoch: number | null;
  readonly latestHandshakeAgeSeconds: number | null;
  readonly ready: boolean;
  readonly mullvadAppConnected: boolean;
  readonly activeExits: readonly RouterExitStatus[];
}

export interface RouterEntryList {
  readonly entries: readonly string[];
  readonly selectedEntry: string | null;
}

export interface ChromiumExitLease {
  readonly ready: true;
  readonly routeId: string;
  readonly relayIp: string;
  readonly relayPort: number;
  readonly localHost: "127.0.0.1";
  readonly localPort: number;
  readonly leaseId: string;
  readonly leaseGeneration: number;
  readonly leaseTtlSeconds: number;
  readonly selectedEntry: string | null;
}

export interface ChromiumExitRequest {
  readonly routeId: string;
  readonly relayIp: string;
  readonly relayPort?: number;
  readonly start?: boolean;
  readonly leaseId: string;
  readonly leaseGeneration: number;
  readonly leaseTtlSeconds?: number;
}

export interface ChromiumExitRelease {
  readonly released: boolean;
}

export interface NativeRouterClient {
  ping(): Promise<RouterPing>;
  status(): Promise<RouterStatus>;
  listEntries(): Promise<RouterEntryList>;
  ensureUp(): Promise<RouterStatus>;
  stop(): Promise<RouterStatus>;
  restart(): Promise<RouterStatus>;
  setEntry(entryId: string, start?: boolean): Promise<RouterStatus>;
  prepareChromiumExit(request: ChromiumExitRequest): Promise<ChromiumExitLease>;
  releaseChromiumExit(
    routeId: string,
    leaseId: string,
    leaseGeneration: number
  ): Promise<ChromiumExitRelease>;
}

export interface NativeRouterClientOptions {
  readonly socketPath?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly requestIdFactory?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configError(message: string): NativeRouterClientError {
  return new NativeRouterClientError(
    "INVALID_ROUTER_CLIENT_CONFIG",
    message,
    false,
    null
  );
}

function protocolError(
  operation: RouterCommand,
  message: string,
  options?: ErrorOptions
): NativeRouterClientError {
  return new NativeRouterClientError(
    "ROUTER_PROTOCOL_ERROR",
    message,
    false,
    operation,
    options
  );
}

function requestError(
  operation: RouterCommand,
  message: string
): NativeRouterClientError {
  return new NativeRouterClientError(
    "INVALID_ROUTER_REQUEST",
    message,
    false,
    operation
  );
}

function validateSocketPath(value: string): string {
  if (
    !isAbsolute(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 4096
  ) {
    throw configError("Router control socket path must be a bounded absolute path");
  }
  return value;
}

function validateTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 120_000) {
    throw configError("Router client timeout must be an integer from 10 to 120000 ms");
  }
  return value;
}

function validateMaxResponseBytes(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 128 ||
    value > MAX_RESPONSE_LIMIT_BYTES
  ) {
    throw configError(
      "Router client response limit must be an integer from 128 bytes to 2 MiB"
    );
  }
  return value;
}

function validateRequestId(value: string): string {
  if (!REQUEST_ID_RE.test(value)) {
    throw configError("Router request ID factory returned an invalid identifier");
  }
  return value;
}

function systemErrorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
}

function mapSocketError(
  operation: RouterCommand,
  socketPath: string,
  error: unknown
): NativeRouterClientError {
  const code = systemErrorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return new NativeRouterClientError(
      "ROUTER_ACCESS_DENIED",
      `Access to router control socket ${socketPath} was denied`,
      false,
      operation,
      { cause: error }
    );
  }

  return new NativeRouterClientError(
    "ROUTER_UNAVAILABLE",
    `Unable to reach router control socket ${socketPath}`,
    true,
    operation,
    { cause: error }
  );
}

function encodeRequest(
  operation: RouterCommand,
  requestId: string,
  payload: Readonly<Record<string, unknown>>
): string {
  const wire = `${JSON.stringify({
    command: operation,
    id: requestId,
    ...payload
  })}\n`;
  if (Buffer.byteLength(wire, "utf8") > MAX_REQUEST_BYTES) {
    throw requestError(operation, "Router request exceeds the client request limit");
  }
  return wire;
}

function parseEnvelope(
  operation: RouterCommand,
  expectedRequestId: string,
  raw: string
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error: unknown) {
    throw protocolError(
      operation,
      "Router daemon returned invalid JSON",
      { cause: error }
    );
  }

  if (!isRecord(value)) {
    throw protocolError(operation, "Router daemon response must be an object");
  }
  if (value["id"] !== expectedRequestId) {
    throw protocolError(operation, "Router daemon response correlation ID mismatch");
  }
  if (value["ok"] === false) {
    const remoteMessage = value["error"];
    if (typeof remoteMessage !== "string" || remoteMessage.length === 0) {
      throw protocolError(operation, "Router daemon rejection omitted an error message");
    }
    throw new NativeRouterClientError(
      "ROUTER_REJECTED",
      remoteMessage,
      false,
      operation
    );
  }
  if (value["ok"] !== true) {
    throw protocolError(operation, "Router daemon response omitted ok=true");
  }
  return value;
}

function readString(
  value: Record<string, unknown>,
  key: string,
  operation: RouterCommand
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw protocolError(operation, `Router response field ${key} must be a non-empty string`);
  }
  return field;
}

function readNullableString(
  value: Record<string, unknown>,
  key: string,
  operation: RouterCommand
): string | null {
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== "string" || field.length === 0) {
    throw protocolError(operation, `Router response field ${key} must be a string or null`);
  }
  return field;
}

function readBoolean(
  value: Record<string, unknown>,
  key: string,
  operation: RouterCommand
): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw protocolError(operation, `Router response field ${key} must be boolean`);
  }
  return field;
}

function readInteger(
  value: Record<string, unknown>,
  key: string,
  operation: RouterCommand,
  minimum: number,
  maximum: number
): number {
  const field = value[key];
  if (
    typeof field !== "number" ||
    !Number.isSafeInteger(field) ||
    field < minimum ||
    field > maximum
  ) {
    throw protocolError(operation, `Router response field ${key} is out of range`);
  }
  return field;
}

function readNullableNonnegativeInteger(
  value: Record<string, unknown>,
  key: string,
  operation: RouterCommand
): number | null {
  if (value[key] === null) return null;
  return readInteger(value, key, operation, 0, Number.MAX_SAFE_INTEGER);
}

function parsePing(
  value: Record<string, unknown>,
  operation: RouterCommand
): RouterPing {
  return Object.freeze({
    version: readString(value, "version", operation)
  });
}

function parseStatus(
  value: Record<string, unknown>,
  operation: RouterCommand
): RouterStatus {
  const rawExits = value["active_exits"];
  if (!Array.isArray(rawExits)) {
    throw protocolError(operation, "Router response active_exits must be an array");
  }

  const activeExits = rawExits.map((rawExit): RouterExitStatus => {
    if (!isRecord(rawExit)) {
      throw protocolError(operation, "Router active exit must be an object");
    }
    const localHost = readString(rawExit, "local_host", operation);
    if (localHost !== "127.0.0.1") {
      throw protocolError(operation, "Router active exit must bind IPv4 loopback");
    }
    return Object.freeze({
      routeId: readString(rawExit, "route_id", operation),
      relayIp: readString(rawExit, "relay_ip", operation),
      relayPort: readInteger(rawExit, "relay_port", operation, 1, 65_535),
      localHost,
      localPort: readInteger(rawExit, "local_port", operation, 1, 65_535)
    });
  });

  return Object.freeze({
    version: readString(value, "version", operation),
    selectedEntry: readNullableString(value, "selected_entry", operation),
    interfaceName: readString(value, "interface", operation),
    interfaceUp: readBoolean(value, "interface_up", operation),
    baseProxyReachable: readBoolean(value, "base_proxy_reachable", operation),
    baseRouteBound: readBoolean(value, "base_route_bound", operation),
    latestHandshakeEpoch: readNullableNonnegativeInteger(
      value,
      "latest_handshake_epoch",
      operation
    ),
    latestHandshakeAgeSeconds: readNullableNonnegativeInteger(
      value,
      "latest_handshake_age_seconds",
      operation
    ),
    ready: readBoolean(value, "ready", operation),
    mullvadAppConnected: readBoolean(value, "mullvad_app_connected", operation),
    activeExits: Object.freeze(activeExits)
  });
}

function parseChromiumExitLease(
  value: Record<string, unknown>,
  operation: RouterCommand
): ChromiumExitLease {
  if (value["ready"] !== true) {
    throw protocolError(operation, "Chromium exit response must be ready");
  }
  const localHost = readString(value, "local_host", operation);
  if (localHost !== "127.0.0.1") {
    throw protocolError(operation, "Chromium exit must bind IPv4 loopback");
  }
  const routeId = readString(value, "route_id", operation);
  const leaseId = readString(value, "lease_id", operation);
  if (!ROUTE_ID_RE.test(routeId) || !CHROMIUM_LEASE_ID_RE.test(leaseId)) {
    throw protocolError(operation, "Chromium exit response identifiers are invalid");
  }

  return Object.freeze({
    ready: true,
    routeId,
    relayIp: readString(value, "relay_ip", operation),
    relayPort: readInteger(value, "relay_port", operation, 1, 65_535),
    localHost,
    localPort: readInteger(value, "local_port", operation, 1, 65_535),
    leaseId,
    leaseGeneration: readInteger(
      value,
      "lease_generation",
      operation,
      1,
      CHROMIUM_LEASE_GENERATION_MAX
    ),
    leaseTtlSeconds: readInteger(
      value,
      "lease_ttl_seconds",
      operation,
      CHROMIUM_LEASE_TTL_MIN_SECONDS,
      CHROMIUM_LEASE_TTL_MAX_SECONDS
    ),
    selectedEntry: readNullableString(value, "selected_entry", operation)
  });
}

function parseChromiumExitRelease(
  value: Record<string, unknown>,
  operation: RouterCommand
): ChromiumExitRelease {
  return Object.freeze({
    released: readBoolean(value, "released", operation)
  });
}

function parseEntryList(
  value: Record<string, unknown>,
  operation: RouterCommand
): RouterEntryList {
  const rawEntries = value["entries"];
  if (
    !Array.isArray(rawEntries) ||
    rawEntries.some((entry) => typeof entry !== "string" || !ENTRY_ID_RE.test(entry))
  ) {
    throw protocolError(operation, "Router response entries are invalid");
  }

  const selectedEntry = readNullableString(value, "selected_entry", operation);
  if (selectedEntry !== null && !ENTRY_ID_RE.test(selectedEntry)) {
    throw protocolError(operation, "Router selected entry is invalid");
  }

  return Object.freeze({
    entries: Object.freeze(rawEntries.slice()) as readonly string[],
    selectedEntry
  });
}

function exchange(
  socketPath: string,
  operation: RouterCommand,
  requestLine: string,
  expectedRequestId: string,
  timeoutMs: number,
  maxResponseBytes: number
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = Buffer.alloc(0);
    const socket = createConnection({ path: socketPath });

    const finishReject = (error: NativeRouterClientError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    const finishResolve = (value: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => {
      finishReject(
        new NativeRouterClientError(
          "ROUTER_TIMEOUT",
          `Router command ${operation} exceeded ${timeoutMs} ms`,
          true,
          operation
        )
      );
    }, timeoutMs);
    timer.unref();

    socket.once("connect", () => {
      socket.write(requestLine);
    });

    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      response = Buffer.concat([response, chunk]);
      if (response.length > maxResponseBytes) {
        finishReject(
          new NativeRouterClientError(
            "ROUTER_RESPONSE_TOO_LARGE",
            `Router command ${operation} exceeded the response limit`,
            false,
            operation
          )
        );
        return;
      }

      const newline = response.indexOf(0x0a);
      if (newline < 0) return;

      const line = response.subarray(0, newline).toString("utf8");
      try {
        finishResolve(parseEnvelope(operation, expectedRequestId, line));
      } catch (error: unknown) {
        if (error instanceof NativeRouterClientError) {
          finishReject(error);
        } else {
          finishReject(
            protocolError(
              operation,
              "Router daemon response could not be decoded safely",
              { cause: error }
            )
          );
        }
      }
    });

    socket.once("end", () => {
      if (!settled) {
        finishReject(
          protocolError(operation, "Router daemon closed without a complete response")
        );
      }
    });

    socket.once("error", (error: Error) => {
      finishReject(mapSocketError(operation, socketPath, error));
    });
  });
}

export function createNativeRouterClient(
  options: NativeRouterClientOptions = {}
): NativeRouterClient {
  const socketPath = validateSocketPath(
    options.socketPath ?? DEFAULT_NATIVE_ROUTER_SOCKET_PATH
  );
  const timeoutMs = validateTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = validateMaxResponseBytes(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  );
  const requestIdFactory = options.requestIdFactory ?? randomUUID;

  async function call(
    operation: RouterCommand,
    payload: Readonly<Record<string, unknown>> = {}
  ): Promise<Record<string, unknown>> {
    const requestId = validateRequestId(requestIdFactory());
    const requestLine = encodeRequest(operation, requestId, payload);
    return exchange(
      socketPath,
      operation,
      requestLine,
      requestId,
      timeoutMs,
      maxResponseBytes
    );
  }

  return Object.freeze({
    async ping(): Promise<RouterPing> {
      return parsePing(await call("ping"), "ping");
    },
    async status(): Promise<RouterStatus> {
      return parseStatus(await call("status"), "status");
    },
    async listEntries(): Promise<RouterEntryList> {
      return parseEntryList(await call("list_entries"), "list_entries");
    },
    async ensureUp(): Promise<RouterStatus> {
      return parseStatus(await call("ensure_up"), "ensure_up");
    },
    async stop(): Promise<RouterStatus> {
      return parseStatus(await call("stop"), "stop");
    },
    async restart(): Promise<RouterStatus> {
      return parseStatus(await call("restart"), "restart");
    },
    async setEntry(entryId: string, start = true): Promise<RouterStatus> {
      if (!ENTRY_ID_RE.test(entryId)) {
        throw requestError("set_entry", "Router entry ID is invalid");
      }
      return parseStatus(
        await call("set_entry", {
          entry_id: entryId,
          start
        }),
        "set_entry"
      );
    },
    async prepareChromiumExit(
      request: ChromiumExitRequest
    ): Promise<ChromiumExitLease> {
      const relayPort = request.relayPort ?? 1080;
      const leaseTtlSeconds = request.leaseTtlSeconds ?? 60;
      if (!ROUTE_ID_RE.test(request.routeId)) {
        throw requestError("prepare_chromium_exit", "Router route ID is invalid");
      }
      if (!CHROMIUM_LEASE_ID_RE.test(request.leaseId)) {
        throw requestError("prepare_chromium_exit", "Chromium lease ID is invalid");
      }
      if (
        !Number.isSafeInteger(request.leaseGeneration) ||
        request.leaseGeneration < 1 ||
        request.leaseGeneration > CHROMIUM_LEASE_GENERATION_MAX
      ) {
        throw requestError(
          "prepare_chromium_exit",
          "Chromium lease generation is invalid"
        );
      }
      if (
        !Number.isSafeInteger(leaseTtlSeconds) ||
        leaseTtlSeconds < CHROMIUM_LEASE_TTL_MIN_SECONDS ||
        leaseTtlSeconds > CHROMIUM_LEASE_TTL_MAX_SECONDS
      ) {
        throw requestError("prepare_chromium_exit", "Chromium lease TTL is invalid");
      }
      if (!Number.isSafeInteger(relayPort) || relayPort < 1 || relayPort > 65_535) {
        throw requestError("prepare_chromium_exit", "Router relay port is invalid");
      }
      return parseChromiumExitLease(
        await call("prepare_chromium_exit", {
          route_id: request.routeId,
          relay_ip: request.relayIp,
          relay_port: relayPort,
          start: request.start ?? true,
          lease_id: request.leaseId,
          lease_generation: request.leaseGeneration,
          lease_ttl_seconds: leaseTtlSeconds
        }),
        "prepare_chromium_exit"
      );
    },
    async releaseChromiumExit(
      routeId: string,
      leaseId: string,
      leaseGeneration: number
    ): Promise<ChromiumExitRelease> {
      if (!ROUTE_ID_RE.test(routeId) || !CHROMIUM_LEASE_ID_RE.test(leaseId)) {
        throw requestError(
          "release_chromium_exit",
          "Chromium exit release identifiers are invalid"
        );
      }
      if (
        !Number.isSafeInteger(leaseGeneration) ||
        leaseGeneration < 1 ||
        leaseGeneration > CHROMIUM_LEASE_GENERATION_MAX
      ) {
        throw requestError(
          "release_chromium_exit",
          "Chromium lease generation is invalid"
        );
      }
      return parseChromiumExitRelease(
        await call("release_chromium_exit", {
          route_id: routeId,
          lease_id: leaseId,
          lease_generation: leaseGeneration
        }),
        "release_chromium_exit"
      );
    }
  });
}
