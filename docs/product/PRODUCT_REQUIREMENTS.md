# PCMS + Persona — Product Requirements Document

**Status:** Product reset / requirements baseline  
**Scope:** PCMS, Personas, Perchance management and automation  
**Document type:** Product Requirements Document  
**Purpose:** Define **what the product must do, why it exists, and for whom**. Technical architecture and implementation are explicitly outside the scope of this document.

---

# 1. Product vision

PCMS — **Perchance Central Management System** — is a local-first management system for operating many independent Perchance accounts, browser identities, generators, projects, and automated workflows from one place.

Its fundamental operating unit is the **Persona**.

A Persona represents a persistent, isolated browser identity belonging to an account. It retains the browser state necessary to behave like the same user over time and uses a defined network route.

The intended relationship is:

```text
PCMS
 ├── Accounts
 │     └── Persona
 │           ├── persistent browser identity/state
 │           ├── authenticated sessions
 │           ├── assigned network route
 │           └── browser activity
 │
 ├── Generators / Projects / Deployments
 ├── Workflows / Runs / Scheduling
 ├── Refresher
 ├── Explorer
 ├── Account Provisioning
 ├── Statistics
 └── operational management
```

The product must make managing **50+ accounts** practical without treating them as one shared browser environment.

PCMS is the management and orchestration product.

Persona is the isolation and browser-identity abstraction.

Neither concept is defined by a particular browser technology.

---

# 2. Why this product exists

Managing many Perchance accounts manually creates several problems:

- browser sessions become difficult to separate reliably;
- accounts need stable, persistent authenticated identities;
- different accounts may need different network routes;
- generator ownership and deployment state become difficult to track;
- repetitive operations need automation;
- automation must not accidentally cross account boundaries;
- failures can leave uncertain external state;
- CAPTCHA, verification codes and other human-required steps interrupt automation;
- browser debugging and acceptance testing need access to the real authenticated environment;
- scripts and automation need predictable inputs and structured results;
- recovering from browser, application or automation failures must not require reconstructing everything manually.

Previous work attempted to solve these requirements using a Firefox extension, Firefox containers, PersonaMonkey and a native routing bridge.

Those technologies are **possible implementations**, not the product definition.

The product requirement is the behavior they were intended to provide.

---

# 3. Target users

## 3.1 Primary user

A technical operator managing a large number of Perchance accounts and generators.

The operator needs to:

- inspect any account quickly;
- open its actual browser identity;
- know whether its session is authenticated;
- know which network route it is using;
- run automated operations;
- intervene when automation requires human input;
- find generators/accounts/projects rapidly;
- understand failures;
- recover from interrupted work;
- manage large batches without confusing identities.

The interface is optimized for one technically capable operator rather than a mass-market consumer audience.

## 3.2 Secondary clients

PCMS should also be operable by authorized automation clients such as:

- coding/testing agents;
- browser-control agents;
- CLI tools;
- MCP clients;
- future external management tools.

These clients must use the same logical operations and safety boundaries as the human UI.

They must not require a separate hidden management path.

---

# 4. Product principles

## 4.1 Persona is a product concept, not a browser feature

A Persona is not synonymous with:

- a Firefox container;
- a Chromium profile;
- a browser extension identity;
- a process;
- a cookie store;
- a proxy;
- a network namespace.

Those may be used to implement Personas.

The stable product concept is:

> **A Persona is a persistent and isolated browser identity, with associated browser state, account binding, routing policy, lifecycle and health.**

---

## 4.2 One active account has one dedicated Persona

The default invariant is:

```text
one active Account ↔ one dedicated Persona
```

A Persona must not normally be shared by multiple active accounts.

Controlled rebinding must exist for:

- repair;
- migration;
- Persona replacement;
- account recovery.

Binding history should remain understandable after such changes.

---

## 4.3 Account identity and network identity are separate

An Account is not an IP address.

The conceptual relationship is:

