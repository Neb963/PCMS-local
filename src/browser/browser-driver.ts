import type { ChromiumDevToolsEndpoint } from "../personas/chromium-browser.js";
import { ChromiumBrowserManager } from "../personas/chromium-browser.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 120_000;

export type BrowserDriverEffectState = "NOT_DISPATCHED" | "MAY_HAVE_OCCURRED";

export type BrowserDriverErrorCode =
  | "BROWSER_DRIVER_PERSONA_NOT_RUNNING"
  | "BROWSER_DRIVER_CONNECT_FAILED"
  | "BROWSER_DRIVER_CONNECT_TIMEOUT"
  | "BROWSER_DRIVER_CANCELLED"
  | "BROWSER_DRIVER_COMMAND_TIMEOUT"
  | "BROWSER_DRIVER_CONNECTION_LOST"
  | "BROWSER_DRIVER_PROTOCOL_ERROR"
  | "BROWSER_DRIVER_TARGET_NOT_FOUND"
  | "BROWSER_DRIVER_TARGET_LOST"
  | "BROWSER_DRIVER_SESSION_DETACHED";

export class BrowserDriverError extends Error {
  public constructor(
    public readonly code: BrowserDriverErrorCode,
    message: string,
    public readonly personaUid: string,
    public readonly operation: string,
    public readonly targetId: string | null = null,
    cause?: unknown,
    public readonly effectState: BrowserDriverEffectState = "NOT_DISPATCHED"
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BrowserDriverError";
  }
}

export interface BrowserDriverOptions {
  readonly browserManager: ChromiumBrowserManager;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
}

export interface BrowserDriverConnectOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface BrowserDriverCommandOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface BrowserPageTarget {
  readonly targetId: string;
  readonly url: string;
  readonly title: string;
}

export interface BrowserPageSelector {
  readonly targetId?: string;
  readonly url?: string;
}

interface RuntimeMessageEvent {
  readonly data: unknown;
}

interface RuntimeCloseEvent {
  readonly code: number;
  readonly reason: string;
}

interface RuntimeWebSocket {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: RuntimeMessageEvent) => void) | null;
  onclose: ((event: RuntimeCloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type RuntimeWebSocketConstructor = new (url: string) => RuntimeWebSocket;

interface CdpResponse {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

interface CdpProtocolError {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly data?: unknown;
}

interface CdpTargetInfo {
  readonly targetId?: unknown;
  readonly type?: unknown;
  readonly url?: unknown;
  readonly title?: unknown;
}

interface PendingCommand {
  readonly method: string;
  readonly targetId: string | null;
  readonly sessionId: string | null;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abortListener?: () => void;
}

function validateTimeout(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`${label} must be an integer between 1 and ${MAX_TIMEOUT_MS} ms`);
  }
}

function webSocketConstructor(): RuntimeWebSocketConstructor {
  const constructor = (
    globalThis as unknown as { WebSocket?: RuntimeWebSocketConstructor }
  ).WebSocket;
  if (constructor === undefined) {
    throw new Error("Node runtime does not provide WebSocket");
  }
  return constructor;
}

function parseMessage(data: unknown): CdpResponse | null {
  if (typeof data !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as CdpResponse;
  } catch {
    return null;
  }
}

function protocolErrorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "CDP returned an invalid protocol error";
  }
  const error = value as CdpProtocolError;
  return typeof error.message === "string"
    ? error.message
    : "CDP returned an unspecified protocol error";
}

function isTargetLossProtocolError(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const error = value as CdpProtocolError;
  const message = typeof error.message === "string" ? error.message : "";
  return (
    error.code === -32001 ||
    /target closed|session.*closed|no session with given id|target.*gone/iu.test(message)
  );
}

