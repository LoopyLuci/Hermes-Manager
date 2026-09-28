from __future__ import annotations

import pytest

TOKEN = "test-token"


def test_stream_rejects_missing_token(client) -> None:
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises((WebSocketDisconnect, Exception)) as excinfo:
        with client.websocket_connect("/api/v1/stream"):
            pass
    assert excinfo.value is not None


def test_stream_rejects_bad_token(client) -> None:
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises((WebSocketDisconnect, Exception)):
        with client.websocket_connect("/api/v1/stream?token=wrong"):
            pass


def test_stream_sends_heartbeat(client) -> None:
    with client.websocket_connect(f"/api/v1/stream?token={TOKEN}") as socket:
        payload = socket.receive_json()
    assert payload["type"] == "heartbeat"
    assert payload["uptime_s"] >= 0
