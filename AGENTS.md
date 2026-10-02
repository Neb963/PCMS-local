# AGENTS.md — Mandatory PCMS-local Implementation Protocol

This file is normative for every AI coding agent, reviewer or automated contributor working in this repository. It is intentionally written so a fresh agent with repository access and no prior conversation can continue safely.

## 1. Mission

Implement PCMS-local exactly **one session-sized roadmap phase at a time**.

The repository deliberately uses small sequential phases because long cloud-agent runs are operationally unreliable. A normal phase is shaped to fit roughly one 20–30 minute competent-agent session, but agents are not assumed to know elapsed time. Scope is bounded structurally by a narrow objective, explicit non-goals, normally at most 3 work items and at most 5 acceptance gates.

Simplicity, recoverability and verified behavior outrank speculative breadth.

## 2. Authority order

When instructions conflict:

1. explicit current user instruction;
2. safety/security constraints;
3. `docs/product/PRODUCT_REQUIREMENTS.md`;
4. accepted ADRs;
5. normative `docs/architecture/` specifications;
6. `docs/implementation/v0.1/plan.json`, `ROADMAP.md`, policies, ownership and acceptance matrix;
7. executable public contracts/schemas;
8. existing implementation/tests;
9. local convenience.

Existing PersonaMonkey, PCMS and PCMS-alt code never overrides PCMS-local authority merely because it already exists.

## 3. Repository access mode

GitHub is the source of truth and durability boundary.

An agent may operate in either mode:

### A. Local Git workspace

Use the repository's normal Git workflow:
- inspect `git status --short --branch`;
- synchronize latest `main` without destroying local/user work;
- branch, commit and push through Git;
- run focused tests locally;
- inspect GitHub Actions after publication.

### B. Cloud / GitHub connector

A local clone is **not required**.

Use the GitHub connector to:
- inspect the latest `main` head and required files;
- create/continue the phase branch;
- create coherent commits directly in GitHub;
- inspect PR/workflow/check results;
- merge only when the phase workflow permits.

Do not pretend to have run `git status`, local commands or local tests when operating only through a connector. In connector mode, focused executable verification may run through GitHub Actions instead.

Both modes obey the same branch, phase, evidence and stop rules.

## 4. Start of every implementation session

1. Determine repository access mode: local Git or GitHub connector.
2. Inspect the latest `main` state and current phase branch, if any.
3. Read this file completely.
4. Read `README.md`.
5. Read `ROADMAP.md`.
6. Read `docs/progress/STATUS.md`.
7. Read `docs/implementation/v0.1/plan.json`.
8. Confirm there is exactly one phase whose status is `READY` or `IN_PROGRESS`.
9. Read that phase's objective, non-goals, tasks, acceptance IDs and linked architecture specs.
10. Read the immediately preceding phase report when one exists.
11. Read relevant ADRs and cross-cutting specs for the current phase.
12. Implement **only that phase**.

If zero phases are READY/IN_PROGRESS, stop and report the blocking state.

If more than one phase is READY/IN_PROGRESS, stop: repository execution state is invalid and must be repaired before implementation.

Never select a later phase merely because it is interesting or independently implementable.

## 5. Milestones, phases and tasks

The hierarchy is:

```text
Milestone  = planning/grouping boundary
Phase      = one bounded agent implementation session
Task       = checkpoint inside that phase
Acceptance = evidence required to close that phase
```

Milestones do not authorize implementation by themselves. An instruction such as "implement M04" must be resolved to the single active phase within M04.

Normal phase limits:
- one coherent objective;
- explicit non-goals;
- at most 3 work items;
- at most 5 acceptance IDs;
- one primary implementation concern;
- focused tests plus applicable regression tests.

A phase may exceed those limits only with an explicit `sizeException` in `plan.json`. P000 is the historical bootstrap exception.

## 6. One-phase-at-a-time invariant

Exactly one phase globally may be `READY` or `IN_PROGRESS`.

You MUST NOT:
- start the successor phase after completing the current phase;
- work on a second phase in parallel;
- mark multiple future phases READY;
- pull work forward from later phases for convenience;
- implement speculative abstractions needed only by later phases;
- broaden the phase because adjacent work seems easy.

