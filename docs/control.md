# Driving Hermes Manager from other programs

Everything the window does goes through the bridge, the local API in front of your Hermes install. Other programs use
the same bridge: an MCP client (Claude Desktop, Cursor, VS Code, another agent), ABP, or a script. They can reach Hermes
with or without the window, and they can open the window and drive it.

## Finding the bridge

A bridge started with `--discovery` writes `~/.hermes-manager/control.json` (or `$HM_HOME/control.json`) with its
address, token and pid, and removes it when it stops. The app always starts its bridge this way.

To check that the file is current, ask `GET /api/v1/ping`. It needs no token and answers only with the pid and version.
The pid that answers must be the one in the file.

The app reuses a bridge that is already running, for example one started headless by ABP or the MCP server, instead of
starting a second one. It leaves that bridge running when it quits.

Start a bridge without the window:

```powershell
$env:HM_BRIDGE_TOKEN = '<a long random string>'     # optional: one is generated if not set
& "$env:LOCALAPPDATA\hermes\installs\<id>\environments\<id>\venv\Scripts\python.exe" -m hermes_manager_bridge --discovery
```

Run it with Hermes's own virtualenv, which has everything the bridge needs, including WebSocket support for driving
the window. `PYTHONPATH` must include `src/bridge`.

## The API

Every request needs `Authorization: Bearer <token>`. Without a configured token the bridge refuses everything.

| Route | What it does |
|---|---|
| `GET /api/v1/operations` | Every operation with a readable id (`gateway.status`, `config.apply`, `backups.create`...), one argument schema, and whether it changes anything |
| `POST /api/v1/call/<id>` | Run one, with its arguments as a JSON object |
| `GET /api/v1/openapi.json` | The full API description (the public `/docs` and `/openapi.json` are switched off) |
| `GET /api/v1/gui/status`, `/api/v1/gui/operations` | Whether the window is attached; the window's operations |
| `POST /api/v1/gui/launch` | Open the window (the installed app, or this checkout's built app) and wait until it attaches |
| `POST /api/v1/gui/<op>` | Drive the window (below) |

## Driving the window

The window's main process attaches to the bridge and runs these against the real page:

| Operation | What it does |
|---|---|
| `state`, `window` | Visible, focused, size, current section; show, hide, focus, minimize, maximize, restore, resize |
| `sections`, `open` | The sidebar sections; switch to one |
| `inspect`, `find` | Every button, field, select, checkbox, tab, link, heading and table on screen, with ids, text, values, options; searching them |
| `read`, `text` | One element's contents (a table's rows); all the text on screen |
| `click`, `fill`, `select`, `check`, `key` | Act on an element |
| `wait` | Until an element exists or some text appears |
| `screenshot` | A PNG of the window |

An element is named by `{"id": ...}` (its `data-testid`, or the id `inspect` gave it) or by `{"text": ...}` (its visible
text, label or placeholder), optionally narrowed by `{"role": "button"}`.

## MCP

```json
{"mcpServers": {"hermes-manager": {
  "command": "C:/Users/<you>/AppData/Local/hermes/installs/<id>/environments/<id>/venv/Scripts/python.exe",
  "args": ["-m", "hermes_manager_bridge.mcp"],
  "env": {"PYTHONPATH": "Z:/Projects/Hermes-Manager/src/bridge"}}}}
```

Every operation and every window operation is a tool (`gateway_status`, `config_apply`, `gui_open`, `gui_click`...),
plus `gui_launch`, `hm_operations` and `hm_call`. `--tools compact` offers only the last two. The server uses the
running bridge and starts a headless one if there is none.
