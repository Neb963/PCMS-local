# Definition of Done

## Task/checkpoint

A task checkpoint is complete when:
- intended behavior/contracts are implemented;
- focused tests were actually run;
- relevant docs/schema/API are synchronized;
- diff contains no secrets/debug artifacts/unrelated changes;
- commit is pushed to GitHub;
- progress/claim records identify exact next step.

## Phase

A phase is COMPLETE only when:
1. every phase task is complete or explicitly removed by accepted architecture change;
2. every listed acceptance ID is PASS with required evidence, or explicitly BLOCKED where the phase plan permits deferral;
3. no safety-critical acceptance is falsely replaced by mocks/source inspection;
4. repository verify/lint/typecheck/tests relevant to the phase pass;
5. CI for the phase head is green or every failure is dispositioned as environment/external with evidence;
6. normative docs/contracts reflect implementation;
7. progress report records exact commits, tests, environments, blockers and next READY phase;
8. meaningful work is pushed; no hidden local dependency remains.

P00 specifically cannot close until exact native-source provenance exists and ported hardening tests run in PCMS-local.

## Beta candidate

Requires through P07 with:
- live persistent Chromium Persona;
- protected fail-closed route;
- Account↔Persona binding;
- agent attach;
- provider identity verification;
- safe OperationCoordinator uncertainty;
- Deployer installed/updated as .pcmsmod through public module path.

## Full V1 candidate

Requires product-requirement coverage through P10 plus explicit closure/amendment of generic Workflow/Project/workspace requirements.

## Release

P11 complete; all release-critical B/R/P/A/REC gates actually exercised. No inaccessible live scenario may be reported PASS.

Release artifact includes:
- commit/version;
- Core artifact hash;
- official module hashes;
- router provenance/version;
- migrations/schema;
- CI results;
- live acceptance report;
- known limitations/residual uncertainty.
