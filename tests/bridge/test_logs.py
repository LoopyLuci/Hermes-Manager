from __future__ import annotations

import pytest

TOKEN = "test-token"


def _get(client, path: str, **params):
    return client.get(path, headers={"Authorization": f"Bearer {TOKEN}"}, params=params)


def test_list_logs(client) -> None:
    response = _get(client, "/api/v1/logs")
    assert response.status_code == 200
    names = [entry["name"] for entry in response.json()]
    assert "agent.log" in names
    assert "errors.log" in names
    agent = next(entry for entry in response.json() if entry["name"] == "agent.log")
    assert agent["size"] > 0
    assert agent["rotated"] is False


def test_tail_parses_structured_lines(client) -> None:
    response = _get(client, "/api/v1/logs/tail", file="agent.log", lines=50)
    assert response.status_code == 200
    body = response.json()
    assert body["file"] == "agent.log"
    assert body["entries"], "expected at least one parsed entry"
    entry = body["entries"][0]
    assert entry["level"] in {"INFO", "WARNING", "ERROR", "DEBUG", "CRITICAL"}
    assert entry["logger"]
    assert entry["message"]
    assert body["offset"] > 0


def test_tail_rejects_path_traversal(client) -> None:
    response = _get(client, "/api/v1/logs/tail", file="../state.db")
    assert response.status_code == 200
    assert response.json()["entries"] == []


def test_read_from_offset_returns_only_new_content(client) -> None:
    tail = _get(client, "/api/v1/logs/tail", file="agent.log", lines=10).json()
    offset = tail["offset"]
    follow = _get(client, "/api/v1/logs/read", file="agent.log", offset=offset).json()
    assert follow["offset"] == offset
    assert follow["entries"] == []


def test_logs_require_token(client) -> None:
    assert client.get("/api/v1/logs").status_code == 401
    assert client.get("/api/v1/logs/tail", params={"file": "agent.log"}).status_code == 401


def test_follow_stream_rejects_bad_token(client) -> None:
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises((WebSocketDisconnect, Exception)):
        with client.websocket_connect("/api/v1/logs/stream?file=agent.log&token=wrong"):
            pass
