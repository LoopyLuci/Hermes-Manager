/// <reference lib="dom" />
/**
 * Remote control of the window, for the MCP server, ABP and scripts.
 *
 * The main process keeps a WebSocket to the bridge's /api/v1/gui/attach (reconnecting when the bridge restarts).
 * Each call that arrives runs here: page operations run inside the page through webContents.executeJavaScript
 * (the page script below), screenshots through capturePage, and window operations on the BrowserWindow. Nothing in
 * the renderer had to change: elements are found by their data-testid, their role and their visible text or label.
 */
import type { BrowserWindow } from 'electron'
import type { BridgeInfo } from '@shared/protocol'

type Args = Record<string, unknown>

/** Runs in the page. Returns plain JSON. Kept dependency-free: it is sent as source text. */
function pageScript(op: string, args: Args): unknown {
  const MAX_TEXT = 300
  const INTERACTIVE =
    'button, a[href], input, select, textarea, [role=button], [role=tab], [role=link], [role=checkbox], [role=switch], ' +
    '[role=menuitem], [role=option], [contenteditable=true], [data-testid], table, [role=table], h1, h2, h3, label'

  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const text = (el: Element): string =>
    ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  const labelOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria
    const id = el.getAttribute('id')
    if (id) {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`)
      if (l) return text(l)
    }
    const wrap = el.closest('label')
    if (wrap && wrap !== el) return text(wrap)
    const by = el.getAttribute('aria-labelledby')
    if (by)
      return by
        .split(/\s+/)
        .map((i) => text(document.getElementById(i) as Element))
        .join(' ')
    return (el as HTMLInputElement).placeholder || el.getAttribute('title') || ''
  }
  const kind = (el: Element): string => {
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute('role')
    if (tag === 'input') {
      const t = (el as HTMLInputElement).type
      return t === 'checkbox' || t === 'radio'
        ? t
        : t === 'submit' || t === 'button'
          ? 'button'
          : 'text'
    }
    if (tag === 'textarea') return 'textarea'
    if (tag === 'select') return 'select'
    if (tag === 'a') return 'link'
    if (tag === 'table' || role === 'table') return 'table'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'label') return 'label'
    return role || (tag === 'button' ? 'button' : tag)
  }
  const all = (): Element[] => Array.from(document.querySelectorAll(INTERACTIVE)).filter(visible)
  const idOf = (el: Element, index: number): string =>
    el.getAttribute('data-testid') || el.getAttribute('id') || `${kind(el)}#${index}`
  const describe = (el: Element, index: number): Record<string, unknown> => {
    const d: Record<string, unknown> = {
      id: idOf(el, index),
      kind: kind(el),
      text: text(el).slice(0, MAX_TEXT),
    }
    const label = labelOf(el)
    if (label) d.label = label.slice(0, 200)
    const input = el as HTMLInputElement
    if ('value' in input && el.tagName !== 'BUTTON')
      d.value = input.type === 'password' ? (input.value ? '***' : '') : input.value
    if (input.type === 'checkbox' || input.type === 'radio') d.checked = input.checked
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true')
      d.enabled = false
    if (el.getAttribute('aria-current') || el.getAttribute('aria-selected') === 'true')
      d.current = true
    if (el.tagName === 'SELECT')
      d.options = Array.from((el as HTMLSelectElement).options).map((o) => ({
        value: o.value,
        text: o.text,
      }))
    return d
  }
  const resolve = (target: Args | undefined): Element => {
    const t = (target || {}) as { id?: string; text?: string; role?: string }
    const els = all()
    if (t.id) {
      const exact =
        document.querySelector(`[data-testid="${CSS.escape(t.id)}"]`) ||
        document.getElementById(t.id)
      if (exact) return exact
      const byGen = els.find((el, i) => idOf(el, i) === t.id)
      if (byGen) return byGen
      throw new Error(`no element ${t.id}`)
    }
    if (t.text) {
      const want = t.text.toLowerCase()
      const pool = els.filter((el) => !t.role || kind(el) === t.role)
      const exact = pool.filter(
        (el) => text(el).toLowerCase() === want || labelOf(el).toLowerCase() === want,
      )
      const loose = exact.length
        ? exact
        : pool.filter(
            (el) =>
              text(el).toLowerCase().includes(want) || labelOf(el).toLowerCase().includes(want),
          )
      // a label names a field: prefer the field, and prefer interactive elements over headings and labels
      const ranked = loose.sort(
        (a, b) =>
          Number(['label', 'heading'].includes(kind(a))) -
          Number(['label', 'heading'].includes(kind(b))),
      )
      if (ranked[0]) return ranked[0]
      throw new Error(`nothing on screen shows "${t.text}"`)
    }
    throw new Error('target needs an id or a text')
  }
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    // React tracks the value itself: set it through the prototype's setter, then announce it.
    const proto =
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const tableRows = (el: Element): unknown => {
    const rows = Array.from(el.querySelectorAll('tr')).slice(0, 300)
    return rows.map((r) =>
      Array.from(r.querySelectorAll('th,td')).map((c) => text(c).slice(0, 200)),
    )
  }

  switch (op) {
    case 'sections':
      return Array.from(document.querySelectorAll('[data-testid^="nav-"]')).map((b) => ({
        section: (b.getAttribute('data-testid') || '').slice(4),
        label: text(b),
        current: b.getAttribute('aria-current') === 'page',
        enabled: !(b as HTMLButtonElement).disabled,
      }))
    case 'current':
      return (
        document
          .querySelector('[aria-current="page"][data-testid^="nav-"]')
          ?.getAttribute('data-testid') || 'nav-'
      ).slice(4)
    case 'open': {
      const b = document.querySelector(
        `[data-testid="nav-${String(args.section).toLowerCase()}"]`,
      ) as HTMLButtonElement | null
      if (!b) throw new Error(`no section ${String(args.section)}`)
      if (b.disabled) throw new Error(`section ${String(args.section)} is not available yet`)
      b.click()
      return { section: String(args.section).toLowerCase() }
    }
    case 'inspect': {
      const max = Number(args.max || 400)
      const els = all()
      return {
        count: els.length,
        elements: els.slice(0, max).map((el, i) => describe(el, i)),
        truncated: els.length > max,
      }
    }
    case 'find': {
      const q = String(args.query || '').toLowerCase()
      return all()
        .map((el, i) => describe(el, i))
        .filter((d) => JSON.stringify(d).toLowerCase().includes(q))
        .slice(0, 100)
    }
    case 'read': {
      const el = resolve(args.target as Args)
      const d = describe(el, 0)
      if (kind(el) === 'table') d.rows = tableRows(el)
      d.text = text(el).slice(0, 20000)
      return d
    }
    case 'text': {
      const el = args.target
        ? resolve(args.target as Args)
        : document.querySelector('.content') || document.body
      return { text: text(el).slice(0, Number(args.max_chars || 20000)) }
    }
    case 'click': {
      const el = resolve(args.target as Args) as HTMLElement
      if ((el as HTMLButtonElement).disabled) throw new Error('that element is disabled')
      el.scrollIntoView({ block: 'center' })
      el.click()
      return { clicked: describe(el, 0) }
    }
    case 'fill': {
      const el = resolve(args.target as Args) as HTMLInputElement
      if (!('value' in el)) throw new Error('that element is not a text field')
      el.focus()
      setValue(el, String(args.value ?? ''))
      if (args.submit) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        el.form?.requestSubmit()
      }
      return { filled: describe(el, 0) }
    }
    case 'select': {
      const el = resolve(args.target as Args) as HTMLSelectElement
      if (el.tagName !== 'SELECT') throw new Error('that element is not a select box')
      const want = String(args.option)
      const opt = Array.from(el.options).find((o) => o.value === want || o.text === want)
      if (!opt) throw new Error(`no option ${want}`)
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
        el,
        opt.value,
      )
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { selected: describe(el, 0) }
    }
    case 'check': {
      const el = resolve(args.target as Args) as HTMLInputElement
      const isBox = el.type === 'checkbox' || el.type === 'radio'
      const on = isBox ? el.checked : el.getAttribute('aria-checked') === 'true'
      if (on !== Boolean(args.checked)) el.click()
      return { checked: describe(el, 0) }
    }
    case 'key': {
      const el = (
        args.target ? resolve(args.target as Args) : document.activeElement || document.body
      ) as HTMLElement
      const parts = String(args.keys).split('+')
      const key = parts.pop() || ''
      const mods = parts.map((p) => p.toLowerCase())
      const init = {
        key,
        bubbles: true,
        ctrlKey: mods.includes('ctrl'),
        shiftKey: mods.includes('shift'),
        altKey: mods.includes('alt'),
        metaKey: mods.includes('meta'),
      }
      el.dispatchEvent(new KeyboardEvent('keydown', init))
      el.dispatchEvent(new KeyboardEvent('keyup', init))
      if (key === 'Enter' && el instanceof HTMLButtonElement) el.click()
      return { pressed: args.keys }
    }
    case 'probe': {
      try {
        const el = resolve(args.target as Args)
        const d = describe(el, 0)
        const t = String(args.text || '').toLowerCase()
        return { found: true, element: d, text_ok: !t || text(el).toLowerCase().includes(t) }
      } catch {
        const t = String(args.text || '').toLowerCase()
        return { found: false, text_ok: t ? text(document.body).toLowerCase().includes(t) : false }
      }
    }
    default:
      throw new Error(`unknown page operation ${op}`)
  }
}

