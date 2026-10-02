# 14 — Testing and Observability

## 1. Testing doctrine: CI first, live last

PCMS-local development must not depend on repeated MCP/manual testing.

P01–P11 are deterministic/automated phases. They can complete using GitHub Actions, local deterministic tests, real Chromium automation, a Perchance emulator, and synthetic routing/network fixtures.

P12 is the only normal live-system acceptance phase. It validates a small number of end-to-end scenarios against real Perchance, real Mullvad routing and MCP after the implementation is otherwise release-candidate complete.

This split is deliberate:
- browser/process/storage mechanics are locally controllable and should be tested exhaustively;
- Perchance/Cloudflare and Mullvad are external systems with nondeterminism and credential complexity;
- live testing is expensive and poor for combinatorial fault injection;
- emulator/synthetic tests are reproducible but cannot prove current external compatibility.

## 2. Evidence classes

- U — unit/deterministic;
- I — local integration;
- B — real Chromium/Chrome for Testing, controlled automatically without MCP;
- E — Perchance emulator/contract fixture;
- N — synthetic network/routing fixture;
- REC — adversarial crash/recovery/fault injection;
- L — final live-system acceptance: real Perchance/Mullvad and/or MCP.

P01–P11 acceptance may use U/I/B/E/N/REC.

L evidence is reserved for P12 and is not a prerequisite for advancing through implementation phases.

Never relabel E/N evidence as real Perchance/Mullvad evidence.

## 3. Unit and deterministic tests

Cover:
- schemas/validation;
- SQLite repositories/constraints/migrations;
- operation state machines;
- scheduling/time semantics;
- module manifest/capability delta;
- archive/path safety;
- provider parsers and recorded fixtures;
- redaction;
- retry/uncertainty rules;
- deterministic property/fuzz tests where valuable.

## 4. Local integration

Run real local components:
- pcmsd HTTP/API;
- SQLite;
- module-runner IPC/crash/update;
- browser lifecycle against local fixture servers;
- backup/restore staging;
- child-process death/restart;
- Unix/TCP socket behavior;
- filesystem permission/path cases.

Prefer real processes and files over mocks whenever the boundary is locally controllable.

## 5. Real Chromium in CI

Browser mechanics use real Chrome for Testing/Chromium under Actions:
- Persona create/open/close/reopen persistence;
- cookies/localStorage/IndexedDB isolation;
- multiple simultaneous Personas;
- dynamic DevTools endpoint discovery;
- generic CDP client attach/detach without closing the browser;
- browser crash/reconnect;
- profile ownership conflict;
- manual-visible browser state and automation using the same profile;
- resource caps and 50+ dormant profile inventory.

MCP itself is not needed to prove these mechanics. P12 only verifies that the chosen MCP integration interoperates with the already-proven DevTools/Persona boundary.

## 6. Perchance emulator

The emulator is not a permissive stub. It is a maintained executable model of the provider behaviors PCMS depends upon.

Its contract is derived from:
- prior Perchance discovery/evidence;
- captured sanitized request/response/DOM fixtures;
- explicit provider assumptions documented by the current Perchance adapter;
- later P12 observations when real behavior changes.

At minimum it must be able to model, where relevant:
- authenticated and unauthenticated sessions;
- expected/wrong/unknown account identity;
- generator stable identity versus mutable slug/address;
- listing/current-state reads;
- save/update/public-state effects;
- delayed responses;
- side effect committed followed by response loss;
- stale reads/eventual observation delay where discovered;
- duplicate requests;
- rate limiting/cooldown signals;
- CAPTCHA/challenge/verification-required states;
- session expiry;
- provider errors;
- redirects;
- malformed/unexpected DOM or response shape;
- compatibility drift.

Emulator scenarios must support deterministic fault injection by named scenario/seed.

Unknown real behavior is not invented into the emulator as fact. Mark assumptions explicitly and fail closed in production code when confidence is insufficient.

## 7. Provider contract loop

When discovery or P12 identifies new real behavior:

real observation
→ sanitized evidence/fixture
→ emulator contract update
→ deterministic regression test
→ implementation fix
→ CI green
→ small targeted live recheck

Do not repeatedly debug directly against Cloudflare/Perchance when the issue can be reproduced locally.

## 8. Synthetic routing/network acceptance

P04/P11 use controlled local network infrastructure rather than real Mullvad credentials.

The test harness should exercise the actual PCMS/router/browser code against:
- local SOCKS5 relay(s);
- controlled egress HTTP/DNS endpoints;
- loopback/namespace/veth/WireGuard fixtures where GitHub-hosted Linux permits them;
- socket resets/timeouts;
- relay unavailability;
- tunnel/forwarder death;
- route changes;
- DNS failure/change;
- attempted Direct fallback detection;
- multiple independent synthetic exits.

Critical assertion: a PROTECTED Persona reaches only its selected synthetic route or fails; it never reaches the fixture's Direct/control egress path.

Real Mullvad interoperability is P12 only.

## 9. Module acceptance

All official modules use the public module path:
- install local package;
- update exact hash;
- capability expansion approval;
- candidate migration failure leaves old active;
- crash isolation;
- stale generation rejection;
- disable/re-enable;
- rollback;
- archive attacks rejected.

Deployer/Refresher/Explorer/Provisioning behavior is tested primarily against the Perchance emulator, including uncertain remote-effect scenarios.

## 10. Recovery/adversarial matrix

Automate aggressively:
- pcmsd SIGKILL at every operation state;
- Chromium crash before/after emulated possible mutation;
- module crash/update/disable mid-operation;
- router/forwarder/socket loss;
- DB busy/disk-full/corrupt backup;
- clock rollback/forward/DST;
- duplicate API requests;
- queue floods;
- emulator rate limits/challenges/provider drift;
- restore with unresolved operations;
- missing/corrupt profiles;
- 50+ dormant Personas and bounded active subset.

These tests are more valuable in CI than repeated manual MCP execution because they are reproducible and can run combinatorially.

## 11. Final P12 live acceptance

P12 is intentionally small. It answers only questions emulation cannot:

1. Can MCP attach to and detach from the actual PCMS-managed Chromium Persona non-destructively?
2. Does a real protected Persona use the intended Mullvad route and fail closed under a representative route-loss event?
3. Can PCMS identify the expected real Perchance session/account?
4. Does the current Perchance surface still match the adapter for a representative read?
5. Can one disposable real Deployer mutation be performed and independently verified?

Use disposable test generators/state where mutation is necessary.

Do not force artificial CAPTCHA/Cloudflare challenges merely to test them. Human-task mechanics are exercised against the emulator; if a real challenge naturally occurs, it may be recorded as additional evidence.

## 12. Structured logging

Minimum:
- timestamp/level/component;
- operationId/requestId;
- safe Persona/Account/Generator/module identifiers;
- event code;
- bounded safe fields.

No secret payloads.

## 13. Metrics/diagnostics

Local diagnostics expose:
- pcmsd uptime/version/schema;
- DB size/health;
- running Personas/process health;
- route health/evidence age;
- module versions/generations/restarts;
- queue depth/rejections;
- unresolved/uncertain operations;
- provider gate state;
- HumanTasks;
- backup age/status;
- recent failures.

No external telemetry by default.

## 14. Support bundle

Operator-approved and redacted only. Never include browser profiles or secrets by default.
