import importlib.util
import socket
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "routerd_chromium_forwarder",
    ROOT / "native" / "routerd.py",
)
router = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(router)


def recv_exact(sock, size):
    chunks = []
    while sum(len(chunk) for chunk in chunks) < size:
        chunk = sock.recv(size - sum(len(chunk) for chunk in chunks))
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)


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

    def test_no_auth_socks_handshake_is_terminated_locally_and_relay_is_no_auth(self):
        relay = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        relay.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        relay.bind(("127.0.0.1", 0))
        relay.listen(1)
        relay.settimeout(3)
        relay_requests = []

        def relay_once():
            try:
                peer, _ = relay.accept()
            except OSError:
                return
            with peer:
                relay_requests.append(recv_exact(peer, 3))
                peer.sendall(b"\x05\x00")
                relay_requests.append(recv_exact(peer, 10))
                peer.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")

        relay_thread = threading.Thread(target=relay_once, daemon=True)
        relay_thread.start()
        forwarder = router.ChromiumExitForwarder(
            "route-1",
            "127.0.0.1",
            relay.getsockname()[1],
            0,
            "runtime-lease",
            1,
            5,
        )
        forwarder.start()
        real_socket = socket.socket

        class DeviceSocket:
            def __init__(self, *args, **kwargs):
                self.sock = real_socket(*args, **kwargs)

            def setsockopt(self, level, option, value):
                if level == socket.SOL_SOCKET and option == getattr(socket, "SO_BINDTODEVICE", -1):
                    return
                return self.sock.setsockopt(level, option, value)

            def __getattr__(self, name):
                return getattr(self.sock, name)

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                self.sock.close()
                return False

        denied = real_socket(socket.AF_INET, socket.SOCK_STREAM)
        allowed = real_socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with patch.object(router.socket, "socket", DeviceSocket):
                denied.settimeout(2)
                denied.connect(("127.0.0.1", forwarder.listen_port))
                denied.sendall(b"\x05\x01\x02")
                self.assertEqual(recv_exact(denied, 2), b"\x05\xff")
                self.assertEqual(
                    relay_requests,
                    [],
                    "a client that does not offer no-auth must not contact the relay",
                )

                allowed.settimeout(2)
                allowed.connect(("127.0.0.1", forwarder.listen_port))
                allowed.sendall(b"\x05\x01\x00")
                self.assertEqual(recv_exact(allowed, 2), b"\x05\x00")
                allowed.sendall(b"\x05\x01\x00\x01\x08\x08\x08\x08\x00\x50")
                self.assertEqual(
                    recv_exact(allowed, 10),
                    b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00",
                )
        finally:
            denied.close()
            allowed.close()
            forwarder.stop()
            relay.close()
            relay_thread.join(timeout=2)

        self.assertEqual(
            relay_requests,
            [b"\x05\x01\x00", b"\x05\x01\x00\x01\x08\x08\x08\x08\x00\x50"],
        )

    def test_release_and_stale_lease_guards_are_route_scoped_and_idempotent(self):
        app = router.Router()
        network = Mock(
            return_value=(
                {"ready": True},
                router.ipaddress.ip_address("10.124.0.9"),
                1080,
            )
        )
        app._prepare_exit_network = network

        with patch.object(router, "read_selected", return_value="entry"):
            first = app.prepare_chromium_exit(
                "route-1",
                "10.124.0.9",
                1080,
                True,
                "runtime-a",
                1,
                5,
            )
            forwarder = app.chromium_forwarders["route-1"]
            initial_expiry = forwarder.lease_expires_at

            network.reset_mock()
            replay = app.prepare_chromium_exit(
                "route-1",
                "10.124.0.9",
                1080,
                True,
                "runtime-a",
                1,
                5,
            )
            network.assert_called_once()
            self.assertEqual(replay["local_port"], first["local_port"])
            self.assertEqual(
                forwarder.lease_expires_at,
                initial_expiry,
                "replaying the same lease must not extend its lifetime",
            )

            network.reset_mock()
            with self.assertRaisesRegex(ValueError, "active Chromium forwarder lease"):
                app.prepare_chromium_exit(
                    "route-1",
                    "10.124.0.9",
                    1080,
                    True,
                    "runtime-b",
                    2,
                    5,
                )
            network.assert_not_called()

            with self.assertRaisesRegex(ValueError, "lease mismatch"):
                app.release_chromium_exit("route-1", "runtime-a", 2)
            self.assertIs(app.chromium_forwarders["route-1"], forwarder)

            self.assertTrue(
                app.release_chromium_exit("route-1", "runtime-a", 1)["released"]
            )
            self.assertFalse(
                app.release_chromium_exit("route-1", "runtime-a", 1)["released"]
            )

            second = app.prepare_chromium_exit(
                "route-1",
                "10.124.0.9",
                1080,
                True,
                "runtime-b",
                2,
                5,
            )
            with self.assertRaisesRegex(ValueError, "lease mismatch"):
                app.release_chromium_exit("route-1", "runtime-a", 1)
            self.assertEqual(
                app.chromium_forwarders["route-1"].listen_port,
                second["local_port"],
            )
            self.assertTrue(
                app.release_chromium_exit("route-1", "runtime-b", 2)["released"]
            )

    def test_invalid_lease_is_rejected_before_route_side_effects(self):
        app = router.Router()
        app._prepare_exit_network = Mock()

        with self.assertRaisesRegex(ValueError, "invalid Chromium lease id"):
            app.prepare_chromium_exit(
                "route-1",
                "10.124.0.9",
                1080,
                True,
                "../lease",
                1,
                60,
            )
        with self.assertRaisesRegex(ValueError, "invalid Chromium lease generation"):
            app.prepare_chromium_exit(
                "route-1",
                "10.124.0.9",
                1080,
                True,
                "lease",
                0,
                60,
            )
        with self.assertRaisesRegex(ValueError, "invalid Chromium lease TTL"):
            app.prepare_chromium_exit(
                "route-1",
                "10.124.0.9",
                1080,
                True,
                "lease",
                1,
                301,
            )
        app._prepare_exit_network.assert_not_called()


if __name__ == "__main__":
    unittest.main()
