import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DeploymentArtifactResolver
} from "../../dist/deployer/artifact-selection.js";
import {
  ExactCommitRepositoryScanner
} from "../../dist/deployer/github-repository.js";
import {
  createZip
} from "../helpers/zip-fixture.mjs";

const COMMIT = "c".repeat(40);
const TREE = "d".repeat(40);
const BLOB_V1 = "e".repeat(40);
const BLOB_V2 = "f".repeat(40);

test("P030 exact commit resolves and hashes one bounded validated deployment artifact", async () => {
  const archiveV1 = createZip([
    {
      name: "release/index.html",
      data: "<main>v1</main>"
    },
    {
      name: "release/src/app.js",
      data: "export const version = 1;"
    }
  ]);
  const archiveV2 = createZip([
    {
      name: "release/index.html",
      data: "<main>v2</main>"
    },
    {
      name: "release/src/app.js",
      data: "export const version = 2;"
    }
  ]);
  const blobReads = [];
  const adapter = {
    async readCommitTree(input) {
      assert.equal(input.commitSha, COMMIT);
      return {
        commitSha: COMMIT,
        treeSha: TREE,
        truncated: false,
        entries: [
          {
            path: "release/generator-1.0.0.zip",
            type: "blob",
            sha: BLOB_V1,
            size: archiveV1.length
          },
          {
            path: "release/generator-2.0.0.zip",
            type: "blob",
            sha: BLOB_V2,
            size: archiveV2.length
          }
        ]
      };
    },
    async readBlob(input) {
      blobReads.push(input);
      if (input.blobSha === BLOB_V1) {
        return archiveV1;
      }
      if (input.blobSha === BLOB_V2) {
        return archiveV2;
      }
      throw new Error("unexpected blob");
    }
  };

  const resolver = new DeploymentArtifactResolver(
    new ExactCommitRepositoryScanner(adapter)
  );
  const resolved = await resolver.resolve({
    repository: {
      owner: "Neb963",
      repository: "fixture-project",
      commitSha: COMMIT
    },
    discovery: {
      directory: "release",
      artifactName: "generator",
      layout: "SINGLE_DIRECTORY",
      requiredFiles: [
        "index.html",
        "src/app.js"
      ]
    },
    selection: {
      kind: "EXACT",
      version: "2.0.0"
    }
  });

  assert.equal(resolved.commitSha, COMMIT);
  assert.equal(resolved.treeSha, TREE);
  assert.equal(
    resolved.path,
    "release/generator-2.0.0.zip"
  );
  assert.equal(resolved.blobSha, BLOB_V2);
  assert.equal(resolved.version, "2.0.0");
  assert.equal(resolved.contentRoot, "release");
  assert.equal(
    resolved.sha256,
    createHash("sha256")
      .update(archiveV2)
      .digest("hex")
  );
  assert.equal(
    resolved.readFile("src/app.js").toString(),
    "export const version = 2;"
  );
  assert.equal(blobReads.length, 1);
  assert.equal(blobReads[0].commitSha, COMMIT);
  assert.equal(blobReads[0].blobSha, BLOB_V2);
});
