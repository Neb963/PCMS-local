import type {
  ChromiumBrowserSession,
  ChromiumLaunchOptions
} from "../personas/chromium-browser.js";
import type {
  ChromiumExitLease,
  NativeRouterClient
} from "./native-router-client.js";

const EGRESS_IDENTITY_RE = /^[A-Za-z0-9._:-]{1,160}$/;

export type ProtectedChromiumErrorCode =
  | "PROTECTED_PERSONA_ALREADY_RUNNING"
  | "PROTECTED_EGRESS_VERIFICATION_FAILED"
  | "PROTECTED_EGRESS_MISMATCH"
  | "PROTECTED_CLEANUP_FAILED";

export class ProtectedChromiumError extends Error {
  public constructor(
    public readonly code: ProtectedChromiumErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProtectedChromiumError";
  }
}

export interface ProtectedEgressObservation {
  readonly routeIdentity: string;
  readonly checkedAt: number;
}

export interface ProtectedEgressVerifier {
  verifyForwarder(
    lease: ChromiumExitLease
  ): Promise<ProtectedEgressObservation>;
  verifyBrowser(
    session: ChromiumBrowserSession
  ): Promise<ProtectedEgressObservation>;
}

export interface ProtectedBrowserManager {
  reconcile(personaUid: string): Promise<ChromiumBrowserSession | null>;
  launch(
    personaUid: string,
    options?: ChromiumLaunchOptions
  ): Promise<ChromiumBrowserSession>;
}

export type ProtectedBrowserLaunchOptions = Omit<
  ChromiumLaunchOptions,
  "protectedProxy"
>;

export interface ProtectedChromiumLaunchRequest {
  readonly personaUid: string;
  readonly routeId: string;
  readonly relayIp: string;
  readonly relayPort?: number;
  readonly leaseId: string;
  readonly leaseGeneration: number;
  readonly leaseTtlSeconds?: number;
  readonly expectedEgressIdentity: string;
  readonly browser?: ProtectedBrowserLaunchOptions;
}

export interface ProtectedChromiumSession {
  readonly personaUid: string;
  readonly routeId: string;
  readonly lease: ChromiumExitLease;
  readonly browser: ChromiumBrowserSession;
  readonly forwarderEgress: ProtectedEgressObservation;
  readonly browserEgress: ProtectedEgressObservation;
  close(): Promise<void>;
}

export interface ProtectedChromiumManagerOptions {
  readonly router: NativeRouterClient;
  readonly browser: ProtectedBrowserManager;
  readonly verifier: ProtectedEgressVerifier;
}

function verificationError(
  message: string,
  cause?: unknown
): ProtectedChromiumError {
  return new ProtectedChromiumError(
    "PROTECTED_EGRESS_VERIFICATION_FAILED",
    message,
    cause
  );
}

function validateExpectedIdentity(value: string): string {
  if (!EGRESS_IDENTITY_RE.test(value)) {
    throw verificationError("Expected protected egress identity is invalid");
  }
  return value;
}

function assertObservation(
  observation: ProtectedEgressObservation,
  expectedIdentity: string,
  level: "forwarder" | "browser"
): ProtectedEgressObservation {
  if (
    !EGRESS_IDENTITY_RE.test(observation.routeIdentity) ||
    !Number.isSafeInteger(observation.checkedAt) ||
    observation.checkedAt < 0
  ) {
    throw verificationError(
      `Protected ${level} egress verifier returned invalid evidence`
    );
  }
  if (observation.routeIdentity !== expectedIdentity) {
    throw new ProtectedChromiumError(
      "PROTECTED_EGRESS_MISMATCH",
      `Protected ${level} egress identity did not match the selected route`
    );
  }
  return Object.freeze({
    routeIdentity: observation.routeIdentity,
    checkedAt: observation.checkedAt
  });
}

async function releaseLease(
  router: NativeRouterClient,
  lease: ChromiumExitLease
): Promise<void> {
  await router.releaseChromiumExit(
    lease.routeId,
    lease.leaseId,
    lease.leaseGeneration
  );
}

async function cleanupFailedLaunch(
  router: NativeRouterClient,
  lease: ChromiumExitLease,
  browser: ChromiumBrowserSession | null,
  originalError: unknown
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  if (browser !== null) {
    try {
      await browser.close();
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }
  try {
    await releaseLease(router, lease);
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length > 0) {
    throw new ProtectedChromiumError(
      "PROTECTED_CLEANUP_FAILED",
      "Protected launch failed and cleanup could not be completed safely",
      new AggregateError([originalError, ...cleanupErrors])
    );
  }
  throw originalError;
}

export class ProtectedChromiumManager {
  readonly #router: NativeRouterClient;
  readonly #browser: ProtectedBrowserManager;
  readonly #verifier: ProtectedEgressVerifier;

  public constructor(options: ProtectedChromiumManagerOptions) {
    this.#router = options.router;
    this.#browser = options.browser;
    this.#verifier = options.verifier;
  }

  public async launch(
    request: ProtectedChromiumLaunchRequest
  ): Promise<ProtectedChromiumSession> {
    const expectedIdentity = validateExpectedIdentity(
      request.expectedEgressIdentity
    );

    if (await this.#browser.reconcile(request.personaUid) !== null) {
      throw new ProtectedChromiumError(
        "PROTECTED_PERSONA_ALREADY_RUNNING",
        "Protected launch requires a closed Persona because proxy configuration is process-immutable"
      );
    }

    const lease = await this.#router.prepareChromiumExit({
      routeId: request.routeId,
      relayIp: request.relayIp,
      ...(request.relayPort === undefined ? {} : { relayPort: request.relayPort }),
      leaseId: request.leaseId,
      leaseGeneration: request.leaseGeneration,
      ...(request.leaseTtlSeconds === undefined
        ? {}
        : { leaseTtlSeconds: request.leaseTtlSeconds })
    });

    let browserSession: ChromiumBrowserSession | null = null;
    try {
      let rawForwarder: ProtectedEgressObservation;
      try {
        rawForwarder = await this.#verifier.verifyForwarder(lease);
      } catch (error: unknown) {
        throw verificationError(
          "Protected forwarder egress verification failed",
          error
        );
      }
      const forwarderEgress = assertObservation(
        rawForwarder,
        expectedIdentity,
        "forwarder"
      );

      browserSession = await this.#browser.launch(request.personaUid, {
        ...(request.browser ?? {}),
        protectedProxy: {
          host: lease.localHost,
          port: lease.localPort
        }
      });

      let rawBrowser: ProtectedEgressObservation;
      try {
        rawBrowser = await this.#verifier.verifyBrowser(browserSession);
      } catch (error: unknown) {
        throw verificationError(
          "Protected browser egress verification failed",
          error
        );
      }
      const browserEgress = assertObservation(
        rawBrowser,
        expectedIdentity,
        "browser"
      );

      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) {
          return;
        }
        const errors: unknown[] = [];
        try {
          await browserSession?.close();
        } catch (error: unknown) {
          errors.push(error);
        }
        try {
          await releaseLease(this.#router, lease);
        } catch (error: unknown) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new ProtectedChromiumError(
            "PROTECTED_CLEANUP_FAILED",
            "Protected Persona close could not release all owned resources",
            new AggregateError(errors)
          );
        }
        closed = true;
      };

      return Object.freeze({
        personaUid: request.personaUid,
        routeId: lease.routeId,
        lease,
        browser: browserSession,
        forwarderEgress,
        browserEgress,
        close
      });
    } catch (error: unknown) {
      return cleanupFailedLaunch(
        this.#router,
        lease,
        browserSession,
        error
      );
    }
  }
}
