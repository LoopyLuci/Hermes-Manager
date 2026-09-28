from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..models import (
    BackupCreateRequest,
    BackupCreateResult,
    BackupDeleteResult,
    BackupItem,
    BackupReport,
    ChangePreview,
    ConfigRestorePreview,
    ConfigRestoreResult,
)
from ..runtime import HermesRuntime
from .actions import ActionError, spawn_detached
from .config import ConfigError, _atomic_write, _backup, _load_yaml_document

BACKUP_LOG = "manager-backup.log"


class BackupError(Exception):
    """A user-facing backup problem (bad path, not found, ...)."""


def _home(runtime: HermesRuntime) -> Path:
    if runtime.hermes_home is None:
        raise BackupError("HERMES_HOME is unknown")
    return runtime.hermes_home


def _classify(path: Path, home: Path) -> str:
    parents = path.parents
    if (home / "backups" / "config") in parents:
        return "config"
    if (home / "backups") in parents:
        if path.name.startswith("pre-update-"):
            return "pre-update"
        return "full" if path.suffix == ".zip" else "other"
    if (home / "state-snapshots") in parents:
        return "snapshot"
    if path.parent == home and path.name.startswith("state.db."):
        return "state-db"
    return "other"


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat(timespec="seconds")


def list_backups(runtime: HermesRuntime) -> BackupReport:
    home = runtime.hermes_home
    if home is None:
        return BackupReport(source="files", detail="HERMES_HOME is unknown")

    items: list[BackupItem] = []
    seen: set[Path] = set()

    backups_dir = home / "backups"
    if backups_dir.is_dir():
        for candidate in backups_dir.rglob("*"):
            if not candidate.is_file() or candidate.suffix == ".tmp":
                continue
            seen.add(candidate)
    snapshots_dir = home / "state-snapshots"
    if snapshots_dir.is_dir():
        for candidate in snapshots_dir.rglob("*"):
            if not candidate.is_file():
                continue
            # a snapshot entry is its top-level directory, not every file inside
            relative = candidate.relative_to(snapshots_dir)
            top = snapshots_dir / relative.parts[0]
            if top in seen:
                continue
            seen.add(top)
    for emergency in home.glob("state.db.*.bak"):
        if emergency.is_file():
            seen.add(emergency)

    for candidate in seen:
        try:
            stat = candidate.stat()
        except OSError:
            continue
        items.append(
            BackupItem(
                kind=_classify(candidate, home),
                name=candidate.name,
                path=str(candidate),
                size=stat.st_size,
                modified=_iso(stat.st_mtime),
            )
        )
    items.sort(key=lambda item: item.modified, reverse=True)
    detail = None if items else "no backups found yet"
    return BackupReport(source="files", items=items, detail=detail)


def safe_backup_path(runtime: HermesRuntime, raw: str) -> Path:
    """Resolve *raw* to an existing path that is inside a backup location.

    Live files (config.yaml, .env, state.db) are never addressable through
    this helper — only things under backups/, state-snapshots/, or the
    state.db.*.bak emergency copies at the home root.
    """
    home = _home(runtime)
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = home / raw
    resolved = candidate.resolve()
    home_resolved = home.resolve()
    try:
        resolved.relative_to(home_resolved)
    except ValueError as exc:
        raise BackupError(f"path escapes HERMES_HOME: {raw}") from exc

    in_backups = (home_resolved / "backups").resolve() in resolved.parents or resolved.parent == (
        home_resolved / "backups"
    ).resolve()
    in_snapshots = (home_resolved / "state-snapshots").resolve() in resolved.parents or resolved.parent == (
        home_resolved / "state-snapshots"
    ).resolve()
    emergency = resolved.parent == home_resolved and resolved.name.startswith("state.db.")
    if not (in_backups or in_snapshots or emergency):
        raise BackupError(f"not a backup location: {raw}")
    return resolved


def delete_backup(runtime: HermesRuntime, raw: str) -> BackupDeleteResult:
    try:
        target = safe_backup_path(runtime, raw)
    except BackupError as exc:
        return BackupDeleteResult(ok=False, path=raw, detail=str(exc))
    if not target.exists():
        return BackupDeleteResult(ok=False, path=str(target), detail="backup not found")
    try:
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
    except OSError as exc:
        return BackupDeleteResult(ok=False, path=str(target), detail=f"{type(exc).__name__}: {exc}")
    return BackupDeleteResult(ok=True, path=str(target), detail=None)


