# 14 — Testing and Observability

## 1. Evidence classes

- U: unit/deterministic;
- I: local integration;
- B: real Chromium browser acceptance;
- R: real route/network acceptance;
- P: real Perchance/provider acceptance;
- A: agent-attachment acceptance;
- REC: adversarial recovery.

Do not substitute U/I mocks for B/R/P/A claims.

## 2. Unit

Cover:
- schemas/validation;
- SQLite repositories/constraints/migrations;
- operation state machine;
- scheduling/time semantics;
- module manifest/capability delta;
- archive safety;
- provider parsers/fixtures;
- path validation/redaction.

## 3. Integration

Run real local components without external provider where possible:
- pcmsd HTTP/API;
- SQLite;
- module-runner IPC/crash/update;
- Chromium launch against local fixture web server;
- browser reconnect/crash;
- backup/restore staging.

## 4. Browser acceptance

Real supported Chromium:
- Persona creation/open/close/reopen persistence;
- two profiles isolate cookie/localStorage/IndexedDB;
- multiple active Personas;
- DevTools attach/detach non-destructive;
- browser crash/reconnect;
- profile ownership conflict;
- manual + automation same session.

Chrome for Testing is suitable for deterministic CI browser mechanics; acceptance against the operator-selected production Chromium binary remains required before release support claims.

## 5. Routing acceptance

On Linux host/self-hosted runner with required privileges/config:
- daemon start/stop/restart;
- WireGuard handshake/base SOCKS;
- Chromium protected egress;
- DNS/QUIC/WebRTC tests;
- route-loss no direct fallback;
- route switch;
- Direct explicit;
- Block mode;
- multiple Persona exits.

Do not put real Mullvad private configs in GitHub-hosted CI.

## 6. Provider acceptance

Disposable/test Perchance state:
- session identity;
- read-only generator/listing discovery;
- save/update verification;
- response loss/reconciliation;
- provider drift;
- wrong-account protection;
- human challenge continuation where naturally encountered.

Mutating acceptance records cleanup and affected test entities.

## 7. Module acceptance

- install local package;
- download/update exact hash;
- capability expansion approval;
- candidate migration fail leaves old active;
- crash isolation;
- stale runtime generation rejected;
- disable/re-enable;
- rollback;
- package bomb/traversal rejection.

Official Deployer/Refresher packages must pass this same path.

## 8. Recovery/adversarial

Release matrix includes:
- pcmsd SIGKILL during operation phases;
- Chromium crash before/after possible mutation;
- module crash/update/disable mid-operation;
- router loss;
- DB busy/disk-full/corrupt backup;
- clock rollback/forward/DST;
- duplicate API request;
- queue flood;
- provider rate-limit signal across modules;
- restore with unresolved operations;
- profile missing/corrupt;
- 50+ dormant Persona inventory and bounded active subset.

## 9. Structured logging

Log record minimum:
- timestamp/level/component;
- operationId/requestId where applicable;
- personaUid/accountId/generatorLocalId/moduleId safe IDs;
- event code;
- bounded safe fields.

No secret payloads.

## 10. Metrics/diagnostics

Local diagnostics expose:
- pcmsd uptime/version/schema;
- DB size/health;
- running Personas/process health;
- route health/evidence age;
- module versions/runtime generations/restarts;
- queue depths/rejections;
- unresolved/uncertain operations oldest age;
- provider cooldown/circuit state;
- HumanTasks;
- backup age/status;
- recent structured failures.

No external telemetry by default.

## 11. Support bundle

Generate explicit operator-approved redacted support bundle:
- versions/config summary;
- safe logs;
- module manifests/hashes;
- diagnostics;
- selected sanitized screenshots/fixtures only with confirmation.

Never include browser profiles or secrets by default.
