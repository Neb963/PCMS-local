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

export interface CoreDiagnostics {
  readonly service: "pcmsd";
  readonly status: "ready" | "not_ready";
  readonly version: string;
  readonly runtime: {
    readonly node: string;
  };
  readonly database: {
    readonly status: "ok";
    readonly schemaVersion: number;
  };
  readonly paths: {
    readonly configRoot: string;
    readonly dataRoot: string;
    readonly cacheRoot: string;
    readonly databasePath: string;
  };
  readonly localApi: {
    readonly origin: string;
    readonly authentication: "bearer-token";
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

function parseAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      `PCMS diagnostics field ${field} is invalid`
    );
  }
  return value;
}

function parseCoreDiagnostics(value: unknown): CoreDiagnostics {
  if (
    !isRecord(value) ||
    !isRecord(value["runtime"]) ||
    !isRecord(value["database"]) ||
    !isRecord(value["paths"]) ||
    !isRecord(value["localApi"])
  ) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      "PCMS diagnostics response has an invalid shape"
    );
  }

  const status = value["status"];
  const runtime = value["runtime"];
  const database = value["database"];
  const paths = value["paths"];
  const localApi = value["localApi"];

  if (
    value["service"] !== "pcmsd" ||
    (status !== "ready" && status !== "not_ready") ||
    typeof value["version"] !== "string" ||
    typeof runtime["node"] !== "string" ||
    database["status"] !== "ok" ||
    typeof database["schemaVersion"] !== "number" ||
    !Number.isSafeInteger(database["schemaVersion"]) ||
    database["schemaVersion"] < 1 ||
    typeof localApi["origin"] !== "string" ||
    localApi["authentication"] !== "bearer-token"
  ) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      "PCMS diagnostics response has invalid fields"
    );
  }

  return Object.freeze({
    service: "pcmsd",
    status,
    version: value["version"],
    runtime: Object.freeze({ node: runtime["node"] }),
    database: Object.freeze({
      status: "ok",
      schemaVersion: database["schemaVersion"]
    }),
    paths: Object.freeze({
      configRoot: parseAbsolutePath(paths["configRoot"], "configRoot"),
      dataRoot: parseAbsolutePath(paths["dataRoot"], "dataRoot"),
      cacheRoot: parseAbsolutePath(paths["cacheRoot"], "cacheRoot"),
      databasePath: parseAbsolutePath(paths["databasePath"], "databasePath")
    }),
    localApi: Object.freeze({
      origin: localApi["origin"],
      authentication: "bearer-token"
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

  async function requestJson(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, base), {
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
    return payload;
  }

  return Object.freeze({
    async status(): Promise<CoreStatus> {
      return parseCoreStatus(await requestJson("/api/v1/status"));
    },
    async diagnostics(): Promise<CoreDiagnostics> {
      return parseCoreDiagnostics(await requestJson("/api/v1/diagnostics"));
    }
  });
}
