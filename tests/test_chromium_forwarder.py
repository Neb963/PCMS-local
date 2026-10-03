import importlib.util
import socket
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "routerd_chromium_forwarder",
    ROOT / "native" / "routerd.py",
)
router = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(router)


class ChromiumForwarderLeaseTests(unittest.TestCase):
    def test_listener_binds_ipv4_loopback_and_active_expiry_closes_it(self):
        expired = threading.Event()

        def on_expire(forwarder):
            expired.set()
            forwarder.stop()

        forwarder = router.ChromiumExitForwarder(
            "route-1",
            "127.0.0.1",
            9,
            0,
            "runtime-lease",
            1,
            1,
            on_expire,
        )
        forwarder.start()
        port = forwarder.listen_port
        try:
            self.assertEqual(forwarder.server.server_address[0], "127.0.0.1")
            self.assertGreater(port, 0)
            self.assertTrue(expired.wait(2.5), "short lease must actively expire")
            deadline = time.monotonic() + 2
            while forwarder.server is not None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIsNone(forwarder.server)
            self.assertTrue(forwarder.stopping)
            with self.assertRaises(OSError):
                socket.create_connection(("127.0.0.1", port), timeout=0.2)
        finally:
            forwarder.stop()

    def test_router_expiry_removes_the_matching_route_lease(self):
        app = router.Router()
        app._prepare_exit_network = lambda *args: (
            {"ready": True},
            router.ipaddress.ip_address("10.124.0.9"),
            1080,
        )
        with patch.object(router, "read_selected", return_value="entry"):
            prepared = app.prepare_chromium_exit(
                "route-1",
                "10.124.0.9",
                1080,
                True,
                "runtime-lease",
                4,
                1,
            )
        port = prepared["local_port"]
        self.assertIn("route-1", app.chromium_forwarders)

        deadline = time.monotonic() + 2.5
        while "route-1" in app.chromium_forwarders and time.monotonic() < deadline:
            time.sleep(0.02)

        self.assertNotIn("route-1", app.chromium_forwarders)
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=0.2)


if __name__ == "__main__":
    unittest.main()
