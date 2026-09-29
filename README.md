# Hermes Manager

[![CI](https://github.com/LoopyLuci/Hermes-Manager/actions/workflows/ci.yml/badge.svg)](https://github.com/LoopyLuci/Hermes-Manager/actions/workflows/ci.yml)
[![Release](https://github.com/LoopyLuci/Hermes-Manager/actions/workflows/release.yml/badge.svg)](https://github.com/LoopyLuci/Hermes-Manager/actions/workflows/release.yml)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/LoopyLuci/Hermes-Manager/releases)

A production-grade desktop control center for [Hermes](https://github.com/nosible/hermes): live
telemetry, log exploration, gateway and process control, session browsing, an interactive chat,
a comment-preserving config editor, updates, backups, and a tools center (MCP servers, skills,
cron jobs, plugins, local models) — all in one Electron app.

## Screenshots

> _Place screenshots in `docs/` and reference them here._

## Features

| Area         | What it does                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------ |
| **Overview** | Bridge health, four-layer data source matrix, runtime identity                                   |
| **Logs**     | Virtualized tail/follow of every Hermes log, level filters, search                               |
| **Gateway**  | Status, fleet, processes, start/stop/restart/drain with two-step confirms                        |
| **Sessions** | Browse and search `state.db` sessions, full transcripts                                          |
| **Chat**     | Streaming conversation against `hermes chat`, abort, resume, transcript export                   |
| **Config**   | Edit `config.yaml` and `.env` with type-aware fields, diff preview, atomic apply + backups       |
| **Updates**  | Code identity, update receipts, check + spawn `hermes update`                                    |
| **Backups**  | Full/snapshot/config backups, preview + restore with diff, delete                                |
| **Tools**    | MCP servers (test/toggle), skills (10k+ searchable, enable/disable), cron, plugins, local models |

## Architecture

```
┌────────────────────────────  Electron  ────────────────────────────┐
│  Renderer (React 19 + TypeScript)                                  │
│    └─ preload (contextBridge, strict CSP, sandbox)                 │
│           │ token-authenticated fetch / WebSocket                  │
│  Bridge (FastAPI, 127.0.0.1, random 256-bit token)                 │
│    └─ 4-layer Hermes access with silent fallback + provenance      │
│         rest → files → db/cli → deep (Python imports)              │
│           │                                                         │
│  HERMES_HOME (config.yaml, .env, state.db, logs, skills, cron…)    │
└─────────────────────────────────────────────────────────────────────┘
```

The bridge runs under Hermes's own Python (venv preferred, store python fallback) and exposes a
versioned REST/WS API under `/api/v1`. Every domain declares its data-source preference; the UI
shows a provenance badge for whatever layer answered.

## Getting started

### Prerequisites

- Windows 10/11 x64 (macOS/Linux paths are scaffolded but untested)
- Node.js 22+ and npm
- A Hermes installation (`HERMES_HOME`, default `%LOCALAPPDATA%\hermes`)

### Development

```powershell
npm install
npm run dev          # electron-vite dev with HMR; bridge auto-starts
```

### Quality gates

```powershell
npm run lint           # ESLint
npm run format:check   # Prettier
npm run typecheck      # tsc for the main, renderer and e2e configs
npm run verify         # typecheck + bridge (pytest) + renderer (vitest)
npm run test:e2e       # Playwright Electron journeys (run `npm run build` first)
```

### The local CI/CD pipeline

Everything a change needs is checked on this machine by `scripts/pipeline.mjs`: no cloud runner.

```powershell
npm run hooks:install   # once: every `git push` runs the pipeline first (skip once: git push --no-verify)
npm run pipeline        # what this change needs
npm run pipeline:full   # every stage, including e2e and packaging
node scripts/pipeline.mjs --fast | --list | --only tests | --package | --no-deploy
```

| Stage | What it does |
|---|---|
| `preflight` | Node 22+, npm, free disk, git state, finds Hermes's Python for the bridge |
| `deps` | `npm ci` only when `package-lock.json` changed since the last install |
| `static` | ESLint, TypeScript, Prettier (reported), no secrets or files over 5 MB in the push, `npm audit` of production dependencies |
| `tests` | Vitest and the bridge's pytest suite. A failed test is re-run once on its own: a flake is reported as a flake, and a real failure blocks. |
| `build` | `electron-vite build`, with the output checked |
| `smoke` | A real bridge in a throwaway `HM_HOME` must answer ping, refuse callers without the token, list its operations and run a read-only call. Its MCP server must answer `initialize` and `tools/list`. |
| `e2e` | Playwright against the built Electron app |
| `package` | `electron-builder`, with SHA-256 files beside the artifacts |
| `deploy` | A bridge started by ABP or MCP from this checkout is restarted onto the new code. A running window is left alone and you are told to restart it. |

How it stays reliable:
- only one run happens at a time; the lock left by a crashed run is taken over;
- every command has a timeout, and on timeout its whole process tree is killed;
- a stage that doesn't apply to the change is skipped, and says why; when the change set can't be determined, everything runs;
- each run leaves a log in `logs/pipeline/`, plus JSON reports and a timing history in `reports/pipeline/`.

### Packaging

```powershell
npm run build        # electron-vite production build
npm run dist         # NSIS installer + portable zip → dist/
```

## Testing

- `tests/bridge` — pytest suite running the FastAPI app against a fixture `HERMES_HOME`
  (`.pytest-deps/` supplies the test-only Python packages).
- `tests/renderer` — vitest + jsdom component tests with a scripted `fetch` mock.
- `tests/e2e` — Playwright journeys driving the real Electron app and bridge.

The local pipeline (above) runs all three, plus lint, typecheck, a production build and a live smoke test of the bridge.

## Releasing

1. Bump `version` in `package.json`.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The **Release** workflow builds on Windows, signs with
   [SignPath](https://signpath.org/) (free for open-source), runs the test suite, and
   publishes a GitHub Release containing the installer, portable zip, and `latest.yml`
   consumed by the in-app updater.

Repository secrets used by the release workflow:

| Secret               | Purpose                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `SIGNPATH_API_TOKEN` | SignPath API token (org/project ids configurable in the workflow) |

## Driving it from other programs

The bridge is the one way in, for the window and for everything else: an MCP server
(`python -m hermes_manager_bridge.mcp`) offers every operation and every window operation as tools, and other programs
(such as ABP) call `POST /api/v1/call/<operation>`. A running bridge advertises itself in
`~/.hermes-manager/control.json`; the app reuses a bridge that is already running, and the window can be opened and
driven remotely (sections, every element on screen, clicks, fields, selects, keys, screenshots). See
[docs/control.md](docs/control.md).

## Security model

- Bridge binds `127.0.0.1` on an ephemeral port with a per-launch 256-bit bearer token
  passed via the environment (`HM_BRIDGE_TOKEN`), never on the command line, and never printed.
- Auth is fail-closed: a bridge without a token refuses every request; every route and every
  WebSocket endpoint verify it; the public `/docs` and `/openapi.json` are off (the API description
  is at `/api/v1/openapi.json`, behind the token). Only `/api/v1/ping` (pid and version) is public.
- The discovery file that lets other programs find the bridge is readable only by its owner and
  removed when the bridge stops.
- Renderer runs with `contextIsolation`, `sandbox`, `nodeIntegration: false`, a strict CSP,
  and an origin allowlist on navigation/window-open.
- Secrets in `.env` are masked in the UI; config writes are atomic and backed up before
  every mutation.

## Project layout

```
src/main/       Electron main process (window, bridge supervisor, IPC, security)
src/preload/    contextBridge API surface
src/renderer/   React app (features/, components/, hooks/, lib/)
src/shared/     protocol types shared by main/renderer
src/bridge/     FastAPI bridge (routes/, services/, sources/)
tests/          bridge (pytest), renderer (vitest), e2e (playwright)
scripts/        verify.ps1, dev helpers, icon generator
```

## License

UNLICENSED — all rights reserved.
