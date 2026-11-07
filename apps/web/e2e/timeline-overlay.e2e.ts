import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasOp, NodeView, TimelineDoc } from '@vis/protocol'
import { createMockProvider } from '../../../packages/generation/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const screenshots = process.platform === 'win32' ? 'C:/tmp/vis-overlay' : '/tmp/vis-overlay'
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let timelineId: string
let imageAsset: string
let imageNodeId: string
const errors: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const main = (node: NodeView) => node.slots.find(slot => slot.slotKey === 'main')!
async function savedDoc(): Promise<TimelineDoc> {
  const content = main((await nodes()).find(node => node.nodeId === timelineId)!).content
  if (content.type !== 'timeline') throw new Error('Expected a timeline document')
  return content.doc
}
const overlayTrack = async () => (await savedDoc()).tracks.find(track => track.kind === 'overlay')!
const overlayClip = async () => (await overlayTrack()).clips[0]!
async function seek(editor: Locator, ms: number) {
  const position = editor.getByRole('textbox', { name: 'Playback position', exact: true })
  await position.fill(String(ms / 1000))
  await position.press('Enter')
}
async function setNumber(editor: Locator, name: string, value: string) {
  const field = editor.getByRole('spinbutton', { name, exact: true })
  await field.fill(value)
  await field.press('Enter')
}
async function relativeBox(overlay: Locator) {
  return overlay.evaluate(element => {
    const frame = element.closest('.vis-tl-output-frame')!
    const outer = frame.getBoundingClientRect()
    const inner = element.getBoundingClientRect()
    return { x: (inner.x - outer.x) / outer.width, y: (inner.y - outer.y) / outer.height, width: inner.width / outer.width, aspect: inner.width / inner.height, right: (outer.right - inner.right) / outer.width }
  })
}

