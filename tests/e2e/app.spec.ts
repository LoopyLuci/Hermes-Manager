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
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
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
