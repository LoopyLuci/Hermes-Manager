import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
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
  pid: number
}

interface DiscoveryRecord {
  url: string
  token: string
  pid: number
}

/** Where a running bridge advertises itself (see the bridge's control.py). */
export function discoveryFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HM_HOME?.trim() || join(homedir(), '.hermes-manager'), 'control.json')
}

/**
 * A bridge that is already running (started headless by ABP, the MCP server or a script), if its discovery record
 * is current: the pid that answers /api/v1/ping must be the one that wrote the file.
 */
export async function findRunningBridge(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveryRecord | null> {
  let record: DiscoveryRecord
  try {
    record = JSON.parse(readFileSync(discoveryFile(env), 'utf8')) as DiscoveryRecord
  } catch {
    return null
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const response = await fetch(`${record.url}/api/v1/ping`, { signal: controller.signal })
    clearTimeout(timer)
    const ping = (await response.json()) as { pid?: number }
    return ping.pid === record.pid ? record : null
  } catch {
    return null
  }
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
  /** True when this app is using a bridge someone else started: it is left running when the app quits. */
  private adopted = false
  private token = ''
  private restartAttempts = 0
  private restartTimer: NodeJS.Timeout | null = null
  private stabilityTimer: NodeJS.Timeout | null = null
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

    // A previous stop() must not permanently disable future starts/restarts.
    this.stopping = false

    const running = await findRunningBridge(this.env)
    if (running) {
      this.adopted = true
      this.state.status = 'ready'
      this.state.lastError = null
      this.state.info = { url: running.url, token: running.token, pid: running.pid }
      this.emit('ready', this.state.info)
      return this.state.info
    }

    const hermesHome = resolveHermesHome(this.userDataDir, this.env)
    const hermesRepo = resolveHermesRepo(hermesHome)
    const runtime = findBridgePython(hermesHome, this.env)
    if (!runtime) {
      this.fail('No Python interpreter found for the Hermes Manager bridge.')
      throw new Error(this.state.lastError ?? 'no python runtime')
    }

    // The token goes through the environment, never the command line (which any process can read).
    const token = generateToken()
    this.token = token
    const dir = bridgeDir()
    const args = ['-m', 'hermes_manager_bridge', '--discovery', '--owner', 'app']
    if (hermesHome) args.push('--hermes-home', hermesHome)
    if (hermesRepo) args.push('--hermes-repo', hermesRepo)

    this.state.status = 'starting'
    this.state.lastError = null

    const pythonPath = [dir, hermesRepo, this.env.PYTHONPATH].filter((entry): entry is string =>
      Boolean(entry),
    )
    const child = spawn(runtime.path, args, {
      cwd: dir,
      env: { ...this.env, PYTHONPATH: pythonPath.join(';'), HM_BRIDGE_TOKEN: token },
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
    child.on('error', (error: Error) => {
      // Spawn failures (ENOENT, EACCES, ...) arrive here, not on 'exit'.
      if (this.child !== child) return
      this.child = null
      if (this.stopping) return
      this.state.status = 'failed'
      this.state.lastError = `bridge failed to launch: ${error.message}`
      this.emit('log', this.state.lastError)
      this.emit('exit', null)
      this.scheduleRestart()
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      if (this.stopping) return
      this.state.status = 'failed'
      this.state.lastError = `bridge exited (code=${code}, signal=${signal})`
      this.emit('exit', code)
      this.scheduleRestart()
    })

    return this.waitForReady()
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    if (trimmed.startsWith('HERMES_BRIDGE_READY ')) {
      let message: BridgeReadyMessage | null
      try {
        message = JSON.parse(trimmed.slice('HERMES_BRIDGE_READY '.length)) as BridgeReadyMessage
      } catch {
        this.emit('log', trimmed)
        return
      }
      if (!message || typeof message.port !== 'number' || typeof message.pid !== 'number') {
        this.emit('log', trimmed)
        return
      }
      this.state.status = 'ready'
      this.state.info = {
        url: `http://127.0.0.1:${message.port}`,
        token: this.token,
        pid: message.pid,
      }
      this.emit('ready', this.state.info)
      // The restart budget only resets once the bridge has stayed up for a
      // while; a ready-then-crash loop must still hit the 3-attempt cap.
      this.armStabilityReset()
      return
    }
    this.emit('log', line)
  }

  private armStabilityReset(): void {
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer)
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null
      this.restartAttempts = 0
    }, 15_000)
    this.stabilityTimer.unref?.()
  }

  private waitForReady(): Promise<BridgeInfo> {
    return new Promise((resolve, reject) => {
      if (this.state.status === 'ready' && this.state.info) return resolve(this.state.info)
      const timer = setTimeout(() => {
        cleanup()
        // Never leak a child that sits in 'starting' forever: kill it and let
        // the exit handler mark the failure + schedule a restart.
        const pending = this.child
        if (pending) {
          this.emit('log', 'bridge did not become ready in 30s; killing it')
          pending.kill()
        }
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
    if (this.restartAttempts > 3) {
      this.emit(
        'log',
        `bridge restart budget exhausted (${this.restartAttempts} attempts); giving up`,
      )
      return
    }
    this.restartTimer = setTimeout(
      () => {
        this.restartTimer = null
        if (this.stopping || this.child) return
        void this.start().catch(() => undefined)
      },
      Math.min(1000 * 2 ** (this.restartAttempts - 1), 8000),
    )
    this.restartTimer.unref?.()
  }

  private fail(message: string): void {
    this.state.status = 'failed'
    this.state.lastError = message
    this.emit('log', message)
    // 'error' throws when unhandled; only fire it when someone is listening.
    if (this.listenerCount('error') > 0) this.emit('error', new Error(message))
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer)
      this.stabilityTimer = null
    }
    if (this.adopted) {
      // Not ours to stop: another program started it and still uses it.
      this.adopted = false
      this.state.status = 'stopped'
      this.state.info = null
      return
    }
    const child = this.child
    if (!child) {
      this.state.status = 'stopped'
      this.state.info = null
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
    if (this.child === child) this.child = null
    this.state.status = 'stopped'
    this.state.info = null
    this.state.lastError = null
  }
}
