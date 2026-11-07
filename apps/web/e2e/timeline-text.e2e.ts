import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Locator } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BUILTIN_FONTS, PROTOCOL_VERSION, type CanvasOp, type NodeView, type TextClip, type TimelineDoc } from '@vis/protocol'
import { createMockProvider } from '../../../packages/generation/src/index'
import { eq, spaceSchema as s } from '../../../packages/storage/src/index'
import { issueAgentToken } from '../../../services/studiod/src/auth'
import type { AgentRuntimeFactory } from '../../../services/studiod/src/space-host'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'
import { BUILTIN_FONT_FILES } from '../../../resources/fonts/paths'
import { detectAssFilter } from '../../../packages/assets/src/timeline-render'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const fontDir = process.env['VIS_FONTS_DIR'] ?? join(root, 'resources/fonts/files')
const fontsReady = BUILTIN_FONTS.every(id => existsSync(join(fontDir, BUILTIN_FONT_FILES[id])))
// Exports burn captions through ffmpeg's ASS filter; builds without libass report media.captions_unavailable instead.
const assFilter = await detectAssFilter('ffmpeg')
const ready = fontsReady && assFilter && existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
if (!fontsReady) console.info('Skipping timeline text acceptance: run pnpm fonts:fetch to install built-in fonts')
if (fontsReady && !assFilter) console.info('Skipping timeline text acceptance: this ffmpeg has no ASS filter')
const screenshots = process.platform === 'win32' ? 'C:/tmp/vis-d2' : join(tmpdir(), 'vis-d2')
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let spaceId: string
let videoAsset: string
let sourceIds: string[]
let sequence = 0
let agentToken: string | undefined
let endAgent: (() => void) | undefined
const errors: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const main = (node: NodeView) => node.slots.find(slot => slot.slotKey === 'main')!
const timelineDocument = (node: NodeView): TimelineDoc => {
  const content = main(node).content
  if (content.type !== 'timeline') throw new Error('Expected a timeline document')
  return content.doc
}
const caption = (id: string, startMs: number, text = id): TextClip => ({ id, startMs, durationMs: 600, text, style: { preset: 'subtitle' }, fadeInMs: 0, fadeOutMs: 0 })
const runtime: AgentRuntimeFactory = ({ spaceId, db, report }) => ({
  async ensureReady() {},
  async agentOptions() { return [] },
  async dispatchTurn(input) {
    const { token, tokenHash } = issueAgentToken(spaceId)
    const instanceId = `instance-${crypto.randomUUID()}`
    db.insert(s.agentInstances).values({ id: instanceId, sessionId: input.sessionId, status: 'ready', tokenHash, startedAt: Date.now() }).run()
    db.update(s.turns).set({ instanceId }).where(eq(s.turns.id, input.turnId)).run()
    agentToken = token
    endAgent = () => report({ type: 'turn_ended', sessionId: input.sessionId, turnId: input.turnId, status: 'completed' })
  },
  async terminateTurn() {},
  async interruptTurn() { endAgent?.() },
})

