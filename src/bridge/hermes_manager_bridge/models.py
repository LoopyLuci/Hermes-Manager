from __future__ import annotations

from typing import Any, Literal, TypeAlias

from pydantic import BaseModel, Field

SourceLayer: TypeAlias = Literal["rest", "files", "db", "cli", "deep"]
LayerState: TypeAlias = Literal["ready", "degraded", "unavailable"]

SOURCE_LAYERS: tuple[SourceLayer, ...] = ("rest", "files", "db", "cli", "deep")


class LayerStatus(BaseModel):
    state: LayerState
    detail: str
    origin: str
    latency_ms: float | None = None


class RuntimeInfo(BaseModel):
    python: str
    kind: str
    version: str


class HealthReport(BaseModel):
    ok: bool
    app: str
    app_version: str
    started_at: str
    uptime_s: float
    hermes_home: str | None
    hermes_repo: str | None
    runtime: RuntimeInfo
    layers: dict[SourceLayer, LayerStatus]


class SourceStatus(BaseModel):
    layers: dict[SourceLayer, LayerStatus]
    domains: dict[str, SourceLayer]


class ErrorBody(BaseModel):
    detail: str = Field(examples=["unauthorized"])


class Heartbeat(BaseModel):
    type: Literal["heartbeat"] = "heartbeat"
    at: str
    uptime_s: float


class LogFile(BaseModel):
    name: str
    size: int
    modified: str
    rotated: bool


class LogEntry(BaseModel):
    ts: str | None = None
    level: str | None = None
    session: str | None = None
    logger: str | None = None
    message: str
    raw: str
    seq: int


class LogBatch(BaseModel):
    file: str
    entries: list[LogEntry]
    offset: int
    truncated: bool = False


class LogFollowEvent(BaseModel):
    type: Literal["log"] = "log"
    file: str
    entries: list[LogEntry]
    offset: int
    rotated: bool = False


class GatewayIdentity(BaseModel):
    kind: str | None = None
    pid: int | None = None
    start_time: float | None = None
    profile: str | None = None
    supervisor: str | None = None
    code_sha: str | None = None
    code_version: str | None = None
    hermes_home: str | None = None
    served_profiles: list[str] = Field(default_factory=list)


class GatewayStateInfo(BaseModel):
    state: str | None = None
    pid: int | None = None
    updated_at: str | None = None
    active_agents: int | None = None
    active_work: int | None = None
    served_profiles: list[str] = Field(default_factory=list)
    exit_reason: str | None = None
    restart_requested: bool | None = None
    code_sha: str | None = None
    code_version: str | None = None


class GatewayStatus(BaseModel):
    source: SourceLayer
    running: bool
    drain_requested: bool = False
    identity: GatewayIdentity | None = None
    state: GatewayStateInfo | None = None
    detail: str | None = None


class FleetRow(BaseModel):
    profile: str = "default"
    pid: int | None = None
    state: str = "unknown"
    code_sha: str | None = None
    code_version: str | None = None
    code_root: str | None = None
    served_profiles: list[str] = Field(default_factory=list)


class FleetReport(BaseModel):
    source: SourceLayer
    rows: list[FleetRow]
    detail: str | None = None


class ProcessInfo(BaseModel):
    kind: Literal["gateway", "background", "action"]
    name: str
    pid: int | None = None
    status: str = "unknown"
    detail: str | None = None


class ProcessReport(BaseModel):
    source: SourceLayer
    processes: list[ProcessInfo]
    detail: str | None = None


class LifecycleRequest(BaseModel):
    action: Literal["start", "stop", "restart"]


class LifecycleResult(BaseModel):
    ok: bool
    action: str
    pid: int | None = None
    log: str | None = None
    detail: str | None = None


class DrainRequest(BaseModel):
    action: Literal["drain", "cancel"]


class DrainResult(BaseModel):
    ok: bool
    action: str
    drain_requested: bool
    source: SourceLayer
    detail: str | None = None


class SessionSummary(BaseModel):
    id: str
    title: str | None = None
    source: str | None = None
    model: str | None = None
    started_at: str | None = None
    last_activity_at: str | None = None
    ended_at: str | None = None
    message_count: int | None = None
    tool_call_count: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    archived: bool = False
    profile: str | None = None


class SessionList(BaseModel):
    source: SourceLayer
    sessions: list[SessionSummary]
    total: int
    detail: str | None = None


class ChatMessage(BaseModel):
    id: int
    session_id: str
    role: str
    content: Any
    tool_name: str | None = None
    tool_call_id: str | None = None
    timestamp: str | None = None
    display_kind: str | None = None
    active: bool = True
    compacted: bool = False


class MessagePage(BaseModel):
    source: SourceLayer
    session_id: str
    messages: list[ChatMessage]
    detail: str | None = None


class ChatRequest(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)
    session_id: str | None = Field(default=None, description="Resume this session; omit to start a new one")
    chat_id: str | None = Field(default=None, description="Client correlation id used for abort")


class ChatAbort(BaseModel):
    chat_id: str


class ConfigField(BaseModel):
    path: str
    type: str
    category: str | None = None
    description: str | None = None
    enum: list[Any] | None = None


class ConfigDocument(BaseModel):
    source: SourceLayer
    path: str
    config: dict[str, Any] = Field(default_factory=dict)
    defaults: dict[str, Any] | None = None
    fields: list[ConfigField] = Field(default_factory=list)
    detail: str | None = None


class EnvRow(BaseModel):
    key: str
    value: str | None = None
    is_set: bool = False
    is_secret: bool = False
    category: str | None = None
    description: str | None = None


