import { randomBytes } from "node:crypto";
import { extname, posix } from "node:path";

import type { ModuleAuthorityEnvelope } from "./authority.js";
import {
  isSupportedModuleSdkMethod,
  type ModuleSdkAuthorizer,
  type ModuleSdkHandler
} from "./runner.js";

const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export interface ModuleUiPackage {
  readonly moduleId: string;
  readonly version: string;
  readonly uiEntry: string;
  readFile(path: string): Buffer | Promise<Buffer>;
}

export type ModuleUiState = "READY" | "FAILED";

export interface ModuleUiSession {
  readonly sessionId: string;
  readonly moduleId: string;
  readonly version: string;
  readonly runtimeGeneration: number;
  readonly uiGeneration: number;
  readonly state: ModuleUiState;
  readonly approvedAuthority: ModuleAuthorityEnvelope;
}

export interface ModuleUiAsset {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly contentSecurityPolicy: string;
}

export interface MountModuleUiOptions {
  readonly package: ModuleUiPackage;
  readonly runtimeGeneration: number;
  readonly approvedAuthority: ModuleAuthorityEnvelope;
  readonly sdkHandlers?: Readonly<Record<string, ModuleSdkHandler>>;
  readonly authorizeSdkRequest?: ModuleSdkAuthorizer;
}

export class ModuleUiHostError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(
    code: string,
    message: string,
    retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ModuleUiHostError";
    this.code = code;
    this.retryable = retryable;
  }
}

interface SessionRecord {
  readonly sessionId: string;
  readonly moduleId: string;
  readonly version: string;
  readonly runtimeGeneration: number;
  uiGeneration: number;
  state: ModuleUiState;
  readonly approvedAuthority: ModuleAuthorityEnvelope;
  readonly package: ModuleUiPackage;
  readonly sdkHandlers: ReadonlyMap<string, ModuleSdkHandler>;
  readonly authorizeSdkRequest?: ModuleSdkAuthorizer;
}

const MODULE_UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

function fail(
  code: string,
  message: string,
  retryable = false,
  cause?: unknown
): never {
  throw new ModuleUiHostError(
    code,
    message,
    retryable,
    cause === undefined ? undefined : { cause }
  );
}

function validateRuntimeGeneration(runtimeGeneration: number): void {
  if (
    !Number.isSafeInteger(runtimeGeneration) ||
    runtimeGeneration < 1
  ) {
    fail(
      "INVALID_MODULE_UI_SESSION",
      "runtimeGeneration must be a positive safe integer"
    );
  }
}

function validatePackage(options: MountModuleUiOptions): void {
  if (
    options.package.moduleId.length > 64 ||
    !MODULE_ID.test(options.package.moduleId)
  ) {
    fail(
      "INVALID_MODULE_UI_SESSION",
      "module UI package has invalid module ID"
    );
  }
  if (
    options.package.version.length < 1 ||
    options.package.version.length > 128
  ) {
    fail(
      "INVALID_MODULE_UI_SESSION",
      "module UI package has invalid version"
    );
  }
  const entry = options.package.uiEntry;
  if (
    entry.length < 1 ||
    entry.length > 240 ||
    entry.startsWith("/") ||
    entry.includes("\\") ||
    entry.split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    fail(
      "INVALID_MODULE_UI_SESSION",
      "module UI entry must be a normalized relative package path"
    );
  }
}

