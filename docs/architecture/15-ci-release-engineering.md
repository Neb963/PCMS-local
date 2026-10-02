# 15 — CI, Release Engineering and Supply Chain

## 1. Principle

GitHub Actions is the primary engineering acceptance environment and Actions usage is not budget-constrained for this repository.

Optimize for confidence, fault coverage, reproducibility and diagnosis.

Public-repository CI is secret-free by design. It does not need real Perchance credentials/sessions, Mullvad account secrets, WireGuard private configurations or personal browser profiles.

Real external-system acceptance occurs only in P048–P049 through the operator-controlled local environment/MCP.

## 2. Required CI families

### verify
Every PR and main push:
- repository/spec/JSON validation;
- formatting/lint/typecheck;
- unit tests;
- Python native tests;
- module schemas/packages;
- port provenance checks.

### integration
Every PR/main push:
- pcmsd + SQLite + API;
- module-runner lifecycle;
- Perchance emulator;
- real Chrome for Testing/Chromium profile/CDP behavior;
- synthetic routing/network fixtures;
- backup/recovery.

### adversarial
PR/main/nightly according to runtime cost:
- process kill/restart matrices;
- response-loss-after-side-effect emulator cases;
- timeout/socket/network faults;
- stale runtime generation;
- rate-limit/provider-drift scenarios;
- queue/backpressure floods;
- clock/DST cases;
- archive/path fuzz/property tests;
- recovery from interrupted operations.

### security
- CodeQL or equivalent;
- dependency review;
- repository secret scanning/config where available;
- archive/path/property tests;
- npm advisory reporting with explicit policy;
- permissions/action-pin verification.

### packaging
Main/release-candidate:
- build Core release bundle;
- build official module packages;
- install-tree smoke;
- checksums;
- SBOM;
- reproducibility comparison where practical;
- fresh-install/restore fixture.

### native/network
Linux jobs:
- ported router/sanitizer tests;
- systemd-unit static assertions;
- synthetic SOCKS/WireGuard/network fixtures where hosted-runner capabilities allow;
- Chromium protected-route tests against controlled local exits.

No real Mullvad credential is needed.

## 3. Perchance emulator as CI infrastructure

The emulator is versioned with PCMS-local.

Changes to Perchance-dependent behavior must normally include one or more of:
- sanitized fixture update;
- emulator scenario update;
- adapter regression test.

The emulator intentionally models failures and ambiguity, not just successful requests.

An implementation that passes only the happy-path emulator is incomplete.

## 4. Workflow engineering

Use:
- least-privilege workflow permissions;
- immutable/deliberately pinned Actions;
- concurrency cancellation for superseded PR commits;
- deterministic pinned toolchain;
- dependency caches keyed by lockfile;
- explicit timeouts;
- useful failure artifacts;
- matrices only for distinct risk;
- reusable workflows where they clarify rather than hide behavior.

Because CI contains no real provider/VPN secrets, fork/PR safety is substantially simpler. Still treat GITHUB_TOKEN permissions and artifact contents carefully.

## 5. Phase gates

P001–P047 may become COMPLETE solely from U/I/B/E/N/REC evidence.

No phase through P047 may be blocked merely because:
- MCP is unavailable;
- real Perchance is behind Cloudflare;
- a real Perchance account/session is unavailable;
- Mullvad credentials/config are unavailable;
- a real external provider is temporarily down.

A phase remains blocked if its deterministic/emulated acceptance is incomplete.

## 6. Release candidate versus release

P047 produces a CI-complete release candidate.

It does not claim current real Perchance/Mullvad/MCP compatibility.

P048–P049 then runs the minimal final live acceptance defined in the acceptance matrix. Only after P048–P049 can a release claim supported real-system compatibility.

## 7. Release provenance

Record:
- git commit;
- toolchain/browser versions;
- Core artifact hash;
- official module hashes;
- router source/version;
- emulator/provider-contract version/fixtures;
- SBOM;
- CI acceptance;
- P048–P049 live report for a real release.

## 8. Module releases

Official modules are built independently through the same .pcmsmod path users install.

Module-only updates can be fully CI-tested against emulator/network fixtures. A module that changes Perchance assumptions may require a targeted P048–P049-compatible live check before declaring current-provider compatibility, but does not force unrelated implementation phases to reopen.

## 9. CI design review

Use docs/prompts/CI_DESIGN_PROMPT.md before material CI redesign.
