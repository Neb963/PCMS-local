# PCMS-local Implementation Roadmap v0.1

This is the human execution view of `docs/implementation/v0.1/plan.json`. The JSON plan is the machine-readable authority; CI verifies that this roadmap agrees with it.

## Operating model

PCMS-local uses **session-sized implementation phases** because long cloud-agent runs have proven operationally unreliable in practice.

- There are **50 phases total**, including the already-complete historical bootstrap `P000`.
- A normal implementation phase is intentionally shaped to fit roughly one **20–30 minute cloud-agent work session**.
- Agents are **not assumed to know elapsed time**. The limit is enforced structurally: one narrow objective, explicit non-goals, at most 3 normal work items, and at most 5 normal acceptance gates.
- `P000` is the only current size exception because it predates this roadmap.
- Exactly **one phase globally** may be `READY` or `IN_PROGRESS`.
- Phases execute sequentially. This is an operational reliability choice, not a statement that every subsystem is architecturally coupled.
- Milestone status is derived: READY before its first phase starts, IN_PROGRESS after at least one constituent phase completes while another is active, COMPLETE when all constituent phases complete, otherwise BLOCKED.
- An agent implements **one phase maximum**. After closing it, the agent marks only the immediate successor `READY`, publishes progress, and **STOPS**.
- If a phase proves materially oversized, do not grind through it. Split the remaining scope into successor session phases while preserving milestone/acceptance ownership and the one-active-phase invariant.
- P001–P047 are CI-first and require no MCP, real Perchance credentials or real Mullvad credentials.
- P048–P049 are the only normal live-system phases.

## Status vocabulary

Phase: `BLOCKED`, `READY`, `IN_PROGRESS`, `COMPLETE`.

Task checkbox: `[ ]` TODO, `[~]` IN PROGRESS, `[x]` COMPLETE, `[!]` BLOCKED, `[-]` SUPERSEDED.

At most one task in the active phase may be `[~]`.

## Current execution state

- Completed through: **P029**
- Current phase: **P030 — IN_PROGRESS**
- Next phase: **P031 — BLOCKED (P030)**
- Current milestone: **M07 — Deployer**
- Final live milestone: **M12 — P048–P049**


---

## M00 — Architecture and governance bootstrap
Milestone status: **COMPLETE**

### P000 — Architecture, governance and proven-source bootstrap
Status: **COMPLETE**  
Depends on: none  
Target size: **historical size exception**

**Objective:** Establish the product/architecture authority, implementation governance and proven PersonaMonkey routing baseline.

**Explicitly not in this phase:**
- Do not treat the imported PersonaMonkey runtime as PCMS-local architecture.

**Work:**
- [x] T000.1 — Import exact product requirements and authority hierarchy
- [x] T000.2 — Establish architecture/ADRs/non-goals
- [x] T000.3 — Create implementation governance and acceptance contracts
- [x] T000.4 — Port native routing baseline with exact provenance
- [x] T000.5 — Add repository/provenance verification
- [x] T000.6 — Prove initial GitHub Actions/native baseline

**Acceptance:**
- [x] A00-01
- [x] A00-02
- [x] A00-03
- [x] A00-04
- [x] A00-05
- [x] A00-06
- [x] A00-07

**Closure:** relevant tests + CI green; phase report finalized; P000 → COMPLETE; P001 → READY; publish to GitHub; **STOP — do not implement P001.**

---

## M01 — Local application foundation
Milestone status: **COMPLETE**

### P001 — Workspace, toolchain and hosted-CI baseline
Status: **COMPLETE**  
Depends on: P000  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Create the reproducible Node/TypeScript workspace and deterministic hosted-CI foundation that all later phases build on.

**Explicitly not in this phase:**
- Do not implement daemon behavior, SQLite, UI or browser management.

**Work:**
- [x] T001.1 — Pin workspace/toolchain and strict build/lint/typecheck/test scripts
- [x] T001.2 — Extend hosted CI from bootstrap verification to the implementation skeleton
- [x] T001.3 — Prove clean-checkout build/test/package smoke

**Acceptance:**
- [x] A01-01
- [x] A01-07

**Closure:** relevant tests + CI green; phase report finalized; P001 → COMPLETE; P002 → READY; publish to GitHub; **STOP — do not implement P002.**

### P002 — Configuration, data root and single-instance daemon
Status: **COMPLETE**  
Depends on: P001  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Establish pcmsd configuration/data-root resolution, loopback startup and single-instance ownership with minimal health/readiness.

**Explicitly not in this phase:**
- Do not add SQLite migrations, Web UI or CLI feature surfaces.

**Work:**
- [x] T002.1 — Implement XDG/config/data-root resolution and safe overrides
- [x] T002.2 — Implement single-instance ownership/stale-owner handling
- [x] T002.3 — Start loopback pcmsd with health/readiness/version and lifecycle tests

**Acceptance:**
- [x] A01-02

**Closure:** relevant tests + CI green; phase report finalized; P002 → COMPLETE; P003 → READY; publish to GitHub; **STOP — do not implement P003.**

### P003 — SQLite bootstrap and migration authority
Status: **COMPLETE**  
Depends on: P002  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Create the one authoritative SQLite adapter with required pragmas, ordered immutable migrations and incompatible-schema rejection.

**Explicitly not in this phase:**
- Do not add Account/Persona/module domain repositories yet.

