from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..models import (
    CodeIdentity,
    SourceLayer,
    UpdateApplyRequest,
    UpdateApplyResult,
    UpdateCheckResult,
    UpdateReceiptSummary,
    UpdateReport,
)
from ..runtime import HermesRuntime
from .actions import ActionError, active_status, spawn_detached

UPDATE_LOG = "manager-update.log"


def _receipt_dir(home: Path | None) -> Path | None:
    return home / "logs" / "update_receipts" if home else None


def _is_update_receipt(data: Any) -> bool:
    """True for ``hermes update`` receipts (the dir also holds pm/plugin receipts)."""
    if not isinstance(data, dict):
        return False
    kind = data.get("kind")
    if isinstance(kind, str) and kind not in {"update", ""}:
        return False
    return any(key in data for key in ("argv", "pre_update", "post_update", "fleet"))


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _newest_update_receipt(directory: Path) -> tuple[dict[str, Any] | None, str | None]:
    candidates = sorted(
        (entry for entry in directory.glob("update_*.json") if entry.is_file()),
        key=lambda entry: entry.stat().st_mtime,
        reverse=True,
    )
    for candidate in candidates:
        data = _read_json(candidate)
        if _is_update_receipt(data):
            return data, str(candidate)
    return None, None


def _load_latest_receipt(home: Path | None) -> tuple[dict[str, Any] | None, str | None]:
    directory = _receipt_dir(home)
    if directory is None or not directory.is_dir():
        return None, None
    latest = directory / "latest.json"
    if latest.is_file():
        data = _read_json(latest)
        if isinstance(data, str):
            candidate = directory / data
            if candidate.is_file():
                pointed = _read_json(candidate)
                if _is_update_receipt(pointed):
                    return pointed, str(candidate)
        elif _is_update_receipt(data):
            return data, str(latest)
        elif isinstance(data, dict):
            pointer = data.get("receipt") or data.get("file") or data.get("latest")
            if isinstance(pointer, str):
                candidate = directory / pointer
                if candidate.is_file():
                    pointed = _read_json(candidate)
                    if _is_update_receipt(pointed):
                        return pointed, str(candidate)
    # latest.json points at some other receipt kind — scan for update receipts
    scanned, scanned_path = _newest_update_receipt(directory)
    if scanned is not None:
        return scanned, scanned_path
    return None, str(latest) if latest.is_file() else None


