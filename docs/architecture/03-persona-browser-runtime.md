# 03 — Persona and Chromium Browser Runtime

## 1. Product abstraction

`PersonaUid` is the durable identity. V1's Chromium implementation is a backend.

```ts
interface PersonaRuntimeDescriptor {
  personaUid: string;
  backend: 'chromium-v1';
  state: 'CLOSED' | 'STARTING' | 'RUNNING' | 'DEGRADED' | 'STOPPING' | 'UNAVAILABLE' | 'RETIRED';
}
```

Raw PIDs, DevTools endpoints, process start times and proxy ports are runtime-only.

## 2. Profile ownership

Default root:

```text
~/.local/share/pcms-local/personas/<personaUid>/chromium/
```

Rules:
- exactly one PCMS-owned active browser instance per Persona profile root;
- profile root must be beneath the configured Persona root after canonicalization;
- PCMS does not reuse the operator's ordinary default Chrome/Chromium profile;
- a Persona directory is never auto-recreated over an unexpected nonempty incompatible path;
- delete is explicit and staged; retirement is preferred over destructive deletion.

## 3. Browser choice

Support an explicitly configured Chromium-compatible binary with capability probing. Initial Fedora targets:
- Chromium;
- Chrome/Chrome for Testing where explicitly selected.

Do not branch domain behavior by browser marketing name. BrowserManager records executable path/version and capability observations.

Remote debugging must use a non-default user-data directory. This is also required by modern Chrome remote-debugging hardening and matches PCMS isolation.

## 4. Launch contract

BrowserManager constructs arguments from typed configuration, never concatenated shell strings.

Typical capabilities:
- dedicated `--user-data-dir`;
- dynamically selected or browser-selected DevTools endpoint;
- explicit proxy configuration for protected routing;
- no Direct fallback in protected mode;
- resolver/QUIC/WebRTC hardening required by routing acceptance;
- first-run/default-browser prompts suppressed where documented/supported.

Do not accept arbitrary user/module command-line switches into the production launcher without validation; they can defeat isolation/routing.

## 5. DevTools endpoint

Prefer a race-free mechanism:
- launch with supported dynamic remote-debugging port behavior;
- discover the endpoint from Chromium's profile-scoped `DevToolsActivePort` or an equivalent documented mechanism;
- verify the endpoint belongs to the launched process/profile before exposing a BrowserSession.

Listening address is loopback only.

DevTools capability is equivalent to full control of the authenticated Persona and is therefore never exposed on LAN/Tailscale by default.

## 6. Browser state machine

```text
CLOSED
  → STARTING
      → RUNNING
      → DEGRADED
      → CLOSED/UNAVAILABLE
RUNNING/DEGRADED
  → STOPPING
      → CLOSED
```

Start is idempotent:
- if a healthy owned instance already exists, return it;
- if state is stale but a matching process/DevTools endpoint is provably owned, reconcile;
- if ownership is ambiguous, fail closed rather than attach to an unrelated browser.

## 7. Process ownership and crash recovery

Persist only enough runtime evidence to reconcile safely (for example last known pid/start fingerprint), not to treat a PID as identity.

On pcmsd restart:
- inspect recorded RUNNING/STARTING Personas;
- validate process executable/profile/endpoint ownership;
- reconnect when safe;
- otherwise mark CLOSED/DEGRADED and reconcile affected operations.

A browser crash never deletes/replaces the Persona profile automatically.

## 8. Manual and automated coexistence

The operator opens the same browser instance automation uses.

Concurrency rules:
- read-only observation can coexist;
- side-effecting automation holds Persona/target operation authority through Core;
- human intervention may temporarily take control of the visible Persona while the owning operation is WAITING_HUMAN;
- arbitrary concurrent mutating workflows against the same Persona are denied/queued.

## 9. Agent attachment

Core exposes a controlled way to obtain/bridge the current DevTools endpoint to an authorized local agent.

Requirements:
- attach does not relaunch browser by default;
- detach does not close browser;
- endpoint lifetime/ownership is observable;
- diagnostic API reports enough context for the agent to select the correct Persona without exposing secrets;
- agent activity is auditable at the PCMS operation/session level where invoked through PCMS.

Direct localhost DevTools access by trusted development tooling remains possible in development mode; production UI should not make users reason about ports.

## 10. Close semantics

Graceful close requests Browser.close or equivalent, then bounded wait, then signal escalation only for the known owned process tree.

Closing:
- preserves user-data directory;
- releases runtime route forwarder after browser networking is stopped;
- marks session observation stale rather than claiming logout;
- reconciles active operations.

## 11. Delete/repair/replacement

Retire is non-destructive to history.

Destructive profile deletion:
- requires explicit confirmation;
- browser closed;
- no unresolved operation/human task using it;
- optional backup decision recorded;
- filesystem deletion constrained to the Persona root.

Replacement/rebind creates a new Persona UID unless the operation is explicitly a repair of the same logical Persona with documented state migration.

## 12. Resource controls

Configurable maximum active Personas. Admission considers:
- configured cap;
- memory pressure telemetry when available;
- operation priority;
- already-running human sessions.

Never kill an active Persona merely to satisfy a new background batch without policy/ownership.
