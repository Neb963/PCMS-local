# Porting Provenance

This file records physically copied implementation from older repositories. Product/architecture authority remains in `docs/product`, accepted ADRs and `docs/architecture`.

## PersonaMonkey native routing baseline

Source repository: `Neb963/persona-router`  
Source commit: `9995f6eadfa54be6cc0001f4e04f2a2d9b9401bf`  
Port date: 2026-10-02  
Initial-port policy: **behavior preserving, no PCMS-local semantic adaptation in this commit**.

| Source path | Source blob | Destination | Destination blob | Initial modification |
|---|---|---|---|---|
| `native/routerd.py` | `345911a056c4a01db86e6a805d49b7d44233e7a1` | `native/routerd.py` | `345911a056c4a01db86e6a805d49b7d44233e7a1` | None; byte/content-equivalent Git blob |
| `native/sanitize_configs.py` | `297e06bd909ca9dd02d31bd3a4b1550c8b9bd825` | `native/sanitize_configs.py` | `297e06bd909ca9dd02d31bd3a4b1550c8b9bd825` | None; byte/content-equivalent Git blob |
| `native/persona-mullvad-router.service.in` | `55bb2af323c578d02ef661029664531e7fde8dc3` | `native/persona-mullvad-router.service.in` | `55bb2af323c578d02ef661029664531e7fde8dc3` | None; byte/content-equivalent Git blob |
| `native/routerctl.py` | `f873d588e1b625899ab76b8afd9c25ded37f8e47` | `native/routerctl.py` | `f873d588e1b625899ab76b8afd9c25ded37f8e47` | None; byte/content-equivalent Git blob |
| `tests/test_native.py` | `c6dc70ca38b4ee893fafb457e1ea12a9b1096402` | `tests/native/test_native.py` | `c6dc70ca38b4ee893fafb457e1ea12a9b1096402` | None; byte/content-equivalent Git blob |
| `tests/test_forwarder_auth.py` | `54e963e54e105e81202bfa13a225126662dcb331` | `tests/native/test_forwarder_auth.py` | `54e963e54e105e81202bfa13a225126662dcb331` | None; byte/content-equivalent Git blob |
| `tests/test_native_service_hardening.py` | `dfe934e451f829088195feb066268077f820d64c` | `tests/native/test_native_service_hardening.py` | `dfe934e451f829088195feb066268077f820d64c` | None; byte/content-equivalent Git blob |
| `LICENSE` | `14fac913ccf80234b1848540089a3bbcb6e5283d` | `LICENSE` | `14fac913ccf80234b1848540089a3bbcb6e5283d` | None; byte/content-equivalent Git blob |

### Why these files were ported

- `native/routerd.py`: existing privileged WireGuard/Mullvad routing daemon, scoped routes, local forwarders, bounded control protocol, cleanup and route health.
- `native/sanitize_configs.py`: hardened import/sanitization of WireGuard configs and private atomic writes.
- `native/persona-mullvad-router.service.in`: capability-bounded/sandboxed systemd service template.
- `native/routerctl.py`: generic local daemon diagnostic/control client useful during migration and host testing.
- native tests: preserve the proven sanitizer/private-file/service/forwarder/cancellation behavior before PCMS-local changes it.
- `LICENSE`: PersonaMonkey source is MIT licensed; PCMS-local starts under the same MIT license.

### Evidence carried forward

PersonaMonkey had deterministic native tests and prior live WireGuard/Mullvad acceptance. That evidence supports the imported baseline only.

It does **not** prove:
- Chromium SOCKS/proxy compatibility;
- PCMS-local Core router-client behavior;
- Chromium DNS/QUIC/WebRTC fail-closed behavior;
- PCMS-local installer/migration behavior.

Those have new acceptance gates A04-*.

### Planned adaptation

P04 will add a distinct Chromium-compatible loopback forwarder command/path while retaining the current authenticated `prepare_exit` behavior. The initial port is intentionally unchanged so regressions can be attributed precisely.

## PCMS / PCMS-alt design ports

No source code is physically copied from PCMS or PCMS-alt in the P00 baseline.

Their validated concepts are integrated into the new architecture:
- PCMS: repository/agent discipline, machine-readable plan/traceability, Provider Adapter boundary.
- PCMS-alt: stable GeneratorRef identity, reduced correctness kernel, mutation uncertainty/reconciliation, bounded shared provider backpressure, hardened module candidate activation.

Because those are rewritten specifications rather than byte-for-byte code ports, their provenance is documented in `docs/architecture/16-porting-proven-work.md`.
