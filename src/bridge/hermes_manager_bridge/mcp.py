"""Hermes Manager as an MCP server: every bridge operation and every window operation is an MCP tool.

    python -m hermes_manager_bridge.mcp                  stdio (Claude Desktop, ABP, Cursor, VS Code...)
    python -m hermes_manager_bridge.mcp --tools compact  3 tools (search, describe, call) instead of one per operation

It uses the running bridge (the app's, or one another program started), found through ~/.hermes-manager/control.json,
and starts a headless one if there is none, so a tool call can reach Hermes with or without the window, and can open
the window (gui_launch) and drive it.

The protocol is implemented here (JSON-RPC 2.0: initialize, tools/list, tools/call, ping); tools are all it offers.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

from . import __version__, control

PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")


class Bridge:
    def __init__(self, url: str, token: str) -> None:
        self.url, self.token = url.rstrip("/"), token

    def request(self, method: str, path: str, body: Any = None, timeout: float = 900) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read() or b"{}").get("detail")
            except ValueError:
                detail = None
            raise RuntimeError(f"{detail or e.reason} (HTTP {e.code})") from None
        return json.loads(raw) if raw else None


def connect(start: bool = True, wait_s: float = 30.0) -> Bridge:
    found = control.alive()
    if not found and start:
        env = {**os.environ, "HM_BRIDGE_TOKEN": control.new_token(),
               "PYTHONPATH": os.pathsep.join([str(Path(__file__).resolve().parent.parent), os.environ.get("PYTHONPATH", "")])}
        flags = (0x00000008 | 0x00000200 | 0x08000000) if os.name == "nt" else 0
        with open(control.home() / "bridge.log", "ab") as log:
            subprocess.Popen([sys.executable, "-m", "hermes_manager_bridge", "--discovery", "--owner", "mcp"], env=env,
                             stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, creationflags=flags,
                             start_new_session=os.name != "nt")
        deadline = time.time() + wait_s
        while time.time() < deadline and not found:
            time.sleep(0.3)
            found = control.alive(timeout=1.0)
    if not found:
        raise RuntimeError("no Hermes Manager bridge is running and one could not be started")
    return Bridge(found["url"], found["token"])


def tool_name(op_id: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", op_id)[:64]


class Handler:
    def __init__(self, bridge: Bridge, mode: str = "all") -> None:
        self.bridge = bridge
        self.mode = mode
        self.ops = bridge.request("GET", "/api/v1/operations")
        self.gui = bridge.request("GET", "/api/v1/gui/operations")
        self.by_tool = {tool_name(o["id"]): ("api", o) for o in self.ops}
        self.by_tool.update({tool_name(o["id"]): ("gui", o) for o in self.gui})
        self.by_tool["gui_launch"] = ("launch", {"id": "gui.launch"})

    def tools(self) -> list[dict]:
        meta = [
            {"name": "hm_operations", "description": "Search Hermes Manager's operations (gateway, logs, sessions, chat, config, "
                                                     "updates, backups, tools, gui)",
             "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}}, "annotations": {"readOnlyHint": True}},
            {"name": "hm_call", "description": "Run any Hermes Manager operation by id with its arguments",
             "inputSchema": {"type": "object", "properties": {"operation": {"type": "string"}, "args": {"type": "object"}},
                             "required": ["operation"]}},
        ]
        if self.mode == "compact":
            return meta
        out = []
        for o in self.ops:
            out.append({"name": tool_name(o["id"]), "title": o["id"], "description": o["summary"], "inputSchema": o["params"],
                        "annotations": {"readOnlyHint": not o["mutating"], "destructiveHint": o["id"] in (
                            "backups.delete", "config.apply", "backups.restore", "updates.apply")}})
        for o in self.gui:
            schema = {"type": "object", "properties": o.get("params") or {}}
            if o.get("required"):
                schema["required"] = o["required"]
            out.append({"name": tool_name(o["id"]), "title": o["id"], "description": o["summary"] + " (needs the window; gui_launch opens it)",
                        "inputSchema": schema, "annotations": {"readOnlyHint": not o.get("mutating")}})
        out.append({"name": "gui_launch", "description": "Open the Hermes Manager window (if closed) and wait until it can be driven",
                    "inputSchema": {"type": "object", "properties": {"wait_s": {"type": "number", "default": 60}}}})
        return out + meta

    def _run(self, op_id: str, args: dict) -> Any:
        if op_id == "gui.launch":
            return self.bridge.request("POST", "/api/v1/gui/launch", {"wait_s": args.get("wait_s", 60)})
        if op_id.startswith("gui."):
            return self.bridge.request("POST", f"/api/v1/gui/{op_id[4:]}", args)
        return self.bridge.request("POST", f"/api/v1/call/{op_id}", args)

    async def call_tool(self, name: str, args: dict) -> dict:
        try:
            if name == "hm_operations":
                q = (args.get("query") or "").lower().split()
                result: Any = [{"id": o["id"], "summary": o["summary"], "changes": o.get("mutating", False)}
                               for o in self.ops + self.gui if all(w in f"{o['id']} {o['summary']}".lower() for w in q)]
            elif name == "hm_call":
                result = await asyncio.to_thread(self._run, str(args.get("operation", "")), dict(args.get("args") or {}))
            elif name in self.by_tool:
                result = await asyncio.to_thread(self._run, self.by_tool[name][1]["id"], args)
            else:
                raise RuntimeError(f"unknown tool {name!r}")
        except Exception as e:  # noqa: BLE001 - reported to the model
            return {"content": [{"type": "text", "text": f"Error: {e}"}], "isError": True}
        content: list[dict] = [{"type": "text", "text": json.dumps(result, indent=1, default=str)[:200_000]}]
        if isinstance(result, dict) and result.get("format") == "png" and result.get("base64"):
            content = [{"type": "image", "data": result["base64"], "mimeType": "image/png"},
                       {"type": "text", "text": json.dumps({k: v for k, v in result.items() if k != "base64"})}]
        return {"content": content, "isError": False}

    async def handle(self, msg: dict) -> Optional[dict]:
        mid, method, params = msg.get("id"), msg.get("method", ""), msg.get("params") or {}
        if mid is None:
            return None
        if method == "initialize":
            v = params.get("protocolVersion", PROTOCOL_VERSIONS[0])
            result: Any = {"protocolVersion": v if v in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                           "capabilities": {"tools": {"listChanged": False}},
                           "serverInfo": {"name": "hermes-manager", "title": "Hermes Manager", "version": __version__},
                           "instructions": "Manage a Hermes agent install: gateway, logs, sessions, chat, config, updates, "
                                           "backups, MCP servers, skills, cron, plugins, models. gui_launch opens the "
                                           "Hermes Manager window; gui_* tools drive it."}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": self.tools()}
        elif method == "tools/call":
            result = await self.call_tool(params.get("name", ""), params.get("arguments") or {})
        elif method in ("resources/list", "prompts/list"):
            result = {method.split("/")[0]: []}
        else:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}}
        return {"jsonrpc": "2.0", "id": mid, "result": result}


async def serve(handler: Handler) -> None:
    loop = asyncio.get_running_loop()
    lines: asyncio.Queue[bytes] = asyncio.Queue()

    def pump() -> None:
        for raw in sys.stdin.buffer:
            loop.call_soon_threadsafe(lines.put_nowait, raw)
        loop.call_soon_threadsafe(lines.put_nowait, b"")
    threading.Thread(target=pump, daemon=True).start()
    lock = asyncio.Lock()
    tasks: set[asyncio.Task] = set()

    async def respond(m: dict) -> None:
        reply = await handler.handle(m)
        if reply is not None:
            async with lock:
                sys.stdout.buffer.write((json.dumps(reply, default=str) + "\n").encode("utf-8"))
                sys.stdout.buffer.flush()

    while True:
        raw = await lines.get()
        if not raw:
            break
        if not raw.strip():
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        for m in msg if isinstance(msg, list) else [msg]:
            t = asyncio.create_task(respond(m))
            tasks.add(t)
            t.add_done_callback(tasks.discard)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


def main(argv: Optional[list[str]] = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="hermes_manager_bridge.mcp")
    ap.add_argument("--tools", choices=["all", "compact"], default="all")
    a = ap.parse_args(argv)
    asyncio.run(serve(Handler(connect(), a.tools)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