**Work:**
- [x] T003.1 — Implement database open/configuration and required pragmas
- [x] T003.2 — Implement ordered migration/checksum authority
- [x] T003.3 — Test fresh, upgraded and incompatible/corrupt-open paths

**Acceptance:**
- [x] A01-03

**Closure:** relevant tests + CI green; phase report finalized; P003 → COMPLETE; P004 → READY; publish to GitHub; **STOP — do not implement P004.**

### P004 — Minimal Web UI and typed CLI surfaces
Status: **COMPLETE**  
Depends on: P003  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Expose the smallest authenticated local Web UI and typed CLI/JSON client over the Core API.

**Explicitly not in this phase:**
- Do not implement domain feature screens or direct database access from clients.

**Work:**
- [x] T004.1 — Implement authenticated/same-origin Web UI shell
- [x] T004.2 — Implement typed CLI client with stable JSON mode
- [x] T004.3 — Exercise both surfaces against a real pcmsd integration fixture

**Acceptance:**
- [x] A01-04
- [x] A01-05

**Closure:** relevant tests + CI green; phase report finalized; P004 → COMPLETE; P005 → READY; publish to GitHub; **STOP — do not implement P005.**

### P005 — User-service lifecycle and installable development bundle
Status: **COMPLETE**  
Depends on: P004  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Make the foundation start/stop/restart and package without requiring end-user npm/pnpm commands.

**Explicitly not in this phase:**
- Do not build the final installer or release-hardening matrix.

**Work:**
- [x] T005.1 — Add foreground and user-service launch/diagnostic paths
- [x] T005.2 — Build the development/release bundle skeleton
- [x] T005.3 — Test clean stop/restart/state preservation and bundle startup

**Acceptance:**
- [x] A01-06
- [x] A01-08

**Closure:** relevant tests + CI green; phase report finalized; P005 → COMPLETE; P006 → READY; publish to GitHub; **STOP — do not implement P006.**

---

## M02 — Updateable module platform
Milestone status: **COMPLETE**

### P006 — Module manifest and safe package parser
Status: **COMPLETE**  
Depends on: P005  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Define .pcmsmod authority/package contracts and a bounded archive parser.

**Explicitly not in this phase:**
- Do not execute module code or implement update activation.

**Work:**
- [x] T006.1 — Implement manifest/API/capability schema validation
- [x] T006.2 — Implement traversal/duplicate/link/size/bomb-safe archive parsing
- [x] T006.3 — Add adversarial package fixtures and rejection tests

**Acceptance:**
- [x] A02-01
- [x] A02-02

**Closure:** relevant tests + CI green; phase report finalized; P006 → COMPLETE; P007 → READY; publish to GitHub; **STOP — do not implement P007.**

### P007 — Module runner IPC and crash containment
Status: **COMPLETE**  
Depends on: P006  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Run module backend code outside pcmsd behind bounded typed IPC and contain runtime loss.

**Explicitly not in this phase:**
- Do not implement package updates, storage migration or module UI.

**Work:**
- [x] T007.1 — Implement module-runner process lifecycle and typed RPC envelope
- [x] T007.2 — Enforce supported-authority boundary: no raw DB/router/CDP handles
- [x] T007.3 — Test crash/timeout/oversize-message containment with unrelated Core responsiveness

**Acceptance:**
- [x] A02-03
- [x] A02-04

**Closure:** relevant tests + CI green; phase report finalized; P007 → COMPLETE; P008 → READY; publish to GitHub; **STOP — do not implement P008.**

### P008 — Module storage generations and candidate migration
Status: **COMPLETE**  
Depends on: P007  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Create namespaced module state, runtime-generation fencing and safe candidate-state migration.

**Explicitly not in this phase:**
- Do not activate permission expansion or expose module UI.

**Work:**
- [x] T008.1 — Implement module namespace/version storage and generation fencing
- [x] T008.2 — Implement candidate state copy/migration/health validation
- [x] T008.3 — Prove stale runtime rejection and last-known-good survival on candidate failure

**Acceptance:**
- [x] A02-05
- [x] A02-06

**Closure:** relevant tests + CI green; phase report finalized; P008 → COMPLETE; P009 → READY; publish to GitHub; **STOP — do not implement P009.**

### P009 — Capability approval and atomic module activation
Status: **COMPLETE**  
Depends on: P008  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Require explicit authority-delta approval and atomically activate only validated candidates.

**Explicitly not in this phase:**
- Do not implement remove/purge/rollback lifecycle yet.

**Work:**
- [x] T009.1 — Compute initial/update authority envelopes and expansion deltas
- [x] T009.2 — Implement approval state and atomic candidate activation
- [x] T009.3 — Test decline/reduced-authority/no-expansion paths

**Acceptance:**
- [x] A02-07

**Closure:** relevant tests + CI green; phase report finalized; P009 → COMPLETE; P010 → READY; publish to GitHub; **STOP — do not implement P010.**

### P010 — Disable, re-enable, rollback and purge guards
Status: **COMPLETE**  
Depends on: P009  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Complete destructive/lifecycle controls without losing module state or unresolved operation evidence.

**Explicitly not in this phase:**
- Do not add feature-specific module behavior.

**Work:**
- [x] T010.1 — Implement disable/re-enable while preserving state and unresolved Core evidence
- [x] T010.2 — Implement rollback via a new runtime generation
- [x] T010.3 — Implement guarded remove/purge with unresolved-operation/HumanTask refusal tests

**Acceptance:**
- [x] A02-08
- [x] A02-09
- [x] A02-10

