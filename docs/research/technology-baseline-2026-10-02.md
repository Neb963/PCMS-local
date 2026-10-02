# Technology baseline — 2026-10-02

This note records current upstream facts used by the v0.1 architecture. Re-check before implementing browser/storage boundaries if versions materially change.

## Chromium / Chrome remote debugging

Chrome's current developer guidance states that from Chrome 136, `--remote-debugging-port` / `--remote-debugging-pipe` are not honored against the default Chrome data directory and must be paired with a non-standard `--user-data-dir`. This aligns with PCMS-local's dedicated Persona user-data directory.

Source: https://developer.chrome.com/blog/remote-debugging-port

Chromium documents separate user-data directories as a way to run parallel isolated browser instances.

Source: https://www.chromium.org/developers/creating-and-using-profiles/

## Node SQLite

Node.js 24.21 documentation marks `node:sqlite` stability 1.2 (release candidate). PCMS-local therefore keeps SQLite behind an internal adapter and pins the Node runtime used by a release rather than exposing `node:sqlite` types throughout domain contracts.

Source: https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html

## Browser automation

Puppeteer/Core or a comparable CDP client is an implementation choice behind BrowserDriver. Modules/provider policy do not depend on Puppeteer APIs directly.

Before P03/P06 implementation, record the exact supported Chromium/Chrome and Puppeteer/CDP compatibility matrix in a dated research update.
