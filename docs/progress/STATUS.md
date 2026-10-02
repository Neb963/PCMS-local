# PCMS-local Status

Baseline: v0.1 architecture/bootstrap
Current completed phase: P00
Next phase: P01 — READY

## P00 result

P00 architecture/governance/proven-source bootstrap is complete.

- Exact Product Requirements are repository authority.
- AGENTS contract is self-contained.
- Architecture specs 00–18 and ADR-001..004 are established.
- v0.1 machine-readable plan/policies/ownership/acceptance/DoD are established.
- PersonaMonkey native router baseline + tests are ported byte-identically with exact provenance.
- Repository/provenance/native bootstrap verification runs in GitHub Actions.

See reports/phases/P00.md.

## Testing strategy

CI first, live last.

P01–P11 progress without MCP or real external credentials:
- real Chromium/Chrome for Testing for Persona/profile/CDP behavior;
- evidence-backed Perchance emulator for provider behavior;
- synthetic routing/network fixtures for route/fail-closed behavior;
- deterministic/adversarial crash and recovery tests.

No real Perchance credentials/sessions or Mullvad private configuration are required in public GitHub Actions.

P11 produces a CI-complete release candidate.

P12 is the final, small live acceptance phase using the operator-controlled environment:
- MCP interoperability;
- real Mullvad route/fail-closed smoke;
- real Perchance identity/read smoke;
- one disposable real Deployer mutation.

If P12 finds external drift, reproduce it in emulator/fixture CI first; do not turn MCP into the debugging loop.

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