**Closure:** relevant tests + CI green; phase report finalized; P010 → COMPLETE; P011 → READY; publish to GitHub; **STOP — do not implement P011.**

### P011 — Module UI host and reference package acceptance
Status: **COMPLETE**  
Depends on: P010  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Prove the public module path end-to-end using a reference .pcmsmod and resettable module UI.

**Explicitly not in this phase:**
- Do not special-case first-party modules inside Core.

**Work:**
- [x] T011.1 — Implement isolated/resettable module UI host
- [x] T011.2 — Build/install/update the reference module through the real package path
- [x] T011.3 — Exercise UI failure, update and lifecycle integration

**Acceptance:**
- [x] A02-11
- [x] A02-12

**Closure:** relevant tests + CI green; phase report finalized; P011 → COMPLETE; P012 → READY; publish to GitHub; **STOP — do not implement P012.**

---

## M03 — Chromium Persona runtime
Milestone status: **COMPLETE**

### P012 — Persona profile-root lifecycle
Status: **COMPLETE**  
Depends on: P011  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Create stable Persona user-data directories and explicit open/close/retire/delete guards.

**Explicitly not in this phase:**
- Do not implement provider login, routing or generic CDP automation.

**Work:**
- [x] T012.1 — Implement safe profile-root allocation keyed by Persona UID
- [x] T012.2 — Implement open/close persistence semantics
- [x] T012.3 — Implement retire/delete guards and profile-path safety tests

**Acceptance:**
- [x] A03-01
- [x] A03-09

**Closure:** relevant tests + CI green; phase report finalized; P012 → COMPLETE; P013 → READY; publish to GitHub; **STOP — do not implement P013.**

### P013 — Chromium persistence, isolation and simultaneous Personas
Status: **COMPLETE**  
Depends on: P012  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Prove persistent browser state and isolation across multiple real Chromium Persona processes.

**Explicitly not in this phase:**
- Do not implement crash reconciliation or MCP.

**Work:**
- [x] T013.1 — Launch real Chromium with owned non-default user-data-dir and DevTools endpoint
- [x] T013.2 — Test cookie/localStorage/IndexedDB persistence and cross-Persona isolation
- [x] T013.3 — Test two simultaneous Personas with distinct process/profile/DevTools ownership

**Acceptance:**
- [x] A03-02
- [x] A03-03
- [x] A03-04

**Closure:** relevant tests + CI green; phase report finalized; P013 → COMPLETE; P014 → READY; publish to GitHub; **STOP — do not implement P014.**

### P014 — Browser ownership, crash/restart reconciliation and resource cap
Status: **COMPLETE**  
Depends on: P013  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Make browser runtime ownership/recovery safe across pcmsd or Chromium loss and enforce bounded active Persona count.

**Explicitly not in this phase:**
- Do not implement routing or provider automation.

**Work:**
- [x] T014.1 — Implement runtime fingerprint/ownership and ambiguous-attach refusal
- [x] T014.2 — Implement Chromium/pcmsd restart reconciliation
- [x] T014.3 — Implement active-Persona admission cap and recovery tests

**Acceptance:**
- [x] A03-05
- [x] A03-06
- [x] A03-07
- [x] A03-10

**Closure:** relevant tests + CI green; phase report finalized; P014 → COMPLETE; P015 → READY; publish to GitHub; **STOP — do not implement P015.**

### P015 — Generic DevTools attach/detach acceptance
Status: **COMPLETE**  
Depends on: P014  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Prove an external generic DevTools client can attach to the already-running Persona and detach without destroying it.

**Explicitly not in this phase:**
- Do not use MCP; MCP interoperability is final live acceptance.

**Work:**
- [x] T015.1 — Expose/discover the owned loopback DevTools endpoint safely
- [x] T015.2 — Run a generic CDP attach/interact/detach test against the same Persona
- [x] T015.3 — Verify browser/profile/process survive client disconnect

**Acceptance:**
- [x] A03-08

**Closure:** relevant tests + CI green; phase report finalized; P015 → COMPLETE; P016 → READY; publish to GitHub; **STOP — do not implement P016.**

---

## M04 — Protected routing
Milestone status: **COMPLETE**

### P016 — Native router baseline and bounded Core client
Status: **COMPLETE**  
Depends on: P015  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Preserve the proven PersonaMonkey router baseline while adding an unprivileged typed pcmsd control client.

**Explicitly not in this phase:**
- Do not modify Firefox-compatible prepare_exit semantics or launch Chromium through a route yet.

**Work:**
- [x] T016.1 — Re-run exact port/provenance/native hardening baseline
- [x] T016.2 — Implement bounded Unix-socket router client and typed errors
- [x] T016.3 — Prove pcmsd requires no root/NET_ADMIN privileges

**Acceptance:**
- [x] A04-01
- [x] A04-02

**Closure:** relevant tests + CI green; phase report finalized; P016 → COMPLETE; P017 → READY; publish to GitHub; **STOP — do not implement P017.**

### P017 — Chromium-compatible loopback forwarder lease
Status: **COMPLETE**  
Depends on: P016  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Add the distinct Chromium route/lease command with loopback-only binding and safe expiry/release.

**Explicitly not in this phase:**
- Do not weaken existing authenticated Firefox-compatible forwarder behavior.

**Work:**
- [x] T017.1 — Implement prepare_chromium_exit-equivalent daemon contract
- [x] T017.2 — Bind forwarder loopback-only with route/lease lifetime
- [x] T017.3 — Test expiration, release, stale lease and unauthorized access paths

