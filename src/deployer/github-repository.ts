const FULL_SHA = /^[0-9a-f]{40}$/u;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/u;
const PATH_BYTES = 512;
const MAX_TREE_ENTRIES = 10_000;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export const DEPLOYER_REPOSITORY_LIMITS = Object.freeze({
  treeEntries: MAX_TREE_ENTRIES,
  pathBytes: PATH_BYTES,
  artifactBytes: MAX_ARTIFACT_BYTES
});

export type GitHubTreeEntryType = "blob" | "tree" | "commit";

export interface GitHubTreeEntry {
  readonly path: string;
  readonly type: GitHubTreeEntryType;
  readonly sha: string;
  readonly size?: number | null;
}

export interface GitHubCommitTreeSnapshot {
  readonly commitSha: string;
  readonly treeSha: string;
  readonly truncated: boolean;
  readonly entries: readonly GitHubTreeEntry[];
}

export interface GitHubReadAdapter {
  readCommitTree(input: Readonly<{
    owner: string;
    repository: string;
    commitSha: string;
  }>): Promise<GitHubCommitTreeSnapshot>;

  readBlob(input: Readonly<{
    owner: string;
    repository: string;
    commitSha: string;
    path: string;
    blobSha: string;
    maxBytes: number;
  }>): Promise<Uint8Array>;
}

export interface ExactRepositoryFile {
  readonly path: string;
  readonly blobSha: string;
  readonly size: number | null;
}

export interface ExactRepositorySnapshot {
  readonly owner: string;
  readonly repository: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly files: readonly ExactRepositoryFile[];
}

export interface ScanExactCommitInput {
  readonly owner: string;
  readonly repository: string;
  readonly commitSha: string;
}

export type DeployerRepositoryErrorCode =
  | "DEPLOYER_REPOSITORY_INVALID_INPUT"
  | "DEPLOYER_REPOSITORY_COMMIT_MISMATCH"
  | "DEPLOYER_REPOSITORY_TREE_TRUNCATED"
  | "DEPLOYER_REPOSITORY_TREE_INVALID"
  | "DEPLOYER_REPOSITORY_ARTIFACT_TOO_LARGE"
  | "DEPLOYER_REPOSITORY_BLOB_INVALID";

export class DeployerRepositoryError extends Error {
  public constructor(
    public readonly code: DeployerRepositoryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DeployerRepositoryError";
  }
}

function fail(
  code: DeployerRepositoryErrorCode,
  message: string
): never {
  throw new DeployerRepositoryError(code, message);
}

function validateCommitSha(value: string, label: string): string {
  if (!FULL_SHA.test(value)) {
    fail(
      "DEPLOYER_REPOSITORY_INVALID_INPUT",
      `${label} must be a full lowercase 40-character commit SHA`
    );
  }
  return value;
}

function validateOwner(value: string): string {
  if (!OWNER.test(value)) {
    fail(
      "DEPLOYER_REPOSITORY_INVALID_INPUT",
      "GitHub owner has invalid syntax"
    );
  }
  return value;
}

function validateRepository(value: string): string {
  if (
    !REPOSITORY.test(value) ||
    value === "." ||
    value === ".."
  ) {
    fail(
      "DEPLOYER_REPOSITORY_INVALID_INPUT",
      "GitHub repository has invalid syntax"
    );
  }
  return value;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function normalizeRepositoryPath(
  value: string,
  label = "repository path"
): string {
  if (
    value.length < 1 ||
    utf8Bytes(value) > PATH_BYTES ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      "DEPLOYER_REPOSITORY_TREE_INVALID",
      `${label} is unsafe or outside repository-relative bounds`
    );
  }
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".."
    )
  ) {
    fail(
      "DEPLOYER_REPOSITORY_TREE_INVALID",
      `${label} is not normalized`
    );
  }
  const normalized = value.normalize("NFC");
  if (normalized !== value) {
    fail(
      "DEPLOYER_REPOSITORY_TREE_INVALID",
      `${label} must use NFC normalization`
    );
  }
  return value;
}

function validateTreeType(
  value: GitHubTreeEntryType
): GitHubTreeEntryType {
  if (
    value !== "blob" &&
    value !== "tree" &&
    value !== "commit"
  ) {
    fail(
      "DEPLOYER_REPOSITORY_TREE_INVALID",
      "repository tree entry type is invalid"
    );
  }
  return value;
}

