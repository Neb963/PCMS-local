import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  bearerToken,
  ensureLocalApiToken,
  localApiTokenMatches
} from "../auth/local-api.js";
import {
  AccountRepositoryError
} from "../accounts/account-repository.js";

import {
  DEFAULT_PCMSD_PORT,
  PCMSD_LOOPBACK_HOST
} from "../config/daemon.js";
import {
  ensurePcmsDirectories,
  resolvePcmsPaths,
  type PcmsPaths
} from "../config/paths.js";
import {
  InventoryReadError,
  InventoryReadService
} from "../inventory/read-service.js";
import {
  InventorySearchError
} from "../inventory/search.js";
import { OperationCoordinator } from "../operations/operation-coordinator.js";
import {
  acquireInstanceLock,
  type InstanceLock
} from "../runtime/instance-lock.js";
import {
  openPcmsDatabase,
  type PcmsDatabase
} from "../storage/database.js";
import {
  MODULE_UI_HOST_CSP,
  MODULE_UI_HOST_JS,
  ModuleUiHostError,
  type ModuleUiHost
} from "../modules/ui-host.js";
import { APP_CSS, APP_JS, renderAppShell } from "../ui/app-shell.js";
import { workspaceMetadata } from "../workspace.js";

export interface StartPcmsdOptions {
  readonly paths?: PcmsPaths;
  readonly port?: number;
  readonly moduleUiHost?: ModuleUiHost;
}

export interface PcmsdHandle {
  readonly host: typeof PCMSD_LOOPBACK_HOST;
  readonly port: number;
  readonly origin: string;
  readonly startedAt: string;
  readonly schemaVersion: number;
  close(): Promise<void>;
}

const SECURITY_HEADERS = Object.freeze({
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
});

function writeJson(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  payload: Readonly<Record<string, unknown>>
): void {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString(),
    ...SECURITY_HEADERS
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function writeText(
  request: IncomingMessage,
  response: ServerResponse,
  contentType: string,
  body: string,
  extraHeaders: Readonly<Record<string, string>> = {}
): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentType,
    "content-length": Buffer.byteLength(body).toString(),
    ...SECURITY_HEADERS,
    ...extraHeaders
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function requestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    return null;
  }
}

function writeBytes(
  request: IncomingMessage,
  response: ServerResponse,
  contentType: string,
  body: Buffer,
  extraHeaders: Readonly<Record<string, string>> = {}
): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentType,
    "content-length": body.length.toString(),
    ...SECURITY_HEADERS,
    ...extraHeaders
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

class RequestBodyError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "RequestBodyError";
    this.code = code;
  }
}

async function readBoundedJsonBody(
  request: IncomingMessage,
  maxBytes = 64 * 1024
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      throw new RequestBodyError(
        "REQUEST_BODY_TOO_LARGE",
        "Module UI SDK request body exceeds its limit"
      );
    }
    chunks.push(bytes);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.concat(chunks).toString("utf8")
    );
  } catch {
    throw new RequestBodyError(
      "INVALID_JSON",
      "Module UI SDK request body must be valid JSON"
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new RequestBodyError(
      "INVALID_MODULE_UI_SDK_REQUEST",
      "Module UI SDK request must be an object"
    );
  }
  return parsed as Record<string, unknown>;
}

function safeStructuredError(error: unknown): Readonly<{
  code: string;
  message: string;
}> {
  if (error instanceof RequestBodyError) {
    return Object.freeze({
      code: error.code,
      message: error.message
    });
  }
  if (error instanceof ModuleUiHostError) {
    return Object.freeze({
      code: error.code,
      message: error.message
    });
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    /^[A-Z][A-Z0-9_]{1,63}$/.test(
      (error as { readonly code: string }).code
    )
  ) {
    return Object.freeze({
      code: (error as { readonly code: string }).code,
      message:
        error instanceof Error
          ? error.message.slice(0, 512)
          : "Module UI SDK request failed"
    });
  }
  return Object.freeze({
    code: "MODULE_UI_SDK_FAILED",
    message: "Module UI SDK request failed"
  });
}

