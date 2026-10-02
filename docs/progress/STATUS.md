# PCMS-local Status

Baseline: **v0.1 architecture/bootstrap**  
Current completed phase: **P00**  
Next phase: **P01 — READY**

## P00 result

P00 architecture/governance/proven-source bootstrap is complete.

- Exact Product Requirements are repository authority.
- AGENTS contract is self-contained.
- Architecture specs 00–18 and ADR-001..003 are established.
- v0.1 machine-readable plan/policies/ownership/acceptance/DoD are established.
- PersonaMonkey native router baseline + tests are ported byte-identically with exact provenance.
- Repository/provenance/native bootstrap verification runs in GitHub Actions.
- Successful push and pull-request workflow runs proved the deterministic P00 gates.

See `reports/phases/P00.md`.

## P01 — READY

Goal: executable local shell, SQLite and CI foundation.

P01 scope:
- pinned Node/TypeScript workspace;
- pcmsd config/data-root/single-instance base;
- SQLite adapter/migration authority;
- loopback health/readiness/auth bootstrap;
- minimal Web UI;
- CLI typed client/JSON mode;
- user-service/development launch;
- broader hosted CI/package smoke.

P01 must not implement Chromium Persona lifecycle, protected routing or provider mutation ahead of their owning phases.

## Known future live gates

No Chromium/route/provider/agent live behavior is claimed by P00. Those remain explicit B/R/P/A/REC acceptance gates in P03+.