**Acceptance:**
- [x] A04-03

**Closure:** relevant tests + CI green; phase report finalized; P017 → COMPLETE; P018 → READY; publish to GitHub; **STOP — do not implement P018.**

### P018 — Protected synthetic egress and independent verification
Status: **COMPLETE**  
Depends on: P017  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Launch a protected Chromium Persona through a controlled synthetic exit and independently verify actual egress.

**Explicitly not in this phase:**
- Do not require real Mullvad configuration.

**Work:**
- [x] T018.1 — Build controlled SOCKS/egress fixture with distinguishable route identity
- [x] T018.2 — Wire protected Chromium launch to the leased forwarder
- [x] T018.3 — Verify observed browser egress independently of configured route metadata

**Acceptance:**
- [x] A04-04
- [x] A04-05

**Closure:** relevant tests + CI green; phase report finalized; P018 → COMPLETE; P019 → READY; publish to GitHub; **STOP — do not implement P019.**

### P019 — Leak resistance and route-loss fail-closed behavior
Status: **COMPLETE**  
Depends on: P018  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Prove supported Chromium networking does not silently escape the protected route when DNS/QUIC/WebRTC or route loss is exercised.

**Explicitly not in this phase:**
- Do not claim real Mullvad interoperability.

**Work:**
- [x] T019.1 — Add controlled DNS/QUIC/WebRTC-sensitive network assertions
- [x] T019.2 — Inject proxy/tunnel/forwarder loss during browser use
- [x] T019.3 — Assert failure/blocking and detect any Direct/control-path escape

**Acceptance:**
- [x] A04-06
- [x] A04-07

**Closure:** relevant tests + CI green; phase report finalized; P019 → COMPLETE; P020 → READY; publish to GitHub; **STOP — do not implement P020.**

### P020 — Direct, Block, route switch and multi-route acceptance
Status: **COMPLETE**  
Depends on: P019  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Complete routing mode semantics and safe switching across multiple simultaneously active protected Personas.

**Explicitly not in this phase:**
- Do not add real Mullvad/MCP live acceptance.

**Work:**
- [x] T020.1 — Implement/test explicit Direct and Block launch modes
- [x] T020.2 — Implement safe route switch/relaunch with fresh egress verification
- [x] T020.3 — Test multiple active protected Personas on independent synthetic exits

**Acceptance:**
- [x] A04-08
- [x] A04-09
- [x] A04-10
- [x] A04-11

**Closure:** relevant tests + CI green; phase report finalized; P020 → COMPLETE; P021 → READY; publish to GitHub; **STOP — do not implement P021.**

---

## M05 — Accounts, Generator identity and inventory
Milestone status: **COMPLETE**

### P021 — Account-Persona binding invariants
Status: **COMPLETE**  
Depends on: P020  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Persist Account/Persona entities and enforce one-active-account-to-one-dedicated-Persona with audited rebinding.

**Explicitly not in this phase:**
- Do not implement provider session probing or search.

**Work:**
- [x] T021.1 — Add Account/Persona schema and repositories
- [x] T021.2 — Enforce transactional active binding uniqueness
- [x] T021.3 — Implement explicit rebind history and tests

**Acceptance:**
- [x] A05-01
- [x] A05-02

**Closure:** relevant tests + CI green; phase report finalized; P021 → COMPLETE; P022 → READY; publish to GitHub; **STOP — do not implement P022.**

### P022 — Stable GeneratorRef identity and atomic import
Status: **COMPLETE**  
Depends on: P021  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Create stable Generator identity independent of mutable slug and validate imports atomically.

**Explicitly not in this phase:**
- Do not implement Deployer or provider mutation.

**Work:**
- [x] T022.1 — Add GeneratorRef schema/current-slug/provider-ID constraints
- [x] T022.2 — Implement identity-preserving slug/provider-ID updates
- [x] T022.3 — Implement validate-first all-or-nothing Account/Generator import

**Acceptance:**
- [x] A05-03
- [x] A05-06

**Closure:** relevant tests + CI green; phase report finalized; P022 → COMPLETE; P023 → READY; publish to GitHub; **STOP — do not implement P023.**

### P023 — Health projections, search and Account-to-Persona navigation
Status: **COMPLETE**  
Depends on: P022  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Expose useful inventory/search/navigation without confusing configured, observed, verified, stale or unknown state.

**Explicitly not in this phase:**
- Do not infer provider truth from labels or stale observations.

**Work:**
- [x] T023.1 — Implement route/session/account health projections with evidence age
- [x] T023.2 — Implement metadata search using stable IDs
- [x] T023.3 — Add UI/CLI navigation from Account to the actual bound Persona

**Acceptance:**
- [x] A05-04
- [x] A05-05
- [x] A05-10

**Closure:** relevant tests + CI green; phase report finalized; P023 → COMPLETE; P024 → READY; publish to GitHub; **STOP — do not implement P024.**

### P024 — Wrong-account guard and 50+ inventory resilience
Status: **COMPLETE**  
Depends on: P023  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Make inventory scale and corruption isolation safe while preventing sensitive actions under wrong-account observations.

**Explicitly not in this phase:**
- Do not add mutation execution; this phase establishes admission facts only.

**Work:**
- [x] T024.1 — Implement wrong-account/unknown-session admission guard contract
- [x] T024.2 — Exercise 50+ dormant Account/Persona startup/query bounds
- [x] T024.3 — Prove one missing/corrupt Persona does not poison unrelated inventory

