from __future__ import annotations

import json
import re
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any

from ..models import (
    CronActionResult,
    CronJobSummary,
    CronReport,
    LocalModel,
    LocalModelsReport,
    McpReport,
    McpServer,
    McpTestResult,
    PluginEntry,
    PluginReport,
    SkillEntry,
    SkillList,
    SkillToggleResult,
)
from ..runtime import HermesRuntime
from .actions import ActionError, spawn_detached
from .config import (
    CONFIG_LOCK,
    ConfigError,
    _atomic_write,
    _backup,
    _dump_yaml_document,
    _load_yaml_document,
)

_MCP_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_\-]{1,100}$")
_JOB_ID_PATTERN = re.compile(r"^[A-Za-z0-9_\-]{1,200}$")
_SKILL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_\-\.]{1,200}$")
_DESCRIPTION_PATTERN = re.compile(r"^\s*description:\s*[\"']?(.*?)[\"']?\s*$", re.MULTILINE)
_OLLAMA_PORT = 11434


class ToolsError(Exception):
    """A user-facing tools-center problem."""


def _read_config(runtime: HermesRuntime) -> tuple[dict[str, Any], str]:
    path = runtime.config_file
    if path is None or not path.is_file():
        raise ToolsError("config.yaml not found")
    return _load_yaml_document(path)


# --------------------------------------------------------------------------- mcp


def list_mcp(runtime: HermesRuntime) -> McpReport:
    try:
        data, _flavour = _read_config(runtime)
    except ConfigError as exc:
        return McpReport(source="files", detail=str(exc))
    raw = data.get("mcp_servers")
    if not isinstance(raw, dict):
        return McpReport(source="files", detail="no mcp_servers configured")
    servers: list[McpServer] = []
    for name in sorted(raw):
        spec = raw[name]
        if not isinstance(spec, dict):
            continue
        url = spec.get("url") if isinstance(spec.get("url"), str) else None
        timeout = spec.get("timeout")
        connect_timeout = spec.get("connect_timeout")
        servers.append(
            McpServer(
                name=str(name),
                transport="http" if url else "stdio",
                command=str(spec["command"]) if spec.get("command") else None,
                args=[str(part) for part in spec.get("args") or []] if isinstance(spec.get("args"), list) else [],
                url=url,
                enabled=bool(spec.get("enabled", True)),
                timeout=float(timeout) if isinstance(timeout, (int, float)) else None,
                connect_timeout=float(connect_timeout) if isinstance(connect_timeout, (int, float)) else None,
            )
        )
    return McpReport(source="files", servers=servers, detail=None)


def test_mcp(runtime: HermesRuntime, name: str) -> McpTestResult:
    if not _MCP_NAME_PATTERN.match(name):
        return McpTestResult(ok=False, detail=f"invalid server name: {name!r}")
    report = list_mcp(runtime)
    if all(server.name != name for server in report.servers):
        return McpTestResult(ok=False, detail=f"server not configured: {name}")
    try:
        pid, log_name = spawn_detached(runtime, ["mcp", "test", name], "manager-mcp-test.log", "mcp")
    except ActionError as exc:
        return McpTestResult(ok=False, detail=str(exc))
    return McpTestResult(ok=True, pid=pid, log=log_name, detail=None)


# ------------------------------------------------------------------------ skills


def _skills_dir(runtime: HermesRuntime) -> Path | None:
    if runtime.hermes_home is None:
        return None
    candidate = runtime.hermes_home / "skills"
    return candidate if candidate.is_dir() else None


def _disabled_skills(runtime: HermesRuntime) -> set[str]:
    try:
        data, _flavour = _read_config(runtime)
    except ConfigError:
        return set()
    skills = data.get("skills")
    if isinstance(skills, dict):
        disabled = skills.get("disabled")
        if isinstance(disabled, list):
            return {str(entry) for entry in disabled}
    return set()


def _skill_description(path: Path) -> str | None:
    skill_md = path / "SKILL.md"
    if not skill_md.is_file():
        return None
    try:
        head = skill_md.read_text(encoding="utf-8", errors="replace")[:8192]
    except OSError:
        return None
    match = _DESCRIPTION_PATTERN.search(head)
    if match and match.group(1).strip():
        return match.group(1).strip()
    for line in head.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return None