def _nested_sha(doc: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        block = doc.get(key)
        if isinstance(block, dict):
            sha = block.get("sha") or block.get("code_sha")
            if isinstance(sha, str):
                return sha
        elif isinstance(block, str) and key in {"pre_sha", "post_sha"}:
            return block
    for key in ("pre_sha", "post_sha"):
        value = doc.get(key)
        if isinstance(value, str):
            return value
    return None


def code_identity(runtime: HermesRuntime) -> tuple[CodeIdentity, SourceLayer]:
    try:
        from hermes_cli.version_info import get_code_identity  # type: ignore[import-not-found]

        data = get_code_identity()
    except Exception:  # noqa: BLE001 - deep layer is best effort
        data = None
    if isinstance(data, dict):
        return (
            CodeIdentity(
                version=data.get("version"),
                sha=data.get("sha") or data.get("short_sha"),
                source=data.get("source"),
            ),
            "deep",
        )

    receipt, _path = _load_latest_receipt(runtime.hermes_home)
    if receipt:
        post_version = receipt.get("post_version")
        if isinstance(post_version, dict):
            post_version = post_version.get("version")
        post_sha = _nested_sha(receipt, "post_update")
        if isinstance(post_sha, str) or isinstance(post_version, str):
            return (
                CodeIdentity(version=str(post_version) if post_version else None, sha=post_sha, source="receipt"),
                "files",
            )

    home = runtime.hermes_home
    if home is not None:
        state_file = home / "gateway_state.json"
        if state_file.is_file():
            try:
                doc = json.loads(state_file.read_text(encoding="utf-8"))
                version = doc.get("code_version")
                sha = doc.get("code_sha")
                if version or sha:
                    return (
                        CodeIdentity(version=version, sha=sha, source="gateway-state"),
                        "files",
                    )
            except (OSError, ValueError):
                pass
    return CodeIdentity(), "files"


def receipt_summary(runtime: HermesRuntime) -> UpdateReceiptSummary | None:
    receipt, path = _load_latest_receipt(runtime.hermes_home)
    if not receipt:
        return None
    steps = receipt.get("steps")
    steps_ok = sum(1 for step in steps if isinstance(step, dict) and step.get("ok")) if isinstance(steps, list) else 0
    steps_failed = (
        sum(1 for step in steps if isinstance(step, dict) and not step.get("ok"))
        if isinstance(steps, list)
        else 0
    )
    post_version = receipt.get("post_version")
    if isinstance(post_version, dict):
        post_version = post_version.get("version")
    return UpdateReceiptSummary(
        outcome=receipt.get("outcome"),
        started_at=receipt.get("started_at"),
        finished_at=receipt.get("finished_at"),
        pre_sha=_nested_sha(receipt, "pre_update"),
        post_sha=_nested_sha(receipt, "post_update"),
        post_version=str(post_version) if post_version else None,
        steps_ok=steps_ok,
        steps_failed=steps_failed,
        path=path,
        detail=None,
    )


def update_report(runtime: HermesRuntime) -> UpdateReport:
    identity, source = code_identity(runtime)
    receipt = receipt_summary(runtime)
    status = active_status("update")
    pid = status.get("pid") if isinstance(status.get("pid"), int) else None
    detail = None
    if identity.version is None and identity.sha is None:
        detail = "version identity unavailable (no deep layer, no receipt, no gateway state)"
    return UpdateReport(
        source=source,
        identity=identity,
        receipt=receipt,
        running=bool(status.get("running")),
        pid=pid,
        log=status.get("log"),
        detail=detail,
    )


def _summarize_commits(raw: Any) -> list[str]:
    commits: list[str] = []
    if isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, str):
                commits.append(entry)
            elif isinstance(entry, dict):
                sha = str(entry.get("sha") or "")[:7]
                summary = entry.get("summary") or entry.get("message") or ""
                author = entry.get("author") or ""
                text = " ".join(part for part in (sha, summary, f"({author})" if author else "") if part)
                if text:
                    commits.append(text)
    return commits


def check_for_updates(runtime: HermesRuntime, force: bool = False) -> UpdateCheckResult:
    try:
        from hermes_cli.source_check import check_for_updates as _check  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001 - deep layer is best effort
        return UpdateCheckResult(supported=False, detail=f"update check unavailable: {exc}")
    try:
        data = _check(home=runtime.hermes_home, force=force, passive=True)
    except Exception as exc:  # noqa: BLE001 - network/git failures are expected
        return UpdateCheckResult(supported=False, detail=f"update check failed: {exc}")
    if not isinstance(data, dict):
        return UpdateCheckResult(supported=False, detail="update check returned no data")
    behind = data.get("behind")
    commits = _summarize_commits(data.get("commits"))
    if behind is None and commits:
        behind = len(commits)
    return UpdateCheckResult(
        supported=bool(data.get("supported")),
        update_available=bool(data.get("updateAvailable") or (isinstance(behind, int) and behind > 0)),
        behind=behind if isinstance(behind, int) else None,
        branch=data.get("currentBranch"),
        commits=commits,
        detail=data.get("message"),
    )


def apply_update(runtime: HermesRuntime, request: UpdateApplyRequest) -> UpdateApplyResult:
    args = ["update"]
    if request.branch:
        args += ["--branch", request.branch]
    if request.yes:
        args.append("--yes")
    try:
        pid, log_name = spawn_detached(runtime, args, UPDATE_LOG, "update")
    except ActionError as exc:
        return UpdateApplyResult(ok=False, detail=str(exc))
    return UpdateApplyResult(ok=True, pid=pid, log=log_name, detail=None)
