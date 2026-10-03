# P034 — Refresh emulator contract evidence

Status: implementation evidence for the deterministic P034 refresh/recent contract. This document is **not** a live Perchance compatibility claim.

## Authority and source boundary

PCMS-local product requirements, accepted architecture and the v0.1 acceptance matrix are authoritative for P034.

The deterministic model also uses retained research from the predecessor `Neb963/PCMS` repository at commit `9a753c8c8e1f97f76b88d32e2dcec4a72ca50560` as provenance input. Relevant retained sources are:

- `docs/specs/v0.11/15-intelligent-refresher.md`
- `docs/specs/v0.11/14-provider-architecture.md`
- `src/core/providers/perchance/generators.ts`
- `src/first-party-packages/refresher/marker-strategy.ts`

PCMS-local did not copy predecessor runtime implementation for P034. The predecessor material is used to identify previously researched semantics and uncertainty boundaries, consistent with `docs/research/P026-PERCHANCE-EMULATOR-EVIDENCE.md`.

## Narrow evidence-backed semantics

P034 encodes only the following semantics:

1. The public `/generators` surface was retained as a "recently updated" page observation, but the retained evidence does not establish a stable dedicated recent-page API.
2. The historical `/api/getGeneratorList` capability is not treated as the recent-page observation. Public/library listing and recent visibility remain separate semantic capabilities.
3. A refresh is modeled as an ordinary provider save/deploy of exact source bytes, not as an invented dedicated "refresh" endpoint.
4. The retained refresh design uses a bounded inert marker transform on `main.pjs` and `index.html`, with the same marker token on both surfaces:
   - `// pcms-refresh-marker:v1:<token>`
   - `<!-- pcms-refresh-marker:v1:<token> -->`
5. Provider-confirmed save/deployment and public recent-page appearance are separate facts. A save may be confirmed while the recent effect is still pending.
6. Absence from a recent observation is meaningful only when the semantic contract is recognized and the observation is complete. Unknown shape, wrong semantic surface, or incomplete observation cannot prove absence.

These are the minimum semantics needed before P035 can add scheduling/cohort policy.

## Explicit emulator-only modeling choices

The following are deterministic test-model choices and **not** claims about current Perchance wire formats, URLs, timing or DOM structure:

- `/__pcms_emulator__/observations/public-listing`
- `/__pcms_emulator__/observations/recent`
- `/__pcms_emulator__/observations/refresh-effect`
- fixture `contractVersion: 1`
- the exact JSON envelope fields returned by those routes
- `publishRefreshEffect(publicId)`, which deterministically advances a pending refresh effect into recent visibility
- deterministic recent ordering/rank inside the emulator
- the named `COMPATIBILITY_DRIFT` scenario and its synthetic future shapes

Those routes are internal semantic fixture surfaces. Production logic must not assume Perchance exposes them.

## Parser and compatibility rule

`src/providers/perchance-refresh-contract.ts` normalizes the semantic fixture boundary.

Recognized public-library, recent and refresh-effect contracts return `compatibility = VERIFIED`. Unknown versions, malformed shapes, contradictory counts or a semantic surface passed to the wrong decoder return `compatibility = UNKNOWN`.

For recent observations, `credibleAbsence` is true only for a recognized complete observation. A recognized but incomplete observation preserves any positive items it did observe while explicitly refusing absence authority.

This is deliberately fail-closed: compatibility drift does not become "empty recent page" or successful refresh confirmation.

## Secret and evidence hygiene

All session material used by tests is synthetic. The emulator request ledger records only whether session material was present and never records its value. P034 fixtures contain no real credentials, cookies, provider response bodies, browser profiles or account secrets.

No live Perchance request, MCP session or real Mullvad route is used in P034.

## Deferred live questions

P034 does not establish:

- the current Perchance recent-page DOM structure;
- a current dedicated recent-page API;
- current provider timing between save confirmation and recent-page appearance;
- the current public/library-list response shape;
- current live operational safety of the marker strategy on every generator class.

Current external compatibility remains a P049 live-acceptance question. If live acceptance observes drift, the provider observation must first be sanitized into deterministic evidence/fixtures and the contract regression reproduced in CI before production parsing or policy is changed.
