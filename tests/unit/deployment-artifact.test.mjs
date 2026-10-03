import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DeploymentArtifactValidationError,
  parseDeploymentArtifact
} from "../../dist/deployer/deployment-artifact.js";
import {
  createZip
} from "../helpers/zip-fixture.mjs";

test("P030 validates root-layout deployment ZIP and computes SHA-256", () => {
  const archive = createZip([
    {
      name: "index.html",
      data: "<main>fixture</main>",
      method: "deflate"
    },
    {
      name: "src/app.js",
      data: "export const value = 1;"
    }
  ]);
  const parsed = parseDeploymentArtifact(
    archive,
    {
      layout: "ROOT",
      requiredFiles: [
        "index.html",
        "src/app.js"
      ]
    }
  );

  assert.equal(
    parsed.sha256,
    createHash("sha256")
      .update(archive)
      .digest("hex")
  );
  assert.equal(parsed.contentRoot, null);
  assert.equal(
    parsed.readFile("index.html").toString(),
    "<main>fixture</main>"
  );
  assert.equal(
    parsed.readFile("src/app.js").toString(),
    "export const value = 1;"
  );
});

test("P030 SINGLE_DIRECTORY layout is explicit and rejects mixed roots", () => {
  const valid = createZip([
    {
      name: "release/index.html",
      data: "<main>release</main>"
    },
    {
      name: "release/src/app.js",
      data: "export {};"
    }
  ]);
  const parsed = parseDeploymentArtifact(
    valid,
    {
      layout: "SINGLE_DIRECTORY",
      requiredFiles: [
        "index.html",
        "src/app.js"
      ]
    }
  );
  assert.equal(parsed.contentRoot, "release");
  assert.equal(
    parsed.readFile("index.html").toString(),
    "<main>release</main>"
  );

  const mixed = createZip([
    {
      name: "release/index.html",
      data: "release"
    },
    {
      name: "other/app.js",
      data: "other"
    }
  ]);
  assert.throws(
    () => parseDeploymentArtifact(
      mixed,
      {
        layout: "SINGLE_DIRECTORY",
        requiredFiles: ["index.html"]
      }
    ),
    (error) =>
      error instanceof DeploymentArtifactValidationError &&
      /exactly one top-level directory/.test(
        error.message
      )
  );
});

test("P030 artifact validation fails closed on missing required files and unsafe ZIP paths", () => {
  const missing = createZip([
    {
      name: "index.html",
      data: "fixture"
    }
  ]);
  assert.throws(
    () => parseDeploymentArtifact(
      missing,
      {
        layout: "ROOT",
        requiredFiles: [
          "index.html",
          "src/app.js"
        ]
      }
    ),
    (error) =>
      error instanceof DeploymentArtifactValidationError &&
      /missing required file: src\/app\.js/.test(
        error.message
      )
  );

  const traversal = createZip([
    {
      name: "../index.html",
      data: "unsafe"
    }
  ]);
  assert.throws(
    () => parseDeploymentArtifact(
      traversal,
      {
        layout: "ROOT",
        requiredFiles: ["index.html"]
      }
    ),
    (error) =>
      error instanceof DeploymentArtifactValidationError &&
      /not normalized/.test(error.message)
  );

  const symlink = createZip([
    {
      name: "index.html",
      data: "target",
      externalAttributes: 0o120777 << 16
    }
  ]);
  assert.throws(
    () => parseDeploymentArtifact(
      symlink,
      {
        layout: "ROOT",
        requiredFiles: ["index.html"]
      }
    ),
    (error) =>
      error instanceof DeploymentArtifactValidationError &&
      /unsafe link\/device\/special file/.test(
        error.message
      )
  );
});

test("P030 duplicate required paths are rejected rather than normalized or guessed", () => {
  const archive = createZip([
    {
      name: "index.html",
      data: "fixture"
    }
  ]);
  assert.throws(
    () => parseDeploymentArtifact(
      archive,
      {
        layout: "ROOT",
        requiredFiles: [
          "index.html",
          "index.html"
        ]
      }
    ),
    (error) =>
      error instanceof DeploymentArtifactValidationError &&
      /duplicate/.test(error.message)
  );
});
