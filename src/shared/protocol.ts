export const BRIDGE_API_BASE = '/api/v1'

/** Layers the bridge can read Hermes state from, in preference order. */
export type SourceLayer = 'rest' | 'files' | 'db' | 'cli' | 'deep'

export type LayerState = 'ready' | 'degraded' | 'unavailable'

export interface LayerStatus {
  state: LayerState
  detail: string
  /** Endpoint, path or module that backs this layer. */
  origin: string
  latency_ms: number | null
}

export interface RuntimeInfo {
  python: string
  kind: 'hermes-venv' | 'store' | 'fallback-venv' | 'unknown'
  version: string
}

export interface HealthReport {
  ok: boolean
  app: string
  app_version: string
  started_at: string
  uptime_s: number
  hermes_home: string
  hermes_repo: string | null
  runtime: RuntimeInfo
  layers: Record<SourceLayer, LayerStatus>
}

export interface SourceStatus {
  layers: Record<SourceLayer, LayerStatus>
  /** Which layer currently wins for each feature domain. */
  domains: Record<string, SourceLayer>
}

export interface BridgeInfo {
  url: string
  token: string
  pid: number
}

export interface BridgeStateDto {
  status: 'stopped' | 'starting' | 'ready' | 'failed'
  info: BridgeInfo | null
  lastError: string | null
  health: HealthReport | null
}

export type StreamEvent =
  | { type: 'heartbeat'; at: string; uptime_s: number }
  | { type: 'layers'; layers: Record<SourceLayer, LayerStatus> }

export interface LogFile {
  name: string
  size: number
  modified: string
  rotated: boolean
}

export interface LogEntry {
  ts: string | null
  level: string | null
  session: string | null
  logger: string | null
  message: string
  raw: string
  seq: number
}

export interface LogBatch {
  file: string
  entries: LogEntry[]
  offset: number
  truncated: boolean
}

export interface LogFollowEvent {
  type: 'log'
  file: string
  entries: LogEntry[]
  offset: number
  rotated: boolean
}

export interface GatewayIdentity {
  kind: string | null
  pid: number | null
  start_time: number | null
  profile: string | null
  supervisor: string | null
  code_sha: string | null
  code_version: string | null
  hermes_home: string | null
  served_profiles: string[]
}

export interface GatewayStateInfo {
  state: string | null
  pid: number | null
  updated_at: string | null
  active_agents: number | null
  active_work: number | null
  served_profiles: string[]
  exit_reason: string | null
  restart_requested: boolean | null
  code_sha: string | null
  code_version: string | null
}

export interface GatewayStatus {
  source: SourceLayer
  running: boolean
  drain_requested: boolean
  identity: GatewayIdentity | null
  state: GatewayStateInfo | null
  detail: string | null
}

export interface FleetRow {
  profile: string
  pid: number | null
  state: string
  code_sha: string | null
  code_version: string | null
  code_root: string | null
  served_profiles: string[]
}

export interface FleetReport {
  source: SourceLayer
  rows: FleetRow[]
  detail: string | null
}

export interface ProcessInfo {
  kind: 'gateway' | 'background' | 'action'
  name: string
  pid: number | null
  status: string
  detail: string | null
}

export interface ProcessReport {
  source: SourceLayer
  processes: ProcessInfo[]
  detail: string | null
}

export type LifecycleAction = 'start' | 'stop' | 'restart'
export type DrainAction = 'drain' | 'cancel'

export interface LifecycleResult {
  ok: boolean
  action: string
  pid: number | null
  log: string | null
  detail: string | null
}

export interface DrainResult {
  ok: boolean
  action: string
  drain_requested: boolean
  source: SourceLayer
  detail: string | null
}

export interface SessionSummary {
  id: string
  title: string | null
  source: string | null
  model: string | null
  started_at: string | null
  last_activity_at: string | null
  ended_at: string | null
  message_count: number | null
  tool_call_count: number | null
  input_tokens: number | null
  output_tokens: number | null
  archived: boolean
  profile: string | null
}

export interface SessionList {
  source: SourceLayer
  sessions: SessionSummary[]
  total: number
  detail: string | null
}

export interface ChatMessage {
  id: number
  session_id: string
  role: string
  content: string | Record<string, unknown> | unknown[] | null
  tool_name: string | null
  tool_call_id: string | null
  timestamp: string | null
  display_kind: string | null
  active: boolean
  compacted: boolean
}

export interface MessagePage {
  source: SourceLayer
  session_id: string
  messages: ChatMessage[]
  detail: string | null
}

/** Newline-delimited events streamed from POST /api/v1/chat. */
export type ChatEvent =
  | { type: 'manager.started'; pid: number; session_id: string | null }
  | { type: 'manager.done'; exit_code: number | null; session_id: string | null }
  | { type: 'manager.error'; detail: string; stderr?: string[] }
  | { type: 'manager.log'; line: string }
  | { type: 'system'; subtype: string; model?: string; session_id?: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input?: unknown }
  | { type: 'tool_result'; name: string; output?: string; is_error?: boolean }
  | {
      type: 'result'
      session_id?: string
      exit_code?: number
      text?: string
      tokens?: unknown
      error?: string
    }
  | { type: string; [key: string]: unknown }

