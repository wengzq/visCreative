import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasOp, NodeView, TextProposal } from '@vis/protocol'
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
const shots = '/tmp/vis-0031/step-b'
const passage = '清晨有雾。林舟回家。'
const body = '# 第一章 雾中的来信\n\n' + passage + '河水很静。\n\n信封藏着一个秘密。'
const firstAccepted = body.replace('清晨有雾。', '晨雾贴着河面流动。')
const allAccepted = firstAccepted.replace('林舟回家。', '林舟沿着石阶走向旧书店。')
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let nodeId: string
let sessionId: string
let spaceId: string
const errors: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const node = async () => (await nodes()).find(node => node.nodeId === nodeId)!
const main = async () => (await node()).slots.find(slot => slot.slotKey === 'main')!
const text = async () => { const content = (await main()).content; return content.type === 'text' ? content.body : '' }
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const proposals = async (status: 'open' | 'all' = 'open'): Promise<TextProposal[]> => (await admin.call('text.proposal.list', { slotId: (await main()).slotId, status })).proposals
const editor = () => page.getByRole('dialog', { name: 'Writing page', exact: true })
const input = () => editor().getByRole('textbox', { name: 'Manuscript', exact: true })
const toolbar = () => editor().getByRole('toolbar', { name: 'Selection actions', exact: true })
const open = async () => { await page.getByRole('button', { name: 'Fit canvas', exact: true }).click(); await page.getByRole('button', { name: 'Open writing page', exact: true }).first().click(); await input().waitFor() }
async function close() {
  await editor().getByRole('button', { name: 'Close writing page', exact: true }).click()
  await expect.poll(() => editor().count()).toBe(0)
}
async function selectedManuscriptText() {
  return page.evaluate(() => {
    const selection = window.getSelection()
    if (!selection?.rangeCount) return ''
    const fragment = selection.getRangeAt(0).cloneContents()
    // Inline widgets are presentation, not part of the CodeMirror document selection.
    fragment.querySelectorAll('.vis-writing-edit').forEach(element => element.remove())
    return fragment.textContent
  })
}
async function select() {
  await input().evaluate((element, passage) => {
    const line = [...element.querySelectorAll('.cm-line')].find(line => line.textContent?.startsWith(passage))!
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    const text = walker.nextNode()!
    element.focus()
    window.getSelection()!.setBaseAndExtent(text, 0, text, passage.length)
    document.dispatchEvent(new Event('selectionchange'))
  }, passage)
  await toolbar().waitFor()
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(passage)
}
async function scenario(name: string, payload: object) {
  const message = `writing-${name} ${JSON.stringify({ ...payload, probeId: crypto.randomUUID() })}`
  await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId, text: message, refs: [] })
  await expect.poll(async () => (await admin.call('session.getTranscript', { sessionId })).items.some(item => item.kind === 'assistant_text' && item.payload.text === `Completed ${message}`), { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => (await admin.call('session.list')).sessions.find(session => session.sessionId === sessionId)?.activeTurnId).toBeNull()
}
async function reset() {
  if (await editor().count()) await close()
  for (const proposal of await proposals()) await admin.call('text.proposal.resolve', { requestId: crypto.randomUUID(), slotId: proposal.slotId, action: 'reject', edits: proposal.edits.filter(edit => edit.status === 'pending' || edit.status === 'stale').map(edit => ({ proposalId: proposal.proposalId, editId: edit.editId })) })
  const slot = await main()
  await apply([{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: slot.revision, body }])
  await open()
}
async function propose() {
  await scenario('propose', { nodeId, selection: passage })
  await editor().getByRole('button', { name: 'Accept edit 1', exact: true }).waitFor()
  await editor().getByRole('button', { name: 'Accept edit 2', exact: true }).waitFor()
}

