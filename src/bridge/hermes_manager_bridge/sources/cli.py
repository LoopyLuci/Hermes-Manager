from __future__ import annotations

import shutil

from ..models import LayerStatus
from ..runtime import HermesRuntime
from ._timing import timed


@timed
def probe(runtime: HermesRuntime) -> LayerStatus:
    repo = runtime.hermes_repo
    if repo is not None and (repo / "hermes_cli").is_dir():
        return LayerStatus(state="ready", detail="hermes CLI from checkout", origin=str(repo))

    executable = shutil.which("hermes")
    if executable:
        return LayerStatus(state="ready", detail="hermes CLI on PATH", origin=executable)

    return LayerStatus(
        state="unavailable",
        detail="no hermes checkout and no hermes on PATH",
        origin=str(repo) if repo else "-",
    )
