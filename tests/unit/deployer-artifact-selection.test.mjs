import assert from "node:assert/strict";
import test from "node:test";

import {
  DeploymentArtifactResolver,
  DeploymentArtifactSelectionError
} from "../../dist/deployer/artifact-selection.js";
import {
  ExactCommitRepositoryScanner
} from "../../dist/deployer/github-repository.js";
import {
  createZip
} from "../helpers/zip-fixture.mjs";

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);

function fixture(files) {
  const blobs = new Map(
    files.map((file, index) => [
      String(index + 1).repeat(40),
      Buffer.from(file.bytes)
    ])
  );
  const entries = files.map((file, index) => {
    const sha = String(index + 1).repeat(40);
    return {
      path: file.path,
      type: "blob",
      sha,
      size: blobs.get(sha).length
    };
  });
  const adapter = {
    async readCommitTree() {
      return {
        commitSha: COMMIT,
        treeSha: TREE,
        truncated: false,
        entries
      };
    },
    async readBlob(input) {
      const value = blobs.get(input.blobSha);
      if (value === undefined) {
        throw new Error("missing fixture blob");
      }
      return value;
    }
  };
  return new DeploymentArtifactResolver(
    new ExactCommitRepositoryScanner(adapter)
  );
}

function artifact(content = "fixture") {
  return createZip([
    {
      name: "index.html",
      data: content
    },
    {
      name: "src/app.js",
      data: "export {};"
    }
  ]);
}

const repository = {
  owner: "Neb963",
  repository: "fixture",
  commitSha: COMMIT
};
const discovery = {
  directory: "artifacts",
  artifactName: "generator",
  layout: "ROOT",
  requiredFiles: [
    "index.html",
    "src/app.js"
  ]
};

test("P030 exact and highest version selection are explicit and deterministic", async () => {
  const resolver = fixture([
    {
      path: "artifacts/generator-1.0.0.zip",
      bytes: artifact("one")
    },
    {
      path: "artifacts/generator-2.0.0-rc.1.zip",
      bytes: artifact("rc")
    },
    {
      path: "artifacts/generator-1.5.0.zip",
      bytes: artifact("one-five")
    },
    {
      path: "artifacts/README.md",
      bytes: Buffer.from("ignored")
    }
  ]);

  const exact = await resolver.resolve({
    repository,
    discovery,
    selection: {
      kind: "EXACT",
      version: "1.0.0"
    }
  });
  assert.equal(exact.version, "1.0.0");
  assert.equal(
    exact.readFile("index.html").toString(),
    "one"
  );

  const highest = await resolver.resolve({
    repository,
    discovery,
    selection: {
      kind: "HIGHEST"
    }
  });
  assert.equal(highest.version, "2.0.0-rc.1");
  assert.equal(
    highest.readFile("index.html").toString(),
    "rc"
  );
});

test("P030 ONLY and equal-precedence HIGHEST ambiguity fail closed", async () => {
  const resolver = fixture([
    {
      path: "artifacts/generator-1.0.0+build-a.zip",
      bytes: artifact("a")
    },
    {
      path: "artifacts/generator-1.0.0+build-b.zip",
      bytes: artifact("b")
    }
  ]);

  for (const selection of [
    { kind: "ONLY" },
    { kind: "HIGHEST" }
  ]) {
    await assert.rejects(
      () => resolver.resolve({
        repository,
        discovery,
        selection
      }),
      (error) => {
        assert.ok(
          error instanceof DeploymentArtifactSelectionError
        );
        assert.equal(
          error.code,
          "DEPLOYER_ARTIFACT_AMBIGUOUS"
        );
        return true;
      }
    );
  }
});

test("P030 invalid ZIP naming and selected ZIP content block rather than guess", async () => {
  const badName = fixture([
    {
      path: "artifacts/latest.zip",
      bytes: artifact()
    }
  ]);
  await assert.rejects(
    () => badName.resolve({
      repository,
      discovery,
      selection: {
        kind: "ONLY"
      }
    }),
    (error) => {
      assert.ok(
        error instanceof DeploymentArtifactSelectionError
      );
      assert.equal(
        error.code,
        "DEPLOYER_ARTIFACT_VERSION_INVALID"
      );
      return true;
    }
  );

  const invalidZip = fixture([
    {
      path: "artifacts/generator-1.0.0.zip",
      bytes: Buffer.from("not-a-zip")
    }
  ]);
  await assert.rejects(
    () => invalidZip.resolve({
      repository,
      discovery,
      selection: {
        kind: "ONLY"
      }
    }),
    (error) => {
      assert.ok(
        error instanceof DeploymentArtifactSelectionError
      );
      assert.equal(
        error.code,
        "DEPLOYER_ARTIFACT_INVALID"
      );
      return true;
    }
  );
});

test("P030 exact version request never falls back to another available version", async () => {
  const resolver = fixture([
    {
      path: "artifacts/generator-1.0.0.zip",
      bytes: artifact()
    }
  ]);
  await assert.rejects(
    () => resolver.resolve({
      repository,
      discovery,
      selection: {
        kind: "EXACT",
        version: "2.0.0"
      }
    }),
    (error) => {
      assert.ok(
        error instanceof DeploymentArtifactSelectionError
      );
      assert.equal(
        error.code,
        "DEPLOYER_ARTIFACT_NOT_FOUND"
      );
      return true;
    }
  );
});
