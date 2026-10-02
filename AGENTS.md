# AGENTS.md — Mandatory PCMS-local Agent Contract

This file is normative for every AI coding agent, reviewer or automated contributor working in this repository.

## 1. Mission

Implement PCMS-local as the simplest reliably testable local control plane satisfying the product requirements. Prefer working vertical slices over framework-building. Preserve correctness where remote provider effects, browser identity or routing can create irreversible ambiguity.

## 2. Authority order

When instructions conflict, use this precedence:

1. explicit current user instruction;
2. safety/security constraints;
3. `docs/product/PRODUCT_REQUIREMENTS.md`;
4. accepted ADRs;
5. normative `docs/architecture/` specifications;
6. `docs/implementation/v0.1/plan.json`, policies, requirement ownership and acceptance matrix;
7. executable public contracts/schemas;
8. existing implementation/tests;
9. local convenience.

Existing PersonaMonkey, PCMS and PCMS-alt code never overrides PCMS-local product or architecture authority merely because it is already implemented.

## 3. Mandatory reading before meaningful changes

Read:
- this file;
- `docs/product/PRODUCT_REQUIREMENTS.md`;
- `docs/architecture/00-principles-scope.md`;
- `docs/architecture/01-system-architecture.md`;
- the architecture specs owned by the current phase/task;
- `docs/implementation/v0.1/plan.json`;
- `docs/implementation/v0.1/POLICIES.json`;
- `docs/implementation/v0.1/REQUIREMENT_OWNERSHIP.json`;
- `docs/implementation/v0.1/ACCEPTANCE_MATRIX.md`;
- relevant accepted ADRs;
- the latest phase/progress/handoff record.

Before changing ported routing code, read `PORTING_PROVENANCE.md` and the routing specification.

## 4. First-principles implementation rule

Before adding a subsystem, state:
- the product invariant it protects;
- the observed failure mode if it is absent;
- why the responsibility belongs in Core or a module;
- the smallest mechanism that satisfies it;
- the Day-2 operational cost.

Do not recreate an abstraction from older PCMS merely because it once existed.

## 5. Architecture invariants agents may not bypass

- Persona UID is durable product identity; browser PID/profile path/debug port/proxy port are runtime implementation details.
- One ACTIVE Account is bound to at most one active Persona, and one Persona is not shared by multiple ACTIVE Accounts except through an explicit audited rebind.
- Human use and automation operate the same persistent Persona.
- Protected routing uses the assigned route or blocks; Direct is explicit and never fallback.
- Core authoritative state lives in SQLite; UI, browser state, provider state and module processes are not Core truth.
- Browser/provider-specific behavior is behind typed adapters.
- Mutable provider names/slugs are not durable entity identity when a stable provider identity is available.
- Uncertain external mutation is represented as uncertain and reconciled before automatic retry.
- Module packages are updateable independently, but cannot mutate the Core database, router socket or Chromium processes directly through supported interfaces.
- Module runtime code never executes inside `pcmsd`.
- A module update cannot destroy the last known-good installed package/state before candidate validation.
- Secrets are not ordinary domain/module/log/event payloads.
- Human challenge handling is first-class; CAPTCHA bypass is not a product goal.
- Browser/agent attachment must be non-destructive to the persistent Persona.

Any change violating an invariant requires an explicit ADR/product decision.

## 6. Core versus module rule

Core owns only cross-cutting mechanisms and foundational entities:
- Accounts, Personas, Routes, Generator identity;
- authoritative storage/migrations;
- Browser Manager;
- Route Manager;
- Operation Coordinator;
- bounded scheduling/work admission;
- Human Tasks;
- Module Manager/SDK boundary;
- backup/restore;
- local API, auth boundary, search primitives, diagnostics.

Feature policy belongs in updateable modules:
- Deployer;
- Refresher / refresh measurement;
- Explorer;
- Account Provisioning;
- Statistics;
- future independent features.

A feature does not move into Core merely because calling Core would be convenient.

## 7. Module trust model

Installed modules are operator-trusted executable code, not hostile-code sandboxes. The process boundary exists for lifecycle isolation, crash containment and stable interfaces.

Do not claim that a same-user Node child process is a security sandbox. Module code still receives no supported raw SQLite, routerd, process-manager, secret-store or CDP authority; capabilities flow through typed Core RPC.

