import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@renderer/App'
import type {
  BackupCreateResult,
  BackupReport,
  BridgeInfo,
  ConfigApplyResult,
  ConfigDiff,
  ConfigDocument,
  ConfigRestorePreview,
  ConfigRestoreResult,
  CronActionResult,
  CronReport,
  EnvReport,
  FleetReport,
  GatewayStatus,
  HealthReport,
  LifecycleResult,
  LocalModelsReport,
  LogBatch,
  LogFile,
  McpReport,
  McpTestResult,
  MessagePage,
  PluginReport,
  ProcessReport,
  SessionList,
  SkillList,
  SkillToggleResult,
  SourceStatus,
  UpdateApplyResult,
  UpdateCheckResult,
  UpdateReport
} from '@shared/protocol'

const healthFixture: HealthReport = {
  ok: true,
  app: 'hermes-manager',
  app_version: '0.1.0',
  started_at: '2026-09-26T10:00:00+00:00',
  uptime_s: 42,
  hermes_home: 'C:\\hermes',
  hermes_repo: 'C:\\hermes\\hermes-agent',
  runtime: { python: 'C:\\hermes\\venv\\python.exe', kind: 'hermes-venv', version: '3.14.7' },
  layers: {
    rest: { state: 'ready', detail: 'hermes serve answering HTTP 404', origin: 'http://127.0.0.1:9119', latency_ms: 3 },
    files: { state: 'ready', detail: '7 active logs, 12.4 MB', origin: 'C:\\hermes\\logs', latency_ms: 1 },
    db: { state: 'ready', detail: '34 tables', origin: 'C:\\hermes\\state.db', latency_ms: 2 },
    cli: { state: 'ready', detail: 'hermes CLI from checkout', origin: 'C:\\hermes\\hermes-agent', latency_ms: 0 },
    deep: { state: 'degraded', detail: 'partial imports', origin: 'C:\\hermes\\hermes-agent', latency_ms: 120 }
  }
}

const sourcesFixture: SourceStatus = {
  layers: healthFixture.layers,
  domains: {
    overview: 'rest',
    logs: 'files',
    gateway: 'deep',
    sessions: 'db',
    chat: 'rest',
    updates: 'cli',
    backups: 'cli',
    config: 'rest',
    tools: 'rest'
  }
}

const logFilesFixture: LogFile[] = [
  { name: 'agent.log', size: 1664613, modified: '2026-09-26T10:06:07+00:00', rotated: false },
  { name: 'errors.log', size: 788172, modified: '2026-09-26T10:05:43+00:00', rotated: false },
  { name: 'agent.log.1', size: 5242981, modified: '2026-09-24T21:03:30+00:00', rotated: true }
]

const logTailFixture: LogBatch = {
  file: 'agent.log',
  offset: 4096,
  truncated: false,
  entries: [
    {
      ts: '2026-09-26 10:00:00,123',
      level: 'INFO',
      session: '20260918_112544_1b2239',
      logger: 'agent.conversation_loop',
      message: 'API call #369: model=test',
      raw: '2026-09-26 10:00:00,123 INFO [20260918_112544_1b2239] agent.conversation_loop: API call #369: model=test',
      seq: 0
    },
    {
      ts: '2026-09-26 10:00:01,456',
      level: 'ERROR',
      session: null,
      logger: 'agent.chat_completion_helpers',
      message: 'Streaming failed before delivery',
      raw: '2026-09-26 10:00:01,456 ERROR agent.chat_completion_helpers: Streaming failed before delivery',
      seq: 1
    }
  ]
}

const bridgeInfo: BridgeInfo = { url: 'http://127.0.0.1:9119', token: 'token', pid: 7 }

const gatewayStatusFixture: GatewayStatus = {
  source: 'files',
  running: true,
  drain_requested: false,
  identity: {
    kind: 'gateway',
    pid: 4242,
    start_time: 1_760_000_000,
    profile: null,
    supervisor: 'manual',
    code_sha: 'abcdef1234567890',
    code_version: '0.9.9',
    hermes_home: 'C:\\hermes',
    served_profiles: ['default']
  },
  state: {
    state: 'running',
    pid: 4242,
    updated_at: '2026-09-26T10:00:00Z',
    active_agents: 2,
    active_work: 1,
    served_profiles: ['default'],
    exit_reason: null,
    restart_requested: false,
    code_sha: 'abcdef1234567890',
    code_version: '0.9.9'
  },
  detail: null
}

