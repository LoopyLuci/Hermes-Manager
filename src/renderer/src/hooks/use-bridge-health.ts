import { useCallback, useEffect, useRef, useState } from 'react'
import type { HealthReport } from '@shared/protocol'
import { bridgeApi } from '../lib/bridge-api'

export interface BridgeHealthState {
  health: HealthReport | null
  error: string | null
  live: boolean
  uptimeS: number | null
  refresh: () => void
}

export function useBridgeHealth(): BridgeHealthState {
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(false)
  const [uptimeS, setUptimeS] = useState<number | null>(null)
  const [nonce, setNonce] = useState(0)
  const socketRef = useRef<WebSocket | null>(null)

  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const load = (): void => {
      bridgeApi
        .health()
        .then((report) => {
          if (cancelled) return
          setHealth(report)
          setError(null)
          setUptimeS(report.uptime_s)
        })
        .catch((cause: unknown) => {
          if (cancelled) return
          setError(cause instanceof Error ? cause.message : String(cause))
          timer = setTimeout(load, 3000)
        })
    }
    load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [nonce])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const connect = async (): Promise<void> => {
      const info = await window.hermes?.bridgeInfo?.()
      if (disposed) return
      if (!info) {
        timer = setTimeout(() => void connect(), 1000)
        return
      }
      const url = `${info.url.replace(/^http/, 'ws')}/api/v1/stream?token=${encodeURIComponent(info.token)}`
      const socket = new WebSocket(url)
      socketRef.current = socket
      socket.onopen = () => setLive(true)
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as { uptime_s?: number }
          if (typeof payload.uptime_s === 'number') setUptimeS(payload.uptime_s)
        } catch {
          /* ignore malformed frames */
        }
      }
      socket.onclose = () => {
        setLive(false)
        if (!disposed) timer = setTimeout(() => void connect(), 3000)
      }
      socket.onerror = () => socket.close()
    }

    void connect()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      socketRef.current?.close()
    }
  }, [])

  return { health, error, live, uptimeS, refresh }
}
