from __future__ import annotations

import time
from collections.abc import Callable

from ..models import LayerStatus
from ..runtime import HermesRuntime

Probe = Callable[[HermesRuntime], LayerStatus]


def timed(probe: Probe) -> Probe:
    def wrapper(runtime: HermesRuntime) -> LayerStatus:
        started = time.perf_counter()
        status = probe(runtime)
        if status.latency_ms is None:
            status.latency_ms = round((time.perf_counter() - started) * 1000, 2)
        return status

    return wrapper