function moduleSdkStatus(error: unknown): number {
  const code = safeStructuredError(error).code;
  if (
    code === "MODULE_UI_SESSION_NOT_FOUND" ||
    code === "MODULE_UI_ASSET_NOT_FOUND"
  ) {
    return 404;
  }
  if (
    code === "MODULE_UI_STALE" ||
    code === "MODULE_UI_FAILED" ||
    code === "MODULE_RUNTIME_STALE" ||
    code === "MODULE_RUNTIME_DISABLED"
  ) {
    return 409;
  }
  if (
    code === "MODULE_UI_SDK_METHOD_DENIED" ||
    code === "INVALID_MODULE_UI_SDK_METHOD"
  ) {
    return 403;
  }
  if (
    code === "INVALID_JSON" ||
    code === "REQUEST_BODY_TOO_LARGE" ||
    code === "INVALID_MODULE_UI_SDK_REQUEST" ||
    code === "INVALID_MODULE_SDK_PARAMS" ||
    code === "INVALID_MODULE_UI_SESSION"
  ) {
    return 400;
  }
  return 500;
}

function inventoryApiError(error: unknown): Readonly<{
  code: string;
  message: string;
  status: number;
}> {
  if (error instanceof AccountRepositoryError) {
    if (error.code === "ACCOUNT_NOT_FOUND") {
      return Object.freeze({
        code: error.code,
        message: error.message,
        status: 404
      });
    }
    if (error.code === "ACCOUNT_ID_INVALID") {
      return Object.freeze({
        code: error.code,
        message: error.message,
        status: 400
      });
    }
  }
  if (error instanceof InventorySearchError) {
    return Object.freeze({
      code: error.code,
      message: error.message,
      status:
        error.code === "SEARCH_ROW_INVALID"
          ? 500
          : 400
    });
  }
  if (error instanceof InventoryReadError) {
    return Object.freeze({
      code: error.code,
      message: "Bound Persona inventory is unavailable",
      status: 409
    });
  }
  return Object.freeze({
    code: "INVENTORY_QUERY_FAILED",
    message: "Inventory query failed",
    status: 500
  });
}

function moduleUiStatus(error: ModuleUiHostError): number {
  switch (error.code) {
    case "MODULE_UI_SESSION_NOT_FOUND":
    case "MODULE_UI_ASSET_NOT_FOUND":
      return 404;
    case "MODULE_UI_STALE":
    case "MODULE_UI_FAILED":
      return 409;
    case "INVALID_MODULE_UI_ASSET":
    case "INVALID_MODULE_UI_SESSION":
      return 400;
    default:
      return 500;
  }
}

function serveModuleUi(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  moduleUiHost: ModuleUiHost
): void {
  const match =
    /^\/module-ui\/([A-Za-z0-9_-]+)\/([1-9]\d*)(?:\/(.*))?$/.exec(path);
  if (match === null) {
    writeJson(request, response, 404, {
      error: {
        code: "MODULE_UI_NOT_FOUND",
        message: "Module UI endpoint not found"
      }
    });
    return;
  }

  const sessionId = match[1];
  const generationText = match[2];
  if (sessionId === undefined || generationText === undefined) {
    writeJson(request, response, 404, {
      error: {
        code: "MODULE_UI_NOT_FOUND",
        message: "Module UI endpoint not found"
      }
    });
    return;
  }

  const uiGeneration = Number(generationText);
  let assetPath = match[3] ?? "";
  try {
    assetPath = decodeURIComponent(assetPath);
  } catch {
    writeJson(request, response, 400, {
      error: {
        code: "INVALID_MODULE_UI_ASSET",
        message: "Module UI asset path is not valid URL encoding"
      }
    });
    return;
  }

  void moduleUiHost
    .readAsset(sessionId, uiGeneration, assetPath)
    .then((asset) => {
      if (response.headersSent || response.destroyed) return;
      writeBytes(
        request,
        response,
        asset.contentType,
        asset.bytes,
        {
          "content-security-policy":
            asset.contentSecurityPolicy,
          "x-frame-options": "SAMEORIGIN"
        }
      );
    })
    .catch((error: unknown) => {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof ModuleUiHostError) {
        writeJson(
          request,
          response,
          moduleUiStatus(error),
          {
            error: {
              code: error.code,
              message: error.message
            }
          }
        );
        return;
      }
      writeJson(request, response, 500, {
        error: {
          code: "MODULE_UI_HOST_FAILED",
          message: "Module UI host failed"
        }
      });
    });
}

