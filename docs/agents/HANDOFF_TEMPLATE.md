# Agent Handoff Template

```markdown
# Handoff — <task>

## Identity
- Task ID:
- Phase:
- Branch:
- Base main SHA:
- Latest pushed SHA:
- Owner:
- Acceptance IDs:
- Depends on tasks/commits:
- Migration IDs:
- Merge after:

## Contracts / paths
- Architecture/API/schema changes:
- Touched paths:

## Implemented
- ...

## Verification actually run
- `command` → PASS/FAIL
- CI run → PASS/FAIL/link/reference
- Live B/R/P/A/REC scenario → PASS/BLOCKED/UNTESTED

## External/remote state affected
- None / exact disposable entities
- Cleanup status:

## Known failures / risks
- ...

## Uncommitted work
- None / exact files

## Exact next step
1. ...
2. ...

## Read first
- ...
```

Never hand off meaningful unpushed changes.
