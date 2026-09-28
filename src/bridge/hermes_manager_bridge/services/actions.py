from __future__ import annotations

import os
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..runtime import HermesRuntime
from .gateway import pid_alive

_ACTIVE_LOCK = threading.Lock()
_ACTIVE: dict[str, dict[str, Any]] = {}


class ActionError(Exception):
    """A user-facing action problem (no CLI, spawn failure, ...)."""


def build_cli_command(runtime: HermesRuntime, args: list[str]) -> list[str]:
    """argv for ``hermes <args>`` from a real checkout.

    Unlike the gateway lifecycle helper there is deliberately **no** PATH
    fallback: destructive actions (update, backup) must run from the known
    checkout, never from whatever ``hermes`` happens to be on PATH.
    """
    repo = runtime.hermes_repo
    if repo is None or not (repo / "hermes_cli" / "main.py").is_file():
        raise ActionError("hermes checkout not found (hermes_cli/main.py missing); refusing to spawn")
    try:
        from hermes_cli._launchers import runtime_command  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001 - fall back to plain argv
        executable = sys.executable
        return [executable, "-m", "hermes_cli.main", *args]
    home = str(runtime.hermes_home) if runtime.hermes_home else None
    return runtime_command(repo, args, home=home)


def spawn_detached(
    runtime: HermesRuntime,
    args: list[str],
    log_name: str,
    action_key: str,
) -> tuple[int, str]:
    """Spawn ``hermes <args>`` detached with output appended to *log_name*.

    Returns ``(pid, log_name)``. Registers the pid under *action_key* so
    later status calls can check liveness.
    """
    command = build_cli_command(runtime, args)
    home = runtime.hermes_home
    if home is None:
        raise ActionError("HERMES_HOME is unknown; refusing to spawn")
    logs_dir = home / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)

    log_file = open(logs_dir / log_name, "ab", buffering=0)  # noqa: SIM115 - child inherits the fd
    try:
        log_file.write(f"\n=== manager: hermes {' '.join(args)} ===\n".encode())
        env = dict(os.environ)
        env["HERMES_HOME"] = str(home)
        detach = (
            {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
            if sys.platform == "win32"
            else {"start_new_session": True}
        )
        proc = subprocess.Popen(  # noqa: S603 - argv built from our own resolved CLI
            command,
            cwd=str(runtime.hermes_repo or home),
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            env=env,
            **detach,
        )
    except OSError as exc:
        raise ActionError(f"{type(exc).__name__}: {exc}") from exc
    finally:
        try:
            log_file.close()
        except OSError:
            pass

    with _ACTIVE_LOCK:
        _ACTIVE[action_key] = {
            "pid": proc.pid,
            "log": log_name,
            "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
    return proc.pid, log_name


def active_status(action_key: str) -> dict[str, Any]:
    with _ACTIVE_LOCK:
        entry = dict(_ACTIVE.get(action_key) or {})
    pid = entry.get("pid")
    entry["running"] = pid_alive(pid) if isinstance(pid, int) else False
    return entry
