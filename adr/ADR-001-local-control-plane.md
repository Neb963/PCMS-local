# ADR-001 — PCMS-local is a local Linux control plane

Status: Accepted  
Date: 2026-10-02

## Context

The Firefox-extension implementation made browser-specific extension capability and live MCP behavior a prerequisite for unrelated product development. PCMS is fundamentally a local operator control plane, not a browser-extension product.

## Decision

Implement Core as an unprivileged local Linux service (`pcmsd`) with a local Web UI/CLI/API. Do not require a browser extension for foundation capabilities.

Retain a separate privileged routing daemon only because host WireGuard/route operations require privileges that Core should not hold.

## Consequences

Positive:
- ordinary filesystem/process/SQLite primitives;
- straightforward Chromium/CDP testing;
- simpler backup, modules and installation;
- browser crashes do not erase Core;
- agents can attach to real persistent sessions.

Costs:
- native packaging/service lifecycle becomes product scope;
- localhost API must be authenticated/loopback-confined;
- browser and daemon process reconciliation is required.
