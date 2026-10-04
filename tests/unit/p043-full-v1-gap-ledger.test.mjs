import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const EXPECTED = new Map([
  ["generator inventory and ownership", "IMPLEMENTED"],
  ["Projects", "PARTIAL"],
  ["workspaces and revision history", "DEFERRED"],
  ["deployments and external-drift detection", "PARTIAL"],
  ["reusable Workflows", "DEFERRED"],
  ["scheduling", "IMPLEMENTED"],
  ["queues", "IMPLEMENTED"],
  ["batch execution", "IMPLEMENTED"],
  ["modules", "IMPLEMENTED"],
  ["Refresher", "IMPLEMENTED"],
  ["Explorer", "IMPLEMENTED"],
  ["Account Provisioning", "IMPLEMENTED"],
  ["Statistics", "IMPLEMENTED"],
  ["Attention", "IMPLEMENTED"],
  ["notifications", "DEFERRED"],
  ["global search", "PARTIAL"],
  ["backup/recovery", "IMPLEMENTED"],
  ["operational diagnostics", "IMPLEMENTED"]
]);

function escapeRegex(value) {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

test("P043 Full V1 gap ledger enumerates every PRD section 24 requirement with an explicit disposition", async () => {
  const [prd, ledger, roadmap, traceability] = await Promise.all([
    readFile(
      "docs/product/PRODUCT_REQUIREMENTS.md",
      "utf8"
    ),
    readFile(
      "docs/implementation/v0.1/FULL_V1_GAP_LEDGER.md",
      "utf8"
    ),
    readFile("ROADMAP.md", "utf8"),
    readFile(
      "docs/implementation/v0.1/SPEC_TRACEABILITY.md",
      "utf8"
    )
  ]);

  const boundary = prd.slice(
    prd.indexOf("# 24. Full V1 product boundary"),
    prd.indexOf("# 25. Product acceptance scenarios")
  );
  assert.ok(boundary.length > 0);

  for (const [requirement, status] of EXPECTED) {
    assert.match(
      boundary,
      new RegExp("- " + escapeRegex(requirement) + ";")
    );
    assert.match(
      ledger,
      new RegExp(
        "\\| " +
          escapeRegex(requirement) +
          " \\| \\*\\*" +
          status +
          "\\*\\* \\|"
      )
    );
  }

  const requirementLines = boundary
    .split("\n")
    .filter((line) => line.startsWith("- "));
  assert.equal(requirementLines.length, EXPECTED.size);

  assert.match(
    ledger,
    /Full V1 is \*\*not satisfied\*\* while any row above is \*\*PARTIAL\*\* or \*\*DEFERRED\*\*/
  );
  assert.match(
    roadmap,
    /FULL_V1_GAP_LEDGER\.md/
  );
  assert.match(
    traceability,
    /FULL_V1_GAP_LEDGER\.md/
  );
  assert.match(
    roadmap,
    /must not describe v0\.1 as\s+\*\*Full V1\*\*/
  );
});
