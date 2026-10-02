# ADR-002 — V1 Personas use dedicated Chromium user-data directories

Status: Accepted  
Date: 2026-10-02

## Decision

Each Persona UID owns one dedicated non-default Chromium user-data directory. PCMS launches/attaches a browser process for that directory on demand.

The directory is implementation state, not Persona identity.

## Rationale

Separate user-data directories provide natural persistence/isolation for cookies, local storage, IndexedDB, service workers and provider sessions while allowing multiple independent browser instances. Current Chrome remote-debugging security rules also require a non-default user-data directory for remote debugging, matching the design.

## Constraints

- never concurrently launch two PCMS-owned Chromium instances against the same Persona data directory;
- profile path is not a public durable identifier;
- browser version/profile compatibility must be checked and failures surfaced;
- attaching/detaching an agent must not destroy the Persona;
- dormant Persona directories remain valid without a running process.

## Deferred

Kernel-level per-Persona network namespaces are not required for the first beta unless fail-closed acceptance demonstrates a browser-layer bypass.
