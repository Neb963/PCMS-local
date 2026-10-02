# 05 — Browser Automation and Provider Adapter

## 1. Layering

```text
Feature Module
   ↓ semantic PCMS service
PerchanceProvider
   ↓ semantic browser actions
BrowserAutomation
   ↓
BrowserDriver (Puppeteer/CDP)
   ↓
Chromium Persona
```

Modules must not duplicate Perchance selectors/protocol assumptions.

## 2. BrowserDriver

Initial implementation may use `puppeteer-core` against the already-running Persona DevTools endpoint. Browser installation/lifecycle remains BrowserManager's responsibility; Puppeteer must not create disposable automation profiles for normal PCMS operations.

BrowserDriver owns:
- connect/disconnect;
- target/page selection;
- navigation;
- DOM query/interact primitives;
- isolated/evaluated script calls where required;
- network/console observation;
- screenshots/diagnostic capture;
- storage inspection primitives needed by Core/provider;
- cancellation/timeouts.

Raw CDP sessions are internal escape hatches with explicit tests, not module API.

## 3. Provider adapter

PerchanceProvider owns:
- authenticated identity detection;
- generator identity/current slug verification;
- editor discovery;
- read/write/save semantics;
- public-state verification;
- listing/recent-page observations;
- challenge/rate-limit/provider-drift classification;
- operation reconciliation reads.

Provider-specific selectors/URLs/response shapes stay here or in versioned provider fixtures.

## 4. Capability observations

Provider/browser behaviors are timestamped evidence:
- VERIFIED;
- DEGRADED;
- UNKNOWN/STALE;
- UNAVAILABLE.

Sensitive mutation preflight rechecks stale capabilities instead of trusting startup probes.

## 5. Wrong-account protection

Before account-sensitive mutation:
- resolve Account → Persona;
- require active browser runtime;
- inspect provider session identity using the strongest current evidence;
- compare with expected Account identity;
- stop with a HumanTask/NEEDS_ATTENTION on mismatch/ambiguity.

Do not infer identity solely from a logged-in-looking page.

## 6. Timeouts and cancellation

Every BrowserDriver operation has bounded timeout and cancellation.

Cancellation semantics distinguish:
- cancelled before side effect;
- cancellation requested after side effect may have occurred;
- browser target disappeared;
- control plane lost.

Only the first can safely become FAILED_SAFE without provider reconciliation.

## 7. Human continuation

ProviderAdapter may yield:

```ts
type ProviderStepResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'human-required'; task: HumanTaskDraft; continuation: ContinuationDescriptor }
  | { kind: 'failed-safe'; error: SafeError }
  | { kind: 'uncertain'; evidence: UncertaintyEvidence };
```

Continuations are bounded, versioned operation state, not arbitrary closures serialized to disk.

When the operator completes the browser challenge, the same operation revalidates target/session/route before continuing.

## 8. Diagnostics capture

On provider drift/failure capture bounded redacted evidence:
- current URL;
- provider capability/adapter version;
- sanitized DOM/response fixture where safe;
- screenshot where safe;
- console/network error summaries;
- operation ID/persona UID.

Never include cookies, Authorization headers, passwords, verification codes or secret form values.

## 9. Agent testing

Agents may attach directly to the actual Persona for acceptance. Product automation and agent debugging share browser state but remain distinct authorities.

Acceptance reports must state:
- Persona used/disposable status;
- route mode;
- provider account/generator fixtures;
- mutations performed;
- cleanup;
- whether result was live or mocked.

## 10. Provider drift

Unknown page/API shape fails closed for mutation. Read-only parsers may return UNKNOWN rather than false certainty.

A compatibility failure should disable/degrade the narrow capability, not every unrelated Persona/module.
