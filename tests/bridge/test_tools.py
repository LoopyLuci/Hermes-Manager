from __future__ import annotations

from pathlib import Path

TOKEN = {"Authorization": "Bearer test-token"}


def _post(client, path: str, payload: dict | None = None):
    return client.post(f"/api/v1{path}", json=payload if payload is not None else {}, headers=TOKEN)


def test_mcp_list_reads_config(client):
    body = client.get("/api/v1/tools/mcp", headers=TOKEN).json()
    assert body["source"] == "files"
    servers = {server["name"]: server for server in body["servers"]}
    assert "webbuilder" in servers
    server = servers["webbuilder"]
    assert server["transport"] == "stdio"
    assert server["command"] == "node"
    assert server["args"] == ["C:/tools/cli.js"]
    assert server["enabled"] is True
    assert server["timeout"] == 120.0


def test_mcp_test_refuses_without_checkout_and_unknown_names(client):
    unknown = _post(client, "/tools/mcp/test", {"name": "nope"})
    assert unknown.status_code == 200
    assert unknown.json()["ok"] is False
    assert "not configured" in unknown.json()["detail"]

    bad = _post(client, "/tools/mcp/test", {"name": "bad name!"})
    assert bad.json()["ok"] is False
    assert "invalid" in bad.json()["detail"]

    refused = _post(client, "/tools/mcp/test", {"name": "webbuilder"})
    assert refused.status_code == 200
    assert refused.json()["ok"] is False
    assert "checkout not found" in refused.json()["detail"]


def test_skills_pagination_and_filter(client):
    body = client.get("/api/v1/tools/skills", headers=TOKEN).json()
    assert body["total"] == 3
    assert [entry["name"] for entry in body["skills"]] == ["alpha-skill", "beta-skill", "gamma-skill"]
    assert body["disabled_count"] == 1
    by_name = {entry["name"]: entry for entry in body["skills"]}
    assert by_name["alpha-skill"]["enabled"] is True
    assert by_name["alpha-skill"]["description"] == "Alpha tooling helper"
    assert by_name["beta-skill"]["enabled"] is False

    page = client.get("/api/v1/tools/skills", params={"offset": 1, "limit": 1}, headers=TOKEN).json()
    assert page["total"] == 3
    assert [entry["name"] for entry in page["skills"]] == ["beta-skill"]

    filtered = client.get("/api/v1/tools/skills", params={"q": "gamma"}, headers=TOKEN).json()
    assert filtered["total"] == 1
    assert filtered["skills"][0]["name"] == "gamma-skill"


def test_skills_toggle_updates_disabled_list(client, hermes_home: Path):
    disabled_before = client.get("/api/v1/tools/skills", params={"q": "beta"}, headers=TOKEN).json()["skills"][0]
    assert disabled_before["enabled"] is False

    enable_beta = _post(client, "/tools/skills/toggle", {"name": "beta-skill", "enable": True})
    assert enable_beta.status_code == 200, enable_beta.text
    assert enable_beta.json()["ok"] is True
    assert "beta-skill" not in enable_beta.json()["disabled"]

    disable_alpha = _post(client, "/tools/skills/toggle", {"name": "alpha-skill", "enable": False})
    assert disable_alpha.json()["ok"] is True
    assert "alpha-skill" in disable_alpha.json()["disabled"]

    state = {entry["name"]: entry["enabled"] for entry in client.get("/api/v1/tools/skills", headers=TOKEN).json()["skills"]}
    assert state == {"alpha-skill": False, "beta-skill": True, "gamma-skill": True}

    config_text = (hermes_home / "config.yaml").read_text(encoding="utf-8")
    assert "alpha-skill" in config_text
    assert "beta-skill" not in config_text
    assert any((hermes_home / "backups" / "config").glob("config.yaml.mgr-*"))


def test_skills_toggle_rejects_unknown_skill(client):
    response = _post(client, "/tools/skills/toggle", {"name": "ghost-skill", "enable": False})
    assert response.json()["ok"] is False
    assert "not found" in response.json()["detail"]


def test_cron_list_reads_jobs(client):
    body = client.get("/api/v1/tools/cron", headers=TOKEN).json()
    assert body["source"] == "files"
    assert len(body["jobs"]) == 1
    job = body["jobs"][0]
    assert job["id"] == "job-1"
    assert job["name"] == "nightly-sync"
    assert job["schedule"] == "every 30m"
    assert job["enabled"] is True
    assert job["last_status"] == "ok"
    assert job["no_agent"] is True


def test_cron_action_validates_and_refuses(client):
    unknown = _post(client, "/tools/cron/action", {"job_id": "ghost", "action": "pause"})
    assert unknown.json()["ok"] is False
    assert "not found" in unknown.json()["detail"]

    bad = _post(client, "/tools/cron/action", {"job_id": "job-1; rm", "action": "pause"})
    assert bad.json()["ok"] is False
    assert "invalid job id" in bad.json()["detail"]

    refused = _post(client, "/tools/cron/action", {"job_id": "job-1", "action": "run"})
    assert refused.status_code == 200
    assert refused.json()["ok"] is False
    assert "checkout not found" in refused.json()["detail"]


def test_plugins_lists_bundled_with_catalog_count(client):
    body = client.get("/api/v1/tools/plugins", headers=TOKEN).json()
    assert body["source"] == "files"
    names = {entry["name"]: entry for entry in body["plugins"]}
    assert {"browser", "kanban"} <= set(names)
    assert "__pycache__" not in names
    assert names["browser"]["source"] == "bundled"
    assert names["browser"]["enabled"] is True
    assert body["catalog_count"] == 2


def test_local_models_reports_gguf_inventory(client):
    body = client.get("/api/v1/tools/models", headers=TOKEN).json()
    assert body["source"] == "files"
    gguf = {entry["name"]: entry for entry in body["gguf"]}
    assert "test-model.gguf" in gguf
    assert gguf["test-model.gguf"]["size"] == 9
    if body["ollama_running"]:
        assert isinstance(body["ollama_models"], list)