export interface ConfigField {
  path: string
  type: string
  category: string | null
  description: string | null
  enum: unknown[] | null
}

export interface ConfigDocument {
  source: SourceLayer
  path: string
  config: Record<string, unknown>
  defaults: Record<string, unknown> | null
  fields: ConfigField[]
  detail: string | null
}

export interface EnvRow {
  key: string
  value: string | null
  is_set: boolean
  is_secret: boolean
  category: string | null
  description: string | null
}

export interface EnvReport {
  source: SourceLayer
  path: string
  rows: EnvRow[]
  detail: string | null
}

export interface ConfigChange {
  path: string
  value?: unknown
  op?: 'set' | 'delete'
}

export interface EnvChange {
  key: string
  value?: string | null
  op?: 'set' | 'delete'
}

export interface ConfigEditRequest {
  config: ConfigChange[]
  env: EnvChange[]
}

export interface ChangePreview {
  kind: 'config' | 'env'
  path: string
  action: 'set' | 'delete'
  current: string | null
  next: string | null
  type: string | null
}

export interface ConfigDiff {
  source: SourceLayer
  changes: ChangePreview[]
  detail: string | null
}

export interface ConfigApplyResult {
  ok: boolean
  applied: ChangePreview[]
  backups: string[]
  warnings: string[]
  detail: string | null
}

export interface CodeIdentity {
  version: string | null
  sha: string | null
  source: string | null
}

export interface UpdateReceiptSummary {
  outcome: string | null
  started_at: string | null
  finished_at: string | null
  pre_sha: string | null
  post_sha: string | null
  post_version: string | null
  steps_ok: number
  steps_failed: number
  path: string | null
  detail: string | null
}

export interface UpdateReport {
  source: SourceLayer
  identity: CodeIdentity
  receipt: UpdateReceiptSummary | null
  running: boolean
  pid: number | null
  log: string | null
  detail: string | null
}

export interface UpdateCheckResult {
  supported: boolean
  update_available: boolean
  behind: number | null
  branch: string | null
  commits: string[]
  detail: string | null
}

export interface UpdateApplyResult {
  ok: boolean
  pid: number | null
  log: string | null
  detail: string | null
}

export interface BackupItem {
  kind: string
  name: string
  path: string
  size: number
  modified: string
}

export interface BackupReport {
  source: SourceLayer
  items: BackupItem[]
  detail: string | null
}

export interface BackupCreateResult {
  ok: boolean
  pid: number | null
  log: string | null
  path: string | null
  detail: string | null
}

export interface BackupDeleteResult {
  ok: boolean
  path: string
  detail: string | null
}

export interface ConfigRestorePreview {
  ok: boolean
  backup: string
  changes: ChangePreview[]
  detail: string | null
}

export interface ConfigRestoreResult {
  ok: boolean
  backup: string
  created_backup: string | null
  detail: string | null
}

export interface McpServer {
  name: string
  transport: string
  command: string | null
  args: string[]
  url: string | null
  enabled: boolean
  timeout: number | null
  connect_timeout: number | null
}

export interface McpReport {
  source: SourceLayer
  servers: McpServer[]
  detail: string | null
}

export interface McpTestResult {
  ok: boolean
  pid: number | null
  log: string | null
  detail: string | null
}

export interface SkillEntry {
  name: string
  description: string | null
  enabled: boolean
}

export interface SkillList {
  source: SourceLayer
  total: number
  offset: number
  limit: number
  query: string | null
  skills: SkillEntry[]
  disabled_count: number
  detail: string | null
}

export interface SkillToggleResult {
  ok: boolean
  disabled: string[]
  detail: string | null
}

export interface CronJobSummary {
  id: string
  name: string | null
  schedule: string | null
  enabled: boolean
  state: string | null
  last_status: string | null
  last_run_at: string | null
  next_run_at: string | null
  no_agent: boolean
  script: string | null
  prompt: string | null
}

export interface CronReport {
  source: SourceLayer
  jobs: CronJobSummary[]
  updated_at: string | null
  detail: string | null
}

export interface CronActionResult {
  ok: boolean
  pid: number | null
  log: string | null
  detail: string | null
}

export interface PluginEntry {
  name: string
  source: string
  enabled: boolean
  description: string | null
}

export interface PluginReport {
  source: SourceLayer
  plugins: PluginEntry[]
  catalog_count: number
  detail: string | null
}

export interface LocalModel {
  name: string
  size: number | null
  details: string | null
}

export interface LocalModelsReport {
  source: SourceLayer
  ollama_running: boolean
  ollama_models: LocalModel[]
  gguf: LocalModel[]
  detail: string | null
}
