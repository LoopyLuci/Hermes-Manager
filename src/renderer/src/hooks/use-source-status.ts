import { useCallback, useEffect, useState } from 'react'
import type { SourceStatus } from '@shared/protocol'
import { bridgeApi } from '../lib/bridge-api'

export interface SourceStatusState {
  sources: SourceStatus | null
  error: string | null
  refresh: () => void
}

export function useSourceStatus(): SourceStatusState {
  const [sources, setSources] = useState<SourceStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((value) => value + 1), [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      bridgeApi
        .sources()
        .then((status) => {
          if (cancelled) return
          setSources(status)
          setError(null)
        })
        .catch((cause: unknown) => {
          if (cancelled) return
          setError(cause instanceof Error ? cause.message : String(cause))
          timer = setTimeout(load, 5000)
        })
    }
    load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [nonce])

  return { sources, error, refresh }
}