**Acceptance:**
- [x] A05-07
- [x] A05-08
- [x] A05-09

**Closure:** relevant tests + CI green; phase report finalized; P024 → COMPLETE; P025 → READY; publish to GitHub; **STOP — do not implement P025.**

---

## M06 — Provider automation and operation safety
Milestone status: **COMPLETE**

### P025 — BrowserDriver connection, cancellation and diagnostics
Status: **COMPLETE**  
Depends on: P024  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Create the narrow BrowserDriver over already-running Persona Chromium processes.

**Explicitly not in this phase:**
- Do not create automation-only profiles or implement Perchance semantics.

**Work:**
- [x] T025.1 — Implement connect/target selection against owned Persona DevTools endpoint
- [x] T025.2 — Implement bounded timeout/cancellation/target-loss errors
- [x] T025.3 — Test that BrowserDriver never synthesizes a separate browser identity

**Acceptance:**
- [x] A06-01
- [x] A06-02

**Closure:** relevant tests + CI green; phase report finalized; P025 → COMPLETE; P026 → READY; publish to GitHub; **STOP — do not implement P026.**

### P026 — Perchance emulator and identity/read probes
Status: **COMPLETE**  
Depends on: P025  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Create the stateful evidence-backed Perchance emulator and use it through real Chromium/provider adapter identity probes.

**Explicitly not in this phase:**
- Do not connect CI to real Perchance or encode unobserved provider behavior as fact.

**Work:**
- [x] T026.1 — Implement emulator session/account/generator state and drift/error scenarios
- [x] T026.2 — Implement provider session identity and GeneratorRef/current-slug probes
- [x] T026.3 — Run expected/mismatch/unknown and stale-evidence tests through real BrowserDriver

**Acceptance:**
- [x] A06-03
- [x] A06-04

**Closure:** relevant tests + CI green; phase report finalized; P026 → COMPLETE; P027 → READY; publish to GitHub; **STOP — do not implement P027.**

### P027 — OperationCoordinator claims and uncertainty state machine
Status: **COMPLETE**  
Depends on: P026  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Make remote mutation admission durable and duplicate-safe across crashes, cancellation and ambiguous dispatch.

**Explicitly not in this phase:**
- Do not implement module-specific mutation policy.

**Work:**
- [x] T027.1 — Implement stable-target claim/epoch and legal state transitions
- [x] T027.2 — Persist pre-dispatch evidence and classify post-dispatch loss as UNCERTAIN
- [x] T027.3 — Test restart/cancel/process-loss matrices and forbid blind redispatch

**Acceptance:**
- [x] A06-05
- [x] A06-06
- [x] A06-12

**Closure:** relevant tests + CI green; phase report finalized; P027 → COMPLETE; P028 → READY; publish to GitHub; **STOP — do not implement P028.**

### P028 — Response reconciliation, ProviderGate and Human Tasks
Status: **COMPLETE**  
Depends on: P027  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Add shared provider pressure control, read-first reconciliation and durable human continuation.

**Explicitly not in this phase:**
- Do not automate CAPTCHA solving or bypass human challenges.

**Work:**
- [x] T028.1 — Implement emulator response-loss-after-effect reconciliation
- [x] T028.2 — Implement provider/account/Persona admission cooldown/concurrency gate
- [x] T028.3 — Implement durable HumanTask + transient input continuation through the same Persona

**Acceptance:**
- [x] A06-07
- [x] A06-08
- [x] A06-09
- [x] A06-10

**Closure:** relevant tests + CI green; phase report finalized; P028 → COMPLETE; P029 → READY; publish to GitHub; **STOP — do not implement P029.**

### P029 — Batch isolation and scheduler/time semantics
Status: **COMPLETE**  
Depends on: P028  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Provide bounded batch/scheduler primitives without replay storms or cross-child corruption.

**Explicitly not in this phase:**
- Do not build a generic workflow engine.

**Work:**
- [x] T029.1 — Implement independent batch child result/cancellation accounting
- [x] T029.2 — Implement duplicate wake coalescing and persisted time/budget semantics
- [x] T029.3 — Exercise clock jump/restart/backpressure integration

**Acceptance:**
- [x] A06-11
- [x] A06-13

**Closure:** relevant tests + CI green; phase report finalized; P029 → COMPLETE; P030 → READY; publish to GitHub; **STOP — do not implement P030.**

---

## M07 — Deployer
Milestone status: **READY**

### P030 — Deployer GitHub scanner and artifact selection
Status: **IN_PROGRESS**  
Depends on: P029  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Resolve an exact repository commit into bounded, validated deployment artifacts deterministically.

**Explicitly not in this phase:**
- Do not mutate Perchance or guess ambiguous versions/layouts.

**Work:**
- [x] T030.1 — Implement exact-commit repository tree scan
- [x] T030.2 — Validate ZIP/layout/required files and compute SHA-256
- [~] T030.3 — Implement deterministic version selection and explicit ambiguity failure

**Acceptance:**
- [ ] A07-01
- [ ] A07-02

**Closure:** relevant tests + CI green; phase report finalized; P030 → COMPLETE; P031 → READY; publish to GitHub; **STOP — do not implement P031.**

### P031 — Stable target mapping and initial emulated deployment
Status: **BLOCKED**  
Depends on: P030  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Map desired repository state to stable GeneratorRef and perform the first safe deployment through the emulator.

