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


def test_tail_includes_the_final_terminated_line(client, hermes_home) -> None:
    """Regression: a newline-terminated last line must not be swallowed."""
    (hermes_home / "logs" / "agent.log").write_text(
        "2026-09-26 10:00:00 INFO agent: first\n2026-09-26 10:00:01 ERROR worker: last line\n",
        encoding="utf-8",
    )
    tail = _get(client, "/api/v1/logs/tail", file="agent.log", lines=10).json()
    messages = [entry["raw"] for entry in tail["entries"]]
    assert len(messages) == 2, messages
    assert messages[-1].endswith("worker: last line")


def test_single_line_log_is_read_entirely(client, hermes_home) -> None:
    (hermes_home / "logs" / "agent.log").write_text(
        "2026-09-26 10:00:00 INFO agent: only line\n", encoding="utf-8"
    )
    tail = _get(client, "/api/v1/logs/tail", file="agent.log", lines=10).json()
    assert len(tail["entries"]) == 1
    assert tail["entries"][0]["raw"].endswith("only line")
    assert tail["offset"] == (hermes_home / "logs" / "agent.log").stat().st_size


def test_read_from_withholds_incomplete_trailing_line(hermes_home) -> None:
    from hermes_manager_bridge.services.logs import read_from

    log = hermes_home / "logs" / "agent.log"
    log.write_text(
        "2026-09-26 10:00:00 INFO agent: complete\n2026-09-26 10:00:02 INFO agent: partial",
        encoding="utf-8",
    )
    entries, offset, _ = read_from(log, 0, 0)
    assert [entry.raw for entry in entries] == ["2026-09-26 10:00:00 INFO agent: complete"]
    # Offset stops right where the still-growing line starts (byte exact,
    # independent of newline translation).
    assert offset == log.read_bytes().index(b"2026-09-26 10:00:02")

    log.write_text("2026-09-26 10:00:00 INFO agent: complete\n2026-09-26 10:00:02 INFO agent: partial\n", encoding="utf-8")
    entries, offset, _ = read_from(log, offset, len(entries))
    assert [entry.raw for entry in entries] == ["2026-09-26 10:00:02 INFO agent: partial"]
    assert offset == log.stat().st_size

    # Nothing new: no empty batch, no offset drift.
    entries, offset, _ = read_from(log, offset, len(entries))
    assert entries == []
    assert offset == log.stat().st_size


def test_read_from_sequence_numbers_continue_across_reads(hermes_home) -> None:
    from hermes_manager_bridge.services.logs import read_from

    log = hermes_home / "logs" / "agent.log"
    log.write_text("one\ntwo\nthree\n", encoding="utf-8")
    first, offset, _ = read_from(log, 0, 0)
    assert [entry.seq for entry in first] == [0, 1, 2]
    with log.open("a", encoding="utf-8") as handle:
        handle.write("four\n")
    second, _, _ = read_from(log, offset, len(first))
    assert [entry.seq for entry in second] == [3]
