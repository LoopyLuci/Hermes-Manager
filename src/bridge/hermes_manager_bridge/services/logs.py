from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from ..models import LogBatch, LogEntry, LogFile
from ..runtime import HermesRuntime

LOG_LINE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:,\d{1,3})?)\s+"
    r"(?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL)\s*"
    r"(?:\[(?P<session>[^\]]+)\]\s+)?"
    r"(?P<logger>\S+):\s(?P<message>.*)$"
)
VERBOSE_LINE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:,\d{1,3})?)\s+-\s+"
    r"(?P<logger>\S+)\s+-\s+"
    r"(?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL)\s*"
    r"(?:\[(?P<session>[^\]]+)\])?\s+-\s(?P<message>.*)$"
)
MAX_READ_BYTES = 4 * 1024 * 1024


def safe_log_path(runtime: HermesRuntime, name: str) -> Path | None:
    logs_dir = runtime.logs_dir
    if logs_dir is None:
        return None
    if not name or Path(name).name != name:
        return None
    candidate = (logs_dir / name).resolve()
    if candidate.parent != logs_dir.resolve():
        return None
    return candidate if candidate.is_file() else None


def list_logs(runtime: HermesRuntime) -> list[LogFile]:
    logs_dir = runtime.logs_dir
    if logs_dir is None or not logs_dir.is_dir():
        return []
    files: list[LogFile] = []
    for path in sorted(logs_dir.iterdir()):
        if not path.is_file():
            continue
        name = path.name
        if not (name.endswith(".log") or re.match(r".+\.log\.\d+$", name)):
            continue
        stat = path.stat()
        files.append(
            LogFile(
                name=name,
                size=stat.st_size,
                modified=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(timespec="seconds"),
                rotated=bool(re.match(r".+\.log\.\d+$", name)),
            )
        )
    files.sort(key=lambda entry: (entry.rotated, entry.name))
    return files


def parse_line(raw: str, seq: int) -> LogEntry:
    match = LOG_LINE.match(raw) or VERBOSE_LINE.match(raw)
    if not match:
        return LogEntry(ts=None, level=None, session=None, logger=None, message=raw, raw=raw, seq=seq)
    return LogEntry(
        ts=match.group("ts"),
        level=match.group("level"),
        session=match.group("session"),
        logger=match.group("logger"),
        message=match.group("message"),
        raw=raw,
        seq=seq,
    )


def _decode(chunk: bytes) -> str:
    return chunk.decode("utf-8", errors="replace")


def read_tail(path: Path, lines: int, seq_start: int = 0) -> tuple[list[LogEntry], int]:
    size = path.stat().st_size
    with path.open("rb") as handle:
        if size > MAX_READ_BYTES:
            handle.seek(size - MAX_READ_BYTES)
            handle.readline()
        chunk = handle.read()
    decoded = _decode(chunk).splitlines()
    window = decoded[-lines:] if lines > 0 else decoded
    return [parse_line(line, seq_start + index) for index, line in enumerate(window)], size


def read_from(path: Path, offset: int, seq_start: int, limit: int = 500) -> tuple[list[LogEntry], int, bool]:
    size = path.stat().st_size
    if offset > size:
        offset = 0
    with path.open("rb") as handle:
        handle.seek(offset)
        chunk = handle.read(512 * 1024)
    text = _decode(chunk)
    parts = text.splitlines(keepends=True)
    complete = [part.rstrip("\r\n") for part in parts[:-1]] if len(parts) > 1 else []
    consumed = len(text) if not parts or text.endswith(("\n", "\r")) else len(text) - len(parts[-1])
    truncated = len(complete) > limit
    if truncated:
        complete = complete[-limit:]
    entries = [parse_line(line, seq_start + index) for index, line in enumerate(complete)]
    return entries, offset + consumed, truncated
