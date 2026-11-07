import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkMessageView } from '@vis/protocol'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '../../../packages/generation/src/index'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = join(root, 'apps/cli/dist/vis.mjs')
const ready = existsSync(chromePath()) && existsSync(cli) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const artifacts = process.platform === 'win32' ? 'C:/tmp/vis-0038-R1' : '/tmp/vis-0038-R1'
const rid = () => crypto.randomUUID()
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
const errors: string[] = []

describe.skipIf(!ready)('RFC 0038 unreported child turns', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-unreported-turn-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'unreported-turn-e2e', secretStore: createMemorySecretStore(),
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' } },
    })
    const spaceId = daemon.spaces.create('Unreported child acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url)
  })

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('shows the notice to the parent and inbox, warns without failing the card, and clears the warning when the parent replies', async () => {
    const parent = (await admin.call('work.create', { requestId: rid(), title: 'Parent', chat: { agentKind: 'codex' } })).item
    const child = (await admin.call('work.dispatch', {
      requestId: rid(), parentId: parent.workItemId, title: 'Unreported child',
      brief: `工作代理检查：${JSON.stringify({ scenario: 'unreported' })}`, agentKind: 'codex',
    })).item
    const getChild = () => admin.call('work.get', { workItemId: child.workItemId })
    const isNotice = (message: WorkMessageView) => message.from.kind === 'system' && message.from.failure?.reason === 'turn_unreported'
    await expect.poll(async () => (await getChild()).messages.filter(isNotice).length).toBe(1)
    const notice = (await getChild()).messages.find(isNotice)!
    await expect.poll(async () => (await admin.call('session.getTranscript', { sessionId: parent.sessions[0]!.sessionId })).items.some(item => item.kind === 'user' && (item.payload as { text: string }).text.includes(notice.body)), { timeout: 10_000 }).toBe(true)
    expect(notice.body).toContain('Should I use option A or option B?')
    expect((await getChild()).item).toMatchObject({ status: 'in_progress', activity: 'idle', failure: { reason: 'turn_unreported' } })

    await page.getByRole('tab', { name: 'Board', exact: true }).click()
    const card = page.getByRole('region', { name: 'Work board', exact: true }).getByRole('listitem', { name: /^Unreported child,/ })
    const warning = card.getByRole('status').filter({ hasText: 'The child ended its turn without reporting' })
    await warning.waitFor()
    expect(await card.locator('.vis-work-failure').count()).toBe(0)
    expect(await card.locator('.vis-work-activity.is-error').count()).toBe(0)
    await page.screenshot({ path: join(artifacts, 'unreported-board.png'), animations: 'disabled' })

    await page.getByRole('button', { name: /^Inbox,/ }).click()
    const inbox = page.getByRole('dialog', { name: 'Inbox', exact: true })
    const message = inbox.getByRole('region', { name: 'Ended without reporting: System', exact: true })
    await message.waitFor()
    expect(await message.textContent()).toContain('Nothing was stopped; reply, recall it, or keep waiting.')
    expect(await message.textContent()).toContain('Should I use option A or option B?')
    expect(await inbox.getByText('Work failed', { exact: true }).count()).toBe(0)
    await page.screenshot({ path: join(artifacts, 'unreported-inbox.png'), animations: 'disabled' })
    await inbox.getByRole('button', { name: 'Close Inbox', exact: true }).click()

    await page.getByRole('tab', { name: 'Canvas', exact: true }).click()
    await page.locator('.vis-work-tree').getByRole('listitem', { name: /^Parent,/ }).click()
    const panel = page.locator('.vis-session-panel')
    const composer = panel.getByRole('textbox', { name: 'Message the Agent', exact: true })
    await composer.fill(`工作代理检查：${JSON.stringify({ scenario: 'reply-unreported', workItemId: child.workItemId })}`)
    await composer.press('Enter')
    await expect.poll(async () => (await getChild()).item.sessions.some(session => session.activeTurnId !== null), { timeout: 10_000 }).toBe(true)
    await expect.poll(async () => (await getChild()).item.failure).toBeNull()
    await page.getByRole('tab', { name: 'Board', exact: true }).click()
    await expect.poll(() => warning.count()).toBe(0)
    expect((await getChild()).messages.filter(isNotice)).toHaveLength(1)
    expect((await getChild()).item.status).toBe('in_progress')
    expect(errors).toEqual([])
  })
})
