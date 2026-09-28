import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, SessionSummary } from '@shared/protocol'
import { bridgeApi } from '../../lib/bridge-api'

function formatDate(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toISOString().slice(0, 16).replace('T', ' ')
}

function renderContent(content: ChatMessage['content']): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

export function SessionsPage(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<string>('—')
  const aliveRef = useRef(true)

  const loadSessions = useCallback(async (q?: string) => {
    try {
      const page = await bridgeApi.sessions(q, 100)
      if (!aliveRef.current) return
      setSessions(page.sessions)
      setTotal(page.total)
      setSource(page.source)
      setError(page.detail)
    } catch (cause) {
      if (!aliveRef.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    void loadSessions()
    return () => {
      aliveRef.current = false
    }
  }, [loadSessions])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSessions(query.trim() || undefined), 250)
    return () => window.clearTimeout(timer)
  }, [query, loadSessions])

  const openSession = async (id: string): Promise<void> => {
    setSelected(id)
    setMessages([])
    try {
      const page = await bridgeApi.sessionMessages(id, 300)
      if (aliveRef.current) setMessages(page.messages)
    } catch (cause) {
      if (aliveRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <section className="page page-sessions">
      <header className="page-head">
        <div>
          <h1>Sessions</h1>
          <p className="subtitle">
            {total} sessions · source <span className="badge badge-ready">{source}</span>
            {error ? <span className="ribbon-error"> {error}</span> : null}
          </p>
        </div>
        <div className="toolbar">
          <input
            className="input"
            type="search"
            placeholder="Search title or id…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search sessions"
          />
        </div>
      </header>

      <div className="sessions-layout">
        <aside className="sessions-list" data-testid="sessions-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session-row${selected === session.id ? ' session-row-active' : ''}`}
              onClick={() => void openSession(session.id)}
              data-testid="session-row"
            >
              <span className="session-title">{session.title?.trim() || session.id}</span>
              <span className="session-meta">
                {session.source ?? '—'} · {session.message_count ?? '?'} msgs ·{' '}
                {formatDate(session.last_activity_at)}
                {session.archived ? ' · archived' : ''}
              </span>
            </button>
          ))}
          {sessions.length === 0 ? <p className="panel-note">No sessions match.</p> : null}
        </aside>

        <div className="session-detail" data-testid="messages-panel">
          {!selected ? (
            <p className="panel-note">Select a session to read its transcript.</p>
          ) : (
            <>
              <div className="panel-head">
                <h2 className="mono">{selected}</h2>
                <span className="panel-note">{messages.length} messages loaded</span>
              </div>
              <div className="message-scroll">
                {messages.map((message) => (
                  <div className={`message-line message-${message.role}`} key={message.id}>
                    <span className="message-role">{message.role}</span>
                    <span className="message-body">{renderContent(message.content)}</span>
                  </div>
                ))}
                {messages.length === 0 ? <p className="panel-note">No active messages.</p> : null}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
