/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MAIN_VITE_BRIDGE_PORT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