```text
Account
   ↓
Persona
   ↓
Route
   ↓
Observed network egress
```

Changing a route must not silently change which Account the Persona represents.

Changing a Persona must not silently change which Account PCMS believes is being operated.

---

## 4.4 Persistent browser identity

Closing the browser must not destroy the Persona.

Reopening a Persona should restore the same logical browser identity and its persistent state where the external provider permits it.

A user should be able to say:

> "Open Account 037"

and receive the browser environment belonging to Account 037 rather than a newly synthesized session.

---

## 4.5 Isolation is mandatory

Different Personas must not unintentionally share:

- authenticated sessions;
- cookies;
- provider local storage;
- browser identity state;
- workflow input;
- intermediate workflow state;
- secrets;
- owned tabs;
- retries;
- cancellation state;
- automation results;
- temporary files or equivalent browser-owned execution data where relevant.

A workflow running for Account A must not observe or alter Account B merely because both are executing the same workflow definition.

---

## 4.6 Human and automated use share the same Persona

Automation must operate against the same persistent Persona that the operator can open manually.

The product must not create a separate synthetic automation identity that behaves differently from the account's real browser environment.

A user should be able to:

```text
automation starts
      ↓
human opens/inspects Persona
      ↓
human resolves challenge if required
      ↓
automation continues
```

without changing account identity.

---

## 4.7 Browser implementation must be replaceable

PCMS domain state must not depend on browser-specific concepts.

The product must remain conceptually valid if engineering replaces:

- Firefox with Chromium;
- Chromium with another browser;
- an extension with a local service;
- one routing implementation with another;
- one browser-control protocol with another.

---

## 4.8 Unknown external state fails safely

Perchance and other external providers are not PCMS's database.

If PCMS cannot determine whether an external operation succeeded, it must represent that uncertainty instead of pretending success or blindly repeating the operation.

Examples include:

- account creation request timed out;
- generator creation response was lost;
- route state cannot be verified;
- browser session identity cannot be verified;
- provider API behavior changed.

---

# 5. Core product concepts

## Account

A managed external Perchance identity.

An Account contains business identity and management metadata, not its browser implementation.

---

## Persona

The persistent isolated browser identity used to operate an Account.

A Persona has:

- stable identity;
- lifecycle;
- browser state;
- account binding;
- route assignment;
- operational health;
- session observations;
- automation state.

---

## Route

The network-egress policy used by a Persona.

Examples could include protected routed access or intentionally direct access.

The implementation is outside this PRD.

---

## Generator

A Perchance generator known to PCMS.

PCMS should know:

- who owns it;
- its stable provider identity where discoverable;
- its current name/slug;
- associated project;
- observed online state;
- managed deployment state.

---

## Project

The PCMS representation of something being developed and deployed to one or more generators.

A Project may contain:

- source;
- revisions;
- development workspaces;
- deployment targets;
- deployment history.

---

## Workflow

A reusable definition of an operation.

The same Workflow may execute against many Accounts.

---

## Run

One concrete execution of a Workflow using frozen inputs and a particular set of owned resources.

Each Run is isolated.

---

## Module

An optional PCMS feature package.

Examples:

- Refresher;
- Explorer;
- Statistics;
- Account Provisioning.

PCMS should have a small stable core rather than accumulating every feature directly into the base product.

---

## Human Task

A point where an operation cannot safely continue without operator input or a decision.

Examples:

- CAPTCHA;
- email verification code;
- conflict resolution;
- uncertain provider state;
- dangerous operation approval.

Human intervention is a normal workflow state, not an exceptional product failure.

---

# 6. Persona product requirements

## PER-01 — Stable Persona identity

Every Persona must have a stable PCMS identity that does not change simply because:

- its browser is closed;
- its route changes;
- the application restarts;
- its browser implementation changes.

---

## PER-02 — Persistent state

A Persona must retain the persistent browser state required for normal provider use between sessions.

