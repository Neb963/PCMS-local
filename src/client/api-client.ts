export interface CoreAccountInventorySummary {
  readonly accountId: string;
  readonly displayName: string;
  readonly lifecycleStatus: "ACTIVE" | "INACTIVE";
  readonly personaUid: string | null;
  readonly revision: number;
}

export interface CorePersonaNavigation {
  readonly personaUid: string;
  readonly lifecycleStatus: "ACTIVE" | "RETIRED";
  readonly profileState: "CLOSED" | "OPEN";
  readonly browserBackend: "chromium-v1";
  readonly revision: number;
}

export interface CoreAccountPersonaNavigation {
  readonly accountId: string;
  readonly persona: CorePersonaNavigation | null;
}

export interface CoreInventorySearchResult {
  readonly entityType: "ACCOUNT" | "PERSONA" | "GENERATOR";
  readonly entityId: string;
  readonly label: string;
  readonly matchedField:
    | "accountId"
    | "displayName"
    | "personaUid"
    | "generatorLocalId"
    | "providerStableId"
    | "currentSlug";
  readonly accountId: string | null;
  readonly personaUid: string | null;
}

export interface CoreAttentionItem {
  readonly taskId: string;
  readonly taskType: string;
  readonly title: string;
  readonly explanation: string;
  readonly requiredActionKind: string;
  readonly accountId: string | null;
  readonly personaUid: string | null;
  readonly operationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
}

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

function parseAccountSummary(value: unknown): CoreAccountInventorySummary {
  if (!isRecord(value)) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      "PCMS Account inventory response is invalid"
    );
  }
  const accountId = value["accountId"];
  const displayName = value["displayName"];
  const lifecycleStatus = value["lifecycleStatus"];
  const personaUid = value["personaUid"];
  const revision = value["revision"];
  if (
    typeof accountId !== "string" ||
    typeof displayName !== "string" ||
    (lifecycleStatus !== "ACTIVE" && lifecycleStatus !== "INACTIVE") ||
    (personaUid !== null && typeof personaUid !== "string") ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      "PCMS Account inventory fields are invalid"
    );
  }
  return Object.freeze({
    accountId,
    displayName,
    lifecycleStatus,
    personaUid,
    revision
  });
}

function parsePersonaNavigation(value: unknown): CorePersonaNavigation {
  if (!isRecord(value)) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      "PCMS Persona navigation response is invalid"
    );
  }
  const personaUid = value["personaUid"];
  const lifecycleStatus = value["lifecycleStatus"];
  const profileState = value["profileState"];
  const browserBackend = value["browserBackend"];
  const revision = value["revision"];
  if (
    typeof personaUid !== "string" ||
    (lifecycleStatus !== "ACTIVE" && lifecycleStatus !== "RETIRED") ||
    (profileState !== "CLOSED" && profileState !== "OPEN") ||
    browserBackend !== "chromium-v1" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      "PCMS Persona navigation fields are invalid"
    );
  }
  return Object.freeze({
    personaUid,
    lifecycleStatus,
    profileState,
    browserBackend,
    revision
  });
}

function parseAccountPersonaNavigation(
  value: unknown
): CoreAccountPersonaNavigation {
  if (
    !isRecord(value) ||
    typeof value["accountId"] !== "string" ||
    !Object.hasOwn(value, "persona")
  ) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      "PCMS Account-to-Persona response is invalid"
    );
  }
  const persona = value["persona"];
  return Object.freeze({
    accountId: value["accountId"],
    persona:
      persona === null
        ? null
        : parsePersonaNavigation(persona)
  });
}

