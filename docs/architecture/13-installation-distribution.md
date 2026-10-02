# 13 — Installation, Distribution and Host Integration

## 1. UX objective

Normal setup should be close to:
1. download PCMS-local release;
2. run installer/package;
3. open PCMS Local from desktop;
4. first-run diagnostics detect Chromium;
5. optionally import/install Mullvad WireGuard configs for protected routing;
6. create first Persona.

The operator should not install npm/pnpm or hand-configure ports/services.

## 2. Packaging

Fedora/Linux first.

Preferred release layout bundles:
- pcmsd application;
- Web UI static assets;
- CLI;
- module-runner;
- pinned Node runtime compatible with the release;
- bundled default module `.pcmsmod` artifacts;
- installer/uninstaller/update metadata;
- checksums.

Do not package Chromium itself initially; detect system Chromium/Chrome and show supported/observed version. Chrome for Testing may be used for deterministic CI.

## 3. Paths

User-owned:
- `~/.local/share/pcms-local`
- `~/.config/pcms-local`
- `~/.cache/pcms-local`
- `~/.local/bin/pcms` or desktop integration
- user systemd unit where chosen.

Privileged router:
- `/usr/local/lib/pcms-local-router` or compatibility path accepted by port plan;
- `/etc/pcms-local-router`;
- `/run/pcms-local-router`;
- system service.

The initial router port may temporarily retain PersonaMonkey filesystem/service names for behavior-preserving reuse; rename only through a dedicated migration phase.

## 4. User service

pcmsd should run as a systemd user service for reliable restart/logging, but manual foreground mode is supported for development.

Service:
- no root;
- private-ish umask;
- restart on failure with bounded restart policy;
- explicit environment/config path;
- graceful SIGTERM.

## 5. Desktop entry

Desktop launch opens/starts pcmsd and the local UI in the user's browser. Do not require a separate heavyweight desktop-shell runtime.

## 6. First-run diagnostics

Show:
- data/config paths;
- DB health/schema;
- Chromium binary/version/capabilities;
- route daemon status;
- WireGuard tooling/config status;
- module runtime/API status;
- local API bind/auth state.

Protected routing setup may be deferred; PCMS remains usable while PROTECTED routes are unavailable.

## 7. Upgrades

Core upgrade:
- verify release checksum/signature if introduced;
- preserve data/profile/module dirs;
- safety backup before irreversible DB migration;
- install candidate atomically where packaging permits;
- restart user service;
- health check;
- rollback binary on failure when schema compatibility allows.

Module updates remain independent through ModuleManager.

## 8. Uninstall

Default uninstall removes application/service integration but preserves user data unless explicit `--purge-data`.

Router uninstall is separate/destructive because it affects privileged service/config.

Never delete browser profiles or WireGuard configs silently.

## 9. Offline/reproducible setup

Release should not require network-time package manager execution beyond downloading the release itself, except optional router dependency installation documented explicitly.

Build/release CI produces hashes/SBOM where practical.
