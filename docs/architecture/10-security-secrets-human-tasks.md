# 10 — Security, Secrets and Human Tasks

## 1. Threat model

V1 is a local single-operator tool. Primary threats:
- accidental cross-Persona/account actions;
- credential/session leakage;
- unsafe provider retries;
- malicious/corrupt module update;
- local web/API exposure;
- path/archive injection;
- routing fallback;
- privilege creep into pcmsd;
- same-user accidental access.

Host/root compromise and hostile same-user code are not fully defended by V1. Do not claim otherwise.

## 2. Local API exposure

Default bind: loopback only.

Browser UI authentication uses a per-install high-entropy local token/session bootstrap or an equivalent same-origin mechanism that prevents arbitrary websites from calling PCMS APIs.

Requirements:
- reject non-loopback bind unless explicit advanced configuration;
- strict Origin/Host handling;
- CSRF defense for cookie/session-based calls;
- WebSocket origin/auth validation;
- no secrets in query strings;
- bounded request bodies;
- rate limits for sensitive endpoints.

## 3. SecretStore

Secrets are opaque references in ordinary DB/domain/module records.

Initial preferred implementation:
- Linux Secret Service/libsecret-compatible desktop credential store if reliably available;
- otherwise a clearly marked explicit fallback design must be accepted before implementation.

Never silently fall back to plaintext SQLite/config storage.

Secret categories:
- Account credentials;
- GitHub tokens;
- provider API tokens if introduced;
- module-scoped secrets.

Browser cookies/session storage remain browser-owned profile state, not extracted into SecretStore by default.

## 4. Secret release

A module declares approved secret scope. Core resolves a SecretRef only at the narrow operation step that needs it.

Secret bytes:
- are not logged;
- are not included in module storage/history/statistics;
- are not echoed in errors;
- are not returned to module UI;
- are zeroed/bounded best-effort in memory where language/runtime permits.

Same-user Node process memory is not a hardware security boundary; minimize lifetime/exposure.

## 5. HumanTask

Durable HumanTask fields:
- task ID;
- type;
- status;
- account/persona/operation refs;
- safe title/explanation;
- required action kind;
- created/updated/expiry;
- continuation descriptor reference;
- safe evidence.

Task types include:
- CAPTCHA/challenge;
- verification code required;
- wrong/unknown account identity;
- uncertain remote state;
- route failure;
- destructive confirmation;
- module permission expansion;
- migration/recovery conflict.

## 6. Sensitive human input

Verification codes/passwords/challenge values are transient inputs:
- request scoped;
- expiry;
- single-consumer where appropriate;
- never normal task/event payload;
- lost on restart unless explicit secure persistence is a real requirement.

A durable task may survive restart while asking the operator to re-enter a one-time value.

## 7. Destructive actions

Require explicit confirmation for:
- Persona/profile deletion;
- account destructive provider actions;
- module data purge with unresolved work;
- restore that replaces current state;
- abandonment of UNCERTAIN operation;
- Direct mode where policy marks it sensitive.

Batch destructive confirmation must show scope/count.

## 8. Module package trust

Update package digest and capability delta are shown/recorded. Official packages still pass the same validation path.

No dynamic install-time scripts.

Future package signatures may provide publisher authenticity; V1 digest alone provides integrity against expected release metadata, not author identity.

## 9. Logging/redaction

Structured logs allowlist safe fields. Never log:
- cookies;
- auth headers;
- passwords;
- verification codes;
- WireGuard private keys;
- forwarder tokens;
- full browser profile paths if they reveal unnecessary host data;
- raw provider responses containing secrets.

## 10. Privileged routing separation

pcmsd/module processes do not run root or receive NET_ADMIN. System service unit remains capability-bounded and filesystem-restricted.

## 11. CAPTCHA

PCMS supports pausing/focusing/resuming after human completion. Automated CAPTCHA bypass/solving is explicitly outside product scope.
