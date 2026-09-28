from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from ..models import (
    DrainResult,
    FleetReport,
    FleetRow,
    GatewayIdentity,
    GatewayStateInfo,
    GatewayStatus,
    LifecycleResult,
    ProcessInfo,
    ProcessReport,
    SourceLayer,
)
from ..runtime import HermesRuntime

ACTION_LOGS = {
    "start": "gateway-start.log",
    "stop": "gateway-stop.log",
    "restart": "gateway-restart.log",
}


def pid_alive(pid: int | None) -> bool:
    """True when *pid* is a live process.

    Deliberately avoids ``os.kill(pid, 0)``: on Windows that terminates the
    target with exit code 0 instead of probing it.
    """
    if not pid or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _read_state_doc(home: Path | None) -> dict[str, Any] | None:
    if home is None:
        return None
    path = home / "gateway_state.json"
    try:
        doc = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _drain_marker_path(home: Path | None) -> Path | None:
    if home is None:
        return None
    return home / ".drain_request.json"


def _drain_requested(home: Path | None) -> bool:
    marker = _drain_marker_path(home)
    if marker is None:
        return False
    try:
        from gateway.drain_control import drain_requested  # type: ignore[import-not-found]

        return bool(drain_requested(home=home))
    except Exception:  # noqa: BLE001 - deep layer unavailable; fall back to the marker
        try:
            return marker.is_file()
        except OSError:
            return False


def _identify(home: Path | None) -> dict[str, Any] | None:
    if home is None:
        return None
    try:
        from gateway.control_socket import identify_gateway  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        return None
    try:
        return identify_gateway(home, timeout=1.5)
    except Exception:  # noqa: BLE001 - never let a control-socket probe raise
        return None


def _identity_from_doc(doc: dict[str, Any] | None) -> GatewayIdentity | None:
    if not doc or not doc.get("pid"):
        return None
    return GatewayIdentity(
        kind=doc.get("kind"),
        pid=doc.get("pid"),
        start_time=doc.get("start_time"),
        code_sha=doc.get("code_sha"),
        code_version=doc.get("code_version"),
        hermes_home=doc.get("hermes_home"),
        served_profiles=list(doc.get("served_profiles") or []),
    )


def gateway_status(runtime: HermesRuntime) -> GatewayStatus:
    home = runtime.hermes_home
    doc = _read_state_doc(home)
    live = _identify(home)
    drain = _drain_requested(home)

    source: SourceLayer = "deep" if live else "files"
    identity: GatewayIdentity | None = None
    detail: str | None = None

    if live:
        identity = GatewayIdentity(
            kind=live.get("kind"),
            pid=live.get("pid"),
            start_time=live.get("start_time"),
            profile=live.get("profile"),
            supervisor=live.get("supervisor"),
            code_sha=live.get("code_sha"),
            code_version=live.get("code_version"),
            hermes_home=live.get("hermes_home"),
            served_profiles=list(live.get("served_profiles") or []),
        )
    else:
        identity = _identity_from_doc(doc)
        if home is not None and identity is None:
            detail = "no live control socket and no gateway_state.json identity"

    state_pid = doc.get("pid") if doc else None
    running = bool(
        (identity and identity.pid and pid_alive(identity.pid))
        or (state_pid and pid_alive(state_pid))
    )

    state: GatewayStateInfo | None = None
    if doc:
        state = GatewayStateInfo(
            state=doc.get("gateway_state"),
            pid=state_pid,
            updated_at=doc.get("updated_at"),
            active_agents=doc.get("active_agents"),
            active_work=doc.get("active_work"),
            served_profiles=list(doc.get("served_profiles") or []),
            exit_reason=doc.get("exit_reason"),
            restart_requested=doc.get("restart_requested"),
            code_sha=doc.get("code_sha"),
            code_version=doc.get("code_version"),
        )

    if not running:
        effective = "stopped"
    elif drain:
        effective = "draining"
    else:
        effective = (state.state if state and state.state else "running") or "running"
    if state is None:
        state = GatewayStateInfo(state=effective, pid=state_pid if running else None)
    else:
        state.state = effective

    return GatewayStatus(
        source=source,
        running=running,
        drain_requested=drain,
        identity=identity,
        state=state,
        detail=detail,
    )


def fleet(runtime: HermesRuntime) -> FleetReport:
    try:
        from hermes_cli.update_receipt import collect_fleet_versions  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001 - deep layer unavailable in this install
        return FleetReport(source="files", rows=[_fleet_row_from_state(runtime)], detail=f"{type(exc).__name__}: {exc}"[:160])

    try:
        rows_raw = collect_fleet_versions()
    except Exception as exc:  # noqa: BLE001 - scan failure degrades to the state file
        return FleetReport(source="files", rows=[_fleet_row_from_state(runtime)], detail=f"{type(exc).__name__}: {exc}"[:160])

    rows = [FleetRow(**row) for row in rows_raw if isinstance(row, dict)]
    if not rows:
        rows = [_fleet_row_from_state(runtime)]
    return FleetReport(source="deep", rows=rows)


def _fleet_row_from_state(runtime: HermesRuntime) -> FleetRow:
    doc = _read_state_doc(runtime.hermes_home)
    if not doc:
        return FleetRow(profile="default", state="unknown")
    pid = doc.get("pid")
    state = "current" if pid and pid_alive(pid) else "down"
    if doc.get("restart_requested"):
        state = "restart_pending"
    return FleetRow(
        profile=doc.get("profile") or "default",
        pid=pid,
        state=state,
        code_sha=doc.get("code_sha"),
        code_version=doc.get("code_version"),
        code_root=doc.get("code_root"),
        served_profiles=list(doc.get("served_profiles") or []),
    )


