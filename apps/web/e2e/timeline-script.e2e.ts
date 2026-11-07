import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasOp, NodeView, ScriptDoc, TimelineDoc } from '@vis/protocol'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const screenshots = join(tmpdir(), 'vis-0024-C2')
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let videoAsset: string
let imageAsset: string
const errors: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get')).nodes
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })

describe.skipIf(!ready)('Assemble a script into a timeline', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-timeline-script-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'e2e', runtimes: {}, providers: [], defaults: {}, secretStore: createMemorySecretStore() })
    const { spaceId } = daemon.spaces.create('Script assembly acceptance')
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const video = join(dir, 'shot video.webm')
    const image = join(dir, 'first frame.png')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=2', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', video], { shell: false })
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:size=160x90', '-frames:v', '1', image], { shell: false })
    const space = daemon.spaces.get(spaceId)!
    videoAsset = space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(video), kind: 'video', mime: 'video/webm', origin: 'import', width: 160, height: 90, durationMs: 2000 }).assetVersionId
    imageAsset = space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(image), kind: 'image', mime: 'image/png', origin: 'import', width: 160, height: 90 }).assetVersionId
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'New script', exact: true }).waitFor()
  })
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await page.screenshot({ path: join(screenshots, 'failure.png'), animations: 'disabled' })
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('uses the latest video, a four-second first frame and the final video in shot order, reporting the missing shot', async () => {
    const { idMap } = await apply([{ op: 'node.create', tempId: 'script', kind: 'script', title: 'Story', x: 200, y: 240 }])
    const scriptId = idMap.script
    const script = (await nodes()).find(node => node.nodeId === scriptId)!
    const slot = script.slots.find(slot => slot.slotKey === 'main')!
    await apply([{ op: 'script.replace', slotId: slot.slotId, expectedRevision: slot.revision, doc: {
      shots: Array.from({ length: 4 }, (_, i) => ({ tempId: `shot-${i}`, description: `Scene ${i + 1}`, transition: 'cut', durationSec: i === 1 ? 4 : 2 })),
      assets: [],
    } }])
    const content = (await nodes()).find(node => node.nodeId === scriptId)!.slots.find(slot => slot.slotKey === 'main')!.content
    if (content.type !== 'script') throw new Error('Expected script content')
    const doc: ScriptDoc = content.doc
    await page.locator(`.react-flow__node-script[data-id="${scriptId}"] .vis-node-label`).click()
    const assemble = page.getByRole('button', { name: 'Assemble timeline', exact: true })
    await expect.poll(() => assemble.isDisabled()).toBe(true)
    expect(await assemble.getAttribute('title')).toBe('No shot has a video or first frame yet')
    const output = (tempId: string, shotIndex: number, kind: 'video' | 'image', title: string): CanvasOp => ({
      op: 'node.create', tempId, kind, title, x: 700, y: shotIndex * 230, w: 240, h: 135,
      content: { assetVersionId: kind === 'video' ? videoAsset : imageAsset },
      shot: { scriptNodeId: scriptId, shotId: doc.shots[shotIndex]!.id, role: kind === 'video' ? 'video' : 'first' },
    })
    await apply([output('old', 0, 'video', 'Old take')])
    const outputs = await apply([output('new', 0, 'video', 'Latest take'), output('first', 1, 'image', 'First frame'), output('fourth', 3, 'video', 'Final shot')])
    await expect.poll(() => assemble.isEnabled()).toBe(true)
    await assemble.click()
    await page.getByText('Timeline assembled · 1 shot has no video or first frame', { exact: true }).waitFor()
    await expect.poll(async () => (await nodes()).filter(node => node.kind === 'timeline').length).toBe(1)
    const timeline = (await nodes()).find(node => node.kind === 'timeline')!
    const timelineContent = timeline.slots.find(slot => slot.slotKey === 'main')!.content
    if (timelineContent.type !== 'timeline') throw new Error('Expected timeline content')
    const cut: TimelineDoc = timelineContent.doc
    expect(cut.tracks[0]!.clips.map(clip => [clip.source.nodeId, clip.startMs, clip.outMs])).toEqual([
      [outputs.idMap.new, 0, 2000], [outputs.idMap.first, 2000, 4000], [outputs.idMap.fourth, 6000, 2000],
    ])
    await page.getByRole('region', { name: /^Timeline Story · Timeline,/ }).getByText('3 clips · 00:08', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Story · Timeline', exact: true })
    await editor.waitFor()
    await expect.poll(() => editor.locator('.vis-tl-clip[role="button"]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual([
      'Latest take, 00:00.00–00:02.00', 'First frame, 00:02.00–00:06.00', 'Final shot, 00:06.00–00:08.00',
    ])
    await editor.getByRole('button', { name: 'First frame, 00:02.00–00:06.00', exact: true }).click()
    expect(await editor.getByRole('textbox', { name: 'Length', exact: true }).inputValue()).toBe('00:04.00')
    await page.screenshot({ path: join(screenshots, 'script-timeline.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  })
})
