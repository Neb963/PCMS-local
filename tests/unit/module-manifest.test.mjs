import assert from "node:assert/strict";
import test from "node:test";

import {
  ModuleManifestValidationError,
  isValidModuleCapability,
  parseModuleManifest
} from "../../dist/modules/manifest.js";

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "example.module",
    name: "Example Module",
    version: "1.2.3",
    pcmsApi: ">=1.0.0 <2.0.0",
    backend: "backend/index.mjs",
    ui: "ui/index.html",
    capabilities: [
      "accounts.read",
      "secrets.use:example-token",
      "http:https://*.example.com"
    ],
    services: {
      provides: ["example.lookup@1"],
      requires: ["core.helper@1"]
    },
    stateSchemaVersion: 1,
    update: {
      channel: "stable",
      manifestUrl: "https://updates.example.com/example-module.json"
    },
    ...overrides
  };
}

function assertInvalid(value, pattern) {
  assert.throws(
    () => parseModuleManifest(value),
    (error) =>
      error instanceof ModuleManifestValidationError &&
      pattern.test(error.message)
  );
}

test("accepts the documented v1 manifest authority envelope", () => {
  const parsed = parseModuleManifest(validManifest());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.id, "example.module");
  assert.deepEqual(parsed.capabilities, [
    "accounts.read",
    "secrets.use:example-token",
    "http:https://*.example.com"
  ]);
  assert.equal(parsed.update.manifestUrl, "https://updates.example.com/example-module.json");
  assert.equal(Object.isFrozen(parsed), true);
});

test("capability vocabulary rejects unknown and malformed authority", () => {
  assert.equal(isValidModuleCapability("provider.mutate"), true);
  assert.equal(isValidModuleCapability("secrets.use:deploy-key"), true);
  assert.equal(isValidModuleCapability("http:http://localhost:8080"), true);
  assert.equal(isValidModuleCapability("root.shell"), false);
  assert.equal(isValidModuleCapability("secrets.use:"), false);
  assert.equal(isValidModuleCapability("http:https://example.com/path"), false);
  assert.equal(isValidModuleCapability("http:https://user@example.com"), false);

  assertInvalid(
    validManifest({ capabilities: ["accounts.read", "root.shell"] }),
    /unknown or invalid authority/
  );
  assertInvalid(
    validManifest({ capabilities: ["accounts.read", "accounts.read"] }),
    /duplicate value/
  );
});

test("rejects unknown manifest and nested fields", () => {
  assertInvalid({ ...validManifest(), shell: true }, /unknown field: shell/);
  assertInvalid(
    validManifest({ services: { provides: [], arbitrary: true } }),
    /services contains unknown field/
  );
  assertInvalid(
    validManifest({ update: { channel: "stable", signature: "fake" } }),
    /update contains unknown field/
  );
});

test("rejects invalid identity, versions, API ranges and package paths", () => {
  assertInvalid(validManifest({ id: "Bad Module" }), /conservative lowercase ASCII/);
  assertInvalid(validManifest({ version: "1.2" }), /semantic version/);
  assertInvalid(validManifest({ pcmsApi: "*" }), /pcmsApi/);
  assertInvalid(validManifest({ backend: "../index.mjs" }), /normalized relative/);
  assertInvalid(validManifest({ ui: "/tmp/ui.html" }), /normalized relative/);
  assertInvalid(validManifest({ stateSchemaVersion: 0 }), /positive safe integer/);
});

test("rejects insecure update authority and malformed service references", () => {
  assertInvalid(
    validManifest({ update: { manifestUrl: "http://updates.example.com/module.json" } }),
    /absolute HTTPS URL/
  );
  assertInvalid(
    validManifest({ services: { requires: ["bad service"] } }),
    /service reference/
  );
});
