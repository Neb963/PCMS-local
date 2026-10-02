# 12 — Web UI, Local API, CLI and Agent Interfaces

## 1. One logical control surface

Human UI, CLI, modules and authorized agent/MCP clients use the same Core domain operations and invariants. There is no hidden privileged management backdoor for automation.

Different transports may expose different approved capability subsets.

## 2. Local HTTP API

Versioned under `/api/v1`.

Core concepts:
- Accounts;
- Personas;
- Routes;
- Generators/Projects;
- Operations/Runs/Batches;
- HumanTasks;
- Modules;
- schedules;
- diagnostics/search/backups.

Mutation endpoints support request IDs/idempotency keys where retry ambiguity matters and entity revision preconditions where lost updates matter.

Errors are structured:
```json
{
  "error": {
    "code": "PERSONA_ROUTE_UNAVAILABLE",
    "message": "Protected route is unavailable",
    "retryable": false,
    "operationId": "..."
  }
}
```

Stack traces/internal secrets never cross production API.

## 3. Web UI

Served by pcmsd on loopback.

Primary navigation:
- Home / Attention;
- Accounts;
- Personas;
- Generators / Projects;
- Runs / Operations;
- Modules;
- module-contributed navigation;
- Backups;
- Diagnostics;
- Settings.

Optimize for dense tables/search/forms/timelines, not decorative dashboards.

## 4. Attention

Persistent blocking work is a first-class view. Operator can answer:
- what needs me;
- why;
- what is blocked;
- which Account/Persona/operation;
- next safe actions.

Notifications complement this view; they are not the sole record.

## 5. Search

Core search covers stable local entities and safe metadata. Start with SQLite FTS or simple indexed queries only when justified by actual scale/query needs.

Search never makes display names/slugs into identity.

## 6. CLI

`pcms` CLI uses the same local API/typed client.

Initial commands:
- `pcms status`
- `pcms accounts list`
- `pcms personas list/open/close/status`
- `pcms modules list/install/update/enable/disable/rollback`
- `pcms operations list/get/reconcile/cancel`
- `pcms diagnostics`

Machine-readable `--json` is required for agents/scripts.

## 7. Agent/MCP

Do not block foundation on a bespoke MCP server. The stable local API/CLI and live Chromium DevTools endpoint already allow strong agent workflows.

Later PCMS MCP adapter should map to the same Core commands.

For browser inspection, authorized agent obtains/attaches to the existing Persona, not a disposable synthetic profile.

## 8. DevTools exposure

UI may offer "Copy agent connection" / "Open DevTools" in development/operator tools.

Never expose DevTools endpoint remotely by default. Treat it as full authenticated browser control.

## 9. Module UI

Module UI gets a scoped SDK session bound to module ID/runtime generation and approved capabilities. It cannot call arbitrary Core endpoints merely because it shares localhost origin.

## 10. Event streaming

WebSocket/SSE delivers bounded state-change notifications to UI/CLI clients. Durable truth stays in DB; clients reconnect and requery rather than relying on event replay as a journal.