function validateOptionalSize(
  value: number | null | undefined
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      "DEPLOYER_REPOSITORY_TREE_INVALID",
      "repository blob size is invalid"
    );
  }
  return value;
}

export class ExactCommitRepositoryScanner {
  readonly #adapter: GitHubReadAdapter;

  public constructor(adapter: GitHubReadAdapter) {
    this.#adapter = adapter;
  }

  public async scan(
    input: ScanExactCommitInput
  ): Promise<ExactRepositorySnapshot> {
    const owner = validateOwner(input.owner);
    const repository = validateRepository(input.repository);
    const commitSha = validateCommitSha(
      input.commitSha,
      "commitSha"
    );
    const snapshot = await this.#adapter.readCommitTree({
      owner,
      repository,
      commitSha
    });

    if (snapshot.commitSha !== commitSha) {
      fail(
        "DEPLOYER_REPOSITORY_COMMIT_MISMATCH",
        "GitHub adapter resolved a different commit than the requested exact SHA"
      );
    }
    validateCommitSha(snapshot.treeSha, "treeSha");
    if (snapshot.truncated) {
      fail(
        "DEPLOYER_REPOSITORY_TREE_TRUNCATED",
        "GitHub returned a truncated recursive tree; artifact discovery cannot be complete"
      );
    }
    if (
      !Array.isArray(snapshot.entries) ||
      snapshot.entries.length > MAX_TREE_ENTRIES
    ) {
      fail(
        "DEPLOYER_REPOSITORY_TREE_INVALID",
        `repository tree exceeds limit of ${MAX_TREE_ENTRIES} entries`
      );
    }

    const seen = new Set<string>();
    const files: ExactRepositoryFile[] = [];
    for (const entry of snapshot.entries) {
      const path = normalizeRepositoryPath(entry.path);
      validateTreeType(entry.type);
      validateCommitSha(entry.sha, "tree entry SHA");
      if (seen.has(path)) {
        fail(
          "DEPLOYER_REPOSITORY_TREE_INVALID",
          `repository tree contains duplicate path: ${path}`
        );
      }
      seen.add(path);
      if (entry.type !== "blob") {
        continue;
      }
      const size = validateOptionalSize(entry.size);
      files.push(Object.freeze({
        path,
        blobSha: entry.sha,
        size
      }));
    }

    files.sort((left, right) =>
      left.path.localeCompare(right.path, "en")
    );

    return Object.freeze({
      owner,
      repository,
      commitSha,
      treeSha: snapshot.treeSha,
      files: Object.freeze(files)
    });
  }

  public async readFile(
    snapshot: ExactRepositorySnapshot,
    path: string
  ): Promise<Buffer> {
    const normalizedPath = normalizeRepositoryPath(path);
    const file = snapshot.files.find(
      (candidate) => candidate.path === normalizedPath
    );
    if (file === undefined) {
      fail(
        "DEPLOYER_REPOSITORY_BLOB_INVALID",
        `repository file is not present in exact snapshot: ${normalizedPath}`
      );
    }
    if (
      file.size !== null &&
      file.size > MAX_ARTIFACT_BYTES
    ) {
      fail(
        "DEPLOYER_REPOSITORY_ARTIFACT_TOO_LARGE",
        `repository file exceeds artifact byte limit: ${normalizedPath}`
      );
    }

    const bytes = Buffer.from(
      await this.#adapter.readBlob({
        owner: snapshot.owner,
        repository: snapshot.repository,
        commitSha: snapshot.commitSha,
        path: normalizedPath,
        blobSha: file.blobSha,
        maxBytes: MAX_ARTIFACT_BYTES
      })
    );
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      fail(
        "DEPLOYER_REPOSITORY_ARTIFACT_TOO_LARGE",
        `GitHub adapter returned oversized artifact bytes: ${normalizedPath}`
      );
    }
    if (
      file.size !== null &&
      bytes.length !== file.size
    ) {
      fail(
        "DEPLOYER_REPOSITORY_BLOB_INVALID",
        `GitHub adapter returned blob bytes with unexpected size: ${normalizedPath}`
      );
    }
    return bytes;
  }
}