function serveModuleUiHost(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  moduleUiHost: ModuleUiHost
): void {
  const match =
    /^\/module-ui-host\/([A-Za-z0-9_-]+)\/([1-9]\d*)\/?$/.exec(path);
  if (match === null) {
    writeJson(request, response, 404, {
      error: {
        code: "MODULE_UI_NOT_FOUND",
        message: "Module UI host endpoint not found"
      }
    });
    return;
  }
  const sessionId = match[1];
  const generationText = match[2];
  if (sessionId === undefined || generationText === undefined) {
    writeJson(request, response, 404, {
      error: {
        code: "MODULE_UI_NOT_FOUND",
        message: "Module UI host endpoint not found"
      }
    });
    return;
  }

  try {
    const body = moduleUiHost.renderFrameHost(
      sessionId,
      Number(generationText)
    );
    writeText(
      request,
      response,
      "text/html; charset=utf-8",
      body,
      {
        "content-security-policy": MODULE_UI_HOST_CSP,
        "x-frame-options": "SAMEORIGIN"
      }
    );
  } catch (error: unknown) {
    if (error instanceof ModuleUiHostError) {
      writeJson(
        request,
        response,
        moduleUiStatus(error),
        {
          error: {
            code: error.code,
            message: error.message
          }
        }
      );
      return;
    }
    writeJson(request, response, 500, {
      error: {
        code: "MODULE_UI_HOST_FAILED",
        message: "Module UI host failed"
      }
    });
  }
}

function serveModuleUiSdk(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  moduleUiHost: ModuleUiHost
): void {
  const match =
    /^\/module-ui-sdk\/([A-Za-z0-9_-]+)\/([1-9]\d*)\/?$/.exec(path);
  if (match === null) {
    writeJson(request, response, 404, {
      error: {
        code: "MODULE_UI_SDK_NOT_FOUND",
        message: "Module UI SDK endpoint not found"
      }
    });
    return;
  }
  const sessionId = match[1];
  const generationText = match[2];
  if (sessionId === undefined || generationText === undefined) {
    writeJson(request, response, 404, {
      error: {
        code: "MODULE_UI_SDK_NOT_FOUND",
        message: "Module UI SDK endpoint not found"
      }
    });
    return;
  }

  void readBoundedJsonBody(request)
    .then(async (payload) => {
      const keys = Object.keys(payload).sort();
      if (
        keys.some(
          (key) => key !== "method" && key !== "params"
        ) ||
        !Object.hasOwn(payload, "method") ||
        typeof payload["method"] !== "string"
      ) {
        throw new RequestBodyError(
          "INVALID_MODULE_UI_SDK_REQUEST",
          "Module UI SDK request must contain method and optional params only"
        );
      }
      const result = await moduleUiHost.callSdk(
        sessionId,
        Number(generationText),
        payload["method"],
        Object.hasOwn(payload, "params")
          ? payload["params"]
          : null
      );
      if (response.headersSent || response.destroyed) return;
      writeJson(request, response, 200, { result });
    })
    .catch((error: unknown) => {
      if (response.headersSent || response.destroyed) return;
      const structured = safeStructuredError(error);
      writeJson(
        request,
        response,
        moduleSdkStatus(error),
        {
          error: structured
        }
      );
    });
}

