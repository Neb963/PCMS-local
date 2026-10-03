import type {
  BrowserDriverCommandOptions,
  BrowserPage
} from "../browser/browser-driver.js";

const MAX_IDENTITY_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 4096;
const MAX_CHALLENGE_REF_LENGTH = 256;

export type ProvisioningBrowserAction = "SIGNUP" | "LOGIN";

export interface ProvisioningTransientCredentials {
  readonly providerIdentity: string;
  readonly password: string;
}

export interface ProvisioningSessionObservation {
  readonly authenticated: boolean;
  readonly observedIdentity: string | null;
  readonly verification: "UNVERIFIED";
}

export type ProvisioningIdentityVerification =
  | Readonly<{
      authenticated: true;
      observedIdentity: string;
      verification: "VERIFIED";
    }>
  | Readonly<{
      authenticated: false;
      observedIdentity: string | null;
      verification: "UNAUTHENTICATED";
    }>
  | Readonly<{
      authenticated: true;
      observedIdentity: string;
      verification: "MISMATCH";
    }>;

export interface ProvisioningIdentityExistence {
  readonly expectedIdentity: string;
  readonly exists: boolean;
}

export interface ProvisioningBrowserFlowSuccess {
  readonly action: ProvisioningBrowserAction;
  readonly providerStatus: "submitted" | "authenticated";
  readonly session: ProvisioningSessionObservation;
}

export interface ProvisioningHumanRequirement {
  readonly kind: "CAPTCHA" | "VERIFICATION_CODE";
  readonly challengeRef: string;
}

export interface ProvisioningBrowserFlowHumanRequired {
  readonly action: ProvisioningBrowserAction;
  readonly providerStatus: "captcha-needed" | "verification-code-needed";
  readonly session: ProvisioningSessionObservation;
  readonly humanRequired: ProvisioningHumanRequirement;
}

export type ProvisioningBrowserFlowResult =
  | ProvisioningBrowserFlowSuccess
  | ProvisioningBrowserFlowHumanRequired;

export type ProvisioningBrowserFlowErrorCode =
  | "PROVISIONING_BROWSER_INPUT_INVALID"
  | "PROVISIONING_BROWSER_PROTOCOL_INVALID"
  | "PROVISIONING_BROWSER_PROVIDER_REJECTED";

export class ProvisioningBrowserFlowError extends Error {
  public constructor(
    public readonly code: ProvisioningBrowserFlowErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProvisioningBrowserFlowError";
  }
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32)
  );
}

function normalizeIdentity(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > MAX_IDENTITY_LENGTH ||
    /[\r\n\0]/u.test(normalized)
  ) {
    throw new ProvisioningBrowserFlowError(
      "PROVISIONING_BROWSER_INPUT_INVALID",
      "Provisioning provider identity is invalid"
    );
  }
  return normalized;
}

