# 11 — Backup, Restore and Portability

## 1. Three state classes

Always distinguish:
1. PCMS authoritative structured state — SQLite + immutable module/config metadata;
2. local browser Persona state — Chromium user-data directories;
3. provider-owned remote state — Perchance/GitHub/etc.

A backup result reports each class separately.

## 2. PCMS state backup

Backup archive includes:
- coherent DB snapshot;
- schema/app version;
- non-secret machine-independent config;
- installed module manifests/digests and optionally exact package artifacts;
- required artifact metadata;
- migration/manifest hashes;
- backup manifest with per-file digest.

Secret material is either:
- excluded by default and marked required-on-restore; or
- exported only through an explicit encrypted secret-backup design.

## 3. Browser profile backup

Optional and separate.

Requirements:
- Persona browser closed/quiesced;
- profile directory canonicalized beneath Persona root;
- bounded disk-space preflight;
- copy preserves required file semantics;
- backup manifest records Chromium version/profile metadata;
- no claim that copied profile is portable across arbitrary Chromium versions/platforms.

A profile may be large; automatic frequent full copies are not the default.

Incremental/snapshot filesystem techniques are deferred until measured need.

## 4. Automatic backup

Default automatic backup protects the small authoritative PCMS state and module package/config metadata.

Trigger:
- debounced after important state changes;
- periodic retention;
- pre-destructive migration/update where needed.

Destination defaults to an operator-visible local directory configurable outside the live data root.

## 5. Restore staging

Never mutate live state while parsing untrusted backup.

Flow:
1. bounded archive validation;
2. digest/manifest/schema compatibility checks;
3. restore into staging;
4. validate DB invariants/module artifacts;
5. stop mutation admission;
6. preserve safety backup of current state;
7. atomically activate new DB/config where possible;
8. enter RECOVERY_HOLD;
9. reconcile browser/persona/routes/provider operations;
10. release hold per target/global status.

## 6. RECOVERY_HOLD

After restore, overdue schedules and stale operation state do not immediately mutate providers.

Reconcile:
- Account↔Persona bindings;
- available profile directories;
- module versions;
- unresolved operations;
- route availability;
- provider identity as needed.

Unknown external state is surfaced, never synthesized healthy.

## 7. Persona portability

Exportable Persona definition contains safe PCMS metadata:
- Persona UID;
- display metadata;
- route reference semantics;
- Account binding/history references;
- browser backend/version metadata;
- profile backup reference if explicitly included.

It does not expose route private keys or imply browser profile bytes were included.

## 8. Recovery tests

Release acceptance includes:
- DB-only fresh-install restore;
- restore with installed module versions;
- wrong/corrupt/torn archive;
- unresolved operation preserved;
- missing browser profile reported;
- optional profile round trip on supported Chromium version;
- restore does not replay missed remote mutations.