function pageTargets(result: unknown): readonly BrowserPageTarget[] {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("CDP Target.getTargets returned an invalid result");
  }
  const raw = (result as { targetInfos?: unknown }).targetInfos;
  if (!Array.isArray(raw)) {
    throw new Error("CDP Target.getTargets omitted targetInfos");
  }

  const targets: BrowserPageTarget[] = [];
  for (const value of raw) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const info = value as CdpTargetInfo;
    if (
      info.type !== "page" ||
      typeof info.targetId !== "string" ||
      typeof info.url !== "string" ||
      typeof info.title !== "string"
    ) {
      continue;
    }
    targets.push(Object.freeze({
      targetId: info.targetId,
      url: info.url,
      title: info.title
    }));
  }
  targets.sort((left, right) => left.targetId.localeCompare(right.targetId));
  return Object.freeze(targets);
}

class CdpConnection {
  readonly #personaUid: string;
  readonly #socket: RuntimeWebSocket;
  readonly #commandTimeoutMs: number;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #lostTargets = new Set<string>();
  readonly #sessionTargets = new Map<string, string>();
  readonly #detachedSessions = new Set<string>();
  #nextId = 1;
  #closed = false;

  public constructor(
    personaUid: string,
    socket: RuntimeWebSocket,
    commandTimeoutMs: number
  ) {
    this.#personaUid = personaUid;
    this.#socket = socket;
    this.#commandTimeoutMs = commandTimeoutMs;

    socket.onmessage = (event) => this.#onMessage(event.data);
    socket.onclose = (event) => {
      this.#closed = true;
      const detail = event.reason === ""
        ? `CDP connection closed with code ${event.code}`
        : `CDP connection closed with code ${event.code}: ${event.reason}`;
      this.#rejectAll(
        new BrowserDriverError(
          "BROWSER_DRIVER_CONNECTION_LOST",
          detail,
          this.#personaUid,
          "connection",
          null,
          undefined,
          "MAY_HAVE_OCCURRED"
        )
      );
    };
    socket.onerror = () => {
      if (this.#closed) {
        return;
      }
      this.#rejectAll(
        new BrowserDriverError(
          "BROWSER_DRIVER_CONNECTION_LOST",
          "CDP WebSocket reported a transport error",
          this.#personaUid,
          "connection",
          null,
          undefined,
          "MAY_HAVE_OCCURRED"
        )
      );
    };
  }

  #finishPending(id: number): PendingCommand | null {
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      return null;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#finishPending(id);
      pending.reject(error);
    }
  }

  #rejectPendingForLostTarget(targetId: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.targetId !== targetId) {
        continue;
      }
      this.#finishPending(id);
      pending.reject(
        new BrowserDriverError(
          "BROWSER_DRIVER_TARGET_LOST",
          `Browser target ${targetId} disappeared during ${pending.method}`,
          this.#personaUid,
          pending.method,
          targetId,
          undefined,
          "MAY_HAVE_OCCURRED"
        )
      );
    }
  }

  #rejectPendingForDetachedSession(sessionId: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      this.#finishPending(id);
      pending.reject(
        new BrowserDriverError(
          "BROWSER_DRIVER_SESSION_DETACHED",
          `CDP session ${sessionId} was detached during ${pending.method}`,
          this.#personaUid,
          pending.method,
          pending.targetId,
          undefined,
          "MAY_HAVE_OCCURRED"
        )
      );
    }
  }

  #onMessage(data: unknown): void {
    const message = parseMessage(data);
    if (message === null) {
      return;
    }

    if (typeof message.method === "string") {
      if (
        message.method === "Target.targetDestroyed" &&
        typeof message.params === "object" &&
        message.params !== null &&
        !Array.isArray(message.params)
      ) {
        const targetId = (message.params as { targetId?: unknown }).targetId;
        if (typeof targetId === "string") {
          this.#lostTargets.add(targetId);
          for (const [sessionId, mapped] of this.#sessionTargets) {
            if (mapped === targetId) {
              this.#sessionTargets.delete(sessionId);
              this.#detachedSessions.delete(sessionId);
            }
          }
          this.#rejectPendingForLostTarget(targetId);
        }
      }
      if (
        message.method === "Target.detachedFromTarget" &&
        typeof message.params === "object" &&
        message.params !== null &&
        !Array.isArray(message.params)
      ) {
        const sessionId = (message.params as { sessionId?: unknown }).sessionId;
        if (typeof sessionId === "string") {
          this.#sessionTargets.delete(sessionId);
          // An ordinary session detach says nothing about the target's
          // lifetime: the target stays alive and attachable, so only the
          // detached session's own commands are invalidated. Permanent
          // target loss is only ever recorded from Target.targetDestroyed.
          this.#detachedSessions.add(sessionId);
          this.#rejectPendingForDetachedSession(sessionId);
        }
      }
      return;
    }

    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
      return;
    }
    const pending = this.#finishPending(message.id);
    if (pending === null) {
      return;
    }

    if (message.error !== undefined) {
      const targetLost =
        pending.targetId !== null &&
        (this.#lostTargets.has(pending.targetId) ||
          isTargetLossProtocolError(message.error));
      pending.reject(
        new BrowserDriverError(
          targetLost
            ? "BROWSER_DRIVER_TARGET_LOST"
            : "BROWSER_DRIVER_PROTOCOL_ERROR",
          targetLost
            ? `Browser target ${pending.targetId} disappeared during ${pending.method}`
            : `CDP ${pending.method} failed: ${protocolErrorMessage(message.error)}`,
          this.#personaUid,
          pending.method,
          pending.targetId,
          undefined,
          "MAY_HAVE_OCCURRED"
        )
      );
      return;
    }
    pending.resolve(message.result);
  }

  public command(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: BrowserDriverCommandOptions & {
      readonly sessionId?: string;
      readonly targetId?: string;
    } = {}
  ): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(
        new BrowserDriverError(
          "BROWSER_DRIVER_CONNECTION_LOST",
          "CDP connection is already closed",
          this.#personaUid,
          method,
          options.targetId ?? null
        )
      );
    }
    if (
      options.targetId !== undefined &&
      this.#lostTargets.has(options.targetId)
    ) {
      return Promise.reject(
        new BrowserDriverError(
          "BROWSER_DRIVER_TARGET_LOST",
          `Browser target ${options.targetId} is no longer available`,
          this.#personaUid,
          method,
          options.targetId
        )
      );
    }
    if (
      options.sessionId !== undefined &&
      this.#detachedSessions.has(options.sessionId)
    ) {
      return Promise.reject(
        new BrowserDriverError(
          "BROWSER_DRIVER_SESSION_DETACHED",
          `CDP session ${options.sessionId} is detached`,
          this.#personaUid,
          method,
          options.targetId ?? null
        )
      );
    }

    const timeoutMs = options.timeoutMs ?? this.#commandTimeoutMs;
    validateTimeout(timeoutMs, "BrowserDriver command timeout");
    if (options.signal?.aborted === true) {
      return Promise.reject(
        new BrowserDriverError(
          "BROWSER_DRIVER_CANCELLED",
          `BrowserDriver operation ${method} was cancelled before dispatch`,
          this.#personaUid,
          method,
          options.targetId ?? null,
          options.signal.reason
        )
      );
    }

    const id = this.#nextId;
    this.#nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#finishPending(id);
        if (pending === null) {
          return;
        }
        pending.reject(
          new BrowserDriverError(
            "BROWSER_DRIVER_COMMAND_TIMEOUT",
            `BrowserDriver operation ${method} exceeded ${timeoutMs} ms`,
            this.#personaUid,
            method,
            options.targetId ?? null,
            undefined,
            "MAY_HAVE_OCCURRED"
          )
        );
      }, timeoutMs);

      const signal = options.signal;
      const abortListener = signal === undefined
        ? undefined
        : () => {
            const pending = this.#finishPending(id);
            if (pending === null) {
              return;
            }
            pending.reject(
              new BrowserDriverError(
                "BROWSER_DRIVER_CANCELLED",
                `BrowserDriver operation ${method} was cancelled`,
                this.#personaUid,
                method,
                options.targetId ?? null,
                signal.reason,
                "MAY_HAVE_OCCURRED"
              )
            );
          };

      const pending: PendingCommand = {
        method,
        targetId: options.targetId ?? null,
        sessionId: options.sessionId ?? null,
        resolve,
        reject,
        timer,
        ...(signal === undefined ? {} : { signal }),
        ...(abortListener === undefined ? {} : { abortListener })
      };
      this.#pending.set(id, pending);
      if (signal !== undefined && abortListener !== undefined) {
        signal.addEventListener("abort", abortListener, { once: true });
      }

      try {
        this.#socket.send(JSON.stringify({
          id,
          method,
          params,
          ...(options.sessionId === undefined
            ? {}
            : { sessionId: options.sessionId })
        }));
      } catch (error: unknown) {
        const current = this.#finishPending(id);
        current?.reject(
          new BrowserDriverError(
            "BROWSER_DRIVER_CONNECTION_LOST",
            `Failed to dispatch CDP ${method}`,
            this.#personaUid,
            method,
            options.targetId ?? null,
            error,
            "MAY_HAVE_OCCURRED"
          )
        );
      }
    });
  }

  public rememberSession(sessionId: string, targetId: string): void {
    this.#sessionTargets.set(sessionId, targetId);
  }

  public async disconnect(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#rejectAll(
      new BrowserDriverError(
        "BROWSER_DRIVER_CONNECTION_LOST",
        "BrowserDriver disconnected",
        this.#personaUid,
        "disconnect",
        null,
        undefined,
        "MAY_HAVE_OCCURRED"
      )
    );
    this.#socket.onmessage = null;
    this.#socket.onerror = null;
    this.#socket.onclose = null;
    this.#socket.close(1000, "PCMS BrowserDriver detach");
  }
}

