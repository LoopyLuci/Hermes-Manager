from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..auth import verify_token
from ..models import (
    BackupCreateRequest,
    BackupCreateResult,
    BackupDeleteResult,
    BackupReport,
    BackupTargetRequest,
    ConfigRestorePreview,
    ConfigRestoreRequest,
    ConfigRestoreResult,
)
from ..runtime import HermesRuntime
from ..services import backups as backups_service

router = APIRouter(prefix="/api/v1", dependencies=[Depends(verify_token)])


@router.get("/backups", response_model=BackupReport, tags=["backups"])
def list_backups(request: Request) -> BackupReport:
    runtime: HermesRuntime = request.app.state.runtime
    return backups_service.list_backups(runtime)


@router.post("/backups/create", response_model=BackupCreateResult, tags=["backups"])
def create(request: Request, body: BackupCreateRequest) -> BackupCreateResult:
    runtime: HermesRuntime = request.app.state.runtime
    return backups_service.create_backup(runtime, body)


@router.post("/backups/delete", response_model=BackupDeleteResult, tags=["backups"])
def delete(request: Request, body: BackupTargetRequest) -> BackupDeleteResult:
    runtime: HermesRuntime = request.app.state.runtime
    return backups_service.delete_backup(runtime, body.path)


@router.post("/backups/config/preview", response_model=ConfigRestorePreview, tags=["backups"])
def preview_restore(request: Request, body: ConfigRestoreRequest) -> ConfigRestorePreview:
    runtime: HermesRuntime = request.app.state.runtime
    return backups_service.preview_config_restore(runtime, body.path)


@router.post("/backups/config/restore", response_model=ConfigRestoreResult, tags=["backups"])
def restore(request: Request, body: ConfigRestoreRequest) -> ConfigRestoreResult:
    runtime: HermesRuntime = request.app.state.runtime
    return backups_service.restore_config(runtime, body.path)
