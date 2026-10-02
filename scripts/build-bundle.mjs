import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { PCMSD_USER_SERVICE } from "../dist/install/systemd.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const buildRoot = join(repositoryRoot, "build");
const bundleRoot = join(buildRoot, "pcms-local-dev");
const packageJson = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8")
);

if (process.platform !== "linux") {
  throw new Error("development bundle skeleton currently supports Linux only");
}
if (packageJson.engines?.node !== process.versions.node) {
  throw new Error(
    `bundle Node ${process.versions.node} does not match pinned engine ${packageJson.engines?.node}`
  );
}

await rm(bundleRoot, { recursive: true, force: true });
await mkdir(join(bundleRoot, "app"), { recursive: true, mode: 0o755 });
await mkdir(join(bundleRoot, "runtime"), { recursive: true, mode: 0o755 });
await mkdir(join(bundleRoot, "bin"), { recursive: true, mode: 0o755 });
await mkdir(join(bundleRoot, "share", "systemd", "user"), {
  recursive: true,
  mode: 0o755
});

await cp(join(repositoryRoot, "dist"), join(bundleRoot, "app", "dist"), {
  recursive: true
});
await cp(process.execPath, join(bundleRoot, "runtime", "node"));
await chmod(join(bundleRoot, "runtime", "node"), 0o755);

const daemonLauncher = `#!/bin/sh
set -eu
case "$0" in
  */*) SCRIPT_DIR=${0%/*} ;;
  *) SCRIPT_DIR=. ;;
esac
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
exec "$ROOT/runtime/node" "$ROOT/app/dist/daemon/main.js" "$@"
`;
const cliLauncher = `#!/bin/sh
set -eu
case "$0" in
  */*) SCRIPT_DIR=${0%/*} ;;
  *) SCRIPT_DIR=. ;;
esac
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
exec "$ROOT/runtime/node" "$ROOT/app/dist/cli/main.js" "$@"
`;

await writeFile(join(bundleRoot, "bin", "pcmsd"), daemonLauncher, {
  mode: 0o755
});
await writeFile(join(bundleRoot, "bin", "pcms"), cliLauncher, {
  mode: 0o755
});
await writeFile(
  join(bundleRoot, "share", "systemd", "user", "pcmsd.service"),
  PCMSD_USER_SERVICE,
  { mode: 0o644 }
);

const manifest = Object.freeze({
  bundleFormat: 1,
  name: "pcms-local",
  packageVersion: packageJson.version,
  nodeVersion: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  entries: Object.freeze({
    daemon: "bin/pcmsd",
    cli: "bin/pcms",
    node: "runtime/node",
    systemdUserService: "share/systemd/user/pcmsd.service"
  })
});
await writeFile(
  join(bundleRoot, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 }
);

async function collectFiles(root, path = root) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, child));
    } else if (entry.isFile()) {
      files.push(relative(root, child));
    }
  }
  return files;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

const checksumTargets = (await collectFiles(bundleRoot))
  .filter((path) => path !== "SHA256SUMS")
  .sort();

const checksumLines = [];
for (const path of checksumTargets) {
  const fullPath = join(bundleRoot, path);
  const info = await stat(fullPath);
  if (!info.isFile()) {
    throw new Error(`bundle checksum target is not a file: ${path}`);
  }
  checksumLines.push(`${await hashFile(fullPath)}  ${path}`);
}
await writeFile(
  join(bundleRoot, "SHA256SUMS"),
  `${checksumLines.join("\n")}\n`,
  { mode: 0o644 }
);

await mkdir(buildRoot, { recursive: true });
process.stdout.write(`bundle built: ${bundleRoot}\n`);
