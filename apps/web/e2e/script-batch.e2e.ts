import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BatchView, CanvasOp, NodeView, ScriptDoc, SessionSummary, WorkItemView } from '@vis/protocol'
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
let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let scriptId: string
let sessionId: string
let projectSpaceId: string
const errors: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const batches = async (): Promise<BatchView[]> => (await admin.call('script.batch.list', { scriptNodeId: scriptId })).batches
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
// Free mock jobs are intentionally absent from paid usage, so inspect only this isolated test project's journal.
const jobs = async () => studiod.spaces.get(projectSpaceId)!.db.query.generationJobs.findMany().sync()
const editor = () => page.getByRole('dialog', { name: 'Script editor', exact: true })
const dialog = (media: 'frames' | 'video') => page.getByRole('dialog', { name: media === 'frames' ? 'Batch generate shot images' : 'Batch generate videos', exact: true })
async function scriptDoc(): Promise<ScriptDoc> {
  const content = (await nodes()).find(node => node.nodeId === scriptId)!.slots.find(slot => slot.slotKey === 'main')!.content
  if (content.type !== 'script') throw new Error('Expected script document')
  return content.doc
}
const resultNode = async (shotId: string, role: 'first' | 'last' | 'video', batch?: BatchView) => {
  const id = batch?.shots.find(shot => shot.shotId === shotId)?.steps.find(step => step.role === role)?.nodeId
  return (await nodes()).find(node => id ? node.nodeId === id : node.shot?.scriptNodeId === scriptId && node.shot.shotId === shotId && node.shot.role === role)!
}
function assetPath(node: NodeView) {
  const content = node.slots.find(slot => slot.slotKey === 'main')!.content
  if (content.type !== 'asset') throw new Error('Expected a generated asset')
  const space = studiod.spaces.get(projectSpaceId)!
  return space.assets.blobPath(space.assets.getVersion(space.db, content.assetVersionId)!.blobHash)
}
function imageInputs(node: NodeView): { type: string; path?: string }[] {
  const data = readFileSync(assetPath(node))
  for (let offset = 8; offset + 12 <= data.length;) {
    const length = data.readUInt32BE(offset)
    if (data.toString('ascii', offset + 4, offset + 8) === 'tEXt') {
      const text = data.toString('utf8', offset + 8, offset + 8 + length)
      if (text.startsWith('Inputs\0')) return JSON.parse(text.slice(7))
    }
    offset += length + 12
  }
  throw new Error('The mock PNG did not record its pinned inputs')
}
function videoFrames(node: NodeView): { first: { path: string }; last?: { path: string } } {
  const data = readFileSync(assetPath(node)).toString('utf8')
  const line = data.split('\n').find(line => line.startsWith('VIS_FRAMES:'))
  if (!line) throw new Error('The mock video did not record its pinned frames')
  return JSON.parse(line.slice('VIS_FRAMES:'.length))
}
async function waitBatch(media: 'frames' | 'video', previous: number) {
  await expect.poll(async () => (await batches()).length, { timeout: 10_000 }).toBe(previous + 1)
  const batch = (await batches()).find(batch => batch.media === media && batch.status !== 'succeeded') ?? (await batches()).at(-1)!
  await expect.poll(async () => (await admin.call('script.batch.get', { batchId: batch.batchId })).status, { timeout: 30_000 }).toBe('succeeded')
  return await admin.call('script.batch.get', { batchId: batch.batchId }) as BatchView
}

