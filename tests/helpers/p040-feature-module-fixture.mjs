import { createZip } from "./zip-fixture.mjs";

export const EXPLORER_MODULE_ID = "explorer";
export const PROVISIONING_MODULE_ID = "account-provisioning";

const CAPABILITIES = Object.freeze({
  [EXPLORER_MODULE_ID]: Object.freeze([
    "accounts.read",
    "personas.read",
    "generators.read",
    "generators.write",
    "browser.automate",
    "provider.read",
    "provider.mutate",
    "operations.create"
  ]),
  [PROVISIONING_MODULE_ID]: Object.freeze([
    "accounts.read",
    "accounts.write",
    "personas.control",
    "browser.automate",
    "provider.read",
    "provider.mutate",
    "operations.create",
    "humanTasks.manage",
    "secrets.use:account-credentials"
  ])
});

const NAMES = Object.freeze({
  [EXPLORER_MODULE_ID]: "PCMS Explorer",
  [PROVISIONING_MODULE_ID]: "PCMS Account Provisioning"
});

export function createP040FeatureModulePackage(
  moduleId,
  version
) {
  if (
    moduleId !== EXPLORER_MODULE_ID &&
    moduleId !== PROVISIONING_MODULE_ID
  ) {
    throw new RangeError(
      "unsupported P040 feature module: " + moduleId
    );
  }
  if (version !== "1.0.0" && version !== "1.1.0") {
    throw new RangeError(
      "unsupported P040 feature module version: " + version
    );
  }

  const manifest = {
    schemaVersion: 1,
    id: moduleId,
    name: NAMES[moduleId],
    version,
    pcmsApi: "^1.0.0",
    backend: "backend/index.mjs",
    capabilities: [...CAPABILITIES[moduleId]],
    stateSchemaVersion: 1
  };

  const backend = [
    "export function createModule(context) {",
    "  return {",
    "    async handle(method, params) {",
    '      if (method === "describe") {',
    "        return {",
    "          id: context.module.id,",
    "          version: context.module.version,",
    "          runtimeGeneration: context.module.runtimeGeneration",
    "        };",
    "      }",
    '      if (method === "store") {',
    '        return context.sdk.call("storage.set", params);',
    "      }",
    '      if (method === "load") {',
    '        return context.sdk.call("storage.get", params);',
    "      }",
    '      throw Object.assign(new Error("unsupported feature method"), {',
    '        code: "FEATURE_METHOD_NOT_FOUND"',
    "      });",
    "    }",
    "  };",
    "}",
    ""
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
