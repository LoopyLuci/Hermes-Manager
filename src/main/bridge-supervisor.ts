import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import type { BridgeInfo, HealthReport } from '@shared/protocol'
import { bridgeDir, generateToken } from './bridge-paths'
import { resolveHermesHome, resolveHermesRepo } from './hermes-paths'

export interface BridgeState {
  status: 'stopped' | 'starting' | 'ready' | 'failed'
  info: BridgeInfo | null
  lastError: string | null
  health: HealthReport | null
}

interface BridgeReadyMessage {
  port: number
  token: string
  pid: number
}

/** Locate a Python interpreter able to run the bridge, preferring Hermes's own. */
export function findBridgePython(
  hermesHome: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; kind: 'hermes-venv' | 'store' } | null {
  if (hermesHome && existsSync(hermesHome)) {
    const installs = join(hermesHome, 'installs')
    if (existsSync(installs)) {
      for (const install of readdirSync(installs)) {
        const envRoot = join(installs, install, 'environments')
        if (!existsSync(envRoot)) continue
        for (const environment of readdirSync(envRoot)) {
          const candidate = join(envRoot, environment, 'venv', 'Scripts', 'python.exe')
          if (existsSync(candidate)) return { path: candidate, kind: 'hermes-venv' }
        }
      }
    }
    const tools = join(hermesHome, 'tools')
    if (existsSync(tools)) {
      for (const tool of readdirSync(tools)) {
        if (!tool.startsWith('python-')) continue
        const candidate = join(tools, tool, 'python.exe')
        if (existsSync(candidate)) return { path: candidate, kind: 'store' }
      }
    }
  }
  const fallback = env.HM_BRIDGE_PYTHON?.trim()
  if (fallback && existsSync(fallback)) return { path: fallback, kind: 'store' }
  return null
}

export class BridgeSupervisor extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null
  private stopping = false
  private restartAttempts = 0
  private readonly state: BridgeState = {
    status: 'stopped',
    info: null,
    lastError: null,
    health: null,
  }

  constructor(
    private readonly userDataDir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    super()
  }

  getState(): BridgeState {
    return { ...this.state }
  }

  async start(): Promise<BridgeInfo> {
    if (this.state.status === 'ready' && this.state.info) return this.state.info
    if (this.child) return this.waitForReady()

    const hermesHome = resolveHermesHome(this.userDataDir, this.env)
    const hermesRepo = resolveHermesRepo(hermesHome)
    const runtime = findBridgePython(hermesHome, this.env)
    if (!runtime) {
      this.fail('No Python interpreter found for the Hermes Manager bridge.')
      throw new Error(this.state.lastError ?? 'no python runtime')
    }

    const token = generateToken()
    const dir = bridgeDir()
    const args = ['-m', 'hermes_manager_bridge', '--token', token]
    if (hermesHome) args.push('--hermes-home', hermesHome)
    if (hermesRepo) args.push('--hermes-repo', hermesRepo)

    this.state.status = 'starting'
    this.state.lastError = null

    const pythonPath = [dir, hermesRepo, this.env.PYTHONPATH].filter((entry): entry is string =>
      Boolean(entry),
    )
    const child = spawn(runtime.path, args, {
      cwd: dir,
      env: { ...this.env, PYTHONPATH: pythonPath.join(';') },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child

    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) this.handleLine(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.emit('log', chunk))
    child.on('exit', (code, signal) => {
      this.child = null
      if (this.stopping) return
      this.state.status = 'failed'
      this.state.lastError = `bridge exited (code=${code}, signal=${signal})`
      this.emit('exit', code)
      this.scheduleRestart()
    })

    const info = await this.waitForReady()
    this.restartAttempts = 0
    return info
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    if (trimmed.startsWith('HERMES_BRIDGE_READY ')) {
      const message = JSON.parse(trimmed.slice('HERMES_BRIDGE_READY '.length)) as BridgeReadyMessage
      this.state.status = 'ready'
      this.state.info = {
        url: `http://127.0.0.1:${message.port}`,
        token: message.token,
        pid: message.pid,
      }
      this.emit('ready', this.state.info)
      return
    }
    this.emit('log', line)
  }

  private waitForReady(): Promise<BridgeInfo> {
    return new Promise((resolve, reject) => {
      if (this.state.status === 'ready' && this.state.info) return resolve(this.state.info)
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new Error(`bridge did not become ready in 30s: ${this.state.lastError ?? 'no output'}`),
        )
      }, 30_000)
      const onReady = (info: BridgeInfo): void => {
        cleanup()
        resolve(info)
      }
      const onExit = (code: number | null): void => {
        cleanup()
        reject(
          new Error(
            `bridge exited before ready (code=${code}): ${this.state.lastError ?? 'unknown'}`,
          ),
        )
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        this.off('ready', onReady)
        this.off('exit', onExit)
      }
      this.on('ready', onReady)
      this.on('exit', onExit)
    })
  }

  private scheduleRestart(): void {
    if (this.stopping) return
    this.restartAttempts += 1
    if (this.restartAttempts > 3) return
    setTimeout(
      () => {
        if (this.stopping || this.child) return
        void this.start().catch(() => undefined)
      },
      Math.min(1000 * 2 ** (this.restartAttempts - 1), 8000),
    )
  }

  private fail(message: string): void {
    this.state.status = 'failed'
    this.state.lastError = message
    this.emit('error', new Error(message))
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (!child) {
      this.state.status = 'stopped'
      return
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill()
    })
    this.child = null
    this.state.status = 'stopped'
    this.state.info = null
  }
}
