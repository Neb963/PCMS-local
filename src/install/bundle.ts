import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  readdir
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

export interface PcmsBundleManifest {
  readonly bundleFormat: 2;
  readonly name: "pcms-local";
  readonly packageVersion: string;
  readonly nodeVersion: string;
  readonly platform: "linux";
  readonly arch: string;
  readonly schemaVersion: number;
  readonly entries: Readonly<{
    daemon: "bin/pcmsd";
    cli: "bin/pcms";
    open: "bin/pcms-open";
    node: "runtime/node";
    installer: "install.sh";
    systemdUserService:
      "share/systemd/user/pcmsd.service";
  }>;
}

export interface VerifiedPcmsBundle {
  readonly root: string;
  readonly manifest: PcmsBundleManifest;
  readonly releaseId: string;
  readonly checksumCount: number;
}

function isRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function safeRoot(root: string): string {
  if (!isAbsolute(root)) {
    throw new Error("bundle root must be absolute");
  }
  return resolve(root);
}

function safeRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some(
      (part) => part === "" || part === "." || part === ".."
    )
  ) {
    throw new Error(
      `bundle checksum path is unsafe: ${path}`
    );
  }
}

function parseManifest(value: unknown): PcmsBundleManifest {
  if (!isRecord(value) || !isRecord(value["entries"])) {
    throw new Error("bundle manifest has an invalid shape");
  }
  const entries = value["entries"];
  const packageVersion = value["packageVersion"];
  const nodeVersion = value["nodeVersion"];
  const arch = value["arch"];
  const schemaVersion = value["schemaVersion"];

  if (
    value["bundleFormat"] !== 2 ||
    value["name"] !== "pcms-local" ||
    typeof packageVersion !== "string" ||
    !SAFE_VERSION.test(packageVersion) ||
    typeof nodeVersion !== "string" ||
    nodeVersion.length === 0 ||
    nodeVersion.length > 64 ||
    value["platform"] !== "linux" ||
    typeof arch !== "string" ||
    arch.length === 0 ||
    arch.length > 64 ||
    typeof schemaVersion !== "number" ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1 ||
    entries["daemon"] !== "bin/pcmsd" ||
    entries["cli"] !== "bin/pcms" ||
    entries["open"] !== "bin/pcms-open" ||
    entries["node"] !== "runtime/node" ||
    entries["installer"] !== "install.sh" ||
    entries["systemdUserService"] !==
      "share/systemd/user/pcmsd.service"
  ) {
    throw new Error(
      "bundle manifest is incompatible with this installer"
    );
  }

  return Object.freeze({
    bundleFormat: 2,
    name: "pcms-local",
    packageVersion,
    nodeVersion,
    platform: "linux",
    arch,
    schemaVersion,
    entries: Object.freeze({
      daemon: "bin/pcmsd",
      cli: "bin/pcms",
      open: "bin/pcms-open",
      node: "runtime/node",
      installer: "install.sh",
      systemdUserService:
        "share/systemd/user/pcmsd.service"
    })
  });
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function collectTree(
  root: string,
  directory = root
): Promise<Readonly<{
  files: readonly string[];
  directories: readonly string[];
}>> {
  const files: string[] = [];
  const directories: string[] = [];
  const entries = await readdir(
    directory,
    { withFileTypes: true }
  );

  for (const entry of entries) {
    const path = join(directory, entry.name);
    const rel = relative(root, path).split("\\").join("/");
    if (entry.isSymbolicLink()) {
      throw new Error(
        `bundle must not contain symbolic links: ${rel}`
      );
    }
    if (entry.isDirectory()) {
      directories.push(rel);
      const nested = await collectTree(root, path);
      files.push(...nested.files);
      directories.push(...nested.directories);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `bundle contains unsupported filesystem entry: ${rel}`
      );
    }
    files.push(rel);
  }

  return Object.freeze({
    files: Object.freeze(files.sort()),
    directories: Object.freeze(directories.sort())
  });
}

export async function verifyPcmsBundle(
  root: string
): Promise<VerifiedPcmsBundle> {
  const bundleRoot = safeRoot(root);
  const rootInfo = await lstat(bundleRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(
      "bundle root must be a real directory"
    );
  }

  const manifest = parseManifest(
    JSON.parse(
      await readFile(
        join(bundleRoot, "manifest.json"),
        "utf8"
      )
    )
  );

  const checksumBytes = await readFile(
    join(bundleRoot, "SHA256SUMS")
  );
  const checksumText = checksumBytes.toString("utf8");
  const expected = new Map<string, string>();

  for (const line of checksumText.split("\n")) {
    if (line === "") continue;
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (match === null) {
      throw new Error(
        `bundle checksum line is invalid: ${line}`
      );
    }
    const digest = match[1]!;
    const path = match[2]!;
    safeRelativePath(path);
    if (!SHA256.test(digest) || expected.has(path)) {
      throw new Error(
        `bundle checksum entry is invalid: ${path}`
      );
    }
    expected.set(path, digest);
  }
  if (expected.size === 0) {
    throw new Error("bundle checksum inventory is empty");
  }

  const tree = await collectTree(bundleRoot);
  const actualFiles = tree.files.filter(
    (path) => path !== "SHA256SUMS"
  );
  const expectedFiles = [...expected.keys()].sort();
  if (
    actualFiles.length !== expectedFiles.length ||
    actualFiles.some(
      (path, index) => path !== expectedFiles[index]
    )
  ) {
    throw new Error(
      "bundle filesystem does not match checksum inventory"
    );
  }

  for (const [path, expectedDigest] of expected) {
    const fullPath = resolve(bundleRoot, path);
    const inside = relative(bundleRoot, fullPath);
    if (
      inside === "" ||
      inside.startsWith("..") ||
      isAbsolute(inside)
    ) {
      throw new Error(
        `bundle checksum path escapes root: ${path}`
      );
    }
    const info = await lstat(fullPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(
        `bundle checksum target is not a regular file: ${path}`
      );
    }
    if (await hashFile(fullPath) !== expectedDigest) {
      throw new Error(
        `bundle checksum mismatch: ${path}`
      );
    }
  }

  const inventoryDigest = createHash("sha256")
    .update(checksumBytes)
    .digest("hex");
  const releaseId =
    `${manifest.packageVersion}-${inventoryDigest.slice(0, 16)}`;

  return Object.freeze({
    root: bundleRoot,
    manifest,
    releaseId,
    checksumCount: expected.size
  });
}
