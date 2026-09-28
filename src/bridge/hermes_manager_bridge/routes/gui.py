"""Remote control of the Hermes Manager window.

The window's main process connects to ``/api/v1/gui/attach`` (WebSocket, token checked) when the bridge is ready.
Calls to ``POST /api/v1/gui/{op}`` are forwarded to it and answered with its reply; it runs them against the real
page (``src/main/automation.ts``): the sections, every button, field, list and table on screen, clicks, typing,
selections, keys, screenshots, and the window itself. ``POST /api/v1/gui/launch`` opens the window if it is closed.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import time
import uuid
from pathlib import Path
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from ..auth import verify_token, verify_websocket_token

TARGET = {"type": "object", "description": "Which element: {id} (its data-testid or the id gui.inspect gave it), "
                                           "or {text} (its visible text, label or placeholder), optionally {role}",
          "properties": {"id": {"type": "string"}, "text": {"type": "string"}, "role": {"type": "string"}}}

GUI_OPS: list[dict] = [
    {"id": "gui.state", "summary": "The window: visible, focused, size, the section on screen, the bridge's state", "params": {}},
    {"id": "gui.sections", "summary": "Every section in the sidebar and which is on screen", "params": {}},
    {"id": "gui.open", "summary": "Switch to a section (overview, logs, gateway, sessions, chat, updates, backups, config, tools)",
     "params": {"section": {"type": "string"}}, "required": ["section"], "mutating": True},
    {"id": "gui.inspect", "summary": "The elements on screen: buttons, fields, selects, checkboxes, tabs, links, tables, with ids, "
                                     "text, values and whether they are enabled", "params": {"max": {"type": "integer", "default": 400}}},
    {"id": "gui.find", "summary": "Elements whose text, label, id or role contains the query", "params": {"query": {"type": "string"}},
     "required": ["query"]},
    {"id": "gui.read", "summary": "Everything one element shows: text, value, options, or a table's rows",
     "params": {"target": TARGET}, "required": ["target"]},
    {"id": "gui.text", "summary": "All the text on screen (or inside one element), as a person would read it",
     "params": {"target": TARGET, "max_chars": {"type": "integer", "default": 20000}}},
    {"id": "gui.click", "summary": "Click a button, link, checkbox, tab or any element", "params": {"target": TARGET},
     "required": ["target"], "mutating": True},
    {"id": "gui.fill", "summary": "Type a value into a text field or text area (replacing what is there)",
     "params": {"target": TARGET, "value": {"type": "string"}, "submit": {"type": "boolean", "default": False}},
     "required": ["target", "value"], "mutating": True},
    {"id": "gui.select", "summary": "Choose an option in a select box (by its value or visible text)",
     "params": {"target": TARGET, "option": {"type": "string"}}, "required": ["target", "option"], "mutating": True},
    {"id": "gui.check", "summary": "Tick or untick a checkbox or switch", "params": {"target": TARGET, "checked": {"type": "boolean"}},
     "required": ["target", "checked"], "mutating": True},
    {"id": "gui.key", "summary": "Press a key in the focused element or a target (Enter, Escape, Tab, ArrowDown, ctrl+k...)",
     "params": {"keys": {"type": "string"}, "target": TARGET}, "required": ["keys"], "mutating": True},
    {"id": "gui.wait", "summary": "Wait until an element exists, is enabled, or some text appears (up to timeout_s)",
     "params": {"target": TARGET, "text": {"type": "string"}, "timeout_s": {"type": "number", "default": 10}}},
    {"id": "gui.screenshot", "summary": "A PNG of the window (base64)", "params": {"max_width": {"type": "integer", "default": 1600}}},
    {"id": "gui.window", "summary": "Show, hide, focus, minimize, maximize, restore or resize the window",
     "params": {"action": {"type": "string", "enum": ["show", "hide", "focus", "minimize", "maximize", "restore", "resize"]},
                "width": {"type": "integer"}, "height": {"type": "integer"}}, "required": ["action"], "mutating": True},
]
GUI_IDS = {o["id"] for o in GUI_OPS}


class GuiLink:
    def __init__(self) -> None:
        self.ws: Optional[WebSocket] = None
        self.info: dict[str, Any] = {}
        self.pending: dict[str, asyncio.Future] = {}

    @property
    def attached(self) -> bool:
        return self.ws is not None

    async def call(self, op: str, args: dict, timeout: float = 60.0) -> Any:
        if self.ws is None:
            raise HTTPException(status_code=409, detail="the Hermes Manager window is not open (gui.launch opens it)")
        rid = uuid.uuid4().hex
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        try:
            await self.ws.send_json({"type": "call", "id": rid, "op": op, "args": args})
            reply = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail=f"the window did not answer {op} within {timeout:.0f}s") from None
        finally:
            self.pending.pop(rid, None)
        if not reply.get("ok"):
            raise HTTPException(status_code=400, detail=reply.get("error") or "the window reported an error")
        return reply.get("result")


router = APIRouter(prefix="/api/v1/gui", tags=["gui"])
ws_router = APIRouter(prefix="/api/v1/gui")


def _link(request: Request) -> GuiLink:
    link = getattr(request.app.state, "gui", None)
    if link is None:
        link = request.app.state.gui = GuiLink()
    return link


@ws_router.websocket("/attach")
async def attach(websocket: WebSocket, token: Optional[str] = Query(None)) -> None:
    if not verify_websocket_token(websocket, token):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    link: GuiLink = getattr(websocket.app.state, "gui", None) or GuiLink()
    websocket.app.state.gui = link
    if link.ws is not None:
        await websocket.send_json({"type": "refused", "reason": "another window is attached"})
        await websocket.close()
        return
    link.ws = websocket
    link.info = {"attached_at": time.time()}
    from .. import control
    control.update(gui=True)
    try:
        while True:
            msg = await websocket.receive_json()
            if msg.get("type") == "reply":
                fut = link.pending.get(msg.get("id", ""))
                if fut and not fut.done():
                    fut.set_result(msg)
            elif msg.get("type") == "hello":
                link.info.update({k: v for k, v in msg.items() if k != "type"})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        link.ws = None
        for fut in link.pending.values():
            if not fut.done():
                fut.set_result({"ok": False, "error": "the window closed"})
        control.update(gui=False)


@router.get("/status", dependencies=[Depends(verify_token)])
async def status(request: Request) -> dict:
    link = _link(request)
    return {"attached": link.attached, **link.info}


@router.get("/operations", dependencies=[Depends(verify_token)])
async def operations() -> list:
    return GUI_OPS


def _app_command() -> Optional[list[str]]:
    """How to open Hermes Manager: $HM_APP, the installed app, or this checkout's built app with its Electron."""
    if os.environ.get("HM_APP") and Path(os.environ["HM_APP"]).exists():
        return [os.environ["HM_APP"]]
    local = os.environ.get("LOCALAPPDATA", "")
    for exe in (Path(local) / "Programs" / "hermes-manager" / "Hermes Manager.exe",
                Path(local) / "Programs" / "Hermes Manager" / "Hermes Manager.exe"):
        if exe.is_file():
            return [str(exe)]
    root = Path(__file__).resolve().parents[4]
    electron = root / "node_modules" / "electron" / "dist" / ("electron.exe" if os.name == "nt" else "electron")
    if electron.is_file() and (root / "out" / "main" / "index.js").is_file():
        return [str(electron), str(root)]
    return None


