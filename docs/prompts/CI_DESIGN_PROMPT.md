# Prompt — Design / Redesign PCMS-local GitHub Actions

Use this prompt when assigning an agent to create or materially redesign CI.

Repository: Neb963/PCMS-local

Act as the CI/release engineering owner for PCMS-local.

Read AGENTS.md, ADR-004, architecture 14/15, the canonical v0.1 plan/policies/acceptance matrix, and current workflows before editing.

GitHub Actions usage is UNLIMITED. More importantly, P01–P11 must be closable entirely through deterministic CI/local evidence. Do not introduce real Perchance or Mullvad secrets into CI and do not make MCP a phase gate.

Design from failure modes:
- clean-checkout/toolchain drift;
- SQLite migration/recovery faults;
- module package traversal/bomb/capability/update/rollback faults;
- module-runner crash/stale-generation/IPC faults;
- real Chromium profile/CDP lifecycle faults;
- browser crash/reconnect/profile ownership conflicts;
- provider response loss after emulated committed mutation;
- wrong account/session/slug/provider identity;
- provider rate-limit/challenge/schema/DOM drift;
- router/forwarder/socket loss and accidental Direct fallback;
- DNS/QUIC/WebRTC-sensitive routing assumptions;
- clock/DST/queue/backpressure failures;
- backup/restore/package/release regressions.

Required CI:
1. Verify: repo/spec validation, format/lint/typecheck/unit/native tests.
2. Integration: pcmsd + SQLite + API + module-runner.
3. Chromium: real Chrome for Testing/Chromium, persistent user-data-dirs, isolation, CDP attach/detach, crash/reconnect.
4. Perchance emulator: evidence-backed stateful provider model including error/uncertainty/drift scenarios. It must not be a happy-path stub.
5. Synthetic network: local SOCKS/controlled endpoints and Linux networking fixtures where hosted runners allow them; prove route-or-block/no Direct fallback.
6. Adversarial/recovery: kill processes and inject response/network/time/storage faults systematically.
7. Security: CodeQL/dependency review/archive/path/fuzz/property checks.
8. Packaging: Core + official .pcmsmod artifacts, checksums, SBOM, install/restore smoke, reproducibility where practical.

Use immutable/deliberately pinned actions, least-privilege permissions, concurrency cancellation, safe caches, explicit timeouts and useful failure artifacts.

Do NOT add a credentialed live/self-hosted workflow as a normal gate. Real Perchance/Mullvad/MCP testing belongs to P12 on the operator-controlled local environment after P11 is CI-complete.

If P12 later discovers drift, add the sanitized behavior to emulator/fixture tests and reproduce it in CI before fixing.

Run workflows, inspect actual logs, fix root causes, push coherent checkpoints and update acceptance/progress evidence honestly.
