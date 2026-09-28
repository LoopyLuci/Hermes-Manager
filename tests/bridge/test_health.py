from __future__ import annotations

import pytest

TOKEN = "test-token"


def test_health_requires_bearer_token(client) -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 401
    assert response.json() == {"detail": "unauthorized"}


def test_health_accepts_wrong_token(client) -> None:
    response = client.get("/api/v1/health", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401


def test_health_reports_runtime_and_layers(client) -> None:
    response = client.get("/api/v1/health", headers={"Authorization": f"Bearer {TOKEN}"})
    assert response.status_code == 200
    body = response.json()
    assert body["app"] == "hermes-manager"
    assert body["hermes_repo"].endswith("hermes-agent")
    assert set(body["layers"]) == {"rest", "files", "db", "cli", "deep"}
    assert body["layers"]["files"]["state"] == "ready"
    assert body["layers"]["db"]["state"] == "ready"
    assert body["layers"]["db"]["detail"] == "2 tables"
    assert body["runtime"]["version"].startswith("3.")


def test_health_accepts_token_query_parameter(client) -> None:
    response = client.get("/api/v1/health", params={"token": TOKEN})
    assert response.status_code == 200


def test_sources_maps_domains_to_layers(client) -> None:
    response = client.get("/api/v1/sources", headers={"Authorization": f"Bearer {TOKEN}"})
    assert response.status_code == 200
    body = response.json()
    assert body["domains"]["logs"] == "files"
    assert body["domains"]["sessions"] in {"rest", "db"}
    assert body["domains"]["config"] in {"deep", "files"}
    assert set(body["domains"]) >= {"overview", "logs", "gateway", "sessions", "updates", "backups", "config", "tools"}


@pytest.mark.parametrize("layer", ["rest", "files", "db", "cli", "deep"])
def test_every_layer_probe_returns_valid_state(client, layer: str) -> None:
    response = client.get("/api/v1/health", headers={"Authorization": f"Bearer {TOKEN}"})
    status = response.json()["layers"][layer]
    assert status["state"] in {"ready", "degraded", "unavailable"}
    assert status["detail"]
    assert status["origin"]
    assert status["latency_ms"] is None or status["latency_ms"] >= 0
