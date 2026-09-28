from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .auth import verify_token, verify_websocket_token
from .models import ErrorBody, Heartbeat, HealthReport, SourceStatus
from . import catalog as op_catalog
from .routes.backups import router as backups_router
from .routes.chat import router as chat_router
from .routes.config import router as config_router
from .routes.gateway import router as gateway_router
from .routes.gui import router as gui_router
from .routes.gui import ws_router as gui_ws_router
from .routes.logs import follow_router as logs_follow_router
from .routes.logs import router as logs_router
from .routes.sessions import router as sessions_router
from .routes.tools import router as tools_router
from .routes.updates import router as updates_router
from .runtime import HermesRuntime, resolve_runtime
from .services.health import build_health, build_source_status

api_router = APIRouter(prefix="/api/v1", dependencies=[Depends(verify_token)])
ws_router = APIRouter(prefix="/api/v1")
public_router = APIRouter()


@api_router.get(
    "/health",
    response_model=HealthReport,
    responses={401: {"model": ErrorBody}},
    tags=["core"],
)
def health(request: Request) -> HealthReport:
    runtime: HermesRuntime = request.app.state.runtime
    started_at: datetime = request.app.state.started_at
    return build_health(runtime, started_at)


@api_router.get(
    "/sources",
    response_model=SourceStatus,
    responses={401: {"model": ErrorBody}},
    tags=["core"],
)
def sources(request: Request) -> SourceStatus:
    runtime: HermesRuntime = request.app.state.runtime
    return build_source_status(runtime)


@api_router.get("/openapi.json", include_in_schema=False)
def openapi_spec(request: Request) -> dict:
    """The full API description (behind the token: the public /docs and /openapi.json are switched off)."""
    return request.app.openapi()


@api_router.get("/operations", tags=["core"])
def operations(request: Request) -> list[dict]:
    """Every operation the bridge offers, with one argument schema each (see catalog.py)."""
    return [{k: v for k, v in op.items() if k != "where"} for op in _catalog(request.app)]


@api_router.post("/call/{op_id}", tags=["core"])
async def call_operation(op_id: str, request: Request) -> JSONResponse:
    """Run one operation by id with its arguments as a JSON object, and return its answer as it is."""
    import httpx

    op = next((o for o in _catalog(request.app) if o["id"] == op_id), None)
    if op is None:
        return JSONResponse(status_code=404, content={"detail": f"no operation {op_id!r}"})
    try:
        args = await request.json() if await request.body() else {}
        method, path, query, body = op_catalog.request_for(op, args if isinstance(args, dict) else {})
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"detail": str(exc)})
    transport = httpx.ASGITransport(app=request.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://bridge", timeout=900) as client:
        r = await client.request(method, path, params=query, json=body,
                                 headers={"Authorization": f"Bearer {request.app.state.token}"})
    try:
        content = r.json()
    except ValueError:
        content = {"text": r.text}
    return JSONResponse(status_code=r.status_code, content=content)


def _catalog(app: FastAPI) -> list[dict]:
    if getattr(app.state, "catalog", None) is None:
        app.state.catalog = op_catalog.build(app)
    return app.state.catalog


@public_router.get("/api/v1/ping", include_in_schema=False)
def ping() -> dict:
    """No token needed: lets a client tell that the bridge in the discovery file is the one answering."""
    return {"ok": True, "service": "hermes-manager-bridge", "pid": os.getpid(), "version": __version__}


@ws_router.websocket("/stream")
async def stream(websocket: WebSocket, token: Annotated[str | None, Query()] = None) -> None:
    if not verify_websocket_token(websocket, token):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    started_at: datetime = websocket.app.state.started_at
    try:
        while True:
            now = datetime.now(timezone.utc)
            await websocket.send_json(
                Heartbeat(at=now.isoformat(timespec="seconds"), uptime_s=(now - started_at).total_seconds()).model_dump()
            )
            await asyncio.sleep(2.0)
    except (WebSocketDisconnect, RuntimeError):
        return


def create_app(runtime: HermesRuntime | None = None, token: str | None = None) -> FastAPI:
    resolved = runtime or resolve_runtime()
    app = FastAPI(
        title="Hermes Manager Bridge",
        version=__version__,
        description="Local control-plane API in front of a Hermes install.",
        responses={401: {"model": ErrorBody}},
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.runtime = resolved
    app.state.token = token
    app.state.started_at = datetime.now(timezone.utc)

    app.state.catalog = None
    app.include_router(public_router)
    app.include_router(api_router)
    app.include_router(ws_router)
    app.include_router(gui_router)
    app.include_router(gui_ws_router)
    app.include_router(gateway_router)
    app.include_router(logs_router)
    app.include_router(logs_follow_router)
    app.include_router(sessions_router)
    app.include_router(chat_router)
    app.include_router(config_router)
    app.include_router(updates_router)
    app.include_router(backups_router)
    app.include_router(tools_router)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["*"],
    )

    @app.exception_handler(Exception)
    async def unhandled(_request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})

    return app
