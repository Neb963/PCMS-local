# 06 — Module System and SDK Boundary

## 1. Goals

Modules must be independently:
- installable;
- updateable;
- enableable/disableable;
- rollbackable;
- observable;
- crash-isolated from Core.

V1 first-party modules use the same package/runtime path available to the user after installation.

## 2. Package identity

Artifact extension: `.pcmsmod`.

A package is a bounded ZIP containing prebuilt self-contained assets:

```text
manifest.json
backend/index.mjs
ui/index.html          optional
ui/assets/*            optional
migrations/*           optional descriptors/data transforms
README.md              optional
```

No `npm install`, package manager lifecycle scripts or dependency resolution occurs during module installation.

Backend dependencies must be bundled into the package.

## 3. Manifest

Minimum:

```ts
interface ModuleManifestV1 {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;          // semver
  pcmsApi: string;          // supported API range
  backend: string;
  ui?: string;
  capabilities: string[];
  services?: {
    provides?: string[];
    requires?: string[];
  };
  stateSchemaVersion: number;
  update?: {
    channel?: string;
    manifestUrl?: string;
  };
}
```

IDs use a conservative ASCII format and are immutable for module continuity.

## 4. Capability envelope

Keep capabilities coarse enough to understand but narrow enough to prevent accidental authority.

Initial vocabulary:
- `accounts.read`
- `accounts.write`
- `personas.read`
- `personas.control`
- `generators.read`
- `generators.write`
- `browser.read`
- `browser.automate`
- `provider.read`
- `provider.mutate`
- `operations.create`
- `schedules.manage`
- `humanTasks.manage`
- `secrets.use:<scope>`
- `http:<origin-pattern>`
- `github.read`
- module service dependencies.

Capability additions on update require explicit user approval. Reductions can activate without additional approval after validation.

## 5. Runtime

Core launches a generic `module-runner` child with:
- exact package/version path;
- runtime generation;
- one IPC channel;
- startup nonce;
- resource limits/config.

The runner loads exactly one backend entrypoint.

Core validates every RPC envelope before dispatch. Runtime generation is checked on every request so stale processes cannot continue after update/disable.

## 6. IPC

Use framed JSON/MessagePack-like bounded messages over inherited stdio or Unix socket. Initial implementation should prefer simple length-delimited JSON over stdio unless profiling shows a need for another encoding.

Every request:
- protocol version;
- runtime generation;
- request ID;
- method;
- bounded params.

Every response:
- request ID;
- result or structured error.

Payload limits and outstanding request counts are enforced by Core before allocation/dispatch.

## 7. Failure containment

If module process crashes:
- active module state becomes DEGRADED/ERROR;
- unrelated modules/Core continue;
- outstanding RPC fails with structured MODULE_RUNTIME_LOST;
- remote operations already admitted remain represented by OperationCoordinator, not erased;
- restart policy is bounded to avoid crash loops.

## 8. Module storage

Module SDK exposes namespaced storage; backend code does not access `pcms.db` directly through supported APIs.

Each module owns its schema version/migration logic for its namespace, while Core owns activation atomicity and rollback copy/snapshot.

## 9. Services between modules

Avoid a service mesh.

When real feature dependency exists, modules may export versioned semantic services through Core:
- exact service ID + major version;
- Core routes to active runtime generation;
- calls bounded and cycle-protected;
- no synchronous required-service dependency cycles.

Prefer Core domain services when the data/entity is foundational rather than chaining modules.

## 10. UI contribution

Core Web UI may mount module UI in a constrained iframe/component host.

Module UI talks to Core through a UI SDK proxy with the module's capability envelope. UI is never backend/domain authority.

A broken UI can be destroyed/reloaded without killing pcmsd or browser Personas.

## 11. First-party equality

Bundled/official Deployer, Refresher, Explorer, Provisioning and Statistics packages must use the same installation/activation/runtime mechanism as manually installed updates.

Do not create hidden privileged shortcuts for first-party modules.

## 12. Trust statement

Module packages are operator-trusted same-user executable code. The process/API design prevents accidental Core coupling and improves lifecycle containment but is not a hostile-code sandbox.

Future untrusted module support would require OS sandboxing and a separate threat model.
