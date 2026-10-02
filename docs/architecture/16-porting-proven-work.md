# 16 — Porting Proven Work

## 1. Source repositories

Primary sources:
- `Neb963/persona-router` (PersonaMonkey);
- `Neb963/PCMS-alt`;
- `Neb963/PCMS`.

These are evidence/implementation sources, not normative architecture.

## 2. PersonaMonkey — physically port

Initial behavior-preserving port:
- `native/routerd.py`;
- `native/sanitize_configs.py`;
- `native/persona-mullvad-router.service.in`;
- associated native hardening tests.

Why: this is the privileged host/network component with significant existing implementation, hardening and live evidence. Rewriting it would increase risk without simplifying PCMS-local.

Port with exact provenance. Adapt Chromium forwarder behavior only after baseline tests pass in PCMS-local.

## 3. PersonaMonkey — conceptually port

Retain:
- stable Persona UID separate from browser identity;
- route Block/Direct/protected semantics;
- fail-closed philosophy;
- route health/actual egress distinction;
- bounded native protocol style;
- operation correlation/secret-safe diagnostics ideas;
- external mutation/human continuation lessons.

Redesign transport around local Core.

## 4. PersonaMonkey — do not port

- Firefox `contextualIdentities`;
- `cookieStoreId` as durable identity;
- Firefox `proxy.onRequest`;
- browser extension background/options UI;
- native messaging framing shim used only for WebExtension transport;
- userscript/workflow engine as foundation;
- cross-extension Integration API authorization/transport;
- Firefox Sync recovery.

## 5. PCMS-alt — port design work

Retain:
- reduced Core versus module policy boundary;
- GeneratorRef stable local identity/current slug distinction;
- external mutation uncertainty and read-first reconciliation;
- shared provider backpressure/cooldown idea;
- dynamic module candidate/update hardening concepts;
- small correctness kernel.

Do not port the Firefox sandbox/userScripts implementation from **PCMS-alt P01** or its IndexedDB authority.

## 6. PCMS — port repository discipline/contracts selectively

Retain:
- AGENTS authority order;
- machine-readable phase/dependency/gate plan;
- requirement ownership/traceability;
- acceptance matrix;
- frequent remote checkpoints;
- typed external boundary doctrine;
- explicit progress/handoff records;
- provider adapter separation.

Do not restore the old broad domain architecture (global event journal, generalized resource system, etc.) unless current product requirements later prove a concrete need.

## 7. Provenance file

Every copied source file is listed in root `PORTING_PROVENANCE.md` with:
- source repo;
- source commit/blob;
- destination path;
- initial modifications;
- test/evidence carried forward;
- later adaptation commits.

## 8. Test provenance

Ported tests prove only the retained behavior they actually exercise. Older live Firefox evidence may support the native router itself but does not prove Chromium integration.

All Chromium-specific routing/browser behavior gets new acceptance IDs.
