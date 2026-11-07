import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { NodeView } from '@vis/protocol'
import { WRITING_LIMITS } from '@vis/protocol'
import { createWritingDraft } from '../../../packages/writing/ui/src/draft'
import { createMockProvider } from '../../../packages/generation/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { physicalMemory } from './memory-tools'
import { chromePath, removeTempDir } from '../e2e/platform'

// Measure with the production bundle, real isolated SQLite and no agents or paid providers.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = process.env.VIS_PERF_OUT ?? '/tmp/vis-0031'
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const manuscript = ('# 第一章 雾中的来信\n\n' + '清晨的雾沿着河岸缓缓升起。林舟推开旧书店的木门，发现柜台上放着一封没有署名的信。\n\n'.repeat(100)).repeat(50).slice(0, 200_000)
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let cdp: CDPSession
let spaceId: string
const metrics: Record<string, unknown> = {}
const node = async (): Promise<NodeView> => (await admin.call('canvas.get', {})).nodes[0]!
const frame = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return { ...(await cdp.send('Runtime.getHeapUsage')), dom: await cdp.send('Memory.getDOMCounters') } }
const p = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]

describe.skipIf(!ready)('RFC 0031 manuscript measurements', () => {
  beforeAll(async () => {
    mkdirSync(out, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-writing-perf-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'writing-perf', runtimes: {}, secretStore: createMemorySecretStore(), providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } } })
    spaceId = daemon.spaces.create('Manuscript performance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    cdp = await page.context().newCDPSession(page)
    await page.goto(host.url)
    await page.getByRole('button', { name: 'Import manuscript', exact: true }).waitFor()
    metrics.environment = { date: new Date().toISOString(), cpu: cpus()[0]?.model, cores: cpus().length, ramBytes: totalmem(), node: process.version, chrome: browser.version(), characters: manuscript.length, utf8Bytes: Buffer.byteLength(manuscript) }
    metrics.empty = await heap()
  })
  afterAll(async () => {
    vi.useRealTimers()
    writeFileSync(join(out, 'writing-perf.json'), JSON.stringify(metrics, null, 2))
    await browser?.close(); admin?.close(); await host?.close(); await daemon?.stop('user_quit')
    vi.unstubAllEnvs(); if (dir) removeTempDir(dir)
  })
  it('measures canvas opening, editor opening, typing-to-paint latency and retained heap', async () => {
    await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'node.create', tempId: 'manuscript', kind: 'text', title: 'Long manuscript', format: 'markdown', content: { text: manuscript } }] })
    const opens: number[] = []
    for (let run = 0; run < 5; run++) {
      const start = performance.now()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: 'Open writing page', exact: true }).waitFor()
      await frame()
      opens.push(performance.now() - start)
    }
    metrics.canvasOpenMs = { samples: opens, median: p(opens, .5), p95: p(opens, .95) }
    metrics.canvas = await heap()
    if (process.platform === 'darwin') metrics.canvasPhysical = await physicalMemory(await browser.newBrowserCDPSession(), out, 'writing-canvas')
    metrics.canvasBodyDomCharacters = await page.locator('.vis-node-text-body').evaluate(element => element.textContent!.length)
    const start = performance.now()
    await page.getByRole('button', { name: 'Open writing page', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'Manuscript', exact: true })
    await input.waitFor(); await frame()
    metrics.editorOpenMs = performance.now() - start
    metrics.editor = await heap()
    if (process.platform === 'darwin') metrics.editorPhysical = await physicalMemory(await browser.newBrowserCDPSession(), out, 'writing-editor')
    await input.click(); await page.keyboard.press('ControlOrMeta+End')
    await input.evaluate(element => {
      const samples: number[] = []
      Object.assign(window, { writingLatencies: samples })
      element.addEventListener('beforeinput', () => { const start = performance.now(); requestAnimationFrame(() => { samples.push(performance.now() - start) }) })
    })
    for (let index = 0; index < 80; index++) { await page.keyboard.insertText(index % 10 ? '文' : '\n'); await page.waitForTimeout(65) }
    await frame()
    const samples = await page.evaluate(() => (window as unknown as { writingLatencies: number[] }).writingLatencies)
    metrics.typingToPaintMs = { samples, count: samples.length, median: p(samples, .5), p95: p(samples, .95), max: Math.max(...samples) }
    metrics.afterTyping = await heap()
    await page.getByRole('button', { name: 'Close writing page', exact: true }).click()
    await page.getByRole('dialog', { name: 'Writing page', exact: true }).waitFor({ state: 'detached' })
  })
  it('measures ten minutes of typing using the actual autosave controller and SQLite writes', async () => {
    const space = daemon.spaces.get(spaceId)!
    const initial = await node()
    const slot = initial.slots[0]!
    const db = space.db.$client
    const databasePath = db.name
    db.pragma('wal_checkpoint(TRUNCATE)')
    const beforeBytes = statSync(databasePath).size
    const beforeCount = (db.prepare('SELECT count(*) AS n FROM slot_revisions WHERE slot_id = ?').get(slot.slotId) as { n: number }).n
    let body = slot.content.type === 'text' ? slot.content.body : ''
    const writes: Array<{ ms: number; bytes: number }> = []
    const start = Date.now()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const controller = createWritingDraft({ node: initial, history: async () => ({ versions: [], hasMore: false }), upload: async () => { throw new Error('Unused') }, onClose() {}, commit: async (body, expectedRevision) => {
      space.canvas.apply({ kind: 'user' }, { requestId: crypto.randomUUID(), ops: [{ op: 'slot.setText', slotId: slot.slotId, body, expectedRevision }] })
      writes.push({ ms: Date.now() - start, bytes: Buffer.byteLength(body) })
      return 'ok'
    } })
    // 20 seconds typing at two Han characters/second, then a 10-second thinking pause, repeated 20 times.
    for (let block = 0; block < 20; block++) {
      for (let key = 0; key < 40; key++) { body += '文'; controller.getSnapshot().edit(body); await vi.advanceTimersByTimeAsync(500) }
      await vi.advanceTimersByTimeAsync(10_000)
    }
    await controller.getSnapshot().flush()
    controller.dispose()
    vi.useRealTimers()
    db.pragma('wal_checkpoint(TRUNCATE)')
    const revisions = db.prepare('SELECT count(*) AS n, sum(length(cast(text_body AS blob))) AS bytes FROM slot_revisions WHERE slot_id = ? AND revision > ?').get(slot.slotId, slot.revision) as { n: number; bytes: number }
    metrics.revisionSimulation = { durationMs: 600_000, addedCharacters: 800, debounceMs: WRITING_LIMITS.autosaveMs, maxWaitMs: WRITING_LIMITS.maxWaitMs, initialRevisions: beforeCount, newRevisions: revisions.n, textBodyBytes: revisions.bytes, wholeDatabaseGrowthBytes: statSync(databasePath).size - beforeBytes, writes, note: 'Database growth includes event payloads and undo/idempotency operations as well as revision bodies; history coalescing remains unimplemented.' }
    console.log(JSON.stringify(metrics, null, 2))
  })
})
