# PCMS-local v0.1 Acceptance Matrix

Evidence: **U** unit/deterministic, **I** local integration, **B** real Chromium, **R** real routing, **P** real Perchance, **A** agent attachment, **REC** adversarial recovery.

A gate is PASS only with the evidence class it requires. Source inspection does not substitute for live B/R/P/A evidence.

| ID | Phase | Evidence | Acceptance |
|---|---|---:|---|
| A00-01 | P00 | U | Exact Product Requirements are committed and named highest product authority. |
| A00-02 | P00 | U | AGENTS authority/Git/CI/porting contracts are self-contained. |
| A00-03 | P00 | U | Architecture specs + accepted ADRs cover Core, Persona, routing, modules, operations, install/test/security/non-goals. |
| A00-04 | P00 | U | plan/policies/ownership JSON parse and phase dependencies/acceptance IDs are consistent. |
| A00-05 | P00 | U | Every physically copied source file has exact source repo/commit/blob provenance. |
| A00-06 | P00 | U | Ported native sanitizer/service/router hardening tests pass without PCMS-specific semantic changes. |
| A00-07 | P00 | I | Initial GitHub Actions execute repository + native deterministic gates on branch/PR. |
| A01-01 | P01 | U | Node/TS workspace builds, typechecks, lints and tests from clean checkout. |
| A01-02 | P01 | I | pcmsd starts single-instance on loopback and reports health/readiness/version. |
| A01-03 | P01 | I | SQLite opens with required pragmas, applies ordered migration, rejects incompatible schema. |
| A01-04 | P01 | I | local Web UI loads through authenticated/same-origin Core surface. |
| A01-05 | P01 | I | CLI uses Core API and emits stable JSON mode. |
| A01-06 | P01 | I | user-service/foreground lifecycle stops cleanly and restarts without state loss. |
| A01-07 | P01 | U/I | hosted CI includes verify, integration skeleton, native tests, security/package foundations. |
| A01-08 | P01 | I | release/dev bundle starts without requiring end-user npm/pnpm commands. |
| A02-01 | P02 | U | bounded archive parser rejects traversal, duplicates, unsafe links and zip bombs. |
| A02-02 | P02 | U | manifest/API/capability schemas reject unknown/invalid authority. |
| A02-03 | P02 | I | module process has no supported raw Core DB/router/CDP handles; bounded RPC works. |
| A02-04 | P02 | REC | module crash leaves pcmsd/unrelated module responsive and returns structured runtime loss. |
| A02-05 | P02 | U/I | stale runtime generation cannot issue accepted SDK calls after update/disable. |
| A02-06 | P02 | REC | candidate migration/health failure leaves old module/version/state active. |
| A02-07 | P02 | I | capability expansion requires explicit approval before activation. |
| A02-08 | P02 | I | disable/re-enable preserves state and unresolved Core operations. |
| A02-09 | P02 | I | rollback activates retained prior package/state via a new generation. |
| A02-10 | P02 | I | purge is blocked while unresolved operations/tasks require module evidence. |
| A02-11 | P02 | I | module UI failure can be reset without killing pcmsd. |
| A02-12 | P02 | I | reference module installs/updates from .pcmsmod exactly as future first-party modules. |
| A03-01 | P03 | B | Persona user-data-dir is created under safe root and remains stable across close/reopen. |
| A03-02 | P03 | B | authenticated/cookie/localStorage state persists where provider/browser permits. |
| A03-03 | P03 | B | two Personas do not share cookie/localStorage/IndexedDB test state. |
| A03-04 | P03 | B | two simultaneous Personas use distinct profile/process/DevTools ownership. |
| A03-05 | P03 | REC/B | browser crash leaves Persona definition/profile intact and runtime reconciles. |
| A03-06 | P03 | B | pcmsd restart safely reconnects owned running Persona or marks it closed/degraded. |
| A03-07 | P03 | B | profile ownership ambiguity refuses second launch/unsafe attach. |
| A03-08 | P03 | A | agent attaches to running real Persona and disconnects without closing it. |
| A03-09 | P03 | B | explicit close preserves profile; retire/delete obey guards. |
| A03-10 | P03 | I/B | configurable active-Persona cap queues/rejects excess without killing active human work. |
| A04-01 | P04 | U | PersonaMonkey native baseline port tests remain green before adaptation. |
| A04-02 | P04 | I | unprivileged pcmsd can use typed bounded router control; cannot require root/NET_ADMIN. |
| A04-03 | P04 | U/I | Chromium forwarder binds loopback only, is route/lease scoped, expires/releases safely. |
| A04-04 | P04 | R | protected Persona exits through selected Mullvad route. |
| A04-05 | P04 | R/B | browser egress verification matches route independently of config metadata. |
| A04-06 | P04 | R/B | DNS/QUIC/WebRTC acceptance shows no relevant ordinary host-route escape under supported config. |
| A04-07 | P04 | R/B | loss of protected proxy/tunnel causes browser failure, never silent Direct fallback. |
| A04-08 | P04 | B | Direct works only when explicitly selected and is visibly classified. |
| A04-09 | P04 | B | Block mode prevents external browser networking. |
| A04-10 | P04 | R/B | route change uses safe transition/relaunch and verifies new egress before mutation admission. |
| A04-11 | P04 | R/B | multiple active protected Personas can use independent exits without state crossover. |
| A05-01 | P05 | U/I | Account↔Persona active uniqueness enforced transactionally. |
| A05-02 | P05 | I | explicit rebind records understandable binding history. |
| A05-03 | P05 | U/I | Generator localId survives slug change; stable provider ID uniqueness enforced when known. |
| A05-04 | P05 | I | route/session/account health distinguish configured/observed/verified/stale/unknown. |
| A05-05 | P05 | I | search finds Accounts/Personas/Generators by safe metadata without using display value as identity. |
| A05-06 | P05 | I | import validates full batch invariants before atomic apply. |
| A05-07 | P05 | B/P | wrong-account observation blocks sensitive mutation. |
| A05-08 | P05 | I | 50+ dormant Accounts/Personas remain manageable with bounded startup/query work. |
| A05-09 | P05 | I | one Persona missing/corrupt does not make unrelated inventory unusable. |
| A05-10 | P05 | I | operator can open Account → actual bound Persona from UI/CLI. |
| A06-01 | P06 | B | BrowserDriver controls already-running Persona; it does not synthesize a separate automation profile. |
| A06-02 | P06 | B | BrowserDriver timeouts/cancellation/target loss are structured and bounded. |
| A06-03 | P06 | P | Perchance session identity probe distinguishes expected/mismatch/unknown. |
| A06-04 | P06 | P | generator identity/current slug can be revalidated before mutation. |
| A06-05 | P06 | U/I | one unresolved mutation claim per stable target; epochs/fresh preflight enforced. |
| A06-06 | P06 | REC | pcmsd/module/browser loss after possible dispatch becomes UNCERTAIN, not failed/retried. |
| A06-07 | P06 | P/REC | response loss reconciles remote state before any redispatch. |
| A06-08 | P06 | I | provider cooldown/rate-limit signal gates concurrent mutation producers. |
| A06-09 | P06 | I | durable HumanTask survives restart while one-time input may expire safely. |
| A06-10 | P06 | B/P | human challenge can pause, focus same Persona and resume same logical operation. |
| A06-11 | P06 | I | batch children have independent results; partial failure does not corrupt successful targets. |
| A06-12 | P06 | REC | cancellation after possible side effect cannot be misreported as clean CANCELLED. |
| A06-13 | P06 | U/I | scheduler handles duplicate wake/clock jump without mutation backlog storm. |
| A07-01 | P07 | U/I | Deployer scans exact repository commit and hashes bounded artifacts. |
| A07-02 | P07 | U | ambiguous/invalid ZIP/version selection blocks rather than guesses. |
| A07-03 | P07 | I | repository slug maps to stable GeneratorRef then current identity is revalidated. |
| A07-04 | P07 | P | initial deployment saves/verifies desired content and required public state. |
| A07-05 | P07 | P | changed artifact updates; identical verified SHA is no-op. |
| A07-06 | P07 | P/REC | old slug reuse/provider identity mismatch cannot redirect mutation. |
| A07-07 | P07 | P/REC | lost response after save reconciles before retry. |
| A07-08 | P07 | I | polling coalesces and respects shared provider gate/backpressure. |
| A07-09 | P07 | I | Deployer can be updated independently as a .pcmsmod without Core reinstall. |
| A07-10 | P07 | REC | Deployer update/disable/crash mid-operation preserves Core claim/evidence. |
| A07-11 | P07 | I | module rollback restores last-known-good Deployer version/state. |
| A07-12 | P07 | B/R/P/A | end-to-end Account→Persona→route→agent/provider→deploy vertical slice passes. |
| A08-01 | P08 | P | safe refresh mutation/effect is empirically characterized before scheduled automation. |
| A08-02 | P08 | P | listing/recent observation parser returns UNKNOWN on provider drift. |
| A08-03 | P08 | I | cohort size is configurable and not capped by recent-page visible capacity. |
| A08-04 | P08 | U/I | active/sleep/timezone/budget semantics survive DST/clock jumps. |
| A08-05 | P08 | I | Refresher/Deployer collision on same Generator is denied by shared target claim. |
| A08-06 | P08 | I/P | rate-limit/challenge evidence gates other mutation modules appropriately. |
| A08-07 | P08 | P | manual refresh verifies intended remote effect/public state. |
| A08-08 | P08 | P | scheduled/recent-visibility modes record per-generator verified history. |
| A08-09 | P08 | REC | uncertain refresh blocks duplicate claim until reconciled. |
| A08-10 | P08 | I | Refresher is independently updateable/rollbackable package. |
| A09-01 | P09 | P | Explorer availability observation is distinct from verified ownership. |
| A09-02 | P09 | P/REC | Explorer claim uses operation safety/reconciliation and reserves only verified acquisitions. |
| A09-03 | P09 | I | Explorer handoff creates/links stable Generator/Project target without identity confusion. |
| A09-04 | P09 | U/I | Provisioning staging detects duplicates before side effects. |
| A09-05 | P09 | B/P | Provisioning allocates dedicated Persona and operates same human-visible session. |
| A09-06 | P09 | B/P | CAPTCHA/challenge/code creates HumanTask and resumes after human completion. |
| A09-07 | P09 | P | Account becomes ACTIVE only after authenticated provider identity verification. |
| A09-08 | P09 | REC | interrupted signup/login is reconciled; duplicate account creation is not blindly retried. |
| A09-09 | P09 | I | batch provisioning isolates per-account input/state/result/cancellation. |
| A09-10 | P09 | I | Explorer and Provisioning modules update independently. |
| A09-11 | P09 | I | secret inputs never appear in ordinary module/history/log/statistics records. |
| A10-01 | P10 | I | Statistics derives from operational facts and cannot mutate authoritative state. |
| A10-02 | P10 | I | coherent DB/module state backup validates manifest and hashes. |
| A10-03 | P10 | I | automatic backup retention does not include browser profiles unintentionally. |
| A10-04 | P10 | B | optional closed-Persona profile backup/restore reports Chromium compatibility honestly. |
| A10-05 | P10 | REC | restore activates into RECOVERY_HOLD and does not replay overdue mutations. |
| A10-06 | P10 | REC | missing profile/module/external state is reported rather than synthesized healthy. |
| A10-07 | P10 | I | Attention survives restart; notifications do not replace durable tasks. |
| A10-08 | P10 | I | backup restore to fresh install reconstructs Core relationships/module registry. |
| A10-09 | P10 | U | Full-V1 requirements gap ledger is explicit before release hardening. |
| A11-01 | P11 | I | clean Fedora/Linux install requires no user npm/pnpm setup and launches from desktop/CLI. |
| A11-02 | P11 | I | uninstall preserves data by default; purge is explicit; router/profile/config not silently deleted. |
| A11-03 | P11 | REC | pcmsd SIGKILL across operation phases preserves correct uncertainty/claims. |
| A11-04 | P11 | REC | module crash/update/disable and Chromium crash matrices preserve unrelated work. |
| A11-05 | P11 | R/REC | router/tunnel/forwarder failure remains fail-closed and recoverable. |
| A11-06 | P11 | REC | disk-full/DB busy/corrupt backup errors are bounded/actionable. |
| A11-07 | P11 | REC | queue flood/poison module does not starve UI/control/recovery lane. |
| A11-08 | P11 | I/B | 50+ Persona inventory/startup/disk and configured active subset remain bounded. |
| A11-09 | P11 | U/I | secrets/redaction/path/archive security audit passes. |
| A11-10 | P11 | I | release Core/modules have checksums, provenance and SBOM/reproducibility evidence where required. |
| A11-11 | P11 | REC | fresh-install restore drill passes with unresolved operation/HumanTask preservation. |
| A11-12 | P11 | A | agent can identify/open/inspect/interact/detach real Persona non-destructively. |
| A11-13 | P11 | R | protected routing live matrix passes supported host/browser. |
| A11-14 | P11 | P | disposable-provider acceptance covers critical mutation/reconciliation paths. |
| A11-15 | P11 | U/I/B/R/P/A/REC | release report has no false PASS and lists residual unsupported/unknown behavior. |
