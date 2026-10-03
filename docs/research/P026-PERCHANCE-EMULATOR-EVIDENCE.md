# P026 Perchance emulator evidence baseline

Status: implementation evidence for the deterministic P026 emulator. This document is not a live-compatibility claim.

## Source boundary

PCMS-local architecture is authoritative. The emulator model also uses sanitized provider observations already retained in the predecessor PCMS research package, principally the disposable-account discovery dated **2026-09-28**:

- `docs/specs/v0.11/discovery/perchance-account-provisioning-2026-09-28/PERCHANCE_ACCOUNT_PROVISIONING_DISCOVERY.md`
- `docs/specs/v0.11/discovery/perchance-account-provisioning-2026-09-28/evidence/NETWORK_SUMMARY.json`
- `docs/specs/v0.11/discovery/perchance-account-provisioning-2026-09-28/evidence/MANUAL_OBSERVATIONS.md`
- `docs/specs/v0.11/14-provider-architecture.md`

Those files are provenance input only. P026 does not copy predecessor runtime code and does not contact real Perchance.

## Observations treated as verified compatibility evidence

The retained 2026-09-28 discovery established the following narrow facts for the tested profile:

1. `POST /api/getGeneratorsByUser` uses the fields `email` and `sessionToken`.
2. A valid authenticated session can return HTTP 200 JSON `status=success` with `generators=[]` and `generatorFolderMap={}`; zero generators is therefore a valid positive session probe.
3. Perchance account comparison was observed to be ASCII case-insensitive for the tested authentication/session path. Whitespace, Unicode folding and mailbox-alias equivalence were not established.
4. A mismatched email with a valid session, and a valid email with an invalid session, produced `session-token-error` through the separately observed ownership probe.
5. Provider/perimeter HTML must not be interpreted as Perchance application JSON.
6. Earlier retained provider research identifies `publicId` as the preferred stable generator identity while the public slug/name is mutable.

P026 preserves the architectural rule that a provider page-local identity hint is not sufficient by itself: sensitive decisions require compatible server-backed evidence.

## Explicit emulator modeling assumptions

The emulator must exercise failure handling that cannot safely depend on live services. The following are deterministic test-model choices, not claims that current Perchance necessarily emits these exact responses:

- For a non-zero account list, the emulator represents a generator as `{generatorName, publicId}`. P026's adapter normalizes a bounded set of historical aliases rather than elevating this one fixture shape into a permanent provider contract.
- The emulator returns `session-token-error` for an invalid `email`/session pair on `getGeneratorsByUser`. The equivalent pairing rejection was directly observed on `checkGeneratorOwnership`; this endpoint-specific behavior remains a modeled assumption until P049 live acceptance.
- `UNKNOWN_STATUS`, `MALFORMED_SUCCESS`, `HTTP_ERROR` and `PERIMETER_HTML` are named synthetic fault-injection scenarios. They exist to prove fail-closed behavior and are not provider-behavior assertions.
- Generator rename/stable-ID replacement are controlled state mutations inside the emulator. They model the architectural invariant “stable provider ID vs mutable slug,” not a claim about an undocumented remote mutation endpoint.

## Secret/evidence hygiene

Fixture session tokens are synthetic. The emulator request ledger records only whether session material was present; it never records the token. Provider adapter outputs and phase evidence must likewise exclude session tokens and raw provider response bodies.

## Deferred live questions

Real Perchance compatibility, current page/session-store extraction details, non-zero owned-generator response shape, and final live account/read behavior remain reserved for P049. If P049 observes drift, that drift must first be encoded into deterministic fixtures before production logic is changed.
