import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '../../../packages/generation/src/index'
import { promptRef, type CanvasOp, type NodeView, type SlotVersionView, type WorkItemView } from '../../../packages/protocol/src/index'
import { eq, spaceSchema as s } from '../../../packages/storage/src/index'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const chrome = chromePath()
const cli = join(root, 'apps/cli/dist/vis.mjs')
const ready = existsSync(chrome) && existsSync(cli) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const revisedPrompt = 'A vendor-expanded view of the reference beside a quiet river.'
let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let spaceId: string
let referenceId: string
let targetId: string
let authored: string
const errors: string[] = []
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const target = async () => (await nodes()).find(node => node.nodeId === targetId)!
const prompt = () => page.getByRole('textbox', { name: 'Prompt', exact: true })
const notice = () => page.getByText('The picture on screen was made with different settings', { exact: true })
const restore = () => page.getByRole('button', { name: "Restore this version's settings", exact: true })
const source = async (): Promise<NonNullable<SlotVersionView['source']>> => {
  const slot = (await target()).slots.find(slot => slot.slotKey === 'main')!
  return (await admin.call('slot.history', { slotId: slot.slotId })).versions[0].source
}
async function selectTarget() {
  await page.locator(`.react-flow__node[data-id="${targetId}"] .vis-node-label`).click()
  await page.getByRole('button', { name: 'Model and parameters', exact: true }).waitFor()
}
async function generateNew(operation: 'generate' | 'image.matting' = 'generate', preceding: { slotId: string; revision: number }[] = []) {
  const main = (await nodes()).find(node => node.nodeId === referenceId)!.slots[0]!
  const result = await admin.call('generation.submit', {
    requestId: crypto.randomUUID(), kind: 'image', operation, provider: 'mock', model: 'mock-image-1', prompt: authored,
    inputs: [...preceding, { slotId: main.slotId, revision: main.revision }], params: operation === 'generate' ? { width: 128, height: 128 } : {},
    targets: [{ outputIndex: 0, kind: 'new_node', nearNodeId: referenceId }],
  })
  await expect.poll(async () => (await admin.call('generation.get', { jobId: result.jobId })).status, { timeout: 10_000 }).toBe('succeeded')
  targetId = (await nodes()).find(node => node.slots.some(slot => slot.source?.jobId === result.jobId))!.nodeId
  return result.jobId
}