export class BrowserPage {
  readonly #connection: CdpConnection;

  public constructor(
    connection: CdpConnection,
    public readonly personaUid: string,
    public readonly targetId: string,
    public readonly sessionId: string,
    public readonly url: string,
    public readonly title: string
  ) {
    this.#connection = connection;
  }

  public async focus(
    options: BrowserDriverCommandOptions = {}
  ): Promise<void> {
    await this.#connection.command(
      "Page.bringToFront",
      {},
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        sessionId: this.sessionId,
        targetId: this.targetId
      }
    );
  }

  /**
   * Detach this page's CDP session without closing the browser target: the
   * Persona stays alive and the target remains attachable.
   */
  public async detach(
    options: BrowserDriverCommandOptions = {}
  ): Promise<void> {
    await this.#connection.command(
      "Target.detachFromTarget",
      { sessionId: this.sessionId },
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        targetId: this.targetId
      }
    );
  }

  public async evaluate(
    expression: string,
    options: BrowserDriverCommandOptions & { readonly awaitPromise?: boolean } = {}
  ): Promise<unknown> {
    const result = await this.#connection.command(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: options.awaitPromise ?? true
      },
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        sessionId: this.sessionId,
        targetId: this.targetId
      }
    );
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new BrowserDriverError(
        "BROWSER_DRIVER_PROTOCOL_ERROR",
        "Runtime.evaluate returned an invalid result",
        this.personaUid,
        "Runtime.evaluate",
        this.targetId,
        undefined,
        "MAY_HAVE_OCCURRED"
      );
    }
    const remote = (result as {
      result?: { value?: unknown; unserializableValue?: unknown };
      exceptionDetails?: unknown;
    });
    if (remote.exceptionDetails !== undefined) {
      throw new BrowserDriverError(
        "BROWSER_DRIVER_PROTOCOL_ERROR",
        "Runtime.evaluate reported an exception",
        this.personaUid,
        "Runtime.evaluate",
        this.targetId,
        undefined,
        "MAY_HAVE_OCCURRED"
      );
    }
    if (remote.result === undefined) {
      throw new BrowserDriverError(
        "BROWSER_DRIVER_PROTOCOL_ERROR",
        "Runtime.evaluate omitted its remote result",
        this.personaUid,
        "Runtime.evaluate",
        this.targetId,
        undefined,
        "MAY_HAVE_OCCURRED"
      );
    }
    return remote.result.value ?? remote.result.unserializableValue;
  }
}

