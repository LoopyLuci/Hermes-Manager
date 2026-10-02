from __future__ import annotations

import sys
import threading

import pytest

from hermes_manager_bridge.services import chat as chat_service

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

# A child that keeps streaming forever until killed: used to prove the bridge
# kills in-flight turns on abort and on shutdown.
HANGING_CHAT_SCRIPT = """
import json, sys, time
sys.stdin.read()
print(json.dumps({"type": "system", "subtype": "init", "session_id": "sess-hang"}), flush=True)
while True:
    print(json.dumps({"type": "text", "text": "tick "}), flush=True)
    time.sleep(0.2)
"""


def test_follow_stream_sends_the_existing_tail(client) -> None:
    with client.websocket_connect(f"/api/v1/logs/stream?file=agent.log&token={TOKEN}") as socket:
        event = socket.receive_json()
    assert event["file"] == "agent.log"
    assert event["offset"] > 0
    assert any("agent: up" in (entry.get("raw") or "") for entry in event["entries"])


def test_follow_stream_reports_rotation(client, hermes_home) -> None:
    agent_log = hermes_home / "logs" / "agent.log"
    with client.websocket_connect(f"/api/v1/logs/stream?file=agent.log&offset=99999&token={TOKEN}") as socket:
        first = socket.receive_json()
    assert first["rotated"] is True
    assert first["offset"] == 0
    # tail after rotation still resolves to the same file
    assert agent_log.exists()


def test_follow_stream_requires_a_token(client) -> None:
    with pytest.raises(Exception):
        with client.websocket_connect("/api/v1/logs/stream?file=agent.log"):
            pass


def test_chat_abort_kills_the_running_turn(runtime, monkeypatch) -> None:
    """Abort must terminate a live turn instead of waiting for it to finish.

    Driven at the service layer: Starlette's TestClient buffers streaming
    responses, so an endless child could never be observed over HTTP.
    """
    from hermes_manager_bridge.models import ChatRequest

    monkeypatch.setattr(
        chat_service,
        "build_chat_command",
        lambda rt, session_id=None: [sys.executable, "-c", HANGING_CHAT_SCRIPT],
    )

    frames: list[dict] = []
    finished = threading.Event()

    def consume() -> None:
        request = ChatRequest(text="hang", chat_id="chat-hang")
        for event in chat_service.stream_chat(runtime, request, "chat-hang"):
            frames.append(event)
            if event.get("type") == "manager.started":
                assert chat_service.abort_chat("chat-hang") is True
        finished.set()

    worker = threading.Thread(target=consume, daemon=True)
    worker.start()
    assert finished.wait(timeout=30), "aborted chat turn never finished"
    worker.join(timeout=5)
    assert frames[0]["type"] == "manager.started"
    assert frames[-1]["type"] in {"manager.done", "manager.error"}


def test_shutdown_reaps_in_flight_chat_children(runtime, monkeypatch) -> None:
    from fastapi.testclient import TestClient

    from hermes_manager_bridge.models import ChatRequest
    from hermes_manager_bridge.server import create_app

    monkeypatch.setattr(
        chat_service,
        "build_chat_command",
        lambda rt, session_id=None: [sys.executable, "-c", HANGING_CHAT_SCRIPT],
    )

    frames: list[dict] = []
    started = threading.Event()

    def consume() -> None:
        request = ChatRequest(text="hang", chat_id="chat-reap")
        for event in chat_service.stream_chat(runtime, request, "chat-reap"):
            frames.append(event)
            if event.get("type") == "manager.started":
                started.set()

    with TestClient(create_app(runtime=runtime, token=TOKEN), headers=AUTH) as client:
        assert client.get("/api/v1/health").status_code == 200
        worker = threading.Thread(target=consume, daemon=True)
        worker.start()
        assert started.wait(timeout=20), "chat turn never started"
        pid = int(frames[0]["pid"])
        assert _pid_alive(pid)
        # Leaving this context runs the FastAPI lifespan shutdown handler.
    assert finished_within(worker, 15), "chat stream outlived the bridge"
    assert not _pid_alive(pid), "bridge shutdown left an orphaned chat child"


def finished_within(thread: threading.Thread, seconds: float) -> bool:
    thread.join(timeout=seconds)
    return not thread.is_alive()


def _pid_alive(pid: int) -> bool:
    import ctypes

    process = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if not process:
        return False
    try:
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(process, ctypes.byref(code))
        return code.value == 259
    finally:
        ctypes.windll.kernel32.CloseHandle(process)