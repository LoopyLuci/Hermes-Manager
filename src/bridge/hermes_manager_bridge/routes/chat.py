from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from ..auth import verify_token
from ..models import ChatAbort, ChatRequest
from ..runtime import HermesRuntime
from ..services import chat as chat_service

router = APIRouter(prefix="/api/v1", dependencies=[Depends(verify_token)])


@router.post("/chat", tags=["chat"])
def chat(request: Request, body: ChatRequest) -> StreamingResponse:
    """Stream one chat turn as newline-delimited JSON events.

    Frames: ``manager.started`` → stream-json frames from ``hermes chat``
    (``system``/``text``/``tool_use``/``tool_result``/``result``) →
    ``manager.done`` (or ``manager.error``). Closing the connection kills the child.
    """
    runtime: HermesRuntime = request.app.state.runtime

    def generate():
        for event in chat_service.stream_chat(runtime, body, body.chat_id):
            yield json.dumps(event, ensure_ascii=False) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@router.post("/chat/abort", tags=["chat"])
def abort(body: ChatAbort) -> dict:
    return {"ok": chat_service.abort_chat(body.chat_id)}
