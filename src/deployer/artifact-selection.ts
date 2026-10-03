import {
  DeploymentArtifactValidationError,
  parseDeploymentArtifact,
  type DeploymentArtifactEntry,
  type DeploymentArtifactLayout,
  type ParsedDeploymentArtifact
} from "./deployment-artifact.js";
import {
  ExactCommitRepositoryScanner,
  normalizeRepositoryPath,
  type ExactRepositorySnapshot,
  type ScanExactCommitInput
} from "./github-repository.js";

const ARTIFACT_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const MAX_CANDIDATES = 128;

interface ParsedVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

export interface DeploymentArtifactDiscoveryPolicy {
  readonly directory: string | null;
  readonly artifactName: string;
  readonly layout: DeploymentArtifactLayout;
  readonly requiredFiles: readonly string[];
}

export type DeploymentArtifactSelection =
  | Readonly<{
      kind: "EXACT";
      version: string;
    }>
  | Readonly<{
      kind: "HIGHEST";
    }>
  | Readonly<{
      kind: "ONLY";
    }>;

export interface DeploymentArtifactCandidate {
  readonly version: string;
  readonly path: string;
  readonly blobSha: string;
  readonly size: number | null;
}

export interface ResolvedDeploymentArtifact {
  readonly owner: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly path: string;
  readonly blobSha: string;
  readonly version: string;
  readonly sha256: string;
  readonly contentRoot: string | null;
  readonly entries: readonly DeploymentArtifactEntry[];
  readFile(path: string): Buffer;
}

export interface ResolveDeploymentArtifactInput {
  readonly repository: ScanExactCommitInput;
  readonly discovery: DeploymentArtifactDiscoveryPolicy;
  readonly selection: DeploymentArtifactSelection;
}

export type DeploymentArtifactSelectionErrorCode =
  | "DEPLOYER_ARTIFACT_POLICY_INVALID"
  | "DEPLOYER_ARTIFACT_VERSION_INVALID"
  | "DEPLOYER_ARTIFACT_NOT_FOUND"
  | "DEPLOYER_ARTIFACT_AMBIGUOUS"
  | "DEPLOYER_ARTIFACT_INVALID";

export class DeploymentArtifactSelectionError extends Error {
  public constructor(
    public readonly code:
      DeploymentArtifactSelectionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DeploymentArtifactSelectionError";
  }
}

