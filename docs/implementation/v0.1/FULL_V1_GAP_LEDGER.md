# Full V1 requirements gap ledger

Status: **ACTIVE RELEASE-SCOPE CONSTRAINT**  
Owner: P043 / M10  
Product authority: docs/product/PRODUCT_REQUIREMENTS.md §24  
Decision date: 2026-10-04

## Decision

The v0.1 implementation roadmap is a hardening and acceptance baseline, **not a claim that the PRD's Full V1 boundary is complete**.

A requirement is:

- **IMPLEMENTED** when the v0.1 baseline has the required product mechanism; later M11/M12 hardening or live acceptance may still test it further.
- **PARTIAL** when a real subset exists but the PRD requirement is not complete.
- **DEFERRED** when the Full V1 product surface is intentionally not implemented in the v0.1 roadmap.

Every **PARTIAL** or **DEFERRED** row is accepted as a post-v0.1 Full-V1 completion item. It is not waived, redefined as complete, or satisfied by a similarly named lower-level mechanism. A future roadmap/product decision must close those rows before any release is described as **Full V1**.

M11 and M12 may continue to harden and validate the v0.1 baseline. Their release-candidate/final reports must preserve this scope distinction.

## Ledger

| Full V1 requirement | v0.1 status | Evidence in current baseline | Accepted disposition |
| --- | --- | --- | --- |
| generator inventory and ownership | **IMPLEMENTED** | Durable Account/Generator repositories, stable provider identity, inventory/search surfaces and ownership-aware module flows. | Keep in v0.1; M11/M12 only harden/validate. |
| Projects | **PARTIAL** | ProjectRepository provides durable Project ID → Generator target mapping. It does not provide the broader Project workspace/revision product model. | Keep target mapping in v0.1; full Project model is post-v0.1 Full-V1 work. |
| workspaces and revision history | **DEFERRED** | No workspace/revision-history domain or persistence contract exists. | Post-v0.1 Full-V1 work; do not infer it from module state, files or Operations. |
| deployments and external-drift detection | **PARTIAL** | Deployer has stable-target mutation, artifact scanning/read-back and drift/uncertainty handling, but there is no first-class Deployment record tied to workspace revisions. | Keep current Deployer safety in v0.1; first-class deployment/revision history is post-v0.1 Full-V1 work. |
| reusable Workflows | **DEFERRED** | Concrete Deployer/Refresher/Provisioning plans use Operations, continuations, schedules and batches; there is no reusable Workflow definition/Run domain. | Post-v0.1 Full-V1 work. Extract only from demonstrated common semantics; do not relabel Operations as Workflows. |
| scheduling | **IMPLEMENTED** | Durable scheduler, timezone/interval policy and restart-safe schedule state. | Keep in v0.1; harden in M11. |
| queues | **IMPLEMENTED** | Bounded work queues and admission/backpressure contracts. | Keep in v0.1; harden under resource-pressure acceptance. |
| batch execution | **IMPLEMENTED** | Durable batch membership/status plus provisioning per-account isolation/cancellation. | Keep in v0.1. |
| modules | **IMPLEMENTED** | Package validation, lifecycle, capability approval, process isolation, state generations, rollback and UI SDK fencing. | Keep in v0.1; release artifact/security hardening remains M11. |
| Refresher | **IMPLEMENTED** | First-party module policy/execution/history with shared Core admission and reconciliation. | Keep in v0.1. |
| Explorer | **IMPLEMENTED** | First-party module package/lifecycle and bounded read-oriented integration. | Keep in v0.1. |
| Account Provisioning | **IMPLEMENTED** | Dedicated Persona allocation, HumanTask continuation, identity verification, interrupted-flow reconciliation and batches. | Keep in v0.1. |
| Statistics | **IMPLEMENTED** | Read-only operational aggregate projection over authoritative facts. | Keep in v0.1. |
| Attention | **IMPLEMENTED** | Durable open HumanTasks projected through authenticated API, CLI and Web UI; P043 proves restart persistence. | Keep human_tasks authoritative. Notifications must never replace this durable record. |
| notifications | **DEFERRED** | No standalone notification delivery subsystem is implemented. | Post-v0.1 Full-V1 work. v0.1 may expose Attention directly but must not claim notifications. |
| global search | **PARTIAL** | Search covers Account, Persona and Generator metadata/stable identity. It does not cover Projects, Workflow definitions, Runs, modules or their richer metadata. | Keep current inventory search in v0.1; Full-V1 cross-entity search is post-v0.1 work. |
| backup/recovery | **IMPLEMENTED** | Coherent Core/module backup, optional closed-profile backup, integrity validation, staged restore, RECOVERY_HOLD, degraded/unknown reporting and fresh-install relationship reconstruction. | Keep in v0.1; P046 repeats release drill/security evidence. |
| operational diagnostics | **IMPLEMENTED** | Local status/diagnostics endpoints, structured errors/evidence, health/readiness and bounded operational state are present. | Keep in v0.1; M11 hardens release diagnostics/failure matrices. |

## Full V1 claim gate

Full V1 is **not satisfied** while any row above is **PARTIAL** or **DEFERRED**. As of this decision the unresolved Full-V1 areas are:

- the broader Project domain;
- workspaces and revision history;
- first-class deployments linked to revisions;
- reusable Workflow definitions/Runs;
- notifications;
- global search across the full Full-V1 entity set.

These are deliberate, visible gaps. They are not TODO placeholders inside P043 and they do not block v0.1 hardening; they block only a **Full V1** product claim until a subsequent roadmap closes them.
