import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasOp, NodeView, SessionSummary, TimelineDoc, WorkItemView } from '@vis/protocol'
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
const screenshots = join(tmpdir(), 'vis-0024-B3')
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let spaceId: string
let videoAsset: string
let audioAsset: string
let worker: WorkItemView
let rejectCommits = false
let rejectedCommits = 0
const errors: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const main = (node: NodeView) => node.slots.find(slot => slot.slotKey === 'main')!
const document = (node: NodeView): TimelineDoc => {
  const content = main(node).content
  if (content.type !== 'timeline') throw new Error('Expected a timeline document')
  return content.doc
}
const card = (title: string) => page.getByRole('region', { name: new RegExp(`^Timeline ${title},`) })
const screenshot = (name: string) => page.screenshot({ path: join(screenshots, `${name}.png`), animations: 'disabled' })

async function fit() {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  let previous = ''
  await expect.poll(async () => {
    const transform = await page.getByRole('region', { name: /^Timeline / }).first().evaluate(element => {
      const viewport = element.closest('.react-flow__viewport')
      return viewport ? getComputedStyle(viewport).transform : ''
    })
    const settled = transform === previous
    previous = transform
    return settled
  }, { intervals: [100] }).toBe(true)
}

async function seedMedia() {
  const created = await apply([
    { op: 'node.create', tempId: 'third', kind: 'video', title: 'Shot 3', x: 40, y: 520, w: 240, h: 135, content: { assetVersionId: videoAsset } },
    { op: 'node.create', tempId: 'first', kind: 'video', title: 'Shot 1', x: 40, y: 40, w: 240, h: 135, content: { assetVersionId: videoAsset } },
    { op: 'node.create', tempId: 'second', kind: 'video', title: 'Shot 2', x: 40, y: 280, w: 240, h: 135, content: { assetVersionId: videoAsset } },
    { op: 'node.create', tempId: 'audio', kind: 'audio', title: 'Music source', x: 420, y: 520, w: 300, h: 140, content: { assetVersionId: audioAsset } },
  ])
  return [created.idMap.first, created.idMap.second, created.idMap.third] as string[]
}

async function scenario(text: string) {
  await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId: worker.sessions[0]!.sessionId, text, refs: [] })
  await expect.poll(async () => {
    const transcript = await admin.call('session.getTranscript', { sessionId: worker.sessions[0]!.sessionId })
    return JSON.stringify(transcript.items)
  }, { timeout: 15_000 }).toContain(`Completed ${text}`)
  await expect.poll(async () => {
    const sessions: SessionSummary[] = (await admin.call('session.list')).sessions
    return sessions.find(session => session.sessionId === worker.sessions[0]!.sessionId)?.activeTurnId
  }).toBeNull()
}