Where Perchance permits session persistence, reopening the Persona should preserve its logged-in state.

---

## PER-03 — Strong Persona isolation

Persistent state belonging to one Persona must not accidentally become visible to another Persona.

This requirement applies equally to manual browsing and automation.

---

## PER-04 — Persona lifecycle

PCMS must support at minimum:

- create;
- inspect;
- open;
- close;
- archive/retire;
- repair or replace;
- delete with explicit confirmation.

The operator must be able to distinguish active, closed, unavailable, degraded and retired Personas.

---

## PER-05 — Account binding

PCMS must explicitly display which Account is bound to each Persona and vice versa.

A conflicting binding must not be silently accepted.

---

## PER-06 — Controlled rebinding

The operator must be able to replace a damaged Persona or deliberately move an Account to another Persona.

Rebinding must be explicit and auditable.

---

## PER-07 — Dormant Personas

Managing 50+ Personas must not require all 50 browser environments to be actively running.

A closed Persona remains managed and retains its persistent state.

---

## PER-08 — Multiple active Personas

PCMS must permit multiple Personas to operate concurrently when host resources and configured policy allow it.

Their state and operations must remain independent.

---

## PER-09 — Human browser access

The operator must be able to open the actual Persona and use it normally.

The Persona is not automation-only.

---

## PER-10 — Automation access

Authorized automation must be able to operate the real Persona without creating a separate account identity.

---

## PER-11 — Live inspection

An authorized debugging or automation client must be able to inspect and interact with a running Persona without requiring the Persona to be destroyed and recreated.

Useful inspection includes the effective equivalents of:

- page state;
- DOM;
- console;
- network activity;
- storage;
- navigation;
- interaction.

The protocol used to accomplish this is an engineering decision.

---

## PER-12 — Non-destructive agent attachment

Attaching or detaching an agent must not normally close the Persona or destroy its persistent browser session.

This is an explicit requirement arising from the problems experienced with the previous live-testing environment.

---

# 7. Routing requirements

## ROUTE-01 — Persona-specific routing

Each Persona may have its own configured route.

Routing configuration belongs to the Persona, not directly to the Account record.

---

## ROUTE-02 — Explicit direct mode

Direct host networking, where permitted, must be an explicit route choice.

It must not be an accidental fallback.

---

## ROUTE-03 — Fail-closed protected routing

When a Persona requires protected routing, loss or failure of that route must not silently allow browser traffic to escape through ordinary host networking.

The product-level guarantee is:

> Browser-originated network traffic for a protected Persona uses its assigned route or is blocked.

---

## ROUTE-04 — Route health

PCMS must expose understandable route state.

At minimum the operator must be able to determine:

- intended route;
- whether it is currently usable;
- whether network egress was verified;
- whether the Persona is safe to operate.

---

## ROUTE-05 — Egress verification

PCMS must provide a way to verify actual external network identity independently of configured route metadata.

"Route configured" and "route verified" are different states.

---

## ROUTE-06 — Route transition safety

Changing routes must produce a clearly observable transition.

Operations that require a verified protected route must not begin while the Persona's routing state is uncertain.

---

# 8. Browser automation requirements

## AUTO-01 — Isolated execution

Each automation execution must have isolated:

- inputs;
- state;
- result;
- errors;
- cancellation;
- retries;
- temporary data.

---

## AUTO-02 — Structured inputs

A Workflow must be able to receive per-Run inputs without modifying the persistent Workflow definition.

---

## AUTO-03 — Secret inputs

Automation must be able to use sensitive values without treating them as ordinary workflow data.

Secrets must not appear in:

- normal logs;
- statistics;
- ordinary event payloads;
- exported diagnostic bundles;
- unrelated module state.

---

## AUTO-04 — Structured results

Automation must return machine-readable completion information.

The caller must be able to distinguish:

- success;
- provider rejection;
- browser failure;
- routing failure;
- human-input requirement;
- cancellation;
- unknown external state.

