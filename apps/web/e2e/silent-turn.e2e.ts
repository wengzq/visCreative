import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkItemView } from '@vis/protocol'
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
const artifacts = '/tmp/vis-next/rfc35'
const rid = () => crypto.randomUUID()
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let spaceId: string
let at = Date.now() - 10 * 60_000
const errors: string[] = []
const session = async (item: WorkItemView) => (await admin.call('session.list')).sessions.find(session => session.sessionId === item.sessions[0]!.sessionId)!
const panel = () => page.locator('.vis-session-panel')
const open = async (item: WorkItemView) => {
  await page.reload()
  await page.getByRole('tab', { name: 'Canvas', exact: true }).click()
  await page.locator('.vis-work-tree').getByRole('listitem', { name: new RegExp(`^${item.title},`) }).click()
  await panel().getByRole('textbox', { name: 'Message the Agent', exact: true }).waitFor()
}

describe.skipIf(!ready)('RFC 0035 silent turns', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-silent-turn-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'silent-turn-e2e', secretStore: createMemorySecretStore(), now: () => at,
      watchdog: { idleMs: 1000, toolMs: 2000, intervalMs: 50, stopGraceMs: 100 },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' } },
    })
    spaceId = daemon.spaces.create('Silent turn acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => localStorage.setItem('vis.session.width', '520'))
    await page.goto(host.url)
  })
  afterAll(async () => {
    await page?.close(); await browser?.close(); admin?.close(); await host?.close(); await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('warns inside the running block beside Stop and on the board, tells the parent once, and clears both on streaming recovery', async () => {
    const parent = (await admin.call('work.create', { requestId: rid(), title: 'Parent', chat: { agentKind: 'codex' } })).item
    const child = (await admin.call('work.dispatch', { requestId: rid(), parentId: parent.workItemId, title: 'Quiet child', brief: 'watchdog-recover', agentKind: 'codex' })).item
    await open(child)
    await panel().locator('.vis-work-block.is-running').waitFor()
    await expect.poll(async () => (await admin.call('session.getTranscript', { sessionId: child.sessions[0]!.sessionId })).items.some(item => item.kind === 'reasoning')).toBe(true)
    at = Date.now()
    await expect.poll(async () => (await session(child)).silentSince).not.toBeNull()
    const block = panel().locator('.vis-work-block.is-running')
    const warning = block.getByRole('status').filter({ hasText: /No activity for 10 minutes; the Agent may be stuck/ })
    await warning.waitFor()
    expect(await block.getAttribute('open')).toBeNull()
    expect(await panel().locator('.vis-work-block').count()).toBe(1)
    const stop = block.getByRole('button', { name: 'Stop', exact: true })
    const bounds = await Promise.all([warning.boundingBox(), stop.boundingBox()])
    expect(Math.abs(bounds[0]!.y - bounds[1]!.y)).toBeLessThan(40)
    expect(bounds[1]!.x).toBeGreaterThan(bounds[0]!.x)
    expect(await block.locator('summary').first().evaluate(element => element.contains(element.querySelector('[role="status"]')))).toBe(true)
    await page.screenshot({ path: join(artifacts, 'silent-work-block.png'), animations: 'disabled' })
    await page.getByRole('tab', { name: 'Board', exact: true }).click()
    const card = page.getByRole('region', { name: 'Work board', exact: true }).getByRole('listitem', { name: /^Quiet child,/ })
    const cardWarning = card.getByRole('status').filter({ hasText: /No activity for 10 minutes/ })
    try { await cardWarning.waitFor() } catch (error) {
      await page.screenshot({ path: join(artifacts, 'failure-board.png'), animations: 'disabled' })
      writeFileSync(join(artifacts, 'failure-board.json'), JSON.stringify({ item: (await admin.call('work.get', { workItemId: child.workItemId })).item, html: await page.locator('.vis-work-board').innerHTML() }, null, 2))
      throw error
    }
    const cardGeometry = await card.evaluate(element => {
      const heading = element.querySelector('.vis-work-card-heading')!.getBoundingClientRect()
      const warning = element.querySelector('[role="status"]')!.getBoundingClientRect()
      const agent = element.querySelector('.vis-work-agents')!.getBoundingClientRect()
      return { headingBottom: heading.bottom, warningTop: warning.top, warningBottom: warning.bottom, agentTop: agent.top }
    })
    expect(cardGeometry.warningTop).toBeGreaterThanOrEqual(cardGeometry.headingBottom)
    expect(cardGeometry.warningBottom).toBeLessThanOrEqual(cardGeometry.agentTop)
    await page.screenshot({ path: join(artifacts, 'silent-board-card.png'), animations: 'disabled' })
    const messages = () => admin.call('work.get', { workItemId: child.workItemId })
    await expect.poll(async () => (await messages()).messages.filter(message => message.kind === 'failure').length).toBe(1)
    const failure = (await messages()).messages.find(message => message.kind === 'failure')!
    expect(failure.body).toContain('has not been stopped. Recall it or keep waiting')
    await page.getByRole('button', { name: /^Inbox,/ }).click()
    const inbox = page.getByRole('dialog', { name: 'Inbox', exact: true })
    const notice = inbox.getByRole('region', { name: 'No activity: System', exact: true })
    await notice.waitFor()
    expect(await notice.textContent()).toContain('It has not been stopped; recall it or keep waiting.')
    expect(await inbox.getByText('Work failed', { exact: true }).count()).toBe(0)
    await inbox.getByRole('button', { name: 'Close Inbox', exact: true }).click()
    await expect.poll(async () => (await admin.call('session.getTranscript', { sessionId: parent.sessions[0]!.sessionId })).items.some(item => item.kind === 'user' && JSON.stringify(item.payload).includes(failure.body))).toBe(true)
    writeFileSync(join(child.workDir, '.vis-watchdog-resume'), 'resume')
    await expect.poll(async () => (await session(child)).silentSince).toBeNull()
    await expect.poll(() => cardWarning.count()).toBe(0)
    await page.getByRole('tab', { name: 'Canvas', exact: true }).click()
    await open(child)
    await expect.poll(() => panel().getByText(/No activity for/).count()).toBe(0)
    expect((await messages()).messages.filter(message => message.kind === 'failure')).toHaveLength(1)
    const active = (await session(child)).activeTurnId!
    await admin.call('session.stop', { requestId: rid(), sessionId: child.sessions[0]!.sessionId, turnId: active })
    await expect.poll(async () => (await session(child)).activeTurnId).toBeNull()
  })

  it('Stop finishes a hung turn and Send now still promotes its message ahead of FIFO drafts', async () => {
    const item = (await admin.call('work.create', { requestId: rid(), title: 'Hung root', chat: { agentKind: 'codex' } })).item
    const sid = item.sessions[0]!.sessionId
    await admin.call('session.sendMessage', { requestId: rid(), sessionId: sid, text: 'watchdog-hung', refs: [] })
    await open(item)
    await panel().locator('.vis-work-block.is-running').waitFor()
    await expect.poll(async () => (await admin.call('session.getTranscript', { sessionId: sid })).items.filter(item => item.kind === 'reasoning').length).toBe(1)
    const old = (await session(item)).activeTurnId!
    await panel().getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(async () => (await session(item)).activeTurnId).toBeNull()
    expect((await admin.call('work.get', { workItemId: item.workItemId })).messages.filter(message => message.kind === 'failure')).toEqual([])
    await admin.call('session.resumeQueue', { requestId: rid(), sessionId: sid })
    await admin.call('session.sendMessage', { requestId: rid(), sessionId: sid, text: 'watchdog-hung', refs: [] })
    await expect.poll(async () => (await admin.call('session.getTranscript', { sessionId: sid })).items.filter(item => item.kind === 'reasoning').length).toBe(2)
    await admin.call('session.sendMessage', { requestId: rid(), sessionId: sid, text: 'First queued', refs: [] })
    await admin.call('session.sendMessage', { requestId: rid(), sessionId: sid, text: 'Selected next', refs: [] })
    const selected = panel().locator('.vis-item.is-user').filter({ has: page.getByText('Selected next', { exact: true }) })
    await selected.getByRole('button', { name: 'Send now', exact: true }).click()
    await expect.poll(async () => (await session(item)).activeTurnId, { timeout: 15_000 }).toBeNull()
    const prompts = readFileSync(join(item.workDir, '.vis-e2e-agent.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.method === 'turn/start').map(entry => entry.prompt.split('\n')[0])
    expect(prompts).toEqual(['watchdog-hung', 'watchdog-hung', 'Selected next', 'First queued'])
    expect(daemon.spaces.get(spaceId)!.db.select().from((await import('../../../packages/storage/src/index')).spaceSchema.turns).all().find(turn => turn.id === old)?.status).toBe('interrupted')
    expect(errors).toEqual([])
  })
})