class EnvReport(BaseModel):
    source: SourceLayer
    path: str
    rows: list[EnvRow] = Field(default_factory=list)
    detail: str | None = None


class ConfigChange(BaseModel):
    path: str
    value: Any = None
    op: Literal["set", "delete"] = "set"


class EnvChange(BaseModel):
    key: str
    value: str | None = None
    op: Literal["set", "delete"] = "set"


class ConfigEditRequest(BaseModel):
    config: list[ConfigChange] = Field(default_factory=list)
    env: list[EnvChange] = Field(default_factory=list)


class ChangePreview(BaseModel):
    kind: Literal["config", "env"]
    path: str
    action: Literal["set", "delete"]
    current: str | None = None
    next: str | None = None
    type: str | None = None


class ConfigDiff(BaseModel):
    source: SourceLayer
    changes: list[ChangePreview] = Field(default_factory=list)
    detail: str | None = None


class ConfigApplyResult(BaseModel):
    ok: bool
    applied: list[ChangePreview] = Field(default_factory=list)
    backups: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    detail: str | None = None


class CodeIdentity(BaseModel):
    version: str | None = None
    sha: str | None = None
    source: str | None = None


class UpdateReceiptSummary(BaseModel):
    outcome: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    pre_sha: str | None = None
    post_sha: str | None = None
    post_version: str | None = None
    steps_ok: int = 0
    steps_failed: int = 0
    path: str | None = None
    detail: str | None = None


class UpdateReport(BaseModel):
    source: SourceLayer
    identity: CodeIdentity
    receipt: UpdateReceiptSummary | None = None
    running: bool = False
    pid: int | None = None
    log: str | None = None
    detail: str | None = None


class UpdateCheckResult(BaseModel):
    supported: bool
    update_available: bool = False
    behind: int | None = None
    branch: str | None = None
    commits: list[str] = Field(default_factory=list)
    detail: str | None = None


class UpdateApplyRequest(BaseModel):
    branch: str | None = None
    yes: bool = True


class UpdateApplyResult(BaseModel):
    ok: bool
    pid: int | None = None
    log: str | None = None
    detail: str | None = None


class BackupItem(BaseModel):
    kind: str
    name: str
    path: str
    size: int
    modified: str


class BackupReport(BaseModel):
    source: SourceLayer
    items: list[BackupItem] = Field(default_factory=list)
    detail: str | None = None


class BackupCreateRequest(BaseModel):
    mode: Literal["snapshot", "full"] = "snapshot"


class BackupCreateResult(BaseModel):
    ok: bool
    pid: int | None = None
    log: str | None = None
    path: str | None = None
    detail: str | None = None


class BackupTargetRequest(BaseModel):
    path: str


class BackupDeleteResult(BaseModel):
    ok: bool
    path: str
    detail: str | None = None


class ConfigRestoreRequest(BaseModel):
    path: str


class ConfigRestorePreview(BaseModel):
    ok: bool
    backup: str
    changes: list[ChangePreview] = Field(default_factory=list)
    detail: str | None = None


class ConfigRestoreResult(BaseModel):
    ok: bool
    backup: str
    created_backup: str | None = None
    detail: str | None = None


class McpServer(BaseModel):
    name: str
    transport: str = "stdio"
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    url: str | None = None
    enabled: bool = True
    timeout: float | None = None
    connect_timeout: float | None = None


class McpReport(BaseModel):
    source: SourceLayer
    servers: list[McpServer] = Field(default_factory=list)
    detail: str | None = None


class McpTestRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class McpTestResult(BaseModel):
    ok: bool
    pid: int | None = None
    log: str | None = None
    detail: str | None = None


class SkillEntry(BaseModel):
    name: str
    description: str | None = None
    enabled: bool = True


class SkillList(BaseModel):
    source: SourceLayer
    total: int = 0
    offset: int = 0
    limit: int = 0
    query: str | None = None
    skills: list[SkillEntry] = Field(default_factory=list)
    disabled_count: int = 0
    detail: str | None = None


class SkillToggleRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    enable: bool = True


class SkillToggleResult(BaseModel):
    ok: bool
    disabled: list[str] = Field(default_factory=list)
    detail: str | None = None


class CronJobSummary(BaseModel):
    id: str
    name: str | None = None
    schedule: str | None = None
    enabled: bool = True
    state: str | None = None
    last_status: str | None = None
    last_run_at: str | None = None
    next_run_at: str | None = None
    no_agent: bool = False
    script: str | None = None
    prompt: str | None = None


class CronReport(BaseModel):
    source: SourceLayer
    jobs: list[CronJobSummary] = Field(default_factory=list)
    updated_at: str | None = None
    detail: str | None = None


class CronActionRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=200)
    action: Literal["pause", "resume", "run"]


class CronActionResult(BaseModel):
    ok: bool
    pid: int | None = None
    log: str | None = None
    detail: str | None = None


class PluginEntry(BaseModel):
    name: str
    source: str
    enabled: bool = False
    description: str | None = None


class PluginReport(BaseModel):
    source: SourceLayer
    plugins: list[PluginEntry] = Field(default_factory=list)
    catalog_count: int = 0
    detail: str | None = None


class LocalModel(BaseModel):
    name: str
    size: int | None = None
    details: str | None = None


class LocalModelsReport(BaseModel):
    source: SourceLayer
    ollama_running: bool = False
    ollama_models: list[LocalModel] = Field(default_factory=list)
    gguf: list[LocalModel] = Field(default_factory=list)
    detail: str | None = None