describe.skipIf(!ready)('Writing with Agents acceptance', () => {
  beforeAll(async () => {
    mkdirSync(shots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-writing-agents-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'writing-agents-e2e', secretStore: createMemorySecretStore(), providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) } })
    spaceId = daemon.spaces.create('Writing acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    nodeId = (await apply([{ op: 'node.create', tempId: 'book', kind: 'text', title: '雾中的来信', format: 'markdown', content: { text: body } }])).idMap.book!
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(8000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await open()
  })
  afterEach(async ({ task }) => { if (task.result?.state === 'fail') await page.screenshot({ path: join(shots, 'failure.png'), animations: 'disabled' }) })
  afterAll(async () => {
    await browser?.close(); admin?.close(); await host?.close(); await daemon?.stop('user_quit')
    vi.unstubAllEnvs(); if (dir) removeTempDir(dir)
  })

  it('shows a no-session hint and sends the selected Han passage and chapter directly to fake Codex', async () => {
    await select()
    expect(await toolbar().innerText()).toBe('Open an Agent session first')
    expect((await admin.call('session.list')).sessions).toEqual([])
    await close()
    const session = await admin.call('session.create', { requestId: crypto.randomUUID(), title: 'Writing partner', agentKind: 'codex' })
    sessionId = session.sessionId
    await page.getByRole('listitem', { name: /^Writing partner,/ }).click()
    await open()
    await select()
    await page.screenshot({ path: join(shots, 'selection-toolbar.png'), animations: 'disabled' })
    await toolbar().getByRole('button', { name: 'Rewrite', exact: true }).click()
    await expect.poll(() => editor().getByRole('status').allTextContents()).toContain('Writing partner is working…')
    await editor().getByRole('button', { name: 'Accept edit 1', exact: true }).waitFor()
    const transcript = JSON.stringify((await admin.call('session.getTranscript', { sessionId })).items)
    expect(transcript).toContain('Writing task: rewrite')
    expect(transcript).toContain('第一章 雾中的来信')
    expect(transcript).toContain(passage)
    expect(transcript).toContain(nodeId)
    expect(await text()).toBe(body)
    expect(await editor().locator('.vis-writing-old').allTextContents()).toEqual(['清晨有雾。', '林舟回家。'])
    expect(await editor().locator('.vis-writing-edit ins').allTextContents()).toEqual(['晨雾贴着河面流动。', '林舟沿着石阶走向旧书店。'])
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => toolbar().count()).toBe(0)
    await page.screenshot({ path: join(shots, 'inline-review-chinese.png'), animations: 'disabled' })
  })

  it('accepts one edit, rejects another, and preserves user history and CodeMirror undo', async () => {
    const before = (await main()).revision
    await editor().getByRole('button', { name: 'Accept edit 1', exact: true }).click()
    await expect.poll(text).toBe(firstAccepted)
    await expect.poll(async () => (await proposals())[0]!.edits.map(edit => edit.status)).toEqual(['accepted', 'pending'])
    await editor().getByRole('button', { name: 'Reject edit 1', exact: true }).click()
    await expect.poll(async () => (await proposals()).length).toBe(0)
    expect(await text()).toBe(firstAccepted)
    expect((await main()).revision).toBe(before + 1)
    expect((await main()).writer?.actor).toBe('user')
    const history = await admin.call('slot.history', { slotId: (await main()).slotId, limit: 2 })
    expect(history.versions.map(version => version.content)).toEqual([{ type: 'text', body: firstAccepted }, { type: 'text', body }])
    await input().click(); await page.keyboard.press('ControlOrMeta+z')
    await close()
    await expect.poll(text).toBe(body)
  })

  it('accepts all valid edits in a single revision and rejects all without a text write', async () => {
    await reset(); await propose()
    const revision = (await main()).revision
    await editor().getByRole('button', { name: 'Next edit', exact: true }).click()
    await page.keyboard.press('Shift+ArrowRight')
    expect(await selectedManuscriptText()).toBe('清')
    await editor().getByRole('button', { name: 'Previous edit', exact: true }).click()
    await page.keyboard.press('Shift+ArrowRight')
    expect(await selectedManuscriptText()).toBe('林')
    await editor().getByRole('button', { name: 'Accept all', exact: true }).click()
    await expect.poll(text).toBe(allAccepted)
    expect((await main()).revision).toBe(revision + 1)
    await reset(); await propose()
    const before = (await main()).revision
    await editor().getByRole('button', { name: 'Reject all', exact: true }).click()
    await expect.poll(async () => (await proposals()).length).toBe(0)
    expect(await text()).toBe(body)
    expect((await main()).revision).toBe(before)
  })

  it('persists proposals across reload and shows the count on the canvas card through the host', async () => {
    await reset(); await propose()
    const ids = (await proposals()).map(proposal => proposal.proposalId)
    await close()
    await expect.poll(() => page.locator('.vis-writing-card-bar').first().innerText()).toContain('2 edits to review')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await open()
    await editor().getByRole('button', { name: 'Accept edit 2', exact: true }).waitFor()
    expect((await proposals()).map(proposal => proposal.proposalId)).toEqual(ids)
    expect(await text()).toBe(body)
  })

  it('stales a changed anchor in the local draft and never applies it, including through Accept all', async () => {
    await reset(); await propose()
    // Edit the actual document with the keyboard, leaving the review decorations intact.
    await input().click(); await page.keyboard.press('ControlOrMeta+Home')
    for (let index = 0; index < 2; index++) await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Home'); await page.keyboard.press('Delete')
    await expect.poll(() => editor().getByRole('button', { name: 'Accept edit 1', exact: true }).isDisabled()).toBe(true)
    await expect.poll(async () => (await proposals())[0]!.edits[0]!.status, { timeout: 12_000 }).toBe('stale')
    const edited = body.replace('清晨有雾。', '晨有雾。')
    expect(await text()).toBe(edited)
    expect(await editor().getByText('The original text changed; this edit cannot be applied', { exact: true }).count()).toBe(1)
    const proposal = (await proposals())[0]!
    await expect(admin.call('text.proposal.resolve', { requestId: crypto.randomUUID(), slotId: proposal.slotId, action: 'accept', expectedRevision: (await main()).revision, body: allAccepted, edits: [{ proposalId: proposal.proposalId, editId: proposal.edits[0]!.editId }] })).rejects.toMatchObject({ code: 'invalid_params' })
    await editor().getByRole('button', { name: 'Accept all', exact: true }).click()
    await expect.poll(text).toBe(edited.replace('林舟回家。', '林舟沿着石阶走向旧书店。'))
    expect((await proposals())[0]!.edits.map(edit => edit.status)).toEqual(['stale', 'accepted'])
    await editor().getByRole('button', { name: 'Reject all', exact: true }).click()
  })

  it('refuses direct Agent writes on user text and non-unique anchors, while allowing its own drafts', async () => {
    await reset()
    await scenario('refuse', { nodeId })
    expect(await text()).toBe(body)
    const slot = await main()
    await apply([{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: slot.revision, body: '雾。雾。' }])
    await scenario('nonunique', { nodeId, find: '雾' })
    expect(await text()).toBe('雾。雾。')
    expect(await proposals()).toEqual([])
    await scenario('own', {})
    const draft = (await nodes()).find(node => node.title === 'Agent draft')!
    expect(draft.slots[0]).toMatchObject({ revision: 2, content: { type: 'text', body: 'Second Agent draft' }, writer: { actor: 'agent' } })
  })

  it('requires an explicit user Allow or Deny card for Agent deletion of user prose', async () => {
    if (await editor().getByRole('button', { name: 'Load their version', exact: true }).count()) await editor().getByRole('button', { name: 'Load their version', exact: true }).click()
    if (await editor().count()) await close()
    const partner = page.getByRole('listitem', { name: /^Writing partner,/ })
    if (await partner.count()) await partner.click()
    const created = await apply([{ op: 'node.create', tempId: 'delete', kind: 'text', title: 'A chapter to delete', content: { text: 'Writer-owned chapter' }, x: 800, y: 0 }])
    const targetId = created.idMap.delete!
    await scenario('delete', { nodeId: targetId })
    const card = page.getByRole('region', { name: 'Approval pending: Delete manuscript', exact: true })
    await card.waitFor()
    expect(await card.innerText()).toContain('A chapter to delete')
    expect(await card.getByRole('button', { name: 'Allow for this session', exact: true }).count()).toBe(0)
    expect((await nodes()).some(node => node.nodeId === targetId)).toBe(true)
    await card.getByRole('button', { name: 'Deny', exact: true }).click()
    await expect.poll(() => card.count()).toBe(0)
    expect((await nodes()).some(node => node.nodeId === targetId)).toBe(true)
    await scenario('delete', { nodeId: targetId })
    await card.waitFor()
    await card.getByRole('button', { name: 'Allow', exact: true }).click()
    await expect.poll(async () => (await nodes()).some(node => node.nodeId === targetId)).toBe(false)
  })

  it('lets fake Codex read an earlier episode and refuses a project outside its series', async () => {
    const series = await admin.call('series.create', { requestId: crypto.randomUUID(), name: '雾中来信' })
    await admin.call('space.setSeries', { requestId: crypto.randomUUID(), spaceId, series: { seriesId: series.seriesId }, episode: 2 })
    const earlier = await admin.call('space.create', { requestId: crypto.randomUUID(), name: 'First episode', series: { seriesId: series.seriesId }, episode: 1 })
    const outside = await admin.call('space.create', { requestId: crypto.randomUUID(), name: 'Outside novel' })
    const earlierBody = '# 序章\n\n林舟收到一封信。'
    const earlierHost = daemon.spaces.get(earlier.spaceId)!
    earlierHost.canvas.apply({ kind: 'user' }, { requestId: crypto.randomUUID(), ops: [{ op: 'node.create', tempId: 'chapter', kind: 'text', format: 'markdown', content: { text: earlierBody } }, { op: 'node.create', tempId: 'notes', kind: 'text', purpose: 'working', content: { text: 'Working notes' } }] })
    await scenario('series', { earlier: earlier.spaceId, outside: outside.spaceId, body: earlierBody })
    expect(earlierHost.canvas.get({}).nodes.find(node => node.nodeId !== nodeId)?.slots[0]!.revision).toBe(1)
    expect(errors).toEqual([])
  })
})