async function inPage(win: BrowserWindow, op: string, args: Args): Promise<unknown> {
  const source = `(${pageScript.toString()})(${JSON.stringify(op)}, ${JSON.stringify(args)})`
  return win.webContents.executeJavaScript(source, true)
}

async function run(
  win: BrowserWindow,
  op: string,
  args: Args,
  bridgeState: () => unknown,
): Promise<unknown> {
  const name = op.replace(/^gui\./, '')
  switch (name) {
    case 'state': {
      const [width, height] = win.getSize()
      return {
        visible: win.isVisible(),
        focused: win.isFocused(),
        minimized: win.isMinimized(),
        maximized: win.isMaximized(),
        width,
        height,
        title: win.getTitle(),
        section: await inPage(win, 'current', {}),
        bridge: bridgeState(),
      }
    }
    case 'window': {
      const action = String(args.action)
      if (action === 'show') win.show()
      else if (action === 'hide') win.hide()
      else if (action === 'focus') {
        win.show()
        win.focus()
      } else if (action === 'minimize') win.minimize()
      else if (action === 'maximize') win.maximize()
      else if (action === 'restore') {
        if (win.isMinimized()) win.restore()
        win.unmaximize()
        win.show()
      } else if (action === 'resize') win.setSize(Number(args.width), Number(args.height))
      else throw new Error(`unknown window action ${action}`)
      return run(win, 'state', {}, bridgeState)
    }
    case 'screenshot': {
      const image = await win.webContents.capturePage()
      const maxWidth = Number(args.max_width || 1600)
      const size = image.getSize()
      const out = size.width > maxWidth ? image.resize({ width: maxWidth }) : image
      const png = out.toPNG()
      return {
        format: 'png',
        width: out.getSize().width,
        height: out.getSize().height,
        base64: png.toString('base64'),
      }
    }
    case 'wait': {
      const deadline = Date.now() + Math.min(Number(args.timeout_s || 10), 120) * 1000
      let last: unknown = null
      while (Date.now() < deadline) {
        last = await inPage(win, 'probe', args)
        const p = last as { found: boolean; text_ok: boolean }
        if ((args.target ? p.found : true) && (args.text ? p.text_ok : true)) return last
        await new Promise((r) => setTimeout(r, 200))
      }
      throw new Error(`timed out waiting (${JSON.stringify(last)})`)
    }
    default:
      return inPage(win, name, args)
  }
}

