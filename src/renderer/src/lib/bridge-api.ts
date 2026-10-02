import type {
  AppUpdateCheck,
  BackupCreateResult,
  BackupDeleteResult,
  BackupReport,
  BridgeInfo,
  ChatEvent,
  ConfigApplyResult,
  ConfigDiff,
  ConfigDocument,
  ConfigEditRequest,
  ConfigRestorePreview,
  ConfigRestoreResult,
  CronActionResult,
  CronReport,
  DrainAction,
  DrainResult,
  EnvReport,
  FleetReport,
  GatewayStatus,
  HealthReport,
  LifecycleAction,
  LifecycleResult,
  LocalModelsReport,
  LogBatch,
  LogEntry,
  LogFile,
  LogFollowEvent,
  McpReport,
  McpTestResult,
  MessagePage,
  PluginReport,
  ProcessReport,
  SessionList,
  SkillList,
  SkillToggleResult,
  SourceLayer,
  SourceStatus,
  StreamEvent,
  UpdateApplyResult,
  UpdateCheckResult,
  UpdateReport,
} from '@shared/protocol'

const API_BASE = '/api/v1'

/** The bridge boots after the renderer on cold start; wait for it instead of failing. */
const BRIDGE_WAIT_MS = 20_000
const BRIDGE_WAIT_POLL_MS = 200

