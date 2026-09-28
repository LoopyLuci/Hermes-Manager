from __future__ import annotations

import importlib

from ..models import LayerStatus
from ..runtime import HermesRuntime
from ._timing import timed

PROBED_MODULES = ("gateway.status", "hermes_cli.config", "pm.environments")


@timed
def probe(runtime: HermesRuntime) -> LayerStatus:
    origin = str(runtime.hermes_repo) if runtime.hermes_repo else "-"
    imported: list[str] = []
    first_error = ""
    for name in PROBED_MODULES:
        try:
            importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001 - any import failure degrades this layer
            if not first_error:
                first_error = f"{type(exc).__name__}: {exc}"
        else:
            imported.append(name)

    if "gateway.status" in imported:
        state = "ready"
        detail = f"in-process imports OK ({len(imported)}/{len(PROBED_MODULES)})"
    elif imported:
        state = "degraded"
        detail = f"partial imports ({len(imported)}/{len(PROBED_MODULES)}): {first_error[:160]}"
    else:
        state = "unavailable"
        detail = first_error[:160] or "hermes modules not importable"
    return LayerStatus(state=state, detail=detail, origin=origin)