function createRequestHandler(
  startedAtMs: number,
  isReady: () => boolean,
  schemaVersion: number,
  apiToken: string,
  currentOrigin: () => string,
  paths: PcmsPaths,
  moduleUiHost: ModuleUiHost | undefined,
  inventory: InventoryReadService
) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const origin = currentOrigin();
    let expectedHost: string;
    try {
      expectedHost = new URL(origin).host;
    } catch {
      response.destroy();
      return;
    }

    if (request.headers.host !== expectedHost) {
      writeJson(request, response, 400, {
        error: {
          code: "INVALID_HOST",
          message: "Request Host does not match the local PCMS endpoint"
        }
      });
      return;
    }

    const requestOrigin = request.headers.origin;
    if (requestOrigin !== undefined && requestOrigin !== origin) {
      writeJson(request, response, 403, {
        error: {
          code: "INVALID_ORIGIN",
          message: "Cross-origin requests are not permitted"
        }
      });
      return;
    }

    const url = requestUrl(request);
    const path = url?.pathname ?? "/";

    if (
      moduleUiHost !== undefined &&
      path.startsWith("/module-ui-sdk/")
    ) {
      if (request.method !== "POST") {
        writeJson(request, response, 405, {
          error: {
            code: "METHOD_NOT_ALLOWED",
            message: "Module UI SDK endpoint requires POST"
          }
        });
        return;
      }
      serveModuleUiSdk(
        request,
        response,
        path,
        moduleUiHost
      );
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      writeJson(request, response, 405, {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Only GET and HEAD are supported by bootstrap endpoints"
        }
      });
      return;
    }

    if (path === "/" || path === "/index.html") {
      writeText(
        request,
        response,
        "text/html; charset=utf-8",
        renderAppShell(apiToken),
        {
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        }
      );
      return;
    }

    if (path === "/app.js") {
      writeText(request, response, "text/javascript; charset=utf-8", APP_JS);
      return;
    }

    if (path === "/app.css") {
      writeText(request, response, "text/css; charset=utf-8", APP_CSS);
      return;
    }

    if (
      moduleUiHost !== undefined &&
      path === "/module-ui-host.js"
    ) {
      writeText(
        request,
        response,
        "text/javascript; charset=utf-8",
        MODULE_UI_HOST_JS
      );
      return;
    }

    if (
      moduleUiHost !== undefined &&
      path.startsWith("/module-ui-host/")
    ) {
      serveModuleUiHost(
        request,
        response,
        path,
        moduleUiHost
      );
      return;
    }

    if (
      moduleUiHost !== undefined &&
      path.startsWith("/module-ui/")
    ) {
      serveModuleUi(request, response, path, moduleUiHost);
      return;
    }

    const accountPersonaMatch =
      /^\/api\/v1\/accounts\/([^/]+)\/persona\/?$/.exec(path);
    const authenticatedApi =
      path === "/api/v1/status" ||
      path === "/api/v1/diagnostics" ||
      path === "/api/v1/accounts" ||
      path === "/api/v1/search" ||
      accountPersonaMatch !== null;

    if (authenticatedApi) {
      const candidate = bearerToken(request.headers.authorization);
      if (
        candidate === null ||
        !localApiTokenMatches(apiToken, candidate)
      ) {
        writeJson(request, response, 401, {
          error: {
            code: "UNAUTHORIZED",
            message: "Valid local API authorization is required"
          }
        });
        return;
      }

      const ready = isReady();
      if (path === "/api/v1/status") {
        writeJson(request, response, ready ? 200 : 503, {
          service: "pcmsd",
          status: ready ? "ready" : "not_ready",
          version: workspaceMetadata.version,
          baseline: workspaceMetadata.baseline,
          database: {
            status: "ok",
            schemaVersion
          }
        });
        return;
      }

      if (path === "/api/v1/diagnostics") {
        writeJson(request, response, ready ? 200 : 503, {
          service: "pcmsd",
          status: ready ? "ready" : "not_ready",
          version: workspaceMetadata.version,
          runtime: {
            node: process.version
          },
          database: {
            status: "ok",
            schemaVersion
          },
          paths: {
            configRoot: paths.configRoot,
            dataRoot: paths.dataRoot,
            cacheRoot: paths.cacheRoot,
            databasePath: paths.databasePath
          },
          localApi: {
            origin,
            authentication: "bearer-token"
          }
        });
        return;
      }

      try {
        if (path === "/api/v1/accounts") {
          writeJson(request, response, 200, {
            accounts: inventory.listAccounts()
          });
          return;
        }

        if (path === "/api/v1/search") {
          writeJson(request, response, 200, {
            results: inventory.search(url?.searchParams.get("q") ?? "")
          });
          return;
        }

        const encodedAccountId = accountPersonaMatch?.[1];
        if (encodedAccountId !== undefined) {
          let accountId: string;
          try {
            accountId = decodeURIComponent(encodedAccountId);
          } catch {
            writeJson(request, response, 400, {
              error: {
                code: "ACCOUNT_ID_INVALID",
                message: "Account ID path is not valid URL encoding"
              }
            });
            return;
          }
          const navigation = inventory.accountPersona(accountId);
          writeJson(
            request,
            response,
            200,
            {
              accountId: navigation.accountId,
              persona: navigation.persona
            }
          );
          return;
        }
      } catch (error: unknown) {
        const structured = inventoryApiError(error);
        writeJson(request, response, structured.status, {
          error: {
            code: structured.code,
            message: structured.message
          }
        });
        return;
      }
    }

    if (path === "/api/v1/health") {
      writeJson(request, response, 200, {
        service: "pcmsd",
        status: "ok",
        version: workspaceMetadata.version,
        uptimeMs: Math.max(0, Date.now() - startedAtMs),
        database: {
          status: "ok",
          schemaVersion
        }
      });
      return;
    }

    if (path === "/api/v1/ready") {
      const ready = isReady();
      writeJson(request, response, ready ? 200 : 503, {
        service: "pcmsd",
        status: ready ? "ready" : "not_ready",
        ready,
        version: workspaceMetadata.version,
        schemaVersion
      });
      return;
    }

    if (path === "/api/v1/version") {
      writeJson(request, response, 200, {
        service: "pcmsd",
        version: workspaceMetadata.version,
        baseline: workspaceMetadata.baseline
      });
      return;
    }

    writeJson(request, response, 404, {
      error: {
        code: "NOT_FOUND",
        message: "Endpoint not found"
      }
    });
  };
}

