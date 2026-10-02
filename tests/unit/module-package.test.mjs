import assert from "node:assert/strict";
import test from "node:test";

import {
  ModulePackageValidationError,
  parsePcmsModulePackage
} from "../../dist/modules/package.js";
import {
  createModuleZip,
  createZip,
  moduleManifest
} from "../helpers/zip-fixture.mjs";

test("parses and fully validates a bounded .pcmsmod ZIP", () => {
  const archive = createModuleZip({
    manifest: moduleManifest({
      ui: "ui/index.html",
      capabilities: ["accounts.read", "http:http://localhost:8080"]
    }),
    extraEntries: [
      { name: "ui/index.html", data: "<main>fixture</main>", method: "deflate" },
      { name: "README.md", data: "fixture" }
    ]
  });

  const parsed = parsePcmsModulePackage(archive);
  assert.match(parsed.sha256, /^[0-9a-f]{64}$/);
  assert.equal(parsed.manifest.id, "fixture.module");
  assert.equal(parsed.manifest.ui, "ui/index.html");
  assert.equal(parsed.readFile("backend/index.mjs").toString(), "export default {};");
  assert.equal(parsed.readFile("ui/index.html").toString(), "<main>fixture</main>");
  assert.ok(parsed.entries.some((entry) => entry.compression === "deflate"));

  const mutableCopy = parsed.readFile("README.md");
  mutableCopy.fill(0);
  assert.equal(parsed.readFile("README.md").toString(), "fixture");
});

test("requires one root manifest and all manifest entrypoints", () => {
  const noManifest = createZip([
    { name: "backend/index.mjs", data: "export default {};" }
  ]);
  assert.throws(
    () => parsePcmsModulePackage(noManifest),
    (error) =>
      error instanceof ModulePackageValidationError &&
      /root manifest\.json/.test(error.message)
  );

  const missingBackend = createZip([
    { name: "manifest.json", data: JSON.stringify(moduleManifest()) }
  ]);
  assert.throws(
    () => parsePcmsModulePackage(missingBackend),
    /backend entry is missing/
  );
});
