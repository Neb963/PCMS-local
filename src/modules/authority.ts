import {
  isValidModuleCapability,
  type ModuleManifestV1
} from "./manifest.js";

const SERVICE_REF =
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*@(?:0|[1-9]\d*)$/;

export interface ModuleAuthorityEnvelope {
  readonly capabilities: readonly string[];
  readonly requiredServices: readonly string[];
}

export interface ModuleAuthorityDelta {
  readonly addedCapabilities: readonly string[];
  readonly removedCapabilities: readonly string[];
  readonly addedRequiredServices: readonly string[];
  readonly removedRequiredServices: readonly string[];
  readonly expands: boolean;
}

export class ModuleAuthorityError extends Error {
  public readonly code = "INVALID_MODULE_AUTHORITY";

  public constructor(message: string) {
    super(message);
    this.name = "ModuleAuthorityError";
  }
}

function fail(message: string): never {
  throw new ModuleAuthorityError(message);
}

function normalizeUnique(
  values: readonly string[],
  label: string,
  validate: (value: string) => boolean,
  maxItems: number
): readonly string[] {
  if (!Array.isArray(values) || values.length > maxItems) {
    fail(`${label} must contain at most ${maxItems} items`);
  }

  const result = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 256 ||
      !validate(value)
    ) {
      fail(`${label} contains invalid authority: ${String(value)}`);
    }
    result.add(value);
  }

  return Object.freeze([...result].sort());
}

export function normalizeModuleAuthorityEnvelope(
  input: ModuleAuthorityEnvelope
): ModuleAuthorityEnvelope {
  if (typeof input !== "object" || input === null) {
    fail("authority envelope must be an object");
  }

  return Object.freeze({
    capabilities: normalizeUnique(
      input.capabilities,
      "capabilities",
      isValidModuleCapability,
      64
    ),
    requiredServices: normalizeUnique(
      input.requiredServices,
      "requiredServices",
      (value) => SERVICE_REF.test(value),
      32
    )
  });
}

export function emptyModuleAuthorityEnvelope(): ModuleAuthorityEnvelope {
  return Object.freeze({
    capabilities: Object.freeze([]),
    requiredServices: Object.freeze([])
  });
}

export function moduleAuthorityEnvelopeFromManifest(
  manifest: ModuleManifestV1
): ModuleAuthorityEnvelope {
  return normalizeModuleAuthorityEnvelope({
    capabilities: manifest.capabilities,
    requiredServices: manifest.services?.requires ?? []
  });
}

function difference(
  left: readonly string[],
  right: readonly string[]
): readonly string[] {
  const rightSet = new Set(right);
  return Object.freeze(left.filter((item) => !rightSet.has(item)));
}

export function computeModuleAuthorityDelta(
  previous: ModuleAuthorityEnvelope | null,
  requested: ModuleAuthorityEnvelope
): ModuleAuthorityDelta {
  const before =
    previous === null
      ? emptyModuleAuthorityEnvelope()
      : normalizeModuleAuthorityEnvelope(previous);
  const after = normalizeModuleAuthorityEnvelope(requested);

  const addedCapabilities = difference(
    after.capabilities,
    before.capabilities
  );
  const removedCapabilities = difference(
    before.capabilities,
    after.capabilities
  );
  const addedRequiredServices = difference(
    after.requiredServices,
    before.requiredServices
  );
  const removedRequiredServices = difference(
    before.requiredServices,
    after.requiredServices
  );

  return Object.freeze({
    addedCapabilities,
    removedCapabilities,
    addedRequiredServices,
    removedRequiredServices,
    expands:
      addedCapabilities.length > 0 ||
      addedRequiredServices.length > 0
  });
}

export function serializeModuleAuthorityEnvelope(
  envelope: ModuleAuthorityEnvelope
): string {
  return JSON.stringify(normalizeModuleAuthorityEnvelope(envelope));
}

export function parseSerializedModuleAuthorityEnvelope(
  serialized: string
): ModuleAuthorityEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error: unknown) {
    throw new ModuleAuthorityError(
      `stored authority envelope is invalid JSON: ${error instanceof Error ? error.message : "unknown parse failure"}`
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    fail("stored authority envelope must be an object");
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "capabilities" ||
    keys[1] !== "requiredServices" ||
    !Array.isArray(record["capabilities"]) ||
    !Array.isArray(record["requiredServices"])
  ) {
    fail("stored authority envelope has invalid shape");
  }

  return normalizeModuleAuthorityEnvelope({
    capabilities: record["capabilities"] as string[],
    requiredServices: record["requiredServices"] as string[]
  });
}

export function serializeModuleAuthorityDelta(
  delta: ModuleAuthorityDelta
): string {
  return JSON.stringify({
    addedCapabilities: [...delta.addedCapabilities],
    removedCapabilities: [...delta.removedCapabilities],
    addedRequiredServices: [...delta.addedRequiredServices],
    removedRequiredServices: [...delta.removedRequiredServices],
    expands: delta.expands
  });
}

export function parseSerializedModuleAuthorityDelta(
  serialized: string
): ModuleAuthorityDelta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error: unknown) {
    throw new ModuleAuthorityError(
      `stored authority delta is invalid JSON: ${error instanceof Error ? error.message : "unknown parse failure"}`
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    fail("stored authority delta must be an object");
  }

  const record = parsed as Record<string, unknown>;
  const exactKeys = [
    "addedCapabilities",
    "addedRequiredServices",
    "expands",
    "removedCapabilities",
    "removedRequiredServices"
  ];
  if (
    Object.keys(record).sort().join("\u0000") !== exactKeys.join("\u0000") ||
    !Array.isArray(record["addedCapabilities"]) ||
    !Array.isArray(record["removedCapabilities"]) ||
    !Array.isArray(record["addedRequiredServices"]) ||
    !Array.isArray(record["removedRequiredServices"]) ||
    typeof record["expands"] !== "boolean"
  ) {
    fail("stored authority delta has invalid shape");
  }

  const added = normalizeModuleAuthorityEnvelope({
    capabilities: record["addedCapabilities"] as string[],
    requiredServices: record["addedRequiredServices"] as string[]
  });
  const removed = normalizeModuleAuthorityEnvelope({
    capabilities: record["removedCapabilities"] as string[],
    requiredServices: record["removedRequiredServices"] as string[]
  });
  const expands =
    added.capabilities.length > 0 ||
    added.requiredServices.length > 0;
  if (record["expands"] !== expands) {
    fail("stored authority delta expansion flag is inconsistent");
  }

  return Object.freeze({
    addedCapabilities: added.capabilities,
    removedCapabilities: removed.capabilities,
    addedRequiredServices: added.requiredServices,
    removedRequiredServices: removed.requiredServices,
    expands
  });
}
