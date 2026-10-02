const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const API_RANGE = new RegExp(
  `^(?:[~^]?${SEMVER.source.slice(1, -1)}|>=${SEMVER.source.slice(1, -1)} <${SEMVER.source.slice(1, -1)})$`
);

const MODULE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SERVICE_REF =
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*@(?:0|[1-9]\d*)$/;
const SECRET_SCOPE =
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const HTTP_ORIGIN =
  /^https?:\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::(?:[1-9]\d{0,4}))?$/i;

const FIXED_CAPABILITIES = new Set([
  "accounts.read",
  "accounts.write",
  "personas.read",
  "personas.control",
  "generators.read",
  "generators.write",
  "browser.read",
  "browser.automate",
  "provider.read",
  "provider.mutate",
  "operations.create",
  "schedules.manage",
  "humanTasks.manage",
  "github.read"
]);

export interface ModuleManifestV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly pcmsApi: string;
  readonly backend: string;
  readonly ui?: string;
  readonly capabilities: readonly string[];
  readonly services?: Readonly<{
    provides?: readonly string[];
    requires?: readonly string[];
  }>;
  readonly stateSchemaVersion: number;
  readonly update?: Readonly<{
    channel?: string;
    manifestUrl?: string;
  }>;
}

export class ModuleManifestValidationError extends Error {
  public readonly code = "INVALID_MODULE_MANIFEST";

  public constructor(message: string) {
    super(message);
    this.name = "ModuleManifestValidationError";
  }
}

function fail(message: string): never {
  throw new ModuleManifestValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  field: string
): Record<string, unknown> {
  if (!isRecord(value)) fail(`${field} must be an object`);
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${field} contains unknown field: ${key}`);
  }
}

function requireString(
  value: unknown,
  field: string,
  maxLength: number
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${field} must be a non-empty bounded string without control characters`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    fail(`${field} must be a positive safe integer`);
  }
  return value;
}

function packageFilePath(value: unknown, field: string): string {
  const path = requireString(value, field, 240);
  if (
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`${field} must be a normalized relative package file path`);
  }
  return path;
}

function uniqueStringArray(
  value: unknown,
  field: string,
  validate: (item: string) => void,
  maxItems = 64
): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail(`${field} must be an array with at most ${maxItems} items`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    const item = requireString(raw, `${field}[]`, 256);
    validate(item);
    if (seen.has(item)) fail(`${field} contains duplicate value: ${item}`);
    seen.add(item);
    result.push(item);
  }
  return Object.freeze(result);
}

export function isValidModuleCapability(capability: string): boolean {
  if (FIXED_CAPABILITIES.has(capability)) return true;
  if (capability.startsWith("secrets.use:")) {
    const scope = capability.slice("secrets.use:".length);
    return scope.length <= 64 && SECRET_SCOPE.test(scope);
  }
  if (capability.startsWith("http:")) {
    const originPattern = capability.slice("http:".length);
    if (!HTTP_ORIGIN.test(originPattern)) return false;
    try {
      const candidate = originPattern.replace("://*.", "://wildcard.");
      const url = new URL(candidate);
      const port = url.port === "" ? null : Number(url.port);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username === "" &&
        url.password === "" &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === "" &&
        (port === null || (Number.isSafeInteger(port) && port <= 65535))
      );
    } catch {
      return false;
    }
  }
  return false;
}

function validateCapability(capability: string): void {
  if (!isValidModuleCapability(capability)) {
    fail(`capabilities contains unknown or invalid authority: ${capability}`);
  }
}

function validateServiceRef(service: string): void {
  if (!SERVICE_REF.test(service)) {
    fail(`invalid module service reference: ${service}`);
  }
}

function parseServices(
  value: unknown
): ModuleManifestV1["services"] {
  if (value === undefined) return undefined;
  const services = requireRecord(value, "services");
  assertExactKeys(services, ["provides", "requires"], "services");
  const result: {
    provides?: readonly string[];
    requires?: readonly string[];
  } = {};
  if (services["provides"] !== undefined) {
    result.provides = uniqueStringArray(
      services["provides"],
      "services.provides",
      validateServiceRef,
      32
    );
  }
  if (services["requires"] !== undefined) {
    result.requires = uniqueStringArray(
      services["requires"],
      "services.requires",
      validateServiceRef,
      32
    );
  }
  return Object.freeze(result);
}

function parseUpdate(
  value: unknown
): ModuleManifestV1["update"] {
  if (value === undefined) return undefined;
  const update = requireRecord(value, "update");
  assertExactKeys(update, ["channel", "manifestUrl"], "update");
  const result: { channel?: string; manifestUrl?: string } = {};

  if (update["channel"] !== undefined) {
    const channel = requireString(update["channel"], "update.channel", 64);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(channel)) {
      fail("update.channel has invalid syntax");
    }
    result.channel = channel;
  }

  if (update["manifestUrl"] !== undefined) {
    const raw = requireString(update["manifestUrl"], "update.manifestUrl", 2048);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      fail("update.manifestUrl must be an absolute HTTPS URL");
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      fail("update.manifestUrl must be an absolute HTTPS URL without credentials or fragment");
    }
    result.manifestUrl = url.toString();
  }

  return Object.freeze(result);
}

export function parseModuleManifest(value: unknown): ModuleManifestV1 {
  const manifest = requireRecord(value, "manifest");
  assertExactKeys(
    manifest,
    [
      "schemaVersion",
      "id",
      "name",
      "version",
      "pcmsApi",
      "backend",
      "ui",
      "capabilities",
      "services",
      "stateSchemaVersion",
      "update"
    ],
    "manifest"
  );

  if (manifest["schemaVersion"] !== 1) {
    fail("schemaVersion must equal 1");
  }

  const id = requireString(manifest["id"], "id", 64);
  if (!MODULE_ID.test(id)) fail("id must use conservative lowercase ASCII module syntax");

  const name = requireString(manifest["name"], "name", 120);
  const version = requireString(manifest["version"], "version", 128);
  if (!SEMVER.test(version)) fail("version must be valid semantic version syntax");

  const pcmsApi = requireString(manifest["pcmsApi"], "pcmsApi", 256);
  if (!API_RANGE.test(pcmsApi)) {
    fail("pcmsApi must be an exact, caret, tilde, or bounded >=... <... semantic-version range");
  }

  const backend = packageFilePath(manifest["backend"], "backend");
  const ui =
    manifest["ui"] === undefined
      ? undefined
      : packageFilePath(manifest["ui"], "ui");

  const capabilities = uniqueStringArray(
    manifest["capabilities"],
    "capabilities",
    validateCapability
  );
  const services = parseServices(manifest["services"]);
  const stateSchemaVersion = requirePositiveInteger(
    manifest["stateSchemaVersion"],
    "stateSchemaVersion"
  );
  const update = parseUpdate(manifest["update"]);

  return Object.freeze({
    schemaVersion: 1,
    id,
    name,
    version,
    pcmsApi,
    backend,
    ...(ui === undefined ? {} : { ui }),
    capabilities,
    ...(services === undefined ? {} : { services }),
    stateSchemaVersion,
    ...(update === undefined ? {} : { update })
  });
}
