# PCMS-local v0.1 Acceptance Matrix

Evidence: **U** unit/deterministic, **I** local integration, **B** real Chromium under automated control, **E** Perchance emulator/contract fixture, **N** synthetic network/routing, **REC** adversarial recovery, **L** final live-system/MCP acceptance.

P001–P047 are closable using U/I/B/E/N/REC only. Real Perchance, real Mullvad and MCP are deliberately deferred to P048–P049. Emulator/synthetic evidence must never be described as proof of current external-system behavior.

Acceptance IDs retain their domain-oriented names (for example A06-*) while ownership is assigned to the smaller session phase that proves them.

| ID | Milestone | Phase | Evidence | Acceptance |
|---|---|---|---:|---|
| A00-01 | M00 | P000 | U | Exact Product Requirements are committed and named highest product authority. |
| A00-02 | M00 | P000 | U | AGENTS authority/Git/CI/porting contracts are self-contained. |
| A00-03 | M00 | P000 | U | Architecture specs + accepted ADRs cover Core, Persona, routing, modules, operations, install/test/security/non-goals. |
| A00-04 | M00 | P000 | U | plan/policies/ownership JSON parse and phase dependencies/acceptance IDs are consistent. |
| A00-05 | M00 | P000 | U | Every physically copied source file has exact source repo/commit/blob provenance. |
| A00-06 | M00 | P000 | U | Ported native sanitizer/service/router hardening tests pass without PCMS-specific semantic changes. |
| A00-07 | M00 | P000 | I | Initial GitHub Actions execute repository + native deterministic gates on branch/PR. |
| A01-01 | M01 | P001 | U | Node/TS workspace builds, typechecks, lints and tests from clean checkout. |
| A01-02 | M01 | P002 | I | pcmsd starts single-instance on loopback and reports health/readiness/version. |
| A01-03 | M01 | P003 | I | SQLite opens with required pragmas, applies ordered migration, rejects incompatible schema. |
| A01-04 | M01 | P004 | I | local Web UI loads through authenticated/same-origin Core surface. |
| A01-05 | M01 | P004 | I | CLI uses Core API and emits stable JSON mode. |
| A01-06 | M01 | P005 | I | user-service/foreground lifecycle stops cleanly and restarts without state loss. |
| A01-07 | M01 | P001 | U/I | hosted CI includes verify, integration skeleton, native tests, security/package foundations. |
| A01-08 | M01 | P005 | I | release/dev bundle starts without requiring end-user npm/pnpm commands. |
| A02-01 | M02 | P006 | U | bounded archive parser rejects traversal, duplicates, unsafe links and zip bombs. |
| A02-02 | M02 | P006 | U | manifest/API/capability schemas reject unknown/invalid authority. |
| A02-03 | M02 | P007 | I | module process has no supported raw Core DB/router/CDP handles; bounded RPC works. |
| A02-04 | M02 | P007 | REC | module crash leaves pcmsd/unrelated module responsive and returns structured runtime loss. |
| A02-05 | M02 | P008 | U/I | stale runtime generation cannot issue accepted SDK calls after update/disable. |
| A02-06 | M02 | P008 | REC | candidate migration/health failure leaves old module/version/state active. |
| A02-07 | M02 | P009 | I | capability expansion requires explicit approval before activation. |
| A02-08 | M02 | P010 | I | disable/re-enable preserves state and unresolved Core operations. |
| A02-09 | M02 | P010 | I | rollback activates retained prior package/state via a new generation. |
| A02-10 | M02 | P010 | I | purge is blocked while unresolved operations/tasks require module evidence. |
| A02-11 | M02 | P011 | I | module UI failure can be reset without killing pcmsd. |
| A02-12 | M02 | P011 | I | reference module installs/updates from .pcmsmod exactly as future first-party modules. |
| A03-01 | M03 | P012 | B | Persona user-data-dir is created under safe root and remains stable across close/reopen. |
| A03-02 | M03 | P013 | B | authenticated/cookie/localStorage state persists where provider/browser permits. |
| A03-03 | M03 | P013 | B | two Personas do not share cookie/localStorage/IndexedDB test state. |
| A03-04 | M03 | P013 | B | two simultaneous Personas use distinct profile/process/DevTools ownership. |
| A03-05 | M03 | P014 | REC/B | browser crash leaves Persona definition/profile intact and runtime reconciles. |
| A03-06 | M03 | P014 | B | pcmsd restart safely reconnects owned running Persona or marks it closed/degraded. |
| A03-07 | M03 | P014 | B | profile ownership ambiguity refuses second launch/unsafe attach. |
| A03-08 | M03 | P015 | B | generic DevTools client attaches to a running real Persona and disconnects without closing it; MCP is deferred to P12. |
| A03-09 | M03 | P012 | B | explicit close preserves profile; retire/delete obey guards. |
| A03-10 | M03 | P014 | I/B | configurable active-Persona cap queues/rejects excess without killing active human work. |
| A04-01 | M04 | P016 | U | PersonaMonkey native baseline port tests remain green before adaptation. |
| A04-02 | M04 | P016 | I | unprivileged pcmsd can use typed bounded router control; cannot require root/NET_ADMIN. |
| A04-03 | M04 | P017 | U/I | Chromium forwarder binds loopback only, is route/lease scoped, expires/releases safely. |
| A04-04 | M04 | P018 | N/B | protected Persona exits through the selected synthetic route/relay fixture. |
| A04-05 | M04 | P018 | N/B | browser egress verification matches the selected synthetic route independently of config metadata. |
| A04-06 | M04 | P019 | N/B | controlled DNS/QUIC/WebRTC tests show no relevant Direct/control-path escape under supported Chromium configuration. |
| A04-07 | M04 | P019 | N/B | loss of protected synthetic proxy/tunnel causes browser failure, never silent Direct fallback. |
| A04-08 | M04 | P020 | B | Direct works only when explicitly selected and is visibly classified. |
| A04-09 | M04 | P020 | B | Block mode prevents external browser networking. |
| A04-10 | M04 | P020 | N/B | route change uses safe transition/relaunch and verifies the new synthetic egress before mutation admission. |
| A04-11 | M04 | P020 | N/B | multiple active protected Personas use independent synthetic exits without state crossover. |
| A05-01 | M05 | P021 | U/I | Account↔Persona active uniqueness enforced transactionally. |
| A05-02 | M05 | P021 | I | explicit rebind records understandable binding history. |
| A05-03 | M05 | P022 | U/I | Generator localId survives slug change; stable provider ID uniqueness enforced when known. |
| A05-04 | M05 | P023 | I | route/session/account health distinguish configured/observed/verified/stale/unknown. |
| A05-05 | M05 | P023 | I | search finds Accounts/Personas/Generators by safe metadata without using display value as identity. |
| A05-06 | M05 | P022 | I | import validates full batch invariants before atomic apply. |
| A05-07 | M05 | P024 | B/E | emulated wrong-account/session observation blocks sensitive mutation. |
| A05-08 | M05 | P024 | I | 50+ dormant Accounts/Personas remain manageable with bounded startup/query work. |
| A05-09 | M05 | P024 | I | one Persona missing/corrupt does not make unrelated inventory unusable. |
| A05-10 | M05 | P023 | I | operator can open Account → actual bound Persona from UI/CLI. |
| A06-01 | M06 | P025 | B | BrowserDriver controls already-running Persona; it does not synthesize a separate automation profile. |
| A06-02 | M06 | P025 | B | BrowserDriver timeouts/cancellation/target loss are structured and bounded. |
| A06-03 | M06 | P026 | B/E | Perchance emulator session identity distinguishes expected/mismatch/unknown through the real browser/provider adapter. |
| A06-04 | M06 | P026 | B/E | generator identity/current slug is revalidated through the provider adapter against emulator contract state before mutation. |
| A06-05 | M06 | P027 | U/I | one unresolved mutation claim per stable target; epochs/fresh preflight enforced. |
| A06-06 | M06 | P027 | REC | pcmsd/module/browser loss after possible dispatch becomes UNCERTAIN, not failed/retried. |
| A06-07 | M06 | P028 | E/REC | emulated response loss after possible remote effect reconciles state before any redispatch. |
| A06-08 | M06 | P028 | I | provider cooldown/rate-limit signal gates concurrent mutation producers. |
| A06-09 | M06 | P028 | I | durable HumanTask survives restart while one-time input may expire safely. |
| A06-10 | M06 | P028 | B/E | emulated provider challenge pauses, focuses the same Persona and resumes the same logical operation. |
| A06-11 | M06 | P029 | I | batch children have independent results; partial failure does not corrupt successful targets. |
| A06-12 | M06 | P027 | REC | cancellation after possible side effect cannot be misreported as clean CANCELLED. |
| A06-13 | M06 | P029 | U/I | scheduler handles duplicate wake/clock jump without mutation backlog storm. |
| A07-01 | M07 | P030 | U/I | Deployer scans exact repository commit and hashes bounded artifacts. |
| A07-02 | M07 | P030 | U | ambiguous/invalid ZIP/version selection blocks rather than guesses. |
| A07-03 | M07 | P031 | I | repository slug maps to stable GeneratorRef then current identity is revalidated. |
| A07-04 | M07 | P031 | B/E | initial deployment against the emulator saves/verifies desired content and required public state. |
| A07-05 | M07 | P032 | B/E | changed emulator artifact state updates; identical verified SHA is a no-op. |
| A07-06 | M07 | P032 | E/REC | emulated old-slug reuse/provider identity mismatch cannot redirect mutation. |
| A07-07 | M07 | P032 | E/REC | emulated lost response after save reconciles before retry. |
| A07-08 | M07 | P033 | I | polling coalesces and respects shared provider gate/backpressure. |
| A07-09 | M07 | P033 | I | Deployer can be updated independently as a .pcmsmod without Core reinstall. |
| A07-10 | M07 | P033 | REC | Deployer update/disable/crash mid-operation preserves Core claim/evidence. |
| A07-11 | M07 | P033 | I | module rollback restores last-known-good Deployer version/state. |
| A07-12 | M07 | P033 | B/N/E/REC | end-to-end Account→Persona→synthetic route→provider emulator→Deployer vertical slice passes without MCP. |
| A08-01 | M08 | P034 | E | refresh mutation/effect is represented by an explicit evidence-backed emulator contract before scheduled automation. |
| A08-02 | M08 | P034 | E | listing/recent emulator and fixtures return UNKNOWN on unrecognized provider shape/drift. |
| A08-03 | M08 | P035 | I | cohort size is configurable and not capped by recent-page visible capacity. |
| A08-04 | M08 | P035 | U/I | active/sleep/timezone/budget semantics survive DST/clock jumps. |
| A08-05 | M08 | P035 | I | Refresher/Deployer collision on same Generator is denied by shared target claim. |
| A08-06 | M08 | P035 | I/E | emulated rate-limit/challenge evidence gates other mutation modules appropriately. |
| A08-07 | M08 | P036 | E | manual refresh against emulator verifies intended remote effect/public state. |
| A08-08 | M08 | P036 | E | scheduled/recent-visibility modes record per-generator verified emulator history. |
| A08-09 | M08 | P036 | REC | uncertain refresh blocks duplicate claim until reconciled. |
| A08-10 | M08 | P036 | I | Refresher is independently updateable/rollbackable package. |
| A09-01 | M09 | P037 | E | Explorer availability observation against emulator is distinct from verified ownership. |
| A09-02 | M09 | P037 | E/REC | Explorer emulated claim uses operation safety/reconciliation and reserves only verified acquisitions. |
| A09-03 | M09 | P037 | I | Explorer handoff creates/links stable Generator/Project target without identity confusion. |
| A09-04 | M09 | P038 | U/I | Provisioning staging detects duplicates before side effects. |
| A09-05 | M09 | P038 | B/E | Provisioning allocates a dedicated Persona and operates the same human-visible session against emulator flow. |
| A09-06 | M09 | P039 | B/E | emulated CAPTCHA/challenge/code state creates HumanTask and resumes after supplied human continuation. |
| A09-07 | M09 | P039 | E | Account becomes ACTIVE only after authenticated emulator identity verification. |
| A09-08 | M09 | P039 | REC | interrupted signup/login is reconciled; duplicate account creation is not blindly retried. |
| A09-09 | M09 | P040 | I | batch provisioning isolates per-account input/state/result/cancellation. |
| A09-10 | M09 | P040 | I | Explorer and Provisioning modules update independently. |
| A09-11 | M09 | P040 | I | secret inputs never appear in ordinary module/history/log/statistics records. |
| A10-01 | M10 | P041 | I | Statistics derives from operational facts and cannot mutate authoritative state. |
| A10-02 | M10 | P041 | I | coherent DB/module state backup validates manifest and hashes. |
| A10-03 | M10 | P041 | I | automatic backup retention does not include browser profiles unintentionally. |
| A10-04 | M10 | P042 | B | optional closed-Persona profile backup/restore reports Chromium compatibility honestly. |
| A10-05 | M10 | P042 | REC | restore activates into RECOVERY_HOLD and does not replay overdue mutations. |
| A10-06 | M10 | P042 | REC | missing profile/module/external state is reported rather than synthesized healthy. |
| A10-07 | M10 | P043 | I | Attention survives restart; notifications do not replace durable tasks. |
| A10-08 | M10 | P043 | I | backup restore to fresh install reconstructs Core relationships/module registry. |
| A10-09 | M10 | P043 | U | Full-V1 requirements gap ledger is explicit before release hardening. |
| A11-01 | M11 | P044 | I | clean Fedora/Linux install requires no user npm/pnpm setup and launches from desktop/CLI. |
| A11-02 | M11 | P044 | I | uninstall preserves data by default; purge is explicit; router/profile/config not silently deleted. |
| A11-03 | M11 | P045 | REC | pcmsd SIGKILL across operation phases preserves correct uncertainty/claims. |
| A11-04 | M11 | P045 | REC | module crash/update/disable and Chromium crash matrices preserve unrelated work. |
| A11-05 | M11 | P047 | N/REC | synthetic router/tunnel/forwarder failure matrix remains fail-closed and recoverable. |
| A11-06 | M11 | P045 | REC | disk-full/DB busy/corrupt backup errors are bounded/actionable. |
| A11-07 | M11 | P045 | REC | queue flood/poison module does not starve UI/control/recovery lane. |
| A11-08 | M11 | P045 | I/B | 50+ Persona inventory/startup/disk and configured active subset remain bounded. |
| A11-09 | M11 | P046 | U/I | secrets/redaction/path/archive security audit passes. |
| A11-10 | M11 | P046 | I | release Core/modules have checksums, provenance and SBOM/reproducibility evidence where required. |
| A11-11 | M11 | P046 | REC | fresh-install restore drill passes with unresolved operation/HumanTask preservation. |
| A11-12 | M11 | P047 | B | generic DevTools automation can identify/open/inspect/interact/detach a real Persona non-destructively; MCP is P12. |
| A11-13 | M11 | P047 | N/B | full synthetic protected-routing matrix passes supported hosted-CI browser/network fixtures. |
| A11-14 | M11 | P047 | B/E/REC | Perchance emulator acceptance covers critical read/mutation/reconciliation/drift paths. |
| A11-15 | M11 | P047 | U/I/B/E/N/REC | CI-complete release-candidate report has no false PASS and lists residual external-system assumptions for P12. |
| A12-01 | M12 | P048 | L | MCP attaches to the actual PCMS-managed Chromium Persona, inspects/interacts, detaches, and the Persona remains alive/persistent. |
| A12-02 | M12 | P048 | L | Two real Personas can be identified as distinct persistent browser/account contexts without cross-session confusion. |
| A12-03 | M12 | P048 | L | A real PROTECTED Persona uses its assigned Mullvad route; one representative route-loss event blocks/fails rather than falling back to Direct. |
| A12-04 | M12 | P049 | L | PCMS identifies the expected real Perchance session/account and performs a representative read through the current provider surface. |
| A12-05 | M12 | P049 | L | One disposable real Deployer mutation is performed against the intended generator and independently verified; discrepancies are first reproduced in emulator CI before further live debugging. |