@router.post("/launch", dependencies=[Depends(verify_token)])
async def launch(request: Request, wait_s: Annotated[float, Body(embed=True)] = 60.0) -> dict:
    link = _link(request)
    if link.attached:
        return {"attached": True, "already_open": True, **link.info}
    cmd = _app_command()
    if cmd is None:
        raise HTTPException(status_code=404, detail="Hermes Manager is not installed and this checkout is not built "
                                                    "(npm run build), so there is no window to open")
    flags = (0x00000008 | 0x00000200) if os.name == "nt" else 0
    subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=flags, start_new_session=os.name != "nt", cwd=str(Path(cmd[-1]).parent))
    deadline = time.time() + min(wait_s, 180)
    while time.time() < deadline:
        if link.attached:
            return {"attached": True, "already_open": False, **link.info}
        await asyncio.sleep(0.5)
    raise HTTPException(status_code=504, detail="the window opened but did not attach in time")


@router.post("/{op}", dependencies=[Depends(verify_token)])
async def call(op: str, request: Request, args: Annotated[Optional[dict], Body()] = None) -> Any:
    op_id = op if op.startswith("gui.") else f"gui.{op}"
    if op_id not in GUI_IDS:
        raise HTTPException(status_code=404, detail=f"no GUI operation {op_id!r}")
    return await _link(request).call(op_id, args or {})

