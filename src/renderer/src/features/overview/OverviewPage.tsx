import type { HealthReport, SourceStatus } from '@shared/protocol'
import { LayerMatrix } from '../../components/LayerMatrix'

const DOMAIN_LABELS: Record<string, string> = {
  overview: 'Overview',
  logs: 'Log explorer',
  gateway: 'Gateway',
  sessions: 'Sessions',
  chat: 'Chat',
  updates: 'Updates',
  backups: 'Backups',
  config: 'Config',
  tools: 'Tools',
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${rest}s`
  return `${rest}s`
}

export function OverviewPage({
  health,
  sources,
  error,
  uptimeS,
  refresh,
}: {
  health: HealthReport | null
  sources: SourceStatus | null
  error: string | null
  uptimeS: number | null
  refresh: () => void
}): React.JSX.Element {
  if (error && !health) {
    return (
      <section className="page">
        <header className="page-head">
          <h1>Overview</h1>
        </header>
        <div className="panel panel-error">
          <h2>Bridge unreachable</h2>
          <p>{error}</p>
          <button type="button" className="button" onClick={refresh}>
            Retry
          </button>
        </div>
      </section>
    )
  }

  if (!health) {
    return (
      <section className="page">
        <header className="page-head">
          <h1>Overview</h1>
        </header>
        <div className="panel panel-muted">Contacting bridge…</div>
      </section>
    )
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="subtitle">
            Live telemetry and data-source health for {health.hermes_home ?? 'this install'}
          </p>
        </div>
        <button type="button" className="button" onClick={refresh}>
          Refresh
        </button>
      </header>

      <div className="cards">
        <div className="card">
          <span className="card-label">Bridge uptime</span>
          <span className="card-value">{formatDuration(uptimeS ?? health.uptime_s)}</span>
        </div>
        <div className="card">
          <span className="card-label">Python runtime</span>
          <span className="card-value">{health.runtime.kind}</span>
          <span className="card-note">{health.runtime.version}</span>
        </div>
        <div className="card">
          <span className="card-label">Hermes repo</span>
          <span className="card-value">{health.hermes_repo ? 'detected' : 'missing'}</span>
          <span className="card-note">{health.hermes_repo ?? 'not found in HERMES_HOME'}</span>
        </div>
        <div className="card">
          <span className="card-label">Layers reachable</span>
          <span className="card-value">
            {Object.values(health.layers).filter((layer) => layer.state !== 'unavailable').length} /
            5
          </span>
          <span className="card-note">
            {health.ok ? 'all layers answering' : 'some layers degraded'}
          </span>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Data source matrix</h2>
          <span className="panel-note">Every read falls back across these layers</span>
        </div>
        <LayerMatrix layers={health.layers} />
      </div>

      {sources ? (
        <div className="panel">
          <div className="panel-head">
            <h2>Active source per feature</h2>
            <span className="panel-note">Resolved live from the bridge</span>
          </div>
          <div className="domain-grid" data-testid="domain-grid">
            {Object.entries(sources.domains ?? {}).map(([domain, layer]) => (
              <div className="domain-cell" key={domain} data-domain={domain}>
                <span className="domain-name">{DOMAIN_LABELS[domain] ?? domain}</span>
                <span className={`badge badge-${sources.layers[layer]?.state ?? 'unavailable'}`}>
                  {layer}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}
