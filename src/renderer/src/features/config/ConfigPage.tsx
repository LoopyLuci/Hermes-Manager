import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ConfigApplyResult,
  ConfigChange,
  ConfigDiff,
  ConfigDocument,
  ConfigEditRequest,
  EnvChange,
  EnvReport,
} from '@shared/protocol'
import { bridgeApi } from '../../lib/bridge-api'

function getPath(config: Record<string, unknown>, path: string): unknown {
  let current: unknown = config
  for (const part of path.split('.')) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

type Parsed = { ok: true; value: unknown } | { ok: false; error: string }

function parseDraft(type: string, text: string): Parsed {
  switch (type) {
    case 'boolean':
      if (text === 'true') return { ok: true, value: true }
      if (text === 'false') return { ok: true, value: false }
      return { ok: false, error: 'expected true or false' }
    case 'number': {
      const trimmed = text.trim()
      const numeric = Number(trimmed)
      if (trimmed === '' || Number.isNaN(numeric)) return { ok: false, error: 'expected a number' }
      return { ok: true, value: numeric }
    }
    case 'list':
    case 'object': {
      try {
        const parsed: unknown = JSON.parse(text || (type === 'list' ? '[]' : '{}'))
        const valid =
          type === 'list'
            ? Array.isArray(parsed)
            : parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        return valid ? { ok: true, value: parsed } : { ok: false, error: `expected a JSON ${type}` }
      } catch {
        return { ok: false, error: 'invalid JSON' }
      }
    }
    default:
      return { ok: true, value: text }
  }
}

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/
const SECRET_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i

export function ConfigPage(): React.JSX.Element {
  const [doc, setDoc] = useState<ConfigDocument | null>(null)
  const [env, setEnv] = useState<EnvReport | null>(null)
  const [tab, setTab] = useState<'config' | 'env'>('config')
  const [search, setSearch] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [envDrafts, setEnvDrafts] = useState<Record<string, string>>({})
  const [deletes, setDeletes] = useState<Set<string>>(new Set())
  const [envDeletes, setEnvDeletes] = useState<Set<string>>(new Set())
  const [diff, setDiff] = useState<ConfigDiff | null>(null)
  const [pendingBody, setPendingBody] = useState<ConfigEditRequest | null>(null)
  const [result, setResult] = useState<ConfigApplyResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [addKey, setAddKey] = useState('')
  const [addValue, setAddValue] = useState('')
  const aliveRef = useRef(true)

  const reload = useCallback(async () => {
    try {
      const [nextDoc, nextEnv] = await Promise.all([bridgeApi.config(), bridgeApi.configEnv()])
      if (!aliveRef.current) return
      setDoc(nextDoc)
      setEnv(nextEnv)
      setError(null)
    } catch (cause) {
      if (!aliveRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    void reload()
    return () => {
      aliveRef.current = false
    }
  }, [reload])

  const typeOf = useCallback(
    (path: string): string => {
      const field = doc?.fields.find((entry) => entry.path === path)
      if (field) return field.type
      const current = doc ? getPath(doc.config, path) : undefined
      if (typeof current === 'boolean') return 'boolean'
      if (typeof current === 'number') return 'number'
      if (Array.isArray(current)) return 'list'
      if (current && typeof current === 'object') return 'object'
      return 'string'
    },
    [doc],
  )

  const fields = useMemo(() => {
    if (!doc) return []
    const needle = search.trim().toLowerCase()
    return doc.fields.filter((field) => !needle || field.path.toLowerCase().includes(needle))
  }, [doc, search])

  const grouped = useMemo(() => {
    const buckets = new Map<string, typeof fields>()
    for (const field of fields) {
      const category = field.category ?? 'general'
      const bucket = buckets.get(category) ?? []
      bucket.push(field)
      buckets.set(category, bucket)
    }
    return [...buckets.entries()]
  }, [fields])

  const envRows = useMemo(() => {
    if (!env) return []
    const needle = search.trim().toLowerCase()
    const visible = env.rows.filter((row) => !needle || row.key.toLowerCase().includes(needle))
    const known = new Set(env.rows.map((row) => row.key))
    const draftOnly = Object.keys(envDrafts)
      .filter((key) => !known.has(key))
      .filter((key) => !needle || key.toLowerCase().includes(needle))
      .map((key) => ({
        key,
        value: null,
        is_set: false,
        is_secret: SECRET_PATTERN.test(key),
        category: null,
        description: null,
      }))
    return [...visible, ...draftOnly]
  }, [env, search, envDrafts])

  const changeCount =
    Object.keys(drafts).length +
    deletes.size +
    Object.keys(envDrafts).filter((key) => envDrafts[key] !== '').length +
    envDeletes.size

  const setDraft = (path: string, text: string): void => {
    const initial = doc ? displayValue(getPath(doc.config, path)) : ''
    setDrafts((current) => {
      const next = { ...current }
      if (text === initial) delete next[path]
      else next[path] = text
      return next
    })
    setDeletes((current) => {
      if (!current.has(path)) return current
      const next = new Set(current)
      next.delete(path)
      return next
    })
  }

  const setEnvDraft = (key: string, text: string): void => {
    const row = env?.rows.find((entry) => entry.key === key)
    const initial = row && !row.is_secret ? (row.value ?? '') : ''
    setEnvDrafts((current) => {
      const next = { ...current }
      if (text === initial) delete next[key]
      else next[key] = text
      return next
    })
    setEnvDeletes((current) => {
      if (!current.has(key)) return current
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }

  const toggleDelete = (path: string): void => {
    setDeletes((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    setDrafts((current) => {
      if (!(path in current)) return current
      const next = { ...current }
      delete next[path]
      return next
    })
  }

  const toggleEnvDelete = (key: string): void => {
    setEnvDeletes((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setEnvDrafts((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const buildRequest = (): { body: ConfigEditRequest; errors: string[] } => {
    const config: ConfigChange[] = []
    const envChanges: EnvChange[] = []
    const errors: string[] = []
    for (const [path, text] of Object.entries(drafts)) {
      const parsed = parseDraft(typeOf(path), text)
      if (!parsed.ok) {
        errors.push(`${path}: ${parsed.error}`)
        continue
      }
      config.push({ path, value: parsed.value })
    }
    for (const path of deletes) config.push({ path, op: 'delete' })
    for (const [key, text] of Object.entries(envDrafts)) {
      if (text === '') continue
      envChanges.push({ key, value: text })
    }
    for (const key of envDeletes) envChanges.push({ key, op: 'delete' })
    return { body: { config, env: envChanges }, errors }
  }

  const review = async (): Promise<void> => {
    const { body, errors } = buildRequest()
    if (errors.length > 0) {
      setError(errors.join('; '))
      return
    }
    if (body.config.length === 0 && body.env.length === 0) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const preview: ConfigDiff = await bridgeApi.configDiff(body)
      if (!aliveRef.current) return
      setPendingBody(body)
      setDiff(preview)
    } catch (cause) {
      if (!aliveRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (!pendingBody) return
    setBusy(true)
    setError(null)
    try {
      const applied: ConfigApplyResult = await bridgeApi.configApply(pendingBody)
      if (!aliveRef.current) return
      setResult(applied)
      setDiff(null)
      setPendingBody(null)
      setDrafts({})
      setEnvDrafts({})
      setDeletes(new Set())
      setEnvDeletes(new Set())
      await reload()
    } catch (cause) {
      if (!aliveRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const cancelDiff = (): void => {
    setDiff(null)
    setPendingBody(null)
  }

  const submitAdd = (): void => {
    const key = addKey.trim().toUpperCase()
    if (!ENV_KEY_PATTERN.test(key)) {
      setError(`invalid env key: ${key || '(empty)'}`)
      return
    }
    if (!addValue) {
      setError(`${key}: value required`)
      return
    }
    setEnvDrafts((current) => ({ ...current, [key]: addValue }))
    setAddKey('')
    setAddValue('')
    setError(null)
    setTab('env')
  }

  const renderField = (path: string, type: string): React.JSX.Element => {
    const initial = doc ? displayValue(getPath(doc.config, path)) : ''
    const isDeleted = deletes.has(path)
    const text = drafts[path] ?? initial
    const isSet = doc ? getPath(doc.config, path) !== undefined : false
    // What Hermes uses when the key is not set: shown as a hint, never as if it were the value.
    const fallback = doc?.defaults ? displayValue(getPath(doc.defaults, path)) : ''
    const hint = fallback ? `default: ${fallback}` : 'not set'
    const parsed = path in drafts ? parseDraft(type, text) : { ok: true as const, value: undefined }

    return (
      <div className={`field-row${isDeleted ? ' field-deleted' : ''}`} key={path}>
        <div className="field-label">
          <span className="field-path mono" data-testid={`field-path-${path}`}>
            {path.split('.').slice(-1)[0]}
          </span>
          <span className="chip chip-debug">{type}</span>
        </div>
        {isDeleted ? (
          <span className="panel-note">marked for removal</span>
        ) : type === 'boolean' ? (
          <select
            className="field-input"
            data-testid={`field-${path}`}
            value={text}
            onChange={(event) => setDraft(path, event.target.value)}
          >
            {!isSet ? <option value="">{`(${hint})`}</option> : null}
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : type === 'list' || type === 'object' ? (
          <textarea
            className="field-input mono"
            rows={2}
            data-testid={`field-${path}`}
            placeholder={isSet ? undefined : hint}
            value={text}
            onChange={(event) => setDraft(path, event.target.value)}
          />
        ) : (
          <input
            className="field-input"
            data-testid={`field-${path}`}
            placeholder={isSet ? undefined : hint}
            value={text}
            onChange={(event) => setDraft(path, event.target.value)}
          />
        )}
        <div className="field-actions">
          {!parsed.ok ? <span className="field-error">{parsed.error}</span> : null}
          {isSet ? (
            <button
              type="button"
              className="button button-ghost"
              data-testid={`remove-${path}`}
              onClick={() => toggleDelete(path)}
            >
              {isDeleted ? 'Undo' : 'Remove'}
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <section className="page page-config">
      <header className="page-head">
        <div>
          <h1>Configuration</h1>
          <p className="subtitle">
            {doc ? (
              <>
                <span className={`badge badge-${doc.source === 'deep' ? 'ready' : 'degraded'}`}>
                  {doc.source}
                </span>{' '}
                <span className="mono">{doc.path || 'config.yaml'}</span>
                {env ? (
                  <>
                    {' '}
                    · <span className="mono">{env.path || '.env'}</span>
                  </>
                ) : null}
              </>
            ) : (
              'Loading configuration…'
            )}
          </p>
        </div>
        <div className="toolbar">
          <span className="change-count" data-testid="change-count">
            {changeCount} pending
          </span>
          <button
            type="button"
            className="button button-primary"
            data-testid="review-changes"
            disabled={busy || changeCount === 0}
            onClick={() => void review()}
          >
            Review changes
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => void reload()}>
            Reload
          </button>
        </div>
      </header>

      <div className="toolbar-row">
        <div className="config-tabs">
          <button
            type="button"
            className={`button${tab === 'config' ? ' button-primary' : ''}`}
            data-testid="tab-config"
            onClick={() => setTab('config')}
          >
            config.yaml
          </button>
          <button
            type="button"
            className={`button${tab === 'env' ? ' button-primary' : ''}`}
            data-testid="tab-env"
            onClick={() => setTab('env')}
          >
            .env
          </button>
        </div>
        <input
          className="input config-search"
          data-testid="config-search"
          placeholder="Filter keys…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {error ? (
          <span className="ribbon-error" role="alert" data-testid="config-error">
            {error}
          </span>
        ) : null}
      </div>

      {result ? (
        <div className="panel result-banner" data-testid="config-result">
          <strong>Applied {result.applied.length} change(s).</strong>
          {result.backups.length > 0 ? (
            <div className="panel-note">
              backups: <span className="mono">{result.backups.join(', ')}</span>
            </div>
          ) : null}
          {result.warnings.map((warning) => (
            <div className="panel-note" key={warning}>
              {warning}
            </div>
          ))}
        </div>
      ) : null}

      {diff ? (
        <div className="panel diff-panel" data-testid="diff-panel">
          <div className="panel-head">
            <h2>Review changes</h2>
            <span className="panel-note">
              {diff.changes.length} change(s) — nothing written yet
            </span>
          </div>
          <ul className="diff-list">
            {diff.changes.map((change) => (
              <li
                className="diff-row"
                key={`${change.kind}:${change.path}:${change.action}`}
                data-testid="diff-row"
              >
                <span className={`chip chip-${change.kind === 'env' ? 'info' : 'debug'}`}>
                  {change.kind}
                </span>
                <span className="mono diff-path">{change.path}</span>
                <span className={`chip chip-${change.action === 'delete' ? 'warn' : 'ok'}`}>
                  {change.action}
                </span>
                <span className="diff-current mono">{change.current ?? '—'}</span>
                <span className="diff-arrow">→</span>
                <span className="diff-next mono">{change.next ?? '—'}</span>
              </li>
            ))}
          </ul>
          <div className="toolbar-row">
            <button
              type="button"
              className="button button-primary"
              data-testid="apply-confirm"
              disabled={busy}
              onClick={() => void apply()}
            >
              {busy ? 'Applying…' : 'Apply changes'}
            </button>
            <button
              type="button"
              className="button"
              data-testid="cancel-diff"
              disabled={busy}
              onClick={cancelDiff}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {tab === 'config' ? (
        <div data-testid="config-form">
          {doc?.detail ? <div className="panel panel-muted">{doc.detail}</div> : null}
          {grouped.map(([category, categoryFields]) => (
            <div className="panel" key={category}>
              <div className="panel-head">
                <h2>{category}</h2>
                <span className="panel-note">{categoryFields.length} key(s)</span>
              </div>
              <div className="field-grid">
                {categoryFields.map((field) => renderField(field.path, field.type))}
              </div>
            </div>
          ))}
          {grouped.length === 0 && doc ? (
            <div className="panel panel-muted">No keys match the filter.</div>
          ) : null}
        </div>
      ) : (
        <div className="panel" data-testid="env-form">
          <div className="panel-head">
            <h2>Environment</h2>
            <span className="panel-note">
              {env ? `${env.rows.length} variable(s) · source ${env.source}` : 'loading'}
            </span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {envRows.map((row) => {
                const isDeleted = envDeletes.has(row.key)
                const text = envDrafts[row.key] ?? (row.is_secret ? '' : (row.value ?? ''))
                const parsed =
                  row.key in envDrafts
                    ? parseDraft('string', text)
                    : { ok: true as const, value: undefined }
                return (
                  <tr key={row.key} data-key={row.key} className={isDeleted ? 'field-deleted' : ''}>
                    <td className="mono" data-testid={`env-key-${row.key}`}>
                      {row.key}
                      {row.category ? (
                        <span className="chip chip-debug">{row.category}</span>
                      ) : null}
                    </td>
                    <td>
                      {isDeleted ? (
                        <span className="panel-note">marked for removal</span>
                      ) : row.is_secret ? (
                        <input
                          className="field-input mono"
                          type="password"
                          data-testid={`env-value-${row.key}`}
                          placeholder={row.is_set ? `•••••• (${row.value ?? 'set'})` : 'not set'}
                          value={text}
                          onChange={(event) => setEnvDraft(row.key, event.target.value)}
                        />
                      ) : (
                        <input
                          className="field-input mono"
                          data-testid={`env-value-${row.key}`}
                          placeholder="not set"
                          value={text}
                          onChange={(event) => setEnvDraft(row.key, event.target.value)}
                        />
                      )}
                    </td>
                    <td>
                      <span className={`chip chip-${row.is_set ? 'ok' : 'debug'}`}>
                        {row.is_set ? 'set' : 'unset'}
                      </span>
                      {!parsed.ok ? <span className="field-error">{parsed.error}</span> : null}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="button button-ghost"
                        data-testid={`env-remove-${row.key}`}
                        disabled={!row.is_set && !isDeleted}
                        onClick={() => toggleEnvDelete(row.key)}
                      >
                        {isDeleted ? 'Undo' : 'Remove'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="config-add-row">
            <input
              className="field-input mono"
              data-testid="env-add-key"
              placeholder="NEW_VARIABLE"
              value={addKey}
              onChange={(event) => setAddKey(event.target.value)}
            />
            <input
              className="field-input mono"
              data-testid="env-add-value"
              placeholder="value"
              value={addValue}
              onChange={(event) => setAddValue(event.target.value)}
            />
            <button
              type="button"
              className="button"
              data-testid="env-add-submit"
              onClick={submitAdd}
            >
              Add variable
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
