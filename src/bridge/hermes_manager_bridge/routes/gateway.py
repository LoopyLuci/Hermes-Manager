from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..auth import verify_token
from ..models import (
    DrainRequest,
    DrainResult,
    FleetReport,
    GatewayStatus,
    LifecycleRequest,
    LifecycleResult,
    ProcessReport,
)
from ..runtime import HermesRuntime
from ..services import gateway as gateway_service

router = APIRouter(prefix="/api/v1", dependencies=[Depends(verify_token)])


@router.get("/gateway", response_model=GatewayStatus, tags=["gateway"])
def status(request: Request) -> GatewayStatus:
    runtime: HermesRuntime = request.app.state.runtime
    return gateway_service.gateway_status(runtime)


@router.get("/gateway/fleet", response_model=FleetReport, tags=["gateway"])
def fleet(request: Request) -> FleetReport:
    runtime: HermesRuntime = request.app.state.runtime
    return gateway_service.fleet(runtime)


@router.get("/processes", response_model=ProcessReport, tags=["gateway"])
def processes(request: Request) -> ProcessReport:
    runtime: HermesRuntime = request.app.state.runtime
    return gateway_service.processes(runtime)


@router.post("/gateway/lifecycle", response_model=LifecycleResult, tags=["gateway"])
def lifecycle(request: Request, body: LifecycleRequest) -> LifecycleResult:
    runtime: HermesRuntime = request.app.state.runtime
    return gateway_service.lifecycle(runtime, body.action)


@router.post("/gateway/drain", response_model=DrainResult, tags=["gateway"])
def drain(request: Request, body: DrainRequest) -> DrainResult:
    runtime: HermesRuntime = request.app.state.runtime
    return gateway_service.set_drain(runtime, body.action)
