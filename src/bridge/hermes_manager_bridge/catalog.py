"""The bridge's API as a catalog of operations, built from its own OpenAPI description.

Each route becomes an operation with a readable id (``gateway.status``, ``config.apply``), a summary, one JSON Schema
for all its arguments (path, query and body merged) and whether it changes anything. ``POST /api/v1/call/{op}`` runs
one with those arguments, so the MCP server and other programs need no knowledge of paths and methods.
"""
from __future__ import annotations

import re
from typing import Any

from fastapi import FastAPI

SKIP_PREFIXES = ("/api/v1/call", "/api/v1/operations", "/api/v1/openapi.json", "/api/v1/ping", "/api/v1/gui")


def _resolve(schema: Any, components: dict, depth: int = 0) -> Any:
    if depth > 12:
        return {}
    if isinstance(schema, dict):
        if "$ref" in schema:
            name = schema["$ref"].rsplit("/", 1)[-1]
            return _resolve(components.get(name, {}), components, depth + 1)
        return {k: _resolve(v, components, depth + 1) for k, v in schema.items() if k != "title"}
    if isinstance(schema, list):
        return [_resolve(v, components, depth + 1) for v in schema]
    return schema


def _op_id(path: str, method: str, name: str, tag: str) -> str:
    """A readable id: the tag, then the route function's name without the tag repeated (gateway.status)."""
    base = re.sub(r"_api_v1_.*$", "", name or "")
    base = base or re.sub(r"[^a-z0-9]+", "_", path.replace("/api/v1/", "").lower()).strip("_")
    if tag and base.startswith(tag + "_"):
        base = base[len(tag) + 1:]
    return f"{tag}.{base}" if tag else base


def build(app: FastAPI) -> list[dict]:
    spec = app.openapi()
    components = (spec.get("components") or {}).get("schemas") or {}
    ops: list[dict] = []
    seen: set[str] = set()
    for path, methods in spec.get("paths", {}).items():
        if path.startswith(SKIP_PREFIXES):
            continue
        for method, op in methods.items():
            tag = (op.get("tags") or [""])[0]
            op_id = _op_id(path, method, op.get("operationId", ""), tag)
            while op_id in seen:
                op_id += "_" + method
            seen.add(op_id)
            props: dict[str, Any] = {}
            required: list[str] = []
            where: dict[str, str] = {}
            for p in op.get("parameters") or []:
                name = p["name"]
                props[name] = _resolve(p.get("schema") or {}, components)
                if p.get("description"):
                    props[name]["description"] = p["description"]
                where[name] = p.get("in", "query")
                if p.get("required"):
                    required.append(name)
            body = ((op.get("requestBody") or {}).get("content") or {}).get("application/json", {}).get("schema")
            if body:
                body = _resolve(body, components)
                if body.get("type") == "object" and body.get("properties"):
                    for k, v in body["properties"].items():
                        props[k] = v
                        where[k] = "body"
                    required += [r for r in body.get("required", []) if r not in required]
                else:
                    props["body"] = body
                    where["body"] = "body-whole"
                    if (op.get("requestBody") or {}).get("required"):
                        required.append("body")
            params: dict[str, Any] = {"type": "object", "properties": props}
            if required:
                params["required"] = required
            ops.append({"id": op_id, "group": tag or "core", "method": method.upper(), "path": path,
                        "summary": op.get("summary") or op.get("description") or op_id,
                        "params": params, "where": where, "mutating": method.upper() not in ("GET", "HEAD")})
    return sorted(ops, key=lambda o: o["id"])


def request_for(op: dict, args: dict) -> tuple[str, str, dict, Any]:
    """(method, path, query, json body) for calling `op` with `args`."""
    unknown = set(args) - set(op["where"])
    if unknown:
        raise ValueError(f"unknown argument(s) for {op['id']}: {', '.join(sorted(unknown))}")
    missing = [r for r in op["params"].get("required", []) if r not in args]
    if missing:
        raise ValueError(f"missing required argument(s) for {op['id']}: {', '.join(missing)}")
    path = op["path"]
    query: dict = {}
    body: Any = None
    for k, v in args.items():
        where = op["where"][k]
        if where == "path":
            path = path.replace("{" + k + "}", str(v))
        elif where == "query":
            query[k] = v
        elif where == "body-whole":
            body = v
        else:
            body = body if isinstance(body, dict) else {}
            body[k] = v
    return op["method"], path, query, body
