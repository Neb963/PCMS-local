import { createZip } from "./zip-fixture.mjs";

export const DEPLOYER_MODULE_ID = "deployer";

const CAPABILITIES = Object.freeze([
  "accounts.read",
  "personas.control",
  "generators.read",
  "browser.automate",
  "provider.read",
  "provider.mutate",
  "operations.create",
  "schedules.manage",
  "github.read"
]);

export function createDeployerModulePackage(version) {
  if (version !== "1.0.0" && version !== "1.1.0") {
    throw new RangeError(`unsupported Deployer module version: ${version}`);
  }

  const manifest = {
    schemaVersion: 1,
    id: DEPLOYER_MODULE_ID,
    name: "PCMS Deployer",
    version,
    pcmsApi: "^1.0.0",
    backend: "backend/index.mjs",
    capabilities: [...CAPABILITIES],
    stateSchemaVersion: 1
  };

  const backend = `export function createModule(context) {
    return {
      async handle(method, params) {
        if (method === "describe") {
          return {
            id: context.module.id,
            version: context.module.version,
            runtimeGeneration: context.module.runtimeGeneration
          };
        }
        if (method === "store") {
          return context.sdk.call("storage.set", params);
        }
        if (method === "load") {
          return context.sdk.call("storage.get", params);
        }
        if (method === "beginOperation") {
          return context.sdk.call("operations.deployer.prepare", params);
        }
        if (method === "poll") {
          return context.sdk.call("schedules.deployer.poll", params);
        }
        if (method === "deploy") {
          return context.sdk.call("services.deployer.deploy", params);
        }
        if (method === "crash") {
          process.exit(73);
        }
        throw Object.assign(new Error("unsupported Deployer method"), {
          code: "DEPLOYER_METHOD_NOT_FOUND"
        });
      }
    };
  }
  `;

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
