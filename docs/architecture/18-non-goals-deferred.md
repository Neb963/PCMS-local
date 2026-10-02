# 18 — Non-Goals and Deferred Capabilities

This document prevents attractive but nonessential work from delaying the first useful PCMS-local release.

## Foundation non-goals

- Firefox runtime/containers/extension compatibility;
- Chrome extension helper unless CDP demonstrably cannot meet a required operation;
- Electron/Tauri desktop shell;
- cloud sync/backend;
- multi-user/RBAC;
- Kubernetes/containers for deployment;
- PostgreSQL/Redis;
- distributed locks;
- event sourcing/global Event Journal;
- generic workflow graph engine;
- arbitrary provider plugin marketplace;
- untrusted module sandbox;
- automatic CAPTCHA solving;
- full browser-profile version migration across arbitrary Chromium releases;
- remote DevTools exposure.

## Deferred pending evidence

### Kernel network namespace isolation
Reopen only if Chromium fail-closed acceptance exposes relevant proxy bypass or threat model requires stronger same-user/process separation.

### Module package signatures
Add when there is a publisher/distribution authenticity requirement. Exact hashes remain mandatory now.

### Generic Workflow engine
Extract from concrete flows after shared semantics are demonstrated.

### External MCP server
Add after stable API/CLI; do not create a second authority path.

### Electron/Tauri
Only if local-web UI cannot satisfy desktop integration/usability requirements.

### Incremental browser-profile backup
Only after storage size/frequency makes full optional snapshots impractical.

### Cross-platform support
Architecture avoids gratuitous Linux coupling in domain layers, but Fedora/Linux is V1. Windows/macOS ports are not release blockers.

## Reopening rule

A deferred item requires:
- concrete user/product requirement;
- observed limitation of current simpler design;
- ADR describing operational cost and migration.
