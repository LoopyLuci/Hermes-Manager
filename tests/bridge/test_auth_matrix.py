from __future__ import annotations

import pytest

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}

# Every route the bridge exposes, with a body that is valid enough that a 401
# can only come from authentication (never from request validation).
ROUTES: list[tuple[str, str, object | None]] = [
    ("GET", "/api/v1/health", None),
    ("GET", "/api/v1/sources", None),
    ("GET", "/api/v1/gateway", None),
    ("GET", "/api/v1/gateway/fleet", None),
    ("GET", "/api/v1/processes", None),
    ("GET", "/api/v1/logs", None),
    ("GET", "/api/v1/logs/tail?file=agent.log", None),
    ("GET", "/api/v1/sessions", None),
    ("GET", "/api/v1/sessions/sess-alpha/messages", None),
    ("GET", "/api/v1/config", None),
    ("GET", "/api/v1/config/env", None),
    ("GET", "/api/v1/updates", None),
    ("POST", "/api/v1/updates/check", {}),
    ("POST", "/api/v1/updates/apply", {"yes": True}),
    ("GET", "/api/v1/backups", None),
    ("POST", "/api/v1/backups/create", {"mode": "snapshot"}),
    ("POST", "/api/v1/backups/delete", {"path": "backups/x.zip"}),
    ("POST", "/api/v1/backups/config/preview", {"path": "backups/x.yaml"}),
    ("POST", "/api/v1/backups/config/restore", {"path": "backups/x.yaml"}),
    ("GET", "/api/v1/tools/mcp", None),
    ("POST", "/api/v1/tools/mcp/test", {"name": "webbuilder"}),
    ("GET", "/api/v1/tools/skills", None),
    ("POST", "/api/v1/tools/skills/toggle", {"name": "alpha-skill", "disabled": False}),
    ("GET", "/api/v1/tools/cron", None),
    ("POST", "/api/v1/tools/cron/action", {"job_id": "job-1", "action": "run"}),
    ("GET", "/api/v1/tools/plugins", None),
    ("GET", "/api/v1/tools/models", None),
    ("POST", "/api/v1/config/diff", {"config": [], "env": []}),
    ("POST", "/api/v1/config/apply", {"config": [], "env": []}),
    ("POST", "/api/v1/gateway/lifecycle", {"action": "restart"}),
    ("POST", "/api/v1/gateway/drain", {"minutes": 5}),
    ("POST", "/api/v1/chat", {"text": "hi"}),
    ("POST", "/api/v1/chat/abort", {"chat_id": "chat-1"}),
]


def _request(client, method: str, path: str, body: object | None):
    if body is None:
        return client.request(method, path)
    return client.request(method, path, json=body)


def _request_with_headers(client, method: str, path: str, body: object | None, headers):
    if body is None:
        return client.request(method, path, headers=headers)
    return client.request(method, path, json=body, headers=headers)


@pytest.mark.parametrize("method,path,body", ROUTES, ids=[f"{m} {p.split('?')[0]}" for m, p, _ in ROUTES])
def test_route_rejects_missing_token(client, method: str, path: str, body: object | None) -> None:
    response = _request(client, method, path, body)
    assert response.status_code == 401, f"{method} {path} returned {response.status_code}"


@pytest.mark.parametrize("method,path,body", ROUTES, ids=[f"{m} {p.split('?')[0]}" for m, p, _ in ROUTES])
def test_route_rejects_wrong_token(client, method: str, path: str, body: object | None) -> None:
    headers = {"Authorization": "Bearer nope"}
    response = _request_with_headers(client, method, path, body, headers)
    assert response.status_code == 401, f"{method} {path} accepted a wrong token"


def test_bridge_without_configured_token_fails_closed(runtime) -> None:
    from fastapi.testclient import TestClient

    from hermes_manager_bridge.server import create_app

    with TestClient(create_app(runtime=runtime, token=None)) as anonymous:
        assert anonymous.get("/api/v1/health").status_code == 503
        assert anonymous.get("/api/v1/config").status_code == 503


def test_token_is_accepted_from_the_x_hermes_token_header(client) -> None:
    assert client.get("/api/v1/health", headers={"x-hermes-token": TOKEN}).status_code == 200


def test_token_comparison_never_raises_on_unicode() -> None:
    """httpx refuses to even send non-ASCII headers, so assert on the helper."""
    from hermes_manager_bridge.auth import _bearer_value, _matches

    assert _matches("tok", "tok") is True
    assert _matches("tok", "other") is False
    assert _matches("tök", "tok") is False  # must not raise UnicodeEncodeError
    assert _matches("tok", "tök") is False
    assert _bearer_value("Bearer abc") == "abc"
    assert _bearer_value("bearer abc") == "abc"
    assert _bearer_value("Basic abc") is None
    assert _bearer_value(None) is None


def test_docs_are_disabled_unless_explicitly_enabled(client) -> None:
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_interactive_docs_can_be_enabled(monkeypatch, runtime) -> None:
    from fastapi.testclient import TestClient

    from hermes_manager_bridge.server import create_app

    monkeypatch.setenv("HERMES_BRIDGE_DOCS", "1")
    with TestClient(create_app(runtime=runtime, token=TOKEN), headers=AUTH) as documented:
        assert documented.get("/docs").status_code == 200


def test_unhandled_errors_do_not_leak_internals(runtime) -> None:
    from fastapi.testclient import TestClient

    from hermes_manager_bridge.routes import config as config_routes
    from hermes_manager_bridge.server import create_app

    def explode(*_args, **_kwargs):
        raise RuntimeError("secret token=abcd1234 leaked")

    original = config_routes.config_service.read_config
    config_routes.config_service.read_config = explode  # type: ignore[assignment]
    try:
        with TestClient(
            create_app(runtime=runtime, token=TOKEN),
            headers=AUTH,
            raise_server_exceptions=False,
        ) as broken:
            response = broken.get("/api/v1/config")
    finally:
        config_routes.config_service.read_config = original  # type: ignore[assignment]

    assert response.status_code == 500
    assert "abcd1234" not in response.text
    assert response.json()["detail"] == "internal server error"