# 04 — Routing and Network Safety

## 1. Scope

PCMS-local initially reuses PersonaMonkey's Linux Mullvad router daemon because it already implements the privileged WireGuard/Mullvad routing boundary and has hardening tests/live evidence.

The daemon is not PCMS Core and does not become a generic root RPC server.

## 2. Route model

```ts
type RouteMode = 'BLOCK' | 'DIRECT' | 'PROTECTED';

interface Route {
  routeId: string;
  mode: RouteMode;
  provider?: 'mullvad';
  relay?: { ip: string; port: 1080 };
  enabled: boolean;
}
```

`DIRECT` requires explicit configuration/operation authority. Missing/disabled protected route means BLOCKED, not Direct.

## 3. Privilege boundary

`pcmsd` runs unprivileged.

The system router daemon alone may hold the capabilities required to:
- create/configure WireGuard interface;
- add scoped routes;
- use SO_BINDTODEVICE as needed;
- expose bounded local forwarders.

Its Unix control socket is accessible only to the configured desktop user/group and uses a strict request schema/size limits.

## 4. Ported baseline

The initial imported daemon, sanitizer, systemd unit and hardening tests retain their PersonaMonkey source provenance. First port should be behavior-preserving.

PCMS-specific changes are subsequent commits with regression tests.

## 5. Chromium forwarder incompatibility

PersonaMonkey's Firefox path uses SOCKS username/password authentication for local forwarders. Chromium's SOCKS5 client does not provide the same authentication path needed here.

Add a distinct daemon command, not a weakening of the Firefox-compatible command:

```text
prepare_chromium_exit
```

Properties:
- binds IPv4 loopback only;
- random ephemeral port;
- bound to one route/relay and one runtime lease/generation;
- no SOCKS authentication because Chromium cannot supply it;
- short lifetime/explicit release;
- inaccessible remotely;
- safe to recreate after pcmsd restart only after ownership reconciliation.

Same-user hostile-process protection is explicitly out of the V1 threat model. Do not describe loopback as protection from malicious processes running as the same Linux user.

## 6. Protected browser launch

Ordering:
1. validate route;
2. ensure WireGuard/base proxy ready;
3. prepare Chromium forwarder;
4. independently test forwarder egress;
5. launch Chromium with sole proxy route and no Direct fallback;
6. verify actual browser egress;
7. mark Persona route HEALTHY.

If steps fail, browser is not admitted to protected provider work.

## 7. DNS/QUIC/WebRTC

Acceptance must verify, not assume:
- destination DNS is resolved through the protected SOCKS path for ordinary browser requests;
- QUIC/UDP paths do not silently bypass the proxy;
- WebRTC does not expose/use non-proxied UDP for protected Personas under supported configuration;
- localhost control endpoints remain reachable as intentionally excluded local control traffic where required.

Exact Chromium flags/policies are capability-tested and centralized in BrowserManager. Modules never set them.

## 8. Route state

Distinguish:
- CONFIGURED;
- PREPARING;
- READY_UNVERIFIED;
- HEALTHY;
- DEGRADED;
- UNAVAILABLE;
- BLOCKED;
- UNKNOWN.

`HEALTHY` requires fresh positive evidence, not simply a configured relay.

## 9. Egress verification

Use at least:
- daemon-level relay reachability;
- external egress identity check;
- browser-level egress check for acceptance/sensitive operations.

Record redacted result:
- expected route/relay ID;
- observed provider/exit classification;
- country/city if useful;
- checkedAt/age;
- DNS evidence status.

Do not persist/log public IP more broadly than operationally needed; diagnostics may redact it.

## 10. Route loss

If protected route/forwarder becomes unavailable:
- Chromium must fail requests rather than use host Direct;
- Persona route health degrades immediately when detected;
- new sensitive operations are denied;
- in-flight side-effecting operations become FAILED_SAFE only if pre-effect failure is known; otherwise UNCERTAIN;
- recovery requires fresh verification.

## 11. Route switching

For a running Persona, safest initial policy is:
- stop mutation admission;
- quiesce/close or network-idle the browser as specified by BrowserManager;
- release old forwarder;
- prepare/verify new route;
- relaunch/reconnect browser with new immutable process proxy configuration;
- verify browser egress;
- resume.

Do not attempt dynamic proxy mutation merely to avoid a restart unless a later capability is proven safe.

## 12. Direct and Block

Direct launch has no route forwarder and is visibly marked DIRECT.

Block uses a deliberately unreachable/blackhole policy or browser launch mode proven to block network. It is not represented as a broken protected proxy because diagnostics/intent differ.

## 13. Kernel hardening deferred

Per-Persona network namespaces/cgroups/nftables could provide a stronger kernel-enforced egress boundary. They add privilege/process complexity and are not required before empirical Chromium fail-closed acceptance.

Reopen if:
- supported Chromium can bypass the sole proxy through a relevant path;
- same-user/malicious-browser threat model becomes stronger;
- routing guarantees cannot otherwise meet the PRD.
