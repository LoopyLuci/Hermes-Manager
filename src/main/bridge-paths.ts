import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { app } from 'electron'

export interface BridgeLaunchOptions {
  token: string
  hermesHome: string
  hermesRepo: string | null
}

/**
 * Location of the bridge package (src/bridge).
 * In dev the bundle lives in out/main with sources at <root>/src/bridge;
 * in production electron-builder copies it via extraResources to
 * <resources>/app/src/bridge (outside the asar).
 */
export function bridgeDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app', 'src', 'bridge')
    : join(app.getAppPath(), 'src', 'bridge')
}

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

export function resolveHermesHome(): string {
  const fromEnv = process.env.HERMES_HOME?.trim()
  if (fromEnv) return fromEnv
  return join(app.getPath('appData'), 'hermes')
}
