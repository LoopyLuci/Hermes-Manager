from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from . import __version__
from .runtime import resolve_runtime
from .server import create_app

READY_PREFIX = "HERMES_BRIDGE_READY "


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="hermes_manager_bridge", description="Hermes Manager local bridge")
    parser.add_argument("--token", default="", help="Bearer token required on every /api request")
    parser.add_argument("--hermes-home", default=None, help="Path to the Hermes home directory")
    parser.add_argument("--hermes-repo", default=None, help="Path to the hermes-agent checkout")
    parser.add_argument("--version", action="version", version=__version__)
    return parser.parse_args(argv)


async def _serve(app, token: str) -> int:  # type: ignore[no-untyped-def]
    import uvicorn

    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", access_log=False)
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
    port = sockets[0].getsockname()[1] if sockets else 0
    payload = {"port": port, "token": token, "pid": os.getpid(), "version": __version__}
    print(READY_PREFIX + json.dumps(payload), flush=True)

    await task
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    runtime = resolve_runtime(args.hermes_home, args.hermes_repo)
    app = create_app(runtime=runtime, token=args.token or None)
    return asyncio.run(_serve(app, args.token))


if __name__ == "__main__":
    raise SystemExit(main())
