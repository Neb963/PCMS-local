# ADR-003 — Updateable modules execute out-of-process

Status: Accepted  
Date: 2026-10-02

## Context

Deployer, Refresher, Explorer, Provisioning and Statistics must be independently installable/updateable after PCMS installation. Loading arbitrary updateable module code directly into pcmsd couples crash/lifecycle/authority and prevents safe candidate activation.

## Decision

A module package is an immutable self-contained `.pcmsmod` artifact. Backend code executes in a dedicated unprivileged module-runner child process and communicates with Core through a versioned bounded RPC protocol.

Module UI executes in a Core-owned web surface/iframe with the UI SDK, not by injecting backend code into the daemon.

## Security statement

This is not an adversarial sandbox. Same-user module code is operator-trusted and may use OS access available to that user outside the PCMS SDK. The supported contract still denies raw Core authority and creates a useful lifecycle/crash boundary.

## Update rule

Stage and validate a candidate before the active-version pointer changes. Permission/capability expansion requires explicit approval. Preserve last known-good package/state for rollback.
