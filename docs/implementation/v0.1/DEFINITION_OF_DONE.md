# Definition of Done

## Task/checkpoint

A task checkpoint is complete when:
- intended behavior/contracts are implemented;
- focused tests were actually run;
- relevant docs/schema/API are synchronized;
- diff contains no secrets/debug artifacts/unrelated changes;
- commit is pushed to GitHub;
- progress/claim records identify exact next step.

## Implementation phase P01–P11

A phase is COMPLETE when:
1. every owned task is complete or explicitly removed by accepted architecture change;
2. every listed acceptance ID is PASS using its required U/I/B/E/N/REC evidence;
3. emulator/synthetic tests exercise both success and relevant failure/uncertainty paths;
4. repository verify/lint/typecheck/tests relevant to the phase pass;
5. CI for the phase head is green or every infrastructure failure is precisely dispositioned;
6. normative docs/contracts match behavior;
7. progress report records exact commits/tests/environments/assumptions and next READY phase;
8. meaningful work is pushed and no hidden local dependency remains.

MCP, real Perchance, real Mullvad credentials/routes and Cloudflare reachability are not phase gates for P01–P11. Their absence must not block implementation progress.

Do not claim that emulator/synthetic evidence proves current external-system compatibility.

P00 additionally required exact port provenance/native baseline evidence and is already complete.

## Beta / development milestones

A CI-complete development beta may be produced after the relevant feature phases without MCP/live-provider testing, provided it is labelled as not yet live-accepted.

Through P07 the system should already prove in CI:
- persistent real Chromium Personas;
- synthetic protected fail-closed routing;
- Account↔Persona binding;
- generic DevTools attach/detach;
- Perchance emulator identity/provider semantics;
- OperationCoordinator uncertainty/reconciliation;
- Deployer installed/updated as a real .pcmsmod.

## Full V1 implementation candidate

P10 closes product feature coverage, subject to the explicit Workflow/Project/workspace gap decision.

## Release candidate

P11 complete means CI-complete release candidate:
- deterministic/adversarial tests green;
- real Chromium acceptance green;
- Perchance emulator contract green;
- synthetic routing/fail-closed matrix green;
- packaging/install/restore/security gates green.

It still does not claim current real Perchance/Mullvad/MCP compatibility.

## Final release

P12 is the only normal live-system phase.

Release requires A12-01..A12-05:
- minimal MCP attach/detach/Persona identity smoke;
- real Mullvad protected-route/fail-closed smoke;
- real Perchance session/read compatibility;
- one disposable real Deployer mutation independently verified.

If live behavior differs from the emulator, first reproduce/update it in deterministic CI, fix there, then rerun the narrow live scenario.

No inaccessible live scenario may be reported PASS.

Release provenance includes:
- commit/version;
- Core artifact hash;
- official module hashes;
- router provenance/version;
- emulator/provider-contract version;
- migrations/schema;
- CI results;
- final P12 live report;
- known limitations/residual uncertainty.
