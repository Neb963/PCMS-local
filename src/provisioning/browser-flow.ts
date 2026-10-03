import type { BrowserPage } from "../browser/browser-driver.js";

const MAX_IDENTITY_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 4096;

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

export interface ProvisioningBrowserFlowResult {
  readonly action: ProvisioningBrowserAction;
  readonly providerStatus: "submitted" | "authenticated";
  readonly session: ProvisioningSessionObservation;
}

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

function validateCredentials(
  credentials: ProvisioningTransientCredentials
): void {
  if (
    credentials.providerIdentity.length < 1 ||
    credentials.providerIdentity.length > MAX_IDENTITY_LENGTH ||
    /[\r\n\0]/u.test(credentials.providerIdentity) ||
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
  semantic: "PROVISIONING_FLOW" | "PROVISIONING_SESSION"
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

export class ProvisioningBrowserFlow {
  public async observeSession(
    page: BrowserPage
  ): Promise<ProvisioningSessionObservation> {
    const response = assertContract(
      await page.evaluate(
        "window.pcmsProvisioning.session()",
        { awaitPromise: true }
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

  public signup(
    page: BrowserPage,
    credentials: ProvisioningTransientCredentials
  ): Promise<ProvisioningBrowserFlowResult> {
    return this.#run(page, "SIGNUP", credentials);
  }

  public login(
    page: BrowserPage,
    credentials: ProvisioningTransientCredentials
  ): Promise<ProvisioningBrowserFlowResult> {
    return this.#run(page, "LOGIN", credentials);
  }

  async #run(
    page: BrowserPage,
    action: ProvisioningBrowserAction,
    credentials: ProvisioningTransientCredentials
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
      await page.evaluate(expression, { awaitPromise: true }),
      "PROVISIONING_FLOW"
    );
    const status = response["status"];
    const expected = action === "SIGNUP" ? "submitted" : "authenticated";
    if (status !== expected) {
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

    return Object.freeze({
      action,
      providerStatus: expected,
      session: await this.observeSession(page)
    });
  }
}
