# 01 — System Architecture

## 1. Runtime topology

```text
┌─────────────────────────────────────────────────────────────┐
│                         pcmsd                               │
│ Node.js / TypeScript, unprivileged user service            │
│                                                             │
│  Domain: Accounts, Personas, Generators, HumanTasks         │
│  Core: SQLite, ModuleManager, OperationCoordinator          │
│  Runtime: BrowserManager, RouteClient, Scheduler            │
│  Adapter: PerchanceProvider                                 │
│  Surfaces: HTTP/WebSocket API, Web UI, CLI/MCP adapters     │
└───────┬────────────────────┬───────────────────────┬─────────┘
        │ stdio/IPC          │ CDP loopback          │ Unix socket
        ▼                    ▼                       ▼
 module-runner(s)     Chromium Persona(s)     persona-mullvad-router
 unprivileged         dedicated data dirs     privileged system service
        │                    │                       │
        └────────────┬───────┘                       ▼
                     │                           WireGuard/Mullvad
                     ▼
                  Perchance
```

No browser extension is required for the foundation.

## 2. Process responsibilities

### pcmsd
The sole local product authority. It owns:
- DB migrations/repositories;
- domain invariants;
- lifecycle of module and browser processes;
- route coordination through a narrow Unix-socket client;
- provider/browser automation admission;
- durable operation state;
- schedules/queues;
- Human Tasks;
- backup/restore;
- local API/UI.

It runs as the desktop user and must not require NET_ADMIN/root.

### Chromium Persona process
One running process tree per active Persona, launched with that Persona's dedicated non-default `--user-data-dir`. It owns browser persistence such as cookies/storage/cache/service workers. The process is ephemeral; the Persona is not.

Debugging is loopback-only and treated as privileged local control. Chrome 136+ requires remote debugging to use a non-default user data directory; this aligns with the Persona model.

### module-runner
One process per active module version (or a strictly bounded pool if later measured necessary). It loads one staged module package, speaks framed RPC to Core, emits structured logs and exits independently.

Modules never receive Core DB handles or Core implementation objects.

### persona-mullvad-router
Privileged system service ported from PersonaMonkey. It owns WireGuard interface/route manipulation and per-exit local forwarders. Core talks to its control Unix socket through a typed client.

The initial port remains provenance-identical; Chromium-specific unauthenticated loopback forwarders are added later as a separately reviewed change because Chromium SOCKS5 authentication support differs from Firefox.

## 3. Durable data placement

```text
~/.local/share/pcms-local/
├── pcms.db
├── personas/<personaUid>/chromium/     # browser-owned large state
├── modules/<moduleId>/<version>/       # immutable installed package versions
├── module-data/<moduleId>/             # exported/recovery material when applicable
├── artifacts/                          # bounded immutable artifacts
└── backups/

~/.config/pcms-local/
└── config.json                         # non-secret machine configuration
```

Secrets do not live in `config.json` or ordinary module data. The secret backend is defined separately.

## 4. Domain-to-runtime indirection

Durable records use stable IDs:

```text
AccountId → PersonaUid → RouteId
GeneratorLocalId → AccountId → PersonaUid
```

Runtime handles are reconstructed:

```text
PersonaUid
  → profile path
  → browser process id
  → DevTools endpoint
  → prepared route forwarder
```

PID, debug port, proxy port and Chromium profile-internal IDs never become cross-module identity.

## 5. Browser boundary

Only BrowserManager owns Chromium process launch/attach/termination and raw CDP transport.

Only provider adapters interpret provider DOM/API behavior.

Modules call semantic operations, for example:

```text
deployer
  → provider.verifyIdentity(generatorLocalId)
  → provider.applyArtifact(...)
  → provider.verifyDeployment(...)
```

not arbitrary selectors/CDP.

A low-level browser execution API may exist for controlled workflows/testing, but it is capability-gated and still Persona-scoped.

## 6. Module boundary

Package lifecycle:

```text
download/import
→ bounded parse + digest
→ manifest/API/capability validation
→ permission delta approval
→ immutable staging
→ quiesce old admission
→ drain/fence old runtime
→ clone/migrate candidate state
→ candidate health/self-test
→ atomic active-version switch
→ start new runtime
→ retain old package/state for rollback
```

Module processes are operator-trusted. The architecture protects Core integrity through supported interfaces and failure containment; it does not claim same-user hostile code confinement.

## 7. External mutation boundary

Every provider mutation is driven through OperationCoordinator:

```text
PREPARED → RUNNING → VERIFYING → SUCCEEDED
                         ├──────→ FAILED_SAFE
                         └──────→ UNCERTAIN
```

At most one unresolved mutation claim exists per stable target key where concurrent effects are unsafe.

Interrupted `RUNNING`/`VERIFYING` operations become `UNCERTAIN` on bootstrap until reconciled.

## 8. Routing boundary

Route modes:
- `PROTECTED` — requires prepared local route and verified egress; no Direct fallback;
- `DIRECT` — explicit host networking;
- `BLOCK` — no browser network.

A protected browser starts only after route preparation. Sensitive automation additionally requires sufficiently fresh egress/session evidence.

Browser-layer proxy configuration is the initial fail-closed mechanism. Kernel-enforced namespaces/nftables are deferred unless acceptance finds a practical bypass or the threat model expands.

## 9. Startup order

1. acquire single-instance lock;
2. open DB and apply bounded transactional migrations;
3. mark interrupted remote operations uncertain;
4. load config/module registry;
5. probe router/browser binaries;
6. reconcile module desired runtimes;
7. reconcile recorded running Personas against actual processes/endpoints;
8. restore schedules without replaying an unbounded missed backlog;
9. expose UI/API readiness.

No provider mutation occurs merely because pcmsd restarted.

## 10. Shutdown

- stop new mutation admission;
- request module quiescence with bounded timeout;
- persist durable state already committed by operations;
- do not destroy Persona definitions;
- browser shutdown policy is explicit: managed browsers may be closed gracefully or left running according to configured shutdown mode;
- release runtime-only route forwarders where ownership is certain.

Crash recovery never relies on shutdown having completed.

## 11. Installation shape

Normal user experience:
- one PCMS-local installer/package;
- desktop entry;
- user systemd service for pcmsd;
- Chromium auto-detected/configurable;
- privileged router installation only when protected routing is enabled.

No end-user npm/pnpm commands. Release packaging may bundle a pinned Node runtime to avoid host toolchain drift.

## 12. Replaceability seams

The following interfaces are intentionally narrow:
- `BrowserDriver` — Chromium/CDP today;
- `RouteBackend` — PersonaMonkey routerd today;
- `ProviderAdapter` — Perchance V1;
- `SecretStore`;
- `ModuleTransport`;
- `Database` repository layer.

Replaceability does not imply implementing alternatives now.
