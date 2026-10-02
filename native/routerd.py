#!/usr/bin/env python3
import argparse
import base64
import errno
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import re
import select
import shutil
import signal
import ssl
import socket
import socketserver
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit

NATIVE_BRIDGE_VERSION = "0.3.0"
ROOT = Path(os.environ.get("PRM_ROOT", "/etc/persona-mullvad-router"))
ENTRIES = ROOT / "configs"
ACTIVE = ROOT / "prm-mv.conf"
STATE = ROOT / "state.json"
SOCKET_PATH = Path(os.environ.get("PRM_SOCKET", "/run/persona-mullvad-router/control.sock"))
WG_IF = "prm-mv"
BASE_PROXY_IP = "10.64.0.1"
BASE_PROXY_PORT = 1080
RELAY_NET = ipaddress.ip_network("10.124.0.0/16")
ROUTE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")
ENTRY_RE = re.compile(r"^[A-Za-z0-9._-]{1,140}$")
FETCH_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")
FORWARDER_USERNAME = "persona"
FORWARDER_TOKEN_RE = re.compile(r"^[0-9a-f]{64}$")
FORWARDER_TOKEN_TTL_SECONDS = 60 * 60
MAX_REQ = 2 * 1024 * 1024
MAX_FETCH_RESPONSE = 650 * 1024


def run(cmd, timeout=20, check=True):
    env = {**os.environ, "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
    p = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, env=env)
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed: {(p.stderr or p.stdout).strip()}")
    return p


def iface_up():
    return Path(f"/sys/class/net/{WG_IF}").exists()


SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


def which(name):
    return shutil.which(name, path=SYSTEM_PATH)


def ip_cmd():
    path = which("ip")
    if not path:
        raise RuntimeError("ip not found")
    return path


def wg_cmd():
    path = which("wg")
    if not path:
        raise RuntimeError("wg not found")
    return path


def create_private_temp_file(directory, prefix, data):
    """Write bytes to a same-directory temporary file created as mode 0600."""
    fd, name = tempfile.mkstemp(prefix=prefix, dir=directory)
    path = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        raise
    return path


def atomic_write_private(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = create_private_temp_file(path.parent, f".{path.name}.", data)
    try:
        os.replace(tmp, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
        raise


def parse_active_config(path):
    """Parse the already-sanitized wg-quick-style config.

    Only fields emitted by sanitize_configs.py are accepted here. We use the
    Interface Address/MTU ourselves and feed only native WireGuard keys to
    `wg setconf`, so wg-quick is not needed at runtime.
    """
    allowed_interface = {"PrivateKey", "Address", "MTU", "Table"}
    allowed_peer = {"PublicKey", "PresharedKey", "AllowedIPs", "Endpoint", "PersistentKeepalive"}
    section = None
    interface = {}
    peer = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip()
            if section not in ("Interface", "Peer"):
                raise RuntimeError(f"unsupported section in active config: {section}")
            continue
        if "=" not in line or section not in ("Interface", "Peer"):
            raise RuntimeError("invalid active WireGuard configuration")
        key, value = [x.strip() for x in line.split("=", 1)]
        allowed = allowed_interface if section == "Interface" else allowed_peer
        if key not in allowed:
            raise RuntimeError(f"unexpected key in active WireGuard configuration: {section}.{key}")
        (interface if section == "Interface" else peer)[key] = value

    if not interface.get("PrivateKey") or not interface.get("Address"):
        raise RuntimeError("active config is missing PrivateKey or Address")
    for req in ("PublicKey", "AllowedIPs", "Endpoint"):
        if not peer.get(req):
            raise RuntimeError(f"active config is missing Peer.{req}")

    addresses = [x.strip() for x in interface["Address"].split(",") if x.strip()]
    if not addresses:
        raise RuntimeError("active config has no interface addresses")
    for addr in addresses:
        ipaddress.ip_interface(addr)  # validate before changing the host

    mtu = None
    if interface.get("MTU"):
        mtu = int(interface["MTU"])
        if not 576 <= mtu <= 9000:
            raise RuntimeError("active config MTU is outside the accepted range")

    # wg(8) config format: no Address/MTU/Table fields.
    lines = ["[Interface]", f"PrivateKey = {interface['PrivateKey']}", "", "[Peer]"]
    for key in ("PublicKey", "PresharedKey", "AllowedIPs", "Endpoint", "PersistentKeepalive"):
        if peer.get(key):
            lines.append(f"{key} = {peer[key]}")
    lines.append("")
    return addresses, mtu, "\n".join(lines)


def interface_up_direct():
    if iface_up():
        return
    addresses, mtu, native_conf = parse_active_config(ACTIVE)
    ip = ip_cmd()
    wg = wg_cmd()
    runtime = SOCKET_PATH.parent
    runtime.mkdir(parents=True, exist_ok=True)
    conf = create_private_temp_file(runtime, f".{WG_IF}.wg.", native_conf.encode("utf-8"))
    try:
        run([ip, "link", "add", "dev", WG_IF, "type", "wireguard"])
        run([wg, "setconf", WG_IF, str(conf)])
        for addr in addresses:
            run([ip, "address", "add", addr, "dev", WG_IF])
        if mtu:
            run([ip, "link", "set", "dev", WG_IF, "mtu", str(mtu)])
        run([ip, "link", "set", "up", "dev", WG_IF])
    except Exception:
        run([ip, "link", "delete", "dev", WG_IF], check=False)
        raise
    finally:
        try:
            conf.unlink()
        except FileNotFoundError:
            pass


def interface_down_direct():
    if iface_up():
        run([ip_cmd(), "link", "delete", "dev", WG_IF], timeout=10, check=False)


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path, obj):
    atomic_write_private(path, json.dumps(obj, indent=2).encode("utf-8"))


def entry_files():
    out = []
    for p in sorted(ENTRIES.glob("*.conf")):
        out.append({"id": p.stem, "file": p.name})
    return out


def read_selected():
    st = load_json(STATE, {})
    selected = st.get("selected_entry")
    if selected and (ENTRIES / f"{selected}.conf").exists():
        return selected
    entries = entry_files()
    return entries[0]["id"] if entries else None


def activate_entry(entry_id):
    if not ENTRY_RE.fullmatch(str(entry_id or "")):
        raise ValueError("invalid entry id")
    src = ENTRIES / f"{entry_id}.conf"
    if not src.exists():
        raise ValueError("entry does not exist")
    data = src.read_bytes()
    atomic_write_private(ACTIVE, data)
    st = load_json(STATE, {})
    st["selected_entry"] = entry_id
    save_json(STATE, st)


def ensure_active_config():
    selected = read_selected()
    if not selected:
        raise RuntimeError("no Mullvad WireGuard configs installed")
    if not ACTIVE.exists():
        activate_entry(selected)
    return selected


def add_route(ip):
    ip_obj = ipaddress.ip_address(ip)
    if ip_obj.version != 4:
        raise ValueError("only IPv4 Mullvad relay addresses are supported")
    run([ip_cmd(), "route", "replace", f"{ip}/32", "dev", WG_IF])


def route_bound_to_wg(ip):
    if not iface_up():
        return False
    p = run([ip_cmd(), "route", "get", ip], check=False)
    return p.returncode == 0 and f"dev {WG_IF}" in p.stdout


def mullvad_app_connected():
    cli = which("mullvad")
    if not cli:
        return False
    try:
        p = run([cli, "status"], timeout=4, check=False)
        text = (p.stdout + "\n" + p.stderr).lower()
        return "connected" in text and "disconnected" not in text
    except Exception:
        return False


def latest_handshake():
    if not iface_up():
        return 0
    p = run([wg_cmd(), "show", WG_IF, "latest-handshakes"], check=False)
    if p.returncode != 0:
        return 0
    epochs = []
    for line in p.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[-1].isdigit():
            epochs.append(int(parts[-1]))
    return max(epochs, default=0)


def bound_connect(ip, port, timeout=1.5):
    if not iface_up():
        return False
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.settimeout(timeout)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, (WG_IF + "\0").encode())
        s.connect((ip, int(port)))
        return True
    except OSError:
        return False
    finally:
        s.close()



