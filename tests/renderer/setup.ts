import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

class SilentWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null

  constructor(_url: string) {}

  send(_data: string): void {}

  close(): void {
    this.readyState = 3
    this.onclose?.({})
  }
}

;(globalThis as unknown as { WebSocket: unknown }).WebSocket = SilentWebSocket

if (typeof globalThis.ResizeObserver === 'undefined') {
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return []
    }
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver
}

// jsdom has no layout engine: give the log viewport a real size so
// @tanstack/virtual can compute a visible range (it reads offsetHeight/offsetWidth).
for (const prop of ['offsetHeight', 'offsetWidth'] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.classList?.contains('log-viewport')) return prop === 'offsetHeight' ? 700 : 1200
      return (descriptor?.get?.call(this) as number | undefined) ?? 0
    }
  })
}

afterEach(() => {
  cleanup()
})