const fleetFixture: FleetReport = {
  source: 'files',
  rows: [
    {
      profile: 'default',
      pid: 4242,
      state: 'current',
      code_sha: 'abcdef1234567890',
      code_version: '0.9.9',
      code_root: null,
      served_profiles: ['default']
    }
  ],
  detail: null
}

const processesFixture: ProcessReport = {
  source: 'files',
  processes: [{ kind: 'gateway', name: 'gateway · default', pid: 4242, status: 'current', detail: '0.9.9' }],
  detail: null
}

const lifecycleFixture: LifecycleResult = {
  ok: true,
  action: 'stop',
  pid: 9001,
  log: 'gateway-stop.log',
  detail: null
}

const sessionListFixture: SessionList = {
  source: 'db',
  total: 2,
  detail: null,
  sessions: [
    {
      id: 'sess-alpha',
      title: 'Alpha debugging',
      source: 'desktop',
      model: 'test/model-a',
      started_at: '2026-09-20T10:00:00Z',
      last_activity_at: '2026-09-26T09:00:00Z',
      ended_at: null,
      message_count: 4,
      tool_call_count: 0,
      input_tokens: 10,
      output_tokens: 20,
      archived: false,
      profile: 'default'
    },
    {
      id: 'sess-beta',
      title: 'Beta notes',
      source: 'cli',
      model: 'test/model-b',
      started_at: '2026-09-21T11:00:00Z',
      last_activity_at: '2026-09-25T08:00:00Z',
      ended_at: null,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 5,
      output_tokens: 6,
      archived: true,
      profile: 'default'
    }
  ]
}

const messagesFixture: MessagePage = {
  source: 'db',
  session_id: 'sess-alpha',
  detail: null,
  messages: [
    {
      id: 1,
      session_id: 'sess-alpha',
      role: 'user',
      content: 'hello there',
      tool_name: null,
      tool_call_id: null,
      timestamp: '2026-09-20T10:00:01Z',
      display_kind: null,
      active: true,
      compacted: false
    },
    {
      id: 2,
      session_id: 'sess-alpha',
      role: 'assistant',
      content: 'hi! how can I help?',
      tool_name: null,
      tool_call_id: null,
      timestamp: '2026-09-20T10:00:05Z',
      display_kind: null,
      active: true,
      compacted: false
    }
  ]
}

const chatStreamFixture = [
  { type: 'manager.started', pid: 4242, session_id: null },
  { type: 'system', subtype: 'init', model: 'test/model-a', session_id: 'sess-new' },
  { type: 'text', text: 'hello ' },
  { type: 'text', text: 'world' },
  { type: 'result', session_id: 'sess-new', exit_code: 0, text: 'hello world', tokens: {} },
  { type: 'manager.done', exit_code: 0, session_id: 'sess-new' }
]

const configDocFixture: ConfigDocument = {
  source: 'files',
  path: 'C:\\hermes\\config.yaml',
  config: {
    model: 'openrouter/test-model',
    telemetry: false,
    terminal: { backend: 'vte' },
    approvals: { mode: 'auto' }
  },
  defaults: null,
  fields: [
    { path: 'approvals.mode', type: 'string', category: 'approvals', description: null, enum: null },
    { path: 'model', type: 'string', category: 'model', description: null, enum: null },
    { path: 'telemetry', type: 'boolean', category: 'telemetry', description: null, enum: null },
    { path: 'terminal.backend', type: 'string', category: 'terminal', description: null, enum: null }
  ],
  detail: null
}

const envReportFixture: EnvReport = {
  source: 'files',
  path: 'C:\\hermes\\.env',
  detail: null,
  rows: [
    {
      key: 'OPENROUTER_API_KEY',
      value: 'sk-o...7890',
      is_set: true,
      is_secret: true,
      category: 'provider',
      description: null
    },
    {
      key: 'WEB_TOOLS_DEBUG',
      value: 'true',
      is_set: true,
      is_secret: false,
      category: 'tool',
      description: null
    }
  ]
}

