# 02 — Domain Model, SQLite and Migrations

## 1. Authority

PCMS structured state is authoritative only when committed to `pcms.db`. Browser profile contents, provider pages, route-daemon state, module process memory and UI state are external/derived observations.

V1 uses one SQLite database opened by pcmsd. The database is not shared directly with module processes.

## 2. Technology choice

Use the SQLite API behind a small internal repository/transaction abstraction. The initial implementation should prefer the pinned Node runtime's built-in `node:sqlite` if the chosen pinned Node release passes repository acceptance; the adapter prevents this implementation choice from leaking into domain code.

Reasons:
- no native npm addon required in the end-user package;
- one local operator and modest write volume;
- transactions/constraints are strong enough for PCMS invariants;
- backup and migration behavior are well understood.

If `node:sqlite` proves operationally unsuitable, replacing the adapter with a mature SQLite binding is a local implementation change, not an architecture change.

## 3. Connection and durability

At open:
- foreign keys ON;
- WAL mode unless acceptance shows an environment-specific problem;
- bounded busy timeout;
- defensive mode where supported;
- application/user schema version verified;
- no arbitrary loadable SQLite extensions.

Keep write transactions short. No network, CDP, filesystem copy, module RPC or provider operation may occur while holding a DB write transaction.

## 4. Initial Core tables

Names may evolve through migrations, but the ownership model is fixed.

### accounts
- `account_id TEXT PRIMARY KEY`
- business identity/display metadata
- lifecycle state
- bound `persona_uid` nullable
- created/updated timestamps
- revision integer

### personas
- `persona_uid TEXT PRIMARY KEY`
- display metadata
- route_id
- lifecycle state
- browser implementation kind/version metadata
- profile relative path metadata
- created/updated timestamps
- revision integer

The actual profile bytes are not stored in SQLite.

### persona_bindings_history
Append-only audit of explicit bind/rebind/unbind events.

### routes
Normalized non-secret route configuration and lifecycle metadata. Secret WireGuard material remains owned by the privileged router configuration, not ordinary DB rows.

### generators
- `generator_local_id TEXT PRIMARY KEY`
- owning account ID
- stable provider public ID when known
- mutable current slug/address
- verification status/timestamps
- project association where applicable

### operations
Durable external-operation state and target claims:
- operation ID
- kind/module
- target key
- state
- attempt
- provenance/fingerprints
- timestamps
- bounded safe result/error metadata

### human_tasks
Durable work requiring operator intervention. One-time secret values are references/transient values, not task payload history.

### schedules
Desired future/recurring work definitions and next-run metadata.

### modules
Installed module registry:
- module ID
- active version
- enabled state
- approved capability envelope
- status
- current state schema version

### module_versions
Immutable package inventory with digest, path, manifest projection, installation/validation timestamps.

### module_kv
Namespaced bounded module storage for small structured state. Large artifacts belong in the artifact store and are referenced by digest/path.

### provider_state
Small shared provider health/cooldown observations needed for safe aggregate mutation admission.

### schema_migrations
Exact ordered migration IDs and checksums.

## 5. Binding invariants

Enforce structurally when possible:
- one active Persona binding per active Account;
- one Persona not bound to more than one ACTIVE Account;
- GeneratorRef local IDs globally unique;
- known provider stable IDs cannot silently map to two live generators.

Where SQLite partial unique indexes are sufficient, use them. Cross-record rebinding that temporarily violates uniqueness is one transaction with explicit history.

## 6. Optimistic concurrency

Mutable aggregate records carry integer revisions. Public APIs that edit operator-visible entities support expected revision where lost updates matter.

Do not expose a global revision as a substitute for entity-level correctness.

## 7. Module storage

Modules do not receive SQL.

SDK storage supports:
- get/list by namespace;
- compare-and-set;
- bounded atomic batch within the module namespace;
- schema version/migration activation through ModuleManager.

Cross-module data dependencies use service/domain APIs, not table reads.

## 8. Migrations

Rules:
- each migration ID is immutable once merged;
- migration order is centrally allocated;
- migration checksum is recorded;
- migration transaction either commits fully or leaves the prior schema usable;
- filesystem/browser/profile migrations use staged two-phase procedures because they cannot be atomic with SQLite;
- irreversible/destructive migrations require an explicit pre-migration backup and acceptance scenario.

Startup failure during migration leaves pcmsd BLOCKED with actionable diagnostics; it never guesses a later schema version.

## 9. Filesystem identity

Store paths relative to the PCMS data root when possible. Validate canonicalized paths before use. No DB/import/module value may escape approved roots through `..`, symlinks or absolute-path injection.

Persona profile roots and immutable module package roots have different lifecycle owners and must never overlap.

## 10. Backup interaction

A consistent PCMS DB snapshot uses SQLite's supported backup/serialization mechanism or an equivalent transactionally coherent procedure.

Browser profile backup is a separate operation requiring the Persona browser to be closed/quiesced. PCMS backup metadata must say whether profile state was included, skipped or failed.

Never imply DB backup equals browser profile/provider backup.
