from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from hermes_manager_bridge.services import gateway as gateway_service


def _write_state(home: Path, **extra) -> dict:
    doc = {
        "pid": os.getpid(),
        "kind": "gateway",
        "gateway_state": "running",
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "active_agents": 2,
        "active_work": 1,
        "served_profiles": ["default"],
        "code_sha": "abc1234",
        "code_version": "0.9.9",
        "hermes_home": str(home),
    }
    doc.update(extra)
    (home / "gateway_state.json").write_text(json.dumps(doc), encoding="utf-8")
    return doc


def test_pid_alive_probes_safely():
    assert gateway_service.pid_alive(os.getpid()) is True
    assert gateway_service.pid_alive(None) is False
    assert gateway_service.pid_alive(0) is False


def test_gateway_status_stopped_without_state(client):
    response = client.get("/api/v1/gateway", headers={"Authorization": "Bearer test-token"})
    assert response.status_code == 200
    body = response.json()
    assert body["running"] is False
    assert body["source"] == "files"
    assert body["state"]["state"] == "stopped"
    assert body["drain_requested"] is False


def test_gateway_status_running_from_state_file(client, hermes_home):
    _write_state(hermes_home)
    response = client.get("/api/v1/gateway", headers={"Authorization": "Bearer test-token"})
    body = response.json()
    assert body["running"] is True
    assert body["state"]["state"] == "running"
    assert body["state"]["pid"] == os.getpid()
    assert body["identity"]["code_sha"] == "abc1234"
    assert body["source"] in ("deep", "files")


def test_gateway_status_reports_draining(client, hermes_home):
    _write_state(hermes_home, gateway_state="draining")
    (hermes_home / ".drain_request.json").write_text(json.dumps({"requested_at": time.time()}), encoding="utf-8")
    response = client.get("/api/v1/gateway", headers={"Authorization": "Bearer test-token"})
    body = response.json()
    assert body["drain_requested"] is True
    assert body["state"]["state"] == "draining"


def test_drain_roundtrip(client, hermes_home):
    headers = {"Authorization": "Bearer test-token"}
    marker = hermes_home / ".drain_request.json"

    response = client.post("/api/v1/gateway/drain", json={"action": "drain"}, headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["drain_requested"] is True
    assert marker.is_file()

    status = client.get("/api/v1/gateway", headers=headers).json()
    assert status["drain_requested"] is True

    response = client.post("/api/v1/gateway/drain", json={"action": "cancel"}, headers=headers)
    assert response.status_code == 200
    assert response.json()["drain_requested"] is False
    assert not marker.exists()


def test_lifecycle_spawns_detached_command(client, hermes_home, monkeypatch):
    headers = {"Authorization": "Bearer test-token"}

    def fake_command(runtime, action):
        return [sys.executable, "-c", "print('spawned')"]

    monkeypatch.setattr(gateway_service, "build_lifecycle_command", fake_command)
    response = client.post("/api/v1/gateway/lifecycle", json={"action": "restart"}, headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["pid"] and body["pid"] > 0
    assert body["log"] == "gateway-restart.log"

    log_path = hermes_home / "logs" / "gateway-restart.log"
    for _ in range(50):
        if log_path.is_file() and "manager: hermes gateway restart" in log_path.read_text(encoding="utf-8", errors="replace"):
            break
        time.sleep(0.05)
    assert log_path.is_file()
    assert "manager: hermes gateway restart" in log_path.read_text(encoding="utf-8", errors="replace")


def test_lifecycle_without_cli_reports_error(client, monkeypatch):
    headers = {"Authorization": "Bearer test-token"}
    monkeypatch.setattr(gateway_service, "build_lifecycle_command", lambda runtime, action: None)
    response = client.post("/api/v1/gateway/lifecycle", json={"action": "start"}, headers=headers)
    body = response.json()
    assert body["ok"] is False
    assert "no hermes CLI" in body["detail"]


def test_lifecycle_rejects_unknown_action(client):
    response = client.post(
        "/api/v1/gateway/lifecycle",
        json={"action": "explode"},
        headers={"Authorization": "Bearer test-token"},
    )
    assert response.status_code == 422


def test_fleet_falls_back_to_state_file(client, hermes_home):
    _write_state(hermes_home)
    response = client.get("/api/v1/gateway/fleet", headers={"Authorization": "Bearer test-token"})
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "files"
    assert body["rows"], "expected at least the state-file row"
    row = body["rows"][0]
    assert row["pid"] == os.getpid()
    assert row["state"] in ("current", "down", "restart_pending")


def test_processes_lists_gateway_entry(client, hermes_home):
    _write_state(hermes_home)
    response = client.get("/api/v1/processes", headers={"Authorization": "Bearer test-token"})
    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "files"
    kinds = {item["kind"] for item in body["processes"]}
    assert "gateway" in kinds
    gateway_items = [item for item in body["processes"] if item["kind"] == "gateway"]
    assert gateway_items[0]["pid"] == os.getpid()


def test_gateway_requires_token(client):
    assert client.get("/api/v1/gateway").status_code == 401
    assert client.get("/api/v1/gateway/fleet").status_code == 401
    assert client.post("/api/v1/gateway/lifecycle", json={"action": "start"}).status_code == 401