def recv_exact_sock(sock, n):
    out = bytearray()
    while len(out) < n:
        chunk = sock.recv(n - len(out))
        if not chunk:
            raise RuntimeError("SOCKS connection closed unexpectedly")
        out.extend(chunk)
    return bytes(out)


def _connect_socket(sock, address, timeout, cancel_event=None):
    if cancel_event is None:
        sock.settimeout(timeout)
        sock.connect(address)
        return

    deadline = time.monotonic() + timeout
    sock.setblocking(False)
    result = sock.connect_ex(address)
    in_progress = {errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, errno.EINTR}
    if result not in (0, errno.EISCONN) and result not in in_progress:
        raise OSError(result, os.strerror(result))
    while result not in (0, errno.EISCONN):
        if cancel_event.is_set():
            raise RuntimeError("request cancelled")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise socket.timeout("timed out connecting to Mullvad relay")
        _readable, writable, exceptional = select.select([], [sock], [sock], min(0.1, remaining))
        if writable or exceptional:
            result = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
            if result:
                raise OSError(result, os.strerror(result))
            break
    if cancel_event.is_set():
        raise RuntimeError("request cancelled")
    sock.settimeout(timeout)


def socks5_connect_via_wg(relay_ip, relay_port, host, port, timeout=15, cancel_event=None, register_socket=None):
    """Connect to host:port via a Mullvad internal SOCKS5 relay.

    DNS is deliberately delegated to SOCKS (ATYP=domain), and the relay
    socket is bound to prm-mv so it cannot fall back to the host route.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if register_socket:
            register_socket(s)
        if cancel_event and cancel_event.is_set():
            raise RuntimeError("request cancelled")
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, (WG_IF + "\0").encode())
        _connect_socket(s, (str(relay_ip), int(relay_port)), timeout, cancel_event)
        s.sendall(b"\x05\x01\x00")
        if recv_exact_sock(s, 2) != b"\x05\x00":
            raise RuntimeError("Mullvad SOCKS relay rejected unauthenticated connection")
        host_bytes = str(host).encode("idna")
        if not 1 <= len(host_bytes) <= 255:
            raise ValueError("target hostname is too long")
        s.sendall(b"\x05\x01\x00\x03" + bytes([len(host_bytes)]) + host_bytes + int(port).to_bytes(2, "big"))
        head = recv_exact_sock(s, 4)
        if head[0] != 5 or head[1] != 0:
            raise RuntimeError(f"Mullvad SOCKS connect failed with code {head[1] if len(head) > 1 else '?'}")
        atyp = head[3]
        if atyp == 1:
            recv_exact_sock(s, 4)
        elif atyp == 3:
            recv_exact_sock(s, recv_exact_sock(s, 1)[0])
        elif atyp == 4:
            recv_exact_sock(s, 16)
        else:
            raise RuntimeError("invalid SOCKS response address type")
        recv_exact_sock(s, 2)
        s.settimeout(timeout)
        return s
    except Exception as exc:
        s.close()
        if cancel_event and cancel_event.is_set():
            raise RuntimeError("request cancelled") from exc
        raise


def safe_request_headers(raw):
    blocked = {"connection", "proxy-connection", "transfer-encoding", "content-length", "host"}
    out = {}
    if isinstance(raw, dict):
        for key, value in raw.items():
            k = str(key).strip()
            if not k or "\r" in k or "\n" in k or k.lower() in blocked:
                continue
            v = str(value)
            if "\r" in v or "\n" in v:
                continue
            out[k] = v
    return out


def host_matches_domain_rule(host, rule):
    host = str(host or "").lower().rstrip(".")
    rule = str(rule or "").strip().lower()
    rule = re.sub(r"^https?://", "", rule).split("/")[0].split(":")[0].rstrip(".")
    if not host or not rule:
        return False
    if rule in ("*", "<all_urls>"):
        return True
    if rule.startswith("*.") or rule.startswith("."):
        suffix = rule[2:] if rule.startswith("*.") else rule[1:]
        return host == suffix or host.endswith("." + suffix)
    return host == rule


def is_local_or_reserved_host(host):
    host = str(host or "").lower().strip("[]")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped:
            address = address.ipv4_mapped
        else:
            return address.is_loopback or address.is_unspecified or address.is_link_local or address.is_multicast or address in ipaddress.ip_network("fc00::/7")
    reserved_v4 = (
        ipaddress.ip_network("0.0.0.0/8"),
        ipaddress.ip_network("10.0.0.0/8"),
        ipaddress.ip_network("127.0.0.0/8"),
        ipaddress.ip_network("169.254.0.0/16"),
        ipaddress.ip_network("172.16.0.0/12"),
        ipaddress.ip_network("192.168.0.0/16"),
        ipaddress.ip_network("100.64.0.0/10"),
        ipaddress.ip_network("224.0.0.0/4"),
    )
    return any(address in network for network in reserved_v4)


def validate_persona_url_policy(policy):
    required = ("block_local_network", "domain_mode", "allowed_domains", "blocked_domains")
    if not isinstance(policy, dict) or any(key not in policy for key in required):
        raise ValueError("invalid Persona URL policy")
    if not isinstance(policy["block_local_network"], bool):
        raise ValueError("invalid Persona URL policy")
    if policy["domain_mode"] not in ("any", "allowlist"):
        raise ValueError("invalid Persona URL policy")
    for key in ("allowed_domains", "blocked_domains"):
        values = policy[key]
        if not isinstance(values, list) or len(values) > 256:
            raise ValueError("invalid Persona URL policy")
        if any(not isinstance(value, str) or len(value) > 512 for value in values):
            raise ValueError("invalid Persona URL policy")
    return policy


def persona_url_policy_reason(policy, url):
    validate_persona_url_policy(policy)
    try:
        parsed = urlsplit(str(url))
        host = parsed.hostname
    except ValueError:
        raise ValueError("invalid Persona URL policy target")
    if parsed.scheme not in ("http", "https") or not host:
        return None

    block_local = policy["block_local_network"]
    if block_local and is_local_or_reserved_host(host):
        return "local-network-blocked"

    domain_mode = policy["domain_mode"]
    rule_lists = {key: policy[key] for key in ("allowed_domains", "blocked_domains")}

    if any(host_matches_domain_rule(host, rule) for rule in rule_lists["blocked_domains"]):
        return "blocked-domain"
    if domain_mode == "allowlist" and not any(host_matches_domain_rule(host, rule) for rule in rule_lists["allowed_domains"]):
        return "not-on-allowlist"
    return None


def validate_userscript_connect_policy(policy):
    """Require an explicit, bounded page origin and @connect rule list."""
    if not isinstance(policy, dict) or "page_url" not in policy or "rules" not in policy:
        raise ValueError("invalid userscript @connect policy")
    page_url = policy.get("page_url")
    rules = policy.get("rules", [])
    if not isinstance(page_url, str) or len(page_url) > 4096 or not isinstance(rules, list) or len(rules) > 256:
        raise ValueError("invalid userscript @connect policy")
    if any(not isinstance(rule, str) or len(rule) > 512 for rule in rules):
        raise ValueError("invalid userscript @connect policy")
    try:
        page = urlsplit(page_url)
        if page.scheme not in ("http", "https") or not page.hostname:
            raise ValueError("invalid userscript @connect policy")
        page.port
    except ValueError as exc:
        raise ValueError("invalid userscript @connect policy") from exc
    return policy


def validate_relay_fetch_policies(request):
    validate_persona_url_policy(request.get("network_policy"))
    validate_userscript_connect_policy(request.get("connect_policy"))


def userscript_connect_allowed(policy, url):
    """Check GM @connect rules on every routed request and redirect target."""
    validate_userscript_connect_policy(policy)
    page_url = policy["page_url"]
    rules = policy["rules"]
    try:
        target = urlsplit(str(url))
        page = urlsplit(page_url)
        target_host = (target.hostname or "").lower()
        page_host = (page.hostname or "").lower()
        target_port = target.port or (443 if target.scheme == "https" else 80)
        page_port = page.port or (443 if page.scheme == "https" else 80)
    except ValueError as exc:
        raise ValueError("invalid userscript @connect target") from exc
    if target.scheme not in ("http", "https") or not target_host or page.scheme not in ("http", "https") or not page_host:
        raise ValueError("invalid userscript @connect target")
    if (target.scheme.lower(), target_host, target_port) == (page.scheme.lower(), page_host, page_port):
        return True
    for raw in rules:
        rule = raw.strip().lower()
        if not rule or rule == "self":
            continue
        if rule == "*":
            return True
        if rule.startswith("*."):
            rule = rule[2:]
        if rule.startswith("http://") or rule.startswith("https://"):
            rule = urlsplit(rule).netloc or urlsplit(rule).path.split("/", 1)[0]
        else:
            rule = rule.split("/", 1)[0]
        rule = rule.rsplit("@", 1)[-1]
        if rule.startswith("[") and "]" in rule:
            rule = rule[1:rule.index("]")]
        else:
            rule = rule.split(":", 1)[0]
        rule = rule.rstrip(".")
        if rule and (target_host == rule or target_host.endswith("." + rule)):
            return True
    return False


def fetch_through_relay(relay_ip, relay_port, req, cancel_event=None, register_socket=None):
    url = str(req.get("url") or "")
    method = str(req.get("method") or "GET").upper()
    if not re.fullmatch(r"[A-Z]{1,16}", method):
        raise ValueError("invalid HTTP method")
    headers = safe_request_headers(req.get("headers") or {})
    raw_body = req.get("body")
    body = b"" if raw_body is None else str(raw_body).encode("utf-8")
    timeout = max(1, min(120, float(req.get("timeout_seconds") or 30)))
    redirects = max(0, min(10, int(req.get("max_redirects") or 5)))
    network_policy = req.get("network_policy")
    connect_policy = req.get("connect_policy")
    validate_relay_fetch_policies(req)

    current = url
    for redirect_count in range(redirects + 1):
        if cancel_event and cancel_event.is_set():
            raise RuntimeError("request cancelled")
        parts = urlsplit(current)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("GM request target must be HTTP(S)")
        policy_reason = persona_url_policy_reason(network_policy, current)
        if policy_reason:
            raise ValueError(f"request blocked by Persona URL policy ({policy_reason})")
        if not userscript_connect_allowed(connect_policy, current):
            try:
                denied_host = urlsplit(current).hostname or "unknown host"
            except ValueError:
                denied_host = "unknown host"
            raise ValueError(f"request blocked by userscript @connect policy ({denied_host})")
        target_port = parts.port or (443 if parts.scheme == "https" else 80)
        if cancel_event:
            sock = socks5_connect_via_wg(
                relay_ip, relay_port, parts.hostname, target_port, timeout,
                cancel_event=cancel_event, register_socket=register_socket
            )
        else:
            sock = socks5_connect_via_wg(relay_ip, relay_port, parts.hostname, target_port, timeout)
        if register_socket:
            register_socket(sock)
        try:
            if cancel_event and cancel_event.is_set():
                raise RuntimeError("request cancelled")
            if parts.scheme == "https":
                context = ssl.create_default_context()
                sock = context.wrap_socket(sock, server_hostname=parts.hostname, do_handshake_on_connect=False)
                if register_socket:
                    register_socket(sock)
                sock.settimeout(timeout)
                if cancel_event and cancel_event.is_set():
                    raise RuntimeError("request cancelled")
                sock.do_handshake()
            path = parts.path or "/"
            if parts.query:
                path += "?" + parts.query
            host_header = parts.hostname
            if parts.port and parts.port not in (80, 443):
                host_header += f":{parts.port}"
            send_headers = dict(headers)
            send_headers.setdefault("Host", host_header)
            send_headers.setdefault("Accept-Encoding", "identity")
            send_headers["Connection"] = "close"
            if body and method not in ("GET", "HEAD"):
                send_headers["Content-Length"] = str(len(body))
            lines = [f"{method} {path} HTTP/1.1"] + [f"{k}: {v}" for k, v in send_headers.items()] + ["", ""]
            sock.sendall("\r\n".join(lines).encode("iso-8859-1", "replace"))
            if body and method not in ("GET", "HEAD"):
                sock.sendall(body)
            response = http.client.HTTPResponse(sock, method=method)
            response.begin()
            status = int(response.status)
            response_headers = response.getheaders()
            location = response.getheader("Location")
            if status in (301, 302, 303, 307, 308) and location and redirect_count < redirects:
                next_url = urljoin(current, location)
                old_parts = urlsplit(current)
                new_parts = urlsplit(next_url)
                old_port = old_parts.port or (443 if old_parts.scheme == "https" else 80)
                new_port = new_parts.port or (443 if new_parts.scheme == "https" else 80)
                old_origin = (old_parts.scheme.lower(), (old_parts.hostname or "").lower(), old_port)
                new_origin = (new_parts.scheme.lower(), (new_parts.hostname or "").lower(), new_port)
                if new_origin != old_origin:
                    # Do not forward credentials/container cookies supplied for one
                    # origin to an unrelated redirect destination. This mirrors
                    # the security boundary expected from browser fetch/XHR.
                    sensitive = {"authorization", "proxy-authorization", "cookie", "referer", "origin"}
                    headers = {k: v for k, v in headers.items() if k.lower() not in sensitive}
                current = next_url
                if status in (301, 302, 303) and method not in ("GET", "HEAD"):
                    method = "GET"
                    body = b""
                    headers = {k: v for k, v in headers.items() if k.lower() not in {"content-type", "content-length"}}
                continue
            data = response.read(MAX_FETCH_RESPONSE + 1)
            if cancel_event and cancel_event.is_set():
                raise RuntimeError("request cancelled")
            if len(data) > MAX_FETCH_RESPONSE:
                raise RuntimeError(f"routed native fetch response exceeds {MAX_FETCH_RESPONSE} bytes")
            return {
                "ok": True,
                "final_url": current,
                "status": status,
                "status_text": response.reason or "",
                "headers": [[str(k), str(v)] for k, v in response_headers],
                "body_base64": base64.b64encode(data).decode("ascii"),
            }
        except Exception as exc:
            if cancel_event and cancel_event.is_set():
                raise RuntimeError("request cancelled") from exc
            raise
        finally:
            try:
                sock.close()
            except Exception:
                pass
    raise RuntimeError("too many redirects")


def socket_read_exact(sock, length):
    chunks = []
    remaining = length
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise ConnectionError("SOCKS client disconnected during authentication")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def authenticate_forwarder_client(client, token):
    """Require SOCKS5 username/password before opening the Mullvad relay."""
    try:
        version, method_count = socket_read_exact(client, 2)
        if version != 5 or method_count == 0:
            client.sendall(b"\x05\xff")
            return False
        methods = socket_read_exact(client, method_count)
        if 2 not in methods:
            client.sendall(b"\x05\xff")
            return False
        client.sendall(b"\x05\x02")

        auth_version, username_length = socket_read_exact(client, 2)
        username = socket_read_exact(client, username_length)
        (password_length,) = socket_read_exact(client, 1)
        password = socket_read_exact(client, password_length)
        expected = token.encode("ascii") if isinstance(token, str) else b""
        authorized = (
            auth_version == 1
            and username == FORWARDER_USERNAME.encode("ascii")
            and bool(expected)
            and hmac.compare_digest(password, expected)
        )
        client.sendall(b"\x01\x00" if authorized else b"\x01\x01")
        return authorized
    except (ConnectionError, OSError, ValueError, IndexError):
        return False


class ExitForwarder:
    def __init__(self, route_id, relay_ip, relay_port, listen_port, forwarder_token):
        self.route_id = route_id
        self.relay_ip = relay_ip
        self.relay_port = relay_port
        self.listen_port = listen_port
        self.forwarder_token = forwarder_token
        self.token_expires_at = time.monotonic() + FORWARDER_TOKEN_TTL_SECONDS
        self.token_generation = 0
        self.retired_token_digests = set()
        self.server = None
        self.thread = None
        self.active_sockets = set()
        self.active_clients_lock = threading.RLock()
        self.stopping = False

    def start(self):
        if not isinstance(self.forwarder_token, str) or not FORWARDER_TOKEN_RE.fullmatch(self.forwarder_token):
            raise ValueError("forwarder authentication is required")
        relay_ip, relay_port = self.relay_ip, self.relay_port
        forwarder = self

        with self.active_clients_lock:
            self.stopping = False
            self.token_expires_at = time.monotonic() + FORWARDER_TOKEN_TTL_SECONDS

        class Handler(socketserver.BaseRequestHandler):
            def handle(inner_self):
                downstream = inner_self.request
                upstream = None
                try:
                    token, generation = forwarder._register_downstream(downstream)
                    if token is None:
                        return
                    downstream.settimeout(7)
                    if not authenticate_forwarder_client(downstream, token):
                        return

                    upstream, connect_result = forwarder._begin_upstream_connect(
                        relay_ip, relay_port, generation
                    )
                    forwarder._finish_upstream_connect(upstream, connect_result, generation)
                    if not forwarder._send_upstream_greeting(upstream, generation):
                        return
                    # The local hop authenticates the extension. Mullvad's relay
                    # remains a no-auth SOCKS5 endpoint reached only through wg.
                    if socket_read_exact(upstream, 2) != b"\x05\x00":
                        return
                    if not forwarder._generation_is_current(generation):
                        return

                    upstream.settimeout(None)
                    downstream.settimeout(None)
                    sockets = [downstream, upstream]
                    while True:
                        readable, _, exceptional = select.select(sockets, [], sockets, 60)
                        if exceptional:
                            break
                        if not readable:
                            continue
                        for src in readable:
                            data = src.recv(65536)
                            if not data:
                                return
                            dst = upstream if src is downstream else downstream
                            dst.sendall(data)
                except (OSError, ValueError):
                    return
                finally:
                    with forwarder.active_clients_lock:
                        forwarder.active_sockets.discard(downstream)
                        if upstream is not None:
                            forwarder.active_sockets.discard(upstream)
                    for sock in (downstream, upstream):
                        if sock is not None:
                            try:
                                sock.close()
                            except OSError:
                                pass

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self.server = Server(("127.0.0.1", self.listen_port), Handler)
        self.listen_port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, name=f"exit-{self.route_id}", daemon=True)
        self.thread.start()

    def _expire_token_locked(self, now=None):
        now = time.monotonic() if now is None else now
        if self.forwarder_token is not None and now >= self.token_expires_at:
            digest = hashlib.sha256(self.forwarder_token.encode("ascii")).digest()
            self.retired_token_digests.add(digest)
            self.forwarder_token = None
            self.token_expires_at = 0
            self.token_generation += 1

    def _register_downstream(self, downstream):
        with self.active_clients_lock:
            self._expire_token_locked()
            if self.stopping or self.forwarder_token is None:
                return None, self.token_generation
            self.active_sockets.add(downstream)
            return self.forwarder_token, self.token_generation

    def _generation_is_current(self, generation):
        with self.active_clients_lock:
            self._expire_token_locked()
            return (
                not self.stopping
                and generation == self.token_generation
                and self.forwarder_token is not None
            )

    def _begin_upstream_connect(self, relay_ip, relay_port, generation):
        """Start connect_ex while holding the revoke gate, then wait outside it."""
        with self.active_clients_lock:
            self._expire_token_locked()
            if (
                self.stopping
                or generation != self.token_generation
                or self.forwarder_token is None
            ):
                raise OSError("forwarder credential expired or revoked")
            upstream = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.active_sockets.add(upstream)
            try:
                upstream.setblocking(False)
                upstream.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, (WG_IF + "\0").encode())
                result = upstream.connect_ex((relay_ip, int(relay_port)))
            except Exception:
                self.active_sockets.discard(upstream)
                upstream.close()
                raise
        in_progress = {errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, errno.EINTR}
        if result not in (0, errno.EISCONN) and result not in in_progress:
            with self.active_clients_lock:
                self.active_sockets.discard(upstream)
            upstream.close()
            raise OSError(result, os.strerror(result))
        return upstream, result

    def _finish_upstream_connect(self, upstream, result, generation, timeout=7):
        deadline = time.monotonic() + timeout
        in_progress = {errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, errno.EINTR}
        while result not in (0, errno.EISCONN):
            if self.stopping:
                raise OSError("forwarder stopped while connecting")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise socket.timeout("timed out connecting to Mullvad relay")
            _readable, writable, exceptional = select.select([], [upstream], [upstream], min(0.1, remaining))
            if writable or exceptional:
                result = upstream.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                if result:
                    raise OSError(result, os.strerror(result))
                break
        with self.active_clients_lock:
            self._expire_token_locked()
            if self.stopping or generation != self.token_generation or self.forwarder_token is None:
                raise OSError("forwarder credential expired or revoked")
            upstream.settimeout(7)

    def _send_upstream_greeting(self, upstream, generation):
        # Serialize this small protocol write with credential revocation. Once
        # stop/rotation takes the lock, no newly authenticated client can start
        # a relay session with a stale generation.
        with self.active_clients_lock:
            self._expire_token_locked()
            if self.stopping or generation != self.token_generation or self.forwarder_token is None:
                return False
            upstream.sendall(b"\x05\x01\x00")
            return True

    def rotate_token(self, token):
        if not isinstance(token, str) or not FORWARDER_TOKEN_RE.fullmatch(token):
            raise ValueError("forwarder authentication is required")
        new_digest = hashlib.sha256(token.encode("ascii")).digest()
        with self.active_clients_lock:
            self._expire_token_locked()
            if self.stopping:
                raise RuntimeError("forwarder is stopping")
            if new_digest in self.retired_token_digests:
                raise ValueError("forwarder token has expired")
            if self.forwarder_token == token:
                return
            if self.forwarder_token is not None:
                self.retired_token_digests.add(
                    hashlib.sha256(self.forwarder_token.encode("ascii")).digest()
                )
            self.forwarder_token = token
            self.token_expires_at = time.monotonic() + FORWARDER_TOKEN_TTL_SECONDS
            self.token_generation += 1

    def stop(self):
        with self.active_clients_lock:
            # This lock is also the gate used before an upstream connect starts.
            self.stopping = True
            if self.forwarder_token is not None:
                self.retired_token_digests.add(
                    hashlib.sha256(self.forwarder_token.encode("ascii")).digest()
                )
            self.forwarder_token = None
            self.token_expires_at = 0
            self.token_generation += 1
            sockets = list(self.active_sockets)
            server, thread = self.server, self.thread
            self.server = None
            self.thread = None

        errors = []
        if server:
            try:
                server.shutdown()
            except Exception as exc:
                errors.append(exc)
            try:
                server.server_close()
            except Exception as exc:
                errors.append(exc)
        for sock in sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError as exc:
                errors.append(exc)
        if thread and thread is not threading.current_thread():
            try:
                thread.join(timeout=2)
            except RuntimeError as exc:
                errors.append(exc)
        if errors:
            raise RuntimeError("one or more forwarder resources failed to close") from errors[0]


class Router:
    def __init__(self):
        self.lock = threading.RLock()
        self.active_fetches_lock = threading.RLock()
        self.active_fetches = {}
        self.cancelled_fetches = {}
        self.forwarders = {}

    def status(self):
        selected = read_selected()
        up = iface_up()
        base_route = False
        base_proxy = False
        if up:
            try:
                add_route(BASE_PROXY_IP)
                base_route = route_bound_to_wg(BASE_PROXY_IP)
                base_proxy = bound_connect(BASE_PROXY_IP, BASE_PROXY_PORT, 0.75)
            except Exception:
                pass
        hs = latest_handshake()
        return {
            "ok": True,
            "version": NATIVE_BRIDGE_VERSION,
            "selected_entry": selected,
            "interface": WG_IF,
            "interface_up": up,
            "base_proxy_reachable": base_proxy,
            "base_route_bound": base_route,
            "latest_handshake_epoch": hs,
            "latest_handshake_age_seconds": (int(time.time()) - hs) if hs else None,
            "ready": bool(up and base_route and base_proxy),
            "mullvad_app_connected": mullvad_app_connected(),
            "active_exits": [
                {
                    "route_id": f.route_id,
                    "relay_ip": f.relay_ip,
                    "relay_port": f.relay_port,
                    "local_host": "127.0.0.1",
                    "local_port": f.listen_port,
                }
                for f in self.forwarders.values()
            ],
        }

    def ensure_up(self):
        with self.lock:
            ensure_active_config()
            if not iface_up() and mullvad_app_connected():
                raise RuntimeError("Mullvad desktop app appears connected. Disconnect it before starting the local bridge.")
            if not iface_up():
                interface_up_direct()
            add_route(BASE_PROXY_IP)
            # Re-add routes for all already configured forwarders after restart.
            for f in self.forwarders.values():
                add_route(f.relay_ip)
            deadline = time.time() + 12
            while time.time() < deadline:
                if bound_connect(BASE_PROXY_IP, BASE_PROXY_PORT, 0.7):
                    break
                time.sleep(0.35)
            st = self.status()
            if not st["ready"]:
                st["ok"] = False
                st["error"] = "WireGuard interface is up but Mullvad SOCKS is not reachable yet"
            return st

    def _stop_forwarders(self):
        # Revoke credentials before taking the tunnel down or switching entries.
        forwarders = list(self.forwarders.values())
        self.forwarders.clear()
        errors = []
        for forwarder in forwarders:
            try:
                forwarder.stop()
            except Exception as exc:
                errors.append(exc)
        if errors:
            raise RuntimeError(f"failed to stop {len(errors)} forwarder(s)") from errors[0]

    def stop(self):
        with self.lock:
            cleanup_error = None
            try:
                self._stop_forwarders()
            except Exception as exc:
                cleanup_error = exc
            interface_error = None
            try:
                if iface_up() or cleanup_error:
                    interface_down_direct()
            except Exception as exc:
                interface_error = exc
            if cleanup_error or interface_error:
                errors = int(cleanup_error is not None) + int(interface_error is not None)
                raise RuntimeError(
                    f"router stop completed cleanup attempts with {errors} error(s)"
                ) from (cleanup_error or interface_error)
            st = self.status()
            st["stopped"] = True
            return st

    def restart(self):
        with self.lock:
            self.stop()
            return self.ensure_up()

    def list_entries(self):
        return {"ok": True, "entries": entry_files(), "selected_entry": read_selected()}

    def set_entry(self, entry_id, start=True):
        with self.lock:
            was_up = iface_up()
            cleanup_error = None
            try:
                self._stop_forwarders()
            except Exception as exc:
                cleanup_error = exc
            interface_error = None
            try:
                if was_up or cleanup_error:
                    interface_down_direct()
            except Exception as exc:
                interface_error = exc
            if cleanup_error or interface_error:
                errors = int(cleanup_error is not None) + int(interface_error is not None)
                raise RuntimeError(
                    f"entry switch stopped before activation after {errors} cleanup error(s)"
                ) from (cleanup_error or interface_error)
            activate_entry(entry_id)
            if start or was_up:
                return self.ensure_up()
            return self.status()

    @staticmethod
    def _validate_relay_target(relay_ip, relay_port):
        ip_obj = ipaddress.ip_address(str(relay_ip))
        if ip_obj.version != 4 or ip_obj not in RELAY_NET:
            raise ValueError(f"relay IP {relay_ip} is outside Mullvad's allowed internal relay range {RELAY_NET}")
        if int(relay_port) != 1080:
            raise ValueError("Mullvad relay port must be 1080")
        return ip_obj, int(relay_port)

    def _prepare_exit_network(self, relay_ip, relay_port=1080, start=True):
        ip_obj, port = self._validate_relay_target(relay_ip, relay_port)
        st = self.ensure_up() if start else self.status()
        if not st["ready"]:
            raise RuntimeError(st.get("error") or "Mullvad tunnel is not ready")
        add_route(str(ip_obj))
        if not bound_connect(str(ip_obj), port, 1.0):
            raise RuntimeError("selected Mullvad SOCKS relay is not reachable through WireGuard")
        return st, ip_obj, port

    def prepare_exit(self, route_id, relay_ip, relay_port=1080, start=True, forwarder_token=None):
        with self.lock:
            if not ROUTE_ID_RE.fullmatch(str(route_id or "")):
                raise ValueError("invalid route id")
            if not isinstance(forwarder_token, str) or not FORWARDER_TOKEN_RE.fullmatch(forwarder_token):
                raise ValueError("forwarder authentication is required")
            ip_obj, port = self._validate_relay_target(relay_ip, relay_port)
            existing = self.forwarders.get(route_id)
            if existing and existing.relay_ip == str(ip_obj) and existing.relay_port == port:
                # Refuse a caller trying to extend an expired lease by replaying
                # the old credential. The extension must supply fresh entropy.
                with existing.active_clients_lock:
                    existing._expire_token_locked()
                    if existing.forwarder_token is None and (
                        hashlib.sha256(forwarder_token.encode("ascii")).digest()
                        in existing.retired_token_digests
                    ):
                        raise ValueError("forwarder token has expired")
            st, ip_obj, port = self._prepare_exit_network(relay_ip, relay_port, start)
            existing = self.forwarders.get(route_id)
            if existing and (existing.relay_ip != str(ip_obj) or existing.relay_port != port):
                existing.stop()
                del self.forwarders[route_id]
                existing = None
            if not existing:
                # Bind localhost only. Port 0 lets the kernel choose an unused port.
                existing = ExitForwarder(route_id, str(ip_obj), port, 0, forwarder_token)
                existing.start()
                self.forwarders[route_id] = existing
            else:
                # Credential rotation changes only what future SOCKS handshakes
                # can authenticate; established TCP sessions remain untouched.
                existing.rotate_token(forwarder_token)
            return {
                "ok": True,
                "ready": True,
                "route_id": route_id,
                "relay_ip": str(ip_obj),
                "relay_port": port,
                "local_host": "127.0.0.1",
                "local_port": existing.listen_port,
                "selected_entry": read_selected(),
            }

    def release_exit(self, route_id):
        if not isinstance(route_id, str) or not ROUTE_ID_RE.fullmatch(route_id):
            raise ValueError("invalid route id")
        with self.lock:
            f = self.forwarders.pop(route_id, None)
            if f:
                f.stop()
            return {"ok": True, "released": bool(f)}

    def fetch_exit(self, route_id, relay_ip, relay_port, request):
        # prepare_exit protects forwarder/interface mutation with self.lock. Do not
        # hold the router-wide lock during the network request: automation may
        # legitimately have many concurrent GM requests across tabs/personas.
        request = dict(request or {})
        validate_relay_fetch_policies(request)
        if not isinstance(route_id, str) or not ROUTE_ID_RE.fullmatch(route_id):
            raise ValueError("invalid route id")
        self._validate_relay_target(relay_ip, relay_port)
        request_id = request.get("request_id")
        fetch_state = None
        if request_id is not None:
            if not isinstance(request_id, str) or not FETCH_REQUEST_ID_RE.fullmatch(request_id):
                raise ValueError("invalid fetch request id")
            fetch_state = {"cancelled": threading.Event(), "socket": None}
            with self.active_fetches_lock:
                now = time.time()
                self.cancelled_fetches = {key: stamped for key, stamped in self.cancelled_fetches.items() if now - stamped < 60}
                if request_id in self.active_fetches:
                    raise ValueError("fetch request id is already active")
                if self.cancelled_fetches.pop(request_id, None) is not None:
                    fetch_state["cancelled"].set()
                self.active_fetches[request_id] = fetch_state

        try:
            if fetch_state and fetch_state["cancelled"].is_set():
                raise RuntimeError("request cancelled")
            with self.lock:
                self._prepare_exit_network(relay_ip, relay_port, True)
            if fetch_state and fetch_state["cancelled"].is_set():
                raise RuntimeError("request cancelled")

            def register_socket(sock):
                if not fetch_state:
                    return
                with self.active_fetches_lock:
                    current = self.active_fetches.get(request_id)
                    if current is not fetch_state or fetch_state["cancelled"].is_set():
                        should_close = True
                    else:
                        fetch_state["socket"] = sock
                        should_close = False
                if should_close:
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

            return fetch_through_relay(
                str(relay_ip), int(relay_port), request,
                fetch_state["cancelled"] if fetch_state else None,
                register_socket if fetch_state else None
            )
        finally:
            if fetch_state:
                with self.active_fetches_lock:
                    if self.active_fetches.get(request_id) is fetch_state:
                        self.active_fetches.pop(request_id, None)

    def cancel_fetch(self, request_id):
        if not isinstance(request_id, str) or not FETCH_REQUEST_ID_RE.fullmatch(request_id):
            raise ValueError("invalid fetch request id")
        with self.active_fetches_lock:
            now = time.time()
            self.cancelled_fetches = {key: stamped for key, stamped in self.cancelled_fetches.items() if now - stamped < 60}
            fetch_state = self.active_fetches.get(request_id)
            if not fetch_state:
                if len(self.cancelled_fetches) >= 1000:
                    oldest = min(self.cancelled_fetches, key=self.cancelled_fetches.get)
                    self.cancelled_fetches.pop(oldest, None)
                self.cancelled_fetches[request_id] = now
                return {"ok": True, "cancelled": False, "pending": True}
            fetch_state["cancelled"].set()
            sock = fetch_state.get("socket")
        if sock:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        return {"ok": True, "cancelled": True}

    def dispatch(self, req):
        cmd = req.get("command")
        if cmd == "status":
            return self.status()
        if cmd == "ensure_up":
            return self.ensure_up()
        if cmd == "stop":
            return self.stop()
        if cmd == "restart":
            return self.restart()
        if cmd == "list_entries":
            return self.list_entries()
        if cmd == "set_entry":
            return self.set_entry(req.get("entry_id"), bool(req.get("start", True)))
        if cmd == "prepare_exit":
            return self.prepare_exit(
                req.get("route_id"), req.get("relay_ip"), req.get("relay_port", 1080),
                bool(req.get("start", True)), req.get("forwarder_token")
            )
        if cmd == "release_exit":
            return self.release_exit(req.get("route_id"))
        if cmd == "fetch_exit":
            return self.fetch_exit(req.get("route_id"), req.get("relay_ip"), req.get("relay_port", 1080), req.get("request") or {})
        if cmd == "cancel_fetch":
            return self.cancel_fetch(req.get("request_id"))
        if cmd == "ping":
            return {"ok": True, "version": NATIVE_BRIDGE_VERSION}
        raise ValueError("unsupported command")


ROUTER = Router()


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        raw = self.rfile.readline(MAX_REQ + 1)
        if len(raw) > MAX_REQ:
            return
        try:
            req = json.loads(raw.decode("utf-8"))
            if not isinstance(req, dict):
                raise ValueError("request must be an object")
            response = ROUTER.dispatch(req)
        except Exception as exc:
            response = {"ok": False, "error": str(exc)}
        if "id" in (req if isinstance(locals().get("req"), dict) else {}):
            response["id"] = req["id"]
        self.wfile.write((json.dumps(response, separators=(",", ":")) + "\n").encode("utf-8"))


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def secure_control_socket(path, uid, gid):
    # The hardened service intentionally does not retain CAP_FOWNER. The daemon
    # owns the freshly-created socket initially, so set its final mode before
    # handing ownership to the desktop user. Reversing these calls makes the
    # subsequent chmod fail with EPERM once ownership has changed.
    os.chmod(path, 0o600)
    os.chown(path, uid, gid)


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    ENTRIES.mkdir(parents=True, exist_ok=True)
    ensure_active_config()
    SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass
    server = UnixServer(str(SOCKET_PATH), Handler)
    uid = int(os.environ.get("PRM_CONTROL_UID", "0"))
    gid = int(os.environ.get("PRM_CONTROL_GID", "0"))
    secure_control_socket(SOCKET_PATH, uid, gid)

    def shutdown(_sig, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        try:
            # Shutdown must be self-contained. The control socket is mode 0600
            # and owned by the desktop user, so a capability-restricted
            # systemd control process must not need to reconnect through it.
            ROUTER.stop()
        finally:
            server.server_close()
            try:
                SOCKET_PATH.unlink()
            except FileNotFoundError:
                pass


if __name__ == "__main__":
    main()
