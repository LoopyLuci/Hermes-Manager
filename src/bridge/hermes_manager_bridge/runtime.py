from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class HermesRuntime:
    hermes_home: Path | None
    hermes_repo: Path | None
    python: str
    python_kind: str

    @property
    def python_version(self) -> str:
        return ".".join(str(part) for part in sys.version_info[:3])

    @property
    def logs_dir(self) -> Path | None:
        return self.hermes_home / "logs" if self.hermes_home else None

    @property
    def state_db(self) -> Path | None:
        return self.hermes_home / "state.db" if self.hermes_home else None

    @property
    def config_file(self) -> Path | None:
        return self.hermes_home / "config.yaml" if self.hermes_home else None

    @property
    def env_file(self) -> Path | None:
        return self.hermes_home / ".env" if self.hermes_home else None

    @property
    def gateway_state_file(self) -> Path | None:
        return self.hermes_home / "gateway_state.json" if self.hermes_home else None


def _looks_like_home(path: Path) -> bool:
    return (path / "hermes-agent").is_dir() or (path / "logs").is_dir()


def _discover_home() -> Path | None:
    from_env = os.environ.get("HERMES_HOME", "").strip()
    if from_env:
        candidate = Path(from_env)
        if _looks_like_home(candidate):
            return candidate
    for env_var in ("LOCALAPPDATA", "APPDATA"):
        base = os.environ.get(env_var)
        if base:
            candidate = Path(base) / "hermes"
            if _looks_like_home(candidate):
                return candidate
    return None


def _discover_repo(home: Path | None) -> Path | None:
    if home is None:
        return None
    repo = home / "hermes-agent"
    if (repo / "pyproject.toml").is_file() or (repo / "hermes_cli").is_dir():
        return repo
    return None


def _discover_python_kind(home: Path | None) -> str:
    executable = Path(sys.executable)
    parts = executable.parts
    if home is not None:
        try:
            executable.relative_to(home)
            if "installs" in parts:
                return "hermes-venv"
            if "tools" in parts:
                return "store"
        except ValueError:
            pass
    if sys.prefix != sys.base_prefix:
        return "fallback-venv"
    return "unknown"


def resolve_runtime(hermes_home: str | None = None, hermes_repo: str | None = None) -> HermesRuntime:
    home: Path | None
    if hermes_home:
        home = Path(hermes_home)
        if not _looks_like_home(home):
            home = home if home.exists() else _discover_home()
    else:
        home = _discover_home()

    repo: Path | None
    if hermes_repo:
        repo = Path(hermes_repo)
        if not repo.is_dir():
            repo = _discover_repo(home)
    else:
        repo = _discover_repo(home)

    return HermesRuntime(
        hermes_home=home,
        hermes_repo=repo,
        python=sys.executable,
        python_kind=_discover_python_kind(home),
    )