export class BrowserDriverConnection {
  readonly #connection: CdpConnection;

  public constructor(
    public readonly personaUid: string,
    public readonly endpoint: ChromiumDevToolsEndpoint,
    connection: CdpConnection
  ) {
    this.#connection = connection;
  }

  public async listPages(
    options: BrowserDriverCommandOptions = {}
  ): Promise<readonly BrowserPageTarget[]> {
    return pageTargets(
      await this.#connection.command("Target.getTargets", {}, options)
    );
  }

  public async selectPage(
    selector: BrowserPageSelector = {},
    options: BrowserDriverCommandOptions = {}
  ): Promise<BrowserPage> {
    const pages = await this.listPages(options);
    const selected = pages.find((page) => {
      if (selector.targetId !== undefined && page.targetId !== selector.targetId) {
        return false;
      }
      if (selector.url !== undefined && page.url !== selector.url) {
        return false;
      }
      return true;
    });
    if (selected === undefined) {
      throw new BrowserDriverError(
        "BROWSER_DRIVER_TARGET_NOT_FOUND",
        "No page target matched the requested BrowserDriver selector",
        this.personaUid,
        "Target.getTargets",
        selector.targetId ?? null
      );
    }

    const result = await this.#connection.command(
      "Target.attachToTarget",
      { targetId: selected.targetId, flatten: true },
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        targetId: selected.targetId
      }
    );
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new BrowserDriverError(
        "BROWSER_DRIVER_PROTOCOL_ERROR",
        "Target.attachToTarget returned an invalid result",
        this.personaUid,
        "Target.attachToTarget",
        selected.targetId,
        undefined,
        "MAY_HAVE_OCCURRED"
      );
    }
    const sessionId = (result as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string") {
      throw new BrowserDriverError(
        "BROWSER_DRIVER_PROTOCOL_ERROR",
        "Target.attachToTarget omitted sessionId",
        this.personaUid,
        "Target.attachToTarget",
        selected.targetId,
        undefined,
        "MAY_HAVE_OCCURRED"
      );
    }
    this.#connection.rememberSession(sessionId, selected.targetId);
    return new BrowserPage(
      this.#connection,
      this.personaUid,
      selected.targetId,
      sessionId,
      selected.url,
      selected.title
    );
  }

  public disconnect(): Promise<void> {
    return this.#connection.disconnect();
  }
}

