from __future__ import annotations

import os

import httpx

from ..models import LayerStatus
from ..runtime import HermesRuntime
from ._timing import timed

DEFAULT_SERVE_PORT = 9119


def serve_endpoint() -> str:
    port = int(os.environ.get("HERMES_SERVE_PORT", "") or DEFAULT_SERVE_PORT)
    return f"http://127.0.0.1:{port}"


@timed
def probe(runtime: HermesRuntime) -> LayerStatus:
    del runtime
    endpoint = serve_endpoint()
    try:
        with httpx.Client(timeout=0.8, trust_env=False) as client:
            response = client.get(f"{endpoint}/")
    except httpx.HTTPError as exc:
        return LayerStatus(
            state="unavailable",
            detail=f"hermes serve not reachable: {type(exc).__name__}",
            origin=endpoint,
        )
    return LayerStatus(
        state="ready",
        detail=f"hermes serve answering HTTP {response.status_code}",
        origin=endpoint,
    )