describe.skipIf(!ready)('Script batch confirmation, continuity and approval', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-script-batch-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    const mock = createMockProvider({ latencyMs: 0 })
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'script-batch-e2e',
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
      providers: [mock], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' } }, secretStore: createMemorySecretStore(),
    })
    const { spaceId } = studiod.spaces.create('Script batches')
    projectSpaceId = spaceId
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const { item } = await admin.call('work.create', { requestId: crypto.randomUUID(), title: 'Batch writer', chat: { agentKind: 'codex' } }) as { item: WorkItemView }
    sessionId = item.sessions[0]!.sessionId
    const { idMap } = await apply([{ op: 'node.create', tempId: 'script', kind: 'script', x: 0, y: 0, title: 'Batch screenplay' }])
    scriptId = idMap.script
    const slot = (await nodes()).find(node => node.nodeId === scriptId)!.slots.find(slot => slot.slotKey === 'main')!
    await apply([{ op: 'script.replace', slotId: slot.slotId, expectedRevision: slot.revision, doc: { sessionId, shots: [
      { tempId: 'one', transition: 'cut', description: 'A traveler reaches a door', endState: 'The door opens', framePrompt: 'First shot still', endFramePrompt: 'First shot ending', videoPrompt: 'Open the door', durationSec: 1 },
      { tempId: 'two', transition: 'continuous', description: 'The traveler steps through', framePrompt: 'Continue the previous ending', videoPrompt: 'Step through the door', durationSec: 1 },
      { tempId: 'three', transition: 'cut', description: 'A landscape', framePrompt: 'Wide landscape', videoPrompt: 'Slow landscape pan', durationSec: 1 },
    ], assets: [] } }])
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url)
    await page.getByRole('button', { name: 'Expand storyboard', exact: true }).click()
    await editor().waitFor()
  })
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    admin?.close()
    await host?.close()
    await studiod?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('cancels the dry run, confirms images once on double click, and renders the first and last frame results', async () => {
    try {
      await editor().getByRole('checkbox', { name: 'Select shot 3', exact: true }).check()
      await editor().getByRole('button', { name: 'Batch generate shot images', exact: true }).click()
      await dialog('frames').getByText('1 shot · 1 generation job', { exact: true }).waitFor()
      await dialog('frames').getByRole('button', { name: 'Cancel', exact: true }).click()
      await editor().getByRole('checkbox', { name: 'Select shot 3', exact: true }).uncheck()
      await editor().getByRole('button', { name: 'Batch generate shot images', exact: true }).click()
      await dialog('frames').getByText('3 shots · 4 generation jobs', { exact: true }).waitFor()
      await page.screenshot({ path: join(tmpdir(), 'vis-script-batch-confirmation.png'), animations: 'disabled' })
      expect(await jobs()).toHaveLength(0)
      expect(await batches()).toHaveLength(0)
      await dialog('frames').getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await jobs()).toHaveLength(0)
      expect(await batches()).toHaveLength(0)
      await editor().getByRole('button', { name: 'Batch generate shot images', exact: true }).click()
      const confirm = dialog('frames').getByRole('button', { name: 'Confirm generation', exact: true })
      await expect.poll(() => confirm.isEnabled()).toBe(true)
      await confirm.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
      const batch = await waitBatch('frames', 0)
      expect((await jobs()).filter(job => job.kind === 'image')).toHaveLength(4)
      const doc = await scriptDoc()
      const first = await resultNode(doc.shots[0]!.id, 'first', batch)
      const last = await resultNode(doc.shots[0]!.id, 'last', batch)
      const continuous = await resultNode(doc.shots[1]!.id, 'first', batch)
      expect(last.inputs).toContain(first.nodeId)
      expect(continuous.inputs).toContain(last.nodeId)
      expect(imageInputs(last)).toContainEqual(expect.objectContaining({ type: 'asset', path: assetPath(first) }))
      expect(imageInputs(continuous)).toContainEqual(expect.objectContaining({ type: 'asset', path: assetPath(last) }))
      for (const shot of doc.shots) {
        const output = await resultNode(shot.id, 'first', batch)
        expect(output.slots.find(slot => slot.slotKey === 'main')?.content.type).toBe('asset')
      }
      await editor().getByRole('row', { name: 'Shot 1', exact: true }).getByRole('button', { name: 'Last frame: View generated output', exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(tmpdir(), 'vis-script-batch-frames.png'), animations: 'disabled' })
      expect(errors).toEqual([])
    } catch (error) { await page.screenshot({ path: join(tmpdir(), 'vis-script-batch-failure.png'), animations: 'disabled' }); throw error }
  }, 60_000)

  it('uses the previous video last frame for the selected strict continuous shot', async () => {
    await editor().getByRole('button', { name: 'Batch generate videos', exact: true }).click()
    await dialog('video').getByRole('checkbox', { name: "Shot 2: Use the previous video's last frame", exact: true }).check()
    await expect.poll(() => dialog('video').getByRole('button', { name: 'Confirm generation', exact: true }).isEnabled()).toBe(true)
    await dialog('video').getByRole('button', { name: 'Confirm generation', exact: true }).click()
    const batch = await waitBatch('video', 1)
    const doc = await scriptDoc()
    const firstVideo = await resultNode(doc.shots[0]!.id, 'video', batch)
    const extracted = await resultNode(doc.shots[1]!.id, 'first', batch)
    const secondVideo = await resultNode(doc.shots[1]!.id, 'video', batch)
    expect(batch.shots.find(shot => shot.shotId === doc.shots[1]!.id)?.steps.find(step => step.role === 'first')).toMatchObject({ source: 'extract', status: 'succeeded' })
    expect(extracted.inputs).toContain(firstVideo.nodeId)
    expect(secondVideo.inputs).toContain(extracted.nodeId)
    expect(videoFrames(secondVideo).first.path).toBe(assetPath(extracted))
    const firstShotFrame = await resultNode(doc.shots[0]!.id, 'first')
    const firstShotLast = await resultNode(doc.shots[0]!.id, 'last')
    expect(videoFrames(firstVideo)).toMatchObject({ first: { path: assetPath(firstShotFrame) }, last: { path: assetPath(firstShotLast) } })
    expect((await jobs()).filter(job => job.kind === 'video')).toHaveLength(3)
    await page.screenshot({ path: join(tmpdir(), 'vis-script-batch-videos.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  }, 60_000)

  it('requires user approval for fake Agent batches; rejects without submissions and approves the next request', async () => {
    await editor().getByRole('button', { name: 'Close script editor', exact: true }).click()
    const before = (await jobs()).length
    await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId, text: `script-batch ${scriptId}`, refs: [] })
    await expect.poll(async () => (await batches()).filter(batch => batch.status === 'pending_approval').length, { timeout: 20_000 }).toBe(1)
    expect(await jobs()).toHaveLength(before)
    await page.getByRole('button', { name: 'Open approval session', exact: true }).click()
    let card = page.getByRole('region', { name: 'Batch generation approval', exact: true }).last()
    const doc = await scriptDoc()
    const slot = (await nodes()).find(node => node.nodeId === scriptId)!.slots.find(slot => slot.slotKey === 'main')!
    await apply([{ op: 'script.patch', slotId: slot.slotId, ops: [{ kind: 'shot.update', shotId: doc.shots[0]!.id, rev: doc.shots[0]!.rev, fields: { description: 'Changed after the Agent requested this batch' } }] }])
    await card.getByText('Changed since the request', { exact: false }).waitFor()
    expect(await jobs()).toHaveLength(before)
    await page.screenshot({ path: join(tmpdir(), 'vis-script-batch-pending-approval.png'), animations: 'disabled' })
    await card.getByRole('button', { name: 'Reject', exact: true }).click()
    await expect.poll(async () => (await batches()).filter(batch => batch.status === 'rejected').length, { timeout: 10_000 }).toBe(1)
    expect(await jobs()).toHaveLength(before)
    await expect.poll(async () => ((await admin.call('session.list', {})).sessions as SessionSummary[]).find(session => session.sessionId === sessionId)?.activeTurnId, { timeout: 20_000 }).toBeNull()
    await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId, text: `script-batch ${scriptId}`, refs: [] })
    await expect.poll(async () => (await batches()).filter(batch => batch.status === 'pending_approval').length, { timeout: 20_000 }).toBe(1)
    card = page.getByRole('region', { name: 'Batch generation approval', exact: true }).last()
    await expect.poll(() => card.getByRole('button', { name: 'Approve', exact: true }).isEnabled()).toBe(true)
    await card.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect.poll(async () => (await batches()).filter(batch => batch.origin === 'agent' && batch.status === 'succeeded').length, { timeout: 30_000 }).toBe(1)
    expect((await jobs()).length).toBeGreaterThan(before)
    await page.screenshot({ path: join(tmpdir(), 'vis-script-batch-approval.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  }, 60_000)
})
