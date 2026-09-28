"""How other programs find a running bridge: a discovery file with its address, token and pid.

When the bridge starts with ``--discovery`` (Hermes Manager always passes it; a headless bridge started by another
program does too) it writes ``<home>/control.json``; ``<home>`` is ``$HM_HOME`` or ``~/.hermes-manager``. A client
reads it, checks that the pid that answers ``/api/v1/ping`` is the one that wrote it, and uses the token. The file is
removed when that bridge stops. Only the user who owns the home folder can read it.
"""
from __future__ import annotations

import json
import os
import secrets
import time
import urllib.request
from pathlib import Path
from typing import Any, Optional


def home() -> Path:
    p = Path(os.environ.get("HM_HOME") or Path.home() / ".hermes-manager")
    p.mkdir(parents=True, exist_ok=True)
    return p


def discovery_path() -> Path:
    return home() / "control.json"


def new_token() -> str:
    return secrets.token_hex(32)


def write(url: str, token: str, *, version: str, gui: bool = False, owner: str = "bridge") -> None:
    data = {"url": url, "token": token, "pid": os.getpid(), "version": version, "gui": gui, "owner": owner,
            "started": time.time()}
    tmp = discovery_path().with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    tmp.replace(discovery_path())


def update(**fields: Any) -> None:
    d = read()
    if d and d.get("pid") == os.getpid():
        d.update(fields)
        write(d["url"], d["token"], version=d.get("version", ""), gui=bool(d.get("gui")), owner=d.get("owner", "bridge"))


def read() -> Optional[dict]:
    try:
        return json.loads(discovery_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def remove() -> None:
    d = read()
    if d and d.get("pid") == os.getpid():
        discovery_path().unlink(missing_ok=True)


def alive(timeout: float = 2.0) -> Optional[dict]:
    """The discovery record of a bridge that is really running (the pid that answers is the one that wrote it)."""
    d = read()
    if not d:
        return None
    try:
        with urllib.request.urlopen(d["url"] + "/api/v1/ping", timeout=timeout) as r:
            ping = json.loads(r.read())
    except Exception:  # noqa: BLE001
        return None
    return d if ping.get("pid") == d.get("pid") else None