function validateCredentials(
  credentials: ProvisioningTransientCredentials
): void {
  normalizeIdentity(credentials.providerIdentity);
  if (
    credentials.password.length < 1 ||
    credentials.password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new ProvisioningBrowserFlowError(
      "PROVISIONING_BROWSER_INPUT_INVALID",
      "Provisioning browser credentials are invalid"
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProvisioningBrowserFlowError(
      "PROVISIONING_BROWSER_PROTOCOL_INVALID",
      "Provisioning emulator returned a non-object response"
    );
  }
  return value as Record<string, unknown>;
}

function assertContract(
  value: unknown,
  semantic:
    | "PROVISIONING_FLOW"
    | "PROVISIONING_SESSION"
    | "PROVISIONING_IDENTITY"
    | "PROVISIONING_VERIFICATION"
): Record<string, unknown> {
  const parsed = record(value);
  if (
    parsed["contractVersion"] !== 1 ||
    parsed["semantic"] !== semantic
  ) {
    throw new ProvisioningBrowserFlowError(
      "PROVISIONING_BROWSER_PROTOCOL_INVALID",
      "Provisioning emulator returned an unrecognized contract"
    );
  }
  return parsed;
}

function evaluateOptions(
  options: BrowserDriverCommandOptions
): BrowserDriverCommandOptions & { readonly awaitPromise: true } {
  return {
    awaitPromise: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  };
}

export class ProvisioningBrowserFlow {
  public async observeSession(
    page: BrowserPage,
    options: BrowserDriverCommandOptions = {}
  ): Promise<ProvisioningSessionObservation> {
    const response = assertContract(
      await page.evaluate(
        "window.pcmsProvisioning.session()",
        evaluateOptions(options)
      ),
      "PROVISIONING_SESSION"
    );
    const authenticated = response["authenticated"];
    const identity = response["identity"];
    if (
      typeof authenticated !== "boolean" ||
      (identity !== null && typeof identity !== "string")
    ) {
      throw new ProvisioningBrowserFlowError(
        "PROVISIONING_BROWSER_PROTOCOL_INVALID",
        "Provisioning session observation has invalid fields"
      );
    }
    return Object.freeze({
      authenticated,
      observedIdentity: identity,
      verification: "UNVERIFIED"
    });
  }

  public async verifyAuthenticatedIdentity(
    page: BrowserPage,
    expectedIdentity: string,
    options: BrowserDriverCommandOptions = {}
  ): Promise<ProvisioningIdentityVerification> {
    const expected = normalizeIdentity(expectedIdentity);
    const session = await this.observeSession(page, options);
    if (!session.authenticated) {
      return Object.freeze({
        authenticated: false,
        observedIdentity: session.observedIdentity,
        verification: "UNAUTHENTICATED"
      });
    }
    if (session.observedIdentity === null) {
      throw new ProvisioningBrowserFlowError(
        "PROVISIONING_BROWSER_PROTOCOL_INVALID",
        "Authenticated provisioning session omitted provider identity"
      );
    }
    return Object.freeze({
      authenticated: true,
      observedIdentity: session.observedIdentity,
      verification:
        asciiLowercase(session.observedIdentity) === asciiLowercase(expected)
          ? "VERIFIED"
          : "MISMATCH"
    });
  }

  public async probeIdentity(
    page: BrowserPage,
    expectedIdentity: string,
    options: BrowserDriverCommandOptions = {}
  ): Promise<ProvisioningIdentityExistence> {
    const expected = normalizeIdentity(expectedIdentity);
    const expression =
      "window.pcmsProvisioning.identity(" +
      JSON.stringify(expected) +
      ")";
    const response = assertContract(
      await page.evaluate(expression, evaluateOptions(options)),
      "PROVISIONING_IDENTITY"
    );
    if (
      response["identity"] !== expected ||
      typeof response["exists"] !== "boolean"
    ) {
      throw new ProvisioningBrowserFlowError(
        "PROVISIONING_BROWSER_PROTOCOL_INVALID",
        "Provisioning identity observation has invalid fields"
      );
    }
    return Object.freeze({
      expectedIdentity: expected,
      exists: response["exists"]
    });
  }

  public signup(
    page: BrowserPage,
    credentials: ProvisioningTransientCredentials,
    options: BrowserDriverCommandOptions = {}
  ): Promise<ProvisioningBrowserFlowResult> {
    return this.#run(page, "SIGNUP", credentials, options);
  }

  public login(
    page: BrowserPage,
    credentials: ProvisioningTransientCredentials,
    options: BrowserDriverCommandOptions = {}
  ): Promise<ProvisioningBrowserFlowResult> {
    return this.#run(page, "LOGIN", credentials, options);
  }

  public async submitVerificationCode(
    page: BrowserPage,
    code: string,
    options: BrowserDriverCommandOptions = {}
  ): Promise<ProvisioningSessionObservation> {
    if (typeof code !== "string" || code.length < 1 || code.length > 4096) {
      throw new ProvisioningBrowserFlowError(
        "PROVISIONING_BROWSER_INPUT_INVALID",
        "Provisioning verification code is invalid"
      );
    }
    const expression =
      "window.pcmsProvisioning.verify(" +
      JSON.stringify(code) +
      ")";
    const response = assertContract(
      await page.evaluate(expression, evaluateOptions(options)),
      "PROVISIONING_VERIFICATION"
    );
    if (response["status"] !== "verified") {
      const status = response["status"];
      if (typeof status !== "string") {
        throw new ProvisioningBrowserFlowError(
          "PROVISIONING_BROWSER_PROTOCOL_INVALID",
          "Provisioning verification response omitted a valid status"
        );
      }
      throw new ProvisioningBrowserFlowError(
        "PROVISIONING_BROWSER_PROVIDER_REJECTED",
        `Provisioning verification was rejected with status ${status}`
      );
    }
    return this.observeSession(page, options);
  }

  async #run(
    page: BrowserPage,
    action: ProvisioningBrowserAction,
    credentials: ProvisioningTransientCredentials,
    options: BrowserDriverCommandOptions
  ): Promise<ProvisioningBrowserFlowResult> {
    validateCredentials(credentials);
    const functionName = action === "SIGNUP" ? "signup" : "login";
    const expression =
      `window.pcmsProvisioning.${functionName}(` +
      JSON.stringify(credentials.providerIdentity) +
      "," +
      JSON.stringify(credentials.password) +
      ")";
    const response = assertContract(
      await page.evaluate(expression, evaluateOptions(options)),
      "PROVISIONING_FLOW"
    );
    const status = response["status"];
    const expected = action === "SIGNUP" ? "submitted" : "authenticated";
    if (status === expected) {
      return Object.freeze({
        action,
        providerStatus: expected,
        session: await this.observeSession(page, options)
      });
    }

    if (status === "captcha-needed" || status === "verification-code-needed") {
      const challengeRef = response["challengeRef"];
      if (
        typeof challengeRef !== "string" ||
        challengeRef.length < 1 ||
        challengeRef.length > MAX_CHALLENGE_REF_LENGTH
      ) {
        throw new ProvisioningBrowserFlowError(
          "PROVISIONING_BROWSER_PROTOCOL_INVALID",
          "Provisioning human-required response omitted a valid challenge reference"
        );
      }
      return Object.freeze({
        action,
        providerStatus: status,
        session: await this.observeSession(page, options),
        humanRequired: Object.freeze({
          kind: status === "captcha-needed" ? "CAPTCHA" : "VERIFICATION_CODE",
          challengeRef
        })
      });
    }

    if (typeof status !== "string") {
      throw new ProvisioningBrowserFlowError(
        "PROVISIONING_BROWSER_PROTOCOL_INVALID",
        "Provisioning flow response omitted a valid status"
      );
    }
    throw new ProvisioningBrowserFlowError(
      "PROVISIONING_BROWSER_PROVIDER_REJECTED",
      `Provisioning provider rejected ${action.toLowerCase()} with status ${status}`
    );
  }
}