const configDiffFixture: ConfigDiff = {
  source: 'files',
  detail: null,
  changes: [
    {
      kind: 'config',
      path: 'model',
      action: 'set',
      current: '"openrouter/test-model"',
      next: '"openrouter/new-model"',
      type: 'string'
    },
    {
      kind: 'env',
      path: 'WEB_TOOLS_DEBUG',
      action: 'set',
      current: 'true',
      next: 'false',
      type: 'string'
    }
  ]
}

const configApplyFixture: ConfigApplyResult = {
  ok: true,
  applied: configDiffFixture.changes,
  backups: ['C:\\hermes\\backups\\config\\config.yaml.mgr-20260928-120000'],
  warnings: [],
  detail: null
}

const updateReportFixture: UpdateReport = {
  source: 'files',
  identity: { version: '0.21.5', sha: 'bbbbbbbbbbbb2222222222', source: 'receipt' },
  receipt: {
    outcome: 'success',
    started_at: '2026-09-26T10:00:00Z',
    finished_at: '2026-09-26T10:02:00Z',
    pre_sha: 'aaaaaaaaaaaa1111111111',
    post_sha: 'bbbbbbbbbbbb2222222222',
    post_version: '0.21.5',
    steps_ok: 2,
    steps_failed: 1,
    path: 'C:\\hermes\\logs\\update_receipts\\latest.json',
    detail: null
  },
  running: false,
  pid: null,
  log: null,
  detail: null
}

const updateCheckFixture: UpdateCheckResult = {
  supported: false,
  update_available: false,
  behind: null,
  branch: null,
  commits: [],
  detail: 'update check unavailable: no deep layer'
}

const updateApplyFixture: UpdateApplyResult = { ok: true, pid: 777, log: 'manager-update.log', detail: null }

const backupReportFixture: BackupReport = {
  source: 'files',
  detail: null,
  items: [
    {
      kind: 'config',
      name: 'config.yaml.good.20260922-120000',
      path: 'C:\\hermes\\backups\\config\\config.yaml.good.20260922-120000',
      size: 6400,
      modified: '2026-09-22T12:00:00+00:00'
    },
    {
      kind: 'full',
      name: 'hermes-backup-2026-08-25-101431-abc123.zip',
      path: 'C:\\hermes\\backups\\hermes-backup-2026-08-25-101431-abc123.zip',
      size: 420167367,
      modified: '2026-08-25T10:14:31+00:00'
    },
    {
      kind: 'snapshot',
      name: '20260928_100000',
      path: 'C:\\hermes\\state-snapshots\\20260928_100000',
      size: 1024,
      modified: '2026-09-28T10:00:00+00:00'
    },
    {
      kind: 'state-db',
      name: 'state.db.pre-update-emergency-2026-09-19T23-09-42-292Z.bak',
      path: 'C:\\hermes\\state.db.pre-update-emergency-2026-09-19T23-09-42-292Z.bak',
      size: 366526464,
      modified: '2026-09-19T23:09:42+00:00'
    }
  ]
}

const restorePreviewFixture: ConfigRestorePreview = {
  ok: true,
  backup: 'C:\\hermes\\backups\\config\\config.yaml.good.20260922-120000',
  detail: null,
  changes: [
    {
      kind: 'config',
      path: 'model',
      action: 'set',
      current: '"openrouter/test-model"',
      next: '"openrouter/old-model"',
      type: null
    }
  ]
}

const restoreResultFixture: ConfigRestoreResult = {
  ok: true,
  backup: 'C:\\hermes\\backups\\config\\config.yaml.good.20260922-120000',
  created_backup: 'C:\\hermes\\backups\\config\\config.yaml.mgr-20260928-130000',
  detail: null
}

const backupCreateFixture: BackupCreateResult = {
  ok: false,
  pid: null,
  log: null,
  path: null,
  detail: 'quick snapshot unavailable: no deep layer'
}

const mcpReportFixture: McpReport = {
  source: 'files',
  detail: null,
  servers: [
    {
      name: 'webbuilder',
      transport: 'stdio',
      command: 'node',
      args: ['C:/tools/cli.js'],
      url: null,
      enabled: true,
      timeout: 120,
      connect_timeout: null
    }
  ]
}