def create_backup(runtime: HermesRuntime, request: BackupCreateRequest) -> BackupCreateResult:
    home = _home(runtime)
    if request.mode == "full":
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")
        target = home / "backups" / f"hermes-backup-{stamp}.zip"
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            pid, log_name = spawn_detached(
                runtime, ["backup", "-o", str(target)], BACKUP_LOG, "backup"
            )
        except ActionError as exc:
            return BackupCreateResult(ok=False, detail=str(exc))
        return BackupCreateResult(ok=True, pid=pid, log=log_name, detail=None)

    try:
        from hermes_cli.backup import create_quick_snapshot  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001 - deep layer is best effort
        return BackupCreateResult(ok=False, detail=f"quick snapshot unavailable: {exc}")
    try:
        created = create_quick_snapshot(label="manager", hermes_home=home)
    except Exception as exc:  # noqa: BLE001 - snapshot failures vary widely
        return BackupCreateResult(ok=False, detail=f"snapshot failed: {exc}")
    if not created:
        return BackupCreateResult(ok=False, detail="snapshot produced no directory")
    return BackupCreateResult(ok=True, path=str(created), detail=None)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _flatten_values(prefix: str, data: Any, out: dict[str, str]) -> None:
    if isinstance(data, dict):
        if not data and prefix:
            out[prefix] = "{}"
        for key, value in data.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            _flatten_values(path, value, out)
    elif prefix:
        out[prefix] = _json(data)


def _is_config_backup(runtime: HermesRuntime, target: Path) -> bool:
    home = runtime.hermes_home
    if home is None:
        return False
    config_dir = (home / "backups" / "config").resolve()
    return target.parent == config_dir or config_dir in target.parents


def preview_config_restore(runtime: HermesRuntime, raw: str) -> ConfigRestorePreview:
    try:
        target = safe_backup_path(runtime, raw)
    except BackupError as exc:
        return ConfigRestorePreview(ok=False, backup=raw, detail=str(exc))
    if not target.is_file():
        return ConfigRestorePreview(ok=False, backup=str(target), detail="backup file not found")
    if not _is_config_backup(runtime, target):
        return ConfigRestorePreview(ok=False, backup=str(target), detail="not a config backup")

    try:
        backup_data, _flavour = _load_yaml_document(target)
    except ConfigError as exc:
        return ConfigRestorePreview(ok=False, backup=str(target), detail=str(exc))

    config_path = runtime.config_file
    current: dict[str, Any] = {}
    if config_path is not None and config_path.is_file():
        try:
            current, _ = _load_yaml_document(config_path)
        except ConfigError as exc:
            return ConfigRestorePreview(ok=False, backup=str(target), detail=f"current config unreadable: {exc}")

    current_flat: dict[str, str] = {}
    backup_flat: dict[str, str] = {}
    _flatten_values("", current, current_flat)
    _flatten_values("", backup_data, backup_flat)

    changes: list[ChangePreview] = []
    for path in sorted(set(current_flat) | set(backup_flat)):
        in_current = path in current_flat
        in_backup = path in backup_flat
        if in_current and in_backup and current_flat[path] == backup_flat[path]:
            continue
        action = "delete" if in_current and not in_backup else "set"
        changes.append(
            ChangePreview(
                kind="config",
                path=path,
                action=action,  # type: ignore[arg-type]
                current=current_flat.get(path),
                next=backup_flat.get(path),
                type=None,
            )
        )
    return ConfigRestorePreview(ok=True, backup=str(target), changes=changes, detail=None)


def restore_config(runtime: HermesRuntime, raw: str) -> ConfigRestoreResult:
    try:
        target = safe_backup_path(runtime, raw)
    except BackupError as exc:
        return ConfigRestoreResult(ok=False, backup=raw, detail=str(exc))
    if not target.is_file():
        return ConfigRestoreResult(ok=False, backup=str(target), detail="backup file not found")
    if not _is_config_backup(runtime, target):
        return ConfigRestoreResult(ok=False, backup=str(target), detail="not a config backup")

    try:
        text = target.read_text(encoding="utf-8")
        _load_yaml_document(target)
    except (OSError, ConfigError) as exc:
        return ConfigRestoreResult(ok=False, backup=str(target), detail=f"backup unusable: {exc}")

    config_path = runtime.config_file
    if config_path is None:
        return ConfigRestoreResult(ok=False, backup=str(target), detail="HERMES_HOME is unknown")

    created_backup: Path | None = None
    if config_path.is_file():
        created_backup = _backup(config_path)
    try:
        _atomic_write(config_path, text)
    except OSError as exc:
        return ConfigRestoreResult(
            ok=False,
            backup=str(target),
            created_backup=str(created_backup) if created_backup else None,
            detail=f"write failed: {exc}",
        )
    return ConfigRestoreResult(
        ok=True,
        backup=str(target),
        created_backup=str(created_backup) if created_backup else None,
        detail=None,
    )
