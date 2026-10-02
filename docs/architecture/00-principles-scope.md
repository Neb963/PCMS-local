# 00 — Principles, Scope and Invariants

## 1. Problem statement

PCMS-local must make 50+ Perchance Accounts behave like durable, isolated and manageable resources rather than manually juggled browser sessions.

Previous Firefox-based designs proved important product requirements but also coupled core progress to extension lifecycle, contextual identities, browser-specific proxy hooks and difficult live testing. PCMS-local resets the implementation boundary while retaining the requirements.

## 2. Fundamental truths

1. A Persona is a product identity, not a Chromium profile, process, cookie jar, route or port.
2. The chosen V1 browser implementation must persist the same logical Persona across browser/application restarts.
3. Browser state is large, externally managed state. PCMS records ownership/health/metadata; it does not normalize the Chromium profile into database rows.
4. Perchance is an external mutable system. Local transactions cannot make provider mutations atomic.
5. Route configuration is not route proof. Protected work requires sufficiently fresh actual egress evidence.
6. Chromium/CDP is a control implementation. Domain modules must not depend on raw CDP semantics.
7. Same-user updateable modules are executable operator-trusted code; process separation is primarily a lifecycle/failure boundary.
8. The privileged network service is a separate failure/security domain because Linux network configuration requires capabilities the normal control plane must not hold.
9. 50+ managed Personas does not imply 50 running browsers. Dormant identities must cost mostly disk.
10. Human intervention is normal workflow state.
11. Reliability for coding/browser agents is a product requirement, not merely developer convenience.
12. Simplicity has economic value: every process, daemon, broker, schema and compatibility layer adds Day-2 failure modes.

## 3. Core invariants

### INV-ID-01 — Stable domain identity
Account, Persona, Generator, Project, Run and Operation IDs are PCMS-owned stable identifiers. Mutable external labels are metadata.

### INV-PER-01 — Persistent isolated Persona
A Persona owns one persistent browser state root at a time. Two Personas never intentionally share that state root.

### INV-ACC-01 — Dedicated active binding
One ACTIVE Account has at most one dedicated active Persona; one Persona is not simultaneously bound to multiple ACTIVE Accounts.

### INV-NET-01 — Protected means route-or-block
A protected Persona never intentionally falls back to ordinary host egress. Direct is an explicit route.

### INV-AUTO-01 — Same identity for human and automation
Automation controls the same persistent Persona that the operator can open.

### INV-EXT-01 — Uncertain external state is explicit
If a mutation may have occurred but cannot be verified, its operation remains `UNCERTAIN`; automatic duplicate mutation is blocked until reconciliation.

### INV-DB-01 — One authoritative local database
PCMS authoritative structured state is committed through one SQLite database and schema/migration authority.

### INV-MOD-01 — Module lifecycle independence
Feature modules can be installed, updated, disabled and rolled back without replacing PCMS Core.

### INV-MOD-02 — Core authority is not imported into modules
Module code runs outside `pcmsd` and uses the versioned module RPC/SDK. Supported module interfaces do not expose raw Core DB/router/process/CDP authority.

### INV-UPD-01 — Last known-good survives candidate failure
Module/Core updates stage and validate candidates before switching active authority. Failed candidates cannot destroy the last usable version/state.

### INV-HUM-01 — Human tasks survive control-plane restart
Durable blocking Human Tasks are reconstructable after restart. Sensitive one-time input may remain transient.

### INV-AGENT-01 — Debug attachment is non-destructive
Authorized agent attachment/detachment does not normally terminate the browser Persona.

## 4. V1 product scope

Foundation:
- Accounts, Personas, Routes and Generator identity;
- Chromium profile lifecycle;
- route preparation/verification and protected fail-closed operation;
- Browser Automation service and Perchance provider adapter;
- Operation Coordinator with uncertainty/reconciliation;
- module install/update/enable/disable/rollback;
- local Web UI + CLI/API;
- Human Tasks;
- bounded scheduling/queue/batch primitives;
- backup/restore/diagnostics/search.

First-party updateable modules:
- Deployer;
- Refresh Measurement / Refresher;
- Ban Detector if still useful as an independent policy;
- Explorer;
- Account Provisioning;
- Statistics.

## 5. Explicit non-goals for the foundation

- Firefox parity;
- cross-browser portability in V1;
- AMO/Chrome Web Store distribution;
- extension-based control plane;
- Electron/Tauri unless later UX evidence requires it;
- containers/VMs for normal installation;
- untrusted third-party module sandboxing;
- cloud backend;
- multi-user RBAC;
- PostgreSQL/Redis/message broker;
- generic distributed lock service;
- global event-sourcing journal;
- general workflow language before real workflows require one;
- keeping every legacy PersonaMonkey capability.

## 6. Complexity admission rule

Add a new shared Core abstraction only if:
1. at least two independent consumers need it; or
2. it is required at a Core lifecycle/correctness boundary; and
3. a module-local implementation would violate an invariant.

Otherwise keep it local.

## 7. Failure-domain target

The normal runtime should have only these major failure domains:
- `pcmsd` control plane;
- individual module processes;
- individual Chromium Persona processes;
- privileged routing daemon;
- external providers/network.

Failure in one module/Persona should not take down unrelated modules/Personas.

## 8. Performance model

At 50+ managed Accounts:
- dormant Personas consume disk only;
- browser-process concurrency is configured and bounded;
- module work queues are bounded;
- SQLite writes are short and local;
- no remote call is held inside a DB transaction;
- browser/profile directories are excluded from naive frequent whole-tree backups.

The initial target is one workstation/operator, not horizontal scale.
