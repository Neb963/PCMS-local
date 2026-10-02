#!/usr/bin/env python3
import argparse
import json
import socket
import sys

SOCKET_PATH = "/run/persona-mullvad-router/control.sock"

def call(req):
    s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    s.settimeout(45)
    s.connect(SOCKET_PATH)
    s.sendall((json.dumps(req,separators=(",",":"))+"\n").encode())
    data=b""
    while b"\n" not in data and len(data)<1024*1024:
        c=s.recv(65536)
        if not c: break
        data+=c
    s.close()
    if not data: raise RuntimeError("no response from daemon")
    return json.loads(data.split(b"\n",1)[0])

def main():
    ap=argparse.ArgumentParser(prog="persona-mullvad-router")
    sub=ap.add_subparsers(dest="cmd",required=True)
    sub.add_parser("status")
    sub.add_parser("ping")
    sub.add_parser("up")
    sub.add_parser("down")
    sub.add_parser("restart")
    sub.add_parser("entries")
    p=sub.add_parser("entry"); p.add_argument("id")
    p=sub.add_parser("prepare-exit"); p.add_argument("route_id"); p.add_argument("relay_ip")
    args=ap.parse_args()
    mapping={"status":"status","ping":"ping","up":"ensure_up","down":"stop","restart":"restart","entries":"list_entries"}
    if args.cmd in mapping: req={"command":mapping[args.cmd]}
    elif args.cmd=="entry": req={"command":"set_entry","entry_id":args.id,"start":True}
    else: req={"command":"prepare_exit","route_id":args.route_id,"relay_ip":args.relay_ip,"relay_port":1080,"start":True}
    out=call(req)
    print(json.dumps(out,indent=2))
    raise SystemExit(0 if out.get("ok",False) else 1)

if __name__=="__main__": main()
