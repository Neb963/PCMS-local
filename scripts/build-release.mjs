import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { arch, platform } from "node:process";
import { gzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildOfficialModulePackages
} from "./release-modules.mjs";

const repositoryRoot = fileURLToPath(
  new URL("../", import.meta.url)
);
const buildRoot = join(repositoryRoot, "build");
const bundleRoot = join(buildRoot, "pcms-local-dev");
const releaseRoot = resolve(
  process.env.PCMS_RELEASE_ROOT ??
    join(buildRoot, "release-p046")
);
const packageJson = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8")
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function collectFiles(root, path = root) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        "release input contains a symbolic link: " +
          relative(root, child)
      );
    }
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, child));
    } else if (entry.isFile()) {
      files.push(relative(root, child));
    } else {
      throw new Error(
        "release input contains a special file: " +
          relative(root, child)
      );
    }
  }
  return files.sort();
}

async function canonicalTreeDigest(root) {
  const hash = createHash("sha256");
  for (const path of await collectFiles(root)) {
    const metadata = await stat(join(root, path));
    hash.update(path);
    hash.update("\0");
    hash.update(String(metadata.mode & 0o777));
    hash.update("\0");
    hash.update(await readFile(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function coreArchiveBytes() {
  const result = spawnSync(
    "tar",
    [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--format=gnu",
      "-cf",
      "-",
      "pcms-local-dev"
    ],
    {
      cwd: buildRoot,
      encoding: null,
      maxBuffer: 512 * 1024 * 1024
    }
  );
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : String(result.stderr ?? "");
    throw new Error(
      "deterministic Core archive creation failed: " +
        stderr.trim()
    );
  }
  return gzipSync(result.stdout, {
    level: 9,
    mtime: 0
  });
}

function sourceCommit() {
  const candidate =
    process.env.PCMS_RELEASE_SOURCE_COMMIT ??
    process.env.GITHUB_SHA ??
    "";
  return /^[a-f0-9]{40}$/u.test(candidate)
    ? candidate
    : "UNSPECIFIED";
}

if (platform !== "linux") {
  throw new Error("release artifacts currently support Linux only");
}

const bundleInfo = await stat(bundleRoot).catch(() => null);
if (bundleInfo === null || !bundleInfo.isDirectory()) {
  throw new Error(
    "Core bundle is missing; run scripts/build-bundle.mjs first"
  );
}
if (
  releaseRoot === resolve(bundleRoot) ||
  releaseRoot.startsWith(resolve(bundleRoot) + "/")
) {
  throw new Error("release root must not overlap the Core bundle");
}

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(join(releaseRoot, "modules"), {
  recursive: true,
  mode: 0o755
});

const firstCore = coreArchiveBytes();
const secondCore = coreArchiveBytes();
if (!firstCore.equals(secondCore)) {
  throw new Error(
    "Core release archive is not byte-reproducible"
  );
}

const coreName =
  `pcms-local-${packageJson.version}-linux-${arch}.tar.gz`;
const corePath = join(releaseRoot, coreName);
await writeFile(corePath, firstCore, { mode: 0o644 });

const firstModules =
  buildOfficialModulePackages(packageJson.version);
const secondModules =
  buildOfficialModulePackages(packageJson.version);
const modules = [];
for (let index = 0; index < firstModules.length; index += 1) {
  const first = firstModules[index];
  const second = secondModules[index];
  if (
    first.moduleId !== second.moduleId ||
    !first.bytes.equals(second.bytes)
  ) {
    throw new Error(
      `module package is not byte-reproducible: ${first.moduleId}`
    );
  }
  const file =
    `${first.moduleId}-${first.version}.pcmsmod`;
  const path = join(releaseRoot, "modules", file);
  await writeFile(path, first.bytes, { mode: 0o644 });
  modules.push(Object.freeze({
    moduleId: first.moduleId,
    version: first.version,
    file: `modules/${file}`,
    sha256: first.sha256,
    bytes: first.bytes.length,
    reproducible: true
  }));
}

const commit = sourceCommit();
const coreSha256 = sha256(firstCore);
const nodeSha256 = await hashFile(process.execPath);
const lockfileSha256 = await hashFile(
  join(repositoryRoot, "package-lock.json")
);
const portingProvenanceSha256 = await hashFile(
  join(repositoryRoot, "PORTING_PROVENANCE.md")
);
const coreTreeSha256 = await canonicalTreeDigest(bundleRoot);

const sbom = Object.freeze({
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "pcms-local-release",
  documentNamespace:
    "https://github.com/Neb963/PCMS-local/p046/" +
    encodeURIComponent(commit),
  creationInfo: Object.freeze({
    created: "1970-01-01T00:00:00Z",
    creators: Object.freeze([
      "Tool: pcms-local-p046-release-builder"
    ])
  }),
  packages: Object.freeze([
    Object.freeze({
      SPDXID: "SPDXRef-Package-PCMS",
      name: "pcms-local",
      versionInfo: packageJson.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      checksums: Object.freeze([
        Object.freeze({
          algorithm: "SHA256",
          checksumValue: coreSha256
        })
      ])
    }),
    Object.freeze({
      SPDXID: "SPDXRef-Package-Node",
      name: "node",
      versionInfo: process.versions.node,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      checksums: Object.freeze([
        Object.freeze({
          algorithm: "SHA256",
          checksumValue: nodeSha256
        })
      ])
    }),
    ...modules.map((module) => Object.freeze({
      SPDXID:
        "SPDXRef-Package-Module-" +
        module.moduleId.replace(/[^A-Za-z0-9.-]/gu, "-"),
      name: "pcms-module-" + module.moduleId,
      versionInfo: module.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      checksums: Object.freeze([
        Object.freeze({
          algorithm: "SHA256",
          checksumValue: module.sha256
        })
      ])
    }))
  ]),
  relationships: Object.freeze([
    Object.freeze({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-Package-PCMS"
    }),
    ...modules.map((module) => Object.freeze({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement:
        "SPDXRef-Package-Module-" +
        module.moduleId.replace(/[^A-Za-z0-9.-]/gu, "-")
    }))
  ])
});
const sbomPath = join(releaseRoot, "sbom.spdx.json");
await writeFile(
  sbomPath,
  JSON.stringify(sbom, null, 2) + "\n",
  { mode: 0o644 }
);
const sbomSha256 = await hashFile(sbomPath);

const provenance = Object.freeze({
  format: "pcms-release-provenance-v1",
  sourceCommit: commit,
  sourceCommitVerified: commit !== "UNSPECIFIED",
  packageVersion: packageJson.version,
  platform,
  arch,
  toolchain: Object.freeze({
    nodeVersion: process.versions.node,
    nodeSha256
  }),
  core: Object.freeze({
    file: coreName,
    sha256: coreSha256,
    bytes: firstCore.length,
    treeSha256: coreTreeSha256,
    reproducible: true
  }),
  modules: Object.freeze(modules),
  sbom: Object.freeze({
    file: "sbom.spdx.json",
    sha256: sbomSha256
  }),
  sourceInputs: Object.freeze({
    packageLockSha256: lockfileSha256,
    portingProvenanceSha256
  }),
  compatibilityClaim: Object.freeze({
    deterministicCiOnly: true,
    livePerchanceMullvadMcpVerified: false
  })
});
await writeFile(
  join(releaseRoot, "provenance.json"),
  JSON.stringify(provenance, null, 2) + "\n",
  { mode: 0o644 }
);

const checksumFiles = (await collectFiles(releaseRoot))
  .filter((path) => path !== "SHA256SUMS");
const checksumLines = [];
for (const path of checksumFiles) {
  checksumLines.push(
    `${await hashFile(join(releaseRoot, path))}  ${path}`
  );
}
await writeFile(
  join(releaseRoot, "SHA256SUMS"),
  checksumLines.join("\n") + "\n",
  { mode: 0o644 }
);

process.stdout.write(
  `release artifacts built: ${releaseRoot}\n`
);
