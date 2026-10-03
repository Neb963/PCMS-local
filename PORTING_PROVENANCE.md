# Porting Provenance

This file records physically copied implementation from older repositories. Product/architecture authority remains in `docs/product`, accepted ADRs and `docs/architecture`.

## PersonaMonkey native routing baseline

Source repository: `Neb963/persona-router`  
Source commit: `9995f6eadfa54be6cc0001f4e04f2a2d9b9401bf`  
Port date: 2026-10-02  
Initial-port policy: **behavior preserving, no PCMS-local semantic adaptation in the source files listed below**.

| Source path | Source blob | Destination | Destination blob | Initial modification |
|---|---|---|---|---|
| `native/routerd.py` | `345911a056c4a01db86e6a805d49b7d44233e7a1` | `native/routerd.py` | `345911a056c4a01db86e6a805d49b7d44233e7a1` | None |
| `native/sanitize_configs.py` | `297e06bd909ca9dd02d31bd3a4b1550c8b9bd825` | `native/sanitize_configs.py` | `297e06bd909ca9dd02d31bd3a4b1550c8b9bd825` | None |
| `native/persona-mullvad-router.service.in` | `55bb2af323c578d02ef661029664531e7fde8dc3` | `native/persona-mullvad-router.service.in` | `55bb2af323c578d02ef661029664531e7fde8dc3` | None |
| `native/routerctl.py` | `f873d588e1b625899ab76b8afd9c25ded37f8e47` | `native/routerctl.py` | `f873d588e1b625899ab76b8afd9c25ded37f8e47` | None |
| `tests/test_native.py` | `c6dc70ca38b4ee893fafb457e1ea12a9b1096402` | `tests/test_native.py` | `c6dc70ca38b4ee893fafb457e1ea12a9b1096402` | None |
| `tests/test_forwarder_auth.py` | `54e963e54e105e81202bfa13a225126662dcb331` | `tests/test_forwarder_auth.py` | `54e963e54e105e81202bfa13a225126662dcb331` | None |
| `tests/test_native_service_hardening.py` | `dfe934e451f829088195feb066268077f820d64c` | `tests/test_native_service_hardening.py` | `dfe934e451f829088195feb066268077f820d64c` | None |
| `LICENSE` | `14fac913ccf80234b1848540089a3bbcb6e5283d` | `LICENSE` | `14fac913ccf80234b1848540089a3bbcb6e5283d` | None |

The first port commit accidentally placed the three test files one directory too deep. Commit `c29a4f7e17658fadf0d0faf9d8c12b594b6233e3` corrected only their repository paths; the test blob contents remain byte/Git-blob identical to upstream.

### Why these files were ported

- `native/routerd.py`: existing privileged WireGuard/Mullvad routing daemon, scoped routes, local forwarders, bounded control protocol, cleanup and route health.
- `native/sanitize_configs.py`: hardened import/sanitization of WireGuard configs and private atomic writes.
- `native/persona-mullvad-router.service.in`: capability-bounded/sandboxed systemd service template.
- `native/routerctl.py`: generic local daemon diagnostic/control client useful during migration and host testing.
- native tests: preserve sanitizer/private-file/service/forwarder/cancellation behavior before PCMS-local changes it.
- `LICENSE`: PersonaMonkey is MIT licensed; PCMS-local uses the same MIT license.

### Evidence carried forward

PersonaMonkey had deterministic native tests and prior live WireGuard/Mullvad acceptance. That evidence supports the imported baseline only.

It does **not** prove Chromium SOCKS/proxy compatibility, PCMS-local Core router-client behavior, Chromium DNS/QUIC/WebRTC fail-closed behavior, or PCMS-local installation/migration behavior. Those have new A04-* gates.

### P017 adaptation

The imported `native/routerd.py` baseline blob remains `345911a056c4a01db86e6a805d49b7d44233e7a1`. After P016 re-proved that exact baseline in CI, P017 intentionally begins PCMS-local-specific adaptation.

- `5c4fc952f56b6a020090b998e2ec585aaf780374` — adds the distinct `prepare_chromium_exit` / `release_chromium_exit` route-lease contract and leaves the authenticated Firefox-compatible `prepare_exit` path intact.

All other files still listed by `scripts/verify-ported-blobs.mjs` remain byte/Git-blob identical to their recorded upstream PersonaMonkey blobs.

## PCMS / PCMS-alt design ports

No source code is physically copied from PCMS or PCMS-alt in historical P000.

Their validated concepts are rewritten into PCMS-local specifications:
- PCMS: repository/agent discipline, machine-readable plan/traceability, Provider Adapter boundary.
- PCMS-alt: stable GeneratorRef identity, reduced correctness kernel, mutation uncertainty/reconciliation, bounded shared provider backpressure, hardened module candidate activation.

See `docs/architecture/16-porting-proven-work.md`.