const mcpTestFixture: McpTestResult = { ok: true, pid: 4321, log: 'manager-mcp-test.log', detail: null }

const skillCatalogFixture: SkillList = {
  source: 'files',
  total: 3,
  offset: 0,
  limit: 50,
  query: null,
  disabled_count: 1,
  detail: null,
  skills: [
    { name: 'alpha-skill', description: 'Alpha tooling helper', enabled: true },
    { name: 'beta-skill', description: 'Beta helper', enabled: false },
    { name: 'gamma-skill', description: 'Gamma helper', enabled: true }
  ]
}

const cronReportFixture: CronReport = {
  source: 'files',
  updated_at: '2026-09-28T10:00:00Z',
  detail: null,
  jobs: [
    {
      id: 'job-1',
      name: 'nightly-sync',
      schedule: 'every 30m',
      enabled: true,
      state: 'scheduled',
      last_status: 'ok',
      last_run_at: '2026-09-28T09:30:00Z',
      next_run_at: '2026-09-28T10:00:00Z',
      no_agent: true,
      script: 'sync.py',
      prompt: null
    }
  ]
}

const cronActionFixture: CronActionResult = { ok: true, pid: 555, log: 'manager-cron.log', detail: null }

const pluginReportFixture: PluginReport = {
  source: 'files',
  catalog_count: 2,
  detail: null,
  plugins: [
    { name: 'browser', source: 'bundled', enabled: true, description: null },
    { name: 'kanban', source: 'bundled', enabled: true, description: null }
  ]
}

const modelsReportFixture: LocalModelsReport = {
  source: 'files',
  ollama_running: false,
  ollama_models: [],
  detail: 'ollama server not responding on :11434',
  gguf: [{ name: 'test-model.gguf', size: 1_048_576, details: 'local gguf' }]
}

function ndjsonResponse(events: unknown[]): Response {
  const encoder = new TextEncoder()
  const payload = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    }
  })
  return { ok: true, status: 200, body: stream, json: async () => ({}) } as unknown as Response
}

const originalFetch = globalThis.fetch

function installBridge(): void {
  ;(window as unknown as { hermes: unknown }).hermes = {
    bridgeInfo: async () => bridgeInfo,
    bridgeState: async () => ({ status: 'ready', info: bridgeInfo, lastError: null }),
    startBridge: async () => bridgeInfo,
    restartBridge: async () => bridgeInfo,
    openExternal: async () => undefined,
    readSettings: async () => ({}),
    writeSettings: async () => ({}),
    detectHermesHome: async () => null,
    pickHermesHome: async () => null,
    onBridgeLog: () => () => undefined,
    onHermesHomeMissing: () => () => undefined
  }
}

