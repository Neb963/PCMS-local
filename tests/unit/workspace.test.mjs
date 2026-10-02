import assert from "node:assert/strict";
import test from "node:test";

import { workspaceMetadata } from "../../dist/workspace.js";

test("workspace metadata exposes only inert foundation identity", () => {
  assert.deepEqual(workspaceMetadata, {
    name: "pcms-local",
    baseline: "0.1",
    runtime: "node"
  });
  assert.equal(Object.isFrozen(workspaceMetadata), true);
});
