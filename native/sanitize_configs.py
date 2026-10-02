#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import zipfile
from pathlib import Path

ALLOWED_INTERFACE = {"PrivateKey", "Address", "MTU"}
ALLOWED_PEER = {"PublicKey", "PresharedKey", "AllowedIPs", "Endpoint", "PersistentKeepalive"}
NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_name(name: str) -> str:
    name = Path(name).name
    stem = Path(name).stem
    stem = NAME_RE.sub("-", stem).strip(".-")[:120]
    return stem or "mullvad-entry"


def parse_config(text: str):
    section = None
    seen_sections = []
    values = {"Interface": [], "Peer": []}
    removed = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip()
            if section not in ("Interface", "Peer"):
                raise ValueError(f"unsupported section [{section}]")
            seen_sections.append(section)
            if seen_sections.count(section) > 1:
                raise ValueError(f"multiple [{section}] sections are not supported")
            continue
        if section not in values or "=" not in line:
            raise ValueError(f"invalid line: {raw[:120]}")
        key, value = [x.strip() for x in line.split("=", 1)]
        allowed = ALLOWED_INTERFACE if section == "Interface" else ALLOWED_PEER
        if key in allowed:
            values[section].append((key, value))
        else:
            removed.append(f"{section}.{key}")

    if "Interface" not in seen_sections or "Peer" not in seen_sections:
        raise ValueError("config must contain [Interface] and [Peer]")
    kv_i = dict(values["Interface"])
    kv_p = dict(values["Peer"])
    for req in ("PrivateKey", "Address"):
        if not kv_i.get(req):
            raise ValueError(f"missing Interface.{req}")
    for req in ("PublicKey", "AllowedIPs", "Endpoint"):
        if not kv_p.get(req):
            raise ValueError(f"missing Peer.{req}")

    # Reconstruct a safe WireGuard source file. Table=off documents that the
    # host's default route is never replaced by this service.
    out = ["[Interface]"]
    for key in ("PrivateKey", "Address", "MTU"):
        if kv_i.get(key):
            out.append(f"{key} = {kv_i[key]}")
    out.append("Table = off")
    out.append("")
    out.append("[Peer]")
    for key in ("PublicKey", "PresharedKey", "AllowedIPs", "Endpoint", "PersistentKeepalive"):
        if kv_p.get(key):
            out.append(f"{key} = {kv_p[key]}")
    out.append("")
    return "\n".join(out), removed, kv_p.get("Endpoint", "")


def iter_configs(source: Path):
    if source.is_dir():
        for p in sorted(source.rglob("*.conf")):
            yield p.name, p.read_text(encoding="utf-8")
        return
    if source.suffix.lower() == ".conf":
        yield source.name, source.read_text(encoding="utf-8")
        return
    if source.suffix.lower() == ".zip":
        with zipfile.ZipFile(source) as zf:
            for info in sorted(zf.infolist(), key=lambda i: i.filename):
                if info.is_dir() or not info.filename.lower().endswith(".conf"):
                    continue
                # Reject symlinks and absurdly large entries.
                mode = (info.external_attr >> 16) & 0o170000
                if mode == stat.S_IFLNK:
                    continue
                if info.file_size > 256 * 1024:
                    raise ValueError(f"config too large: {info.filename}")
                yield Path(info.filename).name, zf.read(info).decode("utf-8")
        return
    raise ValueError("source must be a Mullvad .zip, .conf, or directory")


def write_private_atomic(path: Path, text: str):
    """Write secret-bearing text through a private same-directory temp file.

    `mkstemp` creates the file with mode 0600 before any config bytes are
    written. Keeping the temporary file beside the destination lets replace()
    switch names atomically without exposing a partially written config.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp_path = Path(temp_name)
    open_fd = fd
    try:
        # Keep the private mode invariant explicit before the first secret byte.
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            open_fd = None
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
    finally:
        if open_fd is not None:
            os.close(open_fd)
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def import_configs(source: Path, dest: Path):
    dest.mkdir(parents=True, exist_ok=True)
    imported = []
    failures = []
    for filename, text in iter_configs(source):
        try:
            sanitized, removed, endpoint = parse_config(text)
            entry_id = safe_name(filename)
            path = dest / f"{entry_id}.conf"
            # Avoid collisions from nested ZIP paths or duplicate names.
            base = entry_id
            n = 2
            while path.exists():
                existing = path.read_text(encoding="utf-8")
                if existing == sanitized:
                    break
                entry_id = f"{base}-{n}"
                path = dest / f"{entry_id}.conf"
                n += 1
            write_private_atomic(path, sanitized)
            imported.append({"id": entry_id, "file": path.name, "endpoint": endpoint, "removed": removed})
        except Exception as exc:
            failures.append({"file": filename, "error": str(exc)})
    if not imported:
        raise ValueError(f"no valid WireGuard configs imported; failures={failures}")
    manifest = {"entries": imported, "failures": failures}
    mpath = dest.parent / "entries.json"
    write_private_atomic(mpath, json.dumps(manifest, indent=2))
    return manifest


def main():
    ap = argparse.ArgumentParser(description="Import and sanitize Mullvad WireGuard configs")
    ap.add_argument("source")
    ap.add_argument("dest")
    args = ap.parse_args()
    manifest = import_configs(Path(args.source).expanduser().resolve(), Path(args.dest).resolve())
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
