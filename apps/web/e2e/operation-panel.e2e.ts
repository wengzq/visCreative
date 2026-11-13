import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '../../../packages/generation/src/index'
import { nodeTitleNumber } from '../../../packages/canvas/ui/src/node-title'
import type { CanvasOp, MethodParams, NodeView } from '../../../packages/protocol/src/index'
import { eq, spaceSchema as s } from '../../../packages/storage/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const chrome = chromePath()
const ready = existsSync(chrome) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const draftText = 'Author draft for the next generation'
let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let spaceId: string
let subjectId: string
let imageAssetId: string
let videoAssetId: string
let initialJobs: number
const errors: string[] = []
const submits: MethodParams<'generation.submit'>[] = []
const writes: CanvasOp[][] = []
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const subject = async () => (await nodes()).find(node => node.nodeId === subjectId)!
const main = async () => (await subject()).slots.find(slot => slot.slotKey === 'main')!
const db = () => studiod.spaces.get(spaceId)!.db
const jobs = () => db().select().from(s.generationJobs).all()
const toolbar = () => page.getByRole('toolbar', { name: 'Node operations', exact: true })
const panel = (name: string) => page.getByRole('region', { name, exact: true })
const prompt = () => page.getByRole('textbox', { name: 'Prompt', exact: true })
const close = () => page.getByRole('button', { name: 'Return to generation draft', exact: true })
async function select(nodeId = subjectId) {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  let previous = ''
  await expect.poll(async () => {
    const transform = await page.locator('.react-flow__viewport').evaluate(element => getComputedStyle(element).transform)
    const settled = transform === previous
    previous = transform
    return settled
  }, { intervals: [100] }).toBe(true)
  const all = await nodes()
  const selected = all.find(node => node.nodeId === nodeId)!
  const title = selected.title ?? `${selected.kind === 'video' ? 'Video' : 'Image'} ${nodeTitleNumber(selected, all)}`
  await page.getByText(title, { exact: true }).click()
  await toolbar().waitFor()
}
async function openOperation(name: string) {
  const common = toolbar().getByRole('button', { name, exact: true })
  if (await common.count()) await common.click()
  else {
    await toolbar().getByRole('button', { name: 'More operations', exact: true }).click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
  await panel(name).waitFor()
}
async function resultNode() {
  await expect.poll(() => jobs().length, { timeout: 10_000 }).toBe(initialJobs + 1)
  const job = jobs().at(-1)!
  await expect.poll(async () => (await admin.call('generation.get', { jobId: job.id })).status, { timeout: 10_000 }).toBe('succeeded')
  return (await nodes()).find(node => node.slots.some(slot => slot.source?.jobId === job.id))!
}

describe.skipIf(!ready)('Confirmed generation operations in the prompt panel', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-operation-panel-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'operation-panel-e2e', secretStore: createMemorySecretStore(), runtimes: {},
      providers: [createMockProvider({ latencyMs: 0 })],
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' } },
    })
    spaceId = studiod.spaces.create('Operation panel').spaceId
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const space = studiod.spaces.get(spaceId)!
    const image = await space.assets.stageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="teal"/></svg>'))
    imageAssetId = space.assets.registerVersion(space.db, { staged: image, kind: 'image', mime: 'image/svg+xml', origin: 'import', width: 160, height: 120 }).assetVersionId
    const video = await space.assets.stageBytes(readFileSync(join(root, 'packages/generation/src/providers/mock/fixtures/sample.mp4')))
    videoAssetId = space.assets.registerVersion(space.db, { staged: video, kind: 'video', mime: 'video/mp4', origin: 'import', width: 128, height: 128, durationMs: 1000 }).assetVersionId
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chrome, headless: true })
  })
  beforeEach(async () => {
    const existing = await nodes()
    if (existing.length) await apply(existing.map(node => ({ op: 'node.delete', nodeId: node.nodeId })))
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'reference', kind: 'image', x: -400, y: 0, w: 200, h: 150, content: { assetVersionId: imageAssetId } },
      { op: 'node.create', tempId: 'subject', kind: 'image', x: 0, y: 0, w: 320, h: 240, prompt: draftText, inputNodeIds: ['reference'],
        generation: { provider: 'mock', model: 'mock-image-1', params: { width: 128, height: 128 } }, content: { assetVersionId: imageAssetId } },
    ])
    subjectId = idMap.subject
    errors.length = 0
    submits.length = 0
    writes.length = 0
    initialJobs = jobs().length
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      const frame = JSON.parse(String(payload))
      if (frame.method === 'generation.submit') submits.push(frame.params)
      if (frame.method === 'canvas.apply') writes.push(frame.params.ops)
    }))
    await page.goto(host.url)
    await select()
  })
  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') {
        await page.screenshot({ path: join(tmpdir(), 'vis-operation-panel-failure.png'), animations: 'disabled' })
        writeFileSync(join(tmpdir(), 'vis-operation-panel-failure.json'), JSON.stringify({ submits, writes, jobs: jobs(), nodes: await nodes() }, null, 2))
      }
      expect(errors).toEqual([])
    } finally { await page?.close() }
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await studiod?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('opens Outpaint without submitting, edits operation settings and references, and creates exactly one linked node beside an untouched draft', async () => {
    const before = await subject()
    const subjectMain = await main()
    await openOperation('Outpaint')
    const composer = panel('Outpaint')
    expect(submits).toEqual([])
    expect(jobs()).toHaveLength(initialJobs)
    expect(await composer.getByRole('button', { name: 'Model and parameters', exact: true }).innerText()).toBe('Mock · mock-image-1')
    await composer.getByRole('button', { name: 'Model and parameters', exact: true }).click()
    const models = composer.getByRole('dialog', { name: 'Choose model and parameters', exact: true })
    await models.waitFor()
    expect(await models.getByRole('button', { name: 'mock-image-1', exact: true }).count()).toBe(1)
    expect(await models.getByRole('button', { name: 'mock-video-1', exact: true }).count()).toBe(0)
    await composer.getByRole('button', { name: 'Model and parameters', exact: true }).click()
    await composer.getByRole('combobox', { name: 'Aspect ratio', exact: true }).selectOption('9:16')
    expect(await composer.getByRole('button', { name: 'Outpaint', exact: true }).isEnabled()).toBe(true)
    await composer.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Extend the sky around ')
    await composer.getByRole('button', { name: 'Insert Image 1', exact: true }).click()
    expect(await composer.getByRole('textbox', { name: 'Prompt', exact: true }).textContent()).toBe('Extend the sky around Image 1')
    expect(await composer.getByRole('button', { name: /^Remove reference/ }).count()).toBe(0)
    await page.screenshot({ path: join(tmpdir(), 'vis-operation-outpaint.png'), animations: 'disabled' })
    await composer.getByRole('button', { name: 'Outpaint', exact: true }).click()
    const result = await resultNode()
    expect(submits).toEqual([{
      requestId: expect.any(String), operation: 'image.outpaint', kind: 'image', provider: 'mock', model: 'mock-image-1',
      params: { ratio: '9:16' }, prompt: `Extend the sky around {{ref:${subjectId}}}`,
      inputs: [{ slotId: subjectMain.slotId, revision: subjectMain.revision }], targets: [{ outputIndex: 0, kind: 'new_node', nearNodeId: subjectId }],
    }])
    expect(result.inputs).toEqual([subjectId])
    expect(result.x).toBeGreaterThanOrEqual(before.x + before.w)
    expect(result.y).toBe(before.y)
    expect(result.slots.map(slot => slot.slotKey)).toEqual(['main'])
    expect(result.generation).toBeUndefined()
    expect(await subject()).toEqual(before)
    expect(writes).toEqual([])
    await expect.poll(() => prompt().textContent()).toBe(draftText)
    await openOperation('Outpaint')
    expect(await panel('Outpaint').getByRole('combobox', { name: 'Aspect ratio', exact: true }).inputValue()).toBe('9:16')
    expect(await panel('Outpaint').getByRole('textbox', { name: 'Prompt', exact: true }).textContent()).toBe('')
  })

  it('requires a nonblank Reshoot prompt before submitting a video operation', async () => {
    const { idMap } = await apply([{ op: 'node.create', tempId: 'video', kind: 'video', x: 400, y: 0, w: 240, h: 240, prompt: 'Video draft',
      generation: { provider: 'mock', model: 'mock-video-1' }, content: { assetVersionId: videoAssetId } }])
    subjectId = idMap.video
    await select()
    const before = await subject()
    await openOperation('Reshoot')
    const composer = panel('Reshoot')
    const submit = composer.getByRole('button', { name: 'Reshoot', exact: true })
    expect(await submit.isDisabled()).toBe(true)
    await composer.getByRole('textbox', { name: 'Prompt', exact: true }).fill('   ')
    expect(await submit.isDisabled()).toBe(true)
    expect(submits).toEqual([])
    await composer.getByRole('textbox', { name: 'Prompt', exact: true }).fill('A slower camera move')
    expect(await submit.isEnabled()).toBe(true)
    await submit.click()
    await resultNode()
    expect(submits).toHaveLength(1)
    expect(submits[0]).toMatchObject({ operation: 'video.reshoot', prompt: 'A slower camera move', params: { duration: 5 } })
    expect(await subject()).toEqual(before)
  })

  it('shows no Upscale prompt and submits the operation defaults', async () => {
    await openOperation('Upscale')
    const composer = panel('Upscale')
    expect(await composer.getByRole('textbox', { name: 'Prompt', exact: true }).count()).toBe(0)
    expect(await composer.getByRole('group', { name: 'Scale', exact: true }).getByRole('button', { name: '2×', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await composer.getByRole('button', { name: 'Upscale', exact: true }).click()
    await resultNode()
    expect(submits).toHaveLength(1)
    expect(submits[0]).toMatchObject({ operation: 'image.upscale', params: { scale: 2 }, prompt: '' })
  })

  it('closes with the close button or Escape and switches operations without changing the draft or creating a job', async () => {
    const before = await subject()
    await openOperation('Outpaint')
    await panel('Outpaint').getByRole('textbox', { name: 'Prompt', exact: true }).fill('An unsubmitted operation prompt')
    await close().click()
    expect(await prompt().textContent()).toBe(draftText)
    await openOperation('Outpaint')
    await panel('Outpaint').getByRole('textbox', { name: 'Prompt', exact: true }).fill('Another unsubmitted operation prompt')
    await page.keyboard.press('Escape')
    expect(await prompt().textContent()).toBe(draftText)
    expect(await close().count()).toBe(0)
    await openOperation('Outpaint')
    await openOperation('Upscale')
    expect(await panel('Outpaint').count()).toBe(0)
    expect(await panel('Upscale').getByRole('textbox', { name: 'Prompt', exact: true }).count()).toBe(0)
    await close().click()
    await toolbar().getByRole('button', { name: 'Upscale', exact: true }).click({ modifiers: ['Shift'] })
    await panel('Upscale').waitFor()
    await close().click()
    expect(await subject()).toEqual(before)
    expect(jobs()).toHaveLength(initialJobs)
    expect(submits).toEqual([])
    expect(writes).toEqual([])
  })

  it('leaves operation mode on deselection and preserves the normal draft', async () => {
    await openOperation('Outpaint')
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.locator('.react-flow__pane').click({ position: { x: 50, y: 500 } })
    await expect.poll(() => close().count()).toBe(0)
    await select()
    expect(await prompt().textContent()).toBe(draftText)
    expect(submits).toEqual([])
    expect(writes).toEqual([])
  })

  it('disables submit until its receipt and turns a rapid double press into one job', async () => {
    await openOperation('Outpaint')
    await page.evaluate(() => {
      const send = WebSocket.prototype.send
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && JSON.parse(data).method === 'generation.submit') {
          Object.assign(window, { releaseOperation: () => send.call(this, data) })
          return
        }
        send.call(this, data)
      }
    })
    const submit = panel('Outpaint').getByRole('button', { name: 'Outpaint', exact: true })
    await submit.dblclick({ delay: 0 })
    expect(await submit.isDisabled()).toBe(true)
    expect(jobs()).toHaveLength(initialJobs)
    // The client rereads the node before it submits, so wait until the held submit exists rather than racing that round trip.
    await page.waitForFunction(() => typeof Reflect.get(window, 'releaseOperation') === 'function')
    expect(await submit.isDisabled()).toBe(true)
    await page.evaluate(() => Reflect.get(window, 'releaseOperation')())
    await resultNode()
    expect(submits).toHaveLength(1)
    expect(jobs()).toHaveLength(initialJobs + 1)
    await expect.poll(() => close().count()).toBe(0)
  })

  it('shows operation provenance read-only and Regenerate repeats the same settings and subject revision in the result node', async () => {
    const subjectMain = await main()
    await openOperation('Upscale')
    await panel('Upscale').getByRole('group', { name: 'Scale', exact: true }).getByRole('button', { name: '4×', exact: true }).click()
    await panel('Upscale').getByRole('button', { name: 'Upscale', exact: true }).click()
    const result = await resultNode()
    const slot = result.slots.find(slot => slot.slotKey === 'main')!
    const first = (await admin.call('slot.history', { slotId: slot.slotId })).versions[0]!
    expect(first.source.operation).toBe('image.upscale')
    await select(result.nodeId)
    const provenance = page.getByLabel('Operation that made this version', { exact: true })
    await provenance.getByText('Upscale', { exact: true }).waitFor()
    expect(await provenance.getByText('Mock · mock-image-1', { exact: true }).count()).toBe(1)
    expect(await provenance.getByLabel('Parameter summary', { exact: true }).textContent()).toBe('Scale 4×')
    expect(await provenance.getByRole('img', { name: 'Image 1', exact: true }).count()).toBe(1)
    expect(await page.getByRole('button', { name: "Restore this version's settings", exact: true }).count()).toBe(0)
    expect(await page.getByText('The picture on screen was made with different settings', { exact: true }).count()).toBe(0)
    expect(await prompt().isEditable()).toBe(true)
    expect((await nodes()).find(node => node.nodeId === result.nodeId)!.slots.map(slot => slot.slotKey)).toEqual(['main'])
    const count = (await nodes()).length
    await page.getByRole('button', { name: 'Regenerate with the same prompt and settings (new version)', exact: true }).click()
    await expect.poll(async () => (await nodes()).find(node => node.nodeId === result.nodeId)!.slots.find(slot => slot.slotKey === 'main')!.revision, { timeout: 10_000 }).toBe(2)
    const versions = (await admin.call('slot.history', { slotId: slot.slotId })).versions
    expect(versions.map((version: any) => version.source.operation)).toEqual(['image.upscale', 'image.upscale'])
    const repeated = jobs().at(-1)!
    expect(repeated).toMatchObject({ operation: 'image.upscale', provider: 'mock', model: 'mock-image-1', params: { scale: 4, prompt: '' } })
    expect(db().select().from(s.jobInputs).where(eq(s.jobInputs.jobId, repeated.id)).all()).toMatchObject([{ slotId: subjectMain.slotId, slotRevision: subjectMain.revision }])
    expect(await nodes()).toHaveLength(count)
    expect(submits).toHaveLength(1)
    expect(versions[1]!.content).toEqual(first.content)
  })

  it('shows English and Chinese operation headers and model-owned setting labels', async () => {
    await openOperation('Outpaint')
    expect(await panel('Outpaint').getByRole('heading', { name: 'Outpaint', exact: true }).count()).toBe(1)
    expect(await panel('Outpaint').getByRole('combobox', { name: 'Aspect ratio', exact: true }).count()).toBe(1)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Language', exact: true }).click()
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN')
    await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('zh-CN')
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    expect(await panel('扩图').getByRole('heading', { name: '扩图', exact: true }).count()).toBe(1)
    expect(await panel('扩图').getByRole('combobox', { name: '画面比例', exact: true }).count()).toBe(1)
    await page.screenshot({ path: join(tmpdir(), 'vis-operation-outpaint-zh.png'), animations: 'disabled' })
    expect(submits).toEqual([])
  })
})