function fail(
  code: DeploymentArtifactSelectionErrorCode,
  message: string,
  cause?: unknown
): never {
  throw new DeploymentArtifactSelectionError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function parseVersion(
  value: string,
  label = "version"
): ParsedVersion {
  const match = SEMVER.exec(value);
  if (match === null) {
    fail(
      "DEPLOYER_ARTIFACT_VERSION_INVALID",
      `${label} must be a full semantic version`
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    fail(
      "DEPLOYER_ARTIFACT_VERSION_INVALID",
      `${label} numeric components exceed safe integer bounds`
    );
  }
  const prerelease =
    match[4] === undefined
      ? Object.freeze([])
      : Object.freeze(match[4].split("."));
  return Object.freeze({
    raw: value,
    major,
    minor,
    patch,
    prerelease
  });
}

function comparePrereleaseIdentifier(
  left: string,
  right: string
): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (leftNumber !== rightNumber) {
      return leftNumber < rightNumber ? -1 : 1;
    }
    return 0;
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareVersionPrecedence(
  left: ParsedVersion,
  right: ParsedVersion
): number {
  for (const field of ["major", "minor", "patch"] as const) {
    if (left[field] !== right[field]) {
      return left[field] < right[field] ? -1 : 1;
    }
  }
  if (
    left.prerelease.length === 0 ||
    right.prerelease.length === 0
  ) {
    if (left.prerelease.length === right.prerelease.length) {
      return 0;
    }
    return left.prerelease.length === 0 ? 1 : -1;
  }

  const count = Math.max(
    left.prerelease.length,
    right.prerelease.length
  );
  for (let index = 0; index < count; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    const compared = comparePrereleaseIdentifier(
      leftPart,
      rightPart
    );
    if (compared !== 0) {
      return compared;
    }
  }
  return 0;
}

function normalizeDirectory(
  value: string | null
): string | null {
  if (value === null) {
    return null;
  }
  return normalizeRepositoryPath(
    value,
    "artifact directory"
  );
}

function validatePolicy(
  value: DeploymentArtifactDiscoveryPolicy
): Readonly<{
  directory: string | null;
  artifactName: string;
  layout: DeploymentArtifactLayout;
  requiredFiles: readonly string[];
}> {
  const directory = normalizeDirectory(value.directory);
  if (!ARTIFACT_NAME.test(value.artifactName)) {
    fail(
      "DEPLOYER_ARTIFACT_POLICY_INVALID",
      "artifactName has invalid syntax"
    );
  }
  if (
    value.layout !== "ROOT" &&
    value.layout !== "SINGLE_DIRECTORY"
  ) {
    fail(
      "DEPLOYER_ARTIFACT_POLICY_INVALID",
      "artifact layout is invalid"
    );
  }
  if (
    !Array.isArray(value.requiredFiles) ||
    value.requiredFiles.length < 1
  ) {
    fail(
      "DEPLOYER_ARTIFACT_POLICY_INVALID",
      "requiredFiles must not be empty"
    );
  }
  return Object.freeze({
    directory,
    artifactName: value.artifactName,
    layout: value.layout,
    requiredFiles: Object.freeze([
      ...value.requiredFiles
    ])
  });
}

function directChildName(
  path: string,
  directory: string | null
): string | null {
  if (directory === null) {
    return path.includes("/") ? null : path;
  }
  const prefix = `${directory}/`;
  if (!path.startsWith(prefix)) {
    return null;
  }
  const child = path.slice(prefix.length);
  return child.length > 0 && !child.includes("/")
    ? child
    : null;
}

function candidateVersion(
  fileName: string,
  artifactName: string
): string | null {
  if (!fileName.endsWith(".zip")) {
    return null;
  }
  const prefix = `${artifactName}-`;
  if (!fileName.startsWith(prefix)) {
    fail(
      "DEPLOYER_ARTIFACT_VERSION_INVALID",
      `unexpected ZIP filename in artifact directory: ${fileName}`
    );
  }
  const rawVersion = fileName.slice(
    prefix.length,
    -".zip".length
  );
  return parseVersion(
    rawVersion,
    `artifact filename version in ${fileName}`
  ).raw;
}

function discoverCandidates(
  snapshot: ExactRepositorySnapshot,
  policy:
    DeploymentArtifactDiscoveryPolicy
): readonly DeploymentArtifactCandidate[] {
  const normalized = validatePolicy(policy);
  const candidates: DeploymentArtifactCandidate[] = [];

  for (const file of snapshot.files) {
    const fileName = directChildName(
      file.path,
      normalized.directory
    );
    if (fileName === null) {
      continue;
    }
    const version = candidateVersion(
      fileName,
      normalized.artifactName
    );
    if (version === null) {
      continue;
    }
    candidates.push(Object.freeze({
      version,
      path: file.path,
      blobSha: file.blobSha,
      size: file.size
    }));
    if (candidates.length > MAX_CANDIDATES) {
      fail(
        "DEPLOYER_ARTIFACT_AMBIGUOUS",
        `artifact candidate count exceeds limit of ${MAX_CANDIDATES}`
      );
    }
  }

  candidates.sort((left, right) =>
    left.path.localeCompare(right.path, "en")
  );
  return Object.freeze(candidates);
}

function selectCandidate(
  candidates: readonly DeploymentArtifactCandidate[],
  selection: DeploymentArtifactSelection
): DeploymentArtifactCandidate {
  if (candidates.length === 0) {
    fail(
      "DEPLOYER_ARTIFACT_NOT_FOUND",
      "no deployment artifact candidates matched the explicit policy"
    );
  }

  if (selection.kind === "ONLY") {
    if (candidates.length !== 1) {
      fail(
        "DEPLOYER_ARTIFACT_AMBIGUOUS",
        `ONLY selection requires exactly one candidate, found ${candidates.length}`
      );
    }
    const only = candidates[0];
    if (only === undefined) {
      fail(
        "DEPLOYER_ARTIFACT_NOT_FOUND",
        "deployment artifact candidate disappeared"
      );
    }
    return only;
  }

  if (selection.kind === "EXACT") {
    const expected = parseVersion(
      selection.version,
      "requested exact version"
    ).raw;
    const matching = candidates.filter(
      (candidate) => candidate.version === expected
    );
    if (matching.length === 0) {
      fail(
        "DEPLOYER_ARTIFACT_NOT_FOUND",
        `requested deployment artifact version was not found: ${expected}`
      );
    }
    if (matching.length !== 1) {
      fail(
        "DEPLOYER_ARTIFACT_AMBIGUOUS",
        `requested deployment artifact version is ambiguous: ${expected}`
      );
    }
    const selected = matching[0];
    if (selected === undefined) {
      fail(
        "DEPLOYER_ARTIFACT_NOT_FOUND",
        "deployment artifact candidate disappeared"
      );
    }
    return selected;
  }

  if (selection.kind !== "HIGHEST") {
    fail(
      "DEPLOYER_ARTIFACT_POLICY_INVALID",
      "artifact selection kind is invalid"
    );
  }

  const ranked = candidates
    .map((candidate) => Object.freeze({
      candidate,
      parsed: parseVersion(candidate.version)
    }))
    .sort((left, right) => {
      const precedence = compareVersionPrecedence(
        right.parsed,
        left.parsed
      );
      if (precedence !== 0) {
        return precedence;
      }
      return left.candidate.path.localeCompare(
        right.candidate.path,
        "en"
      );
    });

  const selected = ranked[0];
  if (selected === undefined) {
    fail(
      "DEPLOYER_ARTIFACT_NOT_FOUND",
      "deployment artifact candidate disappeared"
    );
  }
  const second = ranked[1];
  if (
    second !== undefined &&
    compareVersionPrecedence(
      selected.parsed,
      second.parsed
    ) === 0 &&
    selected.candidate.version !==
      second.candidate.version
  ) {
    fail(
      "DEPLOYER_ARTIFACT_AMBIGUOUS",
      `highest deployment version has equal-precedence alternatives: ${selected.candidate.version}, ${second.candidate.version}`
    );
  }
  return selected.candidate;
}

export class DeploymentArtifactResolver {
  readonly #scanner: ExactCommitRepositoryScanner;

  public constructor(
    scanner: ExactCommitRepositoryScanner
  ) {
    this.#scanner = scanner;
  }

  public async resolve(
    input: ResolveDeploymentArtifactInput
  ): Promise<ResolvedDeploymentArtifact> {
    const policy = validatePolicy(input.discovery);
    const snapshot = await this.#scanner.scan(
      input.repository
    );
    const candidates = discoverCandidates(
      snapshot,
      policy
    );
    const selected = selectCandidate(
      candidates,
      input.selection
    );
    const bytes = await this.#scanner.readFile(
      snapshot,
      selected.path
    );

    let artifact: ParsedDeploymentArtifact;
    try {
      artifact = parseDeploymentArtifact(
        bytes,
        {
          layout: policy.layout,
          requiredFiles: policy.requiredFiles
        }
      );
    } catch (error: unknown) {
      if (
        error instanceof DeploymentArtifactValidationError
      ) {
        fail(
          "DEPLOYER_ARTIFACT_INVALID",
          `selected deployment artifact is invalid: ${selected.path}: ${error.message}`,
          error
        );
      }
      throw error;
    }

    return Object.freeze({
      owner: snapshot.owner,
      repository: snapshot.repository,
      commitSha: snapshot.commitSha,
      treeSha: snapshot.treeSha,
      path: selected.path,
      blobSha: selected.blobSha,
      version: selected.version,
      sha256: artifact.sha256,
      contentRoot: artifact.contentRoot,
      entries: artifact.entries,
      readFile(path: string): Buffer {
        return artifact.readFile(path);
      }
    });
  }
}
