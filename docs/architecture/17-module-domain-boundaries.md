# 17 — First-Party Module Domain Boundaries

## 1. Foundation entities are Core

Accounts, Personas, Routes and stable Generator identity are foundational. They are not updateable modules because every module/control surface depends on their invariants.

Feature modules may extend behavior around these entities.

## 2. Deployer

Owns:
- repository/artifact discovery;
- desired deployment state;
- artifact SHA selection;
- deploy history/policy;
- provider synchronization decisions.

Uses:
- Accounts/Generators;
- Persona/route/session capabilities;
- OperationCoordinator;
- PerchanceProvider;
- GitHub read adapter.

It does not own browser selectors, Account identity or module update machinery.

## 3. Refresh Measurement

Owns empirical experiments to determine safe refresh behavior/listing effects.

It must precede automated policy if provider behavior is not currently proven.

## 4. Refresher

Owns:
- generator pools/cohorts;
- cadence/active-sleep policy;
- budgets/fairness;
- desired recent visibility/activity.

Uses stable Generator IDs and OperationCoordinator. It cannot mutate by old slug without fresh target verification.

## 5. Explorer

Owns:
- candidate discovery;
- availability observations/history;
- claim policy;
- reservation/ownership verification;
- handoff into Generator/Project state after verified acquisition.

"Available" is observation, not ownership.

## 6. Account Provisioning

Owns:
- staged account imports;
- signup/login progression;
- Persona allocation request;
- verification/challenge HumanTasks;
- provider identity verification before activation.

It does not mark an Account active merely because a form submission occurred.

## 7. Statistics

Consumes operational facts/projections and produces aggregates. It is never authoritative for Account/Persona/operation state.

Statistics failure cannot block Core mutation correctness.

## 8. Ban Detector

Whether retained as a separate module or folded into read-only provider observations should be decided from actual product usefulness. If separate, it owns observations/classification, not categorical provider truth.

## 9. Projects/workspaces

Core may own stable Project/Workspace identity if multiple modules need it. Rich source/deployment policy remains Deployer/project feature domain.

Do not recreate the former large Project/Deployment graph before Deployer requirements force a specific structure.

## 10. Workflow abstraction

The PRD requires reusable workflows/runs eventually. Do not build a generic graph engine during foundation.

First implement explicit operation plans/continuations for real Deployer/Provisioning/Refresher flows. Extract a reusable Workflow definition/runtime only after at least two materially different workflows demonstrate shared semantics.

This preserves a path to Full V1 without front-loading speculative complexity.
