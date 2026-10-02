import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { inflateRawSync } from "node:zlib";

import {
  ModuleManifestValidationError,
  type ModuleManifestV1,
  parseModuleManifest
} from "./manifest.js";

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

export const MODULE_PACKAGE_LIMITS = Object.freeze({
  archiveBytes: 16 * 1024 * 1024,
  entries: 512,
  entryUncompressedBytes: 8 * 1024 * 1024,
  totalUncompressedBytes: 32 * 1024 * 1024,
  manifestBytes: 256 * 1024,
  compressionRatio: 100,
  pathBytes: 512
});

export interface ModulePackageEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly compression: "stored" | "deflate";
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
}

export interface ParsedModulePackage {
  readonly sha256: string;
  readonly manifest: ModuleManifestV1;
  readonly entries: readonly ModulePackageEntry[];
  readFile(path: string): Buffer;
}

export class ModulePackageValidationError extends Error {
  public readonly code = "INVALID_MODULE_PACKAGE";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModulePackageValidationError";
  }
}

interface CentralEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly compressionMethod: 0 | 8;
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly nameBytes: Buffer;
}

interface LocatedEntry extends CentralEntry {
  readonly dataOffset: number;
  readonly dataEnd: number;
}

function fail(message: string, cause?: unknown): never {
  throw new ModulePackageValidationError(
    message,
    cause === undefined ? undefined : { cause }
  );
}

function u16(buffer: Buffer, offset: number, field: string): number {
  if (offset < 0 || offset + 2 > buffer.length) {
    fail(`truncated ZIP while reading ${field}`);
  }
  return buffer.readUInt16LE(offset);
}

function u32(buffer: Buffer, offset: number, field: string): number {
  if (offset < 0 || offset + 4 > buffer.length) {
    fail(`truncated ZIP while reading ${field}`);
  }
  return buffer.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentLength = u16(buffer, offset + 20, "EOCD comment length");
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  fail("ZIP end-of-central-directory record is missing or malformed");
}

function decodeEntryName(nameBytes: Buffer, flags: number): string {
  if (nameBytes.length === 0 || nameBytes.length > MODULE_PACKAGE_LIMITS.pathBytes) {
    fail("ZIP entry path length is invalid");
  }

  if ((flags & 0x0800) === 0) {
    for (const byte of nameBytes) {
      if (byte > 0x7f) {
        fail("ZIP entry names must be UTF-8 or ASCII");
      }
    }
    return nameBytes.toString("ascii");
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
  } catch (error: unknown) {
    fail("ZIP entry path is not valid UTF-8", error);
  }
}

function canonicalEntryPath(name: string, directory: boolean): string {
  if (
    name.includes("\u0000") ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name)
  ) {
    fail(`unsafe ZIP entry path: ${JSON.stringify(name)}`);
  }

  const raw = directory && name.endsWith("/") ? name.slice(0, -1) : name;
  if (raw.length === 0) fail("ZIP entry path cannot be empty");
  const segments = raw.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  ) {
    fail(`ZIP entry path is not normalized: ${JSON.stringify(name)}`);
  }

  const normalized = raw.normalize("NFC");
  if (normalized !== raw) {
    fail(`ZIP entry path must use NFC normalization: ${JSON.stringify(name)}`);
  }
  return normalized;
}

function entryKind(
  name: string,
  externalAttributes: number
): "file" | "directory" {
  const unixMode = externalAttributes >>> 16;
  const fileType = unixMode & 0o170000;
  if (
    fileType !== 0 &&
    fileType !== 0o100000 &&
    fileType !== 0o040000
  ) {
    fail(`ZIP entry is an unsafe link/device/special file: ${JSON.stringify(name)}`);
  }

  const pathDirectory = name.endsWith("/");
  const modeDirectory = fileType === 0o040000;
  const dosDirectory = (externalAttributes & 0x10) !== 0;

  if (fileType === 0o100000 && pathDirectory) {
    fail(`ZIP entry file type conflicts with directory path: ${JSON.stringify(name)}`);
  }
  if (modeDirectory && !pathDirectory) {
    fail(`ZIP directory entry must end with '/': ${JSON.stringify(name)}`);
  }

  return pathDirectory || modeDirectory || dosDirectory ? "directory" : "file";
}

function validateFlags(flags: number): void {
  const allowed = 0x0800 | 0x0008 | 0x0004 | 0x0002;
  if ((flags & ~allowed) !== 0) {
    fail(`ZIP entry uses unsupported or unsafe general-purpose flags: 0x${flags.toString(16)}`);
  }
}

