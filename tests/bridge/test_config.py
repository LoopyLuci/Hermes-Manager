from __future__ import annotations

import json
from pathlib import Path

TOKEN = {"Authorization": "Bearer test-token"}


def _get(client, path: str, **params):
    response = client.get(f"/api/v1{path}", params=params, headers=TOKEN)
    assert response.status_code == 200, response.text
    return response.json()


def _post(client, path: str, payload: dict):
    response = client.post(f"/api/v1{path}", json=payload, headers=TOKEN)
    return response


def test_read_config_document(client):
    doc = _get(client, "/config")
    assert doc["source"] == "files"
    assert doc["path"].endswith("config.yaml")
    assert doc["config"]["model"] == "openrouter/test-model"
    assert doc["config"]["telemetry"] is False

    paths = {field["path"]: field for field in doc["fields"]}
    assert paths["terminal.backend"]["type"] == "string"
    assert paths["approvals.mode"]["type"] == "string"
    assert paths["telemetry"]["type"] == "boolean"
    assert paths["model"]["type"] == "string"


def test_read_config_missing_file(client, hermes_home: Path):
    (hermes_home / "config.yaml").unlink()
    doc = _get(client, "/config")
    assert doc["config"] == {}
    assert "not found" in (doc["detail"] or "")


def test_read_env_masks_secrets(client):
    report = _get(client, "/config/env")
    rows = {row["key"]: row for row in report["rows"]}
    key = rows["OPENROUTER_API_KEY"]
    assert key["is_set"] and key["is_secret"]
    assert key["value"] == "sk-o...7890"
    assert rows["WEB_TOOLS_DEBUG"]["value"] == "true"
    assert rows["WEB_TOOLS_DEBUG"]["is_secret"] is False


def test_diff_lists_changes_and_skips_noops(client):
    response = _post(
        client,
        "/config/diff",
        {
            "config": [
                {"path": "model", "value": "openrouter/other-model"},
                {"path": "telemetry", "value": False},
            ],
            "env": [
                {"key": "WEB_TOOLS_DEBUG", "value": "true"},
                {"key": "WEB_TOOLS_DEBUG", "value": "false"},
            ],
        },
    )
    assert response.status_code == 200, response.text
    changes = response.json()["changes"]
    assert [(c["kind"], c["path"], c["action"]) for c in changes] == [
        ("config", "model", "set"),
        ("env", "WEB_TOOLS_DEBUG", "set"),
    ]
    assert changes[0]["current"] == '"openrouter/test-model"'
    assert changes[1]["current"] == "true"


def test_diff_new_key_and_unset_path(client):
    response = _post(
        client,
        "/config/diff",
        {
            "config": [{"path": "session.reset", "value": "never"}],
            "env": [{"key": "GITHUB_TOKEN", "value": "ghp_1234567890abcd"}],
        },
    )
    assert response.status_code == 200, response.text
    changes = response.json()["changes"]
    assert changes[0]["current"] is None
    assert changes[1]["current"] is None
    assert changes[1]["next"] == "ghp_...abcd"


def test_diff_rejects_bad_paths_and_denied_env_keys(client):
    response = _post(client, "/config/diff", {"config": [{"path": "model; rm -rf", "value": "x"}]})
    assert response.status_code == 400
    assert "invalid config path" in response.json()["detail"]

    response = _post(client, "/config/diff", {"env": [{"key": "PATH", "value": "/tmp"}]})
    assert response.status_code == 400
    assert "managed by Hermes" in response.json()["detail"]


def test_apply_writes_config_and_env_with_backups(client, hermes_home: Path):
    response = _post(
        client,
        "/config/apply",
        {
            "config": [{"path": "model", "value": "openrouter/applied"}],
            "env": [
                {"key": "WEB_TOOLS_DEBUG", "value": "false"},
                {"key": "TELEGRAM_HOME_CHANNEL", "value": "-100123"},
            ],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert len(body["applied"]) == 3
    assert body["backups"] and all("backups" in entry for entry in body["backups"])

    config_text = (hermes_home / "config.yaml").read_text(encoding="utf-8")
    assert "openrouter/applied" in config_text
    env_text = (hermes_home / ".env").read_text(encoding="utf-8")
    assert "WEB_TOOLS_DEBUG=false" in env_text
    assert "TELEGRAM_HOME_CHANNEL=-100123" in env_text
    assert "# keep this comment" in env_text

    backup_dir = hermes_home / "backups" / "config"
    assert any(backup_dir.glob("config.yaml.mgr-*"))
    assert any(backup_dir.glob(".env.mgr-*"))

    doc = _get(client, "/config")
    assert doc["config"]["model"] == "openrouter/applied"


def test_apply_masks_secret_values(client):
    response = _post(
        client,
        "/config/apply",
        {"env": [{"key": "OPENROUTER_API_KEY", "value": "sk-or-v1-newsecretvalue99"}]},
    )
    assert response.status_code == 200, response.text
    change = response.json()["applied"][0]
    assert change["next"] == "sk-o...ue99"
    assert "newsecretvalue99" not in json.dumps(response.json())


def test_apply_refuses_redacted_placeholder(client):
    response = _post(
        client,
        "/config/apply",
        {"env": [{"key": "OPENROUTER_API_KEY", "value": "«redacted:sk-o...7890»"}]},
    )
    assert response.status_code == 400
    assert "redacted placeholder" in response.json()["detail"]


def test_apply_delete_operations(client, hermes_home: Path):
    response = _post(
        client,
        "/config/apply",
        {
            "config": [{"path": "approvals.mode", "op": "delete"}],
            "env": [{"key": "OPENROUTER_API_KEY", "op": "delete"}],
        },
    )
    assert response.status_code == 200, response.text
    doc = _get(client, "/config")
    assert "mode" not in doc["config"].get("approvals", {})
    env_text = (hermes_home / ".env").read_text(encoding="utf-8")
    assert "OPENROUTER_API_KEY" not in env_text
    assert "# keep this comment" in env_text


def test_apply_without_changes_is_a_noop(client, hermes_home: Path):
    before = (hermes_home / "config.yaml").read_bytes()
    response = _post(
        client,
        "/config/apply",
        {"config": [{"path": "model", "value": "openrouter/test-model"}]},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True and body["applied"] == [] and body["backups"] == []
    assert (hermes_home / "config.yaml").read_bytes() == before
