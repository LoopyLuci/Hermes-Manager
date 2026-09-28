import { app, session, shell } from 'electron'
import { URL } from 'node:url'

/** Dev = unpackaged (vite dev server); packaged builds are always production. */
const isDev = !app.isPackaged

/**
 * Content security policy for the renderer. In dev the Vite HMR server must be
 * reachable; in production everything is served from the app origin.
 */
export function contentSecurityPolicy(): string {
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ]
  if (isDev)
    directives.push("script-src 'self' 'unsafe-inline'", "connect-src 'self' ws://localhost:*")
  return directives.join('; ')
}

/** Lock the renderer down: no off-origin navigation, no window.open, no surprises. */
export function installSecurityPolicy(): void {
  const ses = session.defaultSession
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy()],
      },
    })
  })

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write')
  })

  const allowedSchemes = new Set(['http:', 'https:', 'file:', 'mailto:'])
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (details.resourceType === 'mainFrame') {
      const target = new URL(details.url)
      const devServer =
        isDev && (target.hostname === 'localhost' || target.hostname === '127.0.0.1')
      if (!allowedSchemes.has(target.protocol) && !devServer) return callback({ cancel: true })
    }
    callback({})
  })
}

export async function openExternal(url: string): Promise<void> {
  const parsed = new URL(url)
  if (
    parsed.protocol === 'https:' ||
    parsed.protocol === 'http:' ||
    parsed.protocol === 'mailto:'
  ) {
    await shell.openExternal(url)
  }
}
