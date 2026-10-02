# 15 — CI, Release Engineering and Supply Chain

## 1. Principle

GitHub Actions is unlimited for this repository. Optimize for confidence and diagnostic quality, not minute conservation. Still avoid redundant work that obscures failures.

Hosted CI never receives real production credentials/browser profiles/WireGuard private keys.

## 2. Required CI families

### verify
Every PR and main push:
- repository/spec/JSON validation;
- formatting/lint/typecheck;
- unit tests;
- Python native tests;
- module schema/package tests.

### integration
Every PR/main push where implementation exists:
- pcmsd + SQLite + HTTP API integration;
- module-runner lifecycle;
- local fixture provider;
- Chromium/Chrome for Testing profile/CDP tests in Linux matrix.

### security
Scheduled + PR-sensitive:
- CodeQL or equivalent supported analysis;
- dependency review on PR;
- secret scanning is GitHub repository configuration where available;
- archive/path fuzz/property tests;
- npm audit/advisory reporting with explicit policy.

### packaging
Main/release:
- build Linux release bundle;
- build official module packages;
- verify install tree;
- reproducibility/digest comparison where practical;
- generate SHA-256 manifest and SBOM;
- upload artifacts.

### native
Linux job:
- sanitizer/router unit tests;
- systemd unit static assertions;
- no real privileged WireGuard on ordinary hosted runner.

### live/self-hosted
Manual/workflow_dispatch only:
- privileged route acceptance on dedicated host;
- real production-like Chromium;
- optional disposable Perchance acceptance.

Secrets use protected environments and never run on untrusted fork PRs.

## 3. Workflow engineering

Use:
- least-privilege `permissions:`;
- concurrency groups with cancel-in-progress for superseded PR commits;
- deterministic pinned toolchain;
- package-manager cache keyed by lockfile;
- explicit timeouts;
- artifacts on failure;
- matrix only for meaningful compatibility dimensions;
- reusable workflows/actions only when they reduce duplication without hiding logic.

Third-party actions should be pinned deliberately, preferably immutable SHA for security-sensitive release paths.

## 4. Branch/release gates

Main should remain green.

Recommended required checks once configured:
- verify;
- unit/integration;
- Chromium acceptance;
- native deterministic tests;
- package build.

Live route/Perchance gates may be release-blocking while manual/self-hosted rather than PR-blocking.

## 5. Release provenance

Release metadata records:
- git commit;
- toolchain versions;
- Core artifact SHA-256;
- each official module artifact SHA-256;
- router source/version;
- SBOM;
- acceptance report references.

## 6. Module releases

Official modules are built independently through the same package schema users install. Their update manifest references exact package digest.

A Core release does not need to rebuild module code merely to update one module.

## 7. CI design review

Before materially expanding/replacing workflows, execute the review prompt in `docs/prompts/CI_DESIGN_PROMPT.md` and record important architecture decisions if CI becomes part of a release/security boundary.
