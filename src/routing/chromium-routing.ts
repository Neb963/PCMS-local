import { createServer } from "node:net";
import type { Server, Socket } from "node:net";

import type {
  ChromiumBrowserSession,
  ChromiumLaunchOptions,
  ChromiumProtectedProxy
} from "../personas/chromium-browser.js";
import type {
  ProtectedBrowserManager,
  ProtectedChromiumLaunchRequest,
  ProtectedChromiumSession
} from "./protected-chromium.js";

export type ChromiumRoutingMode = "DIRECT" | "BLOCK" | "PROTECTED";

export type ChromiumRoutingErrorCode =
  | "ROUTING_MODE_REQUIRED"
  | "PERSONA_ROUTE_ALREADY_ACTIVE"
  | "PERSONA_ROUTE_NOT_ACTIVE"
  | "PROTECTED_ROUTE_SWITCH_REQUIRED"
  | "BLOCK_GUARD_FAILED"
  | "ROUTED_CHROMIUM_CLEANUP_FAILED";

export class ChromiumRoutingError extends Error {
  public constructor(
    public readonly code: ChromiumRoutingErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ChromiumRoutingError";
  }
}

export type RoutedBrowserLaunchOptions = Omit<
  ChromiumLaunchOptions,
  "protectedProxy"
>;

export interface DirectChromiumLaunchRequest {
  readonly mode: "DIRECT";
  readonly personaUid: string;
  readonly browser?: RoutedBrowserLaunchOptions;
}

export interface BlockChromiumLaunchRequest {
  readonly mode: "BLOCK";
  readonly personaUid: string;
  readonly browser?: RoutedBrowserLaunchOptions;
}

export interface ProtectedRoutingLaunchRequest
  extends ProtectedChromiumLaunchRequest {
  readonly mode: "PROTECTED";
}

export type RoutedChromiumLaunchRequest =
  | DirectChromiumLaunchRequest
  | BlockChromiumLaunchRequest
  | ProtectedRoutingLaunchRequest;

export interface RoutedChromiumSession {
  readonly personaUid: string;
  readonly mode: ChromiumRoutingMode;
  readonly routeId: string | null;
  readonly expectedEgressIdentity: string | null;
  readonly browser: ChromiumBrowserSession;
  close(): Promise<void>;
}

export interface MutationAdmission {
  readonly allowed: boolean;
  readonly mode: ChromiumRoutingMode | null;
  readonly routeId: string | null;
  readonly reason:
    | "DIRECT_SELECTED"
    | "PROTECTED_VERIFIED"
    | "BLOCK_MODE"
    | "NO_ACTIVE_ROUTE"
    | "ROUTE_TRANSITION";
}

export interface ProtectedChromiumLauncher {
  launch(
    request: ProtectedChromiumLaunchRequest
  ): Promise<ProtectedChromiumSession>;
}

export interface ChromiumRoutingManagerOptions {
  readonly browser: ProtectedBrowserManager;
  readonly protectedChromium: ProtectedChromiumLauncher;
}

interface BlockGuard {
  readonly proxy: ChromiumProtectedProxy;
  close(): Promise<void>;
}

async function startBlockGuard(): Promise<BlockGuard> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  }).catch((error: unknown) => {
    throw new ChromiumRoutingError(
      "BLOCK_GUARD_FAILED",
      "Could not bind the loopback Block-mode network guard",
      error
    );
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new ChromiumRoutingError(
      "BLOCK_GUARD_FAILED",
      "Block-mode network guard did not bind an IPv4 loopback port"
    );
  }

  let closed = false;
  return Object.freeze({
    proxy: Object.freeze({
      host: "127.0.0.1" as const,
      port: address.port
    }),
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
      closed = true;
    }
  });
}