**Explicitly not in this phase:**
- Do not use slug alone as durable target identity or real Perchance.

**Work:**
- [ ] T031.1 — Resolve repository mapping to stable Account/GeneratorRef and freshly revalidate provider identity
- [ ] T031.2 — Implement initial save/public-state path through OperationCoordinator
- [ ] T031.3 — Verify desired content and public state through independent emulator read

**Acceptance:**
- [ ] A07-03
- [ ] A07-04

**Closure:** relevant tests + CI green; phase report finalized; P031 → COMPLETE; P032 → READY; publish to GitHub; **STOP — do not implement P032.**

### P032 — Deployer update, no-op, drift and response-loss reconciliation
Status: **BLOCKED**  
Depends on: P031  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Make repeated deployment safe under identical content, slug reuse/provider drift and lost responses.

**Explicitly not in this phase:**
- Do not add polling/module-update concerns yet.

**Work:**
- [ ] T032.1 — Implement verified-SHA no-op and changed-artifact update
- [ ] T032.2 — Reject old-slug/provider-identity mismatch redirect
- [ ] T032.3 — Reconcile emulated lost save response before any retry

**Acceptance:**
- [ ] A07-05
- [ ] A07-06
- [ ] A07-07

**Closure:** relevant tests + CI green; phase report finalized; P032 → COMPLETE; P033 → READY; publish to GitHub; **STOP — do not implement P033.**

### P033 — Deployer polling, module lifecycle and CI vertical slice
Status: **BLOCKED**  
Depends on: P032  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Prove Deployer behaves like a real independently updateable module and completes the CI beta vertical slice.

**Explicitly not in this phase:**
- Do not use MCP or real Perchance/Mullvad.

**Work:**
- [ ] T033.1 — Implement/coalesce polling under shared provider backpressure
- [ ] T033.2 — Exercise update/disable/crash/rollback while preserving Core operation evidence
- [ ] T033.3 — Run Account→Persona→synthetic route→emulator→Deployer end-to-end CI acceptance

**Acceptance:**
- [ ] A07-08
- [ ] A07-09
- [ ] A07-10
- [ ] A07-11
- [ ] A07-12

**Closure:** relevant tests + CI green; phase report finalized; P033 → COMPLETE; P034 → READY; publish to GitHub; **STOP — do not implement P034.**

---

## M08 — Refresh measurement and Refresher
Milestone status: **BLOCKED**

### P034 — Refresh and recent-listing emulator contract
Status: **BLOCKED**  
Depends on: P033  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Encode the evidence-backed refresh/listing behavior needed by Refresher and fail closed on drift.

**Explicitly not in this phase:**
- Do not measure against live Perchance during implementation phases.

**Work:**
- [ ] T034.1 — Model refresh effect and listing/recent surfaces in the emulator
- [ ] T034.2 — Implement parser/compatibility behavior including UNKNOWN on drift
- [ ] T034.3 — Add sanitized evidence/fixture provenance notes for assumptions

**Acceptance:**
- [ ] A08-01
- [ ] A08-02

**Closure:** relevant tests + CI green; phase report finalized; P034 → COMPLETE; P035 → READY; publish to GitHub; **STOP — do not implement P035.**

### P035 — Refresher cohorts, time policy and shared admission
Status: **BLOCKED**  
Depends on: P034  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Implement cohort/schedule policy while sharing target claims and provider pressure with other modules.

**Explicitly not in this phase:**
- Do not couple Refresher policy into Core.

**Work:**
- [ ] T035.1 — Implement configurable cohorts beyond visible recent-page capacity
- [ ] T035.2 — Implement active/sleep/timezone/budget semantics with DST/clock tests
- [ ] T035.3 — Enforce Deployer collision exclusion and shared ProviderGate signals

**Acceptance:**
- [ ] A08-03
- [ ] A08-04
- [ ] A08-05
- [ ] A08-06

**Closure:** relevant tests + CI green; phase report finalized; P035 → COMPLETE; P036 → READY; publish to GitHub; **STOP — do not implement P036.**

### P036 — Refresher execution, history, uncertainty and package lifecycle
Status: **BLOCKED**  
Depends on: P035  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Complete manual/scheduled refresh execution with verified history, uncertainty handling and independent module lifecycle.

**Explicitly not in this phase:**
- Do not claim live provider refresh semantics beyond emulator contract.

**Work:**
- [ ] T036.1 — Implement manual/scheduled/recent-visibility execution and verified history
- [ ] T036.2 — Block duplicate work while refresh outcome is uncertain and reconcile first
- [ ] T036.3 — Package/update/rollback Refresher through standard .pcmsmod lifecycle

**Acceptance:**
- [ ] A08-07
- [ ] A08-08
- [ ] A08-09
- [ ] A08-10

**Closure:** relevant tests + CI green; phase report finalized; P036 → COMPLETE; P037 → READY; publish to GitHub; **STOP — do not implement P037.**

---

## M09 — Explorer and Account Provisioning
Milestone status: **BLOCKED**

### P037 — Explorer observation, claim and stable handoff
Status: **BLOCKED**  
Depends on: P036  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Implement Explorer candidate observation/claim semantics without confusing availability with ownership.

**Explicitly not in this phase:**
- Do not implement Account Provisioning in this phase.

**Work:**
- [ ] T037.1 — Implement emulator-backed availability observation distinct from ownership
- [ ] T037.2 — Use OperationCoordinator for claim/reconciliation/reservation
- [ ] T037.3 — Handoff verified acquisition to stable Generator/Project target

