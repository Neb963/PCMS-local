# Prompt — Design / Redesign PCMS-local GitHub Actions

Use this prompt when assigning an agent to create or materially redesign CI.

```markdown
Repository: Neb963/PCMS-local

Act as the CI/release engineering owner for PCMS-local.

Read AGENTS.md, docs/product/PRODUCT_REQUIREMENTS.md, docs/architecture/14-testing-observability.md, docs/architecture/15-ci-release-engineering.md, docs/implementation/v0.1/plan.json, POLICIES.json, ACCEPTANCE_MATRIX.md, and the current workflows/package scripts before editing.

GitHub Actions usage is UNLIMITED for this repository. Do not optimize around minute scarcity. Optimize for independent confidence, reproducibility, fast diagnosis and coverage of real risk. However, do not create redundant noisy workflows merely because compute is free.

Design from failure modes:
- a PR compiles locally but fails from clean checkout;
- Node/lockfile/toolchain drift;
- TypeScript/schema/lint/test regressions;
- SQLite migration/recovery regressions;
- module archive traversal/bomb/capability/update/rollback regressions;
- module-runner crash/stale-generation/IPC regressions;
- Chromium profile/CDP lifecycle regressions;
- native Python/router/service hardening regressions;
- package/install/release artifact regressions;
- supply-chain/dependency/security regressions;
- release artifact provenance/reproducibility failures.

Required design:
1. Verify workflow on PR and main push: repo/spec JSON validation, format/lint/typecheck, unit tests, Python native tests.
2. Integration workflow: pcmsd + SQLite + API + module-runner and Chrome for Testing/Chromium mechanics where implementation exists.
3. Security workflow: CodeQL/dependency review and project-specific archive/path fuzz/property tests. Least-privilege permissions.
4. Packaging/release workflow: build Core and official .pcmsmod artifacts, checksums, SBOM, install smoke, reproducibility comparison where practical, artifact upload.
5. Native workflow/job: sanitizer/router deterministic tests and systemd-unit assertions.
6. Live/self-hosted workflow_dispatch design for privileged routing and disposable Perchance acceptance. Never expose real secrets to fork/untrusted PR contexts.

Use concurrency cancellation for superseded PR commits, safe dependency caches, explicit job timeouts, useful failure artifacts, and matrices only for materially different risk. Deliberately pin third-party actions, especially release/security paths. Keep workflow permissions minimal.

Do not weaken local testing: CI supplements local focused tests. Do not claim hosted mocks prove route/provider live behavior.

Run/validate the workflows as far as GitHub permits, inspect actual failed job logs, fix root causes, and commit/push coherent checkpoints. Update acceptance/progress docs with what is actually proven.
```