function requireRoutingMode(
  request: RoutedChromiumLaunchRequest
): ChromiumRoutingMode {
  const mode = (request as { readonly mode?: unknown }).mode;
  if (mode !== "DIRECT" && mode !== "BLOCK" && mode !== "PROTECTED") {
    throw new ChromiumRoutingError(
      "ROUTING_MODE_REQUIRED",
      "Chromium routing mode must be explicitly DIRECT, BLOCK or PROTECTED"
    );
  }
  return mode;
}

export class ChromiumRoutingManager {
  readonly #browser: ProtectedBrowserManager;
  readonly #protectedChromium: ProtectedChromiumLauncher;
  readonly #sessions = new Map<string, RoutedChromiumSession>();
  readonly #transitioning = new Set<string>();
  readonly #admissionBlocked = new Set<string>();

  public constructor(options: ChromiumRoutingManagerOptions) {
    this.#browser = options.browser;
    this.#protectedChromium = options.protectedChromium;
  }

  public get(personaUid: string): RoutedChromiumSession | null {
    return this.#sessions.get(personaUid) ?? null;
  }

  public mutationAdmission(personaUid: string): MutationAdmission {
    const session = this.#sessions.get(personaUid) ?? null;
    if (
      this.#transitioning.has(personaUid) ||
      this.#admissionBlocked.has(personaUid)
    ) {
      return Object.freeze({
        allowed: false,
        mode: session?.mode ?? null,
        routeId: session?.routeId ?? null,
        reason: "ROUTE_TRANSITION"
      });
    }
    if (session === null) {
      return Object.freeze({
        allowed: false,
        mode: null,
        routeId: null,
        reason: "NO_ACTIVE_ROUTE"
      });
    }
    if (session.mode === "BLOCK") {
      return Object.freeze({
        allowed: false,
        mode: "BLOCK",
        routeId: null,
        reason: "BLOCK_MODE"
      });
    }
    if (session.mode === "DIRECT") {
      return Object.freeze({
        allowed: true,
        mode: "DIRECT",
        routeId: null,
        reason: "DIRECT_SELECTED"
      });
    }
    return Object.freeze({
      allowed: true,
      mode: "PROTECTED",
      routeId: session.routeId,
      reason: "PROTECTED_VERIFIED"
    });
  }

