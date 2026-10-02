# 09 — Scheduler, Queue and Batch Semantics

## 1. Scope

PCMS-local needs recurring work, delayed work, bounded resource admission and batch execution. It does not need a universal workflow engine or general message broker.

Core therefore owns a small durable scheduler plus bounded in-memory dispatch queues. Modules own policy for what should be scheduled.

## 2. Durable schedule record

A schedule stores:
- schedule ID and owner module;
- operation kind/version;
- stable target selector or module-owned payload reference;
- cadence/timezone;
- enabled state;
- next due instant;
- last dispatched/last terminal child operation;
- bounded failure metadata.

Schedules contain no plaintext secrets.

## 3. Time model

Durable instants use UTC. Policies based on local calendar days store an explicit IANA timezone.

Clock safety:
- wall-clock rollback must not reopen cooldown/budget early;
- forward jumps do not replay every missed interval;
- DST 23/25-hour days are handled by timezone-aware policy logic;
- a restart recalculates the next valid due time from current durable state.

## 4. Wake-up semantics

A timer is a wake-up hint, not exactly-once delivery.

At wake:
1. load currently due schedules;
2. coalesce duplicate wakeups;
3. recompute eligibility from current state;
4. create explicit operation(s) only if still eligible;
5. advance next due metadata transactionally with dispatch intent.

Do not accumulate unbounded missed-work backlog.

## 5. Resource admission

Core exposes bounded named resources:
- active browser Persona slots;
- provider mutation concurrency;
- module runtime RPC/mailbox capacity;
- optional module-defined work concurrency.

No generic user-defined lock graph.

Waiting work has:
- bounded queue capacity;
- priority class;
- createdAt;
- cancellation;
- deadline/expiry when relevant.

Queue overflow is a structured rejection/backpressure signal, not silent dropping.

## 6. Persona concurrency

Side-effecting operations requiring the same Persona are serialized unless a specific provider operation is proven safe to overlap.

Read-only observation may coexist if BrowserManager/ProviderAdapter declares it compatible.

## 7. Batch

A batch groups independently durable child operations and aggregate progress.

The batch record is a projection/orchestration convenience:
- each child can succeed/fail/wait-human/uncertain independently;
- cancelling batch requests cancellation of eligible children;
- completed remote children are not rolled back merely because another child failed.

## 8. Fairness

Background modules must not starve operator-initiated work.

Initial priority:
1. human continuation / recovery;
2. explicit interactive user action;
3. scheduled/provider mutation;
4. background observation/statistics.

Per-module and per-account fairness prevents a large cohort from monopolizing all browser slots.

## 9. Retries

Retry policy belongs to the operation/module semantics.

Scheduler never blindly retries UNCERTAIN external mutations. Safe local/transient failures may use bounded exponential backoff with jitter.

Retry storms from provider signals are bounded by OperationCoordinator's shared provider gate.

## 10. Shutdown/restart

Pending durable schedules remain. In-memory queue items must either correspond to durable operations/schedules or be intentionally disposable observations.

On restart, rebuild admissible work from durable state; do not attempt to resurrect arbitrary closures/promises.