**Acceptance:**
- [ ] A09-01
- [ ] A09-02
- [ ] A09-03

**Closure:** relevant tests + CI green; phase report finalized; P037 → COMPLETE; P038 → READY; publish to GitHub; **STOP — do not implement P038.**

### P038 — Provisioning staging and dedicated Persona allocation
Status: **BLOCKED**  
Depends on: P037  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Validate account inputs before side effects and allocate the dedicated Persona used for signup/login.

**Explicitly not in this phase:**
- Do not complete verification/challenge/recovery behavior yet.

**Work:**
- [ ] T038.1 — Implement staged import and duplicate detection before external effects
- [ ] T038.2 — Allocate/bind dedicated Persona under invariants
- [ ] T038.3 — Drive signup/login emulator flow in the same human-visible browser session

**Acceptance:**
- [ ] A09-04
- [ ] A09-05

**Closure:** relevant tests + CI green; phase report finalized; P038 → COMPLETE; P039 → READY; publish to GitHub; **STOP — do not implement P039.**

### P039 — Provisioning HumanTask, identity activation and interrupted-flow recovery
Status: **BLOCKED**  
Depends on: P038  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Resume verification/challenge flows safely and activate Accounts only after proven provider identity.

**Explicitly not in this phase:**
- Do not bypass CAPTCHA or blindly retry ambiguous signup effects.

**Work:**
- [ ] T039.1 — Implement CAPTCHA/code/verification-needed HumanTask continuation
- [ ] T039.2 — Verify authenticated provider identity before ACTIVE
- [ ] T039.3 — Reconcile interrupted signup/login without duplicate account creation

**Acceptance:**
- [ ] A09-06
- [ ] A09-07
- [ ] A09-08

**Closure:** relevant tests + CI green; phase report finalized; P039 → COMPLETE; P040 → READY; publish to GitHub; **STOP — do not implement P040.**

### P040 — Provisioning batches, module lifecycle and secret hygiene
Status: **BLOCKED**  
Depends on: P039  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Complete Explorer/Provisioning operational isolation, package lifecycle and secret-redaction boundaries.

**Explicitly not in this phase:**
- Do not store credentials in ordinary module/history/statistics state.

**Work:**
- [ ] T040.1 — Implement isolated per-account batch state/result/cancellation
- [ ] T040.2 — Exercise independent Explorer/Provisioning package update/rollback
- [ ] T040.3 — Audit secret inputs across logs/history/module/statistics records

**Acceptance:**
- [ ] A09-09
- [ ] A09-10
- [ ] A09-11

**Closure:** relevant tests + CI green; phase report finalized; P040 → COMPLETE; P041 → READY; publish to GitHub; **STOP — do not implement P041.**

---

## M10 — Statistics, backup, restore and operational UX
Milestone status: **BLOCKED**

### P041 — Statistics and coherent Core/module backup
Status: **BLOCKED**  
Depends on: P040  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Add read-only Statistics and a coherent integrity-checked backup that excludes browser profiles by default.

**Explicitly not in this phase:**
- Do not let Statistics mutate authoritative state or silently include profiles.

**Work:**
- [ ] T041.1 — Implement Statistics projections from operational facts only
- [ ] T041.2 — Implement DB/module-state backup manifest and hashes
- [ ] T041.3 — Implement automatic retention with explicit profile exclusion

**Acceptance:**
- [ ] A10-01
- [ ] A10-02
- [ ] A10-03

**Closure:** relevant tests + CI green; phase report finalized; P041 → COMPLETE; P042 → READY; publish to GitHub; **STOP — do not implement P042.**

### P042 — Optional profile backup and recovery-hold restore
Status: **BLOCKED**  
Depends on: P041  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Restore optional closed-Persona profiles and Core state without synthesizing health or replaying mutations.

**Explicitly not in this phase:**
- Do not back up open profiles or claim cross-Chromium compatibility that is not verified.

**Work:**
- [ ] T042.1 — Implement optional closed-profile backup/restore with compatibility reporting
- [ ] T042.2 — Activate restores into RECOVERY_HOLD without overdue mutation replay
- [ ] T042.3 — Report missing profile/module/external state as degraded/unknown

**Acceptance:**
- [ ] A10-04
- [ ] A10-05
- [ ] A10-06

**Closure:** relevant tests + CI green; phase report finalized; P042 → COMPLETE; P043 → READY; publish to GitHub; **STOP — do not implement P043.**

### P043 — Attention durability, fresh-install restore and V1 gap ledger
Status: **BLOCKED**  
Depends on: P042  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Finish operational attention/restore UX and explicitly resolve remaining Full-V1 requirement gaps before hardening.

**Explicitly not in this phase:**
- Do not hide unresolved Workflow/Project/workspace requirements.

**Work:**
- [ ] T043.1 — Persist Attention/HumanTask state across restart independent of notifications
- [ ] T043.2 — Run fresh-install Core/module relationship restore acceptance
- [ ] T043.3 — Produce explicit Full-V1 requirements gap ledger and accepted dispositions

**Acceptance:**
- [ ] A10-07
- [ ] A10-08
- [ ] A10-09

**Closure:** relevant tests + CI green; phase report finalized; P043 → COMPLETE; P044 → READY; publish to GitHub; **STOP — do not implement P044.**

---

## M11 — Hardening, packaging and CI release candidate
Milestone status: **BLOCKED**

