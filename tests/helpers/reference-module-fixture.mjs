import { createZip } from "./zip-fixture.mjs";

export const REFERENCE_MODULE_ID = "reference.acceptance";

export function createReferenceModulePackage(version) {
  if (version !== "1.0.0" && version !== "1.1.0") {
    throw new RangeError(`unsupported reference module version: ${version}`);
  }

  const manifest = {
    schemaVersion: 1,
    id: REFERENCE_MODULE_ID,
    name: "PCMS Reference Acceptance Module",
    version,
    pcmsApi: "^1.0.0",
    backend: "backend/index.mjs",
    ui: "ui/index.html",
    capabilities: [],
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
        throw Object.assign(new Error("unsupported reference method"), {
          code: "REFERENCE_METHOD_NOT_FOUND"
        });
      }
    };
  }
  `;

  const ui = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Reference module</title></head>
<body data-reference-version="${version}">
  <main>Reference module ${version}</main>
  <script src="assets/app.js"></script>
</body>
</html>
`;
  const app = `document.body.dataset.referenceLoaded = "${version}";\n`;

  return createZip([
    {
      name: "manifest.json",
      data: JSON.stringify(manifest)
    },
    {
      name: "backend/index.mjs",
      data: backend,
      method: "deflate"
    },
    {
      name: "ui/index.html",
      data: ui,
      method: "deflate"
    },
    {
      name: "ui/assets/app.js",
      data: app,
      method: "deflate"
    }
  ]);
}
