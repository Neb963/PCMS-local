# Browser automation compatibility baseline — 2026-10-03

P025 uses a narrow internal CDP client behind `BrowserDriver`; it does not add Puppeteer or expose raw CDP to modules.

| Component | Supported development/CI baseline |
|---|---|
| Node.js | 24.21.0 |
| Chrome for Testing | 154.0.8037.92 |
| Automation client | PCMS-local internal CDP-over-WebSocket transport |
| Puppeteer | not used |
| DevTools exposure | loopback-only, profile-scoped endpoint resolved by `ChromiumBrowserManager` |

Compatibility is accepted only against the repository-pinned real Chrome for Testing build in `.github/workflows/verify.yml`. The driver attaches to the browser-level WebSocket returned by the owned Persona endpoint and uses the runtime CDP methods exercised by browser acceptance tests. A Chrome/Puppeteer compatibility claim beyond this pinned matrix is intentionally not made.

This satisfies the architecture requirement to record the M06 browser automation compatibility matrix before provider automation work begins. P048–P049 remain responsible for final live-system interoperability.
