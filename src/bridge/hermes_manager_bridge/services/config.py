from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from typing import Any

from ..models import (
    ChangePreview,
    ConfigApplyResult,
    ConfigDiff,
    ConfigDocument,
    ConfigEditRequest,
    ConfigField,
    EnvReport,
    EnvRow,
    SourceLayer,
)
from ..runtime import HermesRuntime

CONFIG_LOCK = threading.RLock()

_SECRET_PATTERN = re.compile(r"(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)", re.IGNORECASE)
_ENV_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_PATH_SEGMENT_PATTERN = re.compile(r"^[A-Za-z0-9_\-]+$")
_ENV_DENYLIST = frozenset({"PATH", "LD_PRELOAD", "PYTHONPATH", "HERMES_HOME", "HERMES_YOLO_MODE"})
_REDACTED_PLACEHOLDER = ("«redacted", "***")
_BACKUP_KEEP = 5


class ConfigError(Exception):
    """A user-facing configuration problem (bad path, unreadable file, ...)."""


# --------------------------------------------------------------------------- yaml


def _load_yaml_document(path: Path) -> tuple[Any, str]:
    """Parse *path* with ruamel (comment-preserving) or PyYAML.

    Returns ``(data, flavour)`` where flavour is ``"ruamel"`` or ``"pyyaml"``.
    """
    if not path.is_file():
        raise ConfigError(f"file not found: {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"cannot read {path.name}: {exc}") from exc
    if not text.strip():
        return {}, "pyyaml"
    try:
        from ruamel.yaml import YAML  # type: ignore[import-not-found]
    except ImportError:
        YAML = None  # type: ignore[assignment]
    if YAML is not None:
        try:
            data = YAML(typ="rt").load(text)
        except Exception as exc:  # noqa: BLE001 - ruamel raises many error types
            raise ConfigError(f"{path.name} is not parseable: {exc}") from exc
        if data is None:
            return {}, "ruamel"
        if not isinstance(data, dict):
            raise ConfigError(f"{path.name} must contain a mapping at the top level")
        return data, "ruamel"
    try:
        import yaml as pyyaml  # type: ignore[import-not-found]
    except ImportError as exc:
        raise ConfigError("no YAML library available (need ruamel.yaml or PyYAML)") from exc
    try:
        data = pyyaml.safe_load(text)
    except pyyaml.YAMLError as exc:
        raise ConfigError(f"{path.name} is not parseable: {exc}") from exc
    if data is None:
        return {}, "pyyaml"
    if not isinstance(data, dict):
        raise ConfigError(f"{path.name} must contain a mapping at the top level")
    return data, "pyyaml"


def _dump_yaml_document(data: Any, flavour: str) -> str:
    if flavour == "ruamel":
        from ruamel.yaml import YAML  # type: ignore[import-not-found]

        buffer = StringIO()
        yaml = YAML()
        yaml.default_flow_style = False
        yaml.dump(data, buffer)
        return buffer.getvalue()
    import yaml as pyyaml  # type: ignore[import-not-found]

    return pyyaml.safe_dump(
        data,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=4096,
    )


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f"{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


# ------------------------------------------------------------------------- paths


def _split_path(path: str) -> list[str]:
    if not path or len(path) > 300:
        raise ConfigError(f"invalid config path: {path!r}")
    parts = path.split(".")
    if any(not part or not _PATH_SEGMENT_PATTERN.match(part) for part in parts):
        raise ConfigError(f"invalid config path: {path!r}")
    return parts


def _walk_get(data: Any, parts: list[str]) -> tuple[bool, Any]:
    current = data
    for part in parts:
        if isinstance(current, dict):
            if part not in current:
                return False, None
            current = current[part]
        elif isinstance(current, list):
            try:
                current = current[int(part)]
            except (ValueError, IndexError):
                return False, None
        else:
            return False, None
    return True, current


def _walk_set(data: Any, parts: list[str], value: Any) -> None:
    current = data
    for part in parts[:-1]:
        if isinstance(current, dict):
            if part not in current or not isinstance(current[part], (dict, list)):
                current[part] = {}
            current = current[part]
        elif isinstance(current, list):
            try:
                position = int(part)
            except ValueError as exc:
                raise ConfigError(f"cannot descend into list with segment {part!r}") from exc
            if position < 0 or position >= len(current):
                raise ConfigError(f"list index out of range: {part}")
            if not isinstance(current[position], (dict, list)):
                current[position] = {}
            current = current[position]
        else:
            raise ConfigError(f"cannot set {'.'.join(parts)} under a scalar value")
    last = parts[-1]
    if isinstance(current, dict):
        current[last] = value
    elif isinstance(current, list):
        try:
            position = int(last)
        except ValueError as exc:
            raise ConfigError(f"cannot index list with segment {last!r}") from exc
        if position < 0 or position >= len(current):
            raise ConfigError(f"list index out of range: {last}")
        current[position] = value
    else:
        raise ConfigError(f"cannot set {'.'.join(parts)} under a scalar value")


def _walk_delete(data: Any, parts: list[str]) -> bool:
    parent = data
    for part in parts[:-1]:
        if isinstance(parent, dict):
            parent = parent.get(part)
        elif isinstance(parent, list):
            try:
                parent = parent[int(part)]
            except (ValueError, IndexError):
                return False
        else:
            return False
    last = parts[-1]
    if isinstance(parent, dict):
        if last in parent:
            del parent[last]
            return True
        return False
    if isinstance(parent, list):
        try:
            position = int(last)
            parent.pop(position)
            return True
        except (ValueError, IndexError):
            return False
    return False


def _infer_type(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "object"
    return "string"


def _flatten_fields(prefix: str, data: Any, out: dict[str, str]) -> None:
    if isinstance(data, dict):
        if not data and prefix:
            out.setdefault(prefix, "object")
        for key, value in data.items():
            key_text = str(key)
            path = f"{prefix}.{key_text}" if prefix else key_text
            _flatten_fields(path, value, out)
    elif prefix:
        out[prefix] = _infer_type(data)


# -------------------------------------------------------------------------- env


def mask_secret(value: str) -> str:
    if len(value) < 12:
        return "***"
    return f"{value[:4]}...{value[-4:]}"


def is_secret_key(key: str) -> bool:
    return bool(_SECRET_PATTERN.search(key))


def _unquote_env_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def _format_env_value(value: str) -> str:
    if value == "":
        return ""
    if re.search(r"[\s#\"']", value):
        escaped = (
            value.replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        )
        return f'"{escaped}"'
    return value


def _parse_env(lines: list[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        key, _, raw = stripped.partition("=")
        key = key.strip()
        if _ENV_KEY_PATTERN.match(key):
            values[key] = _unquote_env_value(raw)
    return values


def _line_is_key(line: str, key: str) -> bool:
    stripped = line.strip()
    if stripped.startswith("export "):
        stripped = stripped[7:].lstrip()
    if "=" not in stripped:
        return False
    candidate, _, _ = stripped.partition("=")
    return candidate.strip() == key


def _rewrite_env_lines(lines: list[str], changes: list[tuple[str, str, Any]]) -> list[str]:
    result = list(lines)
    for key, op, value in changes:
        if op == "delete":
            result = [line for line in result if not _line_is_key(line, key)]
            continue
        assert isinstance(value, str)
        formatted = f"{key}={_format_env_value(value)}"
        position = next((index for index, line in enumerate(result) if _line_is_key(line, key)), None)
        result = [line for line in result if not _line_is_key(line, key)]
        if position is None:
            if result and result[-1].strip():
                result.append("")
            result.append(formatted)
        else:
            result.insert(position, formatted)
    return result


def _read_env_values(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    return _parse_env(lines)


# ------------------------------------------------------------------- deep layer


def _deep_defaults(runtime: HermesRuntime) -> dict[str, Any] | None:
    if runtime.hermes_repo is None:
        return None
    try:
        from hermes_cli.config_defaults import DEFAULT_CONFIG  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001 - deep layer is best effort
        return None
    return DEFAULT_CONFIG if isinstance(DEFAULT_CONFIG, dict) else None


def _deep_env_catalog(runtime: HermesRuntime) -> dict[str, dict[str, Any]]:
    if runtime.hermes_repo is None:
        return {}
    try:
        from hermes_cli.config_defaults import OPTIONAL_ENV_VARS  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001 - deep layer is best effort
        return {}
    if not isinstance(OPTIONAL_ENV_VARS, dict):
        return {}
    return {str(key): value for key, value in OPTIONAL_ENV_VARS.items() if isinstance(value, dict)}


def _build_fields(config: dict[str, Any], defaults: dict[str, Any] | None) -> list[ConfigField]:
    types: dict[str, str] = {}
    if defaults:
        _flatten_fields("", defaults, types)
    _flatten_fields("", config, types)
    fields = [
        ConfigField(
            path=path,
            type=field_type,
            category=path.split(".", 1)[0],
        )
        for path, field_type in sorted(types.items())
    ]
    return fields


# --------------------------------------------------------------------- read side


def read_config(runtime: HermesRuntime) -> ConfigDocument:
    path = runtime.config_file
    if path is None:
        return ConfigDocument(source="files", path="", detail="HERMES_HOME not resolved")
    if not path.is_file():
        return ConfigDocument(source="files", path=str(path), detail="config.yaml not found")
    try:
        data, _flavour = _load_yaml_document(path)
    except ConfigError as exc:
        return ConfigDocument(source="files", path=str(path), detail=str(exc))
    defaults = _deep_defaults(runtime)
    source: SourceLayer = "deep" if defaults is not None else "files"
    return ConfigDocument(
        source=source,
        path=str(path),
        config=data,
        defaults=defaults,
        fields=_build_fields(data, defaults),
        detail=None,
    )


def read_env(runtime: HermesRuntime) -> EnvReport:
    path = runtime.env_file
    catalog = _deep_env_catalog(runtime)
    source: SourceLayer = "deep" if catalog else "files"
    if path is None:
        return EnvReport(source="files", path="", detail="HERMES_HOME not resolved")
    values = _read_env_values(path)
    keys = sorted(set(values) | set(catalog))
    rows: list[EnvRow] = []
    for key in keys:
        meta = catalog.get(key, {})
        secret = bool(meta.get("password")) or is_secret_key(key)
        is_set = key in values
        display = mask_secret(values[key]) if (is_set and secret) else (values[key] if is_set else None)
        rows.append(
            EnvRow(
                key=key,
                value=display,
                is_set=is_set,
                is_secret=secret,
                category=str(meta.get("category")) if meta.get("category") else None,
                description=str(meta.get("description")) if meta.get("description") else None,
            )
        )
    detail = None if path.is_file() else ".env not found (shows catalog defaults)"
    return EnvReport(source=source, path=str(path), rows=rows, detail=detail)


# ------------------------------------------------------------------ diff / apply


def _validate_env_change(key: str, value: Any, op: str) -> str:
    if not _ENV_KEY_PATTERN.match(key):
        raise ConfigError(f"invalid env key: {key!r}")
    if key.upper() in _ENV_DENYLIST:
        raise ConfigError(f"{key} is managed by Hermes and cannot be edited here")
    if op == "delete":
        return key
    if not isinstance(value, str):
        raise ConfigError(f"{key}: value must be a string")
    lowered = value.lower()
    if any(token in lowered for token in _REDACTED_PLACEHOLDER):
        raise ConfigError(f"{key}: refusing to write a redacted placeholder")
    return key


def _plan(runtime: HermesRuntime, body: ConfigEditRequest) -> tuple[list[ChangePreview], dict[str, list]]:
    previews: list[ChangePreview] = []
    plan: dict[str, list] = {"config": [], "env": []}

    if body.config:
        path = runtime.config_file
        if path is None or not path.is_file():
            raise ConfigError("config.yaml not found")
        data, _flavour = _load_yaml_document(path)
        for change in body.config:
            parts = _split_path(change.path)
            found, current = _walk_get(data, parts)
            if change.op == "delete":
                if not found:
                    continue
                previews.append(
                    ChangePreview(
                        kind="config",
                        path=change.path,
                        action="delete",
                        current=json.dumps(current, ensure_ascii=False, default=str),
                        next=None,
                        type=_infer_type(current),
                    )
                )
                plan["config"].append((parts, "delete", None))
            else:
                if found and current == change.value:
                    continue
                field_type = _infer_type(change.value) if not found else _infer_type(current)
                previews.append(
                    ChangePreview(
                        kind="config",
                        path=change.path,
                        action="set",
                        current=json.dumps(current, ensure_ascii=False, default=str) if found else None,
                        next=json.dumps(change.value, ensure_ascii=False, default=str),
                        type=field_type,
                    )
                )
                plan["config"].append((parts, "set", change.value))

    if body.env:
        path = runtime.env_file
        if path is None:
            raise ConfigError("HERMES_HOME not resolved")
        values = _read_env_values(path)
        for change in body.env:
            key = _validate_env_change(change.key, change.value, change.op)
            secret = is_secret_key(key)
            found = key in values
            if change.op == "delete":
                if not found:
                    continue
                previews.append(
                    ChangePreview(
                        kind="env",
                        path=key,
                        action="delete",
                        current=mask_secret(values[key]) if secret else values[key],
                        next=None,
                        type="secret" if secret else "string",
                    )
                )
                plan["env"].append((key, "delete", None))
            else:
                assert isinstance(change.value, str)
                if found and values[key] == change.value:
                    continue
                previews.append(
                    ChangePreview(
                        kind="env",
                        path=key,
                        action="set",
                        current=mask_secret(values[key]) if (found and secret) else (values[key] if found else None),
                        next=mask_secret(change.value) if secret else change.value,
                        type="secret" if secret else "string",
                    )
                )
                plan["env"].append((key, "set", change.value))

    return previews, plan


def compute_diff(runtime: HermesRuntime, body: ConfigEditRequest) -> ConfigDiff:
    with CONFIG_LOCK:
        previews, _plan_data = _plan(runtime, body)
        return ConfigDiff(source="files", changes=previews, detail=None)


def _backup(path: Path) -> Path | None:
    if not path.is_file():
        return None
    backup_dir = path.parent / "backups" / "config"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    target = backup_dir / f"{path.name}.mgr-{stamp}"
    counter = 1
    while target.exists():
        target = backup_dir / f"{path.name}.mgr-{stamp}-{counter}"
        counter += 1
    shutil.copy2(path, target)
    prunable = sorted(backup_dir.glob(f"{path.name}.mgr-*"), key=lambda item: item.stat().st_mtime, reverse=True)
    for stale in prunable[_BACKUP_KEEP:]:
        try:
            stale.unlink()
        except OSError:
            pass
    return target


def apply_edits(runtime: HermesRuntime, body: ConfigEditRequest) -> ConfigApplyResult:
    with CONFIG_LOCK:
        try:
            previews, plan = _plan(runtime, body)
        except ConfigError:
            raise
        if not previews:
            return ConfigApplyResult(ok=True, applied=[], backups=[], warnings=[], detail="no changes")

        backups: list[str] = []
        warnings: list[str] = []

        if plan["config"]:
            path = runtime.config_file
            assert path is not None
            data, flavour = _load_yaml_document(path)
            for parts, op, value in plan["config"]:
                if op == "delete":
                    _walk_delete(data, parts)
                else:
                    _walk_set(data, parts, value)
            text = _dump_yaml_document(data, flavour)
            backup = _backup(path)
            if backup:
                backups.append(str(backup))
            _atomic_write(path, text)
            if flavour == "pyyaml":
                warnings.append(
                    "ruamel.yaml unavailable: config.yaml was rewritten and comments/formatting may have been normalized"
                )

        if plan["env"]:
            path = runtime.env_file
            assert path is not None
            lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
            new_lines = _rewrite_env_lines(lines, plan["env"])
            text = "\n".join(new_lines) + ("\n" if new_lines else "")
            backup = _backup(path)
            if backup:
                backups.append(str(backup))
            _atomic_write(path, text)

        return ConfigApplyResult(
            ok=True,
            applied=previews,
            backups=backups,
            warnings=warnings,
            detail=None,
        )