---

## AUTO-05 — Human continuation

Automation may pause for human intervention and subsequently continue the same logical operation.

Examples include:

- CAPTCHA;
- login challenge;
- email verification;
- provider confirmation.

---

## AUTO-06 — Focus

When an operation needs human interaction, PCMS must be able to lead the operator to the relevant Persona and task.

---

## AUTO-07 — Cancellation

The operator must be able to cancel an owned operation without accidentally cancelling unrelated work in the same system.

---

## AUTO-08 — Persona concurrency control

Two operations that would unsafely manipulate the same Persona at the same time must not run concurrently.

Read-only observation may coexist where safe.

---

## AUTO-09 — Recovery after interruption

If PCMS, the browser, automation controller or host process is interrupted, PCMS must reconcile the operation after restart.

It must not blindly assume that the operation failed before affecting the provider.

---

## AUTO-10 — Duplicate-side-effect protection

Where an external operation may have succeeded before its response was lost, PCMS must attempt to determine remote state before automatically repeating the mutation.

---

# 9. PCMS account management requirements

## ACC-01 — Large account inventory

PCMS must comfortably manage at least **50+ Accounts**.

---

## ACC-02 — Searchable identity

Accounts must be searchable by relevant identity and metadata.

---

## ACC-03 — Groups and tags

Accounts may be organized using groups and tags.

---

## ACC-04 — Account variables

Accounts may contain arbitrary workflow/configuration variables.

Security-sensitive or structurally important information such as credentials and Persona binding must not be reduced to untyped variables.

---

## ACC-05 — Lifecycle state

PCMS must distinguish long-term Account lifecycle from temporary operational state.

For example:

```text
Account: ACTIVE
Persona: CLOSED
Route: HEALTHY
Session: UNKNOWN
```

is meaningful.

---

## ACC-06 — Session visibility

The operator must be able to see whether PCMS believes an Account's Persona currently has a usable authenticated provider session.

Observed session state and verified provider identity must be distinguished.

---

## ACC-07 — Wrong-account protection

Before sensitive account-specific operations, PCMS must detect when the active browser/session identity appears inconsistent with the Account assigned to the Persona.

The safe outcome is to stop the operation and surface the discrepancy.

---

# 10. Generator and project management

PCMS must act as the central management system for managed Perchance generators.

## GEN-01 — Generator inventory

PCMS must maintain an inventory of managed generators and their owning Accounts.

---

## GEN-02 — Stable identity

Where Perchance exposes a stable identifier, PCMS should track the generator using that identity rather than relying solely on mutable names/slugs.

---

## GEN-03 — Project association

Generators can be associated with Projects.

---

## GEN-04 — Version history

PCMS must preserve intentional Project revisions and deployment history.

---

## GEN-05 — Development workspaces

A Project may have multiple development workspaces.

Example:

```text
Tinder Simulator
├── main
├── redesign
├── ai-test
└── monetization-test
```

---

## GEN-06 — Deployment visibility

The operator must be able to determine:

- what revision PCMS intended to deploy;
- where it was deployed;
- what PCMS currently observes remotely;
- whether remote state has drifted from intended state.

---

## GEN-07 — External edits

PCMS must detect relevant provider-side changes made outside PCMS where practical.

It must not silently overwrite uncertain external changes.

---

## GEN-08 — Backup and cloning

Managed generator/project state must support backup and intentional cloning without destroying provenance.

---

## GEN-09 — Bulk operations

Common actions should be possible across selected generators/accounts while retaining per-target isolation and reporting.

---

# 11. Workflow, scheduling and batch operation

## RUN-01 — Reusable workflows

One Workflow definition may be used across many Accounts.

Per-account differences are supplied through Account configuration and frozen Run inputs.

---

## RUN-02 — Run independence

Executing the same Workflow simultaneously for different Accounts must produce independent Runs.

---

## RUN-03 — Scheduling

