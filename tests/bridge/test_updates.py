from __future__ import annotations

TOKEN = {"Authorization": "Bearer test-token"}


def test_update_report_uses_receipt_fallback(client):
    response = client.get("/api/v1/updates", headers=TOKEN)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["source"] == "files"
    assert body["identity"]["version"] == "0.21.5"
    assert body["identity"]["sha"] == "bbbbbbbbbbbb2222222222"
    assert body["identity"]["source"] == "receipt"

    receipt = body["receipt"]
    assert receipt["outcome"] == "success"
    assert receipt["pre_sha"] == "aaaaaaaaaaaa1111111111"
    assert receipt["post_sha"] == "bbbbbbbbbbbb2222222222"
    assert receipt["steps_ok"] == 2
    assert receipt["steps_failed"] == 1
    assert body["running"] is False


def test_update_report_without_any_identity_source(client, hermes_home):
    (hermes_home / "logs" / "update_receipts" / "latest.json").unlink()
    (hermes_home / "gateway_state.json").unlink(missing_ok=True)
    response = client.get("/api/v1/updates", headers=TOKEN)
    assert response.status_code == 200
    body = response.json()
    assert body["identity"]["version"] is None
    assert body["receipt"] is None
    assert "unavailable" in (body["detail"] or "")


def test_update_check_unavailable_without_deep_layer(client):
    response = client.post("/api/v1/updates/check", headers=TOKEN)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["supported"] is False
    assert body["update_available"] is False
    assert body["detail"]


def test_update_apply_refuses_without_a_real_checkout(client):
    response = client.post("/api/v1/updates/apply", json={}, headers=TOKEN)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False
    assert "checkout not found" in body["detail"]
    assert body["pid"] is None


def test_receipt_loader_skips_non_update_receipts(client, hermes_home):
    import json
    import time

    receipt_dir = hermes_home / "logs" / "update_receipts"
    # latest.json now points at a plugin-check receipt (as happens in the wild)
    (receipt_dir / "latest.json").write_text(
        json.dumps({"kind": "plugin-check", "outcome": "ok", "steps": [], "schema": 1}),
        encoding="utf-8",
    )
    update_file = receipt_dir / "update_20260926_100000_4242_deadbeef.json"
    update_file.write_text(
        json.dumps(
            {
                "schema": 1,
                "outcome": "success",
                "argv": ["hermes", "update", "--yes"],
                "pre_update": {"sha": "cafe11112222"},
                "post_update": {"sha": "beef33334444"},
                "post_version": "0.22.0",
                "steps": [{"name": "pull", "ok": True}],
            }
        ),
        encoding="utf-8",
    )
    now = time.time()
    import os

    os.utime(update_file, (now, now))

    body = client.get("/api/v1/updates", headers=TOKEN).json()
    assert body["receipt"] is not None
    assert body["receipt"]["path"].endswith("update_20260926_100000_4242_deadbeef.json")
    assert body["receipt"]["outcome"] == "success"
    assert body["receipt"]["post_sha"] == "beef33334444"
    assert body["identity"]["version"] == "0.22.0"
    assert body["identity"]["sha"] == "beef33334444"


def test_receipt_loader_returns_none_when_only_plugin_receipts(client, hermes_home):
    import json

    receipt_dir = hermes_home / "logs" / "update_receipts"
    (receipt_dir / "latest.json").unlink()
    (receipt_dir / "pm_sync.json").write_text(
        json.dumps({"kind": "plugin-check", "outcome": "ok"}), encoding="utf-8"
    )
    body = client.get("/api/v1/updates", headers=TOKEN).json()
    assert body["receipt"] is None