  async #assertLaunchable(personaUid: string): Promise<void> {
    if (
      this.#sessions.has(personaUid) ||
      this.#transitioning.has(personaUid)
    ) {
      throw new ChromiumRoutingError(
        "PERSONA_ROUTE_ALREADY_ACTIVE",
        "Persona already has active or transitioning Chromium route ownership"
      );
    }
    if (await this.#browser.reconcile(personaUid) !== null) {
      throw new ChromiumRoutingError(
        "PERSONA_ROUTE_ALREADY_ACTIVE",
        "Persona browser is already running outside this routing coordinator"
      );
    }
  }

  #track(
    session: Omit<RoutedChromiumSession, "close">,
    closeOwned: () => Promise<void>
  ): RoutedChromiumSession {
    let closed = false;
    const routed = Object.freeze({
      ...session,
      close: async (): Promise<void> => {
        if (closed) {
          return;
        }
        try {
          await closeOwned();
        } catch (error: unknown) {
          this.#admissionBlocked.add(session.personaUid);
          throw new ChromiumRoutingError(
            "ROUTED_CHROMIUM_CLEANUP_FAILED",
            "Could not close all Chromium routing resources safely",
            error
          );
        }
        if (this.#sessions.get(session.personaUid) === routed) {
          this.#sessions.delete(session.personaUid);
        }
        this.#admissionBlocked.delete(session.personaUid);
        closed = true;
      }
    });
    this.#sessions.set(session.personaUid, routed);
    this.#admissionBlocked.delete(session.personaUid);
    return routed;
  }

  async #launchDirect(
    request: DirectChromiumLaunchRequest
  ): Promise<RoutedChromiumSession> {
    const browser = await this.#browser.launch(
      request.personaUid,
      request.browser ?? {}
    );
    return this.#track(
      {
        personaUid: request.personaUid,
        mode: "DIRECT",
        routeId: null,
        expectedEgressIdentity: null,
        browser
      },
      () => browser.close()
    );
  }

  async #launchBlock(
    request: BlockChromiumLaunchRequest
  ): Promise<RoutedChromiumSession> {
    const guard = await startBlockGuard();
    let browser: ChromiumBrowserSession | null = null;
    try {
      browser = await this.#browser.launch(request.personaUid, {
        ...(request.browser ?? {}),
        protectedProxy: guard.proxy
      });
    } catch (error: unknown) {
      try {
        await guard.close();
      } catch (cleanupError: unknown) {
        throw new ChromiumRoutingError(
          "ROUTED_CHROMIUM_CLEANUP_FAILED",
          "Block-mode Chromium launch failed and its network guard could not be released",
          new AggregateError([error, cleanupError])
        );
      }
      throw error;
    }

    return this.#track(
      {
        personaUid: request.personaUid,
        mode: "BLOCK",
        routeId: null,
        expectedEgressIdentity: null,
        browser
      },
      async () => {
        const errors: unknown[] = [];
        try {
          await browser?.close();
        } catch (error: unknown) {
          errors.push(error);
        }
        try {
          await guard.close();
        } catch (error: unknown) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors);
        }
      }
    );
  }

  async #launchProtected(
    request: ProtectedRoutingLaunchRequest
  ): Promise<RoutedChromiumSession> {
    const { mode: _mode, ...protectedRequest } = request;
    void _mode;
    const protectedSession =
      await this.#protectedChromium.launch(protectedRequest);
    return this.#track(
      {
        personaUid: request.personaUid,
        mode: "PROTECTED",
        routeId: protectedSession.routeId,
        expectedEgressIdentity: request.expectedEgressIdentity,
        browser: protectedSession.browser
      },
      () => protectedSession.close()
    );
  }

  public async launch(
    request: RoutedChromiumLaunchRequest
  ): Promise<RoutedChromiumSession> {
    const mode = requireRoutingMode(request);
    await this.#assertLaunchable(request.personaUid);

    if (mode === "DIRECT") {
      return this.#launchDirect(request as DirectChromiumLaunchRequest);
    }
    if (mode === "BLOCK") {
      return this.#launchBlock(request as BlockChromiumLaunchRequest);
    }
    return this.#launchProtected(request as ProtectedRoutingLaunchRequest);
  }

  public async switchProtectedRoute(
    personaUid: string,
    request: ProtectedRoutingLaunchRequest
  ): Promise<RoutedChromiumSession> {
    const current = this.#sessions.get(personaUid);
    if (current === undefined) {
      throw new ChromiumRoutingError(
        "PERSONA_ROUTE_NOT_ACTIVE",
        "Cannot switch a Persona that has no active routed Chromium session"
      );
    }
    if (current.mode !== "PROTECTED" || request.mode !== "PROTECTED") {
      throw new ChromiumRoutingError(
        "PROTECTED_ROUTE_SWITCH_REQUIRED",
        "Safe route switching in this phase requires PROTECTED to PROTECTED relaunch"
      );
    }
    if (request.personaUid !== personaUid) {
      throw new ChromiumRoutingError(
        "PROTECTED_ROUTE_SWITCH_REQUIRED",
        "Route-switch Persona identity must match the active routed session"
      );
    }
    if (this.#transitioning.has(personaUid)) {
      throw new ChromiumRoutingError(
        "PERSONA_ROUTE_ALREADY_ACTIVE",
        "Persona already has a route transition in progress"
      );
    }

    this.#transitioning.add(personaUid);
    this.#admissionBlocked.add(personaUid);
    try {
      await current.close();
      this.#sessions.delete(personaUid);

      const next = await this.#launchProtected(request);
      this.#admissionBlocked.delete(personaUid);
      return next;
    } finally {
      this.#transitioning.delete(personaUid);
    }
  }
}