function listenOnLoopback(server: Server, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      reject(error);
    };

    server.once("error", onError);
    server.listen(
      {
        host: PCMSD_LOOPBACK_HOST,
        port,
        exclusive: true
      },
      () => {
        server.off("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("pcmsd did not obtain a TCP address"));
          return;
        }
        resolve(address);
      }
    );
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeIdleConnections();
  });
}

export async function startPcmsd(options: StartPcmsdOptions = {}): Promise<PcmsdHandle> {
  const paths = options.paths ?? resolvePcmsPaths();
  const port = options.port ?? DEFAULT_PCMSD_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("pcmsd port must be an integer between 0 and 65535");
  }

  await ensurePcmsDirectories(paths);
  let instanceLock: InstanceLock | null = await acquireInstanceLock(paths.instanceLockPath);
  let database: PcmsDatabase | null = null;

  try {
    database = openPcmsDatabase(paths.databasePath);
    new OperationCoordinator({
      database: database.connection
    }).recoverInterrupted();
  } catch (error: unknown) {
    await instanceLock.release();
    instanceLock = null;
    throw error;
  }

  let apiToken: string;
  try {
    apiToken = await ensureLocalApiToken(paths.apiTokenFile);
  } catch (error: unknown) {
    database.close();
    database = null;
    await instanceLock.release();
    instanceLock = null;
    throw error;
  }

  const schemaVersion = database.schemaVersion;
  const startedAtMs = Date.now();
  let ready = false;
  let origin = "";
  const server = createServer(
    createRequestHandler(
      startedAtMs,
      () => ready,
      schemaVersion,
      apiToken,
      () => origin,
      paths,
      options.moduleUiHost,
      new InventoryReadService({ database: database.connection })
    )
  );

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  let address: AddressInfo;
  try {
    address = await listenOnLoopback(server, port);
    origin = `http://${PCMSD_LOOPBACK_HOST}:${address.port}`;
    ready = true;
  } catch (error: unknown) {
    database.close();
    database = null;
    await instanceLock.release();
    instanceLock = null;
    throw error;
  }

  let closed = false;
  const startedAt = new Date(startedAtMs).toISOString();

  return Object.freeze({
    host: PCMSD_LOOPBACK_HOST,
    port: address.port,
    origin,
    startedAt,
    schemaVersion,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      ready = false;

      try {
        await closeServer(server);
      } finally {
        try {
          if (database !== null) {
            database.close();
            database = null;
          }
        } finally {
          if (instanceLock !== null) {
            await instanceLock.release();
            instanceLock = null;
          }
        }
      }
    }
  });
}
