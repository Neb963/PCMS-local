import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import importlib.util


ROOT = Path(__file__).resolve().parents[1]
SERVICE = ROOT / "native" / "persona-mullvad-router.service.in"
SANITIZER_PATH = ROOT / "native" / "sanitize_configs.py"
SPEC = importlib.util.spec_from_file_location("sanitize_configs", SANITIZER_PATH)
sanitizer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sanitizer)
ROUTER_SPEC = importlib.util.spec_from_file_location("routerd_private_files", ROOT / "native" / "routerd.py")
router = importlib.util.module_from_spec(ROUTER_SPEC)
ROUTER_SPEC.loader.exec_module(router)


CONFIG = """[Interface]
PrivateKey = PRIVATE-KEY-SENTINEL
Address = 10.64.0.2/32

[Peer]
PublicKey = PUBLIC-KEY
AllowedIPs = 0.0.0.0/0
Endpoint = 192.0.2.1:51820
"""


class NativeServiceHardeningTests(unittest.TestCase):
    def test_systemd_unit_has_bounded_capabilities_and_sandbox(self):
        lines = [line.strip() for line in SERVICE.read_text(encoding="utf-8").splitlines()]
        directives = {line.split("=", 1)[0]: line.split("=", 1)[1] for line in lines if "=" in line}

        self.assertEqual(directives["User"], "root")
        self.assertNotIn("ExecStop", directives)
        self.assertEqual(
            set(directives["CapabilityBoundingSet"].split()),
            {"CAP_CHOWN", "CAP_NET_ADMIN", "CAP_NET_RAW"},
        )
        self.assertEqual(directives["NoNewPrivileges"], "yes")
        self.assertEqual(directives["ProtectSystem"], "strict")
        self.assertEqual(directives["ProtectHome"], "yes")
        self.assertEqual(directives["ProtectKernelTunables"], "yes")
        self.assertEqual(directives["ProtectControlGroups"], "yes")
        self.assertEqual(directives["PrivateTmp"], "yes")
        self.assertEqual(directives["LockPersonality"], "yes")
        self.assertEqual(directives["RestrictSUIDSGID"], "yes")
        self.assertEqual(
            set(directives["RestrictAddressFamilies"].split()),
            {"AF_UNIX", "AF_INET", "AF_INET6", "AF_NETLINK"},
        )
        self.assertEqual(
            directives["ReadWritePaths"].split(),
            ["/etc/persona-mullvad-router", "/run/persona-mullvad-router"],
        )
        self.assertEqual(directives["UMask"], "0077")

    def test_import_creates_config_and_manifest_private_before_write_and_replaces_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / "mullvad.conf"
            source.write_text(CONFIG, encoding="utf-8")
            dest = base / "etc" / "configs"
            dest.mkdir(parents=True)
            replacement_target = base / "existing.conf"
            replacement_target.write_text("previous contents", encoding="utf-8")
            expected_outputs = {
                dest / "mullvad.conf",
                base / "etc" / "entries.json",
                replacement_target,
            }

            created_modes = []
            replacements = []
            real_mkstemp = tempfile.mkstemp
            real_replace = os.replace

            def record_mkstemp(*args, **kwargs):
                fd, name = real_mkstemp(*args, **kwargs)
                created_modes.append(stat.S_IMODE(os.fstat(fd).st_mode))
                return fd, name

            def observe_replace(source_path, destination_path):
                source_path = Path(source_path)
                destination_path = Path(destination_path)
                self.assertEqual(source_path.parent, destination_path.parent)
                self.assertEqual(stat.S_IMODE(source_path.stat().st_mode), 0o600)
                if destination_path == replacement_target:
                    self.assertEqual(destination_path.read_text(encoding="utf-8"), "previous contents")
                else:
                    self.assertFalse(destination_path.exists(), "destination appears only at atomic replace")
                replacements.append(destination_path)
                return real_replace(source_path, destination_path)

            old_umask = os.umask(0o022)
            try:
                with patch.object(sanitizer.tempfile, "mkstemp", side_effect=record_mkstemp), \
                     patch.object(sanitizer.os, "replace", side_effect=observe_replace):
                    sanitizer.import_configs(source, dest)
                    sanitizer.write_private_atomic(replacement_target, "replacement contents")
            finally:
                os.umask(old_umask)

            self.assertEqual(created_modes, [0o600, 0o600, 0o600])
            self.assertEqual(set(replacements), expected_outputs)
            for output in expected_outputs:
                self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertIn("PRIVATE-KEY-SENTINEL", (dest / "mullvad.conf").read_text(encoding="utf-8"))
            self.assertEqual(replacement_target.read_text(encoding="utf-8"), "replacement contents")
            self.assertFalse(list(dest.glob(".*.tmp")))
            self.assertFalse(list((base / "etc").glob(".*.tmp")))
            self.assertFalse(list(base.glob(".*.tmp")))

    def test_control_socket_mode_is_set_before_ownership_transfer(self):
        calls = []

        def record_chmod(path, mode):
            calls.append(("chmod", Path(path), mode))

        def record_chown(path, uid, gid):
            calls.append(("chown", Path(path), uid, gid))

        socket_path = Path("/run/persona-mullvad-router/control.sock")
        with patch.object(router.os, "chmod", side_effect=record_chmod), \
             patch.object(router.os, "chown", side_effect=record_chown):
            router.secure_control_socket(socket_path, 1000, 1000)

        self.assertEqual(
            calls,
            [
                ("chmod", socket_path, 0o600),
                ("chown", socket_path, 1000, 1000),
            ],
        )

    def test_daemon_shutdown_uses_full_router_stop_cleanup(self):
        source = (ROOT / "native" / "routerd.py").read_text(encoding="utf-8")
        shutdown = source[source.index("    try:\n        server.serve_forever"):]
        self.assertIn("ROUTER.stop()", shutdown)
        self.assertNotIn("ROUTER._stop_forwarders()", shutdown)

    def test_router_secret_files_are_private_at_creation_under_umask_022(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            created_modes = []
            real_mkstemp = tempfile.mkstemp

            def observe_creation(*args, **kwargs):
                fd, name = real_mkstemp(*args, **kwargs)
                created_modes.append(stat.S_IMODE(os.fstat(fd).st_mode))
                return fd, name

            destination = base / "active.conf"
            destination.write_bytes(b"old secret")
            old_umask = os.umask(0o022)
            try:
                with patch.object(router.tempfile, "mkstemp", side_effect=observe_creation):
                    temporary = router.create_private_temp_file(base, ".wireguard.", b"private key")
                    self.assertEqual(stat.S_IMODE(temporary.stat().st_mode), 0o600)
                    temporary.unlink()
                    router.atomic_write_private(destination, b"replacement key")
            finally:
                os.umask(old_umask)

            self.assertEqual(created_modes, [0o600, 0o600])
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
            self.assertEqual(destination.read_bytes(), b"replacement key")
            self.assertFalse(list(base.glob(".*.wireguard.*")))


if __name__ == "__main__":
    unittest.main()