def build_lifecycle_command(runtime: HermesRuntime, action: str) -> list[str] | None:
    """argv for ``hermes gateway <action>``; None when no CLI is reachable.

    Prefers Hermes's own launcher (``hermes_cli._launchers.runtime_command``)
    so the child gets the same store-Python bootstrap Hermes uses, then falls
    back to a ``hermes`` executable on PATH.
    """
    repo = runtime.hermes_repo
    if repo is not None and (repo / "hermes_cli").is_dir():
        try:
            from hermes_cli._launchers import runtime_command  # type: ignore[import-not-found]

            home = str(runtime.hermes_home) if runtime.hermes_home else None
            return runtime_command(repo, ["gateway", action], home=home)
        except Exception:  # noqa: BLE001
            pass

    executable = shutil.which("hermes")
    if executable:
        return [executable, "gateway", action]
    return None


def lifecycle(runtime: HermesRuntime, action: str) -> LifecycleResult:
    command = build_lifecycle_command(runtime, action)
    if command is None:
        return LifecycleResult(
            ok=False,
            action=action,
            detail="no hermes CLI available (no checkout and no hermes on PATH)",
        )

    home = runtime.hermes_home
    log_name = ACTION_LOGS.get(action, f"gateway-{action}.log")
    logs_dir = home / "logs" if home else None
    if logs_dir is None:
        return LifecycleResult(ok=False, action=action, detail="HERMES_HOME is unknown; refusing to spawn")

    try:
        logs_dir.mkdir(parents=True, exist_ok=True)
        log_file = open(logs_dir / log_name, "ab", buffering=0)  # noqa: SIM115 - child inherits the fd
        log_file.write(f"\n=== manager: hermes gateway {action} ===\n".encode())
        env = dict(os.environ)
        if home is not None:
            env["HERMES_HOME"] = str(home)
        detach = (
            {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
            if sys.platform == "win32"
            else {"start_new_session": True}
        )
        proc = subprocess.Popen(  # noqa: S603 - argv built from our own resolved CLI
            command,
            cwd=str(runtime.hermes_repo or home or Path.cwd()),
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            env=env,
            **detach,
        )
    except OSError as exc:
        return LifecycleResult(ok=False, action=action, detail=f"{type(exc).__name__}: {exc}")
    finally:
        try:
            log_file.close()  # type: ignore[possibly-undefined]
        except (OSError, UnboundLocalError):
            pass

    return LifecycleResult(ok=True, action=action, pid=proc.pid, log=log_name)


def set_drain(runtime: HermesRuntime, action: str) -> DrainResult:
    home = runtime.hermes_home
    if home is None:
        return DrainResult(ok=False, action=action, drain_requested=False, source="files", detail="HERMES_HOME is unknown")

    source: SourceLayer = "files"
    try:
        from gateway.drain_control import (  # type: ignore[import-not-found]
            clear_drain_request,
            write_drain_request,
        )
    except Exception:  # noqa: BLE001 - fall back to writing the marker ourselves
        clear_drain_request = write_drain_request = None  # type: ignore[assignment]
    else:
        source = "deep"

    if action == "drain":
        try:
            if write_drain_request is not None:
                write_drain_request(principal="hermes-manager", home=home)
            else:
                marker = _drain_marker_path(home)
                assert marker is not None
                marker.write_text(
                    json.dumps({"requested_at": time.time(), "principal": "hermes-manager"}),
                    encoding="utf-8",
                )
        except OSError as exc:
            return DrainResult(ok=False, action=action, drain_requested=False, source=source, detail=f"{type(exc).__name__}: {exc}")
    elif action == "cancel":
        try:
            if clear_drain_request is not None:
                clear_drain_request(home=home)
            else:
                marker = _drain_marker_path(home)
                if marker is not None:
                    marker.unlink(missing_ok=True)
        except OSError as exc:
            return DrainResult(ok=False, action=action, drain_requested=True, source=source, detail=f"{type(exc).__name__}: {exc}")

    return DrainResult(ok=True, action=action, drain_requested=_drain_requested(home), source=source)


def processes(runtime: HermesRuntime) -> ProcessReport:
    items: list[ProcessInfo] = []
    detail: str | None = None
    source: SourceLayer = "files"

    fleet_report = fleet(runtime)
    for row in fleet_report.rows:
        items.append(
            ProcessInfo(
                kind="gateway",
                name=f"gateway · {row.profile}",
                pid=row.pid,
                status=row.state,
                detail=row.code_version,
            )
        )

    try:
        from hermes_cli.goals import gather_background_processes  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001
        detail = f"{type(exc).__name__}: {exc}"[:160]
    else:
        try:
            sessions = gather_background_processes()
        except Exception as exc:  # noqa: BLE001
            detail = f"{type(exc).__name__}: {exc}"[:160]
        else:
            source = "deep"
            for session in sessions:
                if isinstance(session, dict):
                    name = (
                        session.get("name")
                        or session.get("task_id")
                        or session.get("session_key")
                        or session.get("session_id")
                        or "background"
                    )
                    pid = session.get("pid")
                    status = session.get("status") or "running"
                    command = session.get("command") or session.get("argv")
                else:
                    name = getattr(session, "name", None) or getattr(session, "session_key", None) or "background"
                    pid = getattr(session, "pid", None)
                    status = getattr(session, "status", None) or "running"
                    command = getattr(session, "command", None)
                items.append(
                    ProcessInfo(
                        kind="background",
                        name=str(name),
                        pid=int(pid) if pid else None,
                        status=str(status),
                        detail=str(command)[:160] if command else None,
                    )
                )

    return ProcessReport(source=source, processes=items, detail=detail)