def list_skills(
    runtime: HermesRuntime,
    query: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> SkillList:
    directory = _skills_dir(runtime)
    if directory is None:
        return SkillList(source="files", offset=offset, limit=limit, query=query, detail="skills/ not found")
    try:
        names = sorted(
            entry.name
            for entry in directory.iterdir()
            if entry.is_dir() and not entry.name.startswith(".")
        )
    except OSError as exc:
        return SkillList(source="files", offset=offset, limit=limit, query=query, detail=str(exc))

    needle = (query or "").strip().lower()
    if needle:
        names = [name for name in names if needle in name.lower()]
    total = len(names)
    disabled = _disabled_skills(runtime)
    page_names = names[max(offset, 0) : max(offset, 0) + max(min(limit, 200), 1)]
    skills = [
        SkillEntry(
            name=name,
            description=_skill_description(directory / name),
            enabled=name not in disabled,
        )
        for name in page_names
    ]
    return SkillList(
        source="files",
        total=total,
        offset=offset,
        limit=limit,
        query=query,
        skills=skills,
        disabled_count=len(disabled),
        detail=None,
    )


def toggle_skill(runtime: HermesRuntime, name: str, enable: bool) -> SkillToggleResult:
    if not _SKILL_NAME_PATTERN.match(name):
        return SkillToggleResult(ok=False, detail=f"invalid skill name: {name!r}")
    directory = _skills_dir(runtime)
    if directory is None or not (directory / name).is_dir():
        return SkillToggleResult(ok=False, detail=f"skill not found: {name}")

    with CONFIG_LOCK:
        try:
            data, flavour = _read_config(runtime)
        except ConfigError as exc:
            return SkillToggleResult(ok=False, detail=str(exc))
        skills = data.get("skills")
        if not isinstance(skills, dict):
            skills = {}
            data["skills"] = skills
        disabled_value = skills.get("disabled")
        disabled = [str(entry) for entry in disabled_value] if isinstance(disabled_value, list) else []
        if enable:
            disabled = [entry for entry in disabled if entry != name]
        elif name not in disabled:
            disabled.append(name)
        skills["disabled"] = disabled
        path = runtime.config_file
        assert path is not None
        _backup(path)
        try:
            _atomic_write(path, _dump_yaml_document(data, flavour))
        except OSError as exc:
            return SkillToggleResult(ok=False, detail=f"write failed: {exc}")
    return SkillToggleResult(ok=True, disabled=disabled, detail=None)


# ------------------------------------------------------------------------- cron


def list_cron(runtime: HermesRuntime) -> CronReport:
    if runtime.hermes_home is None:
        return CronReport(source="files", detail="HERMES_HOME is unknown")
    path = runtime.hermes_home / "cron" / "jobs.json"
    if not path.is_file():
        return CronReport(source="files", detail="cron/jobs.json not found")
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return CronReport(source="files", detail=f"jobs.json unreadable: {exc}")
    jobs_raw = doc.get("jobs") if isinstance(doc, dict) else None
    if not isinstance(jobs_raw, list):
        return CronReport(source="files", detail="jobs.json has no jobs list")

    jobs: list[CronJobSummary] = []
    for raw in jobs_raw:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        schedule = raw.get("schedule")
        schedule_display = raw.get("schedule_display")
        if not schedule_display and isinstance(schedule, dict):
            schedule_display = schedule.get("display")
        prompt = raw.get("prompt")
        jobs.append(
            CronJobSummary(
                id=str(raw["id"]),
                name=str(raw["name"]) if raw.get("name") else None,
                schedule=str(schedule_display) if schedule_display else None,
                enabled=bool(raw.get("enabled", True)),
                state=str(raw["state"]) if raw.get("state") else None,
                last_status=str(raw["last_status"]) if raw.get("last_status") else None,
                last_run_at=str(raw["last_run_at"]) if raw.get("last_run_at") else None,
                next_run_at=str(raw["next_run_at"]) if raw.get("next_run_at") else None,
                no_agent=bool(raw.get("no_agent", False)),
                script=str(raw["script"]) if raw.get("script") else None,
                prompt=(str(prompt)[:200] if isinstance(prompt, str) else None),
            )
        )
    return CronReport(
        source="files",
        jobs=jobs,
        updated_at=str(doc.get("updated_at")) if isinstance(doc, dict) and doc.get("updated_at") else None,
        detail=None,
    )


def cron_action(runtime: HermesRuntime, job_id: str, action: str) -> CronActionResult:
    if not _JOB_ID_PATTERN.match(job_id):
        return CronActionResult(ok=False, detail=f"invalid job id: {job_id!r}")
    known = {job.id for job in list_cron(runtime).jobs}
    if job_id not in known:
        return CronActionResult(ok=False, detail=f"job not found: {job_id}")
    try:
        pid, log_name = spawn_detached(
            runtime, ["cron", action, job_id], "manager-cron.log", "cron"
        )
    except ActionError as exc:
        return CronActionResult(ok=False, detail=str(exc))
    return CronActionResult(ok=True, pid=pid, log=log_name, detail=None)


# ---------------------------------------------------------------------- plugins


def list_plugins(runtime: HermesRuntime) -> PluginReport:
    if runtime.hermes_repo is None:
        return PluginReport(source="files", detail="hermes checkout not found")
    enabled_set: set[str] = set()
    disabled_set: set[str] = set()
    try:
        data, _flavour = _read_config(runtime)
        plugins = data.get("plugins")
        if isinstance(plugins, dict):
            enabled_set = {str(x) for x in plugins.get("enabled") or [] if isinstance(x, (str, int))}
            disabled_set = {str(x) for x in plugins.get("disabled") or [] if isinstance(x, (str, int))}
    except ConfigError:
        pass

    entries: list[PluginEntry] = []
    bundled_root = runtime.hermes_repo / "plugins"
    if bundled_root.is_dir():
        for child in sorted(bundled_root.iterdir()):
            if child.is_dir() and not child.name.startswith((".", "__")):
                entries.append(
                    PluginEntry(
                        name=child.name,
                        source="bundled",
                        enabled=child.name not in disabled_set,
                    )
                )
    user_root = runtime.hermes_home / "plugins" if runtime.hermes_home else None
    if user_root is not None and user_root.is_dir():
        for child in sorted(user_root.iterdir()):
            if child.is_dir() and not child.name.startswith((".", "__")):
                entries.append(
                    PluginEntry(name=child.name, source="user", enabled=child.name in enabled_set)
                )
    catalog_root = runtime.hermes_repo / "plugin-catalog"
    catalog_count = len(list(catalog_root.glob("*.yaml"))) if catalog_root.is_dir() else 0
    return PluginReport(source="files", plugins=entries, catalog_count=catalog_count, detail=None)


# ------------------------------------------------------------ local models


def _ollama_running() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", _OLLAMA_PORT), timeout=0.4):
            return True
    except OSError:
        return False


def _parse_size(text: str) -> int | None:
    match = re.match(r"^\s*([\d.]+)\s*([KMGTP]?i?B)\s*$", text.strip())
    if not match:
        return None
    factors = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4, "PB": 1024**5}
    unit = match.group(2).upper().replace("IB", "B")
    factor = factors.get(unit)
    if factor is None:
        return None
    try:
        return int(float(match.group(1)) * factor)
    except ValueError:
        return None