function mockFetchByPath(): void {
  const deletedPaths = new Set<string>()
  const disabledSkills = new Set<string>(['beta-skill'])
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'POST' && url.includes('/chat')) {
      if (url.includes('/abort')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) } as Response)
      return Promise.resolve(ndjsonResponse(chatStreamFixture))
    }
    let payload: unknown
    if (method === 'POST' && url.includes('/gateway/lifecycle')) payload = lifecycleFixture
    else if (method === 'POST' && url.includes('/updates/check')) payload = updateCheckFixture
    else if (method === 'POST' && url.includes('/updates/apply')) payload = updateApplyFixture
    else if (url.includes('/updates')) payload = updateReportFixture
    else if (method === 'POST' && url.includes('/backups/config/preview')) payload = restorePreviewFixture
    else if (method === 'POST' && url.includes('/backups/config/restore')) payload = restoreResultFixture
    else if (method === 'POST' && url.includes('/backups/create')) payload = backupCreateFixture
    else if (method === 'POST' && url.includes('/backups/delete')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { path?: string }
      if (body.path) deletedPaths.add(body.path)
      payload = { ok: true, path: body.path ?? '', detail: null }
    } else if (url.includes('/backups')) {
      payload = {
        ...backupReportFixture,
        items: backupReportFixture.items.filter((item) => !deletedPaths.has(item.path))
      }
    } else if (method === 'POST' && url.includes('/tools/mcp/test')) {
      payload = mcpTestFixture
    } else if (method === 'POST' && url.includes('/tools/skills/toggle')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name: string; enable: boolean }
      if (body.enable) disabledSkills.delete(body.name)
      else disabledSkills.add(body.name)
      payload = { ok: true, disabled: [...disabledSkills], detail: null } satisfies SkillToggleResult
    } else if (method === 'POST' && url.includes('/tools/cron/action')) {
      payload = cronActionFixture
    } else if (url.includes('/tools/mcp')) {
      payload = mcpReportFixture
    } else if (url.includes('/tools/skills')) {
      payload = {
        ...skillCatalogFixture,
        disabled_count: disabledSkills.size,
        skills: skillCatalogFixture.skills.map((skill) => ({
          ...skill,
          enabled: !disabledSkills.has(skill.name)
        }))
      }
    } else if (url.includes('/tools/cron')) {
      payload = cronReportFixture
    } else if (url.includes('/tools/plugins')) {
      payload = pluginReportFixture
    } else if (url.includes('/tools/models')) {
      payload = modelsReportFixture
    } else if (method === 'POST' && url.includes('/config/diff')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        config?: { path: string; op?: string; value?: unknown }[]
        env?: { key: string; op?: string; value?: string | null }[]
      }
      payload = {
        source: 'files',
        detail: null,
        changes: [
          ...(body.config ?? []).map((change) => ({
            kind: 'config',
            path: change.path,
            action: change.op ?? 'set',
            current: null,
            next: change.value === undefined ? null : JSON.stringify(change.value),
            type: null
          })),
          ...(body.env ?? []).map((change) => ({
            kind: 'env',
            path: change.key,
            action: change.op ?? 'set',
            current: null,
            next: change.value ?? null,
            type: null
          }))
        ]
      }
    } else if (method === 'POST' && url.includes('/config/apply')) payload = configApplyFixture
    else if (url.includes('/config/env')) payload = envReportFixture
    else if (url.includes('/config')) payload = configDocFixture
    else if (url.includes('/gateway/fleet')) payload = fleetFixture
    else if (url.includes('/gateway')) payload = gatewayStatusFixture
    else if (url.includes('/processes')) payload = processesFixture
    else if (url.includes('/messages')) payload = messagesFixture
    else if (url.includes('/sessions')) payload = sessionListFixture
    else if (url.includes('/logs/tail')) payload = logTailFixture
    else if (url.includes('/logs')) payload = logFilesFixture
    else if (url.includes('/sources')) payload = sourcesFixture
    else payload = healthFixture
    return Promise.resolve({ ok: true, status: 200, json: async () => payload } as Response)
  }) as unknown as typeof fetch
}