### P044 — Fedora/Linux installer, desktop launch and uninstall semantics
Status: **BLOCKED**  
Depends on: P043  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Create the supported install/update/uninstall path without npm/pnpm setup for end users.

**Explicitly not in this phase:**
- Do not silently purge user data, profiles, router state or configuration.

**Work:**
- [ ] T044.1 — Build installer/bundle integration with desktop and user-service launch
- [ ] T044.2 — Implement update/uninstall preserving data by default with explicit purge
- [ ] T044.3 — Run clean Fedora/Linux install/start/uninstall smoke in CI

**Acceptance:**
- [ ] A11-01
- [ ] A11-02

**Closure:** relevant tests + CI green; phase report finalized; P044 → COMPLETE; P045 → READY; publish to GitHub; **STOP — do not implement P045.**

### P045 — Crash, resource-pressure and scale hardening matrix
Status: **BLOCKED**  
Depends on: P044  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Exercise the dominant local failure domains and prove unrelated work remains bounded and recoverable.

**Explicitly not in this phase:**
- Do not use real provider/VPN availability as a hardening dependency.

**Work:**
- [ ] T045.1 — Automate pcmsd/module/Chromium kill matrices across operation states
- [ ] T045.2 — Inject DB busy/disk-full/corrupt-backup and queue/poison-module pressure
- [ ] T045.3 — Exercise 50+ Persona inventory/startup/disk with bounded active subset

**Acceptance:**
- [ ] A11-03
- [ ] A11-04
- [ ] A11-06
- [ ] A11-07
- [ ] A11-08

**Closure:** relevant tests + CI green; phase report finalized; P045 → COMPLETE; P046 → READY; publish to GitHub; **STOP — do not implement P046.**

### P046 — Security audit, release artifacts and fresh-restore drill
Status: **BLOCKED**  
Depends on: P045  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Prove release artifacts and recovery are auditable, reproducible enough for V1, and free of obvious secret/path/archive regressions.

**Explicitly not in this phase:**
- Do not treat SBOM/checksum generation as proof of live compatibility.

**Work:**
- [ ] T046.1 — Run secrets/redaction/path/archive security audit
- [ ] T046.2 — Build Core/modules with checksums, provenance and SBOM/reproducibility evidence
- [ ] T046.3 — Run fresh-install restore drill preserving unresolved operation/HumanTask state

**Acceptance:**
- [ ] A11-09
- [ ] A11-10
- [ ] A11-11

**Closure:** relevant tests + CI green; phase report finalized; P046 → COMPLETE; P047 → READY; publish to GitHub; **STOP — do not implement P047.**

### P047 — Full synthetic release-candidate acceptance
Status: **BLOCKED**  
Depends on: P046  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Produce the CI-complete release candidate by exercising the full browser, routing, emulator and recovery vertical system without live credentials.

**Explicitly not in this phase:**
- Do not claim real Mullvad, real Perchance or MCP compatibility.

**Work:**
- [ ] T047.1 — Run generic DevTools Persona acceptance plus full synthetic routing/fail-closed matrix
- [ ] T047.2 — Run Perchance emulator read/mutation/reconciliation/drift suite
- [ ] T047.3 — Publish CI-complete release-candidate report with residual live assumptions

**Acceptance:**
- [ ] A11-05
- [ ] A11-12
- [ ] A11-13
- [ ] A11-14
- [ ] A11-15

**Closure:** relevant tests + CI green; phase report finalized; P047 → COMPLETE; P048 → READY; publish to GitHub; **STOP — do not implement P048.**

---

## M12 — Final live acceptance
Milestone status: **BLOCKED**

### P048 — Live MCP and Mullvad acceptance
Status: **BLOCKED**  
Depends on: P047  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Validate only the external integration facts that deterministic CI cannot prove: MCP interoperability, real Persona distinction and real Mullvad route/fail-closed smoke.

**Explicitly not in this phase:**
- Do not debug broad implementation failures live; feed any discrepancy back into deterministic fixtures first.

**Work:**
- [ ] T048.1 — Run MCP attach/interact/detach on actual PCMS-managed Persona and verify persistence
- [ ] T048.2 — Confirm two actual Personas are distinct contexts
- [ ] T048.3 — Run real protected Mullvad egress plus one representative route-loss fail-closed smoke

**Acceptance:**
- [ ] A12-01
- [ ] A12-02
- [ ] A12-03

**Closure:** relevant tests + CI green; phase report finalized; P048 → COMPLETE; P049 → READY; publish to GitHub; **STOP — do not implement P049.**

### P049 — Live Perchance compatibility and final release acceptance
Status: **BLOCKED**  
Depends on: P048  
Target size: one bounded agent session (~20–30 min empirical target; do not self-time)

**Objective:** Confirm the current Perchance surface still matches the adapter and verify one disposable real Deployer mutation before final release sign-off.

**Explicitly not in this phase:**
- Do not use production-critical generators; do not continue live debugging when behavior diverges from emulator.

**Work:**
- [ ] T049.1 — Verify expected real Perchance session/account and representative read
- [ ] T049.2 — Perform one disposable Deployer mutation and independently verify result
- [ ] T049.3 — If drift exists, encode/reproduce it in CI first; otherwise finalize live acceptance/release report

**Acceptance:**
- [ ] A12-04
- [ ] A12-05

**Closure:** relevant tests + CI green; phase report finalized; P049 → COMPLETE; final release report published; **STOP.**
