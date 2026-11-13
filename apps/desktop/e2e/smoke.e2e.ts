// Desktop shell smoke test (RFC 0046 step b): the real Electron app from source, a real studiod and an isolated data
// directory. No Agents, models or paid services are used.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SpaceSummary } from '@vis/protocol'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { removeTempDir } from '../../web/e2e/platform'
import { openStudiodLink } from '../../web/src/host/studiod-link'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const desktop = join(root, 'apps', 'desktop')
const electronBinary = createRequire(import.meta.url)('electron') as unknown as string
const ready = existsSync(electronBinary) && existsSync(join(desktop, 'dist', 'main.mjs')) && existsSync(join(root, 'services/studiod/dist/studiod.mjs')) && existsSync(join(root, 'apps/web/dist/client/index.html'))

let dataDir: string
let electronApp: ElectronApplication | undefined
const env = () => ({ ...process.env, VIS_DATA_DIR: dataDir, VIS_PROJECTS_DIR: join(dataDir, 'projects') } as Record<string, string>)
const tokenPath = () => join(dataDir, 'run', 'studiod.token')
const link = () => openStudiodLink({ socketPath: studiodEndpoint(dataDir), tokenPath: tokenPath() })

async function launch(): Promise<Page> {
  electronApp = await _electron.launch({ executablePath: electronBinary, args: [desktop], env: env() })
  const page = await electronApp.firstWindow()
  const admin = await link()
  const projects = (await admin.call('space.list')).spaces as SpaceSummary[]
  admin.close()
  // The first-run project is on screen once the page has connected through the in-process host.
  await page.getByText(projects[0]!.name).first().waitFor({ timeout: 15_000 })
  return page
}

describe.runIf(ready)('desktop shell', () => {
  beforeAll(() => { dataDir = mkdtempSync(join(tmpdir(), 'vis-desktop-smoke-')) })
  afterAll(async () => {
    await electronApp?.close().catch(() => {})
    // studiod outlives the app by design; stop it before removing its data.
    const admin = await link().catch(() => undefined)
    if (admin) {
      const closed = new Promise<void>(resolve => { const timer = setInterval(() => { if (admin.closed) { clearInterval(timer); resolve() } }, 50) })
      await admin.call('runtime.shutdown', { reason: 'user_quit' }).catch(() => {})
      await closed
    }
    removeTempDir(dataDir)
  })

  it('starts studiod, shows the UI in a locked-down window, and keeps studiod and preferences across a relaunch', async () => {
    const page = await launch()
    const app = electronApp!
    const origin = new URL(page.url()).origin
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(existsSync(join(dataDir, 'logs', 'studiod.log'))).toBe(true)

    // The page has no Node access; the folder dialog is the only bridge.
    expect(await page.evaluate(() => [typeof (globalThis as any).require, typeof (globalThis as any).process, typeof (window as any).visDesktop?.pickDirectory])).toEqual(['undefined', 'undefined', 'function'])
    await app.evaluate(({ dialog }, picked) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as any }, dataDir)
    expect(await page.evaluate(() => (window as any).visDesktop.pickDirectory())).toEqual({ path: dataDir, cancelled: false })
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as any })
    expect(await page.evaluate(() => (window as any).visDesktop.pickDirectory())).toEqual({ cancelled: true })

    // Other origins never load inside the app: they are handed to the system browser (stubbed here).
    await app.evaluate(({ shell }) => { (globalThis as any).opened = []; shell.openExternal = (async (url: string) => { (globalThis as any).opened.push(url) }) as any })
    await page.evaluate(() => { window.open('https://example.com/docs') })
    await page.evaluate(() => { location.href = 'https://example.com/elsewhere' }).catch(() => {})
    await expect.poll(() => app.evaluate(() => (globalThis as any).opened)).toEqual(['https://example.com/docs', 'https://example.com/elsewhere'])
    expect(app.windows()).toHaveLength(1)
    expect(new URL(page.url()).origin).toBe(origin)

    // A second launch defers to the running app instead of opening another.
    const second = spawn(electronBinary, [desktop], { env: env(), stdio: 'ignore' })
    expect(await new Promise(resolve => second.once('exit', resolve))).toBe(0)
    expect(app.windows()).toHaveLength(1)

    await page.evaluate(() => localStorage.setItem('vis.smoke', 'kept'))
    const token = readFileSync(tokenPath(), 'utf8')
    // Returns once the app process and its output pipes are gone, which also shows studiod did not inherit them.
    await app.close()

    // Quitting the app leaves studiod running (RFC 0004); the next launch attaches to it on the same origin.
    const survivor = await link()
    survivor.close()
    const again = await launch()
    expect(readFileSync(tokenPath(), 'utf8')).toBe(token)
    expect(new URL(again.url()).origin).toBe(origin)
    expect(await again.evaluate(() => localStorage.getItem('vis.smoke'))).toBe('kept')
  }, 90_000)
})
