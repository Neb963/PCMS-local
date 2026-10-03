import { createZip } from "./zip-fixture.mjs";

export const REFRESHER_MODULE_ID = "refresher";

const CAPABILITIES = Object.freeze([
  "accounts.read",
  "personas.read",
  "generators.read",
  "browser.automate",
  "provider.read",
  "provider.mutate",
  "operations.create",
  "schedules.manage"
]);

export function createRefresherModulePackage(version) {
  if (version !== "1.0.0" && version !== "1.1.0") {
    throw new RangeError(
      "unsupported Refresher module version: " + version
    );
  }

  const manifest = {
    schemaVersion: 1,
    id: REFRESHER_MODULE_ID,
    name: "PCMS Refresher",
    version,
    pcmsApi: "^1.0.0",
    backend: "backend/index.mjs",
    capabilities: [...CAPABILITIES],
    stateSchemaVersion: 1
  };

  const backend = [
    'export function createModule(context) {',
    '  return {',
    '    async handle(method, params) {',
    '      if (method === "describe") {',
    '        return {',
    '          id: context.module.id,',
    '          version: context.module.version,',
    '          runtimeGeneration: context.module.runtimeGeneration',
    '        };',
    '      }',
    '      if (method === "store") {',
    '        return context.sdk.call("storage.set", params);',
    '      }',
    '      if (method === "load") {',
    '        return context.sdk.call("storage.get", params);',
    '      }',
    '      if (method === "execute") {',
    '        return context.sdk.call("services.refresher.execute", params);',
    '      }',
    '      if (method === "crash") {',
    '        process.exit(74);',
    '      }',
    '      throw Object.assign(new Error("unsupported Refresher method"), {',
    '        code: "REFRESHER_METHOD_NOT_FOUND"',
    '      });',
    '    }',
    '  };',
    '}',
    ''
  ].join("\n");

  return createZip([
    {
      name: "manifest.json",
      data: JSON.stringify(manifest)
    },
    {
      name: "backend/index.mjs",
      data: backend,
      method: "deflate"
    }
  ]);
}
