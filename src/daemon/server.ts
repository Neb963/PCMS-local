import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

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
import { workspaceMetadata } from "../workspace.js";

export interface StartPcmsdOptions {
  readonly paths?: PcmsPaths;
  readonly port?: number;
}

export interface PcmsdHandle {
  readonly host: typeof PCMSD_LOOPBACK_HOST;
  readonly port: number;
  readonly origin: string;
  readonly startedAt: string;
  close(): Promise<void>;
}

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
    "content-length": Buffer.byteLength(body).toString()
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

function createRequestHandler(startedAtMs: number, isReady: () => boolean) {
  return (request: IncomingMessage, response: ServerResponse): void => {
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
    if (path === "/api/v1/health") {
      writeJson(request, response, 200, {
        service: "pcmsd",
        status: "ok",
        version: workspaceMetadata.version,
        uptimeMs: Math.max(0, Date.now() - startedAtMs)
      });
      return;
    }

    if (path === "/api/v1/ready") {
      const ready = isReady();
      writeJson(request, response, ready ? 200 : 503, {
        service: "pcmsd",
        status: ready ? "ready" : "not_ready",
        ready,
        version: workspaceMetadata.version
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
  const startedAtMs = Date.now();
  let ready = false;
  const server = createServer(createRequestHandler(startedAtMs, () => ready));

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  let address: AddressInfo;
  try {
    address = await listenOnLoopback(server, port);
    ready = true;
  } catch (error: unknown) {
    await instanceLock.release();
    instanceLock = null;
    throw error;
  }

  let closed = false;
  const startedAt = new Date(startedAtMs).toISOString();

  return Object.freeze({
    host: PCMSD_LOOPBACK_HOST,
    port: address.port,
    origin: `http://${PCMSD_LOOPBACK_HOST}:${address.port}`,
    startedAt,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      ready = false;

      try {
        await closeServer(server);
      } finally {
        if (instanceLock !== null) {
          await instanceLock.release();
          instanceLock = null;
        }
      }
    }
  });
}
