from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from ..auth import verify_token
from ..models import MessagePage, SessionList
from ..runtime import HermesRuntime
from ..services import sessions as sessions_service

router = APIRouter(prefix="/api/v1", dependencies=[Depends(verify_token)])


@router.get("/sessions", response_model=SessionList, tags=["sessions"])
def sessions(
    request: Request,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    q: Annotated[str | None, Query(description="Match by title or exact session id")] = None,
) -> SessionList:
    runtime: HermesRuntime = request.app.state.runtime
    return sessions_service.list_sessions(runtime, limit=limit, offset=offset, query=q)


@router.get("/sessions/{session_id}/messages", response_model=MessagePage, tags=["sessions"])
def messages(
    request: Request,
    session_id: str,
    limit: Annotated[int, Query(ge=1, le=500)] = 300,
    order: Annotated[str, Query(pattern="^(oldest|latest)$")] = "oldest",
) -> MessagePage:
    runtime: HermesRuntime = request.app.state.runtime
    return sessions_service.session_messages(runtime, session_id, limit=limit, order=order)
