# ADR-004 — CI-first, live-last acceptance

Status: Accepted
Date: 2026-10-02

## Context

PCMS-local is developed in a public repository. Real Perchance acceptance introduces Cloudflare behavior, account/session credentials, mutable remote state and provider availability. Real Mullvad acceptance introduces private WireGuard material and network/account state. Making either a normal phase gate would add credential-management complexity, nondeterminism and repeated live-debugging cost.

The project specifically aims to minimize fragile browser/MCP-driven development loops.

## Decision

Development phases P01–P11 are closable without MCP and without real Perchance or Mullvad credentials.

GitHub Actions is the primary acceptance environment:
- real Chromium/Chrome for Testing for browser/profile/CDP mechanics;
- a contract-focused Perchance emulator derived from recorded discovery/evidence;
- synthetic SOCKS/WireGuard/network fixtures for routing and fail-closed behavior;
- deterministic crash, timeout, response-loss, clock and recovery injection.

Real Perchance, real Mullvad and MCP are reserved for final P12 system acceptance after the implementation is otherwise release-candidate complete.

No Perchance credential, browser session/profile, Mullvad account secret or WireGuard private configuration is required in public-repository GitHub Actions.

## Evidence rule

Passing emulator/synthetic tests proves PCMS behavior against the encoded contract. It does not prove that current Perchance/Mullvad behavior still matches that contract.

P12 exists specifically to detect that final integration gap.

If P12 discovers provider/network drift:
1. record the observed discrepancy;
2. update discovery evidence and the emulator/synthetic fixture;
3. reproduce the failure in deterministic CI;
4. fix implementation;
5. make CI green;
6. rerun only the relevant final live scenario.

Do not use live MCP as the primary debugging loop.

## Consequences

Positive:
- phases can progress without external credentials/services;
- public CI remains secret-free;
- failures are reproducible;
- Cloudflare/provider availability does not block development;
- far more failure combinations can be exercised continuously;
- live testing becomes small and high-value.

Costs:
- emulator fidelity becomes an explicit maintained asset;
- real provider/network drift can remain invisible until P12;
- P12 is still required before a release can claim real-system compatibility.
