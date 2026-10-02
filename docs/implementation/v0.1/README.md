# PCMS-local Implementation Authority v0.1

This directory is the implementation authority beneath the Product Requirements, accepted ADRs and architecture specifications.

## Canonical files

1. `plan.json` — sole manually authoritative phase/dependency/status plan.
2. `POLICIES.json` — machine-readable cross-cutting policy.
3. `REQUIREMENT_OWNERSHIP.json` — requirement/spec/phase/code ownership.
4. `ACCEPTANCE_MATRIX.md` — release/phase gates and evidence class.
5. `SPEC_TRACEABILITY.md` — human-readable product→architecture→phase mapping.
6. `DEFINITION_OF_DONE.md` — phase/release completion rules.

`docs/progress/STATUS.md` is the current human status view and must match `plan.json`.

## Execution rule

A fresh implementation agent should be able to receive:

> Implement the next READY phase.

The agent reads `AGENTS.md`, this directory, relevant architecture specs and progress records, creates a task claim/branch, implements only that phase, tests, pushes checkpoints and stops after phase closure.

## Current phase

P00 — Architecture, governance and proven-source bootstrap.

P00 is not complete until the ported router provenance/tests and first repository/CI gates exist and are verified.
