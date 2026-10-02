import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const root = join(__dirname, '..', '..')
const electronBinary = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  test.skip(!existsSync(electronBinary), 'electron binary not installed')
  test.skip(!existsSync(join(root, 'out', 'renderer', 'index.html')), 'run npm run build first')
  app = await _electron.launch({
    executablePath: electronBinary,
    args: [root],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      // Close-to-tray off so Playwright teardown always terminates the app.
      HM_E2E: '1',
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
})

test('boots into the overview with a live bridge', async () => {
  await expect(page.getByTestId('nav-overview')).toBeVisible()
  await expect(page.getByTestId('nav-tools')).toBeEnabled()

  let last = ''
  for (let i = 0; i < 30; i++) {
    last = await page.evaluate(async () =>
      JSON.stringify(
        await (
          window as unknown as { hermes: { bridgeState: () => Promise<unknown> } }
        ).hermes.bridgeState(),
      ),
    )
    if (last.includes('"ready"')) break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  expect(last).toContain('"ready"')

  const ribbon = page.getByTestId('status-ribbon')
  await expect(ribbon).toBeVisible()
  await expect(ribbon).toContainText(/hermes-venv|store-python|python/i, { timeout: 60_000 })
})

test('navigates every section', async () => {
  for (const section of [
    'logs',
    'gateway',
    'sessions',
    'chat',
    'config',
    'updates',
    'backups',
    'tools',
  ]) {
    await page.getByTestId(`nav-${section}`).click()
    await expect(page.getByTestId(`nav-${section}`)).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('section.page h1').first()).toBeVisible()
  }
  await expect(page.getByTestId('tab-mcp')).toBeVisible()
})

test('log explorer loads the tail', async () => {
  await page.getByTestId('nav-logs').click()
  await expect(page.getByTestId('log-viewport')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('text=agent.log').first()).toBeVisible()
})

test('can be driven from outside through the bridge', async () => {
  // What the MCP server and ABP do: find the bridge from its discovery file and call the window's operations.
  const { readFileSync } = await import('node:fs')
  const { homedir } = await import('node:os')
  const record = JSON.parse(
    readFileSync(
      join(process.env.HM_HOME ?? join(homedir(), '.hermes-manager'), 'control.json'),
      'utf8',
    ),
  ) as { url: string; token: string }
  const call = async (
    op: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${record.url}/api/v1/gui/${op}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${record.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      })
      if (r.status !== 409) return (await r.json()) as Record<string, unknown>
      await new Promise((resolve) => setTimeout(resolve, 500)) // the window is still attaching
    }
    throw new Error('the window never attached')
  }
  const sections = (await call('sections')) as unknown as Array<{ section: string }>
  expect(sections.map((s) => s.section)).toContain('backups')
  await call('open', { section: 'backups' })
  await expect(page.getByTestId('nav-backups')).toHaveAttribute('aria-current', 'page')
  const found = (await call('find', { query: 'backup' })) as unknown as unknown[]
  expect(found.length).toBeGreaterThan(0)
  await call('click', { target: { id: 'nav-logs' } })
  await expect(page.getByTestId('nav-logs')).toHaveAttribute('aria-current', 'page')
  const shot = await call('screenshot', { max_width: 800 })
  expect(shot.format).toBe('png')
  expect(String(shot.base64).length).toBeGreaterThan(1000)
  const state = await call('state')
  expect(state.section).toBe('logs')
})
