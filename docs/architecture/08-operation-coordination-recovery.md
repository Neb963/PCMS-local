# 08 — Operation Coordination, External Effects and Recovery

## 1. Why this is Core

Remote mutations are not transactional with SQLite or browser state. Multiple modules may mutate the same Perchance target. Correctness must survive module/browser/pcmsd crashes.

Therefore Core owns one small OperationCoordinator. It is not a general workflow engine.

## 2. Stable target keys

Examples:
- `perchance:generator:<generatorLocalId>`
- `perchance:account:<accountId>`
- `persona:<personaUid>:control`

Target keys use PCMS stable IDs, never mutable slug/email.

## 3. State machine

```text
PREPARED
  → RUNNING
      → VERIFYING
          → SUCCEEDED
          → FAILED_SAFE
          → UNCERTAIN
PREPARED → CANCELLED
UNCERTAIN → VERIFYING → SUCCEEDED | FAILED_SAFE | NEEDS_HUMAN
```

Terminal local cancellation after a remote side effect may have occurred is not `CANCELLED`; it is `UNCERTAIN`.

## 4. Admission record

Persist before first possible side effect:
- operation ID/idempotency key;
- owner module/version/runtime generation;
- actor/user source;
- stable target key;
- operation kind/schema version;
- Persona/account IDs;
- desired fingerprint/provenance;
- precondition observations and ages;
- attempt number;
- claim epoch;
- timestamps.

Never fingerprint secret bytes into logs/state; reference opaque secret/input identities.

## 5. Target claims

At most one unresolved unsafe mutation claim per target key.

Claim has monotonic epoch. Every side-effecting step validates current claim/operation ownership immediately before dispatch.

Different read-only observations may coexist.

## 6. Provider admission

A minimal ProviderGate inside OperationCoordinator tracks:
- bounded global/provider mutation concurrency;
- optional account/Persona scope;
- cooldown/circuit observations after rate-limit/challenge/outage.

This is not a scheduler. It prevents retry storms across modules.

Unknown rate-limit scope defaults conservatively wider until evidence narrows it.

## 7. Fresh prerequisites

Immediately before mutation require current-enough:
- target/provider identity;
- Account↔Persona binding;
- browser ownership;
- session identity;
- route/effective egress;
- provider capability.

A long queue wait invalidates earlier preflight observations.

## 8. Verification

After side effect:
- perform read-first verification appropriate to operation;
- only then mark SUCCEEDED;
- provider explicit rejection known before effect can be FAILED_SAFE;
- ambiguous network/browser/pcmsd loss becomes UNCERTAIN.

## 9. Restart bootstrap

On pcmsd startup:
- any nonterminal operation that could have dispatched a side effect is classified conservatively;
- `RUNNING`/`VERIFYING` become/re-enter UNCERTAIN unless durable evidence proves no dispatch;
- claims remain blocking;
- module/browser handles are not treated as outcome evidence;
- reconciliation is scheduled/brought to HumanTask as appropriate.

No missed mutation backlog is blindly replayed.

## 10. Module update/disable

Operation record outlives module runtime. A new compatible module version may reconcile an older operation through a versioned reconciliation contract, or the system requires the retained old adapter/module or human intervention.

Do not purge provenance needed to resolve uncertainty.

## 11. Batch operations

A batch is an orchestration/view grouping of independent child operations.

Partial failure does not roll back already successful remote children unless the provider explicitly supports a safe compensating action.

Each child has its own target claim/result.

## 12. Cancellation

Cancellation:
- stops future local steps;
- signals BrowserDriver/module;
- records cancellation request;
- does not assert remote rollback.

If side effect may have occurred, final state follows verification/uncertainty doctrine.

## 13. Retention

Keep operational history long enough for audit/statistics while bounding DB growth:
- terminal operation detail retention configurable;
- compact summaries may outlive verbose diagnostics;
- unresolved/uncertain records are never age-purged automatically.

## 14. Exactly-once statement

PCMS does not claim exactly-once external mutation. It provides durable operation identity, target exclusion, verification and reconciliation to make duplicate effects unlikely and observable under the supported provider contract.
