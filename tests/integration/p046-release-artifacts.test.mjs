import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parsePcmsModulePackage
} from "../../dist/modules/package.js";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("P046 release artifacts carry checksums provenance SBOM and reproducibility evidence", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "pcms-p046-release-")
  );
  const sourceCommit = "b".repeat(40);
  try {
    const built = spawnSync(
      process.execPath,
      ["scripts/build-release.mjs"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PCMS_RELEASE_ROOT: root,
          PCMS_RELEASE_SOURCE_COMMIT: sourceCommit
        },
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
      }
    );
    assert.equal(
      built.status,
      0,
      built.stderr || built.stdout
    );

    const checksumText = await readFile(
      join(root, "SHA256SUMS"),
      "utf8"
    );
    const checksumEntries = checksumText
      .trim()
      .split("\n")
      .map((line) => {
        const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
        assert.ok(match, "invalid checksum line: " + line);
        return {
          expected: match[1],
          path: match[2]
        };
      });
    assert.ok(checksumEntries.length >= 9);
    for (const entry of checksumEntries) {
      assert.equal(
        sha256(await readFile(join(root, entry.path))),
        entry.expected,
        entry.path
      );
    }

    const provenance = JSON.parse(
      await readFile(
        join(root, "provenance.json"),
        "utf8"
      )
    );
    assert.equal(
      provenance.format,
      "pcms-release-provenance-v1"
    );
    assert.equal(provenance.sourceCommit, sourceCommit);
    assert.equal(provenance.sourceCommitVerified, true);
    assert.equal(provenance.core.reproducible, true);
    assert.match(provenance.core.sha256, /^[a-f0-9]{64}$/u);
    assert.match(
      provenance.core.treeSha256,
      /^[a-f0-9]{64}$/u
    );
    assert.deepEqual(
      provenance.modules.map((module) => module.moduleId),
      [
        "deployer",
        "refresher",
        "explorer",
        "account-provisioning",
        "statistics"
      ]
    );
    assert.equal(
      provenance.modules.every(
        (module) => module.reproducible === true
      ),
      true
    );
    assert.equal(
      provenance.compatibilityClaim
        .livePerchanceMullvadMcpVerified,
      false
    );

    for (const module of provenance.modules) {
      const bytes = await readFile(join(root, module.file));
      assert.equal(sha256(bytes), module.sha256);
      const parsed = parsePcmsModulePackage(bytes);
      assert.equal(parsed.manifest.id, module.moduleId);
      assert.equal(
        parsed.manifest.version,
        module.version
      );
      assert.equal(parsed.sha256, module.sha256);
    }

    const sbom = JSON.parse(
      await readFile(
        join(root, provenance.sbom.file),
        "utf8"
      )
    );
    assert.equal(sbom.spdxVersion, "SPDX-2.3");
    assert.equal(
      sbom.packages.some(
        (item) => item.name === "pcms-local"
      ),
      true
    );
    assert.equal(
      sbom.packages.some((item) => item.name === "node"),
      true
    );
    for (const module of provenance.modules) {
      assert.equal(
        sbom.packages.some(
          (item) =>
            item.name === "pcms-module-" + module.moduleId
        ),
        true
      );
    }

    const corePath = join(root, provenance.core.file);
    assert.ok((await stat(corePath)).size > 0);
    const listing = spawnSync(
      "tar",
      ["-tzf", corePath],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
      }
    );
    assert.equal(
      listing.status,
      0,
      listing.stderr || listing.stdout
    );
    const paths = listing.stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.ok(paths.length > 0);
    assert.equal(
      paths.every(
        (path) =>
          path === "pcms-local-dev/" ||
          (
            path.startsWith("pcms-local-dev/") &&
            !path.includes("/../") &&
            !path.startsWith("/")
          )
      ),
      true
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true
    });
  }
});
