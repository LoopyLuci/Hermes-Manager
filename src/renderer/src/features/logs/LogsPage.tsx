import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { LogEntry, LogFile } from '@shared/protocol'
import { bridgeApi } from '../../lib/bridge-api'

const LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const
type Level = (typeof LEVELS)[number]

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const MAX_ENTRIES = 5000

export function LogsPage(): React.JSX.Element {
  const [files, setFiles] = useState<LogFile[]>([])
  const [file, setFile] = useState<string>('agent.log')
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [follow, setFollow] = useState(false)
  const [activeLevels, setActiveLevels] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const offsetRef = useRef(0)
  const loadReqRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const disconnectRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    bridgeApi
      .logFiles()
      .then(setFiles)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  const load = useCallback(async (target: string) => {
    const request = ++loadReqRef.current
    setError(null)
    setStatus(null)
    setLoadedFor(null)
    try {
      const batch = await bridgeApi.logTail(target, 400)
      if (request !== loadReqRef.current) return // a newer file/reload won the race
      offsetRef.current = batch.offset
      setEntries(batch.entries)
      setStatus(`${batch.entries.length} lines`)
      setLoadedFor(target)
    } catch (cause) {
      if (request !== loadReqRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void load(file)
    return () => disconnectRef.current?.()
  }, [file, load])

  useEffect(() => {
    disconnectRef.current?.()
    disconnectRef.current = null
    // Connect only once the tail for this exact file has landed; otherwise the
    // socket would start from the previous file's offset.
    if (!follow || loadedFor !== file) return
    const stop = bridgeApi.followLog(file, offsetRef.current, (batch) => {
      if (batch.rotated) {
        setEntries([])
        offsetRef.current = batch.offset
        return
      }
      if (batch.entries.length === 0) return
      offsetRef.current = batch.offset
      setEntries((current) => {
        const next = [...current, ...batch.entries]
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next
      })
    })
    disconnectRef.current = stop
    return () => {
      stop()
      disconnectRef.current = null
    }
  }, [follow, file, loadedFor])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return entries.filter((entry) => {
      if (activeLevels.size > 0 && (!entry.level || !activeLevels.has(entry.level))) return false
      if (needle && !entry.raw.toLowerCase().includes(needle)) return false
      return true
    })
  }, [entries, activeLevels, search])

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 12,
    initialRect: { width: 1200, height: 800 },
  })

  const toggleLevel = (level: Level): void => {
    setActiveLevels((current) => {
      const next = new Set(current)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  return (
    <section className="page page-logs">
      <header className="page-head">
        <div>
          <h1>Log explorer</h1>
          <p className="subtitle">
            {files.length} log files · {status ?? 'loading'}{' '}
            {error ? <span className="ribbon-error">{error}</span> : null}
          </p>
        </div>
        <div className="toolbar">
          <button
            type="button"
            className={`button${follow ? ' button-primary' : ''}`}
            onClick={() => setFollow((value) => !value)}
          >
            {follow ? 'Following…' : 'Follow'}
          </button>
          <button type="button" className="button" onClick={() => void load(file)}>
            Reload
          </button>
        </div>
      </header>

      <div className="logs-layout">
        <aside className="logs-files">
          {files.map((entry) => (
            <button
              key={entry.name}
              type="button"
              className={`file-row${entry.name === file ? ' file-row-active' : ''}`}
              onClick={() => setFile(entry.name)}
              title={`${entry.name} · ${formatBytes(entry.size)}`}
            >
              <span className="file-name">{entry.name}</span>
              <span className="file-size">{formatBytes(entry.size)}</span>
            </button>
          ))}
          {files.length === 0 ? <p className="panel-note">No log files found.</p> : null}
        </aside>

        <div className="logs-main">
          <div className="logs-controls">
            <input
              className="input"
              type="search"
              placeholder="Filter lines…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Filter log lines"
            />
            <div className="level-chips" role="group" aria-label="Level filter">
              {LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={`chip chip-${level}${activeLevels.has(level) ? ' chip-active' : ''}`}
                  onClick={() => toggleLevel(level)}
                  aria-pressed={activeLevels.has(level)}
                >
                  {level}
                </button>
              ))}
              {activeLevels.size > 0 ? (
                <button
                  type="button"
                  className="chip chip-clear"
                  onClick={() => setActiveLevels(new Set())}
                >
                  clear
                </button>
              ) : null}
            </div>
            <span className="panel-note">
              {filtered.length} / {entries.length}
            </span>
          </div>

          <div className="log-viewport" ref={scrollRef} data-testid="log-viewport">
            {filtered.length === 0 ? (
              <p className="panel-note log-empty">No lines match the current filter.</p>
            ) : (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((row) => {
                  const entry = filtered[row.index]
                  if (!entry) return null
                  return (
                    <div
                      key={row.key}
                      className={`log-line${entry.level ? ` log-line-${entry.level.toLowerCase()}` : ''}`}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${row.size}px`,
                        transform: `translateY(${row.start}px)`,
                      }}
                    >
                      <span className="log-ts">{entry.ts ?? ''}</span>
                      <span className="log-level">{entry.level ?? '—'}</span>
                      <span className="log-logger">{entry.logger ?? ''}</span>
                      <span className="log-msg">{entry.message}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
