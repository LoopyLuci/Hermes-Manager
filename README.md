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
npm run lint         # ESLint + Prettier check
npm run typecheck    # tsc for node + web configs (src and tests)
npm run verify       # typecheck + bridge (pytest) + renderer (vitest)
npm run verify:full  # verify + lint + e2e (requires npm run build)
npm run test:e2e     # Playwright Electron journeys (run `npm run build` first)
```

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

CI runs all three plus lint, typecheck, and a production build on every push and pull request.

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

## Security model

- Bridge binds `127.0.0.1` on an ephemeral port with a per-launch 256-bit bearer token
  passed via environment (never on the command line in packaged builds).
- Auth is fail-closed: the bridge refuses to start without a token; every route and both
  WebSocket endpoints verify it; OpenAPI/docs are disabled in production.
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
