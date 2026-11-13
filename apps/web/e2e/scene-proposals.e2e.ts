import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMPTY_SCENE, type NodeView, type SceneDoc, type SceneProposal } from '@vis/protocol'
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
const shots = '/tmp/vis-0044/step-b'
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
const proposals = async (): Promise<SceneProposal[]> => (await admin.call('scene.proposal.list', { slotId: (await slot()).slotId, status: 'all' })).proposals
const editor = () => page.getByRole('dialog', { name: 'Proposal stage', exact: true })
const proposalInEditor = (summary: string) => editor().getByRole('article', { name: summary, exact: true })
const cards = () => page.getByRole('article', { name: 'Scene proposal', exact: true })
const card = (summary: string) => cards().filter({ hasText: summary })
const field = (name: string) => editor().getByRole('spinbutton', { name, exact: true })
const button = (name: string) => editor().getByRole('button', { name, exact: true })
async function open() {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.getByRole('button', { name: 'Open scene', exact: true }).click()
  await expect.poll(() => button('Add view').isEnabled()).toBe(true)
}
async function close() { await button('Close scene editor').click(); await editor().waitFor({ state: 'detached' }) }
async function propose(summary: string, x: number) {
  await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId, text: `scene-proposal ${JSON.stringify({ nodeId, summary, x })}`, refs: [] })
  await expect.poll(async () => (await admin.call('session.getTranscript', { sessionId })).items.some(item => item.kind === 'assistant_text' && item.payload.text === `Completed ${summary}`), { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => (await admin.call('session.list')).sessions.find(session => session.sessionId === sessionId)?.activeTurnId).toBeNull()
}

