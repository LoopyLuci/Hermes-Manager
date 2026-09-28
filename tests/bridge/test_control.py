"""Control from outside the window: fail-closed auth, the ping, the discovery file, the operation catalog and
calling operations by id, the GUI link (forwarding to an attached window), and the MCP server."""
from __future__ import annotations

import asyncio
import json
import os
import threading

import pytest

from hermes_manager_bridge import catalog, control
from hermes_manager_bridge.server import create_app

from conftest import TOKEN

AUTH = {"Authorization": f"Bearer {TOKEN}"}


def test_ping_is_public_and_says_which_process(client):
    r = client.get("/api/v1/ping")
    assert r.status_code == 200 and r.json()["pid"] == os.getpid() and "token" not in r.text


def test_docs_are_off_and_openapi_needs_the_token(client):
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404
    assert client.get("/api/v1/openapi.json").status_code == 401
    assert "/api/v1/gateway" in client.get("/api/v1/openapi.json", headers=AUTH).json()["paths"]


def test_a_bridge_without_a_token_refuses_everything(runtime):
    from fastapi.testclient import TestClient
    with TestClient(create_app(runtime=runtime, token=None)) as c:
        assert c.get("/api/v1/health").status_code == 401
        assert c.get("/api/v1/ping").status_code == 200


def test_catalog_covers_every_route_with_readable_ids(client):
    ops = client.get("/api/v1/operations", headers=AUTH).json()
    ids = {o["id"] for o in ops}
    assert {"gateway.status", "config.read_config", "backups.list_backups", "tools.mcp_list", "chat.chat"} <= ids
    assert len(ops) >= 30
    apply = next(o for o in ops if o["id"] == "config.apply")
    assert apply["mutating"] and apply["method"] == "POST"
    assert not next(o for o in ops if o["id"] == "gateway.status")["mutating"]


def test_call_runs_operations_by_id(client):
    doc = client.post("/api/v1/call/config.read_config", headers=AUTH, json={}).json()
    assert doc["config"]["model"] == "openrouter/test-model"
    tail = client.post("/api/v1/call/logs.tail", headers=AUTH, json={"file": "agent.log"})
    assert tail.status_code == 200
    bad = client.post("/api/v1/call/logs.tail", headers=AUTH, json={"nope": 1})
    assert bad.status_code == 400 and "unknown argument" in bad.json()["detail"]
    assert client.post("/api/v1/call/no.such", headers=AUTH, json={}).status_code == 404
    assert client.post("/api/v1/call/config.read_config", json={}).status_code == 401


def test_request_for_places_arguments():
    op = {"id": "x", "method": "GET", "path": "/api/v1/sessions/{session_id}/messages",
          "params": {"type": "object", "required": ["session_id"]}, "where": {"session_id": "path", "limit": "query"}}
    assert catalog.request_for(op, {"session_id": "abc", "limit": 5}) == ("GET", "/api/v1/sessions/abc/messages", {"limit": 5}, None)
    with pytest.raises(ValueError, match="missing"):
        catalog.request_for(op, {})


def test_discovery_file_round_trip(tmp_path, monkeypatch):
    monkeypatch.setenv("HM_HOME", str(tmp_path))
    control.write("http://127.0.0.1:1", "unused", version="t")
    assert control.read()["pid"] == os.getpid()
    control.update(gui=True)
    assert control.read()["gui"] is True
    assert control.alive(timeout=0.2) is None            # nothing answers on port 1
    control.remove()
    assert control.read() is None


def test_gui_calls_go_to_the_attached_window(client):
    assert client.get("/api/v1/gui/status", headers=AUTH).json()["attached"] is False
    assert client.post("/api/v1/gui/sections", headers=AUTH, json={}).status_code == 409
    with client.websocket_connect(f"/api/v1/gui/attach?token={TOKEN}") as ws:
        ws.send_json({"type": "hello", "app": "test"})
        results = {}

        def call():
            results["open"] = client.post("/api/v1/gui/open", headers=AUTH, json={"section": "logs"})

        t = threading.Thread(target=call)
        t.start()
        msg = ws.receive_json()
        assert msg["op"] == "gui.open" and msg["args"] == {"section": "logs"}
        ws.send_json({"type": "reply", "id": msg["id"], "ok": True, "result": {"section": "logs"}})
        t.join(10)
        assert results["open"].json() == {"section": "logs"}
    assert client.post("/api/v1/gui/nothing", headers=AUTH, json={}).status_code == 404


def test_gui_attach_needs_the_token(client):
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/v1/gui/attach?token=wrong") as ws:
            ws.receive_json()


class _StubBridge:
    def __init__(self, client):
        self.client = client

    def request(self, method, path, body=None, timeout=900):
        r = self.client.request(method, path, headers=AUTH, json=body)
        if r.status_code >= 400:
            raise RuntimeError(r.json().get("detail"))
        return r.json()


def test_mcp_server_lists_and_calls_tools(client):
    from hermes_manager_bridge.mcp import Handler
    h = Handler(_StubBridge(client))

    async def go():
        init = await h.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
        tools = (await h.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))["result"]["tools"]
        ok = (await h.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                              "params": {"name": "config_read_config", "arguments": {}}}))["result"]
        gui = (await h.handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                               "params": {"name": "gui_sections", "arguments": {}}}))["result"]
        return init, tools, ok, gui
    init, tools, ok, gui = asyncio.run(go())
    names = {t["name"] for t in tools}
    assert init["result"]["protocolVersion"] == "2025-06-18"
    assert {"gateway_status", "config_apply", "gui_click", "gui_launch", "hm_call"} <= names
    assert not ok["isError"] and json.loads(ok["content"][0]["text"])["config"]["model"] == "openrouter/test-model"
    assert gui["isError"] and "not open" in gui["content"][0]["text"]
