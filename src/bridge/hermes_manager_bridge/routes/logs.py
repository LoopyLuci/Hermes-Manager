from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, WebSocket, WebSocketDisconnect

from ..auth import verify_token, verify_websocket_token
from ..models import LogBatch, LogFile, LogFollowEvent
from ..runtime import HermesRuntime
from ..services import logs as log_service

router = APIRouter(prefix="/api/v1", dependencies=[Depends(verify_token)])
follow_router = APIRouter(prefix="/api/v1")


@router.get("/logs", response_model=list[LogFile], tags=["logs"])
def list_log_files(request: Request) -> list[LogFile]:
    runtime: HermesRuntime = request.app.state.runtime
    return log_service.list_logs(runtime)


@router.get("/logs/tail", response_model=LogBatch, tags=["logs"])
def tail(
    request: Request,
    file: Annotated[str, Query(description="Log file name inside the logs directory")],
    lines: Annotated[int, Query(ge=1, le=5000)] = 300,
) -> LogBatch:
    runtime: HermesRuntime = request.app.state.runtime
    path = log_service.safe_log_path(runtime, file)
    if path is None:
        return LogBatch(file=file, entries=[], offset=0, truncated=False)
    entries, offset = log_service.read_tail(path, lines)
    return LogBatch(file=file, entries=entries, offset=offset)


@router.get("/logs/read", response_model=LogBatch, tags=["logs"])
def read(
    request: Request,
    file: Annotated[str, Query()],
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=2000)] = 500,
) -> LogBatch:
    runtime: HermesRuntime = request.app.state.runtime
    path = log_service.safe_log_path(runtime, file)
    if path is None:
        return LogBatch(file=file, entries=[], offset=offset)
    entries, next_offset, truncated = log_service.read_from(path, offset, 0, limit)
    return LogBatch(file=file, entries=entries, offset=next_offset, truncated=truncated)


@follow_router.websocket("/logs/stream")
async def stream(
    websocket: WebSocket,
    file: Annotated[str, Query()],
    offset: Annotated[int, Query(ge=0)] = 0,
    token: Annotated[str | None, Query()] = None,
) -> None:
    if not verify_websocket_token(websocket, token):
        await websocket.close(code=1008)
        return
    runtime: HermesRuntime = websocket.app.state.runtime
    path = log_service.safe_log_path(runtime, file)
    if path is None:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    current = offset
    seq = 0
    try:
        while True:
            if path.stat().st_size < current:
                current = 0
                await websocket.send_json(LogFollowEvent(file=file, entries=[], offset=0, rotated=True).model_dump())
            entries, current, _ = log_service.read_from(path, current, seq, limit=1000)
            seq += len(entries)
            if entries:
                await websocket.send_json(
                    LogFollowEvent(file=file, entries=entries, offset=current).model_dump()
                )
            await asyncio.sleep(0.7)
    except (WebSocketDisconnect, RuntimeError):
        return
    except FileNotFoundError:
        await websocket.close(code=1011)
        return