describe('Scene proposal review', () => {
  beforeAll(async () => {
    expect(existsSync(join(root, 'apps/web/dist/client/index.html'))).toBe(true)
    mkdirSync(shots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-scene-proposals-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'scene-proposal-e2e', secretStore: createMemorySecretStore(), providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [join(root, 'apps/cli/dist/vis.mjs'), 'mcp'] } }) } })
    const spaceId = daemon.spaces.create('Scene proposal review').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const initial: SceneDoc = { ...EMPTY_SCENE, objects: [
      { id: 'bench', name: 'Bench', source: { type: 'prop', propId: 'bench' }, hidden: false, createdBy: 'agent', userTouched: true, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { id: 'other', name: 'Marker', source: { type: 'primitive', shape: 'box', size: [1, 1, 1] }, hidden: false, createdBy: 'user', userTouched: true, transform: { position: [-3, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
    ] }
    nodeId = (await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'node.create', tempId: 'stage', title: 'Proposal stage', kind: 'scene' }] })).idMap.stage!
    const created = await slot()
    await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'scene.set', slotId: created.slotId, expectedRevision: created.revision, doc: initial }] })
    sessionId = (await admin.call('session.create', { requestId: crypto.randomUUID(), title: 'Scene partner', agentKind: 'codex' })).sessionId
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(8000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('listitem', { name: /^Scene partner,/ }).click()
  })
  afterEach(async ({ task }) => { if (task.result?.state === 'fail') await page.screenshot({ path: join(shots, `failure-${task.name.replaceAll(/[^a-z0-9]+/gi, '-')}.png`), animations: 'disabled' }) })
  afterAll(async () => { await browser?.close(); admin?.close(); await host?.close(); await daemon?.stop('user_quit'); vi.unstubAllEnvs(); if (dir) removeTempDir(dir) })

  it('previews a protected bench without writing, accepts in the inspector and updates the receipt card', async () => {
    await propose('Move bench right', 3)
    await card('Move bench right').getByText('Pending', { exact: true }).waitFor()
    await page.getByText('1 pending proposals', { exact: true }).waitFor()
    await open()
    const row = proposalInEditor('Move bench right')
    await row.getByText('Bench: position', { exact: true }).waitFor()
    const revision = (await slot()).revision
    const before = await editor().getByRole('img', { name: '3D viewport', exact: true }).screenshot()
    await row.getByRole('button', { name: 'Preview', exact: true }).click()
    await editor().getByText('Previewing proposal · read only', { exact: true }).waitFor()
    const after = await editor().getByRole('img', { name: '3D viewport', exact: true }).screenshot()
    expect(after.equals(before)).toBe(false)
    expect((await doc()).objects[0]!.transform.position).toEqual([0, 0, 0])
    expect((await slot()).revision).toBe(revision)
    await button('Select object: Bench').click()
    await button('Frame selection').click()
    await page.screenshot({ path: join(shots, 'editor-preview.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect.poll(() => editor().getByText('Previewing proposal · read only', { exact: true }).count()).toBe(0)
    await row.getByRole('button', { name: 'Accept change: Bench', exact: true }).click()
    await expect.poll(async () => (await doc()).objects[0]!.transform.position).toEqual([3, 0, 0])
    expect((await doc()).objects[0]!.userTouched).toBe(true)
    await row.getByText('Accepted', { exact: true }).waitFor()
    await expect.poll(() => editor().getByRole('status').allTextContents()).toContain('Saved')
    await page.screenshot({ path: join(shots, 'editor-accepted.png'), animations: 'disabled' })
    await close()
    await card('Move bench right').getByText('Accepted', { exact: true }).waitFor()
    await page.screenshot({ path: join(shots, 'session-accepted.png'), animations: 'disabled' })
  })

  it('opens receipt preview and flushes an open editor draft before chat acceptance', async () => {
    await propose('Move bench left', -1)
    await card('Move bench left').getByRole('button', { name: 'Open in scene editor', exact: true }).click()
    await editor().getByText('Previewing proposal · read only', { exact: true }).waitFor()
    await button('End preview').click()
    await button('Select object: Marker').click()
    await field('Position (m) Z').fill('2')
    // The editor remains mounted while a receipt action exercises the host's shared draft-flush path.
    await card('Move bench left').getByRole('button', { name: 'Accept all', exact: true }).dispatchEvent('click')
    await expect.poll(async () => (await doc()).objects.map(object => object.transform.position)).toEqual([[-1, 0, 0], [-3, 0.5, 2]])
    await proposalInEditor('Move bench left').getByText('Accepted', { exact: true }).waitFor()
    await expect.poll(() => editor().getByRole('status').allTextContents()).toContain('Saved')
    expect((await doc()).objects[0]!.userTouched).toBe(true)
    await close()
    await card('Move bench left').getByText('Accepted', { exact: true }).waitFor()
  })

  it('rejects from the session and shows the same rejected state in the editor', async () => {
    await propose('Reject this move', 4)
    await card('Reject this move').getByRole('button', { name: 'Reject all', exact: true }).click()
    await card('Reject this move').getByText('Rejected', { exact: true }).waitFor()
    expect((await doc()).objects[0]!.transform.position).toEqual([-1, 0, 0])
    await card('Reject this move').getByRole('button', { name: 'Open in scene editor', exact: true }).click()
    await proposalInEditor('Reject this move').getByText('Rejected', { exact: true }).waitFor()
    await close()
  })

  it('disables accepting stale changes after an author edit and allows dismissal', async () => {
    await propose('Stale bench move', 5)
    await open()
    await button('Select object: Bench').click()
    await field('Position (m) X').fill('2')
    await field('Position (m) X').press('Enter')
    const row = proposalInEditor('Stale bench move')
    await row.getByText('Stale', { exact: true }).waitFor()
    expect(await row.getByRole('button', { name: 'Accept all', exact: true }).isDisabled()).toBe(true)
    expect(await row.getByRole('button', { name: 'Accept change: Bench', exact: true }).isDisabled()).toBe(true)
    await page.screenshot({ path: join(shots, 'editor-stale.png'), animations: 'disabled' })
    await close()
    await card('Stale bench move').getByText('Stale', { exact: true }).waitFor()
    expect(await card('Stale bench move').getByRole('button', { name: 'Accept all', exact: true }).isDisabled()).toBe(true)
    await card('Stale bench move').getByRole('button', { name: 'Reject all', exact: true }).click()
    await card('Stale bench move').getByText('Rejected', { exact: true }).waitFor()
    expect((await proposals()).find(proposal => proposal.summary === 'Stale bench move')!.changes[0]!.status).toBe('rejected')
    expect(errors).toEqual([])
  })
})
