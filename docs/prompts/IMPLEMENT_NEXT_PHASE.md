# Prompt — Implement the next READY phase

```markdown
Repository: https://github.com/Neb963/PCMS-local

Implement exactly the one phase currently marked READY in ROADMAP.md / docs/implementation/v0.1/plan.json.

Follow AGENTS.md exactly.

First determine your repository access mode:
- local Git workspace; or
- cloud/GitHub connector.

Do not assume local git/shell access when only the GitHub connector is available. GitHub is the source of truth and published-state durability boundary.

Read ROADMAP.md, the current phase, linked architecture specs, its acceptance gates and the previous phase report. Work only that phase. Do not pull work from its successor.

The phase is already structurally sized for one bounded cloud-agent session (empirical target roughly 20–30 minutes); do not self-time. If evidence shows the phase is materially oversized, stop at a coherent checkpoint and split remaining scope according to AGENTS.md rather than grinding through it.

For each task:
- mark progress;
- implement the smallest coherent slice;
- add/update tests;
- run actually available focused verification;
- fix failures;
- review changes;
- commit/publish the checkpoint to GitHub.

Use GitHub Actions freely. In connector-only mode, Actions may provide executable verification that a local shell cannot.

When the phase passes:
- finalize reports/phases/Pxxx.md;
- mark this phase COMPLETE;
- mark only the immediate successor READY;
- update ROADMAP.md, plan.json and STATUS.md;
- publish the closure;
- STOP.

Do not implement the successor phase in this session.
```
