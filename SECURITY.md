# Security Policy

PCMS-local handles authenticated browser sessions, credentials and network-routing state.

## Never commit

- Chromium/Chrome Persona profile directories;
- cookies/session exports;
- passwords/tokens/verification codes;
- Mullvad/WireGuard private configuration or keys;
- `.env` files containing secrets;
- live PCMS databases/backups.

The repository verifier/CI cannot prove absence of every secret. Review diffs before every push.

## Reporting

For this private-development-stage project, report security issues directly to the repository owner rather than opening an issue containing credentials or exploit-sensitive private data.

## Scope

The V1 module child-process boundary is not claimed to sandbox malicious same-user code. See `docs/architecture/10-security-secrets-human-tasks.md` and `AGENTS.md`.
