from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

BRIDGE_SRC = Path(__file__).resolve().parents[2] / "src" / "bridge"
if str(BRIDGE_SRC) not in sys.path:
    sys.path.insert(0, str(BRIDGE_SRC))

from hermes_manager_bridge.runtime import resolve_runtime  # noqa: E402
from hermes_manager_bridge.server import create_app  # noqa: E402

TOKEN = "test-token"


@pytest.fixture()
def hermes_home(tmp_path: Path) -> Path:
    home = tmp_path / "hermes"
    logs = home / "logs"
    logs.mkdir(parents=True)
    (logs / "agent.log").write_text("2026-09-26 10:00:00 INFO agent: up\n", encoding="utf-8")
    (logs / "errors.log").write_text("", encoding="utf-8")

    repo = home / "hermes-agent"
    (repo / "hermes_cli").mkdir(parents=True)
    (repo / "pyproject.toml").write_text("[project]\nname = 'hermes-agent'\n", encoding="utf-8")

    (home / "config.yaml").write_text(
        "model: openrouter/test-model\n"
        "terminal:\n"
        "  backend: vte\n"
        "approvals:\n"
        "  mode: auto\n"
        "telemetry: false\n"
        "mcp_servers:\n"
        "  webbuilder:\n"
        "    command: node\n"
        "    args:\n"
        "      - C:/tools/cli.js\n"
        "    timeout: 120\n"
        "skills:\n"
        "  disabled:\n"
        "    - beta-skill\n",
        encoding="utf-8",
    )
    (home / ".env").write_text(
        "OPENROUTER_API_KEY=sk-or-v1-abcdef1234567890\n"
        "WEB_TOOLS_DEBUG=true\n"
        "# keep this comment\n",
        encoding="utf-8",
    )

    receipt_dir = home / "logs" / "update_receipts"
    receipt_dir.mkdir(parents=True)
    (receipt_dir / "latest.json").write_text(
        json.dumps(
            {
                "outcome": "success",
                "started_at": "2026-09-26T10:00:00Z",
                "finished_at": "2026-09-26T10:02:00Z",
                "pre_update": {"sha": "aaaaaaaaaaaa1111111111"},
                "post_update": {"sha": "bbbbbbbbbbbb2222222222"},
                "post_version": "0.21.5",
                "steps": [
                    {"name": "pull", "ok": True},
                    {"name": "deps", "ok": True},
                    {"name": "verify", "ok": False},
                ],
            }
        ),
        encoding="utf-8",
    )

    backups = home / "backups"
    (backups / "config").mkdir(parents=True)
    (backups / "config" / "config.yaml.good.20260922-120000").write_text(
        "model: openrouter/old-model\ntelemetry: true\n", encoding="utf-8"
    )
    (backups / "hermes-backup-2026-08-25-101431-abc123.zip").write_bytes(b"PK\x03\x04fake-zip")
    (home / "state.db.pre-update-emergency-2026-09-19T23-09-42-292Z.bak").write_bytes(b"sqlite-fake")
    snapshot = home / "state-snapshots" / "20260928_100000"
    snapshot.mkdir(parents=True)
    (snapshot / "config.yaml").write_text("model: snapshot-model\n", encoding="utf-8")

    for skill_name, description in (
        ("alpha-skill", "Alpha tooling helper"),
        ("beta-skill", "Beta helper"),
        ("gamma-skill", "Gamma helper"),
    ):
        skill_dir = home / "skills" / skill_name
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            f"---\nname: {skill_name}\ndescription: {description}\n---\n\n# {skill_name}\n",
            encoding="utf-8",
        )

    cron_dir = home / "cron"
    cron_dir.mkdir(parents=True)
    (cron_dir / "jobs.json").write_text(
        json.dumps(
            {
                "updated_at": "2026-09-28T10:00:00Z",
                "jobs": [
                    {
                        "id": "job-1",
                        "name": "nightly-sync",
                        "schedule": {"kind": "interval", "minutes": 30, "display": "every 30m"},
                        "schedule_display": "every 30m",
                        "enabled": True,
                        "state": "scheduled",
                        "last_status": "ok",
                        "last_run_at": "2026-09-28T09:30:00Z",
                        "next_run_at": "2026-09-28T10:00:00Z",
                        "no_agent": True,
                        "script": "sync.py",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    for plugin_name in ("browser", "kanban"):
        (repo / "plugins" / plugin_name).mkdir(parents=True, exist_ok=True)
    (repo / "plugins" / "__pycache__").mkdir(parents=True, exist_ok=True)
    catalog = repo / "plugin-catalog"
    catalog.mkdir(parents=True, exist_ok=True)
    (catalog / "one.yaml").write_text("name: one\n", encoding="utf-8")
    (catalog / "two.yaml").write_text("name: two\n", encoding="utf-8")

    (home / "models").mkdir()
    (home / "models" / "test-model.gguf").write_bytes(b"GGUF-fake")

    connection = sqlite3.connect(home / "state.db")
    connection.executescript(
        """
        create table sessions (
            id text primary key,
            title text,
            source text,
            model text,
            started_at text,
            last_activity_at text,
            ended_at text,
            message_count integer,
            tool_call_count integer,
            input_tokens integer,
            output_tokens integer,
            archived integer default 0,
            profile_name text
        );
        create table messages (
            id integer primary key,
            session_id text not null,
            role text not null,
            content text,
            tool_name text,
            tool_call_id text,
            timestamp text,
            display_kind text,
            active integer default 1,
            compacted integer default 0
        );
        insert into sessions (id, title, source, model, started_at, last_activity_at, message_count, archived, profile_name)
        values ('sess-alpha', 'Alpha debugging', 'desktop', 'test/model-a', '2026-09-20T10:00:00Z', '2026-09-26T09:00:00Z', 4, 0, 'default');
        insert into sessions (id, title, source, model, started_at, last_activity_at, message_count, archived, profile_name)
        values ('sess-beta', 'Beta notes', 'cli', 'test/model-b', '2026-09-21T11:00:00Z', '2026-09-25T08:00:00Z', 2, 1, 'default');
        insert into messages (id, session_id, role, content, timestamp) values
            (1, 'sess-alpha', 'user', 'hello there', '2026-09-20T10:00:01Z'),
            (2, 'sess-alpha', 'assistant', 'hi! how can I help?', '2026-09-20T10:00:05Z'),
            (3, 'sess-alpha', 'assistant', '', '2026-09-20T10:00:06Z'),
            (4, 'sess-beta', 'user', 'second session ping', '2026-09-21T11:00:01Z');
        insert into messages (id, session_id, role, content, timestamp, active) values
            (5, 'sess-alpha', 'assistant', 'old compacted line', '2026-09-20T09:59:00Z', 0);
        """
    )
    connection.commit()
    connection.close()

    return home


@pytest.fixture()
def runtime(hermes_home: Path):
    return resolve_runtime(hermes_home=str(hermes_home), hermes_repo=str(hermes_home / "hermes-agent"))


@pytest.fixture()
def app(runtime):
    return create_app(runtime=runtime, token=TOKEN)


@pytest.fixture()
def client(app):
    from fastapi.testclient import TestClient

    with TestClient(app) as instance:
        yield instance
