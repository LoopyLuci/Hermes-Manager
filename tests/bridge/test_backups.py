from __future__ import annotations

from pathlib import Path

TOKEN = {"Authorization": "Bearer test-token"}


def _post(client, path: str, payload: dict | None = None):
    return client.post(f"/api/v1{path}", json=payload if payload is not None else {}, headers=TOKEN)


def test_list_backups_classifies_every_kind(client, hermes_home: Path):
    response = client.get("/api/v1/backups", headers=TOKEN)
    assert response.status_code == 200, response.text
    body = response.json()
    kinds = {item["kind"] for item in body["items"]}
    assert {"config", "full", "state-db", "snapshot"} <= kinds
    for item in body["items"]:
        assert item["path"].startswith(str(hermes_home))
        assert item["size"] >= 0
    snapshot_items = [item for item in body["items"] if item["kind"] == "snapshot"]
    assert snapshot_items[0]["name"] == "20260928_100000"


def test_delete_backup_rejects_live_files_and_escapes(client, hermes_home: Path):
    live = _post(client, "/backups/delete", {"path": str(hermes_home / "config.yaml")})
    assert live.status_code == 200
    assert live.json()["ok"] is False
    assert "not a backup location" in live.json()["detail"]
    assert (hermes_home / "config.yaml").is_file()

    outside = _post(client, "/backups/delete", {"path": str(hermes_home.parent / "outside.txt")})
    assert outside.status_code == 200
    assert outside.json()["ok"] is False
    assert "escapes" in outside.json()["detail"]


def test_delete_backup_removes_file(client, hermes_home: Path):
    target = hermes_home / "backups" / "hermes-backup-2026-08-25-101431-abc123.zip"
    assert target.is_file()
    response = _post(client, "/backups/delete", {"path": str(target)})
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert not target.exists()

    missing = _post(client, "/backups/delete", {"path": str(target)})
    assert missing.json()["ok"] is False
    assert "not found" in missing.json()["detail"]


def test_config_restore_preview_shows_flattened_diff(client, hermes_home: Path):
    backup = hermes_home / "backups" / "config" / "config.yaml.good.20260922-120000"
    response = _post(client, "/backups/config/preview", {"path": str(backup)})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    changes = {change["path"]: change for change in body["changes"]}
    assert changes["model"]["current"] == '"openrouter/test-model"'
    assert changes["model"]["next"] == '"openrouter/old-model"'
    assert changes["telemetry"]["current"] == "false"
    assert changes["telemetry"]["next"] == "true"


def test_config_restore_replaces_file_and_backs_up_current(client, hermes_home: Path):
    backup = hermes_home / "backups" / "config" / "config.yaml.good.20260922-120000"
    response = _post(client, "/backups/config/restore", {"path": str(backup)})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["created_backup"] and "backups" in body["created_backup"]

    doc = client.get("/api/v1/config", headers=TOKEN).json()
    assert doc["config"]["model"] == "openrouter/old-model"
    assert doc["config"]["telemetry"] is True


def test_config_restore_rejects_non_config_backups(client, hermes_home: Path):
    zip_backup = hermes_home / "backups" / "hermes-backup-2026-08-25-101431-abc123.zip"
    preview = _post(client, "/backups/config/preview", {"path": str(zip_backup)})
    assert preview.status_code == 200
    assert preview.json()["ok"] is False
    assert "not a config backup" in preview.json()["detail"]

    restore = _post(client, "/backups/config/restore", {"path": str(zip_backup)})
    assert restore.json()["ok"] is False
    assert (hermes_home / "config.yaml").read_text(encoding="utf-8").startswith("model: openrouter/test-model")


def test_create_backup_modes_refuse_without_deep_or_checkout(client):
    snapshot = _post(client, "/backups/create", {"mode": "snapshot"})
    assert snapshot.status_code == 200, snapshot.text
    assert snapshot.json()["ok"] is False
    assert "unavailable" in snapshot.json()["detail"]

    full = _post(client, "/backups/create", {"mode": "full"})
    assert full.status_code == 200
    assert full.json()["ok"] is False
    assert "checkout not found" in full.json()["detail"]
