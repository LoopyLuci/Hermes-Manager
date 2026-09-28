from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..models import ChatMessage, MessagePage, SessionList, SessionSummary
from ..runtime import HermesRuntime

SESSION_COLUMNS = (
    "id",
    "title",
    "source",
    "model",
    "started_at",
    "last_activity_at",
    "ended_at",
    "message_count",
    "tool_call_count",
    "input_tokens",
    "output_tokens",
    "archived",
    "profile_name",
)
MESSAGE_COLUMNS = (
    "id",
    "session_id",
    "role",
    "content",
    "tool_name",
    "tool_call_id",
    "timestamp",
    "display_kind",
    "active",
    "compacted",
)


def _connect(runtime: HermesRuntime) -> sqlite3.Connection | None:
    db_path = runtime.state_db
    if db_path is None or not Path(db_path).is_file():
        return None
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
    connection.row_factory = sqlite3.Row
    return connection


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    try:
        return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def _decode_content(value: Any) -> Any:
    if isinstance(value, (bytes, bytearray)):
        try:
            value = bytes(value).decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - opaque blobs are not content
            return None
    if isinstance(value, str) and value[:1] in "[{":
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _timestamp(value: Any) -> str | None:
    """state.db stores epoch floats (sometimes stringified by column affinity); the API speaks ISO-8601."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number: float | None = float(value)
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return text
    else:
        return str(value)
    try:
        return datetime.fromtimestamp(number, tz=timezone.utc).isoformat(timespec="seconds")
    except (OverflowError, OSError, ValueError):
        return str(value)


def _optional_int(row: sqlite3.Row, key: str) -> int | None:
    try:
        value = row[key]
    except IndexError:
        return None
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return None


def list_sessions(
    runtime: HermesRuntime,
    limit: int = 50,
    offset: int = 0,
    query: str | None = None,
) -> SessionList:
    connection = _connect(runtime)
    if connection is None:
        return SessionList(source="files", sessions=[], total=0, detail="state.db not found")

    try:
        available = _columns(connection, "sessions")
        if "id" not in available:
            return SessionList(source="db", sessions=[], total=0, detail="sessions table missing")

        select = ", ".join(column for column in SESSION_COLUMNS if column in available)
        where = ""
        params: list[Any] = []
        if query:
            clause = []
            if "title" in available:
                clause.append("title LIKE ?")
                params.append(f"%{query}%")
            clause.append("id = ?")
            params.append(query)
            where = " WHERE " + " OR ".join(clause)

        total = connection.execute(f"SELECT COUNT(*) FROM sessions{where}", params).fetchone()[0]
        order_expr = "last_activity_at" if "last_activity_at" in available else (
            "started_at" if "started_at" in available else "rowid"
        )
        rows = connection.execute(
            f"SELECT {select} FROM sessions{where} ORDER BY {order_expr} DESC LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()

        sessions = [
            SessionSummary(
                id=str(row["id"]),
                title=row["title"] if "title" in available else None,
                source=row["source"] if "source" in available else None,
                model=row["model"] if "model" in available else None,
                started_at=_timestamp(row["started_at"]) if "started_at" in available else None,
                last_activity_at=_timestamp(row["last_activity_at"]) if "last_activity_at" in available else None,
                ended_at=_timestamp(row["ended_at"]) if "ended_at" in available else None,
                message_count=_optional_int(row, "message_count"),
                tool_call_count=_optional_int(row, "tool_call_count"),
                input_tokens=_optional_int(row, "input_tokens"),
                output_tokens=_optional_int(row, "output_tokens"),
                archived=bool(row["archived"]) if "archived" in available and row["archived"] else False,
                profile=row["profile_name"] if "profile_name" in available else None,
            )
            for row in rows
        ]
        return SessionList(source="db", sessions=sessions, total=total)
    except sqlite3.Error as exc:
        return SessionList(source="db", sessions=[], total=0, detail=f"{type(exc).__name__}: {exc}")
    finally:
        connection.close()


def session_messages(
    runtime: HermesRuntime,
    session_id: str,
    limit: int = 300,
    order: str = "oldest",
) -> MessagePage:
    connection = _connect(runtime)
    if connection is None:
        return MessagePage(source="files", session_id=session_id, messages=[], detail="state.db not found")

    try:
        available = _columns(connection, "messages")
        if "session_id" not in available:
            return MessagePage(source="db", session_id=session_id, messages=[], detail="messages table missing")

        select = ", ".join(column for column in MESSAGE_COLUMNS if column in available)
        where = " WHERE session_id = ?"
        params: list[Any] = [session_id]
        if "active" in available:
            where += " AND active = 1"
        direction = "DESC" if order == "latest" else "ASC"
        rows = connection.execute(
            f"SELECT {select} FROM messages{where} ORDER BY id {direction} LIMIT ?",
            [*params, limit],
        ).fetchall()
        if direction == "DESC":
            rows = list(reversed(rows))

        messages = [
            ChatMessage(
                id=int(row["id"]),
                session_id=str(row["session_id"]) if "session_id" in available else session_id,
                role=str(row["role"] or "assistant") if "role" in available else "assistant",
                content=_decode_content(row["content"]) if "content" in available else None,
                tool_name=row["tool_name"] if "tool_name" in available else None,
                tool_call_id=row["tool_call_id"] if "tool_call_id" in available else None,
                timestamp=_timestamp(row["timestamp"]) if "timestamp" in available else None,
                display_kind=row["display_kind"] if "display_kind" in available else None,
                active=bool(row["active"]) if "active" in available and row["active"] is not None else True,
                compacted=bool(row["compacted"]) if "compacted" in available and row["compacted"] else False,
            )
            for row in rows
        ]
        return MessagePage(source="db", session_id=session_id, messages=messages)
    except sqlite3.Error as exc:
        return MessagePage(source="db", session_id=session_id, messages=[], detail=f"{type(exc).__name__}: {exc}")
    finally:
        connection.close()
