import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  bearerToken,
  ensureLocalApiToken,
  localApiTokenMatches
} from "../auth/local-api.js";

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
  acquireInstanceLock,
  type InstanceLock
} from "../runtime/instance-lock.js";
import {
  openPcmsDatabase,
  type PcmsDatabase
} from "../storage/database.js";
import { ModuleUiHostError, type ModuleUiHost } from "../modules/ui-host.js";
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

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
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

function createRequestHandler(
  startedAtMs: number,
  isReady: () => boolean,
  schemaVersion: number,
  apiToken: string,
  currentOrigin: () => string,
  paths: PcmsPaths,
  moduleUiHost: ModuleUiHost | undefined
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

    if (request.method !== "GET" && request.method !== "HEAD") {
      writeJson(request, response, 405, {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Only GET and HEAD are supported by bootstrap endpoints"
        }
      });
      return;
    }

    const path = requestPath(request);

    if (path === "/" || path === "/index.html") {
      writeText(
        request,
        response,
        "text/html; charset=utf-8",
        renderAppShell(apiToken),
        {
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
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
      path.startsWith("/module-ui/")
    ) {
      serveModuleUi(request, response, path, moduleUiHost);
      return;
    }

    if (path === "/api/v1/status" || path === "/api/v1/diagnostics") {
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
      options.moduleUiHost
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