function parseCentralDirectory(
  buffer: Buffer,
  eocdOffset: number
): readonly CentralEntry[] {
  if (
    u16(buffer, eocdOffset + 4, "disk number") !== 0 ||
    u16(buffer, eocdOffset + 6, "central-directory disk") !== 0
  ) {
    fail("multi-disk ZIP packages are not supported");
  }

  const diskEntries = u16(buffer, eocdOffset + 8, "entries on disk");
  const entryCount = u16(buffer, eocdOffset + 10, "entry count");
  const centralSize = u32(buffer, eocdOffset + 12, "central-directory size");
  const centralOffset = u32(buffer, eocdOffset + 16, "central-directory offset");

  if (
    diskEntries === 0xffff ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    fail("ZIP64 module packages are not supported");
  }
  if (diskEntries !== entryCount) fail("multi-disk ZIP entry counts are invalid");
  if (entryCount === 0 || entryCount > MODULE_PACKAGE_LIMITS.entries) {
    fail(`ZIP entry count exceeds limit of ${MODULE_PACKAGE_LIMITS.entries}`);
  }
  if (centralOffset + centralSize !== eocdOffset) {
    fail("ZIP central directory bounds are inconsistent");
  }

  let cursor = centralOffset;
  let totalUncompressed = 0;
  const paths = new Map<string, "file" | "directory">();
  const entries: CentralEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (u32(buffer, cursor, "central entry signature") !== CENTRAL_FILE_SIGNATURE) {
      fail("ZIP central-directory entry signature is invalid");
    }
    if (cursor + 46 > eocdOffset) fail("ZIP central-directory entry is truncated");

    const versionNeeded = u16(buffer, cursor + 6, "version needed");
    if (versionNeeded >= 45) fail("ZIP64 module packages are not supported");

    const flags = u16(buffer, cursor + 8, "entry flags");
    validateFlags(flags);

    const method = u16(buffer, cursor + 10, "compression method");
    if (method !== 0 && method !== 8) {
      fail(`unsupported ZIP compression method: ${method}`);
    }

    const crc = u32(buffer, cursor + 16, "CRC32");
    const compressedSize = u32(buffer, cursor + 20, "compressed size");
    const uncompressedSize = u32(buffer, cursor + 24, "uncompressed size");
    const nameLength = u16(buffer, cursor + 28, "filename length");
    const extraLength = u16(buffer, cursor + 30, "extra length");
    const commentLength = u16(buffer, cursor + 32, "entry comment length");
    const diskStart = u16(buffer, cursor + 34, "entry disk start");
    const externalAttributes = u32(buffer, cursor + 38, "external attributes");
    const localHeaderOffset = u32(buffer, cursor + 42, "local-header offset");

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      fail("ZIP64 module packages are not supported");
    }
    if (diskStart !== 0) fail("multi-disk ZIP entries are not supported");

    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > centralOffset + centralSize) {
      fail("ZIP central-directory entry exceeds declared bounds");
    }

    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeEntryName(nameBytes, flags);
    const kind = entryKind(name, externalAttributes);
    const path = canonicalEntryPath(name, kind === "directory");

    if (paths.has(path)) {
      fail(`duplicate normalized ZIP entry path: ${path}`);
    }
    for (const [existingPath, existingKind] of paths) {
      if (
        (existingKind === "file" && path.startsWith(`${existingPath}/`)) ||
        (kind === "file" && existingPath.startsWith(`${path}/`))
      ) {
        fail(`ZIP file/directory path conflict: ${path}`);
      }
    }
    paths.set(path, kind);

    if (kind === "directory") {
      if (compressedSize !== 0 || uncompressedSize !== 0) {
        fail(`ZIP directory must be empty: ${path}`);
      }
    } else {
      if (uncompressedSize > MODULE_PACKAGE_LIMITS.entryUncompressedBytes) {
        fail(`ZIP entry exceeds uncompressed size limit: ${path}`);
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MODULE_PACKAGE_LIMITS.totalUncompressedBytes) {
        fail("ZIP total uncompressed size exceeds package limit");
      }
      if (method === 0 && compressedSize !== uncompressedSize) {
        fail(`stored ZIP entry has inconsistent sizes: ${path}`);
      }
      if (
        uncompressedSize > 0 &&
        (compressedSize === 0 ||
          uncompressedSize / compressedSize > MODULE_PACKAGE_LIMITS.compressionRatio)
      ) {
        fail(`ZIP entry exceeds compression-ratio limit: ${path}`);
      }
    }

    entries.push({
      path,
      kind,
      compressionMethod: method,
      flags,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      nameBytes: Buffer.from(nameBytes)
    });
    cursor = entryEnd;
  }

  if (cursor !== centralOffset + centralSize) {
    fail("ZIP central directory contains unparsed trailing records");
  }
  return entries;
}

