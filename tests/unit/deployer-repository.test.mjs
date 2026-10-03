import assert from "node:assert/strict";
import test from "node:test";

import {
  DEPLOYER_REPOSITORY_LIMITS,
  DeployerRepositoryError,
  ExactCommitRepositoryScanner
} from "../../dist/deployer/github-repository.js";

const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);
const BLOB_A = "3".repeat(40);
const BLOB_B = "4".repeat(40);

function adapter(overrides = {}) {
  const calls = {
    trees: [],
    blobs: []
  };
  return {
    calls,
    value: {
      async readCommitTree(input) {
        calls.trees.push(input);
        return overrides.tree ?? {
          commitSha: COMMIT,
          treeSha: TREE,
          truncated: false,
          entries: [
            {
              path: "dist/project-1.0.0.zip",
              type: "blob",
              sha: BLOB_A,
              size: 3
            },
            {
              path: "README.md",
              type: "blob",
              sha: BLOB_B,
              size: 4
            },
            {
              path: "dist",
              type: "tree",
              sha: "5".repeat(40)
            }
          ]
        };
      },
      async readBlob(input) {
        calls.blobs.push(input);
        return overrides.blob ?? Buffer.from("zip");
      }
    }
  };
}

test("P030 exact-commit scanner never resolves an abbreviated or different commit", async () => {
  const f = adapter();
  const scanner = new ExactCommitRepositoryScanner(f.value);

  await assert.rejects(
    () => scanner.scan({
      owner: "Neb963",
      repository: "fixture",
      commitSha: COMMIT.slice(0, 12)
    }),
    (error) => {
      assert.ok(error instanceof DeployerRepositoryError);
      assert.equal(
        error.code,
        "DEPLOYER_REPOSITORY_INVALID_INPUT"
      );
      return true;
    }
  );
  assert.equal(f.calls.trees.length, 0);

  const mismatch = adapter({
    tree: {
      commitSha: "a".repeat(40),
      treeSha: TREE,
      truncated: false,
      entries: []
    }
  });
  const mismatchScanner = new ExactCommitRepositoryScanner(
    mismatch.value
  );
  await assert.rejects(
    () => mismatchScanner.scan({
      owner: "Neb963",
      repository: "fixture",
      commitSha: COMMIT
    }),
    (error) => {
      assert.ok(error instanceof DeployerRepositoryError);
      assert.equal(
        error.code,
        "DEPLOYER_REPOSITORY_COMMIT_MISMATCH"
      );
      return true;
    }
  );
});

test("P030 exact snapshot is sorted, bounded and blob reads remain commit-bound", async () => {
  const f = adapter();
  const scanner = new ExactCommitRepositoryScanner(f.value);
  const snapshot = await scanner.scan({
    owner: "Neb963",
    repository: "fixture",
    commitSha: COMMIT
  });

  assert.equal(snapshot.commitSha, COMMIT);
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    ["dist/project-1.0.0.zip", "README.md"].sort((a, b) =>
      a.localeCompare(b, "en")
    )
  );

  const bytes = await scanner.readFile(
    snapshot,
    "dist/project-1.0.0.zip"
  );
  assert.equal(bytes.toString(), "zip");
  assert.deepEqual(f.calls.blobs, [{
    owner: "Neb963",
    repository: "fixture",
    commitSha: COMMIT,
    path: "dist/project-1.0.0.zip",
    blobSha: BLOB_A,
    maxBytes: DEPLOYER_REPOSITORY_LIMITS.artifactBytes
  }]);
});

test("P030 scanner rejects truncated, duplicate and unsafe repository trees", async () => {
  for (const tree of [
    {
      commitSha: COMMIT,
      treeSha: TREE,
      truncated: true,
      entries: []
    },
    {
      commitSha: COMMIT,
      treeSha: TREE,
      truncated: false,
      entries: [
        {
          path: "dist/a.zip",
          type: "blob",
          sha: BLOB_A,
          size: 1
        },
        {
          path: "dist/a.zip",
          type: "blob",
          sha: BLOB_B,
          size: 1
        }
      ]
    },
    {
      commitSha: COMMIT,
      treeSha: TREE,
      truncated: false,
      entries: [{
        path: "../escape.zip",
        type: "blob",
        sha: BLOB_A,
        size: 1
      }]
    }
  ]) {
    const f = adapter({ tree });
    const scanner = new ExactCommitRepositoryScanner(f.value);
    await assert.rejects(
      () => scanner.scan({
        owner: "Neb963",
        repository: "fixture",
        commitSha: COMMIT
      }),
      (error) => {
        assert.ok(error instanceof DeployerRepositoryError);
        assert.ok(
          error.code === "DEPLOYER_REPOSITORY_TREE_TRUNCATED" ||
          error.code === "DEPLOYER_REPOSITORY_TREE_INVALID"
        );
        return true;
      }
    );
  }
});