If untrusted third-party modules become a requirement, add an explicit isolation design rather than overstating the current boundary.

## 8. Git discipline

GitHub is the source of truth.

- Start from latest `main`.
- Work on `agent/<agent-id>/p<phase>-<task>` unless assigned as integration owner.
- Never overwrite/discard user or another agent changes.
- Make small coherent commits using `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- Push every meaningful checkpoint.
- Inspect diffs before committing.
- Never commit secrets, real browser profiles, WireGuard private material, cookies or credentials.
- Never rewrite published shared history without explicit authorization.

Maximum unpushed work: 20 minutes, 250 changed lines, or one acceptance slice, whichever comes first. If necessary, push a clearly labelled `wip:` checkpoint rather than lose work.

## 9. Development discipline

Use:

```text
inspect → understand → change → test → review diff → commit → push → continue
```

For bugs, find root cause and add regression coverage when practical. Keep documentation/contracts synchronized with behavior.

Do not leave required behavior as TODO/FIXME placeholders in merged production paths.

## 10. External-effect doctrine

Before any provider mutation:
1. resolve stable target identity;
2. establish/record durable operation identity;
3. verify Persona/Account/session/route prerequisites freshly enough for the operation;
4. claim the mutation target;
5. persist desired/provenance evidence;
6. perform the remote effect;
7. verify outcome;
8. commit terminal local result.

If the process/browser/network disappears after a side effect may have occurred, transition to `UNCERTAIN`. Do not blindly retry.

## 11. Porting doctrine

Port source only when one of these is true:
- it already solves a still-valid PCMS-local requirement and has meaningful tests/evidence;
- preserving the exact implementation materially lowers risk;
- the source can be isolated behind the new architecture.

Every port records source repository, source commit/blob, modifications and retained tests.

Do not port:
- Firefox contextual identity code;
- Firefox `userScripts`/sandbox runtime;
- cross-extension Integration API transport;
- extension IndexedDB/storage infrastructure;
- Firefox proxy hooks;
- old generic workflow/event/lock frameworks.

## 12. Testing

Every behavior change needs the narrowest useful automated test plus applicable acceptance IDs.

Run locally where available:
- formatting/lint;
- typecheck;
- unit tests;
- Python native tests;
- repository/spec verification;
- focused integration tests.

Live acceptance is required for claims about Chromium profile persistence, browser automation, route fail-closed behavior, Perchance mutations and agent attachment. Mocks/fixtures do not prove those behaviors.

## 13. GitHub Actions — unlimited but engineered

Actions usage is **not budget-constrained** in this repository. Use CI aggressively where it improves coverage, reproducibility, platform/version matrices, packaging, security scanning and independent verification.

Still design workflows intentionally:
- keep jobs cohesive and diagnostically useful;
- use concurrency cancellation for superseded PR runs;
- cache dependencies safely;
- upload failing-test/release artifacts when useful;
- matrix only dimensions with distinct risk;
- pin or deliberately version third-party actions;
- grant least-privilege workflow permissions;
- never expose provider/browser credentials to untrusted PRs;
- separate deterministic hosted-CI gates from live/self-hosted acceptance;
- require release artifacts to be reproducible/checksummed where practical.

CI supplements, rather than replaces, local focused testing.

Read `docs/prompts/CI_DESIGN_PROMPT.md` before major workflow redesign.

## 14. Observability and Day-2 operation

Errors shown to operators must answer:
- what failed;
- which Account/Persona/Generator/operation is affected;
- whether remote state may have changed;
- whether retry is safe;
- what action is available.

Use structured logs with operation/persona/module correlation and secret redaction. Bound queues, history and retry loops. A single poison module or Persona must not make the control plane unusable.

## 15. Stop conditions

Stop and escalate rather than guess when:
- a product/architecture invariant is contradictory;
- a remote mutation cannot be reconciled safely;
- protected routing cannot be made fail-closed for the supported runtime;
- browser identity cannot be distinguished safely before a sensitive action;
- a migration can lose authoritative state;
- an update would destroy the last known-good module/runtime;
- required secret handling would persist plaintext in ordinary state/logs.

Tooling difficulty is not itself a stop condition. Prefer deterministic work and explicit live-acceptance gaps.