function copyAuthority(
  authority: ModuleAuthorityEnvelope
): ModuleAuthorityEnvelope {
  if (
    typeof authority !== "object" ||
    authority === null ||
    !Array.isArray(authority.capabilities) ||
    !Array.isArray(authority.requiredServices)
  ) {
    fail(
      "INVALID_MODULE_UI_SESSION",
      "approved module UI authority has invalid shape"
    );
  }
  return Object.freeze({
    capabilities: Object.freeze([...authority.capabilities]),
    requiredServices: Object.freeze([...authority.requiredServices])
  });
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function sessionSnapshot(record: SessionRecord): ModuleUiSession {
  return Object.freeze({
    sessionId: record.sessionId,
    moduleId: record.moduleId,
    version: record.version,
    runtimeGeneration: record.runtimeGeneration,
    uiGeneration: record.uiGeneration,
    state: record.state,
    approvedAuthority: record.approvedAuthority
  });
}

function resolveUiAssetPath(
  uiEntry: string,
  assetPath: string
): string {
  if (
    assetPath.includes("\\") ||
    assetPath.startsWith("/") ||
    assetPath.includes("\u0000")
  ) {
    fail(
      "INVALID_MODULE_UI_ASSET",
      "module UI asset path is unsafe"
    );
  }

  const requested = assetPath === "" ? posix.basename(uiEntry) : assetPath;
  if (
    requested.length > 512 ||
    requested.split("/").some((segment) =>
      segment === "" || segment === "." || segment === ".."
    )
  ) {
    fail(
      "INVALID_MODULE_UI_ASSET",
      "module UI asset path must be normalized"
    );
  }

  const uiRoot = posix.dirname(uiEntry);
  const candidate =
    uiRoot === "."
      ? posix.normalize(requested)
      : posix.normalize(posix.join(uiRoot, requested));
  if (
    candidate.startsWith("../") ||
    candidate === ".." ||
    (uiRoot !== "." &&
      candidate !== uiRoot &&
      !candidate.startsWith(`${uiRoot}/`))
  ) {
    fail(
      "INVALID_MODULE_UI_ASSET",
      "module UI asset path escapes its UI root"
    );
  }
  return candidate;
}

export class ModuleUiHost {
  readonly #sessions = new Map<string, SessionRecord>();

  public mount(options: MountModuleUiOptions): ModuleUiSession {
    validatePackage(options);
    validateRuntimeGeneration(options.runtimeGeneration);

    const handlers = new Map<string, ModuleSdkHandler>();
    for (const [method, handler] of Object.entries(
      options.sdkHandlers ?? {}
    )) {
      if (!isSupportedModuleSdkMethod(method)) {
        fail(
          "INVALID_MODULE_UI_SDK_METHOD",
          `unsupported module UI SDK method: ${method}`
        );
      }
      if (typeof handler !== "function") {
        fail(
          "INVALID_MODULE_UI_SDK_METHOD",
          `module UI SDK handler must be callable: ${method}`
        );
      }
      handlers.set(method, handler);
    }

    let sessionId = "";
    do {
      sessionId = randomBytes(24).toString("base64url");
    } while (this.#sessions.has(sessionId));

    const record: SessionRecord = {
      sessionId,
      moduleId: options.package.moduleId,
      version: options.package.version,
      runtimeGeneration: options.runtimeGeneration,
      uiGeneration: 1,
      state: "READY",
      approvedAuthority: copyAuthority(options.approvedAuthority),
      package: options.package,
      sdkHandlers: handlers,
      ...(options.authorizeSdkRequest === undefined
        ? {}
        : { authorizeSdkRequest: options.authorizeSdkRequest })
    };
    this.#sessions.set(sessionId, record);
    return sessionSnapshot(record);
  }

  public getSession(sessionId: string): ModuleUiSession {
    return sessionSnapshot(this.#requireSession(sessionId));
  }

  public markFailed(
    sessionId: string,
    uiGeneration: number
  ): ModuleUiSession {
    const record = this.#requireGeneration(
      sessionId,
      uiGeneration
    );
    record.state = "FAILED";
    return sessionSnapshot(record);
  }

  public reset(sessionId: string): ModuleUiSession {
    const record = this.#requireSession(sessionId);
    if (record.uiGeneration === Number.MAX_SAFE_INTEGER) {
      fail(
        "MODULE_UI_GENERATION_EXHAUSTED",
        "module UI generation is exhausted"
      );
    }
    record.uiGeneration += 1;
    record.state = "READY";
    return sessionSnapshot(record);
  }

  public destroy(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  public async readAsset(
    sessionId: string,
    uiGeneration: number,
    assetPath = ""
  ): Promise<ModuleUiAsset> {
    const record = this.#requireReadyGeneration(
      sessionId,
      uiGeneration
    );
    const path = resolveUiAssetPath(
      record.package.uiEntry,
      assetPath
    );
    try {
      const bytes = await record.package.readFile(path);
      return Object.freeze({
        bytes: Buffer.from(bytes),
        contentType: contentType(path),
        contentSecurityPolicy: MODULE_UI_CSP
      });
    } catch (error: unknown) {
      if (error instanceof ModuleUiHostError) throw error;
      fail(
        "MODULE_UI_ASSET_NOT_FOUND",
        `module UI asset is unavailable: ${path}`,
        false,
        error
      );
    }
  }

  public async callSdk(
    sessionId: string,
    uiGeneration: number,
    method: string,
    params: unknown
  ): Promise<unknown> {
    const record = this.#requireReadyGeneration(
      sessionId,
      uiGeneration
    );
    if (!isSupportedModuleSdkMethod(method)) {
      fail(
        "MODULE_UI_SDK_METHOD_DENIED",
        `module UI SDK method is not approved: ${method}`
      );
    }

    await record.authorizeSdkRequest?.({
      moduleId: record.moduleId,
      runtimeGeneration: record.runtimeGeneration,
      method
    });

    const handler = record.sdkHandlers.get(method);
    if (handler === undefined) {
      fail(
        "MODULE_UI_SDK_METHOD_DENIED",
        `module UI SDK method is not approved: ${method}`
      );
    }
    return handler(params);
  }

  #requireSession(sessionId: string): SessionRecord {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      fail(
        "MODULE_UI_SESSION_NOT_FOUND",
        "module UI session does not exist"
      );
    }
    return record;
  }

  #requireGeneration(
    sessionId: string,
    uiGeneration: number
  ): SessionRecord {
    if (
      !Number.isSafeInteger(uiGeneration) ||
      uiGeneration < 1
    ) {
      fail(
        "INVALID_MODULE_UI_SESSION",
        "uiGeneration must be a positive safe integer"
      );
    }
    const record = this.#requireSession(sessionId);
    if (record.uiGeneration !== uiGeneration) {
      fail(
        "MODULE_UI_STALE",
        `module UI generation ${uiGeneration} is stale; current generation is ${record.uiGeneration}`
      );
    }
    return record;
  }

  #requireReadyGeneration(
    sessionId: string,
    uiGeneration: number
  ): SessionRecord {
    const record = this.#requireGeneration(
      sessionId,
      uiGeneration
    );
    if (record.state !== "READY") {
      fail(
        "MODULE_UI_FAILED",
        "module UI session is failed and must be reset"
      );
    }
    return record;
  }
}
