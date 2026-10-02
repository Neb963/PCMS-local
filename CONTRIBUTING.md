# Contributing / Agent Workflow

Read `AGENTS.md` first.

The canonical implementation plan is `docs/implementation/v0.1/plan.json`.

Typical bootstrap checks:

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npm test
npm run verify:repo
npm run verify:port
```

GitHub Actions is a first-class independent verification surface and is not usage-budget constrained. Do not use that as an excuse to skip focused local testing.

Never use real production browser profiles, credentials or WireGuard private configs in repository tests.