/** Keeps the window attached to the bridge for as long as the app runs. */
export class Automation {
  private socket: WebSocket | null = null
  private info: BridgeInfo | null = null
  private closed = false
  private retry: NodeJS.Timeout | null = null

  constructor(
    private readonly window: () => BrowserWindow | null,
    private readonly bridgeState: () => unknown,
  ) {}

  attach(info: BridgeInfo): void {
    this.info = info
    this.connect()
  }

  close(): void {
    this.closed = true
    if (this.retry) clearTimeout(this.retry)
    this.socket?.close()
  }

  private connect(): void {
    if (this.closed || !this.info) return
    this.socket?.close()
    const url = `${this.info.url.replace(/^http/, 'ws')}/api/v1/gui/attach?token=${encodeURIComponent(this.info.token)}`
    const socket = new WebSocket(url)
    this.socket = socket
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', pid: process.pid, app: 'Hermes Manager' }))
    })
    socket.addEventListener('message', (event) => {
      let msg: { type?: string; id?: string; op?: string; args?: Args }
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (msg.type !== 'call' || !msg.id || !msg.op) return
      const win = this.window()
      const reply = (body: Record<string, unknown>): void =>
        socket.send(JSON.stringify({ type: 'reply', id: msg.id, ...body }))
      if (!win) {
        reply({ ok: false, error: 'the window is closed' })
        return
      }
      run(win, msg.op, msg.args || {}, this.bridgeState)
        .then((result) => reply({ ok: true, result }))
        .catch((error: unknown) =>
          reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        )
    })
    socket.addEventListener('close', () => {
      if (this.socket === socket && !this.closed)
        this.retry = setTimeout(() => this.connect(), 3000)
    })
    socket.addEventListener('error', () => undefined)
  }
}
