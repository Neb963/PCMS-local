import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const bundleRoot = join(repositoryRoot, "build", "pcms-local-dev");

async function assertFile(path, executable = false) {
  const info = await lstat(join(bundleRoot, path));
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`bundle path must be a regular file: ${path}`);
  }
  if (executable && (info.mode & 0o111) === 0) {
    throw new Error(`bundle path must be executable: ${path}`);
  }
}

for (const path of [
  "manifest.json",
  "SHA256SUMS",
  "share/systemd/user/pcmsd.service",
  "app/dist/daemon/main.js",
  "app/dist/cli/main.js",
  "app/dist/install/installer.js",
  "app/dist/install/open-ui.js"
]) {
  await assertFile(path);
}
for (const path of [
  "runtime/node",
  "bin/pcmsd",
  "bin/pcms",
  "bin/pcms-open",
  "install.sh"
]) {
  await assertFile(path, true);
}

const manifest = JSON.parse(
  await readFile(join(bundleRoot, "manifest.json"), "utf8")
);
if (
  manifest.bundleFormat !== 2 ||
  manifest.platform !== "linux" ||
  manifest.nodeVersion !== process.versions.node ||
  !Number.isSafeInteger(manifest.schemaVersion) ||
  manifest.schemaVersion < 1 ||
  manifest.entries?.node !== "runtime/node" ||
  manifest.entries?.daemon !== "bin/pcmsd" ||
  manifest.entries?.cli !== "bin/pcms" ||
  manifest.entries?.open !== "bin/pcms-open" ||
  manifest.entries?.installer !== "install.sh"
) {
  throw new Error("bundle manifest is inconsistent with the build runtime/layout");
}

for (const launcher of [
  "bin/pcmsd",
  "bin/pcms",
  "bin/pcms-open",
  "install.sh"
]) {
  const content = await readFile(join(bundleRoot, launcher), "utf8");
  if (/\b(?:npm|pnpm|yarn|node_modules)\b/u.test(content)) {
    throw new Error(`bundle launcher depends on a package manager: ${launcher}`);
  }
}


const service = await readFile(
  join(bundleRoot, "share/systemd/user/pcmsd.service"),
  "utf8"
);
if (!service.startsWith("# Managed by PCMS Local installer\n")) {
  throw new Error("bundle user service is not marked as installer-managed");
}

const nodeVersion = execFileSync(join(bundleRoot, "runtime", "node"), ["--version"], {
  encoding: "utf8"
}).trim();
if (nodeVersion !== `v${manifest.nodeVersion}`) {
  throw new Error(
    `bundled Node reports ${nodeVersion}; expected v${manifest.nodeVersion}`
  );
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

const checksumFile = await readFile(join(bundleRoot, "SHA256SUMS"), "utf8");
const lines = checksumFile.trim().split("\n").filter(Boolean);
if (lines.length === 0) {
  throw new Error("bundle checksum inventory is empty");
}
for (const line of lines) {
  const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
  if (match === null) {
    throw new Error(`invalid SHA256SUMS line: ${line}`);
  }
  const [, expected, path] = match;
  if (await hashFile(join(bundleRoot, path)) !== expected) {
    throw new Error(`bundle checksum mismatch: ${path}`);
  }
}

process.stdout.write(
  `bundle smoke passed: node=${nodeVersion}, files=${lines.length}\n`
);
