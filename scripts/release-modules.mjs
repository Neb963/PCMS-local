import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value & 1) !== 0
          ? 0xedb88320 ^ (value >>> 1)
          : value >>> 1;
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

function localHeader(entry) {
  const header = Buffer.alloc(30 + entry.name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt32LE(entry.crc >>> 0, 14);
  header.writeUInt32LE(entry.compressed.length, 18);
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(entry.name.length, 26);
  entry.name.copy(header, 30);
  return header;
}

function centralHeader(entry, localOffset) {
  const header = Buffer.alloc(46 + entry.name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | 20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt32LE(entry.crc >>> 0, 16);
  header.writeUInt32LE(entry.compressed.length, 20);
  header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(localOffset >>> 0, 42);
  entry.name.copy(header, 46);
  return header;
}

function createZip(files) {
  const entries = files.map((file) => {
    const data = Buffer.from(file.data);
    const method = file.deflate === false ? 0 : 8;
    return {
      name: Buffer.from(file.path, "utf8"),
      data,
      method,
      compressed:
        method === 8 ? deflateRawSync(data) : Buffer.from(data),
      crc: crc32(data)
    };
  });

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const local = localHeader(entry);
    locals.push(local, entry.compressed);
    centrals.push(centralHeader(entry, offset));
    offset += local.length + entry.compressed.length;
  }

  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

function backendSource(moduleId, methods) {
  const branches = methods
    .map(
      ({ method, sdk }) =>
        `        if (method === ${JSON.stringify(method)}) {
          return context.sdk.call(${JSON.stringify(sdk)}, params);
        }`
    )
    .join("\n");
  return `export function createModule(context) {
  return {
    async handle(method, params) {
      if (method === "describe") {
        return {
          id: context.module.id,
          version: context.module.version,
          runtimeGeneration: context.module.runtimeGeneration
        };
      }
${branches}
      throw Object.assign(
        new Error("unsupported ${moduleId} method"),
        { code: "MODULE_METHOD_NOT_FOUND" }
      );
    }
  };
}
`;
}

const DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "deployer",
    name: "PCMS Deployer",
    capabilities: Object.freeze([
      "accounts.read",
      "personas.control",
      "generators.read",
      "browser.automate",
      "provider.read",
      "provider.mutate",
      "operations.create",
      "schedules.manage",
      "github.read"
    ]),
    methods: Object.freeze([
      Object.freeze({
        method: "deploy",
        sdk: "services.deployer.deploy"
      }),
      Object.freeze({
        method: "beginOperation",
        sdk: "operations.deployer.prepare"
      }),
      Object.freeze({
        method: "poll",
        sdk: "schedules.deployer.poll"
      })
    ])
  }),
  Object.freeze({
    id: "refresher",
    name: "PCMS Refresher",
    capabilities: Object.freeze([
      "accounts.read",
      "personas.read",
      "generators.read",
      "browser.automate",
      "provider.read",
      "provider.mutate",
      "operations.create",
      "schedules.manage"
    ]),
    methods: Object.freeze([
      Object.freeze({
        method: "execute",
        sdk: "services.refresher.execute"
      })
    ])
  }),
  Object.freeze({
    id: "explorer",
    name: "PCMS Explorer",
    capabilities: Object.freeze([
      "accounts.read",
      "personas.read",
      "generators.read",
      "generators.write",
      "browser.automate",
      "provider.read",
      "provider.mutate",
      "operations.create"
    ]),
    methods: Object.freeze([])
  }),
  Object.freeze({
    id: "account-provisioning",
    name: "PCMS Account Provisioning",
    capabilities: Object.freeze([
      "accounts.read",
      "accounts.write",
      "personas.control",
      "browser.automate",
      "provider.read",
      "provider.mutate",
      "operations.create",
      "humanTasks.manage",
      "secrets.use:account-credentials"
    ]),
    methods: Object.freeze([])
  }),
  Object.freeze({
    id: "statistics",
    name: "PCMS Statistics",
    capabilities: Object.freeze([]),
    methods: Object.freeze([
      Object.freeze({
        method: "snapshot",
        sdk: "services.statistics.snapshot"
      })
    ])
  })
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildOfficialModulePackages(version) {
  return Object.freeze(
    DEFINITIONS.map((definition) => {
      const manifest = Object.freeze({
        schemaVersion: 1,
        id: definition.id,
        name: definition.name,
        version,
        pcmsApi: "^1.0.0",
        backend: "backend/index.mjs",
        capabilities: [...definition.capabilities],
        stateSchemaVersion: 1
      });
      const bytes = createZip([
        {
          path: "manifest.json",
          data: JSON.stringify(manifest),
          deflate: false
        },
        {
          path: "backend/index.mjs",
          data: backendSource(
            definition.id,
            definition.methods
          )
        }
      ]);
      return Object.freeze({
        moduleId: definition.id,
        version,
        manifest,
        bytes,
        sha256: sha256(bytes)
      });
    })
  );
}