async function bridgeInfo(): Promise<BridgeInfo | null> {
  if (typeof window === 'undefined' || !window.hermes) return null
  const deadline = Date.now() + BRIDGE_WAIT_MS
  for (;;) {
    const info = await window.hermes.bridgeInfo()
    if (info) return info
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, BRIDGE_WAIT_POLL_MS))
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const info = await bridgeInfo()
  if (!info) throw new Error('bridge is not ready')
  const response = await fetch(`${info.url}${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
      Authorization: `Bearer ${info.token}`,
    },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ detail: response.statusText }))) as {
      detail?: string
    }
    throw new Error(body.detail ?? `request failed with ${response.status}`)
  }
  return (await response.json()) as T
}

export const bridgeApi = {
  health: (): Promise<HealthReport> => request<HealthReport>('/health'),
  sources: (): Promise<SourceStatus> => request<SourceStatus>('/sources'),
  logFiles: (): Promise<LogFile[]> => request<LogFile[]>('/logs'),
  logTail: (file: string, lines = 400): Promise<LogBatch> =>
    request<LogBatch>(`/logs/tail?file=${encodeURIComponent(file)}&lines=${lines}`),
  logRead: (file: string, offset: number): Promise<LogBatch> =>
    request<LogBatch>(`/logs/read?file=${encodeURIComponent(file)}&offset=${offset}`),
  gatewayStatus: (): Promise<GatewayStatus> => request<GatewayStatus>('/gateway'),
  gatewayFleet: (): Promise<FleetReport> => request<FleetReport>('/gateway/fleet'),
  processes: (): Promise<ProcessReport> => request<ProcessReport>('/processes'),
  gatewayLifecycle: (action: LifecycleAction): Promise<LifecycleResult> =>
    request<LifecycleResult>('/gateway/lifecycle', {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  gatewayDrain: (action: DrainAction): Promise<DrainResult> =>
    request<DrainResult>('/gateway/drain', { method: 'POST', body: JSON.stringify({ action }) }),
  sessions: (query?: string, limit = 50, offset = 0): Promise<SessionList> => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    if (query) params.set('q', query)
    return request<SessionList>(`/sessions?${params.toString()}`)
  },
  sessionMessages: (
    sessionId: string,
    limit = 300,
    order: 'oldest' | 'latest' = 'oldest',
  ): Promise<MessagePage> =>
    request<MessagePage>(
      `/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}&order=${order}`,
    ),
  config: (): Promise<ConfigDocument> => request<ConfigDocument>('/config'),
  configEnv: (): Promise<EnvReport> => request<EnvReport>('/config/env'),
  configDiff: (body: ConfigEditRequest): Promise<ConfigDiff> =>
    request<ConfigDiff>('/config/diff', { method: 'POST', body: JSON.stringify(body) }),
  configApply: (body: ConfigEditRequest): Promise<ConfigApplyResult> =>
    request<ConfigApplyResult>('/config/apply', { method: 'POST', body: JSON.stringify(body) }),
  updates: (): Promise<UpdateReport> => request<UpdateReport>('/updates'),
  checkUpdates: (force = false): Promise<UpdateCheckResult> =>
    request<UpdateCheckResult>(`/updates/check?force=${force}`, { method: 'POST' }),
  applyUpdate: (branch?: string): Promise<UpdateApplyResult> =>
    request<UpdateApplyResult>('/updates/apply', {
      method: 'POST',
      body: JSON.stringify({ branch: branch || null, yes: true }),
    }),
  /** Manager (not Hermes) updates are served by the main process, not the bridge. */
  checkAppUpdate: (): Promise<AppUpdateCheck> => window.hermes.checkAppUpdate(),
  installAppUpdate: (): Promise<boolean> => window.hermes.installAppUpdate(),
  backups: (): Promise<BackupReport> => request<BackupReport>('/backups'),
  createBackup: (mode: 'snapshot' | 'full'): Promise<BackupCreateResult> =>
    request<BackupCreateResult>('/backups/create', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  deleteBackup: (path: string): Promise<BackupDeleteResult> =>
    request<BackupDeleteResult>('/backups/delete', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  previewConfigRestore: (path: string): Promise<ConfigRestorePreview> =>
    request<ConfigRestorePreview>('/backups/config/preview', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  restoreConfig: (path: string): Promise<ConfigRestoreResult> =>
    request<ConfigRestoreResult>('/backups/config/restore', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  mcpList: (): Promise<McpReport> => request<McpReport>('/tools/mcp'),
  mcpTest: (name: string): Promise<McpTestResult> =>
    request<McpTestResult>('/tools/mcp/test', { method: 'POST', body: JSON.stringify({ name }) }),
  skillsList: (q?: string, offset = 0, limit = 50): Promise<SkillList> => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
    if (q) params.set('q', q)
    return request<SkillList>(`/tools/skills?${params.toString()}`)
  },
  skillsToggle: (name: string, enable: boolean): Promise<SkillToggleResult> =>
    request<SkillToggleResult>('/tools/skills/toggle', {
      method: 'POST',
      body: JSON.stringify({ name, enable }),
    }),
  cronList: (): Promise<CronReport> => request<CronReport>('/tools/cron'),
  cronAction: (jobId: string, action: 'pause' | 'resume' | 'run'): Promise<CronActionResult> =>
    request<CronActionResult>('/tools/cron/action', {
      method: 'POST',
      body: JSON.stringify({ job_id: jobId, action }),
    }),
  pluginsList: (): Promise<PluginReport> => request<PluginReport>('/tools/plugins'),
  modelsList: (): Promise<LocalModelsReport> => request<LocalModelsReport>('/tools/models'),
  /** Send one chat turn; events arrive on *onEvent* as they stream. Resolves when the stream ends. */
  async chat(
    body: { text: string; session_id?: string | null; chat_id?: string },
    onEvent: (event: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const info = await bridgeInfo()
    if (!info) throw new Error('bridge is not ready')
    const response = await fetch(`${info.url}${API_BASE}/chat`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.token}` },
      body: JSON.stringify(body),
    })
    if (!response.ok || !response.body) {
      const payload = (await response.json().catch(() => ({ detail: response.statusText }))) as {
        detail?: string
      }
      throw new Error(payload.detail ?? `chat failed with ${response.status}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) {
          try {
            onEvent(JSON.parse(line) as ChatEvent)
          } catch {
            /* skip malformed frame */
          }
        }
        index = buffer.indexOf('\n')
      }
    }
    const tail = buffer.trim()
    if (tail) {
      try {
        onEvent(JSON.parse(tail) as ChatEvent)
      } catch {
        /* skip malformed tail */
      }
    }
  },
  abortChat: (chatId: string): Promise<{ ok: boolean }> =>
    request<{ ok: boolean }>('/chat/abort', {
      method: 'POST',
      body: JSON.stringify({ chat_id: chatId }),
    }),
  async *events(): AsyncGenerator<StreamEvent> {
    const info = await bridgeInfo()
    if (!info) return
    const url = `${info.url.replace(/^http/, 'ws')}${API_BASE}/stream?token=${encodeURIComponent(info.token)}`
    const socket = new WebSocket(url)
    try {
      yield await new Promise<StreamEvent>((resolve, reject) => {
        socket.onmessage = (event) => resolve(JSON.parse(event.data) as StreamEvent)
        socket.onerror = () => reject(new Error('bridge stream failed'))
      })
      while (socket.readyState === WebSocket.OPEN) {
        yield await new Promise<StreamEvent>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('heartbeat timeout')), 10_000)
          socket.onmessage = (event) => {
            clearTimeout(timer)
            resolve(JSON.parse(event.data) as StreamEvent)
          }
          socket.onerror = () => {
            clearTimeout(timer)
            reject(new Error('bridge stream closed'))
          }
        })
      }
    } finally {
      socket.close()
    }
  },
  /** Follow a log file over the bridge WebSocket. Returns a disconnect function. */
  followLog(file: string, offset: number, onBatch: (batch: LogFollowEvent) => void): () => void {
    let socket: WebSocket | null = null
    let disposed = false

    void (async () => {
      const info = await bridgeInfo()
      if (!info || disposed) return
      const base = info.url.replace(/^http/, 'ws')
      const url = `${base}/api/v1/logs/stream?file=${encodeURIComponent(file)}&offset=${offset}&token=${encodeURIComponent(info.token)}`
      socket = new WebSocket(url)
      socket.onmessage = (event) => {
        try {
          onBatch(JSON.parse(event.data) as LogFollowEvent)
        } catch {
          /* ignore malformed frames */
        }
      }
    })()

    return () => {
      disposed = true
      socket?.close()
    }
  },
}

export type { HealthReport, LogBatch, LogEntry, LogFile, SourceLayer, SourceStatus }