describe.skipIf(!ready)('Timeline overlay acceptance', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-overlay-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'overlay-e2e', secretStore: createMemorySecretStore(), runtimes: {},
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { video: { provider: 'mock' } },
    })
    const spaceId = daemon.spaces.create('Overlay acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const video = join(dir, 'blue shot.mp4')
    const image = join(dir, 'red logo.png')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'aac', '-c:v', 'libx264', '-preset', 'ultrafast', '-y', video], { windowsHide: true })
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:size=96x48', '-frames:v', '1', '-y', image], { windowsHide: true })
    const videoAsset = (await admin.call('asset.import', { requestId: crypto.randomUUID(), path: video })).assetVersionId
    imageAsset = (await admin.call('asset.import', { requestId: crypto.randomUUID(), path: image })).assetVersionId
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'shot', kind: 'video', title: 'Acceptance shot', x: 40, y: 40, content: { assetVersionId: videoAsset } },
      { op: 'node.create', tempId: 'logo', kind: 'image', title: 'Acceptance logo', x: 40, y: 280, content: { assetVersionId: imageAsset } },
    ])
    imageNodeId = idMap.logo!
    timelineId = (await apply([{ op: 'node.create', tempId: 'cut', kind: 'timeline', title: 'Overlay cut', x: 700, y: 160, content: { timelineFrom: [idMap.shot!] } }])).idMap.cut!
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor()
  })
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(screenshots, 'failure-overlay.png'), animations: 'disabled' })
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('drops an image onto an overlay lane, places and fades it in the preview, manipulates it and exports', async () => {
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    const card = page.getByRole('region', { name: /^Timeline Overlay cut,/ })
    await card.getByText('1 clips · 00:06', { exact: true }).click()
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Overlay cut', exact: true })
    await editor.getByRole('button', { name: 'Add track', exact: true }).click()
    await editor.getByRole('menuitem', { name: 'Add overlay track', exact: true }).click()
    const track = editor.getByRole('group', { name: 'Overlay 1', exact: true })
    const lane = track.getByRole('group', { name: 'Overlay 1 lane', exact: true })
    const media = editor.getByRole('complementary', { name: 'Media bin', exact: true })
    await media.getByRole('button', { name: 'Acceptance logo', exact: true }).dragTo(lane, { targetPosition: { x: 1, y: 24 } })
    await expect.poll(async () => (await overlayTrack()).clips.length).toBe(1)
    expect(await overlayClip()).toMatchObject({ source: { nodeId: imageNodeId, assetVersionId: imageAsset }, startMs: 0, inMs: 0, outMs: 5000, overlay: { x: 0.5, y: 0.5, width: 0.25, opacity: 1 } })
    await track.getByRole('button', { name: /^Acceptance logo,/ }).click()
    await seek(editor, 1000)
    const preview = editor.getByRole('group', { name: 'Preview', exact: true })
    const overlay = preview.getByRole('button', { name: 'Overlay Acceptance logo', exact: true })
    await overlay.waitFor()
    await editor.getByRole('combobox', { name: 'Overlay placement', exact: true }).selectOption('topRight')
    await expect.poll(async () => (await relativeBox(overlay)).right).toBeCloseTo(0.04, 2)
    const placed = await relativeBox(overlay)
    expect(placed.y).toBeCloseTo(0.04, 2)
    expect(placed.width).toBeCloseTo(0.25, 2)
    expect(placed.aspect).toBeCloseTo(2, 1)
    await expect.poll(async () => (await overlayClip()).overlay!.x).toBeGreaterThan(0.75)
    const position = (await overlayClip()).overlay!
    expect(position.x).toBeGreaterThan(0.75)
    expect(position.y).toBeLessThan(0.25)

    await track.getByRole('button', { name: 'Hide track', exact: true }).click()
    await expect.poll(async () => (await overlayTrack()).hidden).toBe(true)
    await expect.poll(() => overlay.isVisible()).toBe(false)
    await track.getByRole('button', { name: 'Show track', exact: true }).click()
    await expect.poll(() => overlay.isVisible()).toBe(true)

    await setNumber(editor, 'Opacity', '50')
    await setNumber(editor, 'Fade in (seconds)', '1')
    await setNumber(editor, 'Fade out (seconds)', '1')
    await expect.poll(async () => ({ opacity: (await overlayClip()).overlay!.opacity, fadeInMs: (await overlayClip()).fadeInMs, fadeOutMs: (await overlayClip()).fadeOutMs })).toEqual({ opacity: 0.5, fadeInMs: 1000, fadeOutMs: 1000 })
    await editor.getByText('Fades the picture and sound', { exact: true }).waitFor()
    const opacity = () => overlay.evaluate(element => Number(getComputedStyle(element.parentElement!.querySelector('img')!).opacity))
    const imagePool = await overlay.evaluateHandle(element => [...element.parentElement!.parentElement!.querySelectorAll('img')])
    expect(await imagePool.evaluate(images => images.length)).toBe(2)
    await seek(editor, 500)
    await expect.poll(opacity).toBeCloseTo(0.25, 2)
    await seek(editor, 2000)
    await expect.poll(opacity).toBeCloseTo(0.5, 2)
    await seek(editor, 4500)
    await expect.poll(opacity).toBeCloseTo(0.25, 2)
    await seek(editor, 5500)
    await expect.poll(() => overlay.isVisible()).toBe(false)
    await seek(editor, 2000)
    await expect.poll(opacity).toBeCloseTo(0.5, 2)
    expect(await imagePool.evaluate(images => images.every(image => image.isConnected))).toBe(true)
    expect(await overlay.evaluate(element => element.parentElement!.parentElement!.querySelectorAll('img').length)).toBe(2)
    await imagePool.dispose()
    await editor.getByText('Saved', { exact: true }).waitFor()
    await expect.poll(() => overlay.evaluate(element => new Promise<number>(resolve => {
      let changes = 0
      const observer = new MutationObserver(records => { changes += records.length })
      observer.observe(element.parentElement!, { attributes: true, subtree: true })
      setTimeout(() => { observer.disconnect(); resolve(changes) }, 150)
    }))).toBe(0)
    await overlay.focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await overlayClip()).overlay!.x).toBeCloseTo(position.x - 0.005, 3)
    await page.keyboard.press('Shift+ArrowDown')
    await expect.poll(async () => (await overlayClip()).overlay!.y).toBeCloseTo(position.y + 0.05, 3)

    const beforeDrag = (await overlayClip()).overlay!
    const box = (await overlay.boundingBox())!
    const frame = await overlay.evaluate(element => {
      const rect = element.closest('.vis-tl-output-frame')!.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })
    await page.keyboard.down('Alt')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - frame.width * 0.1, box.y + box.height / 2 + frame.height * 0.1, { steps: 8 })
    expect((await overlayClip()).overlay).toEqual(beforeDrag)
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect.poll(async () => (await overlayClip()).overlay!.x).toBeCloseTo(beforeDrag.x - 0.1, 2)
    await expect.poll(async () => (await overlayClip()).overlay!.y).toBeCloseTo(beforeDrag.y + 0.1, 2)
    await setNumber(editor, 'Overlay size', '40')
    await expect.poll(async () => (await overlayClip()).overlay!.width).toBe(0.4)
    await expect.poll(async () => (await relativeBox(overlay)).aspect).toBeCloseTo(2, 1)

    await editor.getByRole('button', { name: 'Add track', exact: true }).click()
    await editor.getByRole('menuitem', { name: 'Add overlay track', exact: true }).click()
    await expect.poll(async () => (await savedDoc()).tracks.filter(track => track.kind === 'overlay').length).toBe(2)
    await editor.getByRole('button', { name: 'Add track', exact: true }).click()
    expect(await editor.getByRole('menuitem', { name: 'Add overlay track', exact: true }).isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
    await editor.getByRole('combobox', { name: 'Overlay placement', exact: true }).selectOption('topRight')
    await editor.getByText('Saved', { exact: true }).waitFor()
    await page.screenshot({ path: join(screenshots, 'editor-overlay-selected.png'), animations: 'disabled' })
    await editor.getByRole('button', { name: 'Export', exact: true }).click()
    await editor.getByText('Exported', { exact: true }).waitFor({ timeout: 30_000 })
    await expect.poll(async () => (await nodes()).filter(node => node.exportOf?.timelineNodeId === timelineId).length).toBe(1)
    const exported = (await nodes()).find(node => node.exportOf?.timelineNodeId === timelineId)!
    expect(exported.kind).toBe('video')
    expect(errors).toEqual([])
  }, 90_000)

  it('creates a track from the dashed drop row, selects the topmost picture, resizes a corner and preloads the next image', async () => {
    const mainTrack = (await savedDoc()).tracks.find(track => track.kind === 'video')!
    const green = join(dir, 'next logo.png')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=green:size=96x48', '-frames:v', '1', '-y', green], { windowsHide: true })
    const nextAsset = (await admin.call('asset.import', { requestId: crypto.randomUUID(), path: green })).assetVersionId
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'lower', kind: 'image', title: 'Lower logo', x: 360, y: 280, content: { assetVersionId: imageAsset } },
      { op: 'node.create', tempId: 'next', kind: 'image', title: 'Next logo', x: 360, y: 480, content: { assetVersionId: nextAsset } },
      { op: 'node.create', tempId: 'cut', kind: 'timeline', title: 'Layered overlay cut', x: 700, y: 480 },
    ])
    timelineId = idMap.cut!
    const node = (await nodes()).find(node => node.nodeId === timelineId)!
    const doc: TimelineDoc = { version: 1, tracks: [mainTrack, {
      id: 'lower-overlay', kind: 'overlay', muted: false, volume: 1, hidden: false, clips: [
        { id: 'lower-logo', source: { nodeId: idMap.lower!, assetVersionId: imageAsset }, startMs: 0, inMs: 0, outMs: 2000, volume: 1, fadeInMs: 0, fadeOutMs: 0, overlay: { x: 0.5, y: 0.5, width: 0.25, opacity: 1 } },
        { id: 'next-logo', source: { nodeId: idMap.next!, assetVersionId: nextAsset }, startMs: 2400, inMs: 0, outMs: 1600, volume: 1, fadeInMs: 0, fadeOutMs: 0, overlay: { x: 0.5, y: 0.5, width: 0.25, opacity: 1 } },
      ],
    }] }
    await apply([{ op: 'timeline.set', slotId: main(node).slotId, expectedRevision: main(node).revision, doc }])
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    const card = page.getByRole('region', { name: /^Timeline Layered overlay cut,/ })
    await card.getByText('3 clips · 00:06', { exact: true }).click()
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Layered overlay cut', exact: true })
    const media = editor.getByRole('complementary', { name: 'Media bin', exact: true })
    const source = (await media.getByRole('button', { name: 'Acceptance logo', exact: true }).boundingBox())!
    const lowerLane = editor.getByRole('group', { name: 'Overlay 1 lane', exact: true })
    const target = (await lowerLane.boundingBox())!
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, { steps: 4 })
    await page.mouse.move(target.x + 60, target.y + 24, { steps: 12 })
    const newLane = editor.getByRole('group', { name: 'New overlay track', exact: true })
    await newLane.waitFor()
    expect(await newLane.evaluate(element => getComputedStyle(element, '::before').borderTopStyle)).toBe('dashed')
    const destination = (await newLane.boundingBox())!
    await page.mouse.move(destination.x + 1, destination.y + 24, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await savedDoc()).tracks.filter(track => track.kind === 'overlay').length).toBe(2)
    await expect.poll(() => newLane.count()).toBe(0)
    expect((await savedDoc()).tracks.filter(track => track.kind === 'overlay')[1]!.clips[0]).toMatchObject({ source: { nodeId: imageNodeId }, startMs: 0, outMs: 5000 })

    await seek(editor, 1000)
    const preview = editor.getByRole('group', { name: 'Preview', exact: true })
    const lower = preview.getByRole('button', { name: 'Overlay Lower logo', exact: true })
    const upper = preview.getByRole('button', { name: 'Overlay Acceptance logo', exact: true })
    await lower.waitFor()
    await upper.waitFor()
    const overlap = (await lower.boundingBox())!
    await page.mouse.click(overlap.x + overlap.width / 2, overlap.y + overlap.height / 2)
    await expect.poll(() => upper.getAttribute('aria-selected')).toBe('true')
    expect(await lower.getAttribute('aria-selected')).toBe('false')
    const before = await relativeBox(upper)
    const corner = (await upper.boundingBox())!
    const frameWidth = corner.width / before.width
    await page.keyboard.down('Alt')
    await page.mouse.move(corner.x + corner.width - 1, corner.y + corner.height - 1)
    await page.mouse.down()
    await page.mouse.move(corner.x + corner.width - 1 + frameWidth * 0.1, corner.y + corner.height - 1, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect.poll(async () => (await savedDoc()).tracks.filter(track => track.kind === 'overlay')[1]!.clips[0]!.overlay!.width).toBeCloseTo(0.35, 2)
    const resized = await relativeBox(upper)
    expect(resized.aspect).toBeCloseTo(2, 1)
    expect(resized.x).toBeCloseTo(before.x, 2)
    expect(resized.y).toBeCloseTo(before.y, 2)

    await seek(editor, 1800)
    const pool = await lower.evaluateHandle(element => [...element.parentElement!.parentElement!.querySelectorAll('img')])
    expect(await pool.evaluate(images => images.length)).toBe(2)
    expect(await pool.evaluate(images => images.filter(image => image.hasAttribute('src')).length)).toBe(1)
    await seek(editor, 1900)
    await expect.poll(() => pool.evaluate(images => images.filter(image => image.hasAttribute('src')).length)).toBe(2)
    const preload = await pool.evaluateHandle((images, id) => images.find(image => image.getAttribute('src')?.includes(id))!, nextAsset)
    expect(await preload.evaluate(image => getComputedStyle(image).visibility)).toBe('hidden')
    await seek(editor, 2400)
    await expect.poll(() => preview.getByRole('button', { name: 'Overlay Next logo', exact: true }).isVisible()).toBe(true)
    expect(await preload.evaluate(image => image.isConnected && getComputedStyle(image).visibility === 'visible')).toBe(true)
    expect(await pool.evaluate(images => images.every(image => image.isConnected))).toBe(true)
    await preload.dispose()
    await pool.dispose()
    expect(errors).toEqual([])
  }, 60_000)

  it('drops a video, positions and plays picture-in-picture, limits concurrent previews and mutes', async () => {
    const mainTrack = (await savedDoc()).tracks.find(track => track.kind === 'video')!
    timelineId = (await apply([{ op: 'node.create', tempId: 'pip', kind: 'timeline', title: 'Video overlay cut', x: 700, y: 700 }])).idMap.pip!
    const node = (await nodes()).find(node => node.nodeId === timelineId)!
    await apply([{ op: 'timeline.set', slotId: main(node).slotId, expectedRevision: main(node).revision, doc: { version: 1, tracks: [mainTrack] } }])
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    const card = page.getByRole('region', { name: /^Timeline Video overlay cut,/ })
    await card.getByText('1 clips · 00:06', { exact: true }).click()
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Video overlay cut', exact: true })
    await editor.getByRole('button', { name: 'Add track', exact: true }).click()
    await editor.getByRole('menuitem', { name: 'Add overlay track', exact: true }).click()
    const bottom = editor.getByRole('group', { name: 'Overlay 1', exact: true })
    const lane = bottom.getByRole('group', { name: 'Overlay 1 lane', exact: true })
    const media = editor.getByRole('complementary', { name: 'Media bin', exact: true })
    const shot = media.getByRole('button', { name: 'Acceptance shot', exact: true })
    await shot.dragTo(lane, { targetPosition: { x: 1, y: 24 } })
    await expect.poll(async () => (await overlayTrack()).clips.length).toBe(1)
    expect(await overlayClip()).toMatchObject({ startMs: 0, inMs: 0, outMs: 6000, overlay: { x: 0.5, y: 0.5, width: 0.25, opacity: 1 } })
    const clip = bottom.getByRole('button', { name: /^Acceptance shot,/ })
    await clip.click()
    await expect.poll(() => clip.evaluate(element => getComputedStyle(element).backgroundImage)).toContain('/filmstrip')
    await editor.getByRole('spinbutton', { name: 'Speed', exact: true }).waitFor()
    await editor.getByRole('slider', { name: 'Clip volume', exact: true }).waitFor()
    await editor.getByRole('combobox', { name: 'Overlay placement', exact: true }).selectOption('bottomRight')
    await seek(editor, 1000)
    const preview = editor.getByRole('group', { name: 'Preview', exact: true })
    const picture = preview.getByRole('button', { name: 'Overlay Acceptance shot', exact: true })
    await picture.waitFor()
    await expect.poll(async () => (await relativeBox(picture)).right).toBeCloseTo(0.04, 2)
    const placed = await relativeBox(picture)
    expect(placed.x).toBeGreaterThan(0.5)
    expect(placed.y).toBeGreaterThan(0.5)
    expect(placed.width).toBeCloseTo(0.25, 2)
    const video = await picture.evaluateHandle(element => element.parentElement!.querySelector('video')!)
    await expect.poll(() => video.evaluate(element => element.currentTime)).toBeCloseTo(1, 2)
    await page.screenshot({ path: join(screenshots, 'editor-video-overlay-selected.png'), animations: 'disabled' })
    await preview.getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(1.2)
    expect(await video.evaluate(element => element.paused)).toBe(false)
    await preview.getByRole('button', { name: 'Pause', exact: true }).click()
    await seek(editor, 1000)

    const source = (await shot.boundingBox())!
    const target = (await lane.boundingBox())!
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, { steps: 4 })
    await page.mouse.move(target.x + 30, target.y + 24, { steps: 12 })
    const newLane = editor.getByRole('group', { name: 'New overlay track', exact: true })
    await newLane.waitFor()
    const destination = (await newLane.boundingBox())!
    await page.mouse.move(destination.x + 1, destination.y + 24, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await savedDoc()).tracks.filter(track => track.kind === 'overlay').length).toBe(2)
    const top = editor.getByRole('group', { name: 'Overlay 2', exact: true })
    const topClip = top.getByRole('button', { name: /^Acceptance shot,/ })
    await topClip.click()
    await editor.getByRole('combobox', { name: 'Overlay placement', exact: true }).selectOption('topLeft')
    await seek(editor, 1000)
    const visibleVideos = () => preview.evaluate(element => [...element.querySelectorAll('.vis-tl-overlay-slot > video')].filter(video => getComputedStyle(video).visibility === 'visible').map(video => {
      const media = video as HTMLVideoElement
      return { paused: media.paused, muted: media.muted, time: media.currentTime }
    }))
    await expect.poll(async () => (await visibleVideos()).map(item => item.time)).toEqual([1, 1])
    await preview.getByRole('button', { name: 'Play', exact: true }).click()
    const limited = preview.getByRole('status').filter({ hasText: 'Preview limited' })
    await limited.waitFor()
    expect(await limited.textContent()).toContain('Export includes every overlay')
    await expect.poll(async () => (await visibleVideos()).map(item => item.paused)).toEqual([true, false])
    expect((await visibleVideos())[0]!.muted).toBe(true)
    await top.getByRole('button', { name: 'Mute', exact: true }).click()
    await expect.poll(async () => (await savedDoc()).tracks.filter(track => track.kind === 'overlay')[1]!.muted).toBe(true)
    expect(await top.getByRole('button', { name: 'Unmute', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await page.screenshot({ path: join(screenshots, 'editor-video-overlay-preview-limited.png'), animations: 'disabled' })
    await preview.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect.poll(() => limited.count()).toBe(0)
    await seek(editor, 2000)
    await expect.poll(async () => (await visibleVideos()).map(item => item.time)).toEqual([2, 2])
    await video.dispose()
    expect(errors).toEqual([])
  }, 90_000)

  it('exports video overlays with every picture and sound after renderer integration', async () => {
    const editor = page.getByRole('dialog', { name: 'Video overlay cut', exact: true })
    await editor.getByText('Saved', { exact: true }).waitFor()
    await editor.getByRole('button', { name: 'Export', exact: true }).click()
    await editor.getByText('Exported', { exact: true }).waitFor({ timeout: 30_000 })
    await expect.poll(async () => (await nodes()).filter(node => node.exportOf?.timelineNodeId === timelineId).length).toBe(1)
    expect(errors).toEqual([])
  }, 90_000)

})
