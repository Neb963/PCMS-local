# PCMS-local Status

Baseline: **v0.1 architecture/bootstrap**  
Current phase: **P00 — IN PROGRESS**  
Branch of architecture bootstrap: `agent/architecture-bootstrap`

## Completed checkpoints

- Product Requirements imported as highest product authority.
- AGENTS contract established.
- Local-control-plane, Chromium Persona and out-of-process updateable-module decisions accepted.
- Core architecture specifications 00–18 written.
- Canonical implementation plan/policies/ownership/acceptance/DoD established.

## P00 remaining

- Port PersonaMonkey native router/sanitizer/systemd baseline with exact provenance.
- Port/adapt native hardening tests and run deterministic tests.
- Add repository verifier/toolchain skeleton.
- Add initial GitHub Actions and validate branch/PR runs.
- Review all P00 diffs/provenance and close P00 only if A00-* gates are satisfied.

## Next phase

P01 becomes READY only after P00 closure.

P01 goal: an executable local pcmsd/SQLite/Web UI/CLI shell with CI and simple development/service launch; it does not yet implement full Personas or provider automation.