async function openSocket(
  personaUid: string,
  endpoint: ChromiumDevToolsEndpoint,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RuntimeWebSocket> {
  validateTimeout(timeoutMs, "BrowserDriver connect timeout");
  if (signal?.aborted === true) {
    throw new BrowserDriverError(
      "BROWSER_DRIVER_CANCELLED",
      "BrowserDriver connection was cancelled before attach",
      personaUid,
      "connect",
      null,
      signal.reason
    );
  }

  const Constructor = webSocketConstructor();
  const socket = new Constructor(endpoint.webSocketUrl);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: BrowserDriverError) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
      socket.onopen = null;
      socket.onerror = null;
      socket.onclose = null;
      if (error === undefined) {
        resolve(socket);
      } else {
        socket.close(1000, "PCMS BrowserDriver attach failed");
        reject(error);
      }
    };
    const timer = setTimeout(
      () => finish(
        new BrowserDriverError(
          "BROWSER_DRIVER_CONNECT_TIMEOUT",
          `BrowserDriver could not connect within ${timeoutMs} ms`,
          personaUid,
          "connect"
        )
      ),
      timeoutMs
    );
    const onAbort = () => finish(
      new BrowserDriverError(
        "BROWSER_DRIVER_CANCELLED",
        "BrowserDriver connection was cancelled",
        personaUid,
        "connect",
        null,
        signal?.reason
      )
    );

    socket.onopen = () => finish();
    socket.onerror = () => finish(
      new BrowserDriverError(
        "BROWSER_DRIVER_CONNECT_FAILED",
        "BrowserDriver could not connect to the owned Persona DevTools endpoint",
        personaUid,
        "connect"
      )
    );
    socket.onclose = (event) => finish(
      new BrowserDriverError(
        "BROWSER_DRIVER_CONNECT_FAILED",
        `Owned Persona DevTools endpoint closed during attach (code ${event.code})`,
        personaUid,
        "connect"
      )
    );
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function resolveOwnedEndpoint(
  browserManager: ChromiumBrowserManager,
  personaUid: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ChromiumDevToolsEndpoint | null> {
  validateTimeout(timeoutMs, "BrowserDriver connect timeout");
  if (signal?.aborted === true) {
    throw new BrowserDriverError(
      "BROWSER_DRIVER_CANCELLED",
      "BrowserDriver connection was cancelled before endpoint resolution",
      personaUid,
      "connect",
      null,
      signal.reason
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      value?: ChromiumDevToolsEndpoint | null,
      error?: BrowserDriverError
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
      if (error === undefined) {
        resolve(value ?? null);
      } else {
        reject(error);
      }
    };
    const timer = setTimeout(
      () => finish(
        undefined,
        new BrowserDriverError(
          "BROWSER_DRIVER_CONNECT_TIMEOUT",
          `BrowserDriver endpoint resolution exceeded ${timeoutMs} ms`,
          personaUid,
          "connect"
        )
      ),
      timeoutMs
    );
    const onAbort = () => finish(
      undefined,
      new BrowserDriverError(
        "BROWSER_DRIVER_CANCELLED",
        "BrowserDriver connection was cancelled during endpoint resolution",
        personaUid,
        "connect",
        null,
        signal?.reason
      )
    );

    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    browserManager.resolveDevToolsEndpoint(personaUid).then(
      (endpoint) => finish(endpoint),
      (cause: unknown) => finish(
        undefined,
        cause instanceof BrowserDriverError
          ? cause
          : new BrowserDriverError(
              "BROWSER_DRIVER_CONNECT_FAILED",
              "BrowserDriver could not resolve the owned Persona DevTools endpoint",
              personaUid,
              "connect",
              null,
              cause
            )
      )
    );
  });
}

