# 07 — Module Package, Update and Rollback Lifecycle

## 1. Package validation

Before extraction/activation:
- archive byte limit;
- entry count limit;
- per-entry and total uncompressed limits;
- compression-ratio/zip-bomb controls;
- reject absolute paths, traversal, duplicate normalized paths, devices and unsafe links;
- require exact manifest;
- validate IDs/version/API/capabilities;
- compute SHA-256 over original package bytes;
- extract into a private staging directory.

Package bytes are immutable after digesting. Installed version paths are content/version-addressed and never edited in place.

## 2. Sources

V1 sources:
- bundled release packages;
- local `.pcmsmod` file;
- explicit HTTPS update manifest/URL;
- GitHub Releases as an official distribution mechanism.

No marketplace/account infrastructure is required.

## 3. Update metadata

An update manifest contains at least:
- module ID;
- version;
- minimum/maximum compatible PCMS module API;
- package URL;
- package SHA-256;
- optional release notes.

HTTPS alone is transport, not package identity. Exact digest is mandatory.

Package signing can be added later if distribution threat model requires it; do not implement fake/weak signing.

## 4. Candidate lifecycle

```text
DOWNLOADED
→ VALIDATED
→ STAGED
→ AWAITING_APPROVAL?   (capability expansion)
→ MIGRATING
→ HEALTHCHECK
→ READY_TO_SWITCH
→ ACTIVE
```

Failure before switch leaves current version active.

## 5. Quiesce/drain/fence

Before switching away from active version:
1. stop admission of new module-originated work;
2. request quiescence;
3. wait bounded time for local RPC/controller work;
4. fence runtime generation;
5. terminate old runtime if needed.

Remote provider work is not erased by termination because OperationCoordinator owns durable external-effect state.

## 6. State migration

Candidate migrations operate on a candidate copy/snapshot of module state.

Rules:
- old active state remains available until switch;
- candidate validation cannot mutate active namespace;
- migration functions are deterministic with bounded input/output;
- package may declare supported from-version ranges;
- migration failure leaves active state untouched.

Large artifacts are referenced, not blindly cloned.

## 7. Atomic activation

One Core DB transaction switches:
- active module version;
- active module state generation;
- approved capability envelope;
- runtime generation;
- activation metadata.

Derived process/UI runtime is reconciled after commit. If process startup after commit fails, Core may roll back via a new activation transaction to the retained prior generation; it never pretends the failed candidate is healthy.

## 8. Disable

Disable:
- closes admission;
- fences/stops runtime;
- preserves package/state;
- preserves unresolved external operations and HumanTasks;
- removes schedules owned by module from active delivery but retains desired config as defined by module.

## 9. Remove

Default remove:
- disable;
- remove active registration/package versions according to retention policy;
- keep recoverable module data unless user explicitly purges.

Purge is denied while unresolved remote operations/human tasks depend on the module unless an explicit evidence-backed abandonment workflow is performed.

## 10. Rollback

UI supports rollback to retained compatible last-known-good version/state snapshot.

Rollback is itself a new activation generation. Never reactivate a stale runtime process/generation.

## 11. Update checks

Module Manager may check configured update sources on a bounded schedule.

Automatic download is acceptable; automatic activation is allowed only when:
- package digest/manifest valid;
- API compatible;
- no capability expansion;
- module/user policy permits auto-update;
- migration/health check succeeds.

Otherwise surface attention.

## 12. Reproducibility

Official module release pipeline should build package twice in isolated jobs/environment where practical and compare exact digests, or otherwise document nondeterministic fields.

Release metadata records source commit and package hash.
