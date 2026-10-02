import assert from "node:assert/strict";
import test from "node:test";

test("built workspace resolves through the package export", async () => {
  const entry = await import("pcms-local");
  assert.deepEqual(entry.workspaceMetadata, {
    name: "pcms-local",
    baseline: "0.1",
    version: "0.0.0",
    runtime: "node"
  });
});
