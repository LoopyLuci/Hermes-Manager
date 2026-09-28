import type { HermesApi } from './index'

declare global {
  interface Window {
    hermes: HermesApi
  }
}

export {}
