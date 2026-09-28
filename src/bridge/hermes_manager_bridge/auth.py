from __future__ import annotations

import secrets

from fastapi import Header, HTTPException, Query, Request
from typing import Annotated


def _bearer_value(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() == "bearer" and value:
        return value.strip()
    return None


def verify_token(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_hermes_token: Annotated[str | None, Header(alias="x-hermes-token")] = None,
    token: Annotated[str | None, Query(include_in_schema=False)] = None,
) -> None:
    expected: str | None = getattr(request.app.state, "token", None)
    if not expected:
        raise HTTPException(status_code=401, detail="the bridge has no token configured")
    presented = token or _bearer_value(authorization) or x_hermes_token
    if not presented or not secrets.compare_digest(presented, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


def verify_websocket_token(websocket, token: str | None) -> bool:
    expected: str | None = getattr(websocket.app.state, "token", None)
    if not expected:
        return False
    presented = token or _bearer_value(websocket.headers.get("authorization"))
    if not presented:
        return False
    return secrets.compare_digest(presented, expected)