describe.skipIf(!ready)('Timeline editor acceptance', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-timeline-editor-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'timeline-editor-e2e', secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { video: { provider: 'mock' }, audio: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
    })
    spaceId = daemon.spaces.create('Timeline editor acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const video = join(dir, 'short shot.webm')
    const audio = join(dir, 'music.wav')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=2', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-pix_fmt', 'yuv420p', video], { shell: false })
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'pcm_s16le', audio], { shell: false })
    const space = daemon.spaces.get(spaceId)!
    videoAsset = space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(video), kind: 'video', mime: 'video/webm', origin: 'import', width: 160, height: 90, durationMs: 2000 }).assetVersionId
    audioAsset = space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(audio), kind: 'audio', mime: 'audio/wav', origin: 'import', durationMs: 4000 }).assetVersionId
    worker = (await admin.call('work.create', { requestId: crypto.randomUUID(), title: 'Timeline editor', chat: { agentKind: 'codex' } })).item
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    await page.routeWebSocket('**/*', ws => {
      const server = ws.connectToServer()
      ws.onMessage(message => {
        const request = JSON.parse(String(message))
        if (rejectCommits && request.method === 'canvas.apply' && request.params?.ops?.some((op: CanvasOp) => op.op === 'timeline.set')) {
          rejectedCommits++
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid timeline document', data: { code: 'invalid_params', reason: 'timeline.invalid_doc' } } }))
        } else server.send(message)
      })
    })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor()
  })
  afterEach(async ({ task }) => {
    rejectCommits = false
    if (task.result?.state === 'fail' && page) {
      await screenshot(`failure-${task.name.replaceAll(/[^a-z0-9]+/gi, '-')}`)
      // A failed case can leave the editor open over the canvas; reload so later cases start from the canvas.
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor()
    }
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('opens from the canvas, retains the viewport and restores node focus on Escape', async () => {
    const ordered = await seedMedia()
    await apply([{ op: 'node.create', tempId: 'sfx', kind: 'audio', title: 'Sound effects source', x: 420, y: 740, content: { assetVersionId: audioAsset } }])
    const { idMap } = await apply([{ op: 'node.create', tempId: 'timeline', kind: 'timeline', title: 'Editor cut', x: 800, y: 200, content: { timelineFrom: ordered } }])
    await fit()
    await card('Editor cut').getByText('3 clips · 00:06', { exact: true }).click()
    const viewport = await page.locator('.react-flow__viewport').getAttribute('style')
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Editor cut', exact: true })
    await editor.waitFor()
    await editor.getByRole('button', { name: 'Next frame', exact: true }).click()
    await expect.poll(() => editor.getByRole('textbox', { name: 'Playback position' }).inputValue()).toBe('00:00.01')
    await editor.getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(async () => Number((await editor.getByRole('textbox', { name: 'Playback position' }).inputValue()).split(':').at(-1)?.split('.')[0]), { timeout: 5000 }).toBeGreaterThanOrEqual(2)
    await editor.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect.poll(() => editor.getByRole('group', { name: 'Preview', exact: true }).evaluate(element => {
      const videos = [...element.querySelectorAll('video')]
      const visible = videos.find(video => getComputedStyle(video).visibility === 'visible')
      return { count: videos.length, width: visible?.videoWidth, ready: (visible?.readyState ?? 0) >= 2, error: visible?.error?.code ?? null }
    })).toEqual({ count: 2, width: 160, ready: true, error: null })
    await screenshot('editor-shell')
    await editor.getByRole('button', { name: 'Close editor', exact: true }).focus()
    await page.keyboard.press('Escape')
    await expect.poll(() => editor.count()).toBe(0)
    expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(viewport)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-id'))).toBe(idMap.timeline)
    expect(errors).toEqual([])
  })

  it('splits, saves, edits fades with session undo, resolves Agent conflicts and exports', async () => {
    const timeline = (await nodes()).find(node => node.kind === 'timeline')!
    await card('Editor cut').getByText('3 clips · 00:06', { exact: true }).click()
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Editor cut', exact: true })
    const video = editor.getByRole('group', { name: 'Video', exact: true })
    const clipButtons = video.getByRole('button', { name: /^Shot [123],/ })
    await expect.poll(() => clipButtons.count()).toBe(3)
    expect(await clipButtons.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')?.split(',')[0]))).toEqual(['Shot 1', 'Shot 2', 'Shot 3'])
    await editor.getByRole('textbox', { name: 'Playback position' }).fill('00:03.00')
    await editor.getByRole('textbox', { name: 'Playback position' }).press('Enter')
    await editor.getByRole('button', { name: 'Split', exact: true }).click()
    await expect.poll(() => clipButtons.count()).toBe(4)
    await expect.poll(async () => document((await nodes()).find(node => node.nodeId === timeline.nodeId)!).tracks.find(track => track.kind === 'video')!.clips.length).toBe(4)
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click()
    await expect.poll(() => editor.count()).toBe(0)
    await expect.poll(() => card('Editor cut').getByRole('group', { name: 'Video', exact: true }).getByRole('img').count()).toBe(4)
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
    await editor.getByRole('textbox', { name: 'Playback position' }).fill('00:00.00')
    await editor.getByRole('textbox', { name: 'Playback position' }).press('Enter')
    await editor.getByRole('button', { name: 'Music source', exact: true }).dblclick()
    const music = editor.getByRole('button', { name: /^Music source,/ })
    await music.click()
    const fade = editor.getByRole('spinbutton', { name: 'Fade out (seconds)', exact: true })
    await fade.fill('0.5')
    await fade.press('Tab')
    const liveDoc = async () => document((await nodes()).find(node => node.nodeId === timeline.nodeId)!)
    const audioFade = async () => (await liveDoc()).tracks.filter(track => track.kind === 'audio').flatMap(track => track.clips)[0]?.fadeOutMs
    await expect.poll(audioFade).toBe(500)
    await editor.getByRole('button', { name: 'Close editor', exact: true }).focus()
    await page.keyboard.press('Control+z')
    await expect.poll(audioFade).toBe(0)
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(audioFade).toBe(500)
    await editor.getByText('Saved', { exact: true }).waitFor()
    await editor.getByRole('button', { name: 'Add track', exact: true }).click()
    await editor.getByRole('menuitem', { name: 'Add audio track', exact: true }).click()
    await editor.getByRole('button', { name: 'Sound effects source', exact: true }).dblclick()
    await music.click()
    await editor.getByRole('button', { name: 'Fit', exact: true }).click()
    await expect.poll(() => editor.getByRole('button', { name: /^Sound effects source,/ }).evaluate(element => {
      const canvas = element.querySelector('canvas')
      const pixels = canvas?.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
      return !!pixels?.some((value, index) => index % 4 === 3 && value > 0)
    })).toBe(true)
    await screenshot('editor-video-two-audio-selected')
    await editor.getByText('Saved', { exact: true }).waitFor()
    await scenario('timeline-edit')
    await editor.getByRole('button', { name: 'Load their version', exact: true }).waitFor()
    expect(await editor.getByRole('alert').textContent()).toContain(`This timeline was changed by ${(await admin.call('session.list')).sessions.find(session => session.sessionId === worker.sessions[0]!.sessionId)!.title}.`)
    await admin.call('session.rename', { requestId: crypto.randomUUID(), sessionId: worker.sessions[0]!.sessionId, title: 'Renamed timeline writer' })
    await expect.poll(() => editor.getByRole('alert').textContent()).toContain('This timeline was changed by Renamed timeline writer.')
    expect(await editor.getByRole('button', { name: 'Split', exact: true }).isDisabled()).toBe(true)
    await editor.getByRole('button', { name: 'Load their version', exact: true }).click()
    await expect.poll(() => clipButtons.count()).toBe(3)
    await editor.getByRole('button', { name: 'Export', exact: true }).click()
    await editor.getByText(/^Exporting /).waitFor()
    await editor.getByText('Exported', { exact: true }).waitFor({ timeout: 20_000 })
    await expect.poll(async () => (await nodes()).filter(node => node.exportOf?.timelineNodeId === timeline.nodeId).length).toBe(1)
    // Escape clears clip selection before closing; do not let a second press reach the restored canvas and blur its node.
    const selectedClips = editor.locator('.vis-tl-clip[aria-selected="true"]')
    if (await selectedClips.count()) {
      await editor.getByRole('button', { name: 'Close editor', exact: true }).press('Escape')
      await expect.poll(() => selectedClips.count()).toBe(0)
    }
    await editor.getByRole('button', { name: 'Close editor', exact: true }).press('Escape')
    await expect.poll(() => editor.count()).toBe(0)
    await card('Editor cut').getByRole('group', { name: 'Latest export', exact: true }).waitFor()
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-id'))).toBe(timeline.nodeId)
    expect(errors).toEqual([])
  }, 60_000)

  async function openCut(title: string) {
    const ordered = await seedMedia()
    const { idMap } = await apply([{ op: 'node.create', tempId: 'cut', kind: 'timeline', title, x: 800, y: 200, content: { timelineFrom: ordered } }])
    await fit()
    await card(title).getByText('3 clips · 00:06', { exact: true }).click()
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
    const editor = page.getByRole('dialog', { name: title, exact: true })
    await editor.waitFor()
    return { editor, nodeId: idMap.cut! }
  }

  it('keeps the selected canvas timeline after deleting every clip and pressing Delete again', async () => {
    const { editor, nodeId } = await openCut('Delete isolation')
    const clips = editor.getByRole('group', { name: 'Video', exact: true }).getByRole('button', { name: /^Shot [123],/ })
    await clips.nth(0).click()
    await clips.nth(1).click({ modifiers: ['Shift'] })
    await clips.nth(2).click({ modifiers: ['Shift'] })
    await page.keyboard.press('Delete')
    await expect.poll(() => clips.count()).toBe(0)
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
    const before = (await nodes()).map(({ nodeId, x, y }) => ({ nodeId, x, y }))
    for (const key of ['Control+c', 'Control+v', 'Control+d', '?', 'ArrowRight', 'Backspace']) await page.keyboard.press(key)
    await page.keyboard.press('Delete')
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click()
    await expect.poll(() => editor.count()).toBe(0)
    expect((await nodes()).map(({ nodeId, x, y }) => ({ nodeId, x, y }))).toEqual(before)
    expect((await nodes()).some(node => node.nodeId === nodeId)).toBe(true)
    await card('Delete isolation').waitFor()
  })

  it('keeps playback and Escape working after a click on the preview stage', async () => {
    const { editor } = await openCut('Stage focus')
    await editor.getByRole('group', { name: 'Preview', exact: true }).click({ position: { x: 10, y: 10 } })
    await page.keyboard.press('Shift+Tab')
    expect(await editor.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await editor.getByRole('group', { name: 'Preview', exact: true }).click({ position: { x: 10, y: 10 } })
    await page.keyboard.press('Space')
    await expect.poll(() => editor.getByRole('button', { name: 'Pause', exact: true }).count()).toBe(1)
    await page.keyboard.press('Escape')
    await expect.poll(() => editor.count()).toBe(0)
  })

  it('shares decimal-seconds timecodes and preserves first-clip dimensions when setting fps', async () => {
    const { editor, nodeId } = await openCut('Output metadata')
    const position = editor.getByRole('textbox', { name: 'Playback position', exact: true })
    await position.fill('1.5')
    await position.press('Enter')
    await expect.poll(() => position.inputValue()).toBe('00:01.15')
    const fps = editor.getByRole('combobox', { name: 'Frame rate', exact: true })
    await expect.poll(() => fps.isEnabled()).toBe(true)
    await fps.selectOption('24')
    await expect.poll(async () => document((await nodes()).find(node => node.nodeId === nodeId)!).output).toEqual({ width: 160, height: 90, fps: 24 })
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click()
    await expect.poll(() => editor.count()).toBe(0)
  })

  it('keeps both host identities across shell state changes and unrelated App renders', async () => {
    const { editor } = await openCut('Host identity')
    const clip = editor.getByRole('group', { name: 'Video', exact: true }).getByRole('button', { name: /^Shot 1,/ })
    // Host identity is not visible in DOM output; inspect the committed React tree without product instrumentation.
    const hosts = (remember: boolean) => clip.evaluate((element, remember) => {
      type Fiber = { return?: Fiber; child?: Fiber; sibling?: Fiber; stateNode?: unknown; memoizedProps?: { host?: unknown } }
      const properties = element as unknown as Record<string, Fiber>
      let root = properties[Object.keys(element).find(key => key.startsWith('__reactFiber$'))!]!
      while (root.return) root = root.return
      root = (root.stateNode as { current: Fiber }).current
      const find = (fiber: Fiber | undefined): Fiber | undefined => {
        if (!fiber) return
        return fiber.stateNode === element ? fiber : find(fiber.child) ?? find(fiber.sibling)
      }
      let fiber = find(root)
      const current: unknown[] = []
      while (fiber) {
        const host = fiber.memoizedProps?.host
        if (host && !current.includes(host)) current.push(host)
        fiber = fiber.return
      }
      const target = element as HTMLElement & { hostSnapshot?: unknown[] }
      if (remember) target.hostSnapshot = current
      return { count: current.length, same: current.every((host, index) => host === target.hostSnapshot?.[index]) }
    }, remember)
    expect(await hosts(true)).toEqual({ count: 2, same: true })
    await editor.getByRole('button', { name: 'More actions', exact: true }).click()
    expect(await hosts(false)).toEqual({ count: 2, same: true })
    await editor.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.keyboard.press('Control+,')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.waitFor()
    expect(await hosts(false)).toEqual({ count: 2, same: true })
    await settings.getByRole('button', { name: 'Close settings', exact: true }).click()
    const currentWork = (await admin.call('work.get', { spaceId, workItemId: worker.workItemId })).item
    await admin.call('work.update', { requestId: crypto.randomUUID(), spaceId, workItemId: worker.workItemId, expectedRevision: currentWork.revision, title: 'Host identity worker' })
    const note = 'Unrelated host identity note'
    const created = await apply([{ op: 'node.create', tempId: 'note', kind: 'text', x: 40, y: 40, content: { text: note } }])
    await page.getByText(note, { exact: true }).waitFor({ state: 'attached' })
    expect(await hosts(false)).toEqual({ count: 2, same: true })
    await apply([{ op: 'node.delete', nodeId: created.idMap.note! }])
    await page.getByText(note, { exact: true }).waitFor({ state: 'detached' })
    expect(await hosts(false)).toEqual({ count: 2, same: true })
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click()
    await expect.poll(() => editor.count()).toBe(0)
  })

  it('uses clip Tab navigation only from clip buttons and lets boundary Tab follow normal focus order', async () => {
    const { editor } = await openCut('Tab focus')
    const clips = editor.getByRole('group', { name: 'Video', exact: true }).getByRole('button', { name: /^Shot [123],/ })
    await clips.nth(0).click()
    await clips.nth(0).focus()
    await page.keyboard.press('Tab')
    await expect.poll(() => clips.nth(1).getAttribute('aria-selected')).toBe('true')
    await page.keyboard.press('Tab')
    await expect.poll(() => clips.nth(2).getAttribute('aria-selected')).toBe('true')
    await page.keyboard.press('Tab')
    expect(await clips.nth(2).evaluate(element => document.activeElement === element)).toBe(false)
    await editor.getByRole('button', { name: 'Close editor', exact: true }).focus()
    await page.keyboard.press('Tab')
    expect(await editor.getByRole('textbox', { name: 'Timeline title', exact: true }).evaluate(element => document.activeElement === element)).toBe(true)
    await clips.nth(0).click()
    await clips.nth(0).focus()
    await page.keyboard.press('Shift+Tab')
    expect(await clips.nth(0).evaluate(element => document.activeElement === element)).toBe(false)
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click()
    await expect.poll(() => editor.count()).toBe(0)
  })

  it.each(['back', 'escape', 'source'] as const)('can retry or discard an invalid save when leaving through %s', async leave => {
    const { editor, nodeId } = await openCut(`Invalid save ${leave}`)
    const before = (await nodes()).find(node => node.nodeId === nodeId)!
    rejectCommits = true
    rejectedCommits = 0
    const clip = editor.getByRole('group', { name: 'Video', exact: true }).getByRole('button', { name: /^Shot 1,/ })
    await clip.click()
    const volume = editor.getByRole('spinbutton', { name: 'Clip audio (percent)', exact: true })
    await volume.fill('50')
    await volume.press('Enter')
    await editor.getByText('Unsaved changes', { exact: true }).waitFor()
    if (leave === 'source') await editor.getByRole('button', { name: 'Shot 1', exact: true }).last().click()
    else if (leave === 'escape') {
      await editor.getByRole('group', { name: 'Preview', exact: true }).click({ position: { x: 10, y: 10 } })
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
    } else await editor.getByRole('button', { name: 'Close editor', exact: true }).click()
    const discard = editor.getByRole('button', { name: 'Close without saving', exact: true })
    await discard.waitFor()
    expect(await editor.getByRole('alert').getByText('The timeline document is invalid', { exact: true }).count()).toBe(1)
    const rejected = rejectedCommits
    await editor.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => rejectedCommits).toBeGreaterThan(rejected)
    await discard.click()
    await expect.poll(() => editor.count()).toBe(0)
    const after = (await nodes()).find(node => node.nodeId === nodeId)!
    expect(main(after).revision).toBe(main(before).revision)
    expect(document(after)).toEqual(document(before))
    rejectCommits = false
  })
})

