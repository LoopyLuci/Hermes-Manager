"""The bridge: Hermes Manager's local API in front of a Hermes install.

    python -m hermes_manager_bridge                     started by the app (prints HERMES_BRIDGE_READY {...})
    python -m hermes_manager_bridge --discovery         also writes ~/.hermes-manager/control.json so other programs
                                                        (the MCP server, ABP) can find and use it; headless if no window

The token comes from $HM_BRIDGE_TOKEN (never the command line, where every process could read it); if there is none,
one is generated. ``--token`` still works for older launchers but is discouraged.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from . import __version__, control
from .runtime import resolve_runtime
from .server import create_app

READY_PREFIX = "HERMES_BRIDGE_READY "


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="hermes_manager_bridge", description="Hermes Manager local bridge")
    parser.add_argument("--token", default="", help="(discouraged: visible to other processes) use $HM_BRIDGE_TOKEN")
    parser.add_argument("--hermes-home", default=None, help="Path to the Hermes home directory")
    parser.add_argument("--hermes-repo", default=None, help="Path to the hermes-agent checkout")
    parser.add_argument("--port", type=int, default=0, help="Port on 127.0.0.1 (default: any free port)")
    parser.add_argument("--discovery", action="store_true", help="Write ~/.hermes-manager/control.json while running")
    parser.add_argument("--owner", default="bridge", help="Who started it (app, abp, mcp...), recorded in control.json")
    parser.add_argument("--version", action="version", version=__version__)
    return parser.parse_args(argv)


async def _serve(app, token: str, port: int, discovery: bool, owner: str) -> int:  # type: ignore[no-untyped-def]
    import uvicorn

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())

    for _ in range(600):
        if server.started or server.should_exit:
            break
        await asyncio.sleep(0.02)
    else:
        task.cancel()
        print("HERMES_BRIDGE_ERROR bridge failed to bind within 12s", file=sys.stderr, flush=True)
        return 1

    if not server.started:
        task.cancel()
        print("HERMES_BRIDGE_ERROR bridge exited during startup", file=sys.stderr, flush=True)
        return 1

    sockets = server.servers[0].sockets if server.servers else []
    bound = sockets[0].getsockname()[1] if sockets else 0
    if discovery:
        control.write(f"http://127.0.0.1:{bound}", token, version=__version__, owner=owner)
    # The token is not printed: whoever started the bridge already has it, and stdout may be logged.
    payload = {"port": bound, "pid": os.getpid(), "version": __version__}
    print(READY_PREFIX + json.dumps(payload), flush=True)
    try:
        await task
    finally:
        if discovery:
            control.remove()
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    token = (
        os.environ.get("HM_BRIDGE_TOKEN", "").strip()
        or os.environ.get("HERMES_BRIDGE_TOKEN", "").strip()  # legacy alias
        or args.token
        or control.new_token()
    )
    runtime = resolve_runtime(args.hermes_home, args.hermes_repo)
    app = create_app(runtime=runtime, token=token)
    return asyncio.run(_serve(app, token, args.port, args.discovery, args.owner))


if __name__ == "__main__":
    raise SystemExit(main())