def _ollama_models() -> tuple[list[LocalModel], str | None]:
    executable = shutil.which("ollama")
    if not executable:
        return [], "ollama not on PATH"
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv, own PATH lookup
            [executable, "list"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return [], f"ollama list failed: {exc}"
    if result.returncode != 0:
        return [], (result.stderr or "").strip() or f"ollama list exited {result.returncode}"
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        return [], None
    models: list[LocalModel] = []
    for line in lines[1:]:
        parts = re.split(r"\s{2,}", line.strip())
        if not parts:
            continue
        size = _parse_size(parts[2]) if len(parts) > 2 else None
        details = " · ".join(parts[3:]) if len(parts) > 3 else None
        models.append(LocalModel(name=parts[0], size=size, details=details or None))
    return models, None


def list_local_models(runtime: HermesRuntime) -> LocalModelsReport:
    gguf: list[LocalModel] = []
    if runtime.hermes_home is not None:
        models_dir = runtime.hermes_home / "models"
        if models_dir.is_dir():
            for candidate in sorted(models_dir.glob("*.gguf")):
                try:
                    size = candidate.stat().st_size
                except OSError:
                    size = None
                gguf.append(LocalModel(name=candidate.name, size=size, details="local gguf"))

    running = _ollama_running()
    models: list[LocalModel] = []
    detail: str | None = None
    if running:
        models, detail = _ollama_models()
    else:
        detail = f"ollama server not responding on :{_OLLAMA_PORT}"
    return LocalModelsReport(
        source="files",
        ollama_running=running,
        ollama_models=models,
        gguf=gguf,
        detail=detail,
    )