PCMS must support future and recurring work.

---

## RUN-04 — Queue

Operations waiting for limited resources must be queued rather than silently dropped.

---

## RUN-05 — Batch execution

The user must be able to initiate operations across a selected set of Accounts, Personas or Generators.

Each constituent operation remains individually observable.

---

## RUN-06 — Partial failure

One target failing must not automatically corrupt or invalidate successful operations on other batch members.

---

## RUN-07 — Auditability

PCMS must retain sufficient operational history to answer:

- what was attempted;
- on which entity;
- when;
- why;
- what happened;
- whether human intervention occurred.

---

# 12. Module requirements

PCMS should maintain a small, stable core.

Higher-level policies should be implemented as independently manageable modules.

Modules must be individually enableable and disableable without rebuilding the entire product.

V1 requires the following major product modules.

---

## 12.1 Refresher

The Refresher exists to maintain desired recent-generator visibility/activity across a managed generator population.

It must support:

- configurable generator pools;
- configurable operational cohorts;
- cohorts larger than the visible recent-page capacity;
- configurable active/sleep cycles;
- automatic and manual operation;
- per-generator refresh history;
- clear confirmation of what was actually refreshed;
- safe Account/Persona allocation.

The current observed recent-page capacity of roughly 284 entries is an external provider characteristic, **not** a PCMS cohort limit.

---

## 12.2 Explorer

Explorer exists to discover and claim useful Perchance generator identities/namespaces.

It must support:

- candidate lists;
- availability checks;
- historical observations;
- claim attempts;
- Account selection/allocation;
- ownership verification;
- reservation of successfully acquired targets;
- later conversion of a claimed target into a Project Deployment.

Availability observations must not be treated as equivalent to successful ownership.

---

## 12.3 Account Provisioning

Account Provisioning exists to turn imported/new account credentials into verified, usable managed Accounts.

It must support:

- batch staging;
- duplicate detection;
- account creation/provisioning progress;
- Persona allocation;
- login;
- verification;
- human CAPTCHA/challenge handling;
- verification-code tasks;
- interrupted-flow recovery;
- authenticated identity confirmation before activation.

An Account must not become operational merely because PCMS submitted a signup form.

---

## 12.4 Statistics

Statistics exists to answer operational questions across PCMS.

Examples include:

- operation success/failure;
- Account activity;
- generator activity;
- refresh effectiveness;
- Explorer effectiveness;
- Persona usage;
- human-wait time;
- automation time.

Statistics should be derived from PCMS operational facts rather than becoming a second source of truth.

No external telemetry is required by default.

---

# 13. Attention and human intervention

PCMS must provide one central place for work requiring operator action.

Examples include:

- CAPTCHA;
- verification code;
- uncertain account identity;
- route failure;
- generator conflict;
- external-state reconciliation;
- dangerous permission request;
- failed recovery requiring a decision.

The user should immediately be able to answer:

```text
What needs me?
Why?
What is blocked?
Which Account/Persona/Run is affected?
What action can I take?
```

A transient notification alone is not sufficient for blocking work.

Required human tasks must survive a PCMS restart when the underlying operation is durable.

Sensitive one-time human input does not need to become durable history.

---

# 14. Search and navigation

With 50+ Accounts and potentially many more Generators, search is a primary product capability.

The user must be able to search across:

- Accounts;
- Personas;
- Projects;
- Generators;
- Deployments;
- Workflows;
- Runs;
- modules;
- relevant custom parameters/metadata.

Search results should lead directly to the relevant entity or action context.

Changing a display name or generator slug must not destroy the identity of stored references.

---

# 15. Diagnostics and observability

The system must expose enough state that the operator can understand why something cannot run.

Examples:

```text
Account        ACTIVE
Persona        CLOSED
Session        RESTORABLE
Route          UNAVAILABLE
Workflow       READY

Result:
Operation blocked because the required protected route is unavailable.
```