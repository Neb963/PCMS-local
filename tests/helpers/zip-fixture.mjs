import { deflateRawSync } from "node:zlib";

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

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader({
  name,
  flags,
  method,
  crc,
  compressedSize,
  uncompressedSize
}) {
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt32LE(crc >>> 0, 14);
  header.writeUInt32LE(compressedSize >>> 0, 18);
  header.writeUInt32LE(uncompressedSize >>> 0, 22);
  header.writeUInt16LE(name.length, 26);
  name.copy(header, 30);
  return header;
}

function centralHeader({
  name,
  flags,
  method,
  crc,
  compressedSize,
  uncompressedSize,
  externalAttributes,
  localOffset
}) {
  const header = Buffer.alloc(46 + name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | 20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(flags, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt32LE(crc >>> 0, 16);
  header.writeUInt32LE(compressedSize >>> 0, 20);
  header.writeUInt32LE(uncompressedSize >>> 0, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(externalAttributes >>> 0, 38);
  header.writeUInt32LE(localOffset >>> 0, 42);
  name.copy(header, 46);
  return header;
}

export function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry.nameBytes ?? Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data ?? "");
    const method =
      entry.method === "deflate" ? 8 :
      entry.method === "store" || entry.method === undefined ? 0 :
      entry.method;
    const compressed =
      method === 8 ? deflateRawSync(data) : Buffer.from(data);
    const flags = entry.flags ?? 0x0800;
    const crc = entry.crc32 ?? crc32(data);
    const compressedSize = entry.compressedSize ?? compressed.length;
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const directory = entry.name?.endsWith("/") ?? false;
    const externalAttributes =
      entry.externalAttributes ??
      ((directory ? 0o040755 : 0o100644) << 16) |
        (directory ? 0x10 : 0);

    const local = localHeader({
      name,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize
    });
    locals.push(local, compressed);
    centrals.push(
      centralHeader({
        name,
        flags,
        method,
        crc,
        compressedSize,
        uncompressedSize,
        externalAttributes,
        localOffset: offset
      })
    );
    offset += local.length + compressed.length;
  }

  const centralOffset = offset;
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([...locals, central, eocd]);
}

export function moduleManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "fixture.module",
    name: "Fixture Module",
    version: "1.0.0",
    pcmsApi: "^1.0.0",
    backend: "backend/index.mjs",
    capabilities: ["accounts.read"],
    stateSchemaVersion: 1,
    ...overrides
  };
}

export function createModuleZip({
  manifest = moduleManifest(),
  extraEntries = [],
  manifestEntry = {}
} = {}) {
  return createZip([
    {
      name: "manifest.json",
      data: JSON.stringify(manifest),
      ...manifestEntry
    },
    {
      name: "backend/index.mjs",
      data: "export default {};",
      method: "deflate"
    },
    ...extraEntries
  ]);
}
