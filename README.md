# PCMS-local

PCMS-local is a local-first Linux control plane for managing persistent, isolated, inspectable and automatable Perchance identities.

The product unit is the **Persona**: a durable PCMS identity with browser state, Account binding, route policy, lifecycle and health. PCMS-local V1 implements Personas with dedicated Chromium user-data directories, but the domain model deliberately does not expose Chromium profile paths, CDP ports or proxy endpoints as durable identity.

## Architectural thesis

```text
PCMS-local
├── pcmsd — local Node.js/TypeScript control plane
│   ├── SQLite authoritative state
│   ├── Accounts / Generators / Human Tasks
│   ├── Persona Manager
│   ├── Browser Manager
│   ├── Route Manager
│   ├── Operation Coordinator
│   ├── Scheduler / bounded work admission
│   ├── Module Manager
│   ├── local API / Web UI / CLI
│   └── provider adapters
├── updateable feature modules
│   ├── Deployer
│   ├── Refresher
│   ├── Explorer
│   ├── Account Provisioning
│   └── Statistics
├── Chromium processes — one user-data-dir per running Persona
└── privileged routing service — ported PersonaMonkey Mullvad router
```

A module is an operator-installed/updateable package executed outside the Core process. Module code calls a bounded PCMS SDK; it is never loaded with Core authority.

## Current status

**P014 browser ownership, crash/restart reconciliation and active-Persona capacity is complete; M03 is in progress and P015 is READY.** No production-ready PCMS-local release exists yet.

The repository is intentionally starting fresh rather than incrementally converting the Firefox extension architecture. PersonaMonkey and earlier PCMS repositories are sources of proven requirements, contracts and selected implementation; they are not architecture authority.

## Start here

1. [Product Requirements](docs/product/PRODUCT_REQUIREMENTS.md) — highest product authority.
2. [AGENTS.md](AGENTS.md) — mandatory one-phase-at-a-time implementation protocol.
3. [ROADMAP.md](ROADMAP.md) — human execution view of the 50 session-sized phases.
4. [Principles and scope](docs/architecture/00-principles-scope.md).
5. [System architecture](docs/architecture/01-system-architecture.md).
6. [Implementation authority](docs/implementation/v0.1/README.md).
7. [ADRs](adr/) for accepted implementation choices.

## V1 implementation choices

- Fedora/Linux first.
- Node.js + TypeScript for `pcmsd`, web/CLI and module SDK/runtime.
- SQLite as one authoritative local database.
- Chromium/Chrome-compatible browser runtime using a dedicated user-data directory per Persona.
- CDP through a narrow Browser Manager / Provider Adapter boundary.
- The existing PersonaMonkey Mullvad/WireGuard router is ported as the privileged routing base.
- Local Web UI; no Electron/Tauri requirement.
- Modules are self-contained `.pcmsmod` packages, independently installable/updateable/disableable.
- GitHub Actions are a first-class verification surface and are not budget-constrained for this repository.
- Development is CI-first/live-last: P001–P047 use real Chromium + Perchance emulation + synthetic routing; P048–P049 are final real Perchance/Mullvad/MCP acceptance.
- Implementation is strictly sequential and session-sized: exactly one phase is active, each normal phase has ≤3 work items and ≤5 acceptance gates, and the agent stops after closing it.

## Explicit non-goals for the initial implementation

- Firefox/Firefox containers as a required runtime.
- another large browser extension.
- a separate PersonaMonkey desktop product.
- Docker/Podman as a normal installation requirement.
- PostgreSQL/Redis/message brokers.
- a general distributed workflow engine.
- multi-user SaaS/RBAC.
- pretending updateable local module code is an adversarial security sandbox.

The goal is a small, recoverable system that can reach a useful beta quickly while preserving the correctness boundaries needed for real provider mutations.