function parseSearchResult(value: unknown): CoreInventorySearchResult {
  if (!isRecord(value)) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      "PCMS search result is invalid"
    );
  }
  const entityType = value["entityType"];
  const entityId = value["entityId"];
  const label = value["label"];
  const matchedField = value["matchedField"];
  const accountId = value["accountId"];
  const personaUid = value["personaUid"];
  if (
    (entityType !== "ACCOUNT" &&
      entityType !== "PERSONA" &&
      entityType !== "GENERATOR") ||
    typeof entityId !== "string" ||
    typeof label !== "string" ||
    (matchedField !== "accountId" &&
      matchedField !== "displayName" &&
      matchedField !== "personaUid" &&
      matchedField !== "generatorLocalId" &&
      matchedField !== "providerStableId" &&
      matchedField !== "currentSlug") ||
    (accountId !== null && typeof accountId !== "string") ||
    (personaUid !== null && typeof personaUid !== "string")
  ) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      "PCMS search result fields are invalid"
    );
  }
  return Object.freeze({
    entityType,
    entityId,
    label,
    matchedField,
    accountId,
    personaUid
  });
}

function parseAttentionItem(value: unknown): CoreAttentionItem {
  if (!isRecord(value)) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      "PCMS Attention item is invalid"
    );
  }
  const taskId = value["taskId"];
  const taskType = value["taskType"];
  const title = value["title"];
  const explanation = value["explanation"];
  const requiredActionKind = value["requiredActionKind"];
  const accountId = value["accountId"];
  const personaUid = value["personaUid"];
  const operationId = value["operationId"];
  const createdAt = value["createdAt"];
  const updatedAt = value["updatedAt"];
  const expiresAt = value["expiresAt"];

  if (
    typeof taskId !== "string" ||
    typeof taskType !== "string" ||
    typeof title !== "string" ||
    typeof explanation !== "string" ||
    typeof requiredActionKind !== "string" ||
    (accountId !== null && typeof accountId !== "string") ||
    (personaUid !== null && typeof personaUid !== "string") ||
    (operationId !== null && typeof operationId !== "string") ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string" ||
    (expiresAt !== null && typeof expiresAt !== "string")
  ) {
    throw new PcmsApiError(
      "INVALID_API_RESPONSE",
      "PCMS Attention item fields are invalid"
    );
  }

  return Object.freeze({
    taskId,
    taskType,
    title,
    explanation,
    requiredActionKind,
    accountId,
    personaUid,
    operationId,
    createdAt,
    updatedAt,
    expiresAt
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
    },
    async attention(): Promise<readonly CoreAttentionItem[]> {
      const payload = await requestJson("/api/v1/attention");
      if (!isRecord(payload) || !Array.isArray(payload["attention"])) {
        throw new PcmsApiError(
          "INVALID_API_RESPONSE",
          "PCMS Attention response has an invalid shape"
        );
      }
      return Object.freeze(
        payload["attention"].map(parseAttentionItem)
      );
    },
    async accounts(): Promise<readonly CoreAccountInventorySummary[]> {
      const payload = await requestJson("/api/v1/accounts");
      if (!isRecord(payload) || !Array.isArray(payload["accounts"])) {
        throw new PcmsApiError(
          "INVALID_API_RESPONSE",
          "PCMS Account list response has an invalid shape"
        );
      }
      return Object.freeze(payload["accounts"].map(parseAccountSummary));
    },
    async accountPersona(
      accountId: string
    ): Promise<CoreAccountPersonaNavigation> {
      return parseAccountPersonaNavigation(
        await requestJson(
          `/api/v1/accounts/${encodeURIComponent(accountId)}/persona`
        )
      );
    },
    async search(
      query: string
    ): Promise<readonly CoreInventorySearchResult[]> {
      const payload = await requestJson(
        `/api/v1/search?q=${encodeURIComponent(query)}`
      );
      if (!isRecord(payload) || !Array.isArray(payload["results"])) {
        throw new PcmsApiError(
          "INVALID_API_RESPONSE",
          "PCMS search response has an invalid shape"
        );
      }
      return Object.freeze(payload["results"].map(parseSearchResult));
    }
  });
}
