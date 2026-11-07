import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NodeView, WorkItemView } from '@vis/protocol'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockProvider, createRenderProvider } from '../../../packages/generation/src/index'
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
const artifacts = '/tmp/vis-next/rfc32'
const rid = () => crypto.randomUUID()
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let item: WorkItemView
let sessionId: string
let holdGeneration = false
const errors: string[] = []
const composer = () => page.getByRole('textbox', { name: 'Message the Agent', exact: true })
const panel = () => page.locator('.vis-session-panel')
const nodes = async () => (await admin.call('canvas.get')).nodes as NodeView[]
const activeJobs = async () => (await admin.call('events.subscribe', { spaceId: item.spaceId })).snapshot.activeJobs
const send = async (text: string) => {
  await composer().fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => composer().inputValue()).toBe('')
}
const idle = async () => { await expect.poll(async () => (await admin.call('session.list')).sessions.find(session => session.sessionId === sessionId)?.activeTurnId, { timeout: 30_000 }).toBeNull() }
const open = async (title: string) => {
  item = (await admin.call('work.create', { requestId: rid(), title, chat: { agentKind: 'codex' } })).item
  sessionId = item.sessions[0]!.sessionId
  await page.reload()
  await page.getByRole('listitem', { name: new RegExp(`^${title},`) }).click()
  await composer().waitFor()
}
const queuedMessage = (text: string) => panel().locator('.vis-item.is-user').filter({ has: page.getByText(text, { exact: true }) })
const prompts = () => readFileSync(join(item.workDir, '.vis-e2e-agent.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.method === 'turn/start').map(entry => entry.prompt.split('\n')[0])

describe.skipIf(!ready)('RFC 0032 turn view, Send now and child documents', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-turn-view-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    const mock = createMockProvider({ latencyMs: 0 })
    const provider = { ...mock, async getTask(...args: Parameters<typeof mock.getTask>) { return holdGeneration ? { state: 'running' as const } : mock.getTask(...args) } }
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'turn-view-e2e', secretStore: createMemorySecretStore(),
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
      providers: [provider, createRenderProvider({ workDir: join(dir, 'render'), chromePath: chromePath(), ffmpegPath: process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg', libs: {} })], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' } },
    })
    const { spaceId } = daemon.spaces.create('RFC 0032 acceptance')
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

  it('collapses a long turn, expands ordered steps, and keeps a single result outside work at its time position', async () => {
    await open('Long turn')
    await send('turn-block')
    await panel().getByRole('region', { name: 'Image result', exact: true }).waitFor()
    expect(await panel().locator('.vis-work-block[open]').count()).toBe(0)
    await page.screenshot({ path: join(artifacts, 'long-turn-running.png'), animations: 'disabled' })
    await idle()
    await page.getByText('Options are ready for your review.', { exact: true }).waitFor()
    const block = panel().locator('.vis-work-block').first()
    expect(await block.locator('summary').first().textContent()).toMatch(/Worked .* · 13 tools · 1 failed/)
    expect(await block.getAttribute('open')).toBeNull()
    const result = panel().getByRole('region', { name: 'Image result', exact: true })
    expect(await result.count()).toBe(1)
    expect(await result.evaluate(element => element.closest('details'))).toBeNull()
    expect(await panel().locator('.vis-transcript').evaluate(element => [...element.children].filter(child => !child.classList.contains('is-notice')).map(child => child.className))).toEqual([
      'vis-item is-user', 'vis-item vis-work-block', 'vis-generation-result is-succeeded', 'vis-item vis-work-block', 'vis-item is-assistant is-markdown',
    ])
    await page.screenshot({ path: join(artifacts, 'long-turn-collapsed.png'), animations: 'disabled' })
    await block.locator('summary').first().click()
    await block.getByRole('button', { name: /^Thought for/ }).first().click()
    await block.locator('.vis-tool-group summary').first().click()
    expect(await block.locator('.vis-work-block-steps').evaluate(element => [...element.children].map(child => child.classList.contains('vis-reasoning') ? 'reasoning' : child.classList.contains('vis-plan') ? 'plan' : 'tools'))).toEqual(['reasoning', 'plan', 'tools', 'reasoning', 'tools', 'reasoning', 'tools'])
    expect(await block.locator('.vis-tool-call').count()).toBe(13)
    expect(await result.count()).toBe(1)
    await block.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifacts, 'long-turn-expanded.png'), animations: 'disabled' })
    await block.locator('summary').first().click()
    await expect.poll(() => panel().locator('.vis-transcript').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2)
  }, 45_000)

  it('leaves Copy to the browser for selected conversation text, with or without a selected canvas node', async () => {
    // Read after dispatch: the canvas re-registers its listener, so listener order proves nothing.
    const copyKey = async () => {
      const blocked = page.evaluate(() => new Promise<boolean>(resolve => {
        const listen = (event: KeyboardEvent) => {
          // The modifier arrives first as its own keydown, which React Flow always prevents.
          if (event.key !== 'c') return
          window.removeEventListener('keydown', listen, true)
          setTimeout(() => resolve(event.defaultPrevented))
        }
        window.addEventListener('keydown', listen, true)
      }))
      await page.keyboard.press('ControlOrMeta+c')
      return blocked
    }
    const reply = 'Options are ready for your review.'
    const box = (await panel().getByText(reply, { exact: true }).boundingBox())!
    await page.mouse.move(box.x + 1, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    expect(await page.evaluate(() => getSelection()?.toString())).toContain('ready for your review')
    expect(await copyKey()).toBe(false)
    await page.locator('.react-flow__node').first().click()
    await expect.poll(() => page.locator('.react-flow__node.selected').count()).toBe(1)
    await panel().getByText(reply, { exact: true }).selectText()
    expect(await copyKey()).toBe(false)
    await page.evaluate(() => getSelection()?.removeAllRanges())
    expect(await copyKey()).toBe(true)
  })

  it('sends the selected draft next without confirmation, retains FIFO behind it, and standalone generation continues', async () => {
    await open('Send now order')
    await send('turn-hold')
    await panel().getByRole('status').filter({ hasText: 'Thinking' }).waitFor()
    await send('First queued')
    await send('Selected next')
    let confirmations = 0
    const dismiss = async (dialog: import('playwright-core').Dialog) => { confirmations++; await dialog.dismiss() }
    page.on('dialog', dismiss)
    // One running turn stays one block, above the messages waiting for it.
    await expect.poll(() => page.locator('.vis-transcript .vis-work-block, .vis-transcript .vis-item.is-user').evaluateAll(items => items.map(item => item.classList.contains('vis-work-block') ? 'work' : item.querySelector('.vis-user-text')?.textContent)))
      .toEqual(['turn-hold', 'work', 'First queued', 'Selected next'])
    await page.screenshot({ path: join(artifacts, 'send-now.png'), animations: 'disabled' })
    await queuedMessage('Selected next').getByRole('button', { name: 'Send now', exact: true }).click()
    await idle()
    expect(confirmations).toBe(0)
    expect(prompts()).toEqual(['turn-hold', 'Selected next', 'First queued'])
    page.off('dialog', dismiss)

    holdGeneration = true
    await send('turn-standalone')
    await expect.poll(async () => (await activeJobs()).some(job => job.status === 'running'), { timeout: 10_000 }).toBe(true)
    const standalone = (await activeJobs()).find(job => job.status === 'running')!
    await send('Continue while generation runs')
    page.on('dialog', dismiss)
    await queuedMessage('Continue while generation runs').getByRole('button', { name: 'Send now', exact: true }).click()
    await idle()
    expect(confirmations).toBe(0)
    expect((await admin.call('generation.get', { jobId: standalone.jobId })).status).toBe('running')
    holdGeneration = false
    await expect.poll(async () => (await admin.call('generation.get', { jobId: standalone.jobId })).status, { timeout: 15_000 }).toBe('succeeded')
    expect((await admin.call('generation.get', { jobId: standalone.jobId })).outputs[0]?.delivery.status).toBe('delivered')
    page.off('dialog', dismiss)
  }, 45_000)

  it('confirms cancellation only for a batch that Stop cancels, and honours cancelling the confirmation', async () => {
    await open('Send now batch')
    const script = await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'script', kind: 'script' }] })
    const scriptNode = (await nodes()).find(node => node.nodeId === script.idMap.script)!
    await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'script.replace', slotId: scriptNode.slots[0]!.slotId, expectedRevision: scriptNode.slots[0]!.revision, doc: { assets: [], shots: [{ tempId: 'shot', durationSec: 2, description: 'A quiet room', framePrompt: 'A quiet room', transition: 'cut' }] } }] })
    await send(`turn-batch ${script.idMap.script}`)
    await expect.poll(async () => (await admin.call('script.batch.list', {})).batches.find(batch => batch.sessionId === sessionId)?.status).toBe('pending_approval')
    const batch = (await admin.call('script.batch.list', {})).batches.find(batch => batch.sessionId === sessionId)!
    holdGeneration = true
    await admin.call('script.batch.approve', { requestId: rid(), batchId: batch.batchId })
    await expect.poll(async () => (await activeJobs()).some(job => job.status === 'running'), { timeout: 10_000 }).toBe(true)
    const batchJob = (await activeJobs()).find(job => job.status === 'running')!
    await send('Interrupt batch')
    const before = (await admin.call('session.list')).sessions.find(session => session.sessionId === sessionId)!.activeTurnId
    page.once('dialog', async dialog => { expect(dialog.message()).toContain('Cancelling is not a refund'); expect(dialog.message()).toContain('Standalone generation continues'); await dialog.dismiss() })
    await queuedMessage('Interrupt batch').getByRole('button', { name: 'Send now', exact: true }).click()
    expect((await admin.call('session.list')).sessions.find(session => session.sessionId === sessionId)!.activeTurnId).toBe(before)
    page.once('dialog', dialog => dialog.accept())
    await queuedMessage('Interrupt batch').getByRole('button', { name: 'Send now', exact: true }).click()
    await idle()
    expect((await admin.call('script.batch.get', { batchId: batch.batchId })).status).toBe('cancelled')
    expect((await admin.call('generation.get', { jobId: batchJob.jobId })).status).toBe('cancelled')
    holdGeneration = false
  }, 45_000)

  it('hides child report text, opens its links without the working-documents toggle, and renders child code', async () => {
    await open('Parent review')
    const child = (await admin.call('work.dispatch', { requestId: rid(), parentId: item.workItemId, title: 'Child report', brief: 'child-working-report', agentKind: 'codex' })).item
    await expect.poll(async () => (await admin.call('work.get', { workItemId: child.workItemId })).item.status, { timeout: 20_000 }).toBe('in_review')
    const notes = (await nodes()).find(node => node.title === 'Child review notes')!
    const code = (await nodes()).find(node => node.title === 'Child animation')!
    expect([notes.purpose, code.purpose]).toEqual(['working', 'working'])
    expect(await page.getByRole('button', { name: 'Show working documents', exact: true }).getAttribute('aria-pressed')).toBe('false')
    expect(await page.locator('.react-flow__node').filter({ hasText: 'Child review notes' }).count()).toBe(0)
    await expect.poll(async () => (await admin.call('session.getTranscript', { sessionId })).items.some(entry => entry.kind === 'user' && JSON.stringify(entry.payload).includes(notes.nodeId))).toBe(true)
    await panel().getByRole('button', { name: /Child review notes/ }).first().click()
    const linked = page.locator('.react-flow__node').filter({ hasText: 'Child review notes' })
    await linked.waitFor()
    expect(await linked.getAttribute('class')).toContain('selected')
    expect(await page.getByRole('button', { name: 'Show working documents', exact: true }).getAttribute('aria-pressed')).toBe('false')
    expect(await page.locator('.react-flow__node').filter({ hasText: 'Child animation' }).count()).toBe(0)
    await panel().getByRole('button', { name: /Child animation/ }).first().click()
    const codeCard = page.locator('.react-flow__node').filter({ hasText: 'Child animation' })
    await codeCard.waitFor()
    await expect.poll(() => linked.count()).toBe(0)
    await codeCard.getByRole('button', { name: 'Render', exact: true }).click()
    await expect.poll(async () => (await nodes()).find(node => node.kind === 'video' && node.slots.some(slot => slot.source?.inputNodeIds.includes(code.nodeId)))?.purpose, { timeout: 30_000 }).toBe('artifact')
    await page.locator('.react-flow__pane').click({ position: { x: 30, y: 30 } })
    await expect.poll(() => codeCard.count()).toBe(0)
    await page.getByRole('tab', { name: 'Board', exact: true }).click()
    await page.getByRole('listitem', { name: /^Child report,/ }).press('Enter')
    const review = page.getByRole('dialog', { name: 'Child report', exact: true })
    await review.getByRole('button', { name: 'Locate node: Child review notes', exact: true }).click()
    await expect.poll(() => review.count()).toBe(0)
    await linked.waitFor()
    expect(await linked.getAttribute('class')).toContain('selected')
    expect(await page.getByRole('button', { name: 'Show working documents', exact: true }).getAttribute('aria-pressed')).toBe('false')
    expect(errors).toEqual([])
  }, 60_000)
})
