from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..auth import verify_token
from ..models import (
    UpdateApplyRequest,
    UpdateApplyResult,
    UpdateCheckResult,
    UpdateReport,
)
from ..runtime import HermesRuntime
from ..services import updates as updates_service

router = APIRouter(prefix="/api/v1", dependencies=[Depends(verify_token)])


@router.get("/updates", response_model=UpdateReport, tags=["updates"])
def report(request: Request) -> UpdateReport:
    runtime: HermesRuntime = request.app.state.runtime
    return updates_service.update_report(runtime)


@router.post("/updates/check", response_model=UpdateCheckResult, tags=["updates"])
def check(request: Request, force: bool = False) -> UpdateCheckResult:
    runtime: HermesRuntime = request.app.state.runtime
    return updates_service.check_for_updates(runtime, force=force)


@router.post("/updates/apply", response_model=UpdateApplyResult, tags=["updates"])
def apply(request: Request, body: UpdateApplyRequest) -> UpdateApplyResult:
    runtime: HermesRuntime = request.app.state.runtime
    return updates_service.apply_update(runtime, body)
