import { useCallback, useEffect, useRef, useState } from 'react'
import type { BridgeStateDto } from '@shared/protocol'

export interface BridgeStatusState {
  status: BridgeStateDto['status'] | null
  lastError: string | null
  retry: () => void
}

/**
 * Polls the main-process bridge supervisor: fast while not ready, slow once
 * stable. `retry` re-runs `bridge:start` (safe to call repeatedly).
 */
export function useBridgeStatus(): BridgeStatusState {
  const [state, setState] = useState<BridgeStateDto | null>(null)
  const [nonce, setNonce] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const retry = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    let disposed = false
    const poll = async (): Promise<void> => {
      try {
        const next = await window.hermes?.bridgeState?.()
        if (disposed) return
        setState(next ?? null)
        timerRef.current = setTimeout(() => void poll(), next?.status === 'ready' ? 10_000 : 2_000)
      } catch {
        if (disposed) return
        timerRef.current = setTimeout(() => void poll(), 5_000)
      }
    }
    void poll()
    return () => {
      disposed = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [nonce])

  const startBridge = useCallback(() => {
    void window.hermes?.startBridge?.().catch(() => undefined)
    retry()
  }, [retry])

  return { status: state?.status ?? null, lastError: state?.lastError ?? null, retry: startBridge }
}
