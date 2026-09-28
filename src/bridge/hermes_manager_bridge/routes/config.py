from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import verify_token
from ..models import (
    ConfigApplyResult,
    ConfigDiff,
    ConfigDocument,
    ConfigEditRequest,
    EnvReport,
)
from ..runtime import HermesRuntime
from ..services import config as config_service
from ..services.config import ConfigError

router = APIRouter(prefix="/api/v1", dependencies=[Depends(verify_token)])


@router.get("/config", response_model=ConfigDocument, tags=["config"])
def read_config(request: Request) -> ConfigDocument:
    runtime: HermesRuntime = request.app.state.runtime
    return config_service.read_config(runtime)


@router.get("/config/env", response_model=EnvReport, tags=["config"])
def read_env(request: Request) -> EnvReport:
    runtime: HermesRuntime = request.app.state.runtime
    return config_service.read_env(runtime)


@router.post("/config/diff", response_model=ConfigDiff, tags=["config"])
def diff(request: Request, body: ConfigEditRequest) -> ConfigDiff:
    runtime: HermesRuntime = request.app.state.runtime
    try:
        return config_service.compute_diff(runtime, body)
    except ConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/config/apply", response_model=ConfigApplyResult, tags=["config"])
def apply(request: Request, body: ConfigEditRequest) -> ConfigApplyResult:
    runtime: HermesRuntime = request.app.state.runtime
    try:
        return config_service.apply_edits(runtime, body)
    except ConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"write failed: {exc}") from exc