describe.skipIf(!ready)('Generation provenance in the prompt panel', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-provenance-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'provenance-e2e', secretStore: createMemorySecretStore(),
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
      providers: [createMockProvider({ latencyMs: 0, revisedPrompt })], defaults: { image: { provider: 'mock' } },
    })
    spaceId = studiod.spaces.create('Generation provenance').spaceId
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chrome, headless: true })
  })
  beforeEach(async () => {
    const existing = await nodes()
    if (existing.length) await apply(existing.map(node => ({ op: 'node.delete', nodeId: node.nodeId })))
    const space = studiod.spaces.get(spaceId)!
    const staged = await space.assets.stageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="teal"/></svg>'))
    const asset = space.assets.registerVersion(space.db, { staged, kind: 'image', mime: 'image/svg+xml', origin: 'import', width: 32, height: 32 })
    const { idMap } = await apply([{ op: 'node.create', tempId: 'reference', kind: 'image', x: -300, y: 0, w: 180, h: 160, content: { assetVersionId: asset.assetVersionId } }])
    referenceId = idMap.reference
    authored = `Place ${promptRef(referenceId)} beside a quiet river.`
    errors.length = 0
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
  })
  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') {
        await page.screenshot({ path: join(tmpdir(), 'vis-provenance-failure.png'), animations: 'disabled' })
        const space = studiod.spaces.get(spaceId)!
        const sessions = space.db.select().from(s.sessions).all()
        writeFileSync(join(tmpdir(), 'vis-provenance-failure.json'), JSON.stringify({
          jobs: space.db.select().from(s.generationJobs).all(),
          transcripts: await Promise.all(sessions.map(session => admin.call('session.getTranscript', { sessionId: session.id }))),
        }, null, 2))
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

  it('seeds the prompt, model and reference when a fake Agent generates a new node through MCP', async () => {
    const { item } = await admin.call('work.create', { requestId: crypto.randomUUID(), title: 'Provenance author', chat: { agentKind: 'codex' } }) as { item: WorkItemView }
    await admin.call('session.sendMessage', {
      requestId: crypto.randomUUID(), sessionId: item.sessions[0]!.sessionId,
      text: `工作代理检查：${JSON.stringify({ scenario: 'generation-provenance', referenceId, prompt: authored })}`, refs: [],
    })
    await expect.poll(async () => (await nodes()).some(node => node.slots.some(slot => slot.source)), { timeout: 15_000 }).toBe(true)
    targetId = (await nodes()).find(node => node.slots.some(slot => slot.source))!.nodeId
    await page.goto(host.url)
    await selectTarget()
    await expect.poll(() => prompt().textContent()).toBe('Place Image 1 beside a quiet river.')
    const node = await target()
    expect(node.slots.find(slot => slot.slotKey === 'prompt')).toMatchObject({ writer: { actor: 'system' }, content: { type: 'text', body: authored } })
    expect(node.generation).toEqual({ provider: 'mock', model: 'mock-image-1', params: { n: 1, width: 128, height: 128 } })
    expect(node.inputs).toEqual([referenceId])
    expect(await page.getByRole('button', { name: 'Model and parameters', exact: true }).innerText()).toBe('Mock · mock-image-1')
    expect(await notice().count()).toBe(0)
  })

  it('shows changed settings, keeps the footer stable and restores authored markers, model, parameters and inputs after confirmation', async () => {
    await generateNew()
    await page.goto(host.url)
    await selectTarget()
    await prompt().fill('')
    expect(await prompt().isEditable()).toBe(true)
    await prompt().fill('A different draft')
    await notice().waitFor()
    const send = page.getByRole('button', { name: 'Generate', exact: true })
    const before = await send.boundingBox()
    const show = page.getByRole('button', { name: 'Show', exact: true })
    await show.click()
    expect(await show.getAttribute('aria-expanded')).toBe('true')
    expect(await page.getByRole('textbox', { name: 'Prompt the model used', exact: true }).textContent()).toBe(revisedPrompt)
    expect(await send.boundingBox()).toEqual(before)
    await page.screenshot({ path: join(tmpdir(), 'vis-provenance-different.png'), animations: 'disabled' })
    await apply([
      { op: 'node.setGeneration', nodeId: targetId, generation: { provider: 'mock', model: 'mock-image-1', params: { width: 256, height: 256 } } },
      { op: 'node.setInputs', nodeId: targetId, inputNodeIds: [] },
    ])
    await restore().click()
    const dialog = page.getByRole('dialog', { name: "Replace the current draft with this version's settings?", exact: true })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await prompt().textContent()).toBe('A different draft')
    await restore().click()
    await dialog.getByRole('button', { name: 'Replace', exact: true }).click()
    await expect.poll(() => prompt().textContent()).toBe('Place Image 1 beside a quiet river.')
    expect((await target()).slots.find(slot => slot.slotKey === 'prompt')?.content).toEqual({ type: 'text', body: authored })
    expect((await target()).generation).toEqual({ provider: 'mock', model: 'mock-image-1', params: { n: 1, width: 128, height: 128 } })
    expect((await target()).inputs).toEqual([referenceId])
    expect(await notice().count()).toBe(0)
    expect((await target()).slots.find(slot => slot.slotKey === 'main')?.revision).toBe(1)
    await page.screenshot({ path: join(tmpdir(), 'vis-provenance-restored.png'), animations: 'disabled' })
  })

  it('discloses and copies the vendor prompt while caching history until the current media revision changes', async () => {
    await generateNew()
    const histories: string[] = []
    page.on('websocket', socket => socket.on('framesent', event => {
      const frame = JSON.parse(String(event.payload))
      if (frame.method === 'slot.history') histories.push(frame.params.slotId)
    }))
    await page.goto(host.url)
    await selectTarget()
    const disclosure = page.getByRole('button', { name: 'Prompt the model used', exact: true })
    await disclosure.waitFor()
    expect(await disclosure.getAttribute('aria-expanded')).toBe('false')
    await disclosure.click()
    expect(await page.getByRole('textbox', { name: 'Prompt the model used', exact: true }).textContent()).toBe(revisedPrompt)
    await page.getByRole('button', { name: 'Copy prompt', exact: true }).click()
    await page.getByRole('button', { name: 'Copied', exact: true }).waitFor()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(revisedPrompt)
    const main = (await target()).slots.find(slot => slot.slotKey === 'main')!
    expect(histories.filter(id => id === main.slotId)).toHaveLength(1)
    await page.locator(`.react-flow__node[data-id="${referenceId}"] .vis-node-label`).click()
    await selectTarget()
    expect(histories.filter(id => id === main.slotId)).toHaveLength(1)
    const original = await source()
    await admin.call('generation.regenerate', { requestId: crypto.randomUUID(), jobId: original.jobId })
    await expect.poll(async () => (await target()).slots.find(slot => slot.slotKey === 'main')?.revision, { timeout: 10_000 }).toBe(2)
    await expect.poll(() => histories.filter(id => id === main.slotId).length).toBe(2)
  })

  it('keeps an existing node author draft, inputs and model settings untouched when a job delivers to its slot', async () => {
    const jobId = await generateNew()
    const before = await target()
    const draft = before.slots.find(slot => slot.slotKey === 'prompt')!
    await apply([
      { op: 'slot.setText', slotId: draft.slotId, expectedRevision: draft.revision, body: 'Author draft for the next picture' },
      { op: 'node.setGeneration', nodeId: targetId, generation: { provider: 'mock', model: 'mock-image-1', params: { width: 256, height: 256 } } },
      { op: 'node.setInputs', nodeId: targetId, inputNodeIds: [] },
    ])
    const authorVersion = await target()
    await admin.call('generation.regenerate', { requestId: crypto.randomUUID(), jobId })
    await expect.poll(async () => (await target()).slots.find(slot => slot.slotKey === 'main')?.revision, { timeout: 10_000 }).toBe(2)
    const after = await target()
    expect(after.slots.find(slot => slot.slotKey === 'prompt')).toEqual(authorVersion.slots.find(slot => slot.slotKey === 'prompt'))
    expect(after.generation).toEqual(authorVersion.generation)
    expect(after.inputs).toEqual(authorVersion.inputs)
    await page.goto(host.url)
    await selectTarget()
    expect(await prompt().textContent()).toBe('Author draft for the next picture')
    await notice().waitFor()
  })

  it('shows legacy provenance without backfilling and creates a prompt slot only when the author restores it', async () => {
    const jobId = await generateNew()
    const node = await target()
    const promptSlot = node.slots.find(slot => slot.slotKey === 'prompt')!
    const space = studiod.spaces.get(spaceId)!
    // Simulate pre-seeding storage before a browser subscribes; delivery itself never backfills old nodes.
    space.db.delete(s.slotRevisions).where(eq(s.slotRevisions.slotId, promptSlot.slotId)).run()
    space.db.delete(s.slots).where(eq(s.slots.id, promptSlot.slotId)).run()
    space.db.delete(s.nodeInputs).where(eq(s.nodeInputs.nodeId, node.nodeId)).run()
    space.db.update(s.nodes).set({ generation: null }).where(eq(s.nodes.id, node.nodeId)).run()
    await page.goto(host.url)
    await selectTarget()
    const used = page.getByRole('textbox', { name: 'Prompt the model used', exact: true })
    await used.waitFor()
    expect(await used.getAttribute('aria-readonly')).toBe('true')
    expect(await used.textContent()).toBe(revisedPrompt)
    expect((await target()).slots.some(slot => slot.slotKey === 'prompt')).toBe(false)
    await restore().click()
    await expect.poll(() => prompt().textContent()).toBe('Place Image 1 beside a quiet river.')
    expect((await target()).slots.find(slot => slot.slotKey === 'prompt')).toMatchObject({ writer: { actor: 'user' }, content: { type: 'text', body: authored } })
    expect((await source()).jobId).toBe(jobId)
    expect((await target()).inputs).toEqual([referenceId])
  })

  it('shows an operation result read-only and lets the author submit a new generate draft without Restore', async () => {
    authored = ''
    await generateNew('image.matting')
    expect((await target()).slots.some(slot => slot.slotKey === 'prompt')).toBe(false)
    await page.goto(host.url)
    await selectTarget()
    const provenance = page.getByLabel('Operation that made this version', { exact: true })
    await provenance.getByText('Remove background', { exact: true }).waitFor()
    expect(await provenance.getByText('Mock · mock-image-1', { exact: true }).count()).toBe(1)
    expect(await provenance.getByRole('textbox').count()).toBe(0)
    expect(await restore().count()).toBe(0)
    expect(await notice().count()).toBe(0)
    await expect.poll(() => prompt().isEditable()).toBe(true)
    expect(await prompt().textContent()).toBe('')
    expect((await target()).slots.some(slot => slot.slotKey === 'prompt')).toBe(false)
    expect((await target()).slots.find(slot => slot.slotKey === 'main')?.revision).toBe(1)
    await prompt().fill('A fresh picture from the operation result')
    await page.getByRole('button', { name: 'Generate', exact: true }).click()
    await expect.poll(async () => (await target()).slots.find(slot => slot.slotKey === 'main')?.revision, { timeout: 10_000 }).toBe(2)
    expect((await target()).slots.find(slot => slot.slotKey === 'prompt')?.content).toEqual({ type: 'text', body: 'A fresh picture from the operation result' })
    const job = await admin.call('generation.get', { jobId: (await source()).jobId })
    expect(job.operation).toBe('generate')
  })

  it('uses the reference strip media numbering when text inputs precede images', async () => {
    const { idMap } = await apply([{ op: 'node.create', tempId: 'text', kind: 'text', content: { text: 'Reference notes' } }])
    const textInput = (await nodes()).find(node => node.nodeId === idMap.text)!.slots[0]!
    await generateNew('generate', [{ slotId: textInput.slotId, revision: textInput.revision }])
    await page.goto(host.url)
    await selectTarget()
    await prompt().fill('Changed draft')
    await page.getByRole('button', { name: 'Show', exact: true }).click()
    const details = page.locator('.vis-generation-provenance-details')
    expect(await details.getByRole('img', { name: 'Text', exact: true }).count()).toBe(1)
    expect(await details.getByRole('img', { name: 'Image 1', exact: true }).count()).toBe(1)
    expect(await details.locator('.vis-reference-number').allTextContents()).toEqual(['1'])
  })
})
