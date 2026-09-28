from __future__ import annotations

from datetime import datetime, timezone

from .. import APP_NAME, __version__
from ..models import HealthReport, RuntimeInfo, SourceStatus
from ..runtime import HermesRuntime
from ..sources import probe_all, resolve_domains


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds")


def build_health(runtime: HermesRuntime, started_at: datetime) -> HealthReport:
    now = datetime.now(timezone.utc)
    layers = probe_all(runtime)
    return HealthReport(
        ok=all(status.state != "unavailable" for status in layers.values()),
        app=APP_NAME,
        app_version=__version__,
        started_at=_iso(started_at),
        uptime_s=round((now - started_at).total_seconds(), 3),
        hermes_home=str(runtime.hermes_home) if runtime.hermes_home else None,
        hermes_repo=str(runtime.hermes_repo) if runtime.hermes_repo else None,
        runtime=RuntimeInfo(
            python=runtime.python,
            kind=runtime.python_kind,
            version=runtime.python_version,
        ),
        layers=layers,
    )


def build_source_status(runtime: HermesRuntime) -> SourceStatus:
    layers = probe_all(runtime)
    return SourceStatus(layers=layers, domains=resolve_domains(layers))
