from __future__ import annotations

import sqlite3

from ..models import LayerStatus
from ..runtime import HermesRuntime
from ._timing import timed


@timed
def probe(runtime: HermesRuntime) -> LayerStatus:
    db_path = runtime.state_db
    if db_path is None:
        return LayerStatus(state="unavailable", detail="HERMES_HOME not resolved", origin="-")
    if not db_path.is_file():
        return LayerStatus(state="unavailable", detail=f"missing {db_path.name}", origin=str(db_path))

    try:
        connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2.0)
        try:
            count = connection.execute(
                "select count(*) from sqlite_master where type='table'"
            ).fetchone()
        finally:
            connection.close()
    except sqlite3.Error as exc:
        return LayerStatus(state="degraded", detail=f"unreadable: {exc}", origin=str(db_path))

    tables = count[0] if count else 0
    return LayerStatus(state="ready", detail=f"{tables} tables", origin=str(db_path))
