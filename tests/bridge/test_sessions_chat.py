from __future__ import annotations

import json
import sys

from hermes_manager_bridge.services import chat as chat_service

TOKEN = {"Authorization": "Bearer test-token"}

FAKE_CHAT_SCRIPT = """
import json, sys
sys.stdin.read()
print(json.dumps({"type": "system", "subtype": "init", "model": "test/model-a", "session_id": "sess-new"}), flush=True)
print(json.dumps({"type": "text", "text": "hello "}), flush=True)
print(json.dumps({"type": "text", "text": "world"}), flush=True)
print(json.dumps({"type": "tool_use", "name": "bash", "input": {"command": "ls"}}), flush=True)
print(json.dumps({"type": "result", "session_id": "sess-new", "exit_code": 0, "text": "hello world", "tokens": {"total": 3}}), flush=True)
"""


def test_session_list_orders_by_recent_activity(client):
    response = client.get("/api/v1/sessions", headers=TOKEN)
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "db"
    assert body["total"] == 2
    assert [row["id"] for row in body["sessions"]] == ["sess-alpha", "sess-beta"]
    assert body["sessions"][0]["message_count"] == 4
    assert body["sessions"][0]["title"] == "Alpha debugging"


def test_session_search_by_title_and_id(client):
    by_title = client.get("/api/v1/sessions", params={"q": "Beta"}, headers=TOKEN).json()
    assert [row["id"] for row in by_title["sessions"]] == ["sess-beta"]

    by_id = client.get("/api/v1/sessions", params={"q": "sess-alpha"}, headers=TOKEN).json()
    assert [row["id"] for row in by_id["sessions"]] == ["sess-alpha"]


def test_epoch_timestamps_are_coerced_to_iso(client, hermes_home):
    import sqlite3

    connection = sqlite3.connect(hermes_home / "state.db")
    connection.execute(
        "insert into sessions (id, title, started_at, last_activity_at, message_count) values (?, ?, ?, ?, ?)",
        ("sess-epoch", "Epoch session", 1789745168.7937136, 1790372933.2690723, 1),
    )
    connection.commit()
    connection.close()

    rows = client.get("/api/v1/sessions", params={"q": "Epoch"}, headers=TOKEN).json()["sessions"]
    assert rows, "epoch session should be listed"
    started = rows[0]["started_at"]
    assert isinstance(started, str) and "T" in started


def test_session_messages_excludes_compacted_and_keeps_order(client):
    response = client.get("/api/v1/sessions/sess-alpha/messages", headers=TOKEN)
    assert response.status_code == 200
    body = response.json()
    assert body["session_id"] == "sess-alpha"
    ids = [message["id"] for message in body["messages"]]
    assert ids == [1, 2, 3]
    assert body["messages"][0]["content"] == "hello there"
    assert body["messages"][1]["role"] == "assistant"
    assert body["messages"][2]["content"] == ""


def test_session_messages_latest_order_reverses_page(client):
    body = client.get(
        "/api/v1/sessions/sess-alpha/messages",
        params={"order": "latest", "limit": 2},
        headers=TOKEN,
    ).json()
    assert [message["id"] for message in body["messages"]] == [2, 3]


def test_session_messages_missing_session_returns_empty(client):
    body = client.get("/api/v1/sessions/nope/messages", headers=TOKEN).json()
    assert body["messages"] == []
    assert body["session_id"] == "nope"


def test_sessions_require_token(client):
    assert client.get("/api/v1/sessions").status_code == 401
    assert client.post("/api/v1/chat", json={"text": "hi"}).status_code == 401


def test_chat_streams_manager_and_stream_json_frames(client, monkeypatch):
    monkeypatch.setattr(
        chat_service,
        "build_chat_command",
        lambda runtime, session_id=None: [sys.executable, "-c", FAKE_CHAT_SCRIPT],
    )
    response = client.post(
        "/api/v1/chat",
        json={"text": "hi there", "chat_id": "chat-1"},
        headers=TOKEN,
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")

    events = [json.loads(line) for line in response.text.splitlines() if line.strip()]
    kinds = [event.get("type") for event in events]
    assert kinds[0] == "manager.started"
    assert kinds[-1] == "manager.done"
    assert "system" in kinds and "text" in kinds and "tool_use" in kinds and "result" in kinds

    done = events[-1]
    assert done["exit_code"] == 0
    assert done["session_id"] == "sess-new"

    text = "".join(event["text"] for event in events if event.get("type") == "text")
    assert text == "hello world"


def test_chat_resumes_session_when_id_given(client, monkeypatch):
    captured: dict = {}

    def fake_command(runtime, session_id=None):
        captured["session_id"] = session_id
        return [sys.executable, "-c", FAKE_CHAT_SCRIPT]

    monkeypatch.setattr(chat_service, "build_chat_command", fake_command)
    response = client.post("/api/v1/chat", json={"text": "again", "session_id": "sess-alpha"}, headers=TOKEN)
    assert response.status_code == 200
    assert captured["session_id"] == "sess-alpha"


def test_chat_without_cli_reports_error(client, monkeypatch):
    monkeypatch.setattr(chat_service, "build_chat_command", lambda runtime, session_id=None: None)
    response = client.post("/api/v1/chat", json={"text": "hi"}, headers=TOKEN)
    events = [json.loads(line) for line in response.text.splitlines() if line.strip()]
    assert events[0]["type"] == "manager.error"
    assert "no hermes CLI" in events[0]["detail"]


def test_chat_abort_unknown_chat_is_safe(client):
    response = client.post("/api/v1/chat/abort", json={"chat_id": "missing"}, headers=TOKEN)
    assert response.status_code == 200
    assert response.json() == {"ok": False}


def test_chat_rejects_empty_text(client):
    response = client.post("/api/v1/chat", json={"text": ""}, headers=TOKEN)
    assert response.status_code == 422
