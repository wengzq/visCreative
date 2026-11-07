import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { timelineDurationMs, type CanvasOp, type NodeView, type TimelineDoc, type WorkItemView } from '@vis/protocol'
import { newId } from '../../../packages/domain/src/index'
import { createMockProvider } from '../../../packages/generation/src/index'
import { eq, spaceSchema as s } from '../../../packages/storage/src/index'
import { issueAgentToken } from '../../../services/studiod/src/auth'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = join(root, 'apps/cli/dist/vis.mjs')
const ready = existsSync(chromePath()) && existsSync(cli) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const screenshots = join(tmpdir(), 'vis-0024d-D1')
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let spaceId: string
let videoAsset: string
let imageAsset: string
let worker: WorkItemView
let agentAttempt: { code: number; out: unknown } | undefined
let agentFailure: string | undefined
const errors: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const main = (node: NodeView) => node.slots.find(slot => slot.slotKey === 'main')!
function document(node: NodeView): TimelineDoc {
  const content = main(node).content
  if (content.type !== 'timeline') throw new Error('Expected a timeline document')
  return content.doc
}

describe.skipIf(!ready)('Timeline speed and transitions', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-timeline-speed-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'timeline-speed-e2e', secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { video: { provider: 'mock' } },
      // The scripted Agent uses the built CLI and a real gateway-bound turn, as cli.e2e.test.ts does.
      runtimes: { codex: ({ spaceId, db, report }) => ({
        async agentOptions() { return [] },
        async ensureReady() {},
        async terminateTurn() {}, async interruptTurn() {},
        async dispatchTurn(input) {
          const { token, tokenHash } = issueAgentToken(spaceId)
          const instanceId = newId('agentInstance')
          db.insert(s.agentInstances).values({ id: instanceId, sessionId: input.sessionId, status: 'ready', tokenHash, startedAt: Date.now() }).run()
          db.update(s.turns).set({ instanceId }).where(eq(s.turns.id, input.turnId)).run()
          const vis = (...args: string[]) => new Promise<{ code: number; out: unknown }>((resolve, reject) => {
            execFile(process.execPath, [cli, ...args], { shell: false, windowsHide: true, env: { ...process.env, VIS_SOCKET: daemon.socketPath, VIS_AGENT_TOKEN: token } }, (error, stdout) => {
              try { resolve({ code: error ? 1 : 0, out: JSON.parse(stdout.trim().split('\n').at(-1)!) }) } catch (failure) { reject(failure) }
            })
          })
          void (async () => {
            try {
              const snapshot = await vis('canvas', 'get')
              const node = (snapshot.out as { nodes: NodeView[] }).nodes.find(node => node.title === 'Image speed guard')!
              const doc = document(node)
              doc.tracks[0]!.clips[0]!.speed = 2
              agentAttempt = await vis('canvas', 'apply', '--params', JSON.stringify({
                requestId: crypto.randomUUID(), ops: [{ op: 'timeline.set', slotId: main(node).slotId, expectedRevision: main(node).revision, doc }],
              }))
            } catch (failure) { agentFailure = String(failure) }
            finally {
              db.update(s.agentInstances).set({ status: 'exited', exitedAt: Date.now() }).where(eq(s.agentInstances.id, instanceId)).run()
              report({ type: 'turn_ended', sessionId: input.sessionId, turnId: input.turnId, status: agentFailure ? 'failed' : 'completed' })
            }
          })()
        },
      }) },
    })
    spaceId = daemon.spaces.create('Speed and transitions acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const video = join(dir, 'shot with audio.webm')
    const image = join(dir, 'still.png')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-ac', '2', video], { shell: false, windowsHide: true })
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:size=160x90', '-frames:v', '1', image], { shell: false, windowsHide: true })
    const space = daemon.spaces.get(spaceId)!
    videoAsset = space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(video), kind: 'video', mime: 'video/webm', origin: 'import', width: 160, height: 90, durationMs: 2000, fps: 30 }).assetVersionId
    imageAsset = space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(image), kind: 'image', mime: 'image/png', origin: 'import', width: 160, height: 90 }).assetVersionId
    worker = (await admin.call('work.create', { requestId: crypto.randomUUID(), title: 'Speed validation', chat: { agentKind: 'codex' } })).item
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor()
  })
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(screenshots, 'failure.png'), animations: 'disabled' })
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('edits speed and crossfades, undoes and redoes both edits, previews and exports their timeline duration', async () => {
    const media = await apply([1, 2, 3].map(index => ({
      op: 'node.create', tempId: `shot${index}`, kind: 'video', title: `Speed shot ${index}`,
      x: 40, y: 40 + index * 180, content: { assetVersionId: videoAsset },
    })))
    const created = await apply([{ op: 'node.create', tempId: 'cut', kind: 'timeline', title: 'Speed cut', x: 700, y: 160, content: { timelineFrom: [media.idMap.shot1!, media.idMap.shot2!, media.idMap.shot3!] } }])
    const liveNode = async () => (await nodes()).find(node => node.nodeId === created.idMap.cut)!
    const liveDoc = async () => document(await liveNode())
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    const card = page.getByRole('region', { name: /^Timeline Speed cut,/ })
    await card.getByText('3 clips · 00:06', { exact: true }).click()
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Speed cut', exact: true })
    const lane = editor.getByRole('group', { name: 'Video', exact: true })
    const second = lane.getByRole('button', { name: /^Speed shot 2,/ })
    await second.click()
    await editor.getByRole('button', { name: '2×', exact: true }).click()
    await expect.poll(() => second.getByText('2×', { exact: true }).count()).toBe(1)
    await expect.poll(async () => (await liveDoc()).tracks[0]!.clips.map(clip => clip.startMs)).toEqual([0, 2000, 3000])
    await expect.poll(async () => timelineDurationMs(await liveDoc())).toBe(5000)
    await expect.poll(() => editor.locator('header').getByRole('button', { name: 'Output settings', exact: true }).textContent()).toContain('00:05.00')
    const cut = lane.getByRole('button', { name: 'Transition: clips 1 → 2', exact: true })
    await cut.focus()
    await page.keyboard.press('Space')
    const popover = editor.getByRole('dialog', { name: 'Transition', exact: true })
    await popover.waitFor()
    expect(await popover.getByRole('spinbutton', { name: 'Transition duration (milliseconds)' }).inputValue()).toBe('500')
    await popover.getByRole('button', { name: 'Crossfade', exact: true }).click()
    await expect.poll(async () => timelineDurationMs(await liveDoc())).toBe(4500)
    await expect.poll(() => lane.getByRole('img', { name: 'Transition overlap' }).count()).toBe(1)
    await page.keyboard.press('Escape')
    await expect.poll(() => popover.count()).toBe(0)
    expect(await cut.evaluate(element => element === globalThis.document.activeElement)).toBe(true)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => timelineDurationMs(await liveDoc())).toBe(5000)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => timelineDurationMs(await liveDoc())).toBe(6000)
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(async () => timelineDurationMs(await liveDoc())).toBe(5000)
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(async () => timelineDurationMs(await liveDoc())).toBe(4500)
    const position = editor.getByRole('textbox', { name: 'Playback position', exact: true })
    await position.fill('1.75')
    await position.press('Enter')
    await expect.poll(() => editor.getByRole('group', { name: 'Preview', exact: true }).evaluate(element => [...element.querySelectorAll('video')].filter(video => getComputedStyle(video).visibility === 'visible').map(video => ({
      ready: video.readyState >= 2, opacity: Number(video.style.opacity), speed: video.playbackRate, pitch: video.preservesPitch,
    })))).toEqual([{ ready: true, opacity: 0.5, speed: 1, pitch: true }, { ready: true, opacity: 0.5, speed: 2, pitch: true }])
    await page.screenshot({ path: join(screenshots, 'speed-crossfade.png'), animations: 'disabled' })
    await editor.getByRole('button', { name: 'Export', exact: true }).click()
    await editor.getByText('Exported', { exact: true }).waitFor({ timeout: 20_000 })
    const exported = (await nodes()).find(node => node.exportOf?.timelineNodeId === created.idMap.cut)!
    expect(exported.kind).toBe('video')
    const asset = main(exported).content
    if (asset.type !== 'asset') throw new Error('Expected an exported asset')
    const space = daemon.spaces.get(spaceId)!
    const version = space.assets.getVersion(space.db, asset.assetVersionId)!
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', space.assets.blobPath(version.blobHash)], { encoding: 'utf8', shell: false, windowsHide: true }))
    const committed = await liveDoc()
    expect(committed.tracks[0]!.clips[1]).toMatchObject({ speed: 2, transitionIn: { kind: 'crossfade', durationMs: 500 } })
    expect(Math.abs(Number(info.format.duration) * 1000 - timelineDurationMs(committed))).toBeLessThanOrEqual(1000 / 30)
    expect(info.streams).toMatchObject([{ codec_type: 'video' }, { codec_name: 'aac', channels: 2 }])
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click()
    await expect.poll(() => editor.count()).toBe(0)
    expect(errors).toEqual([])
  }, 60_000)

  it('rejects image speed through UI and Agent timeline.set and leaves the committed document unchanged', async () => {
    const created = await apply([{ op: 'node.create', tempId: 'image', kind: 'image', title: 'Speed image', x: 0, y: 0, content: { assetVersionId: imageAsset } }])
    const cut = await apply([{ op: 'node.create', tempId: 'imageCut', kind: 'timeline', title: 'Image speed guard', content: { timelineFrom: [created.idMap.image!] } }])
    const node = (await nodes()).find(node => node.nodeId === cut.idMap.imageCut)!
    const invalid = document(node)
    invalid.tracks[0]!.clips[0]!.speed = 2
    await expect(apply([{ op: 'timeline.set', slotId: main(node).slotId, expectedRevision: main(node).revision, doc: invalid }])).rejects.toMatchObject({ code: 'invalid_params', data: { reason: 'timeline.speed_image' } })
    await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId: worker.sessions[0]!.sessionId, text: 'timeline-speed-image', refs: [] })
    await expect.poll(() => agentAttempt ?? agentFailure, { timeout: 15_000 }).toMatchObject({ code: 1, out: { error: { code: 'invalid_params', reason: 'timeline.speed_image' } } })
    expect(document((await nodes()).find(current => current.nodeId === node.nodeId)!)).not.toEqual(invalid)
  })
})
