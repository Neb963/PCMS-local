# PCMS-local Implementation Authority v0.1

This directory is the implementation authority beneath the Product Requirements, accepted ADRs and architecture specifications.

## Canonical files

1. `plan.json` — machine-readable milestone/phase/dependency/status authority.
2. `/ROADMAP.md` — human execution view; task/subtask checklist and phase boundaries.
3. `POLICIES.json` — machine-readable cross-cutting policy.
4. `REQUIREMENT_OWNERSHIP.json` — requirement/spec/implementation ownership.
5. `ACCEPTANCE_MATRIX.md` — acceptance gates, evidence class and owning session phase.
6. `SPEC_TRACEABILITY.md` — product→architecture→milestone/phase mapping.
7. `DEFINITION_OF_DONE.md` — phase/milestone/release completion rules.

`docs/progress/STATUS.md` is deliberately tiny. It points to the one current execution phase and must match plan/roadmap.

## Execution rule

A fresh implementation agent should be able to receive only:

> Implement the next READY phase.

The agent reads `AGENTS.md`, `ROADMAP.md`, the current phase's linked specs, acceptance gates and preceding phase report, then implements **that one phase only**.

A normal phase is structurally sized for one approximately 20–30 minute cloud-agent session; the agent does not self-time. At completion it tests, publishes commits/checkpoints to GitHub, finalizes the phase report, marks the immediate successor READY, and **stops without starting it**.

Repository transport may be either a local Git checkout or the GitHub connector. GitHub remains the durability/source-of-truth boundary.

## Current state

- P000–P003 — COMPLETE
- P004 — READY
- P005–P049 — BLOCKED
- M01 — current milestone
- M12 / P048–P049 — final live acceptance only
