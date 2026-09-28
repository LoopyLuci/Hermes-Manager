from __future__ import annotations

from ..models import LayerStatus
from ..runtime import HermesRuntime
from ._timing import timed

TRACKED_LOGS = (
    "agent.log",
    "errors.log",
    "gateway.log",
    "gui.log",
    "desktop.log",
    "mcp-stderr.log",
    "update.log",
)


def _human(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


@timed
def probe(runtime: HermesRuntime) -> LayerStatus:
    logs_dir = runtime.logs_dir
    if logs_dir is None:
        return LayerStatus(state="unavailable", detail="HERMES_HOME not resolved", origin="-")
    if not logs_dir.is_dir():
        return LayerStatus(state="unavailable", detail=f"missing directory {logs_dir}", origin=str(logs_dir))

    present = [name for name in TRACKED_LOGS if (logs_dir / name).is_file()]
    total = sum((logs_dir / name).stat().st_size for name in present)
    if not present:
        return LayerStatus(state="degraded", detail="logs directory is empty", origin=str(logs_dir))
    return LayerStatus(
        state="ready",
        detail=f"{len(present)} active logs, {_human(total)}",
        origin=str(logs_dir),
    )