async function agentClient(token: string) {
  const socket = connect(daemon.socketPath)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.setEncoding('utf8')
  const pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void }>()
  let buffer = ''
  let id = 0
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      const waiter = pending.get(message.id)
      if (waiter) { pending.delete(message.id); message.error ? waiter.reject(message.error.data) : waiter.resolve(message.result) }
    }
  })
  const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const next = ++id
    pending.set(next, { resolve, reject })
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`)
  })
  await call('runtime.hello', { protocolVersion: PROTOCOL_VERSION, credential: { kind: 'agent', token } })
  return { call, close: () => socket.destroy() }
}

async function createCut(texts: TextClip[] = [], textOnly = false) {
  const title = `Text acceptance ${++sequence}`
  const { idMap } = await apply([{ op: 'node.create', tempId: 'cut', kind: 'timeline', title, x: 700, y: sequence * 100 }])
  const nodeId = idMap.cut!
  const node = (await nodes()).find(node => node.nodeId === nodeId)!
  const doc: TimelineDoc = {
    version: 1, tracks: [{ id: `video-${sequence}`, kind: 'video', muted: false, volume: 1, clips: textOnly ? [] : sourceIds.map((nodeId, index) => ({
      id: `shot-${sequence}-${index}`, source: { nodeId, assetVersionId: videoAsset }, startMs: index * 2000, inMs: 0, outMs: 2000, volume: 1, fadeInMs: 0, fadeOutMs: 0,
    })) }],
    ...(texts.length ? { textTracks: [{ id: `text-${sequence}`, hidden: false, clips: texts }] } : {}),
  }
  await apply([{ op: 'timeline.set', slotId: main(node).slotId, expectedRevision: main(node).revision, doc }])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  const card = page.getByRole('region', { name: new RegExp(`^Timeline ${title},`) })
  await card.getByText(`${(textOnly ? 0 : 2) + texts.length} clips · ${textOnly ? '00:02' : '00:04'}`, { exact: true }).last().click()
  await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
  const editor = page.getByRole('dialog', { name: title, exact: true })
  await editor.waitFor()
  return { nodeId, editor, doc }
}
async function savedDoc(nodeId: string) { return timelineDocument((await nodes()).find(node => node.nodeId === nodeId)!) }
async function seek(editor: Locator, ms: number) {
  const position = editor.getByRole('textbox', { name: 'Playback position', exact: true })
  await position.fill(String(ms / 1000))
  await position.press('Enter')
}
async function exportCut(nodeId: string, doc?: TimelineDoc) {
  let node = (await nodes()).find(node => node.nodeId === nodeId)!
  if (doc) {
    await apply([{ op: 'timeline.set', slotId: main(node).slotId, expectedRevision: main(node).revision, doc }])
    node = (await nodes()).find(node => node.nodeId === nodeId)!
  }
  const task = await admin.call('media.process', { requestId: crypto.randomUUID(), operation: 'timeline.export', nodeId, slotId: main(node).slotId, expectedRevision: main(node).revision, params: {}, waitMs: 30_000 })
  expect(task.status).toBe('succeeded')
  return admin.call('asset.get', { assetVersionId: task.assetVersionIds[0] })
}

describe.skipIf(!ready)('Timeline text and font acceptance', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-text-e2e-'))
    mkdirSync(screenshots, { recursive: true })
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'text-e2e', secretStore: createMemorySecretStore(), runtimes: { codex: runtime },
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { video: { provider: 'mock' } } })
    spaceId = daemon.spaces.create('Text acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const video = join(dir, 'blue shot.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:size=320x180:rate=30:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-y', video], { windowsHide: true })
    const imported = await admin.call('asset.import', { requestId: crypto.randomUUID(), path: video })
    videoAsset = imported.assetVersionId
    const created = await apply([0, 1].map(index => ({ op: 'node.create', tempId: `source${index}`, kind: 'video', title: `Text shot ${index + 1}`, x: 40, y: 40 + index * 240, content: { assetVersionId: videoAsset } })))
    sourceIds = [created.idMap.source0!, created.idMap.source1!]
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
  })
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(screenshots, `failure-text-${sequence}.png`), animations: 'disabled' })
  })
  afterAll(async () => {
    endAgent?.()
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    if (dir) removeTempDir(dir)
  })

  it('adds two lines, applies the variety preset, and shows text only inside its time range', async () => {
    const { editor, nodeId } = await createCut()
    await editor.getByRole('button', { name: 'Add text', exact: true }).click()
    await editor.getByRole('textbox', { name: 'Text content', exact: true }).fill('First line\nSecond line')
    await editor.getByRole('combobox', { name: 'Text preset', exact: true }).selectOption('variety')
    await expect.poll(async () => (await savedDoc(nodeId)).textTracks?.[0]?.clips[0]?.style.preset).toBe('variety')
    await expect.poll(async () => (await savedDoc(nodeId)).textTracks?.[0]?.clips[0]?.text).toBe('First line\nSecond line')
    const overlay = editor.getByRole('group', { name: 'Preview', exact: true }).getByRole('button', { name: 'First line Second line', exact: true })
    expect(await overlay.isVisible()).toBe(true)
    await seek(editor, 3000)
    await expect.poll(() => overlay.isVisible()).toBe(false)
    await seek(editor, 1000)
    await expect.poll(() => overlay.isVisible()).toBe(true)
    await expect.poll(() => page.evaluate(() => [...document.fonts].some(font => font.family.includes('zcool-kuaile') && font.status === 'loaded'))).toBe(true)
    await expect.poll(() => overlay.evaluate(element => ({ color: getComputedStyle(element).color, family: getComputedStyle(element).fontFamily })))
      .toMatchObject({ color: 'rgb(255, 225, 77)', family: expect.stringContaining('zcool-kuaile') })
    await page.screenshot({ path: join(screenshots, 'editor-variety.png'), animations: 'disabled' })
    await overlay.click()
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await savedDoc(nodeId)).textTracks?.[0]?.clips.length).toBe(0)
    expect((await savedDoc(nodeId)).tracks[0]!.clips.map(clip => clip.startMs)).toEqual([0, 2000])
  })

  it('deletes linked captions, moves later captions, and keeps absolute text when linkage is off', async () => {
    const { editor, nodeId } = await createCut([caption('first-caption', 500), caption('later-caption', 2500)])
    const video = editor.getByRole('group', { name: 'Video', exact: true })
    await video.getByRole('button', { name: /^Text shot 1,/ }).click()
    await editor.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(async () => (await savedDoc(nodeId)).textTracks?.[0]?.clips.map(clip => [clip.id, clip.startMs])).toEqual([['later-caption', 500]])
    await editor.getByRole('button', { name: 'Link captions', exact: true }).click()
    await video.getByRole('button', { name: /^Text shot 2,/ }).click()
    await editor.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(async () => (await savedDoc(nodeId)).tracks[0]?.clips.length).toBe(0)
    expect((await savedDoc(nodeId)).textTracks?.[0]?.clips.map(clip => [clip.id, clip.startMs])).toEqual([['later-caption', 500]])
  })

  it('drags and trims text within its lane, refuses overlaps, and hides the overlay with its track', async () => {
    const { editor, nodeId } = await createCut([caption('drag-caption', 500), caption('next-caption', 2500)])
    const lane = editor.getByRole('group', { name: 'Text 1', exact: true })
    const block = lane.getByRole('button', { name: /^drag-caption,/ })
    const drag = async (element: Locator, delta: number) => {
      await element.hover()
      const box = (await element.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 4 })
      await page.mouse.up()
    }
    await drag(block, 60)
    // The trailing edge snaps to the media cut at two seconds, like an audio clip.
    await expect.poll(async () => (await savedDoc(nodeId)).textTracks?.[0]?.clips[0]?.startMs).toBe(1400)
    await drag(block.getByRole('slider', { name: 'Trim text end', exact: true }), 60)
    await editor.getByText('Text clips on the same track cannot overlap', { exact: true }).waitFor()
    expect((await savedDoc(nodeId)).textTracks![0]!.clips[0]!.durationMs).toBe(600)
    await drag(block.getByRole('slider', { name: 'Trim text end', exact: true }), 30)
    await expect.poll(async () => (await savedDoc(nodeId)).textTracks?.[0]?.clips[0]?.durationMs).toBe(1100)
    await seek(editor, 1800)
    const overlay = editor.getByRole('group', { name: 'Preview', exact: true }).getByRole('button', { name: 'drag-caption', exact: true })
    expect(await overlay.isVisible()).toBe(true)
    await lane.getByRole('button', { name: 'Hide text track', exact: true }).click()
    await expect.poll(() => overlay.isVisible()).toBe(false)
    await lane.getByRole('button', { name: 'Show text track', exact: true }).click()
    await expect.poll(() => overlay.isVisible()).toBe(true)
  })

  it('uploads, selects, lists and exports a project font and serves authenticated built-in files', async () => {
    const { editor, nodeId } = await createCut([caption('upload-caption', 500)])
    await editor.getByRole('group', { name: 'Text 1', exact: true }).getByRole('button', { name: /^upload-caption,/ }).click()
    await editor.getByText('Confirm that you have permission to use this font before uploading. Font licensing is your responsibility.', { exact: true }).waitFor()
    const file = join(dir, 'Uploaded Caption Font.otf')
    copyFileSync(join(fontDir, 'noto-sans-sc.otf'), file)
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), editor.getByRole('combobox', { name: 'Font', exact: true }).selectOption('upload')])
    await chooser.setFiles(file)
    await expect.poll(async () => (await admin.call('font.list', {})).fonts.some((font: { label: string }) => font.label === 'Uploaded Caption Font.otf')).toBe(true)
    await expect.poll(async () => (await savedDoc(nodeId)).textTracks?.[0]?.clips[0]?.style.font).toEqual({ assetVersionId: expect.any(String) })
    const selected = (await savedDoc(nodeId)).textTracks![0]!.clips[0]!.style.font!
    if (!('assetVersionId' in selected)) throw new Error('Expected an uploaded font')
    expect(await admin.call('asset.get', { assetVersionId: selected.assetVersionId })).toMatchObject({ kind: 'font', mime: 'font/otf', fontFamily: 'Noto Sans SC' })
    expect((await nodes()).some(node => node.slots.some(slot => slot.content.type === 'asset' && slot.content.assetVersionId === selected.assetVersionId))).toBe(false)
    const responses = await page.evaluate(async (token: string) => {
      const denied = await fetch('/fonts/noto-sans-sc')
      const allowed = await fetch(`/fonts/noto-sans-sc?t=${encodeURIComponent(token)}`)
      return { denied: denied.status, allowed: allowed.status, type: allowed.headers.get('content-type'), cache: allowed.headers.get('cache-control') }
    }, host.token)
    expect(responses).toMatchObject({ denied: 403, allowed: 200, type: 'font/otf', cache: 'private, max-age=31536000, immutable' })
    await editor.getByRole('button', { name: 'Export', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.exportOf?.timelineNodeId === nodeId).length, { timeout: 20_000 }).toBe(1)
  })

  it('exports burned text and produces different caption pixels from the same video without text', async () => {
    const { editor, nodeId } = await createCut([caption('burn', 500, 'Burned caption')])
    await editor.getByRole('button', { name: 'Export', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.exportOf?.timelineNodeId === nodeId).length, { timeout: 20_000 }).toBe(1)
    const exported = (await nodes()).find(node => node.exportOf?.timelineNodeId === nodeId)!
    const content = main(exported).content
    if (content.type !== 'asset') throw new Error('Expected an export asset')
    const withText = await admin.call('asset.get', { assetVersionId: content.assetVersionId })
    expect(existsSync(withText.path)).toBe(true)
    expect(Math.abs(withText.durationMs - 4000)).toBeLessThan(40)
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click()
    const doc = await savedDoc(nodeId)
    const { textTracks: _text, ...without } = doc
    const noText = await exportCut(nodeId, without)
    const frame = (path: string) => execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.8', '-i', path, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    const first = frame(withText.path)
    const second = frame(noText.path)
    expect(first.length).toBe(second.length)
    expect(first.equals(second)).toBe(false)
    expect(first.some((value, i) => i % 3 === 0 && value > second[i]! + 80)).toBe(true)
    execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.8', '-i', withText.path, '-frames:v', '1', '-y', join(screenshots, 'export-burned-text.png')], { windowsHide: true })
  }, 40_000)

  it('exports a text-only timeline at default 1920×1080 on black', async () => {
    const { editor, nodeId } = await createCut([{ ...caption('only', 0, 'Text only'), durationMs: 2000 }], true)
    expect(await editor.getByRole('group', { name: 'Preview', exact: true }).getByRole('button', { name: 'Text only', exact: true }).isVisible()).toBe(true)
    expect(await editor.getByRole('button', { name: 'Export', exact: true }).isEnabled()).toBe(true)
    await editor.getByRole('button', { name: 'Export', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.exportOf?.timelineNodeId === nodeId).length, { timeout: 20_000 }).toBe(1)
    const exported = (await nodes()).find(node => node.exportOf?.timelineNodeId === nodeId)!
    const content = main(exported).content
    if (content.type !== 'asset') throw new Error('Expected a text-only export asset')
    const asset = await admin.call('asset.get', { assetVersionId: content.assetVersionId })
    expect(asset).toMatchObject({ kind: 'video', width: 1920, height: 1080 })
    expect(Math.abs(asset.durationMs - 2000)).toBeLessThan(40)
    expect(existsSync(asset.path)).toBe(true)
  }, 40_000)

  it('rejects a video font reference through an authenticated Agent timeline.set', async () => {
    const { editor, nodeId } = await createCut([caption('invalid-font', 0)])
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click()
    const { item } = await admin.call('work.create', { requestId: crypto.randomUUID(), title: 'Font validation', chat: { agentKind: 'codex' } })
    await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId: item.sessions[0].sessionId, text: 'Validate a caption font', refs: [] })
    await expect.poll(() => agentToken).toBeTypeOf('string')
    const agent = await agentClient(agentToken!)
    try {
      const node = (await nodes()).find(node => node.nodeId === nodeId)!
      const doc = timelineDocument(node)
      doc.textTracks![0]!.clips[0]!.style.font = { assetVersionId: videoAsset }
      await expect(agent.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'timeline.set', slotId: main(node).slotId, expectedRevision: main(node).revision, doc }] }))
        .rejects.toMatchObject({ code: 'invalid_params', reason: 'timeline.font_missing' })
      expect(errors).toEqual([])
    } finally { agent.close(); endAgent?.() }
  })
})
