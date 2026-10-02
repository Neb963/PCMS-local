import importlib.util
import json
import socket
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("routerd_forwarder", ROOT / "native" / "routerd.py")
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


def authenticate_socks_client(client, token):
    client.sendall(b"\x05\x01\x02")
    if recv_exact(client, 2) != b"\x05\x02":
        return False
    encoded_token = token.encode("ascii")
    client.sendall(b"\x01\x07persona" + bytes([len(encoded_token)]) + encoded_token)
    return recv_exact(client, 2) == b"\x01\x00"


class ForwarderAuthTests(unittest.TestCase):
    def test_local_forwarder_requires_token_before_contacting_relay(self):
        token = "a" * 64
        relay = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        relay.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        relay.bind(("127.0.0.1", 0))
        relay.listen(2)
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
                request = recv_exact(peer, 10)
                relay_requests.append(request)
                peer.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")

        relay_thread = threading.Thread(target=relay_once, daemon=True)
        relay_thread.start()
        forwarder = router.ExitForwarder("route-1", "127.0.0.1", relay.getsockname()[1], 0, token)
        forwarder.start()
        real_socket = socket.socket

        class DeviceSocket:
            """Skip only WireGuard's device bind while retaining real TCP behavior."""

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

        clients = []
        try:
            with patch.object(router.socket, "socket", DeviceSocket):
                denied = real_socket(socket.AF_INET, socket.SOCK_STREAM)
                clients.append(denied)
                denied.settimeout(2)
                denied.connect(("127.0.0.1", forwarder.listen_port))
                denied.sendall(b"\x05\x01\x02")
                self.assertEqual(recv_exact(denied, 2), b"\x05\x02")
                denied.sendall(b"\x01\x07persona\x03bad")
                self.assertEqual(recv_exact(denied, 2), b"\x01\x01")
                self.assertEqual(relay_requests, [], "an unauthenticated client must not open the Mullvad relay")

                allowed = real_socket(socket.AF_INET, socket.SOCK_STREAM)
                clients.append(allowed)
                allowed.settimeout(2)
                allowed.connect(("127.0.0.1", forwarder.listen_port))
                allowed.sendall(b"\x05\x01\x02")
                self.assertEqual(recv_exact(allowed, 2), b"\x05\x02")
                encoded_token = token.encode("ascii")
                allowed.sendall(b"\x01\x07persona" + bytes([len(encoded_token)]) + encoded_token)
                self.assertEqual(recv_exact(allowed, 2), b"\x01\x00")
                allowed.sendall(b"\x05\x01\x00\x01\x08\x08\x08\x08\x00\x50")
                self.assertEqual(recv_exact(allowed, 10), b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")

            self.assertEqual(relay_requests, [b"\x05\x01\x00", b"\x05\x01\x00\x01\x08\x08\x08\x08\x00\x50"])
            app = router.Router()
            app.forwarders["route-1"] = forwarder
            with patch.object(router, "read_selected", return_value="entry"), \
                    patch.object(router, "iface_up", return_value=False), \
                    patch.object(router, "latest_handshake", return_value=0), \
                    patch.object(router, "mullvad_app_connected", return_value=False):
                status = app.status()
            self.assertNotIn(token, json.dumps(status), "status must not disclose forwarder credentials")
        finally:
            for client in clients:
                try:
                    client.close()
                except OSError:
                    pass
            forwarder.stop()
            relay.close()
            relay_thread.join(timeout=2)
        self.assertIsNone(forwarder.forwarder_token, "stop must clear the reusable forwarder credential")

    def test_prepare_exit_requires_secret_before_network_side_effects_and_never_returns_it(self):
        app = router.Router()
        app._prepare_exit_network = Mock(return_value=({"ready": True}, router.ipaddress.ip_address("10.124.0.1"), 1080))
        with self.assertRaisesRegex(ValueError, "forwarder authentication"):
            app.prepare_exit("route-1", "10.124.0.1", 1080, True)
        app._prepare_exit_network.assert_not_called()

        token = "b" * 64
        instances = []

        class StubForwarder:
            def __init__(self, route_id, relay_ip, relay_port, listen_port, forwarder_token):
                self.route_id = route_id
                self.relay_ip = relay_ip
                self.relay_port = relay_port
                self.listen_port = 40123
                self.forwarder_token = forwarder_token
                instances.append(self)

            def start(self):
                pass

            def stop(self):
                self.forwarder_token = None

        with patch.object(router, "ExitForwarder", StubForwarder):
            result = app.prepare_exit("route-1", "10.124.0.1", 1080, True, token)
            self.assertEqual(instances[0].forwarder_token, token)
            self.assertNotIn(token, json.dumps(result), "prepare_exit must return only host/port metadata")
            app.release_exit("route-1")
            self.assertIsNone(instances[0].forwarder_token)

    def test_required_fetch_policies_fail_before_tunnel_or_socket_side_effects(self):
        valid_network = {
            "block_local_network": False,
            "domain_mode": "any",
            "allowed_domains": [],
            "blocked_domains": [],
        }
        valid_connect = {"page_url": "https://page.example.test/", "rules": ["*"]}
        invalid_requests = (
            {"url": "https://target.example/"},
            {"url": "https://target.example/", "network_policy": None, "connect_policy": valid_connect},
            {"url": "https://target.example/", "network_policy": {"block_local_network": False}, "connect_policy": valid_connect},
            {"url": "https://target.example/", "network_policy": valid_network},
            {"url": "https://target.example/", "network_policy": valid_network, "connect_policy": None},
        )
        app = router.Router()
        app._prepare_exit_network = Mock()
        for request in invalid_requests:
            with self.subTest(request=request), self.assertRaises(ValueError):
                app.fetch_exit("route-1", "10.124.0.1", 1080, request)
        app._prepare_exit_network.assert_not_called()

    def test_stop_closes_upstream_socket_while_relay_greeting_is_pending(self):
        token = "c" * 64
        relay = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        relay.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        relay.bind(("127.0.0.1", 0))
        relay.listen(1)
        relay.settimeout(3)
        greeting_seen = threading.Event()
        upstream_closed = threading.Event()

        def relay_once():
            try:
                peer, _ = relay.accept()
            except OSError:
                return
            with peer:
                if recv_exact(peer, 3) == b"\x05\x01\x00":
                    greeting_seen.set()
                try:
                    if not peer.recv(1):
                        upstream_closed.set()
                except OSError:
                    upstream_closed.set()

        relay_thread = threading.Thread(target=relay_once, daemon=True)
        relay_thread.start()
        forwarder = router.ExitForwarder("route-1", "127.0.0.1", relay.getsockname()[1], 0, token)
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

        client = real_socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with patch.object(router.socket, "socket", DeviceSocket):
                client.settimeout(2)
                client.connect(("127.0.0.1", forwarder.listen_port))
                self.assertTrue(authenticate_socks_client(client, token))
                self.assertTrue(greeting_seen.wait(2), "forwarder should open the upstream relay before waiting for its greeting")

                forwarder.stop()

            self.assertTrue(upstream_closed.wait(1), "stop must close the upstream relay socket immediately")
        finally:
            client.close()
            forwarder.stop()
            relay.close()
            relay_thread.join(timeout=2)

    def test_revoke_during_authentication_cannot_start_an_upstream_connect(self):
        token = "d" * 64
        forwarder = router.ExitForwarder("route-1", "127.0.0.1", 9, 0, token)
        forwarder.start()
        auth_started = threading.Event()
        resume_auth = threading.Event()
        real_socket = socket.socket
        outbound_socket_calls = []

        def paused_auth(_client, _token):
            auth_started.set()
            return resume_auth.wait(2)

        def track_socket(*args, **kwargs):
            if "fileno" not in kwargs:
                outbound_socket_calls.append(args)
            return real_socket(*args, **kwargs)

        client = real_socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with patch.object(router, "authenticate_forwarder_client", side_effect=paused_auth), \
                    patch.object(router.socket, "socket", side_effect=track_socket):
                client.connect(("127.0.0.1", forwarder.listen_port))
                self.assertTrue(auth_started.wait(2), "the accepted client should reach authentication")

                forwarder.stop()
                resume_auth.set()
                deadline = router.time.monotonic() + 2
                while forwarder.active_sockets and router.time.monotonic() < deadline:
                    router.time.sleep(0.01)

            self.assertEqual(outbound_socket_calls, [], "a revoked handler must not create or connect an upstream socket")
        finally:
            resume_auth.set()
            client.close()
            forwarder.stop()

    def test_expired_token_is_rejected_and_rotation_leaves_established_sockets_open(self):
        token = "e" * 64
        replacement = "f" * 64
        forwarder = router.ExitForwarder("route-1", "127.0.0.1", 9, 0, token)
        left, right = socket.socketpair()
        forwarder.active_sockets.update((left, right))
        try:
            with forwarder.active_clients_lock:
                forwarder.token_expires_at = router.time.monotonic() - 1
                current, _generation = forwarder._register_downstream(object())
            self.assertIsNone(current, "an expired credential must not authenticate new clients")
            with self.assertRaisesRegex(ValueError, "expired"):
                forwarder.rotate_token(token)

            forwarder.rotate_token(replacement)
            self.assertEqual(forwarder.forwarder_token, replacement)
            self.assertIn(left, forwarder.active_sockets)
            self.assertIn(right, forwarder.active_sockets)
            left.sendall(b"x")
            self.assertEqual(right.recv(1), b"x", "credential rotation must not close established TCP sockets")
        finally:
            forwarder.stop()

    def test_router_cleanup_attempts_every_forwarder_and_downs_interface_before_error(self):
        calls = []

        class FailingForwarder:
            def stop(self):
                calls.append("first")
                raise OSError("synthetic close failure")

        class HealthyForwarder:
            def stop(self):
                calls.append("second")

        app = router.Router()
        app.forwarders = {"first": FailingForwarder(), "second": HealthyForwarder()}
        with patch.object(router, "iface_up", return_value=True), \
                patch.object(router, "interface_down_direct") as interface_down, \
                self.assertRaisesRegex(RuntimeError, "cleanup attempts"):
            app.stop()
        self.assertEqual(calls, ["first", "second"], "one failing listener must not skip later listeners")
        interface_down.assert_called_once_with()
        self.assertEqual(app.forwarders, {})

        calls.clear()
        app.forwarders = {"first": FailingForwarder(), "second": HealthyForwarder()}
        with patch.object(router, "iface_up", return_value=True), \
                patch.object(router, "interface_down_direct") as interface_down, \
                patch.object(router, "activate_entry") as activate_entry, \
                self.assertRaisesRegex(RuntimeError, "entry switch stopped"):
            app.set_entry("pl-waw")
        self.assertEqual(calls, ["first", "second"])
        interface_down.assert_called_once_with()
        activate_entry.assert_not_called()


if __name__ == "__main__":
    unittest.main()