export class BrowserDriver {
  readonly #browserManager: ChromiumBrowserManager;
  readonly #connectTimeoutMs: number;
  readonly #commandTimeoutMs: number;

  public constructor(options: BrowserDriverOptions) {
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    validateTimeout(connectTimeoutMs, "BrowserDriver connectTimeoutMs");
    validateTimeout(commandTimeoutMs, "BrowserDriver commandTimeoutMs");
    this.#browserManager = options.browserManager;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#commandTimeoutMs = commandTimeoutMs;
  }

  public async connect(
    personaUid: string,
    options: BrowserDriverConnectOptions = {}
  ): Promise<BrowserDriverConnection> {
    const timeoutMs = options.timeoutMs ?? this.#connectTimeoutMs;
    validateTimeout(timeoutMs, "BrowserDriver connect timeout");
    const deadline = Date.now() + timeoutMs;
    const endpoint = await resolveOwnedEndpoint(
      this.#browserManager,
      personaUid,
      timeoutMs,
      options.signal
    );
    if (endpoint === null) {
      throw new BrowserDriverError(
        "BROWSER_DRIVER_PERSONA_NOT_RUNNING",
        `Persona ${personaUid} has no running owned Chromium process`,
        personaUid,
        "connect"
      );
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new BrowserDriverError(
        "BROWSER_DRIVER_CONNECT_TIMEOUT",
        `BrowserDriver connection exceeded ${timeoutMs} ms`,
        personaUid,
        "connect"
      );
    }
    const socket = await openSocket(
      personaUid,
      endpoint,
      remainingMs,
      options.signal
    );
    const connection = new CdpConnection(
      personaUid,
      socket,
      this.#commandTimeoutMs
    );
    return new BrowserDriverConnection(personaUid, endpoint, connection);
  }
}
