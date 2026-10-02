# Definition of Done

## Task / checkpoint

A task checkpoint is complete when:
- intended current-phase behavior/contracts are implemented;
- focused tests actually available to the agent were run;
- relevant docs/schema/API are synchronized;
- changes contain no secrets/debug artifacts/unrelated work;
- the checkpoint is published to GitHub;
- ROADMAP progress identifies the exact next task in the same phase.

Local-shell verification is not mandatory for connector-only agents; fabricated local execution is forbidden.

## Session-sized implementation phase P001–P047

A phase is COMPLETE only when:
1. every owned roadmap task is complete or explicitly superseded by an accepted plan change;
2. every listed acceptance ID is PASS using its required U/I/B/E/N/REC evidence;
3. relevant failure/uncertainty paths are covered, not only the happy path;
4. repository verification and applicable tests pass;
5. required GitHub Actions for the phase head are green, or an infrastructure failure is precisely dispositioned;
6. normative docs/contracts match implementation;
7. `reports/phases/Pxxx.md` records exact commits, verification, evidence and deviations;
8. current phase is marked COMPLETE in plan/roadmap;
9. only the immediate successor is marked READY;
10. closure state is published to GitHub;
11. the implementing agent **STOPS without starting the successor**.

MCP, real Perchance, real Mullvad credentials/routes and Cloudflare reachability are not gates for P001–P047.

## Phase-size rule

Normal phases have at most 3 work items and at most 5 acceptance IDs. The empirical design target is roughly 20–30 minutes of competent cloud-agent work, but agents must not depend on time awareness.

If a phase proves materially oversized, split remaining scope before continuing rather than skipping verification or running indefinitely.

P000 is the historical bootstrap size exception.

## Milestone completion

A milestone is complete when every constituent phase is COMPLETE and any milestone-level integration evidence specified by its final phase is green.

Milestone completion never authorizes the same agent to start the next milestone automatically; the phase stop rule still applies.

## CI-complete release candidate

P047 complete means:
- deterministic/adversarial tests green;
- real Chromium acceptance green;
- Perchance emulator contract green;
- synthetic routing/fail-closed matrix green;
- packaging/install/restore/security gates green;
- residual external assumptions are explicitly recorded.

It does not claim current real Perchance/Mullvad/MCP compatibility.

## Final live acceptance

P048–P049 are the only normal live-system phases.

Final release requires:
- P048: MCP attach/detach/Persona distinction and real Mullvad route/fail-closed smoke;
- P049: real Perchance identity/read compatibility plus one disposable independently verified Deployer mutation.

If live behavior differs from the emulator, first reproduce/update it in deterministic CI, fix there, then rerun the narrow live scenario.

No inaccessible live scenario may be reported PASS.

Release provenance includes commit/version, Core/module hashes, router provenance, emulator/provider-contract version, migrations/schema, CI results, P048/P049 reports and known residual uncertainty.