After the current phase is complete:
1. finish all current phase tasks;
2. run required focused/regression tests;
3. obtain required GitHub Actions evidence;
4. finalize `reports/phases/Pxxx.md`;
5. mark current phase `COMPLETE`;
6. mark **only its immediate successor** `READY` if dependencies are satisfied;
7. update `ROADMAP.md`, `plan.json` and `docs/progress/STATUS.md`;
8. publish the closure commit;
9. **STOP**.

Do not implement even the first task of the new READY phase in the same session.

## 7. What to do when a phase is too large

Agents are not time-aware, so do not use a timer as the control mechanism.

If implementation evidence shows the current phase is materially larger than the intended session-sized unit:
- stop at the earliest coherent recoverable checkpoint;
- do not rush or omit tests to "finish the phase";
- split the remaining scope into one or more successor session phases;
- preserve existing milestone ownership and acceptance semantics;
- keep exactly one active phase;
- update plan/roadmap/acceptance ownership and repository verification;
- publish the planning correction before continuing implementation.

Do not silently turn one phase into a multi-hour task.

## 8. Task execution and progress marking

Tasks are executed in listed order unless the phase explicitly states otherwise.

ROADMAP task states:
- `[ ]` TODO
- `[~]` IN PROGRESS
- `[x]` COMPLETE
- `[!]` BLOCKED
- `[-]` SUPERSEDED

At most one task in the active phase may be `[~]`.

For each task:
1. mark the phase/task active in roadmap/status records;
2. implement the smallest coherent slice;
3. add/update tests;
4. run the narrowest useful verification available in the current access mode;
5. fix failures rather than deferring them without evidence;
6. mark the task complete and record deviations if any;
7. review the diff/change set;
8. commit and publish the checkpoint to GitHub;
9. continue only with the next task in the **same phase**.

If a task is blocked, record exact evidence and whether the whole phase can continue safely. Never jump to a later phase to stay busy.

## 9. Git and publication discipline

Unpublished valuable work is considered at risk.

- Start from latest `main`.
- Normal phase branch: `agent/<agent-id>/pNNN`.
- One branch should normally contain one active phase.
- Commit after each completed roadmap task or coherent working checkpoint.
- Publish each meaningful checkpoint promptly.
- Before risky migrations/refactors, publish a recoverable checkpoint first.
- Before handoff/session end, publish all valuable work.
- WIP commits are acceptable when needed for recoverability.
- Never force-push shared published history without explicit authorization.
- Never overwrite/discard user or another agent's changes.
- Never commit secrets, real browser profiles, cookies, credentials or WireGuard private material.

Connector-created commits are first-class Git commits; direct local `git push` is not a requirement when the agent operates through GitHub APIs/connectors.

## 10. Phase report

Every completed phase has `reports/phases/Pxxx.md`:

```markdown
# Pxxx — <name>
Status: COMPLETE | BLOCKED | PARTIAL
Milestone:
Start SHA:
End SHA:
Date:
Execution mode: local-git | github-connector | mixed

## Objective
## Implemented
## Acceptance gates
## Verification actually run
## CI evidence
## Deviations / ADRs
## Known issues / unknowns
## Next-phase readiness
```

Reports record evidence; they are not a second roadmap.

A COMPLETE report must never claim a test was run when it was not.

## 11. Scope containment

Do not:
- silently change architecture to simplify implementation;
- resurrect old PCMS architecture unless current specs require it;
- convert module-local policy into Core merely for convenience;
- add a framework/library without a concrete current-phase need;
- leave TODO/FIXME placeholders in completed phase scope;
- use later-phase requirements as justification for speculative code now.

If architecture is contradicted by implementation evidence, document the contradiction and amend the ADR/spec/roadmap before proceeding.

## 12. Architecture invariants agents may not bypass

- Persona UID is durable product identity; browser PID/profile path/debug port/proxy port are runtime details.
- One ACTIVE Account is bound to at most one active Persona, and one Persona is not shared by multiple ACTIVE Accounts except through explicit audited rebind.
- Human use and automation operate the same persistent Persona.
- Protected routing uses the assigned route or blocks; Direct is explicit and never fallback.
- Core authoritative state lives in SQLite; UI/browser/provider/module processes are not Core truth.
- Browser/provider-specific behavior is behind typed adapters.
- Mutable provider names/slugs are not durable identity where stable provider identity exists.
- Uncertain external mutation is represented as uncertain and reconciled before automatic retry.
- Modules cannot use supported interfaces to mutate Core DB/router/Chromium directly.
- Module runtime code never executes inside `pcmsd`.
- Candidate module failure cannot destroy last-known-good package/state.
- Secrets are not ordinary domain/module/log/event payloads.
- Human challenge handling is first-class; CAPTCHA bypass is not a goal.
- Browser/agent attachment is non-destructive.

