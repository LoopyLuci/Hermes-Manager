import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CronReport,
  LocalModelsReport,
  McpReport,
  PluginReport,
  SkillList,
} from '@shared/protocol'
import { bridgeApi } from '../../lib/bridge-api'

type TabId = 'mcp' | 'skills' | 'cron' | 'plugins' | 'models'

const TABS: { id: TabId; label: string }[] = [
  { id: 'mcp', label: 'MCP servers' },
  { id: 'skills', label: 'Skills' },
  { id: 'cron', label: 'Cron' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'models', label: 'Local models' },
]

function formatSize(bytes: number | null): string {
  if (bytes == null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function ToolsPage(): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('mcp')
  const [mcp, setMcp] = useState<McpReport | null>(null)
  const [skills, setSkills] = useState<SkillList | null>(null)
  const [skillQuery, setSkillQuery] = useState('')
  const [skillOffset, setSkillOffset] = useState(0)
  const [cron, setCron] = useState<CronReport | null>(null)
  const [plugins, setPlugins] = useState<PluginReport | null>(null)
  const [models, setModels] = useState<LocalModelsReport | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const aliveRef = useRef(true)

  const load = useCallback(
    async (target: TabId, options?: { query?: string; offset?: number }): Promise<void> => {
      setLoading(target)
      setError(null)
      const absorbDetail = (detail: string | null): void => {
        if (detail) setNote((previous) => previous ?? detail)
      }
      try {
        if (target === 'mcp') {
          const next = await bridgeApi.mcpList()
          if (!aliveRef.current) return
          setMcp(next)
          absorbDetail(next.detail)
        } else if (target === 'skills') {
          const next = await bridgeApi.skillsList(options?.query, options?.offset ?? 0)
          if (!aliveRef.current) return
          setSkills(next)
          absorbDetail(next.detail)
        } else if (target === 'cron') {
          const next = await bridgeApi.cronList()
          if (!aliveRef.current) return
          setCron(next)
          absorbDetail(next.detail)
        } else if (target === 'plugins') {
          const next = await bridgeApi.pluginsList()
          if (!aliveRef.current) return
          setPlugins(next)
          absorbDetail(next.detail)
        } else {
          const next = await bridgeApi.modelsList()
          if (!aliveRef.current) return
          setModels(next)
          absorbDetail(next.detail)
        }
      } catch (cause) {
        if (!aliveRef.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (aliveRef.current) setLoading(null)
      }
    },
    [],
  )

  useEffect(() => {
    aliveRef.current = true
    void load('mcp')
    return () => {
      aliveRef.current = false
    }
  }, [load])

  const guard = (cause: unknown): void => {
    if (!aliveRef.current) return
    setError(cause instanceof Error ? cause.message : String(cause))
  }

  const runMcpTest = async (name: string): Promise<void> => {
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      const result = await bridgeApi.mcpTest(name)
      if (!aliveRef.current) return
      if (result.ok) {
        setNote(
          `test spawned (pid ${result.pid ?? '?'}) — tail ${result.log ?? 'manager-mcp-test.log'}`,
        )
      } else {
        setError(result.detail ?? 'mcp test failed to start')
      }
    } catch (cause) {
      guard(cause)
    } finally {
      setBusy(false)
    }
  }

  const toggleMcpEnabled = async (name: string, enabled: boolean): Promise<void> => {
    const key = `mcp:${name}`
    if (confirming !== key) {
      setConfirming(key)
      return
    }
    setConfirming(null)
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      const result = await bridgeApi.configApply({
        config: [{ path: `mcp_servers.${name}.enabled`, value: enabled }],
        env: [],
      })
      if (!aliveRef.current) return
      if (result.ok) {
        setNote(`${name} ${enabled ? 'enabled' : 'disabled'} in config.yaml`)
        await load('mcp')
      } else {
        setError(result.detail ?? 'config change failed')
      }
    } catch (cause) {
      guard(cause)
    } finally {
      setBusy(false)
    }
  }

  const runSkillsSearch = async (query: string): Promise<void> => {
    setSkillQuery(query)
    setSkillOffset(0)
    await load('skills', { query, offset: 0 })
  }

  const runSkillsPage = async (offset: number): Promise<void> => {
    setSkillOffset(offset)
    await load('skills', { query: skillQuery, offset })
  }

  const toggleSkill = async (name: string, enable: boolean): Promise<void> => {
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      const result = await bridgeApi.skillsToggle(name, enable)
      if (!aliveRef.current) return
      if (result.ok) {
        setNote(
          `skill ${name} ${enable ? 'enabled' : 'disabled'} — skills.disabled now has ${result.disabled.length} entr${result.disabled.length === 1 ? 'y' : 'ies'}`,
        )
        await load('skills', { query: skillQuery, offset: skillOffset })
      } else {
        setError(result.detail ?? 'skill toggle failed')
      }
    } catch (cause) {
      guard(cause)
    } finally {
      setBusy(false)
    }
  }

  const runCronAction = async (
    jobId: string,
    action: 'pause' | 'resume' | 'run',
  ): Promise<void> => {
    if (action === 'run') {
      const key = `cron:${jobId}`
      if (confirming !== key) {
        setConfirming(key)
        return
      }
      setConfirming(null)
    }
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      const result = await bridgeApi.cronAction(jobId, action)
      if (!aliveRef.current) return
      if (result.ok) {
        setNote(
          `${action} ${jobId} spawned (pid ${result.pid ?? '?'}) — tail ${result.log ?? 'manager-cron.log'}`,
        )
        await load('cron')
      } else {
        setError(result.detail ?? `cron ${action} failed`)
      }
    } catch (cause) {
      guard(cause)
    } finally {
      setBusy(false)
    }
  }

  const showNote = note ? (
    <span className="panel-note" role="status" data-testid="tools-note">
      {note}
    </span>
  ) : null
  const showError = error ? (
    <span className="ribbon-error" role="alert" data-testid="tools-error">
      {error}
    </span>
  ) : null

  const renderMcp = (): React.JSX.Element => {
    if (!mcp)
      return (
        <p className="panel-note">{loading === 'mcp' ? 'Contacting bridge…' : 'No data yet.'}</p>
      )
    return (
      <>
        <div className="panel">
          <div className="panel-head">
            <h2>Configured servers</h2>
            <button
              type="button"
              className="button button-small"
              data-testid="mcp-refresh"
              onClick={() => void load('mcp')}
            >
              Refresh
            </button>
          </div>
          <table className="table" data-testid="mcp-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Transport</th>
                <th>Command</th>
                <th>Timeout</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {mcp.servers.map((server) => (
                <tr key={server.name} data-testid={`mcp-${server.name}`}>
                  <td className="mono">{server.name}</td>
                  <td>
                    <span className="chip">{server.transport}</span>
                  </td>
                  <td className="mono">
                    {server.url ?? [server.command ?? '', ...server.args].join(' ').trim()}
                  </td>
                  <td className="mono">{server.timeout != null ? `${server.timeout}s` : '—'}</td>
                  <td>
                    <span className={`chip ${server.enabled ? 'chip-ok' : 'chip-debug'}`}>
                      {server.enabled ? 'enabled' : 'disabled'}
                    </span>
                  </td>
                  <td className="table-actions">
                    <button
                      type="button"
                      className="button button-small"
                      disabled={busy}
                      data-testid={`mcp-test-${server.name}`}
                      onClick={() => void runMcpTest(server.name)}
                    >
                      Test
                    </button>
                    <button
                      type="button"
                      className={`button button-small${confirming === `mcp:${server.name}` ? ' button-danger' : ''}`}
                      disabled={busy}
                      data-testid={`mcp-toggle-${server.name}`}
                      onClick={() => void toggleMcpEnabled(server.name, !server.enabled)}
                    >
                      {confirming === `mcp:${server.name}`
                        ? server.enabled
                          ? 'Confirm disable?'
                          : 'Confirm enable?'
                        : server.enabled
                          ? 'Disable'
                          : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
              {mcp.servers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="panel-note">
                    No mcp_servers in config.yaml yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="panel-note">
          Test runs <span className="mono">hermes mcp test &lt;name&gt;</span>; enable/disable
          writes
          <span className="mono"> mcp_servers.&lt;name&gt;.enabled</span> through the config editor
          (a backup is taken on every apply).
        </p>
      </>
    )
  }

  const renderSkills = (): React.JSX.Element => {
    if (!skills)
      return (
        <p className="panel-note">{loading === 'skills' ? 'Scanning skills…' : 'No data yet.'}</p>
      )
    const hasNext = skills.offset + skills.skills.length < skills.total
    return (
      <>
        <div className="panel">
          <div className="panel-head">
            <h2>
              Skills <span className="chip">{skills.total} match</span>
              <span className="chip chip-debug">{skills.disabled_count} disabled</span>
            </h2>
            <div className="toolbar">
              <input
                className="input"
                placeholder="filter by name…"
                aria-label="Filter skills"
                data-testid="skill-search"
                value={skillQuery}
                onChange={(event) => setSkillQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void runSkillsSearch(skillQuery)
                }}
              />
              <button
                type="button"
                className="button button-small"
                data-testid="skill-search-go"
                onClick={() => void runSkillsSearch(skillQuery)}
              >
                Search
              </button>
            </div>
          </div>
          <table className="table" data-testid="skill-table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Description</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {skills.skills.map((skill) => (
                <tr key={skill.name} data-testid={`skill-${skill.name}`}>
                  <td className="mono">{skill.name}</td>
                  <td>{skill.description ?? '—'}</td>
                  <td>
                    <span className={`chip ${skill.enabled ? 'chip-ok' : 'chip-warn'}`}>
                      {skill.enabled ? 'enabled' : 'disabled'}
                    </span>
                  </td>
                  <td className="table-actions">
                    <button
                      type="button"
                      className="button button-small"
                      disabled={busy}
                      data-testid={`skill-toggle-${skill.name}`}
                      onClick={() => void toggleSkill(skill.name, !skill.enabled)}
                    >
                      {skill.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
              {skills.skills.length === 0 ? (
                <tr>
                  <td colSpan={4} className="panel-note">
                    No skills match.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div className="pagination">
            <button
              type="button"
              className="button button-small"
              disabled={skills.offset === 0}
              data-testid="skills-prev"
              onClick={() => void runSkillsPage(Math.max(0, skills.offset - skills.limit))}
            >
              ← Prev
            </button>
            <span className="panel-note" data-testid="skills-page-info">
              {skills.offset + 1}–{skills.offset + skills.skills.length} of {skills.total}
            </span>
            <button
              type="button"
              className="button button-small"
              disabled={!hasNext}
              data-testid="skills-next"
              onClick={() => void runSkillsPage(skills.offset + skills.limit)}
            >
              Next →
            </button>
          </div>
        </div>
        <p className="panel-note">
          Toggling rewrites <span className="mono">skills.disabled</span> in config.yaml (backup
          kept under <span className="mono">backups/config/</span>). SKILL.md is read only for the
          visible page — large skill libraries stay fast.
        </p>
      </>
    )
  }

  const renderCron = (): React.JSX.Element => {
    if (!cron)
      return (
        <p className="panel-note">{loading === 'cron' ? 'Contacting bridge…' : 'No data yet.'}</p>
      )
    return (
      <>
        <div className="panel">
          <div className="panel-head">
            <h2>
              Jobs <span className="chip">{cron.jobs.length} loaded</span>
            </h2>
            <button
              type="button"
              className="button button-small"
              data-testid="cron-refresh"
              onClick={() => void load('cron')}
            >
              Refresh
            </button>
          </div>
          <table className="table" data-testid="cron-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Schedule</th>
                <th>State</th>
                <th>Last run</th>
                <th>Next run</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {cron.jobs.map((job) => (
                <tr key={job.id} data-testid={`cron-${job.id}`}>
                  <td>
                    <span className="mono">{job.name ?? job.id}</span>
                    {job.no_agent ? <span className="chip chip-debug"> no agent</span> : null}
                  </td>
                  <td className="mono">{job.schedule ?? '—'}</td>
                  <td>
                    <span className={`chip ${job.enabled ? 'chip-ok' : 'chip-debug'}`}>
                      {job.state ?? (job.enabled ? 'scheduled' : 'paused')}
                    </span>
                  </td>
                  <td className="mono">
                    {job.last_status
                      ? `${job.last_status} · ${job.last_run_at ?? ''}`
                      : (job.last_run_at ?? '—')}
                  </td>
                  <td className="mono">{job.next_run_at ?? '—'}</td>
                  <td className="table-actions">
                    <button
                      type="button"
                      className="button button-small"
                      disabled={busy}
                      data-testid={`cron-pause-${job.id}`}
                      onClick={() => void runCronAction(job.id, 'pause')}
                    >
                      Pause
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      disabled={busy}
                      data-testid={`cron-resume-${job.id}`}
                      onClick={() => void runCronAction(job.id, 'resume')}
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      className={`button button-small${confirming === `cron:${job.id}` ? ' button-danger' : ''}`}
                      disabled={busy}
                      data-testid={`cron-run-${job.id}`}
                      onClick={() => void runCronAction(job.id, 'run')}
                    >
                      {confirming === `cron:${job.id}` ? 'Confirm run?' : 'Run now'}
                    </button>
                  </td>
                </tr>
              ))}
              {cron.jobs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="panel-note">
                    No cron jobs yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="panel-note">
          Actions run <span className="mono">hermes cron &lt;pause|resume|run&gt; &lt;job&gt;</span>{' '}
          — paused jobs are restored on gateway restart (config-driven pause does not persist).
        </p>
      </>
    )
  }

  const renderPlugins = (): React.JSX.Element => {
    if (!plugins)
      return (
        <p className="panel-note">
          {loading === 'plugins' ? 'Contacting bridge…' : 'No data yet.'}
        </p>
      )
    return (
      <>
        <div className="cards">
          <div className="card">
            <span className="card-label">Installed</span>
            <span className="card-value">{plugins.plugins.length}</span>
            <span className="card-note">bundled + user plugins</span>
          </div>
          <div className="card">
            <span className="card-label">Catalog</span>
            <span className="card-value">{plugins.catalog_count}</span>
            <span className="card-note">available in plugin-catalog/</span>
          </div>
          <div className="card">
            <span className="card-label">Enabled</span>
            <span className="card-value">
              {plugins.plugins.filter((entry) => entry.enabled).length}
            </span>
            <span className="card-note">not listed in plugins.disabled</span>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Plugins</h2>
            <button
              type="button"
              className="button button-small"
              data-testid="plugins-refresh"
              onClick={() => void load('plugins')}
            >
              Refresh
            </button>
          </div>
          <table className="table" data-testid="plugin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Source</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {plugins.plugins.map((entry) => (
                <tr key={`${entry.source}:${entry.name}`} data-testid={`plugin-${entry.name}`}>
                  <td className="mono">{entry.name}</td>
                  <td>
                    <span className="chip">{entry.source}</span>
                  </td>
                  <td>
                    <span className={`chip ${entry.enabled ? 'chip-ok' : 'chip-debug'}`}>
                      {entry.enabled ? 'enabled' : 'disabled'}
                    </span>
                  </td>
                </tr>
              ))}
              {plugins.plugins.length === 0 ? (
                <tr>
                  <td colSpan={3} className="panel-note">
                    No plugins found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="panel-note">
          Bundled plugins are on unless listed in <span className="mono">plugins.disabled</span>;
          user plugins under <span className="mono">HERMES_HOME/plugins</span> are off unless listed
          in
          <span className="mono"> plugins.enabled</span>. Manage flags from the Config tab.
        </p>
      </>
    )
  }

  const renderModels = (): React.JSX.Element => {
    if (!models)
      return (
        <p className="panel-note">{loading === 'models' ? 'Contacting bridge…' : 'No data yet.'}</p>
      )
    return (
      <>
        <div className="cards">
          <div className="card">
            <span className="card-label">Ollama</span>
            <span className={`card-value ${models.ollama_running ? 'chip-ok' : 'chip-warn'}`}>
              {models.ollama_running ? 'running' : 'offline'}
            </span>
            <span className="card-note">127.0.0.1:11434</span>
          </div>
          <div className="card">
            <span className="card-label">Ollama models</span>
            <span className="card-value">{models.ollama_models.length}</span>
            <span className="card-note">via ollama list</span>
          </div>
          <div className="card">
            <span className="card-label">Local GGUF</span>
            <span className="card-value">{models.gguf.length}</span>
            <span className="card-note">HERMES_HOME/models/*.gguf</span>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Ollama</h2>
            <button
              type="button"
              className="button button-small"
              data-testid="models-refresh"
              onClick={() => void load('models')}
            >
              Refresh
            </button>
          </div>
          {models.ollama_running && models.ollama_models.length > 0 ? (
            <table className="table" data-testid="models-ollama">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Size</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {models.ollama_models.map((model) => (
                  <tr key={model.name} data-testid={`ollama-${model.name}`}>
                    <td className="mono">{model.name}</td>
                    <td className="mono">{formatSize(model.size)}</td>
                    <td>{model.details ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="panel-note" data-testid="models-ollama">
              {models.detail ?? 'Ollama is not running.'}
            </p>
          )}
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>GGUF inventory</h2>
          </div>
          <table className="table" data-testid="models-gguf">
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {models.gguf.map((model) => (
                <tr key={model.name} data-testid={`gguf-${model.name}`}>
                  <td className="mono">{model.name}</td>
                  <td className="mono">{formatSize(model.size)}</td>
                  <td>{model.details ?? '—'}</td>
                </tr>
              ))}
              {models.gguf.length === 0 ? (
                <tr>
                  <td colSpan={3} className="panel-note">
                    No .gguf files in HERMES_HOME/models.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </>
    )
  }

  const renderTab = (): React.JSX.Element => {
    switch (tab) {
      case 'skills':
        return renderSkills()
      case 'cron':
        return renderCron()
      case 'plugins':
        return renderPlugins()
      case 'models':
        return renderModels()
      default:
        return renderMcp()
    }
  }

  const selectTab = (next: TabId): void => {
    setTab(next)
    setConfirming(null)
    setNote(null)
    setError(null)
    if (next === 'mcp' && !mcp) void load('mcp')
    if (next === 'skills' && !skills)
      void load('skills', { query: skillQuery, offset: skillOffset })
    if (next === 'cron' && !cron) void load('cron')
    if (next === 'plugins' && !plugins) void load('plugins')
    if (next === 'models' && !models) void load('models')
  }

  const subtitle =
    tab === 'mcp'
      ? 'MCP servers wired into config.yaml — test connectivity and toggle entries without leaving the manager.'
      : tab === 'skills'
        ? 'Browse the skill library, filter by name, and enable/disable skills (persisted to skills.disabled).'
        : tab === 'cron'
          ? 'Scheduled jobs from cron/jobs.json — pause, resume, or trigger a run immediately.'
          : tab === 'plugins'
            ? 'Bundled and user plugins with their effective enabled state.'
            : 'Local model inventory — ollama runtime and standalone GGUF files.'

  return (
    <section className="page page-tools">
      <header className="page-head">
        <div>
          <h1>Tools</h1>
          <p className="subtitle">
            <span className="badge badge-ready">files</span> {subtitle}
          </p>
        </div>
        <div className="toolbar">
          <button
            type="button"
            className="button"
            disabled={busy || loading !== null}
            data-testid="tools-refresh"
            onClick={() =>
              void load(
                tab,
                tab === 'skills' ? { query: skillQuery, offset: skillOffset } : undefined,
              )
            }
          >
            {loading !== null ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </header>

      <div className="tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`tab${tab === entry.id ? ' tab-active' : ''}`}
            data-testid={`tab-${entry.id}`}
            onClick={() => selectTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="toolbar-row">
        {showNote}
        {showError}
      </div>

      <div className="tab-panel">{renderTab()}</div>
    </section>
  )
}
