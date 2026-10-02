import { randomBytes } from "node:crypto";
import { extname, posix } from "node:path";

import {
  normalizeModuleAuthorityEnvelope,
  type ModuleAuthorityEnvelope
} from "./authority.js";
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
  readonly hostPath: string;
  readonly assetPath: string;
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

export const MODULE_UI_HOST_CSP =
  "default-src 'none'; script-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export const MODULE_UI_HOST_JS = `const frame = document.querySelector("iframe[data-pcms-module-ui]");
const sessionId = document.body.dataset.sessionId;
const uiGeneration = document.body.dataset.uiGeneration;

if (!(frame instanceof HTMLIFrameElement) || !sessionId || !uiGeneration) {
  throw new Error("module UI host bootstrap is invalid");
}

window.addEventListener("message", async (event) => {
  if (event.source !== frame.contentWindow) return;
  const message = event.data;
  if (
    typeof message !== "object" ||
    message === null ||
    message.type !== "pcms.moduleSdk.request" ||
    typeof message.requestId !== "string" ||
    message.requestId.length < 1 ||
    message.requestId.length > 128 ||
    typeof message.method !== "string" ||
    message.method.length < 1 ||
    message.method.length > 128
  ) {
    return;
  }

  let payload;
  let ok = false;
  try {
    const response = await fetch(
      \`/module-ui-sdk/\${sessionId}/\${uiGeneration}\`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          method: message.method,
          params: Object.hasOwn(message, "params")
            ? message.params
            : null
        })
      }
    );
    payload = await response.json();
    ok = response.ok;
  } catch {
    payload = {
      error: {
        code: "MODULE_UI_SDK_TRANSPORT_FAILED",
        message: "Module UI SDK transport failed"
      }
    };
  }

  frame.contentWindow?.postMessage(
    ok
      ? {
          type: "pcms.moduleSdk.response",
          requestId: message.requestId,
          ok: true,
          result: payload.result
        }
      : {
          type: "pcms.moduleSdk.response",
          requestId: message.requestId,
          ok: false,
          error: payload.error
        },
    "*"
  );
});
`;

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
  try {
    return normalizeModuleAuthorityEnvelope(authority);
  } catch (error: unknown) {
    fail(
      "INVALID_MODULE_UI_SESSION",
      "approved module UI authority has invalid shape",
      false,
      error
    );
  }
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
    hostPath:
      `/module-ui-host/${record.sessionId}/${record.uiGeneration}/`,
    assetPath:
      `/module-ui/${record.sessionId}/${record.uiGeneration}/`,
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

  public renderFrameHost(
    sessionId: string,
    uiGeneration: number
  ): string {
    const record = this.#requireReadyGeneration(
      sessionId,
      uiGeneration
    );
    const assetPath =
      `/module-ui/${record.sessionId}/${record.uiGeneration}/`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Module UI</title>
</head>
<body data-session-id="${record.sessionId}" data-ui-generation="${record.uiGeneration}">
  <iframe
    data-pcms-module-ui
    title="Module UI"
    sandbox="allow-scripts"
    referrerpolicy="no-referrer"
    src="${assetPath}"
  ></iframe>
  <script src="/module-ui-host.js"></script>
</body>
</html>
`;
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
