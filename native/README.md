# Ported native routing baseline

This directory initially contains a byte-identical port from PersonaMonkey at commit `9995f6eadfa54be6cc0001f4e04f2a2d9b9401bf`.

See root `PORTING_PROVENANCE.md`.

Do not rename service/config/socket paths or alter semantics during historical P000 merely for PCMS-local branding. M04 (P016–P020) owns controlled Chromium adaptation and any filesystem/service migration.

Run:

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
```

The imported tests establish the baseline only; they do not prove Chromium fail-closed routing.
