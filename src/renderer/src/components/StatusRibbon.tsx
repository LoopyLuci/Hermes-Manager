import type { HealthReport } from '@shared/protocol'

export function StatusRibbon({
  health,
  live,
  error
}: {
  health: HealthReport | null
  live: boolean
  error: string | null
}): React.JSX.Element {
  const bridgeState = error ? 'error' : health ? 'ready' : 'starting'
  return (
    <footer className="ribbon" data-testid="status-ribbon">
      <span className={`dot dot-${live ? 'live' : 'idle'}`} />
      <span className="ribbon-item">bridge {bridgeState}</span>
      <span className="ribbon-sep" />
      <span className="ribbon-item">{live ? 'stream connected' : 'stream idle'}</span>
      {health ? (
        <>
          <span className="ribbon-sep" />
          <span className="ribbon-item" title={health.hermes_home ?? undefined}>
            {health.hermes_home ?? 'HERMES_HOME unresolved'}
          </span>
          <span className="ribbon-sep" />
          <span className="ribbon-item">
            {health.runtime.kind} · python {health.runtime.version}
          </span>
        </>
      ) : null}
      {error ? (
        <>
          <span className="ribbon-sep" />
          <span className="ribbon-item ribbon-error">{error}</span>
        </>
      ) : null}
      <span className="ribbon-spacer" />
      <span className="ribbon-item">Hermes Manager {health?.app_version ?? '0.1.0'}</span>
    </footer>
  )
}
