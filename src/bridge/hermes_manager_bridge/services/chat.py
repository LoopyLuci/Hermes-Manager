from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import threading
from collections import deque
from typing import Any, Iterator

from ..models import ChatRequest
from ..runtime import HermesRuntime

_ACTIVE: dict[str, subprocess.Popen] = {}
_ACTIVE_LOCK = threading.Lock()

#: Seconds without a single output line before the turn is considered hung.
IDLE_TIMEOUT_S = float(os.environ.get("HERMES_BRIDGE_CHAT_IDLE_S", "120"))


def build_chat_command(runtime: HermesRuntime, session_id: str | None = None) -> list[str] | None:
    """argv for a one-shot streaming turn: ``hermes chat --query-file - --format stream-json``.

    The prompt travels on stdin (``--query-file -``) so long messages never hit the
    Windows CreateProcess argv limit; ``--resume`` keeps conversation continuity.
    """
    args = ["chat", "--query-file", "-", "--format", "stream-json"]
    if session_id:
        args += ["--resume", session_id]

    repo = runtime.hermes_repo
    if repo is not None and (repo / "hermes_cli").is_dir():
        try:
            from hermes_cli._launchers import runtime_command  # type: ignore[import-not-found]

            home = str(runtime.hermes_home) if runtime.hermes_home else None
            return runtime_command(repo, args, home=home)
        except Exception:  # noqa: BLE001
            pass

    executable = shutil.which("hermes")
    if executable:
        return [executable, *args]
    return None


def abort_chat(chat_id: str) -> bool:
    with _ACTIVE_LOCK:
        proc = _ACTIVE.get(chat_id)
    if proc is None or proc.poll() is not None:
        return False
    try:
        proc.kill()
    except OSError:
        return False
    return True


def terminate_active() -> None:
    """Kill every in-flight chat child (bridge shutdown)."""
    with _ACTIVE_LOCK:
        procs = list(_ACTIVE.values())
        _ACTIVE.clear()
    for proc in procs:
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
            try:
                proc.wait(timeout=5)
            except (subprocess.TimeoutExpired, OSError):
                pass


def _spawn(runtime: HermesRuntime, command: list[str]) -> subprocess.Popen:
    env = dict(os.environ)
    if runtime.hermes_home is not None:
        env["HERMES_HOME"] = str(runtime.hermes_home)
    return subprocess.Popen(  # noqa: S603 - argv built from our own resolved CLI
        command,
        cwd=str(runtime.hermes_repo or runtime.hermes_home or "."),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def stream_chat(runtime: HermesRuntime, request: ChatRequest, chat_id: str | None = None) -> Iterator[dict[str, Any]]:
    """Yield JSON events for one chat turn, forwarding the child's stream-json frames."""
    command = build_chat_command(runtime, request.session_id)
    if command is None:
        yield {"type": "manager.error", "detail": "no hermes CLI available (no checkout and no hermes on PATH)"}
        return

    try:
        proc = _spawn(runtime, command)
    except OSError as exc:
        yield {"type": "manager.error", "detail": f"{type(exc).__name__}: {exc}"}
        return

    key = chat_id or f"pid-{proc.pid}"
    with _ACTIVE_LOCK:
        _ACTIVE[key] = proc

    stderr_tail: deque[str] = deque(maxlen=60)
    finished = False
    session_id = request.session_id
    try:
        yield {"type": "manager.started", "pid": proc.pid, "session_id": session_id}

        stderr_thread = threading.Thread(
            target=_drain_stderr, args=(proc.stderr, stderr_tail), daemon=True
        )
        stderr_thread.start()

        try:
            assert proc.stdin is not None
            proc.stdin.write(request.text)
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            yield {
                "type": "manager.error",
                "detail": "hermes exited before accepting the query",
                "stderr": list(stderr_tail),
            }
            finished = True
            return

        assert proc.stdout is not None
        # Read on a worker thread so a silent child can never block the
        # response generator forever: the consumer enforces an idle deadline.
        lines: queue.Queue[str | None] = queue.Queue()
        feed_thread = threading.Thread(target=_feed_lines, args=(proc.stdout, lines), daemon=True)
        feed_thread.start()

        while True:
            try:
                line = lines.get(timeout=IDLE_TIMEOUT_S)
            except queue.Empty:
                _kill_quiet(proc)
                yield {
                    "type": "manager.error",
                    "detail": f"hermes produced no output for {IDLE_TIMEOUT_S:g}s and was killed",
                    "stderr": list(stderr_tail),
                }
                finished = True
                return
            if line is None:
                break
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                event = {"type": "manager.log", "line": line}
            if isinstance(event, dict) and isinstance(event.get("session_id"), str):
                session_id = event["session_id"]
            yield event

        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            _kill_quiet(proc)
            yield {
                "type": "manager.error",
                "detail": "hermes did not exit within 30s after its output stream closed; killed",
                "stderr": list(stderr_tail),
            }
            finished = True
            return
        exit_code = proc.returncode
        finished = True
        if exit_code not in (0, None) and stderr_tail:
            yield {"type": "manager.log", "line": " · ".join(list(stderr_tail)[-4:])}
        yield {"type": "manager.done", "exit_code": exit_code, "session_id": session_id}
    finally:
        if not finished and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
        with _ACTIVE_LOCK:
            _ACTIVE.pop(key, None)
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            if pipe is not None:
                try:
                    pipe.close()
                except OSError:
                    pass


def _feed_lines(stream, sink: "queue.Queue[str | None]") -> None:  # type: ignore[no-untyped-def]
    try:
        for line in stream:
            sink.put(line)
    except (OSError, ValueError):
        pass
    finally:
        sink.put(None)


def _kill_quiet(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        try:
            proc.kill()
        except OSError:
            pass


def _drain_stderr(pipe, sink: deque) -> None:  # type: ignore[no-untyped-def]
    try:
        for line in pipe:
            sink.append(line.rstrip())
    except (OSError, ValueError):
        return
