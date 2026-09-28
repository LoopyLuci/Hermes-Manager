import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DrainResult,
  FleetReport,
  GatewayStatus,
  LifecycleAction,
  LifecycleResult,
  ProcessReport
} from '@shared/protocol'
import { bridgeApi } from '../../lib/bridge-api'

type Pending = LifecycleAction | 'drain' | 'cancel' | null

function shortSha(sha: string | null): string {
  if (!sha) return '—'
  return sha.length > 9 ? sha.slice(0, 9) : sha
}

export function GatewayPage(): React.JSX.Element {
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [fleet, setFleet] = useState<FleetReport | null>(null)
  const [processes, setProcesses] = useState<ProcessReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending>(null)
  const [note, setNote] = useState<string | null>(null)
  const aliveRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextFleet, nextProcesses] = await Promise.all([
        bridgeApi.gatewayStatus(),
        bridgeApi.gatewayFleet(),
        bridgeApi.processes()
      ])
      if (!aliveRef.current) return
      setStatus(nextStatus)
      setFleet(nextFleet)
      setProcesses(nextProcesses)
      setError(null)
    } catch (cause) {
      if (!aliveRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => {
      aliveRef.current = false
      window.clearInterval(timer)
    }
  }, [refresh])

  const runLifecycle = async (action: LifecycleAction): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const result: LifecycleResult = await bridgeApi.gatewayLifecycle(action)
      setNote(result.ok ? `hermes gateway ${action} spawned (pid ${result.pid ?? '?'})` : (result.detail ?? 'failed'))
      await refresh()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  const runDrain = async (action: 'drain' | 'cancel'): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const result: DrainResult = await bridgeApi.gatewayDrain(action)
      setNote(result.ok ? (result.drain_requested ? 'drain requested' : 'drain cancelled') : (result.detail ?? 'failed'))
      await refresh()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  const confirm = (action: Pending): void => {
    if (pending !== action) {
      setPending(action)
      return
    }
    if (action === 'drain' || action === 'cancel') void runDrain(action)
    else if (action) void runLifecycle(action)
  }

  const running = status?.running ?? false
  const drained = status?.drain_requested ?? false
  const stateLabel = status ? ((status.state?.state as string | null) ?? (running ? 'running' : 'stopped')) : '…'
  const stateClass = drained ? 'state-pill state-draining' : running ? 'state-pill state-running' : 'state-pill state-stopped'

  const actionButton = (action: LifecycleAction, label: string, enabled: boolean): React.JSX.Element => (
    <button
      key={action}
      type="button"
      className={`button${pending === action ? ' button-danger' : ''}`}
      disabled={!enabled || busy}
      onClick={() => confirm(action)}
      data-testid={`lifecycle-${action}`}
    >
      {pending === action ? `Confirm ${label.toLowerCase()}?` : label}
    </button>
  )

  return (
    <section className="page page-gateway">
      <header className="page-head">
        <div>
          <h1>Gateway &amp; processes</h1>
          <p className="subtitle">
            {status ? (
              <>
                <span className={stateClass} data-testid="gateway-state">
                  {stateLabel}
                </span>{' '}
                pid {status.state?.pid ?? '—'}
                {status.identity?.supervisor ? ` · supervisor ${status.identity.supervisor}` : ''} · source{' '}
                <span className={`badge badge-${status.source === 'deep' ? 'ready' : 'degraded'}`}>{status.source}</span>
              </>
            ) : (
              'Contacting bridge…'
            )}
          </p>
        </div>
        <div className="toolbar">
          <button type="button" className="button" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      <div className="toolbar-row" data-testid="gateway-actions">
        {actionButton('start', 'Start', !running)}
        {actionButton('stop', 'Stop', running)}
        {actionButton('restart', 'Restart', running)}
        {running && !drained ? (
          <button
            type="button"
            className={`button${pending === 'drain' ? ' button-danger' : ''}`}
            disabled={busy}
            onClick={() => confirm('drain')}
            data-testid="drain"
          >
            {pending === 'drain' ? 'Confirm drain?' : 'Drain'}
          </button>
        ) : null}
        {drained ? (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => confirm('cancel')}
            data-testid="cancel-drain"
          >
            {pending === 'cancel' ? 'Confirm cancel?' : 'Cancel drain'}
          </button>
        ) : null}
        {note ? (
          <span className="panel-note" role="status">
            {note}
          </span>
        ) : null}
        {error ? <span className="ribbon-error">{error}</span> : null}
      </div>

      <div className="cards">
        <div className="card">
          <span className="card-label">Active agents</span>
          <span className="card-value">{status?.state?.active_agents ?? '—'}</span>
          <span className="card-note">work in flight: {status?.state?.active_work ?? '—'}</span>
        </div>
        <div className="card">
          <span className="card-label">Code</span>
          <span className="card-value">{status?.state?.code_version ?? status?.identity?.code_version ?? '—'}</span>
          <span className="card-note">sha {shortSha(status?.state?.code_sha ?? status?.identity?.code_sha ?? null)}</span>
        </div>
        <div className="card">
          <span className="card-label">Served profiles</span>
          <span className="card-value">{(status?.state?.served_profiles ?? []).length || '—'}</span>
          <span className="card-note">{(status?.state?.served_profiles ?? []).join(', ') || 'none reported'}</span>
        </div>
        <div className="card">
          <span className="card-label">State file</span>
          <span className="card-value">{status?.state?.updated_at ? 'fresh' : 'missing'}</span>
          <span className="card-note">{status?.state?.updated_at ?? 'no gateway_state.json'}</span>
        </div>
      </div>

      {status?.detail ? <div className="panel panel-muted">{status.detail}</div> : null}

      <div className="panel">
        <div className="panel-head">
          <h2>Fleet matrix</h2>
          <span className="panel-note">
            {fleet ? `${fleet.rows.length} gateway(s) · source ${fleet.source}` : 'loading'}
          </span>
        </div>
        <table className="table" data-testid="fleet-table">
          <thead>
            <tr>
              <th>Profile</th>
              <th>PID</th>
              <th>State</th>
              <th>Version</th>
              <th>SHA</th>
              <th>Served</th>
            </tr>
          </thead>
          <tbody>
            {(fleet?.rows ?? []).map((row, index) => (
              <tr key={`${row.profile}-${row.pid ?? index}`}>
                <td>{row.profile}</td>
                <td className="mono">{row.pid ?? '—'}</td>
                <td>
                  <span className={`chip chip-${row.state === 'current' ? 'info' : 'debug'}`}>{row.state}</span>
                </td>
                <td className="mono">{row.code_version ?? '—'}</td>
                <td className="mono">{shortSha(row.code_sha)}</td>
                <td>{row.served_profiles.join(', ') || '—'}</td>
              </tr>
            ))}
            {fleet && fleet.rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="panel-note">
                  No gateway rows.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {fleet?.detail ? <p className="panel-note">{fleet.detail}</p> : null}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Processes</h2>
          <span className="panel-note">
            {processes ? `${processes.processes.length} tracked · source ${processes.source}` : 'loading'}
          </span>
        </div>
        <ul className="process-list" data-testid="process-list">
          {(processes?.processes ?? []).map((item, index) => (
            <li className="process-row" key={`${item.kind}-${item.name}-${index}`}>
              <span className={`chip chip-${item.kind === 'gateway' ? 'info' : 'debug'}`}>{item.kind}</span>
              <span className="process-name">{item.name}</span>
              <span className="mono process-pid">{item.pid ?? '—'}</span>
              <span className="process-status">{item.status}</span>
              <span className="panel-note">{item.detail ?? ''}</span>
            </li>
          ))}
          {processes && processes.processes.length === 0 ? (
            <li className="panel-note">No processes tracked.</li>
          ) : null}
        </ul>
        {processes?.detail ? <p className="panel-note">{processes.detail}</p> : null}
      </div>
    </section>
  )
}
