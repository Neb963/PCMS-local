# Agent Handoff Template

Use only when a session ends before normal phase closure or when another agent must continue the same phase. A normal completed phase ends with its phase report and STOP.

```markdown
# Handoff — Pxxx / Txxx.y

## Identity
- Milestone:
- Phase:
- Task ID:
- Phase status:
- Task status:
- Branch:
- Base main SHA:
- Latest published SHA:
- Owner:
- Execution mode: local-git | github-connector | mixed
- Acceptance IDs:

## Scope boundary
- Current phase objective:
- Explicit non-goals:
- Do not start:

## Implemented
- ...

## Verification actually run
- local command → PASS/FAIL/NOT AVAILABLE
- GitHub Actions run → PASS/FAIL/reference
- evidence class → U/I/B/E/N/REC/L as applicable

## Contracts / paths
- Architecture/API/schema changes:
- Touched paths:
- Migration IDs:

## External state affected
- None / exact disposable entities
- Cleanup/reconciliation status:

## Known failures / risks
- ...

## Unpublished / uncommitted work
- None, or exact recoverable location and why publication was impossible

## Exact next step inside the SAME phase
1. ...
2. ...

## Read first
- ROADMAP.md current phase
- reports/phases/<previous>.md
- ...
```

Never direct the next agent to a later phase while the current phase is incomplete.
Never claim local commands were run from a connector-only session.
