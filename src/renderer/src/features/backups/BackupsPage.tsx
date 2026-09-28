import { useCallback, useEffect, useRef, useState } from 'react'
import type { BackupItem, BackupReport, ConfigRestorePreview } from '@shared/protocol'
import { bridgeApi } from '../../lib/bridge-api'

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const KIND_LABELS: Record<string, string> = {
  full: 'full backup',
  'pre-update': 'pre-update',
  config: 'config',
  snapshot: 'snapshot',
  'state-db': 'state.db',
  other: 'other'
}

export function BackupsPage(): React.JSX.Element {
  const [report, setReport] = useState<BackupReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [confirmFull, setConfirmFull] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<BackupItem | null>(null)
  const [restorePreview, setRestorePreview] = useState<ConfigRestorePreview | null>(null)
  const aliveRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const next = await bridgeApi.backups()
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
    return () => {
      aliveRef.current = false
    }
  }, [refresh])

  const createSnapshot = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      const result = await bridgeApi.createBackup('snapshot')
      if (!aliveRef.current) return
      if (result.ok) {
        setNote(`snapshot created: ${result.path ?? ''}`)
      } else {
        setError(result.detail ?? 'snapshot failed')
      }
      await refresh()
    } catch (cause) {
      if (!aliveRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const createFull = async (): Promise<void> => {
    if (!confirmFull) {
      setConfirmFull(true)
      return
    }
    setConfirmFull(false)
    setBusy(true)
    setNote(null)
    setError(null)
    try {
      const result = await bridgeApi.createBackup('full')
      if (!aliveRef.current) return
      if (result.ok) setNote(`full backup spawned (pid ${result.pid ?? '?'}) — tail ${result.log ?? 'manager-backup.log'}`)
      else setError(result.detail ?? 'backup failed to start')
    } catch (cause) {
      if (!aliveRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const removeItem = async (item: BackupItem): Promise<void> => {
    if (confirmDelete !== item.path) {
      setConfirmDelete(item.path)
      return
    }
    setConfirmDelete(null)
    setBusy(true)
    setError(null)
    try {
      const result = await bridgeApi.deleteBackup(item.path)
      if (!aliveRef.current) return
      if (result.ok) setNote(`deleted ${item.name}`)
      else setError(result.detail ?? 'delete failed')
      await refresh()
    } catch (cause) {
      if (!aliveRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const openRestore = async (item: BackupItem): Promise<void> => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const preview = await bridgeApi.previewConfigRestore(item.path)
      if (!aliveRef.current) return
      setRestoreTarget(item)
      setRestorePreview(preview)
    } catch (cause) {
      if (!aliveRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const confirmRestore = async (): Promise<void> => {
    if (!restoreTarget) return
    setBusy(true)
    setError(null)
    try {
      const result = await bridgeApi.restoreConfig(restoreTarget.path)
      if (!aliveRef.current) return
      if (result.ok) {
        setNote(`config restored from ${restoreTarget.name}${result.created_backup ? ` (previous saved to ${result.created_backup})` : ''}`)
        setRestoreTarget(null)
        setRestorePreview(null)
        await refresh()
      } else {
        setError(result.detail ?? 'restore failed')
      }
    } catch (cause) {
      if (!aliveRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const items = report?.items ?? []

  return (
    <section className="page page-backups">
      <header className="page-head">
        <div>
          <h1>Backups &amp; snapshots</h1>
          <p className="subtitle">
            {report ? (
              <>
                <span className={`badge badge-${report.source === 'deep' ? 'ready' : 'degraded'}`}>{report.source}</span>{' '}
                {items.length} item(s)
              </>
            ) : (
              'Contacting bridge…'
            )}
          </p>
        </div>
        <div className="toolbar">
          <button type="button" className="button" disabled={busy} data-testid="create-snapshot" onClick={() => void createSnapshot()}>
            Quick snapshot
          </button>
          <button
            type="button"
            className={`button${confirmFull ? ' button-danger' : ''}`}
            disabled={busy}
            data-testid="create-full"
            onClick={() => void createFull()}
          >
            {confirmFull ? 'Confirm full backup?' : 'Full backup'}
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </header>

      <div className="toolbar-row">
        {note ? (
          <span className="panel-note" role="status" data-testid="backup-note">
            {note}
          </span>
        ) : null}
        {error ? (
          <span className="ribbon-error" role="alert" data-testid="backup-error">
            {error}
          </span>
        ) : null}
      </div>

      {restoreTarget && restorePreview ? (
        <div className="panel diff-panel" data-testid="restore-panel">
          <div className="panel-head">
            <h2>Restore config from {restoreTarget.name}</h2>
            <span className="panel-note">
              {restorePreview.ok ? `${restorePreview.changes.length} change(s) — confirm to write` : (restorePreview.detail ?? '')}
            </span>
          </div>
          {restorePreview.ok ? (
            <>
              <ul className="diff-list">
                {restorePreview.changes.map((change) => (
                  <li className="diff-row" key={change.path} data-testid="restore-row">
                    <span className="chip chip-debug">config</span>
                    <span className="mono diff-path">{change.path}</span>
                    <span className={`chip chip-${change.action === 'delete' ? 'warn' : 'ok'}`}>{change.action}</span>
                    <span className="diff-current mono">{change.current ?? '—'}</span>
                    <span className="diff-arrow">→</span>
                    <span className="diff-next mono">{change.next ?? '—'}</span>
                  </li>
                ))}
              </ul>
              <div className="toolbar-row">
                <button type="button" className="button button-primary" disabled={busy} data-testid="restore-confirm" onClick={() => void confirmRestore()}>
                  {busy ? 'Restoring…' : 'Confirm restore'}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setRestoreTarget(null)
                    setRestorePreview(null)
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="toolbar-row">
              <button
                type="button"
                className="button"
                onClick={() => {
                  setRestoreTarget(null)
                  setRestorePreview(null)
                }}
              >
                Close
              </button>
            </div>
          )}
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h2>Inventory</h2>
          <span className="panel-note">{report?.detail ?? 'loading'}</span>
        </div>
        <table className="table" data-testid="backup-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Name</th>
              <th>Size</th>
              <th>Modified</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.path}>
                <td>
                  <span className={`chip ${item.kind === 'config' ? 'chip-info' : item.kind === 'snapshot' ? 'chip-ok' : 'chip-debug'}`}>
                    {KIND_LABELS[item.kind] ?? item.kind}
                  </span>
                </td>
                <td className="mono">{item.name}</td>
                <td>{formatSize(item.size)}</td>
                <td className="mono">{item.modified}</td>
                <td className="field-actions">
                  {item.kind === 'config' ? (
                    <button type="button" className="button button-ghost" disabled={busy} data-testid={`restore-${item.name}`} onClick={() => void openRestore(item)}>
                      Restore
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`button${confirmDelete === item.path ? ' button-danger' : ' button-ghost'}`}
                    disabled={busy}
                    data-testid={`delete-${item.name}`}
                    onClick={() => void removeItem(item)}
                  >
                    {confirmDelete === item.path ? 'Confirm?' : 'Delete'}
                  </button>
                </td>
              </tr>
            ))}
            {report && items.length === 0 ? (
              <tr>
                <td colSpan={5} className="panel-note">
                  No backups yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}
