import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatEvent, SessionSummary } from '@shared/protocol'
import { bridgeApi } from '../../lib/bridge-api'

type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'notice'; text: string }

function newChatId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function ChatPage(): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([])
  const [draft, setDraft] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [liveText, setLiveText] = useState<string | null>(null)
  const chatIdRef = useRef(newChatId())
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const liveTextRef = useRef<string | null>(null)

  useEffect(() => {
    liveTextRef.current = liveText
  }, [liveText])

  useEffect(() => {
    bridgeApi
      .sessions(undefined, 30)
      .then((page) => setSessions(page.sessions))
      .catch(() => setSessions([]))
  }, [])

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [entries, liveText])

  const handleEvent = useCallback((event: ChatEvent) => {
    switch (event.type) {
      case 'text': {
        const text = String(event.text ?? '')
        setLiveText((current) => (current ?? '') + text)
        break
      }
      case 'tool_use':
        setEntries((current) => [
          ...current,
          { kind: 'tool', name: String(event.name ?? 'tool'), detail: 'running…' },
        ])
        break
      case 'tool_result':
        setEntries((current) => {
          const next = [...current]
          for (let index = next.length - 1; index >= 0; index -= 1) {
            const entry = next[index]
            if (entry && entry.kind === 'tool' && entry.name === String(event.name)) {
              next[index] = {
                kind: 'tool',
                name: entry.name,
                detail: String(event.output ?? (event.is_error ? 'failed' : 'done')),
              }
              break
            }
          }
          return next
        })
        break
      case 'result': {
        const finalText = typeof event.text === 'string' ? event.text : ''
        setEntries((current) => [
          ...current,
          { kind: 'assistant', text: finalText || (liveTextRef.current ?? '') },
        ])
        setLiveText(null)
        const resolved =
          typeof event.session_id === 'string' && event.session_id ? event.session_id : null
        if (resolved) setSessionId(resolved)
        break
      }
      case 'system':
        if (typeof event.session_id === 'string' && event.session_id) setSessionId(event.session_id)
        break
      case 'manager.done':
        if (typeof event.session_id === 'string' && event.session_id) setSessionId(event.session_id)
        break
      case 'manager.error':
        setError(String(event.detail ?? 'chat failed'))
        setEntries((current) => [
          ...current,
          { kind: 'notice', text: String(event.detail ?? 'chat failed') },
        ])
        break
      default:
        break
    }
  }, [])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    setError(null)
    setBusy(true)
    setLiveText('')
    setEntries((current) => [...current, { kind: 'user', text }])
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await bridgeApi.chat(
        { text, session_id: sessionId, chat_id: chatIdRef.current },
        handleEvent,
        controller.signal,
      )
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        setEntries((current) => [...current, { kind: 'notice', text: message }])
      }
    } finally {
      setBusy(false)
      setLiveText(null)
      abortRef.current = null
      chatIdRef.current = newChatId()
    }
  }

  const stop = (): void => {
    abortRef.current?.abort()
    void bridgeApi.abortChat(chatIdRef.current).catch(() => undefined)
    setBusy(false)
    setLiveText(null)
    setEntries((current) => [...current, { kind: 'notice', text: 'stopped' }])
  }

  const reset = (): void => {
    if (busy) return
    setEntries([])
    setSessionId(null)
    setError(null)
  }

  const pickSession = async (id: string): Promise<void> => {
    if (busy) return
    setSessionId(id)
    setEntries([])
    setError(null)
    try {
      const page = await bridgeApi.sessionMessages(id, 200, 'latest')
      const restored: Entry[] = page.messages
        .filter(
          (message) =>
            (message.role === 'user' || message.role === 'assistant') &&
            String(message.content ?? '').trim(),
        )
        .map((message) =>
          message.role === 'user'
            ? { kind: 'user', text: String(message.content) }
            : { kind: 'assistant', text: String(message.content) },
        )
      setEntries(restored)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <section className="page page-chat">
      <header className="page-head">
        <div>
          <h1>Chat</h1>
          <p className="subtitle">
            {sessionId ? (
              <>
                session <span className="mono">{sessionId}</span>
              </>
            ) : (
              'new session'
            )}
            {error ? <span className="ribbon-error"> {error}</span> : null}
          </p>
        </div>
        <div className="toolbar">
          <select
            className="input"
            aria-label="Resume a session"
            value=""
            onChange={(event) => {
              if (event.target.value) void pickSession(event.target.value)
            }}
          >
            <option value="">Resume session…</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {(session.title?.trim() || session.id).slice(0, 60)}
              </option>
            ))}
          </select>
          <button type="button" className="button" onClick={reset} disabled={busy}>
            New chat
          </button>
        </div>
      </header>

      <div className="chat-transcript" ref={scrollRef} data-testid="chat-transcript">
        {entries.length === 0 && liveText == null ? (
          <p className="panel-note">Send a message to start a conversation.</p>
        ) : null}
        {entries.map((entry, index) => (
          <div className={`chat-entry chat-${entry.kind}`} key={`${entry.kind}-${index}`}>
            <span className="chat-role">{entry.kind === 'notice' ? '!' : entry.kind}</span>
            <span className="chat-text">{entry.kind === 'tool' ? entry.detail : entry.text}</span>
          </div>
        ))}
        {liveText ? (
          <div className="chat-entry chat-assistant" data-testid="chat-live">
            <span className="chat-role">assistant</span>
            <span className="chat-text">{liveText}</span>
          </div>
        ) : null}
      </div>

      <div className="chat-composer">
        <textarea
          className="input chat-input"
          rows={3}
          placeholder="Message the agent…"
          value={draft}
          aria-label="Message"
          data-testid="chat-input"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="chat-buttons">
          <button
            type="button"
            className="button button-primary"
            disabled={busy || !draft.trim()}
            onClick={() => void send()}
            data-testid="chat-send"
          >
            {busy ? 'Streaming…' : 'Send'}
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={!busy}
            onClick={stop}
            data-testid="chat-stop"
          >
            Stop
          </button>
        </div>
      </div>
    </section>
  )
}