describe('App shell', () => {
  beforeEach(() => {
    installBridge()
    mockFetchByPath()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('renders the navigation with every milestone completed', async () => {
    render(<App />)
    expect(screen.getByTestId('nav-overview')).toBeTruthy()
    expect(screen.getByTestId('nav-chat')).toBeTruthy()
    expect((screen.getByTestId('nav-chat') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('nav-config')).toBeTruthy()
    expect((screen.getByTestId('nav-config') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('nav-updates')).toBeTruthy()
    expect((screen.getByTestId('nav-updates') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('nav-backups')).toBeTruthy()
    expect((screen.getByTestId('nav-backups') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('nav-tools')).toBeTruthy()
    expect((screen.getByTestId('nav-tools') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText('M7')).toBeNull()
  })

  it('renders the data source matrix once health resolves', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('layer-matrix')).toBeTruthy(), { timeout: 3000 })
    const rows = screen.getAllByRole('row')
    expect(rows.length).toBeGreaterThanOrEqual(6)
    expect(screen.getByText('state.db')).toBeTruthy()
    expect(screen.getByText('34 tables')).toBeTruthy()
  })

  it('shows the status ribbon with the resolved runtime', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('status-ribbon')).toBeTruthy())
    await waitFor(() => {
      const ribbon = screen.getByTestId('status-ribbon')
      expect(ribbon.textContent).toMatch(/hermes-venv/)
    })
  })

  it('shows the active source for each feature domain', async () => {
    render(<App />)
    await screen.findByTestId('domain-grid', undefined, { timeout: 3000 })
    await waitFor(() => {
      const logs = document.querySelector('[data-domain="logs"]')
      expect(logs?.textContent).toContain('files')
      const sessions = document.querySelector('[data-domain="sessions"]')
      expect(sessions?.textContent).toContain('db')
    })
  })

  it('navigates to the log explorer and renders the tail', async () => {
    render(<App />)
    await screen.findByTestId('nav-logs')
    fireEvent.click(screen.getByTestId('nav-logs'))
    await screen.findByTestId('log-viewport', undefined, { timeout: 3000 })
    await waitFor(() => {
      expect(screen.getByText('agent.log')).toBeTruthy()
      expect(screen.getByText('API call #369: model=test')).toBeTruthy()
    })
    expect(screen.getByText('CRITICAL')).toBeTruthy()
  })

  it('renders gateway status, fleet and processes', async () => {
    render(<App />)
    fireEvent.click(await screen.findByTestId('nav-gateway'))
    const state = await screen.findByTestId('gateway-state', undefined, { timeout: 3000 })
    expect(state.textContent).toBe('running')
    await waitFor(() => {
      expect(screen.getByTestId('fleet-table').textContent).toContain('4242')
      expect(screen.getByTestId('process-list').textContent).toContain('gateway · default')
    })
    expect(screen.getByTestId('lifecycle-start').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('lifecycle-stop').hasAttribute('disabled')).toBe(false)
  })

  it('requires a second click before running a lifecycle action', async () => {
    render(<App />)
    fireEvent.click(await screen.findByTestId('nav-gateway'))
    await screen.findByTestId('gateway-actions', undefined, { timeout: 3000 })

    const stop = await screen.findByTestId('lifecycle-stop')
    fireEvent.click(stop)
    expect((await screen.findByTestId('lifecycle-stop')).textContent).toBe('Confirm stop?')

    fireEvent.click(screen.getByTestId('lifecycle-stop'))
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as unknown[]
      const post = calls.find(
        (call) => (call as [string, RequestInit])[1]?.method === 'POST' && String((call as [string, RequestInit])[0]).includes('/gateway/lifecycle')
      )
      expect(post).toBeTruthy()
    })
  })

  it('browses sessions and opens a transcript', async () => {
    render(<App />)
    fireEvent.click(await screen.findByTestId('nav-sessions'))
    await screen.findByTestId('sessions-list', undefined, { timeout: 3000 })
    await waitFor(() => {
      expect(screen.getByText('Alpha debugging')).toBeTruthy()
      expect(screen.getByText('Beta notes')).toBeTruthy()
    })

    const rows = screen.getAllByTestId('session-row')
    fireEvent.click(rows[0])
    await screen.findByTestId('messages-panel', undefined, { timeout: 3000 })
    await waitFor(() => {
      expect(screen.getByText('hello there')).toBeTruthy()
      expect(screen.getByText('hi! how can I help?')).toBeTruthy()
    })
  })

  it('streams a chat turn into the transcript', async () => {
    render(<App />)
    fireEvent.click(await screen.findByTestId('nav-chat'))
    const input = await screen.findByTestId('chat-input', undefined, { timeout: 3000 })

    fireEvent.change(input, { target: { value: 'Hello Hermes' } })
    fireEvent.click(screen.getByTestId('chat-send'))

    await waitFor(
      () => {
        const transcript = screen.getByTestId('chat-transcript')
        expect(transcript.textContent).toContain('Hello Hermes')
        expect(transcript.textContent).toContain('hello world')
      },
      { timeout: 3000 }
    )
    await waitFor(() => expect(screen.getByText('sess-new')).toBeTruthy())
  })

  it('edits config and env, reviews the diff, then applies', async () => {
    render(<App />)
    fireEvent.click(await screen.findByTestId('nav-config'))

    const modelField = (await screen.findByTestId('field-model', undefined, { timeout: 3000 })) as HTMLInputElement
    expect(modelField.value).toBe('openrouter/test-model')
    await waitFor(() => expect(screen.getByTestId('change-count').textContent).toBe('0 pending'))

    fireEvent.change(modelField, { target: { value: 'openrouter/new-model' } })
    await waitFor(() => expect(screen.getByTestId('change-count').textContent).toBe('1 pending'))

    fireEvent.click(screen.getByTestId('tab-env'))
    await waitFor(() => {
      expect(screen.getByTestId('env-key-OPENROUTER_API_KEY')).toBeTruthy()
      expect(screen.getByTestId('env-key-WEB_TOOLS_DEBUG')).toBeTruthy()
    })
    const debugField = screen.getByTestId('env-value-WEB_TOOLS_DEBUG') as HTMLInputElement
    expect(debugField.value).toBe('true')
    fireEvent.change(debugField, { target: { value: 'false' } })
    await waitFor(() => expect(screen.getByTestId('change-count').textContent).toBe('2 pending'))

    fireEvent.click(screen.getByTestId('review-changes'))
    const diffPanel = await screen.findByTestId('diff-panel', undefined, { timeout: 3000 })
    expect(diffPanel.textContent).toContain('2 change(s)')
    expect(screen.getAllByTestId('diff-row').length).toBe(2)

    fireEvent.click(screen.getByTestId('apply-confirm'))
    const result = await screen.findByTestId('config-result', undefined, { timeout: 3000 })
    expect(result.textContent).toContain('Applied 2 change(s)')
    await waitFor(() => expect(screen.getByTestId('change-count').textContent).toBe('0 pending'))
  })

  it('adds a new env variable through the review flow', async () => {
    render(<App />)
    fireEvent.click(await screen.findByTestId('nav-config'))
    await screen.findByTestId('field-model', undefined, { timeout: 3000 })

    fireEvent.click(screen.getByTestId('tab-env'))
    fireEvent.change(screen.getByTestId('env-add-key'), { target: { value: 'github_token' } })
    fireEvent.change(screen.getByTestId('env-add-value'), { target: { value: 'ghp_1234567890' } })
    fireEvent.click(screen.getByTestId('env-add-submit'))

    await waitFor(() => expect(screen.getByTestId('env-key-GITHUB_TOKEN')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('change-count').textContent).toBe('1 pending'))

    fireEvent.click(screen.getByTestId('review-changes'))
    const diffPanel = await screen.findByTestId('diff-panel', undefined, { timeout: 3000 })
    expect(diffPanel.textContent).toContain('GITHUB_TOKEN')
    expect(diffPanel.textContent).toContain('1 change(s)')
  })

  it('shows update status, runs a check, and spawns an update', async () => {
    render(<App />)
    fireEvent.click(await screen.findByTestId('nav-updates'))

    await waitFor(() => expect(screen.getByText('0.21.5')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByTestId('receipt-outcome').textContent).toBe('success')

    fireEvent.click(screen.getByTestId('check-updates'))
    const checkPanel = await screen.findByTestId('check-panel', undefined, { timeout: 3000 })
    expect(checkPanel.textContent).toContain('update check unavailable')

    fireEvent.click(screen.getByTestId('apply-update'))
    expect(screen.getByTestId('apply-update').textContent).toBe('Confirm update?')
    fireEvent.click(screen.getByTestId('apply-update'))
    await waitFor(
      () => expect(screen.getByTestId('update-note').textContent).toContain('manager-update.log'),
      { timeout: 3000 }
    )
  })

  it('lists backups, restores config via preview, and deletes items', async () => {
    render(<App />)
    fireEvent.click(await screen.findByTestId('nav-backups'))

    const table = await screen.findByTestId('backup-table', undefined, { timeout: 3000 })
    await waitFor(() => expect(table.querySelectorAll('tbody tr').length).toBe(4))

    fireEvent.click(screen.getByTestId('restore-config.yaml.good.20260922-120000'))
    const restorePanel = await screen.findByTestId('restore-panel', undefined, { timeout: 3000 })
    expect(restorePanel.textContent).toContain('model')
    expect(restorePanel.textContent).toContain('1 change(s)')
    fireEvent.click(screen.getByTestId('restore-confirm'))
    await waitFor(
      () => expect(screen.getByTestId('backup-note').textContent).toContain('config restored'),
      { timeout: 3000 }
    )

    const deleteButton = screen.getByTestId('delete-hermes-backup-2026-08-25-101431-abc123.zip')
    fireEvent.click(deleteButton)
    expect(deleteButton.textContent).toBe('Confirm?')
    fireEvent.click(deleteButton)
    await waitFor(
      () => expect(screen.getByTestId('backup-note').textContent).toContain('deleted hermes-backup'),
      { timeout: 3000 }
    )
    await waitFor(
      () =>
        expect(screen.queryByTestId('delete-hermes-backup-2026-08-25-101431-abc123.zip')).toBeNull(),
      { timeout: 3000 }
    )
  })

  it('browses MCP servers, runs a test, and toggles an entry through config', async () => {
    render(<App />)
    fireEvent.click(await screen.findByTestId('nav-tools'))

    await screen.findByTestId('mcp-table', undefined, { timeout: 3000 })
    await waitFor(() => expect(screen.getByTestId('mcp-webbuilder').textContent).toContain('node'))

    fireEvent.click(screen.getByTestId('mcp-test-webbuilder'))
    await waitFor(
      () => expect(screen.getByTestId('tools-note').textContent).toContain('manager-mcp-test.log'),
      { timeout: 3000 }
    )

    const toggle = screen.getByTestId('mcp-toggle-webbuilder')
    fireEvent.click(toggle)
    expect(screen.getByTestId('mcp-toggle-webbuilder').textContent).toBe('Confirm disable?')
    fireEvent.click(screen.getByTestId('mcp-toggle-webbuilder'))
    await waitFor(
      () => expect(screen.getByTestId('tools-note').textContent).toContain('webbuilder disabled'),
      { timeout: 3000 }
    )
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as unknown[]
    const apply = calls.find(
      (call) =>
        (call as [string, RequestInit])[1]?.method === 'POST' &&
        String((call as [string, RequestInit])[0]).includes('/config/apply')
    )
    expect(apply).toBeTruthy()
  })

  it('filters skills and toggles their persisted state', async () => {
    render(<App />)
    fireEvent.click(await screen.findByTestId('nav-tools'))

    fireEvent.click(await screen.findByTestId('tab-skills'))
    await screen.findByTestId('skill-table', undefined, { timeout: 3000 })
    await waitFor(() => expect(screen.getByTestId('skill-beta-skill').textContent).toContain('disabled'))
    expect(screen.getByTestId('skill-alpha-skill').textContent).toContain('enabled')

    fireEvent.click(screen.getByTestId('skill-toggle-alpha-skill'))
    await waitFor(
      () => expect(screen.getByTestId('tools-note').textContent).toContain('skills.disabled'),
      { timeout: 3000 }
    )
    await waitFor(() => expect(screen.getByTestId('skill-alpha-skill').textContent).toContain('disabled'))

    fireEvent.click(screen.getByTestId('skill-search-go'))
    await waitFor(() => expect(screen.getByTestId('skill-beta-skill')).toBeTruthy(), { timeout: 3000 })
  })

  it('drives cron jobs and inspects plugins and models', async () => {
    render(<App />)
    fireEvent.click(await screen.findByTestId('nav-tools'))

    fireEvent.click(await screen.findByTestId('tab-cron'))
    await screen.findByTestId('cron-table', undefined, { timeout: 3000 })
    await waitFor(() => expect(screen.getByTestId('cron-job-1').textContent).toContain('every 30m'))

    const run = screen.getByTestId('cron-run-job-1')
    fireEvent.click(run)
    expect(screen.getByTestId('cron-run-job-1').textContent).toBe('Confirm run?')
    fireEvent.click(screen.getByTestId('cron-run-job-1'))
    await waitFor(
      () => expect(screen.getByTestId('tools-note').textContent).toContain('manager-cron.log'),
      { timeout: 3000 }
    )

    fireEvent.click(screen.getByTestId('tab-plugins'))
    await screen.findByTestId('plugin-table', undefined, { timeout: 3000 })
    await waitFor(() => expect(screen.getByTestId('plugin-kanban').textContent).toContain('bundled'))

    fireEvent.click(screen.getByTestId('tab-models'))
    await screen.findByTestId('models-gguf', undefined, { timeout: 3000 })
    await waitFor(() => expect(screen.getByTestId('models-gguf').textContent).toContain('test-model.gguf'))
    expect(screen.getByTestId('models-ollama')).toBeTruthy()
    expect(screen.getByTestId('models-ollama').textContent).toContain('not responding')
  })
})
