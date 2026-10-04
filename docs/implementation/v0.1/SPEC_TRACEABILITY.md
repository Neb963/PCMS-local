# Specification Traceability

The Product Requirements document is authoritative. This view maps requirement families to engineering contracts and implementation milestones/session phases.

| Product area | Architecture specs | Primary implementation ownership |
|---|---|---|
| Persona stable identity/persistence/isolation/lifecycle | 00, 02, 03, 12, 14 | M03 / P012–P015; inventory integration M05 |
| Account↔Persona binding / wrong-account protection | 02, 03, 05, 17 | M05 / P021–P024; provider admission M06 |
| Routing / fail-closed / egress verification | 04, 14, 16 | M04 / P016–P020; hardening P047; live P048 |
| Browser automation / human continuation | 03, 05, 08, 10, 12 | M06 / P025–P029 |
| Durable operations / uncertainty / duplicate effects | 08, 09, 14 | M06 / P027–P029; hardening M11 |
| Accounts/search/50+ inventory | 02, 12, 17 | M05 / P021–P024 |
| Generators/projects/deployment | 02, 05, 08, 17 | M05 + M07 / P030–P033 |
| Workflow/scheduling/queue/batch | 08, 09, 17 | P029; generic workflow extraction deferred pending concrete common semantics |
| Modules / independent user updates | 06, 07, 10, 12 | M02 / P006–P011 and feature-module phases |
| Refresher | 08, 09, 17 | M08 / P034–P036 |
| Explorer | 08, 17 | M09 / P037 |
| Account Provisioning | 05, 08, 10, 17 | M09 / P038–P040 |
| Statistics | 14, 17 | P041 |
| Attention / notifications | 10, 12 | P028, P043 |
| Backup/recovery | 02, 11, 14 | M10 / P041–P043; P046 |
| Privacy/security | 04, 10, 14, 15 | all; release hardening P046–P047 |
| Agent usability | 03, 12, 14 | P015, P047; live MCP P048 |
| Simple setup/use | 13, 15 | M01 foundation; installer P044 |
| 50+ scale / bounded resources | 02, 03, 09, 14 | P024, P045 |
| CI/release | 14, 15 | P001, P047; final live P048–P049 |

## Important scope decision

The PRD's Full V1 includes reusable Workflows, Projects/workspaces and scheduling. Scheduling/batch foundations are implemented in P029. A generic Workflow graph/runtime was intentionally not front-loaded: concrete Deployer/Provisioning/Refresher operation plans first demonstrated the semantics actually shared by those features.

P043 resolved the v0.1 scope decision in `FULL_V1_GAP_LEDGER.md`: the v0.1 hardening/acceptance roadmap is not a Full V1 completeness claim. Requirements classified PARTIAL or DEFERRED remain binding post-v0.1 Full-V1 work and must be closed by a future roadmap/product decision before any release is labeled Full V1.

## Acceptance strategy

P001–P047 prove implementation behavior with deterministic evidence, real Chromium, the Perchance emulator and synthetic networking. P048–P049 validate only the external compatibility assumptions that those fixtures cannot prove: MCP interoperability, real Mullvad behavior and current real Perchance behavior.