function locateEntryData(
  buffer: Buffer,
  entry: CentralEntry,
  centralOffset: number
): LocatedEntry {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > centralOffset) fail(`ZIP local header is out of bounds: ${entry.path}`);
  if (u32(buffer, offset, "local file signature") !== LOCAL_FILE_SIGNATURE) {
    fail(`ZIP local-header signature is invalid: ${entry.path}`);
  }

  const flags = u16(buffer, offset + 6, "local flags");
  const method = u16(buffer, offset + 8, "local compression method");
  if (flags !== entry.flags || method !== entry.compressionMethod) {
    fail(`ZIP local/central metadata mismatch: ${entry.path}`);
  }

  const localCrc = u32(buffer, offset + 14, "local CRC32");
  const localCompressed = u32(buffer, offset + 18, "local compressed size");
  const localUncompressed = u32(buffer, offset + 22, "local uncompressed size");
  if ((flags & 0x0008) === 0) {
    if (
      localCrc !== entry.crc32 ||
      localCompressed !== entry.compressedSize ||
      localUncompressed !== entry.uncompressedSize
    ) {
      fail(`ZIP local/central size or CRC mismatch: ${entry.path}`);
    }
  } else if (
    (localCrc !== 0 && localCrc !== entry.crc32) ||
    (localCompressed !== 0 && localCompressed !== entry.compressedSize) ||
    (localUncompressed !== 0 && localUncompressed !== entry.uncompressedSize)
  ) {
    fail(`ZIP data-descriptor metadata is inconsistent: ${entry.path}`);
  }

  const nameLength = u16(buffer, offset + 26, "local filename length");
  const extraLength = u16(buffer, offset + 28, "local extra length");
  const nameStart = offset + 30;
  const nameEnd = nameStart + nameLength;
  const dataOffset = nameEnd + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > centralOffset) fail(`ZIP entry data is out of bounds: ${entry.path}`);

  const localName = buffer.subarray(nameStart, nameEnd);
  if (!localName.equals(entry.nameBytes)) {
    fail(`ZIP local/central filename mismatch: ${entry.path}`);
  }

  return { ...entry, dataOffset, dataEnd };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    const tableValue = CRC_TABLE[(crc ^ byte) & 0xff];
    if (tableValue === undefined) fail("internal CRC table lookup failed");
    crc = tableValue ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inflateEntry(buffer: Buffer, entry: LocatedEntry): Buffer {
  if (entry.kind === "directory") return Buffer.alloc(0);
  const compressed = buffer.subarray(entry.dataOffset, entry.dataEnd);
  let output: Buffer;
  try {
    output =
      entry.compressionMethod === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, {
            maxOutputLength: entry.uncompressedSize + 1
          });
  } catch (error: unknown) {
    fail(`ZIP entry decompression failed: ${entry.path}`, error);
  }

  if (output.length !== entry.uncompressedSize) {
    fail(`ZIP entry uncompressed length mismatch: ${entry.path}`);
  }
  if (crc32(output) !== entry.crc32) {
    fail(`ZIP entry CRC32 mismatch: ${entry.path}`);
  }
  return output;
}

function parseManifest(bytes: Buffer): ModuleManifestV1 {
  if (bytes.length > MODULE_PACKAGE_LIMITS.manifestBytes) {
    fail("manifest.json exceeds manifest size limit");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    fail("manifest.json is not valid UTF-8", error);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    fail("manifest.json is not valid JSON", error);
  }

  try {
    return parseModuleManifest(value);
  } catch (error: unknown) {
    if (error instanceof ModuleManifestValidationError) {
      fail(error.message, error);
    }
    throw error;
  }
}

export function parsePcmsModulePackage(input: Uint8Array): ParsedModulePackage {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buffer.length === 0 || buffer.length > MODULE_PACKAGE_LIMITS.archiveBytes) {
    fail(`module archive byte size must be between 1 and ${MODULE_PACKAGE_LIMITS.archiveBytes}`);
  }
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const centralOffset = u32(buffer, eocdOffset + 16, "central-directory offset");
  const centralEntries = parseCentralDirectory(buffer, eocdOffset);
  const located = centralEntries.map((entry) =>
    locateEntryData(buffer, entry, centralOffset)
  );

  const ranges = [...located]
    .sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.localHeaderOffset < previous.dataEnd
    ) {
      fail(`ZIP local entries overlap: ${previous.path} and ${current.path}`);
    }
  }

  const files = new Map<string, Buffer>();
  const publicEntries: ModulePackageEntry[] = [];
  for (const entry of located) {
    const content = inflateEntry(buffer, entry);
    if (entry.kind === "file") files.set(entry.path, content);
    publicEntries.push(
      Object.freeze({
        path: entry.path,
        kind: entry.kind,
        compression: entry.compressionMethod === 0 ? "stored" : "deflate",
        compressedBytes: entry.compressedSize,
        uncompressedBytes: entry.uncompressedSize
      })
    );
  }

  const manifestBytes = files.get("manifest.json");
  if (manifestBytes === undefined) fail("package must contain exactly one root manifest.json file");
  const manifest = parseManifest(manifestBytes);

  if (!files.has(manifest.backend)) {
    fail(`manifest backend entry is missing from package: ${manifest.backend}`);
  }
  if (manifest.ui !== undefined && !files.has(manifest.ui)) {
    fail(`manifest UI entry is missing from package: ${manifest.ui}`);
  }

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return Object.freeze({
    sha256,
    manifest,
    entries: Object.freeze(publicEntries),
    readFile(path: string): Buffer {
      const content = files.get(path);
      if (content === undefined) {
        throw new ModulePackageValidationError(`package file not found: ${path}`);
      }
      return Buffer.from(content);
    }
  });
}
