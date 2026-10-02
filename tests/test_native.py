import importlib.util
import errno
import tempfile
import threading
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

san = load('san', ROOT/'native'/'sanitize_configs.py')
router = load('router', ROOT/'native'/'routerd.py')

def routed_request(request):
    policies = {
        'network_policy': {
            'block_local_network': False,
            'domain_mode': 'any',
            'allowed_domains': [],
            'blocked_domains': []
        },
        'connect_policy': {
            'page_url': 'https://page.example.test/',
            'rules': ['*']
        }
    }
    policies.update(request)
    return policies

class NativeTests(unittest.TestCase):
    def test_sanitizer_strips_commands_and_dns_and_forces_table_off(self):
        text = '''[Interface]\nPrivateKey = SECRET\nAddress = 10.1.2.3/32\nDNS = 10.64.0.1\nPreUp = touch /tmp/owned\nPostDown = rm -rf /\n\n[Peer]\nPublicKey = PUB\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = 1.2.3.4:51820\nPersistentKeepalive = 25\n'''
        out, removed, endpoint = san.parse_config(text)
        self.assertIn('Table = off', out)
        self.assertNotIn('PreUp', out)
        self.assertNotIn('PostDown', out)
        self.assertNotIn('DNS =', out)
        self.assertIn('Interface.PreUp', removed)
        self.assertEqual(endpoint, '1.2.3.4:51820')


    def test_direct_config_parser_does_not_require_wg_quick(self):
        text = """[Interface]
PrivateKey = SECRET
Address = 10.66.0.2/32, fd00::2/128
MTU = 1380
Table = off

[Peer]
PublicKey = PUB
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 1.2.3.4:51820
PersistentKeepalive = 25
"""
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / 'active.conf'
            cfg.write_text(text)
            addresses, mtu, native = router.parse_active_config(cfg)
        self.assertEqual(addresses, ['10.66.0.2/32', 'fd00::2/128'])
        self.assertEqual(mtu, 1380)
        self.assertIn('PrivateKey = SECRET', native)
        self.assertIn('Endpoint = 1.2.3.4:51820', native)
        self.assertNotIn('Address =', native)
        self.assertNotIn('MTU =', native)
        self.assertNotIn('Table =', native)

    def test_relay_range_is_restricted(self):
        import ipaddress
        self.assertIn(ipaddress.ip_address('10.124.1.42'), router.RELAY_NET)
        self.assertNotIn(ipaddress.ip_address('10.125.1.42'), router.RELAY_NET)
        self.assertNotIn(ipaddress.ip_address('127.0.0.1'), router.RELAY_NET)

    def test_route_id_validation(self):
        self.assertTrue(router.ROUTE_ID_RE.fullmatch('mullvad-abc_123:route'))
        self.assertFalse(router.ROUTE_ID_RE.fullmatch('../evil'))

    def test_safe_request_headers_strips_hop_by_hop_and_injection(self):
        out = router.safe_request_headers({
            'X-Test': 'ok',
            'Host': 'evil.test',
            'Connection': 'keep-alive',
            'Bad\nHeader': 'x',
            'X-Bad': 'a\r\nb'
        })
        self.assertEqual(out, {'X-Test': 'ok'})

    def test_persona_url_policy_blocks_reserved_hosts_and_enforces_domain_rules(self):
        policy = {
            'block_local_network': True,
            'domain_mode': 'allowlist',
            'allowed_domains': ['*.example.test'],
            'blocked_domains': ['ads.example.test']
        }
        self.assertEqual(router.persona_url_policy_reason(policy, 'http://127.0.0.1/admin'), 'local-network-blocked')
        self.assertEqual(router.persona_url_policy_reason(policy, 'http://[::ffff:7f00:1]/admin'), 'local-network-blocked')
        self.assertIsNone(router.persona_url_policy_reason(policy, 'https://app.example.test/path'))
        self.assertEqual(router.persona_url_policy_reason(policy, 'https://ads.example.test/path'), 'blocked-domain')
        self.assertEqual(router.persona_url_policy_reason(policy, 'https://outside.test/path'), 'not-on-allowlist')

    def test_userscript_connect_policy_matches_same_origin_and_declared_hosts(self):
        policy = {'page_url': 'https://site.example.test/path', 'rules': ['*.allowed.example', 'http://other.test:8080/path']}
        self.assertTrue(router.userscript_connect_allowed(policy, 'https://site.example.test/other'))
        self.assertTrue(router.userscript_connect_allowed(policy, 'https://allowed.example/data'))
        self.assertTrue(router.userscript_connect_allowed(policy, 'http://api.allowed.example:3000/data'))
        self.assertTrue(router.userscript_connect_allowed(policy, 'http://other.test:9000/data'))
        self.assertFalse(router.userscript_connect_allowed(policy, 'https://notallowed.example/data'))
        self.assertFalse(router.userscript_connect_allowed(policy, 'https://evilallowed.example/data'))

    def test_routed_gm_redirect_rechecks_userscript_connect_policy(self):
        final_requests = []

        class FinalH(BaseHTTPRequestHandler):
            def do_GET(self):
                final_requests.append(self.path)
                self.send_response(200)
                self.end_headers()
            def log_message(self, *args):
                pass

        final_server = ThreadingHTTPServer(('127.0.0.1', 0), FinalH)
        final_thread = threading.Thread(target=final_server.serve_forever, daemon=True)
        final_thread.start()

        class RedirectH(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header('Location', f'http://denied.example:{final_server.server_address[1]}/private')
                self.end_headers()
            def log_message(self, *args):
                pass

        redirect_server = ThreadingHTTPServer(('127.0.0.1', 0), RedirectH)
        redirect_thread = threading.Thread(target=redirect_server.serve_forever, daemon=True)
        redirect_thread.start()
        connected = []
        original = router.socks5_connect_via_wg
        try:
            def connect(relay_ip, relay_port, host, port, timeout=15, **kwargs):
                connected.append(host)
                return socket.create_connection(('127.0.0.1', port), timeout=timeout)
            router.socks5_connect_via_wg = connect
            with self.assertRaisesRegex(ValueError, r'userscript @connect policy'):
                router.fetch_through_relay('10.124.0.1', 1080, routed_request({
                    'url': f'http://allowed.example:{redirect_server.server_address[1]}/start',
                    'method': 'GET',
                    'connect_policy': {'page_url': 'https://site.example.test/', 'rules': ['allowed.example']}
                }))
            self.assertEqual(connected, ['allowed.example'], 'the denied redirect must be rejected before opening its socket')
            self.assertEqual(final_requests, [], 'the denied redirect destination must receive no request')
        finally:
            router.socks5_connect_via_wg = original
            redirect_server.shutdown()
            redirect_server.server_close()
            final_server.shutdown()
            final_server.server_close()

    def test_http_fetch_engine_parses_response_and_caps_route_to_socks_layer(self):
        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"ok":true}')
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), H)
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        original = router.socks5_connect_via_wg
        try:
            router.socks5_connect_via_wg = lambda relay_ip, relay_port, host, port, timeout=15, **kwargs: socket.create_connection(server.server_address, timeout=timeout)
            res = router.fetch_through_relay('10.124.0.1', 1080, routed_request({'url':'http://example.test/test','method':'GET'}))
            self.assertTrue(res['ok'])
            self.assertEqual(res['status'], 200)
            import base64
            self.assertEqual(base64.b64decode(res['body_base64']), b'{"ok":true}')
        finally:
            router.socks5_connect_via_wg = original
            server.shutdown()
            server.server_close()

    def test_cross_origin_redirect_does_not_forward_cookie_or_authorization(self):
        seen = {}

        class FinalH(BaseHTTPRequestHandler):
            def do_GET(self):
                seen['cookie'] = self.headers.get('Cookie')
                seen['authorization'] = self.headers.get('Authorization')
                seen['referer'] = self.headers.get('Referer')
                seen['origin'] = self.headers.get('Origin')
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'ok')
            def log_message(self, *args):
                pass

        final_server = ThreadingHTTPServer(('127.0.0.1', 0), FinalH)
        final_thread = threading.Thread(target=final_server.serve_forever, daemon=True)
        final_thread.start()

        class RedirectH(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header('Location', f'http://second.test:{final_server.server_address[1]}/final')
                self.end_headers()
            def log_message(self, *args):
                pass

        redirect_server = ThreadingHTTPServer(('127.0.0.1', 0), RedirectH)
        redirect_thread = threading.Thread(target=redirect_server.serve_forever, daemon=True)
        redirect_thread.start()
        original = router.socks5_connect_via_wg
        try:
            router.socks5_connect_via_wg = lambda relay_ip, relay_port, host, port, timeout=15: socket.create_connection(('127.0.0.1', port), timeout=timeout)
            res = router.fetch_through_relay('10.124.0.1', 1080, routed_request({
                'url': f'http://first.test:{redirect_server.server_address[1]}/start',
                'method': 'GET',
                'headers': {
                    'Cookie': 'sid=secret',
                    'Authorization': 'Bearer secret',
                    'Referer': 'http://first.test/private',
                    'Origin': 'http://first.test'
                }
            }))
            self.assertEqual(res['status'], 200)
            self.assertIsNone(seen.get('cookie'))
            self.assertIsNone(seen.get('authorization'))
            self.assertIsNone(seen.get('referer'))
            self.assertIsNone(seen.get('origin'))
        finally:
            router.socks5_connect_via_wg = original
            redirect_server.shutdown()
            redirect_server.server_close()
            final_server.shutdown()
            final_server.server_close()

    def test_routed_redirects_recheck_persona_domain_policy_before_connecting(self):
        seen = []

        class FinalH(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'not expected')
            def log_message(self, *args):
                pass

        final_server = ThreadingHTTPServer(('127.0.0.1', 0), FinalH)
        final_thread = threading.Thread(target=final_server.serve_forever, daemon=True)
        final_thread.start()

        class RedirectH(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header('Location', f'http://second.test:{final_server.server_address[1]}/private')
                self.end_headers()
            def log_message(self, *args):
                pass

        redirect_server = ThreadingHTTPServer(('127.0.0.1', 0), RedirectH)
        redirect_thread = threading.Thread(target=redirect_server.serve_forever, daemon=True)
        redirect_thread.start()
        original = router.socks5_connect_via_wg
        try:
            router.socks5_connect_via_wg = lambda relay_ip, relay_port, host, port, timeout=15: socket.create_connection(('127.0.0.1', port), timeout=timeout)
            with self.assertRaisesRegex(ValueError, r'Persona URL policy \(not-on-allowlist\)'):
                router.fetch_through_relay('10.124.0.1', 1080, routed_request({
                    'url': f'http://first.test:{redirect_server.server_address[1]}/start',
                    'method': 'GET',
                    'network_policy': {
                        'block_local_network': True,
                        'domain_mode': 'allowlist',
                        'allowed_domains': ['first.test'],
                        'blocked_domains': []
                    }
                }))
            self.assertEqual(seen, [], 'the redirected disallowed host must not receive a socket connection')
        finally:
            router.socks5_connect_via_wg = original
            redirect_server.shutdown()
            redirect_server.server_close()
            final_server.shutdown()
            final_server.server_close()

    def test_router_cancels_an_active_routed_fetch_socket(self):
        request_seen = threading.Event()
        release_response = threading.Event()
        outcome = {}

        class SlowH(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', '100')
                self.end_headers()
                self.wfile.flush()
                request_seen.set()
                release_response.wait(5)
                try:
                    self.wfile.write(b'x' * 100)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), SlowH)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        original_connect = router.socks5_connect_via_wg
        try:
            router.socks5_connect_via_wg = lambda relay_ip, relay_port, host, port, timeout=15, **kwargs: socket.create_connection(server.server_address, timeout=timeout)
            app = router.Router()
            app._prepare_exit_network = lambda *args: ({'ready': True}, None, 1080)

            def fetch():
                try:
                    outcome['result'] = app.fetch_exit('route-1', '10.124.0.1', 1080, routed_request({
                        'url': f'http://example.test:{server.server_address[1]}/slow',
                        'method': 'GET',
                        'request_id': 'cancel-test-1'
                    }))
                except Exception as exc:
                    outcome['error'] = str(exc)

            worker = threading.Thread(target=fetch, daemon=True)
            worker.start()
            self.assertTrue(request_seen.wait(2), 'the routed request should reach the controlled test endpoint')
            self.assertTrue(app.cancel_fetch('cancel-test-1')['cancelled'])
            worker.join(3)
            self.assertFalse(worker.is_alive(), 'native cancellation should close the active socket promptly')
            self.assertEqual(outcome.get('error'), 'request cancelled')
        finally:
            release_response.set()
            router.socks5_connect_via_wg = original_connect
            server.shutdown()
            server.server_close()

    def test_router_cancels_during_nonblocking_relay_connect_and_socks_handshake(self):
        for phase in ('connect', 'handshake'):
            with self.subTest(phase=phase):
                outcome = {}
                active_socket = {}

                class ControlledSocket:
                    def __init__(self, *args, **kwargs):
                        self.cancelled = threading.Event()
                        self.phase_started = threading.Event()
                    def setblocking(self, _value):
                        pass
                    def settimeout(self, _value):
                        pass
                    def setsockopt(self, *_args):
                        pass
                    def connect_ex(self, _address):
                        self.phase_started.set()
                        return errno.EINPROGRESS if phase == 'connect' else 0
                    def getsockopt(self, *_args):
                        return 0
                    def sendall(self, _data):
                        if phase == 'handshake':
                            self.phase_started.set()
                    def recv(self, _size):
                        self.phase_started.set()
                        self.cancelled.wait(5)
                        return b''
                    def shutdown(self, _how):
                        self.cancelled.set()
                    def close(self):
                        self.cancelled.set()

                def make_socket(*_args, **_kwargs):
                    active_socket['value'] = ControlledSocket()
                    return active_socket['value']

                def fake_select(_readable, _writable, _exceptional, timeout):
                    active_socket['value'].cancelled.wait(timeout)
                    return [], [], []

                app = router.Router()
                app._prepare_exit_network = lambda *args: ({'ready': True}, None, 1080)
                request_id = f'cancel-{phase}-setup'

                def fetch():
                    try:
                        app.fetch_exit('route-1', '10.124.0.1', 1080, routed_request({
                            'url': 'https://example.test/',
                            'request_id': request_id
                        }))
                    except Exception as exc:
                        outcome['error'] = str(exc)

                with patch.object(router.socket, 'socket', side_effect=make_socket):
                    if phase == 'connect':
                        with patch.object(router.select, 'select', side_effect=fake_select):
                            worker = threading.Thread(target=fetch, daemon=True)
                            worker.start()
                            self.assertTrue(active_socket.get('value', ControlledSocket()).phase_started.wait(2))
                            self.assertTrue(app.cancel_fetch(request_id)['cancelled'])
                            worker.join(2)
                    else:
                        worker = threading.Thread(target=fetch, daemon=True)
                        worker.start()
                        self.assertTrue(active_socket.get('value', ControlledSocket()).phase_started.wait(2))
                        self.assertTrue(app.cancel_fetch(request_id)['cancelled'])
                        worker.join(2)
                self.assertFalse(worker.is_alive(), f'cancellation during {phase} must not wait for the socket timeout')
                self.assertEqual(outcome.get('error'), 'request cancelled')

    def test_router_tracks_and_cancels_the_wrapped_socket_for_https_reads(self):
        request_seen = threading.Event()
        release_response = threading.Event()
        outcome = {}
        wrapped_sockets = []

        class SlowH(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', '100')
                self.end_headers()
                self.wfile.flush()
                request_seen.set()
                release_response.wait(5)
                try:
                    self.wfile.write(b'x' * 100)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *args):
                pass

        class WrappedSocket:
            def __init__(self, sock):
                self.sock = sock
            def __getattr__(self, name):
                return getattr(self.sock, name)
            def do_handshake(self):
                pass

        class FakeTLSContext:
            def wrap_socket(self, sock, **_kwargs):
                wrapped = WrappedSocket(sock)
                wrapped_sockets.append(wrapped)
                return wrapped

        server = ThreadingHTTPServer(('127.0.0.1', 0), SlowH)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        original_connect = router.socks5_connect_via_wg
        app = router.Router()
        app._prepare_exit_network = lambda *args: ({'ready': True}, None, 1080)
        request_id = 'cancel-https-read'
        try:
            def local_connect(_relay_ip, _relay_port, _host, _port, timeout=15, **_kwargs):
                return socket.create_connection(server.server_address, timeout=timeout)
            router.socks5_connect_via_wg = local_connect
            with patch.object(router.ssl, 'create_default_context', return_value=FakeTLSContext()):
                def fetch():
                    try:
                        outcome['result'] = app.fetch_exit('route-1', '10.124.0.1', 1080, routed_request({
                            'url': 'https://example.test/slow',
                            'request_id': request_id
                        }))
                    except Exception as exc:
                        outcome['error'] = str(exc)
                worker = threading.Thread(target=fetch, daemon=True)
                worker.start()
                self.assertTrue(request_seen.wait(2), 'the controlled HTTPS fetch should reach its response read')
                self.assertTrue(wrapped_sockets)
                self.assertIs(app.active_fetches[request_id]['socket'], wrapped_sockets[0], 'cancellation must target the active TLS socket')
                self.assertTrue(app.cancel_fetch(request_id)['cancelled'])
                worker.join(2)
                self.assertFalse(worker.is_alive(), 'TLS response cancellation must interrupt the blocked body read')
                self.assertEqual(outcome.get('error'), 'request cancelled')
        finally:
            release_response.set()
            router.socks5_connect_via_wg = original_connect
            server.shutdown()
            server.server_close()

    def test_router_remembers_cancel_arriving_before_fetch_registration(self):
        app = router.Router()
        self.assertTrue(app.cancel_fetch('cancel-race-1')['pending'])
        app._prepare_exit_network = lambda *args: self.fail('cancelled fetch must not prepare a route')
        with self.assertRaisesRegex(RuntimeError, 'request cancelled'):
            app.fetch_exit('route-1', '10.124.0.1', 1080, routed_request({
                'url': 'https://example.test/',
                'request_id': 'cancel-race-1'
            }))

    def test_cancel_fetch_rejects_malformed_request_ids(self):
        app = router.Router()
        with self.assertRaisesRegex(ValueError, 'invalid fetch request id'):
            app.cancel_fetch('../request')

if __name__ == '__main__':
    unittest.main()
