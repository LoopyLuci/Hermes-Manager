import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppUpdateCheck, UpdateCheckResult, UpdateReport } from '@shared/protocol'
import { bridgeApi } from '../../lib/bridge-api'

function shortSha(sha: string | null): string {
  if (!sha) return '—'
  return sha.length > 9 ? sha.slice(0, 9) : sha
}

export function UpdatesPage(): React.JSX.Element {
  const [report, setReport] = useState<UpdateReport | null>(null)
  const [check, setCheck] = useState<UpdateCheckResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [appUpdate, setAppUpdate] = useState<AppUpdateCheck | null>(null)
  const [appBusy, setAppBusy] = useState(false)
  const aliveRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const next = await bridgeApi.updates()
      if (!aliveRef.current) return
      setReport(next)
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

  const runCheck = async (force: boolean): Promise<void> => {
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      const result = await bridgeApi.checkUpdates(force)
      if (!aliveRef.current) return
      setCheck(result)
    } catch (cause) {
      if (!aliveRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const runUpdate = async (): Promise<void> => {
    if (!confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      const result = await bridgeApi.applyUpdate()
      if (!aliveRef.current) return
      if (result.ok) {
        setNote(
          `update spawned (pid ${result.pid ?? '?'}) — tail ${result.log ?? 'manager-update.log'}`,
        )
        await refresh()
      } else {
        setError(result.detail ?? 'update failed to start')
      }
    } catch (cause) {
      if (!aliveRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const checkApp = async (): Promise<void> => {
    setAppBusy(true)
    try {
      const result = await bridgeApi.checkAppUpdate()
      if (aliveRef.current) setAppUpdate(result)
    } catch (cause) {
      if (aliveRef.current)
        setAppUpdate({
          ok: false,
          current: appUpdate?.current ?? 'unknown',
          available: false,
          version: null,
          notes: null,
          downloaded: false,
          reason: cause instanceof Error ? cause.message : String(cause),
        })
    } finally {
      if (aliveRef.current) setAppBusy(false)
    }
  }

  const installApp = async (): Promise<void> => {
    setAppBusy(true)
    try {
      const started = await bridgeApi.installAppUpdate()
      if (aliveRef.current && !started) {
        setAppUpdate((current) =>
          current ? { ...current, ok: false, reason: 'could not start the installer' } : current,
        )
      }
    } catch (cause) {
      if (aliveRef.current)
        setAppUpdate((current) =>
          current
            ? {
                ...current,
                ok: false,
                reason: cause instanceof Error ? cause.message : String(cause),
              }
            : current,
        )
    } finally {
      if (aliveRef.current) setAppBusy(false)
    }
  }

  const identity = report?.identity
  const receipt = report?.receipt
  const outcomeClass =
    receipt?.outcome === 'success'
      ? 'chip chip-ok'
      : receipt?.outcome
        ? 'chip chip-warn'
        : 'chip chip-debug'

  return (
    <section className="page page-updates">
      <header className="page-head">
        <div>
          <h1>Updates</h1>
          <p className="subtitle">
            {report ? (
              <>
                <span className={`badge badge-${report.source === 'deep' ? 'ready' : 'degraded'}`}>
                  {report.source}
                </span>{' '}
                <span className="mono">v{identity?.version ?? 'unknown'}</span> · sha{' '}
                <span className="mono">{shortSha(identity?.sha ?? null)}</span>
                {identity?.source ? ` · via ${identity.source}` : ''}
                {report.running ? (
                  <span className="chip chip-info"> update running (pid {report.pid})</span>
                ) : null}
              </>
            ) : (
              'Contacting bridge…'
            )}
          </p>
        </div>
        <div className="toolbar">
          <button
            type="button"
            className="button"
            disabled={busy}
            data-testid="check-updates"
            onClick={() => void runCheck(false)}
          >
            Check for updates
          </button>
          <button
            type="button"
            className={`button${confirming ? ' button-danger' : ''}`}
            disabled={busy || report?.running === true}
            data-testid="apply-update"
            onClick={() => void runUpdate()}
          >
            {confirming ? 'Confirm update?' : 'Update now'}
          </button>
        </div>
      </header>

      <div className="toolbar-row">
        {note ? (
          <span className="panel-note" role="status" data-testid="update-note">
            {note}
          </span>
        ) : null}
        {error ? (
          <span className="ribbon-error" role="alert" data-testid="update-error">
            {error}
          </span>
        ) : null}
      </div>

      <div className="cards">
        <div className="card">
          <span className="card-label">Version</span>
          <span className="card-value">{identity?.version ?? '—'}</span>
          <span className="card-note">identity source: {identity?.source ?? 'unknown'}</span>
        </div>
        <div className="card">
          <span className="card-label">Code</span>
          <span className="card-value mono">{shortSha(identity?.sha ?? null)}</span>
          <span className="card-note">
            {receipt ? `receipt: ${receipt.post_version ?? '—'}` : 'no receipt yet'}
          </span>
        </div>
        <div className="card">
          <span className="card-label">Last update</span>
          <span className="card-value">{receipt ? (receipt.outcome ?? '—') : '—'}</span>
          <span className="card-note">
            {receipt
              ? `${receipt.steps_ok} ok / ${receipt.steps_failed} failed · ${receipt.finished_at ?? ''}`
              : 'never'}
          </span>
        </div>
        <div className="card">
          <span className="card-label">Updater</span>
          <span className="card-value">{report?.running ? 'running' : 'idle'}</span>
          <span className="card-note mono">{report?.log ?? 'manager-update.log'}</span>
        </div>
      </div>

      {check ? (
        <div className="panel" data-testid="check-panel">
          <div className="panel-head">
            <h2>Update check</h2>
            <span className={`chip ${check.update_available ? 'chip-warn' : 'chip-ok'}`}>
              {check.update_available ? 'update available' : 'up to date'}
            </span>
          </div>
          {!check.supported ? (
            <p className="panel-note">
              {check.detail ?? 'update checks are not supported for this install'}
            </p>
          ) : (
            <>
              <p className="panel-note">
                {check.behind ?? 0} commit(s) behind{check.branch ? ` ${check.branch}` : ''}
                {check.detail ? ` · ${check.detail}` : ''}
              </p>
              {check.commits.length > 0 ? (
                <ul className="process-list">
                  {check.commits.map((commit, index) => (
                    <li className="process-row" key={`${commit}-${index}`}>
                      <span className="mono">{commit}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div className="panel" data-testid="app-update-panel">
        <div className="panel-head">
          <h2>Hermes Manager updates</h2>
          <span className="panel-note">
            {appUpdate
              ? appUpdate.available
                ? `v${appUpdate.version ?? '?'} available (installed ${appUpdate.current})`
                : appUpdate.ok
                  ? `installed version ${appUpdate.current}`
                  : (appUpdate.reason ?? 'unavailable')
              : 'not checked yet'}
          </span>
        </div>
        <div className="toolbar-row">
          <button
            type="button"
            className="button"
            data-testid="app-check-update"
            disabled={appBusy}
            onClick={() => void checkApp()}
          >
            Check for app update
          </button>
          {appUpdate?.available ? (
            <button
              type="button"
              className="button button-primary"
              data-testid="app-install-update"
              disabled={appBusy}
              onClick={() => void installApp()}
            >
              {appUpdate.downloaded ? 'Restart and install' : 'Download and install'}
            </button>
          ) : null}
        </div>
        {appUpdate?.notes ? (
          <pre className="panel-note mono update-notes">{appUpdate.notes}</pre>
        ) : null}
      </div>

      {report?.detail ? <div className="panel panel-muted">{report.detail}</div> : null}

      <div className="panel">
        <div className="panel-head">
          <h2>Last update receipt</h2>
          <span className="panel-note">{receipt?.path ?? 'no receipt found'}</span>
        </div>
        {receipt ? (
          <table className="table">
            <tbody>
              <tr>
                <td>Outcome</td>
                <td>
                  <span className={outcomeClass} data-testid="receipt-outcome">
                    {receipt.outcome ?? '—'}
                  </span>
                </td>
                <td>Steps</td>
                <td>
                  {receipt.steps_ok} ok / {receipt.steps_failed} failed
                </td>
              </tr>
              <tr>
                <td>Pre sha</td>
                <td className="mono">{shortSha(receipt.pre_sha)}</td>
                <td>Post sha</td>
                <td className="mono">{shortSha(receipt.post_sha)}</td>
              </tr>
              <tr>
                <td>Started</td>
                <td className="mono">{receipt.started_at ?? '—'}</td>
                <td>Finished</td>
                <td className="mono">{receipt.finished_at ?? '—'}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="panel-note">
            No update receipt yet — the receipt appears after the first `hermes update`.
          </p>
        )}
      </div>
    </section>
  )
}
