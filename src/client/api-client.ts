export interface CoreStatus {
  readonly service: "pcmsd";
  readonly status: "ready" | "not_ready";
  readonly version: string;
  readonly baseline: string;
  readonly database: {
    readonly status: "ok";
    readonly schemaVersion: number;
  };
}

export interface PcmsApiClientOptions {
  readonly origin: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

export class PcmsApiError extends Error {
  public readonly code: string;
  public readonly status: number | null;

  public constructor(
    code: string,
    message: string,
    status: number | null = null,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PcmsApiError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCoreStatus(value: unknown): CoreStatus {
  if (!isRecord(value) || !isRecord(value["database"])) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      "PCMS status response has an invalid shape"
    );
  }

  const database = value["database"];
  const service = value["service"];
  const status = value["status"];
  const version = value["version"];
  const baseline = value["baseline"];
  const databaseStatus = database["status"];
  const schemaVersion = database["schemaVersion"];

  if (
    service !== "pcmsd" ||
    (status !== "ready" && status !== "not_ready") ||
    typeof version !== "string" ||
    typeof baseline !== "string" ||
    databaseStatus !== "ok" ||
    typeof schemaVersion !== "number" ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      "PCMS status response has invalid fields"
    );
  }

  return Object.freeze({
    service,
    status,
    version,
    baseline,
    database: Object.freeze({
      status: databaseStatus,
      schemaVersion
    })
  });
}

function parseErrorPayload(
  value: unknown,
  status: number
): PcmsApiError {
  if (isRecord(value) && isRecord(value["error"])) {
    const code = value["error"]["code"];
    const message = value["error"]["message"];
    if (typeof code === "string" && typeof message === "string") {
      return new PcmsApiError(code, message, status);
    }
  }

  return new PcmsApiError(
    "HTTP_ERROR",
    `PCMS API returned HTTP ${status}`,
    status
  );
}

export function createPcmsApiClient(options: PcmsApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = new URL(options.origin);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    base.username !== "" ||
    base.password !== "" ||
    base.pathname !== "/" ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    throw new PcmsApiError(
      "INVALID_API_ORIGIN",
      "PCMS API origin must be an IPv4 loopback HTTP origin"
    );
  }

  return Object.freeze({
    async status(): Promise<CoreStatus> {
      let response: Response;
      try {
        response = await fetchImpl(new URL("/api/v1/status", base), {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${options.token}`
          },
          cache: "no-store"
        });
      } catch (error: unknown) {
        throw new PcmsApiError(
          "API_UNAVAILABLE",
          "Unable to reach the local PCMS API",
          null,
          error
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error: unknown) {
        throw new PcmsApiError(
          "INVALID_API_RESPONSE",
          "PCMS API did not return JSON",
          response.status,
          error
        );
      }

      if (!response.ok) {
        throw parseErrorPayload(payload, response.status);
      }

      return parseCoreStatus(payload);
    }
  });
}
