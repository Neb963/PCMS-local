# Specification Traceability

The Product Requirements document is authoritative. This view maps requirement families to engineering contracts and phases.

| Product area | Architecture specs | Primary phase(s) |
|---|---|---|
| Persona stable identity/persistence/isolation/lifecycle | 00, 02, 03, 12, 14 | P03, P05 |
| Account↔Persona binding / wrong-account protection | 02, 03, 05, 17 | P05, P06 |
| Routing / fail-closed / egress verification | 04, 14, 16 | P04, P11 |
| Browser automation / human continuation | 03, 05, 08, 10, 12 | P06 |
| Durable operations / uncertainty / duplicate effects | 08, 09, 14 | P06, P11 |
| Accounts/search/50+ inventory | 02, 12, 17 | P05 |
| Generators/projects/deployment | 02, 05, 08, 17 | P05, P07 |
| Workflow/scheduling/queue/batch | 08, 09, 17 | P06; generic workflow extraction deferred until concrete evidence |
| Modules / independent user updates | 06, 07, 10, 12 | P02 and all module phases |
| Refresher | 08, 09, 17 | P08 |
| Explorer | 08, 17 | P09 |
| Account Provisioning | 05, 08, 10, 17 | P09 |
| Statistics | 14, 17 | P10 |
| Attention / notifications | 10, 12 | P06, P10 |
| Backup/recovery | 02, 11, 14 | P10, P11 |
| Privacy/security | 04, 10, 14, 15 | all; release P11 |
| Agent usability | 03, 12, 14 | P03, P11 |
| Simple setup/use | 13, 15 | P01 dev path, P11 release installer |
| 50+ scale / bounded resources | 02, 03, 09, 14 | P05, P11 |

## Important scope decision

The PRD's Full V1 includes reusable Workflows, Projects/workspaces and scheduling. Scheduling/batch foundations are implemented in P06. A generic Workflow graph/runtime is intentionally not front-loaded: concrete Deployer/Provisioning/Refresher operation plans must first demonstrate common semantics. P10 owns the explicit Full-V1 gap decision and may add an ADR/phase amendment rather than silently omit a requirement.


## Acceptance strategy

Implementation ownership remains in P01–P11, but real external-system validation is consolidated in P12.

P01–P11 prove behavior with real Chromium plus Perchance emulator/synthetic network fixtures. P12 validates only the remaining external compatibility assumptions against real Perchance, Mullvad and MCP.