Violating an invariant requires an explicit architecture/product decision.

## 13. Core versus module boundary

Core owns cross-cutting mechanisms and foundational entities:
- Accounts, Personas, Routes, Generator identity;
- authoritative storage/migrations;
- Browser Manager;
- Route Manager;
- Operation Coordinator;
- bounded scheduling/admission;
- Human Tasks;
- Module Manager/SDK;
- backup/restore;
- local API/auth/search/diagnostics.

Feature policy remains updateable modules:
- Deployer;
- Refresher;
- Explorer;
- Account Provisioning;
- Statistics;
- future independent features.

## 14. Module trust model

Installed modules are operator-trusted same-user executable code. The process boundary provides lifecycle isolation, crash containment and stable interfaces; it is not a malicious-code sandbox.

Module code receives no supported raw SQLite/router/process-manager/secret-store/CDP authority. If hostile third-party modules become a requirement, design a real isolation boundary rather than overstating this one.

## 15. External-effect doctrine

Before any provider mutation:
1. resolve stable target identity;
2. persist durable operation identity;
3. freshly verify Persona/Account/session/route prerequisites;
4. claim the target;
5. persist desired/provenance evidence;
6. perform the remote effect;
7. verify outcome;
8. persist terminal local result.

If browser/process/network disappears after a side effect may have occurred, transition to `UNCERTAIN`. Never blindly retry.

## 16. Porting doctrine

Port only code that still solves a current requirement, lowers risk and fits the new architecture. Record exact source repo/commit/blob and retained tests.

Do not port Firefox contextual identity/runtime, Firefox proxy hooks, old extension storage, cross-extension transports, or generic workflow/event/lock frameworks merely because they exist.

## 17. Testing — CI first, live last

P001–P047 MUST be closable without MCP, real Perchance credentials/sessions, real Mullvad credentials/configs or Cloudflare availability.

Use:
- unit/property/fuzz tests;
- real SQLite/files/processes;
- real Chromium/Chrome for Testing for profile/CDP/browser mechanics;
- evidence-backed Perchance emulator;
- synthetic SOCKS/WireGuard/network fixtures;
- aggressive deterministic fault injection/recovery tests.

P048–P049 are the only normal live-system phases.

Emulated/synthetic evidence never proves current external compatibility. If final live acceptance finds drift, encode the observation into emulator/fixture regression coverage and fix through CI before repeating the narrow live test.

In local mode, run focused tests locally plus applicable Actions. In connector-only mode, use GitHub Actions or another actually available executable verifier; do not fabricate local test results.

## 18. GitHub Actions

Actions usage is **not budget-constrained**. Optimize for independent confidence, reproducibility and diagnosis.

- keep jobs cohesive;
- cancel superseded PR runs;
- pin/deliberately version third-party actions;
- use least-privilege permissions;
- keep public-repo CI free of real Perchance/Mullvad/browser-session secrets;
- use emulator/synthetic fixtures for phase gates;
- upload useful failure artifacts;
- require checksums/provenance where practical.

Read `docs/prompts/CI_DESIGN_PROMPT.md` before material workflow redesign.

## 19. Day-2 operability

Errors should state what failed, affected identity/operation, whether remote state may have changed, whether retry is safe and the available operator action.

Use bounded queues/retries/history, structured correlated logs and secret redaction. One poison Persona/module must not make the control plane unusable.

## 20. Stop conditions

Stop rather than guess when:
- roadmap execution state has zero or multiple active phases unexpectedly;
- product/architecture invariants conflict;
- a migration can lose authoritative state;
- a remote mutation cannot be reconciled safely;
- protected routing cannot be fail-closed;
- browser identity cannot be distinguished safely;
- an update would destroy last-known-good module/runtime;
- required secret handling would persist plaintext;
- the current phase is demonstrably oversized and needs structural splitting.

Tooling inconvenience alone is not a reason to skip verification or jump phases.
