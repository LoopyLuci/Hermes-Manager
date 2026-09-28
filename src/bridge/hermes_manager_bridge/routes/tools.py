from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..auth import verify_token
from ..models import (
    CronActionRequest,
    CronActionResult,
    CronReport,
    LocalModelsReport,
    McpReport,
    McpTestRequest,
    McpTestResult,
    PluginReport,
    SkillList,
    SkillToggleRequest,
    SkillToggleResult,
)
from ..runtime import HermesRuntime
from ..services import tools as tools_service

router = APIRouter(prefix="/api/v1", dependencies=[Depends(verify_token)])


@router.get("/tools/mcp", response_model=McpReport, tags=["tools"])
def mcp_list(request: Request) -> McpReport:
    runtime: HermesRuntime = request.app.state.runtime
    return tools_service.list_mcp(runtime)


@router.post("/tools/mcp/test", response_model=McpTestResult, tags=["tools"])
def mcp_test(request: Request, body: McpTestRequest) -> McpTestResult:
    runtime: HermesRuntime = request.app.state.runtime
    return tools_service.test_mcp(runtime, body.name)


@router.get("/tools/skills", response_model=SkillList, tags=["tools"])
def skills_list(
    request: Request,
    q: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> SkillList:
    runtime: HermesRuntime = request.app.state.runtime
    return tools_service.list_skills(runtime, query=q, offset=offset, limit=limit)


@router.post("/tools/skills/toggle", response_model=SkillToggleResult, tags=["tools"])
def skills_toggle(request: Request, body: SkillToggleRequest) -> SkillToggleResult:
    runtime: HermesRuntime = request.app.state.runtime
    return tools_service.toggle_skill(runtime, body.name, body.enable)


@router.get("/tools/cron", response_model=CronReport, tags=["tools"])
def cron_list(request: Request) -> CronReport:
    runtime: HermesRuntime = request.app.state.runtime
    return tools_service.list_cron(runtime)


@router.post("/tools/cron/action", response_model=CronActionResult, tags=["tools"])
def cron_action(request: Request, body: CronActionRequest) -> CronActionResult:
    runtime: HermesRuntime = request.app.state.runtime
    return tools_service.cron_action(runtime, body.job_id, body.action)


@router.get("/tools/plugins", response_model=PluginReport, tags=["tools"])
def plugins_list(request: Request) -> PluginReport:
    runtime: HermesRuntime = request.app.state.runtime
    return tools_service.list_plugins(runtime)


@router.get("/tools/models", response_model=LocalModelsReport, tags=["tools"])
def models_list(request: Request) -> LocalModelsReport:
    runtime: HermesRuntime = request.app.state.runtime
    return tools_service.list_local_models(runtime)
