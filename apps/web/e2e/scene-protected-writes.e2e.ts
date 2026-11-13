import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMPTY_SCENE, type NodeView, type SceneDoc } from '@vis/protocol'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '../../../packages/generation/src/index'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const shots = '/tmp/vis-scene-protected-writes'
const proposalHint = 'Use scene.propose to propose this change for the author to review'
const deleteHint = 'Ask the author to delete the scene, or use scene.propose to propose deleting individual objects or views for the author to review'
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let nodeId: string
let sessionId: string
const errors: string[] = []
const scene = async (): Promise<NodeView> => (await admin.call('canvas.get', { nodeIds: [nodeId] })).nodes[0]!
const slot = async () => (await scene()).slots.find(slot => slot.slotKey === 'main')!
const doc = async (): Promise<SceneDoc> => { const content = (await slot()).content; if (content.type !== 'scene') throw new Error('Expected scene'); return content.doc }

async function send(text: string, reply: string) {
  await page.getByRole('textbox', { name: 'Message the Agent', exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByText(reply, { exact: true }).waitFor()
  await vi.waitFor(async () => expect((await admin.call('session.list')).sessions.find(session => session.sessionId === sessionId)?.activeTurnId).toBeNull(), { timeout: 10_000 })
}

async function probe(mode: 'object' | 'view' | 'delete', reasons: string[]) {
  await send(`scene-protected-write ${JSON.stringify({ nodeId, mode })}`, `Completed scene-protected-write ${mode}`)
  const { items } = await admin.call('session.getTranscript', { sessionId })
  const reply = items.find(item => item.kind === 'assistant_text' && item.payload.text === `Completed scene-protected-write ${mode}`)!
  const calls = items.filter(item => item.turnId === reply.turnId && item.kind === 'tool_call')
  const results = items.filter(item => item.turnId === reply.turnId && item.kind === 'tool_result')
  expect(calls).toHaveLength(reasons.length)
  expect(results).toHaveLength(reasons.length)
  for (const [index, reason] of reasons.entries()) {
    expect(calls[index]!.payload).toMatchObject({ name: 'vis.canvas_apply' })
    const result = results[index]!.payload
    expect(result).toMatchObject({ toolUseId: calls[index]!.payload.toolUseId, isError: true })
    const error = JSON.parse(result.text as string)
    expect(error).toMatchObject({ code: 'forbidden', reason })
    // Expand the actual transcript controls so the refusal is visible to the author.
    const output = page.getByText(result.text as string, { exact: true }).last()
    const details = page.locator('details').filter({ has: output })
    for (let index = 0; index < await details.count(); index++) {
      const detail = details.nth(index)
      if (await detail.getAttribute('open') === null) await detail.locator(':scope > summary').click()
    }
    await output.waitFor({ state: 'visible' })
    expect(error.hint).toBe(reason === 'scene.user_only' ? deleteHint : proposalHint)
  }
  await page.locator('summary').filter({ hasText: `${reasons.length} failed` }).last().waitFor({ state: 'visible' })
  expect(errors).toEqual([])
  return calls.map(call => call.payload.input)
}

describe('Protected scene writes through Agent MCP', () => {
  beforeAll(async () => {
    expect(existsSync(join(root, 'apps/web/dist/client/index.html'))).toBe(true)
    mkdirSync(shots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-scene-protected-writes-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'scene-protected-writes-e2e', secretStore: createMemorySecretStore(), providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [join(root, 'apps/cli/dist/vis.mjs'), 'mcp'] } }) } })
    const spaceId = daemon.spaces.create('Protected scene writes').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    nodeId = (await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'node.create', tempId: 'stage', title: 'Protected stage', kind: 'scene' }] })).idMap.stage!
    sessionId = (await admin.call('session.create', { requestId: crypto.randomUUID(), title: 'Scene partner', agentKind: 'codex' })).sessionId
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('listitem', { name: /^Scene partner,/ }).click()
    const initial: SceneDoc = { ...EMPTY_SCENE, objects: [
      { id: 'bench', name: 'Bench', source: { type: 'prop', propId: 'bench' }, hidden: false, createdBy: 'agent', userTouched: false, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
    ], views: [
      { id: 'wide', name: 'Wide', camera: { position: [4, 3, 6], target: [0, 1, 0], roll: 0, focalLengthMm: 35 }, aspectRatio: '16:9', still: null, createdBy: 'agent', userTouched: false },
    ] }
    const created = await slot()
    await send(`工作代理检查：${JSON.stringify({ scenario: 'canvas', ops: [{ op: 'scene.set', slotId: created.slotId, expectedRevision: created.revision, doc: initial }] })}`, '已修改画布')
    expect((await doc()).objects[0]).toMatchObject({ createdBy: 'agent', userTouched: false })
    expect((await doc()).views[0]).toMatchObject({ createdBy: 'agent', userTouched: false })
    // A real UI RPC changes content; the gateway, rather than fixture metadata, stamps protection.
    const saved = await slot()
    await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'scene.set', slotId: saved.slotId, expectedRevision: saved.revision, doc: {
      ...initial,
      objects: initial.objects.map(object => ({ ...object, transform: { ...object.transform, position: [2, 0, 0] } })),
      views: initial.views.map(view => ({ ...view, camera: { ...view.camera, focalLengthMm: 50 } })),
    } }] })
    expect((await doc()).objects[0]).toMatchObject({ createdBy: 'agent', userTouched: true })
    expect((await doc()).views[0]).toMatchObject({ createdBy: 'agent', userTouched: true })
  })
  afterEach(async ({ task }) => { if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(shots, `failure-${task.name.replaceAll(/[^a-z0-9]+/gi, '-')}.png`), animations: 'disabled' }) })
  afterAll(async () => { await browser?.close(); admin?.close(); await host?.close(); await daemon?.stop('user_quit'); vi.unstubAllEnvs(); removeTempDir(dir) })

  it('R-1 refuses a direct bench position edit at the current revision and preserves the scene', async () => {
    const before = await slot()
    const calls = await probe('object', ['scene.object_protected'])
    expect(calls[0]).toMatchObject({ ops: [{ op: 'scene.set', slotId: before.slotId, expectedRevision: before.revision, doc: { objects: [{ id: 'bench', transform: { position: [3, 0, 0] } }] } }] })
    expect((await doc()).objects[0]!.transform.position).toEqual([2, 0, 0])
    expect(await slot()).toEqual(before)
  })

  it('R-2 refuses a direct author-edited view camera change and preserves the camera', async () => {
    const before = await slot()
    const calls = await probe('view', ['scene.view_protected'])
    expect(calls[0]).toMatchObject({ ops: [{ op: 'scene.set', slotId: before.slotId, expectedRevision: before.revision, doc: { views: [{ id: 'wide', camera: { focalLengthMm: 60 } }] } }] })
    expect((await doc()).views[0]!.camera.focalLengthMm).toBe(50)
    expect(await slot()).toEqual(before)
  })

  it('R-3 refuses bench removal and whole-scene deletion and keeps both present', async () => {
    const before = await scene()
    const saved = await slot()
    const calls = await probe('delete', ['scene.object_protected', 'scene.user_only'])
    expect(calls).toMatchObject([
      { ops: [{ op: 'scene.set', slotId: saved.slotId, expectedRevision: saved.revision, doc: { objects: [] } }] },
      { ops: [{ op: 'node.delete', nodeId }] },
    ])
    expect((await doc()).objects.map(object => object.id)).toContain('bench')
    expect(await scene()).toEqual(before)
  })
})
