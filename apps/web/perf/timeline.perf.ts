import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { cpus, totalmem, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { CanvasOp, MediaTaskView, NodeView, TimelineDoc } from '@vis/protocol'
import { createFfmpegMedia, detectVideoEncoder, renderTimeline } from '../../../packages/assets/src/index'
import { createMockProvider } from '../../../packages/generation/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from '../e2e/platform'

/*
 * RFC 0024 §8 measurements. Run after `pnpm build`:
 *   pnpm --filter @vis/web perf
 * Environment:
 *   VIS_PERF_CPU_THROTTLE  Chrome CPU slowdown factor for the low-end approximation (e.g. 4)
 *   VIS_PERF_FFMPEG_DIR    directory holding the ffmpeg / ffprobe that studiod uses (e.g. an LGPL build); fixtures always use PATH ffmpeg
 *   VIS_PERF_OUT           report directory, default /tmp/vis-perf
 * Numbers go to a Markdown and JSON report; nothing here asserts a threshold.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url))
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const throttle = Number(process.env.VIS_PERF_CPU_THROTTLE ?? 1) || 1
const toolDir = process.env.VIS_PERF_FFMPEG_DIR
const executable = (name: string) => `${name}${process.platform === 'win32' ? '.exe' : ''}`
const paths = toolDir ? { ffmpegPath: join(toolDir, executable('ffmpeg')), ffprobePath: join(toolDir, executable('ffprobe')) } : {}
const outDir = process.env.VIS_PERF_OUT ?? '/tmp/vis-perf'
const label = `${toolDir ? 'lgpl' : 'path'}-cpu${throttle}`
const CLIP_MS = 6000
const SOURCES = 10

type Row = { metric: string; target: string; value: string; detail?: string }
const rows: Row[] = []
const raw: Record<string, unknown> = {}
const record = (metric: string, target: string, value: string, detail?: string, data?: unknown) => {
  rows.push({ metric, target, value, ...(detail ? { detail } : {}) })
  if (data !== undefined) raw[metric] = data
  console.log(`[perf] ${metric}: ${value}${detail ? ` (${detail})` : ''}`)
}

let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let cdp: CDPSession
let spaceId: string
let videoNodes: string[] = []
let musicNode: string
let musicVersion: string
let videoVersions: string[] = []
let textNode: string

const ms = (value: number) => `${Math.round(value)} ms`
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? NaN
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? NaN
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const mainSlot = (node: NodeView) => node.slots.find(slot => slot.slotKey === 'main')!
const docOf = (node: NodeView): TimelineDoc => {
  const content = mainSlot(node).content
  if (content.type !== 'timeline') throw new Error('Expected a timeline document')
  return content.doc
}

function fixtureFfmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-y', ...args], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
}

/** Busy 1080p30 H.264 + AAC stereo sources, close to provider output and far from the solid colours of unit tests. */
function makeFixtures() {
  const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' })
  const video = encoders.includes('libx264') ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'] : ['-c:v', 'h264_videotoolbox', '-b:v', '10M']
  const files: string[] = []
  for (let i = 0; i < SOURCES; i++) {
    const file = join(dir, `shot-${i}.mp4`)
    fixtureFfmpeg([
      '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=${CLIP_MS / 1000},hue=h=${i * 36},noise=alls=12:allf=t`,
      '-f', 'lavfi', '-i', `sine=frequency=${220 + i * 55}:sample_rate=48000:duration=${CLIP_MS / 1000}`,
      ...video, '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', file,
    ])
    files.push(file)
  }
  const music = join(dir, 'music.m4a')
  fixtureFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=196:sample_rate=44100:duration=180',
    '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.2:sample_rate=44100:duration=180',
    '-filter_complex', '[0][1]amix=inputs=2,volume=\'0.6+0.4*sin(2*PI*t/7)\':eval=frame,aformat=channel_layouts=stereo',
    '-c:a', 'aac', '-b:a', '192k', music,
  ])
  return { files, music }
}

async function register(path: string) {
  const media = createFfmpegMedia(paths)
  const info = await media.probe(path)
  const space = daemon.spaces.get(spaceId)!
  return space.assets.registerVersion(space.db, {
    staged: await space.assets.stageFile(path), kind: info.kind, mime: info.mime, origin: 'import',
    ...('width' in info && info.width ? { width: info.width, height: info.height } : {}),
    ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}),
    ...('fps' in info && info.fps !== undefined ? { fps: info.fps } : {}),
  }).assetVersionId
}

/** Builds a video-track document of `count` back-to-back clips cycling through the sources. */
async function timeline(title: string, count: number, opts: { fades?: boolean; music?: boolean } = {}) {
  const { idMap } = await apply([{ op: 'node.create', tempId: 'cut', kind: 'timeline', title, x: 1400, y: 40 + rows.length * 10, content: { timelineFrom: videoNodes.slice(0, Math.min(count, SOURCES)) } }])
  const node = (await nodes()).find(n => n.nodeId === idMap.cut)!
  const doc = structuredClone(docOf(node))
  const video = doc.tracks.find(track => track.kind === 'video')!
  const template = video.clips
  video.clips = Array.from({ length: count }, (_, i) => {
    const base = template[i % template.length]!
    const length = base.outMs - base.inMs
    return { ...base, id: crypto.randomUUID(), startMs: i * length, ...(opts.fades ? { fadeInMs: 300, fadeOutMs: 300 } : {}) }
  })
  if (opts.music) {
    const audio = doc.tracks.find(track => track.kind === 'audio') ?? (doc.tracks.push({ id: crypto.randomUUID(), kind: 'audio', muted: false, volume: 1, clips: [] }), doc.tracks.at(-1)!)
    audio.clips = [{ id: crypto.randomUUID(), source: { nodeId: musicNode, assetVersionId: musicVersion }, startMs: 0, inMs: 0, outMs: Math.min(180_000, count * CLIP_MS), volume: 0.8, fadeInMs: 0, fadeOutMs: 2000 }]
  }
  doc.output = { width: 1920, height: 1080, fps: 30 }
  await apply([{ op: 'timeline.set', slotId: mainSlot(node).slotId, expectedRevision: mainSlot(node).revision, doc }])
  return idMap.cut!
}

const card = (title: string) => page.getByRole('region', { name: new RegExp(`^Timeline ${title},`) })

async function openEditor(title: string) {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await card(title).getByText(/ clips · /).click()
  const editor = page.getByRole('dialog', { name: title, exact: true })
  const started = performance.now()
  await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
  await editor.getByRole('group', { name: 'Video', exact: true }).getByRole('button').first().waitFor({ timeout: 30_000 })
  // Two frames after the first clip appears: the editor has painted, not just mounted
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return { editor, openedMs: performance.now() - started }
}

async function closeEditor(title: string) {
  const editor = page.getByRole('dialog', { name: title, exact: true })
  await editor.getByRole('button', { name: 'Close editor', exact: true }).click()
  await editor.waitFor({ state: 'detached' })
}

async function seek(editor: ReturnType<Page['getByRole']>, timecode: string) {
  const position = editor.getByRole('textbox', { name: 'Playback position' })
  await position.fill(timecode)
  await position.press('Enter')
  await page.waitForTimeout(400)
}

/** Frame intervals and long tasks while `action` runs. */
async function frames(action: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { perfFrames: number[]; perfLong: number[]; perfOn: boolean; perfObserver?: PerformanceObserver }
    w.perfFrames = []
    w.perfLong = []
    w.perfOn = true
    let last = performance.now()
    const tick = (time: number) => {
      if (!w.perfOn) return
      w.perfFrames.push(time - last)
      last = time
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    w.perfObserver = new PerformanceObserver(list => { for (const entry of list.getEntries()) w.perfLong.push(entry.duration) })
    w.perfObserver.observe({ type: 'longtask' })
  })
  await action()
  const result = await page.evaluate(() => {
    const w = window as unknown as { perfFrames: number[]; perfLong: number[]; perfOn: boolean; perfObserver?: PerformanceObserver }
    w.perfOn = false
    w.perfObserver?.disconnect()
    return { frames: w.perfFrames.slice(1), long: w.perfLong }
  })
  const mean = result.frames.reduce((sum, value) => sum + value, 0) / Math.max(1, result.frames.length)
  return {
    count: result.frames.length, fps: 1000 / mean, p95: percentile(result.frames, 0.95), max: Math.max(0, ...result.frames),
    over16: result.frames.filter(value => value > 16.7 * 1.5).length, longTasks: result.long.length, longTotal: result.long.reduce((a, b) => a + b, 0),
  }
}

const framesText = (f: Awaited<ReturnType<typeof frames>>) => `${f.fps.toFixed(1)} fps, p95 ${f.p95.toFixed(1)} ms, max ${f.max.toFixed(0)} ms`
const framesDetail = (f: Awaited<ReturnType<typeof frames>>) => `${f.count} frames, ${f.over16} over 25 ms, ${f.longTasks} long tasks (${Math.round(f.longTotal)} ms)`

async function metrics() {
  const { metrics } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map(m => [m.name, m.value])) as Record<string, number>
}

/** Resident memory of this run's Chrome processes; Windows also reports committed private bytes, which exclude shared pages. */
function chromeMemory() {
  if (process.platform === 'win32') {
    // PrivatePageCount is committed private bytes, excluding shared pages; WorkingSetSize is resident memory including shared pages.
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount,CommandLine | ConvertTo-Json -Compress'
    const table = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      input: script, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024,
    })) as { ProcessId: number; ParentProcessId: number; WorkingSetSize: number; PrivatePageCount: number; CommandLine: string | null }[]
    const mine = new Set([process.pid])
    let grew = true
    while (grew) {
      grew = false
      for (const row of table) if (!mine.has(row.ProcessId) && mine.has(row.ParentProcessId)) { mine.add(row.ProcessId); grew = true }
    }
    const chrome = table.filter(row => mine.has(row.ProcessId) && /chrome.exe|msedge.exe/i.test(row.CommandLine ?? ''))
    const renderers = chrome.filter(row => row.CommandLine?.includes('--type=renderer'))
    return {
      rendererMax: Math.max(0, ...renderers.map(row => Number(row.WorkingSetSize))),
      rendererPrivateMax: Math.max(0, ...renderers.map(row => Number(row.PrivatePageCount))),
      total: chrome.reduce((sum, row) => sum + Number(row.WorkingSetSize), 0), processes: chrome.length,
      renderers: renderers.map(row => ({ pid: row.ProcessId, workingSet: Number(row.WorkingSetSize), privateBytes: Number(row.PrivatePageCount) })),
    }
  }
  const table = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(m => m !== null)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]) * 1024, command: m[4]! }))
  const mine = new Set<number>([process.pid])
  let grew = true
  while (grew) {
    grew = false
    for (const row of table) if (!mine.has(row.pid) && mine.has(row.ppid)) { mine.add(row.pid); grew = true }
  }
  const chrome = table.filter(row => mine.has(row.pid) && row.pid !== process.pid && /Chrome|chromium/i.test(row.command))
  const renderers = chrome.filter(row => row.command.includes('--type=renderer'))
  return { rendererMax: Math.max(0, ...renderers.map(row => row.rss)), rendererPrivateMax: undefined, total: chrome.reduce((sum, row) => sum + row.rss, 0), processes: chrome.length }
}

async function waitTask(task: MediaTaskView): Promise<MediaTaskView> {
  let current = task
  while (current.status === 'queued' || current.status === 'running') current = await admin.call('media.get', { taskId: current.taskId, waitMs: 30_000 })
  return current
}

async function exportTimeline(nodeId: string) {
  const node = (await nodes()).find(n => n.nodeId === nodeId)!
  const started = performance.now()
  const task = await admin.call('media.process', { requestId: crypto.randomUUID(), operation: 'timeline.export', nodeId, slotId: mainSlot(node).slotId, expectedRevision: mainSlot(node).revision, params: {}, waitMs: 30_000 })
  const done = await waitTask(task)
  if (done.status !== 'succeeded') throw new Error(`Export failed: ${JSON.stringify(done.error)}`)
  return performance.now() - started
}

describe.skipIf(!ready)('Timeline performance (RFC 0024 §8)', () => {
  beforeAll(async () => {
    mkdirSync(outDir, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-perf-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'perf', runtimes: {}, secretStore: createMemorySecretStore(), media: createFfmpegMedia(paths), providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } } })
    spaceId = daemon.spaces.create('Timeline performance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const started = performance.now()
    const { files, music } = makeFixtures()
    raw.fixtureMs = Math.round(performance.now() - started)
    videoVersions = await Promise.all(files.map(register))
    musicVersion = await register(music)
    const created = await apply([
      ...videoVersions.map((assetVersionId, i): CanvasOp => ({ op: 'node.create', tempId: `v${i}`, kind: 'video', title: `Shot ${i + 1}`, x: 40 + (i % 5) * 280, y: 40 + Math.floor(i / 5) * 200, w: 240, h: 135, content: { assetVersionId } })),
      { op: 'node.create', tempId: 'music', kind: 'audio', title: 'Score', x: 40, y: 480, w: 300, h: 140, content: { assetVersionId: musicVersion } },
      { op: 'node.create', tempId: 'note', kind: 'text', title: 'Notes', x: 400, y: 480, w: 240, h: 140, content: { text: 'Unrelated node an Agent keeps moving' } },
    ])
    videoNodes = videoVersions.map((_, i) => created.idMap[`v${i}`]!)
    musicNode = created.idMap.music!
    textNode = created.idMap.note!
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
    page.setDefaultTimeout(15_000)
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor({ timeout: 30_000 })
  })

  afterAll(async () => {
    const header = [
      `# Timeline performance — ${label}`, '',
      `- Date: ${new Date().toISOString()}`,
      `- Machine: ${cpus()[0]?.model ?? 'unknown'}, ${cpus().length} logical cores, ${Math.round(totalmem() / 2 ** 30)} GB, ${process.platform}`,
      `- Chrome CPU throttle: ${throttle}x; studiod ffmpeg: ${toolDir ?? 'PATH'}`,
      `- Fixtures: ${SOURCES} sources of 1080p30 H.264 + AAC, ${CLIP_MS / 1000} s each; 3 min AAC music`, '',
      '| Metric | Target | Measured | Detail |', '|---|---|---|---|',
      ...rows.map(row => `| ${row.metric} | ${row.target} | ${row.value} | ${row.detail ?? ''} |`), '',
    ]
    writeFileSync(join(outDir, `report-${label}.md`), header.join('\n'))
    writeFileSync(join(outDir, `report-${label}.json`), JSON.stringify({ label, rows, raw }, null, 2))
    console.log(`[perf] report: ${join(outDir, `report-${label}.md`)}`)
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('waveform and filmstrip previews', async () => {
    let started = performance.now()
    const peaks = await admin.call('media.preview', { assetVersionId: musicVersion, kind: 'peaks' })
    const first = performance.now() - started
    started = performance.now()
    await admin.call('media.preview', { assetVersionId: musicVersion, kind: 'peaks' })
    const cached = performance.now() - started
    record('Waveform, 3 min music, first / cached', '< 2 s / < 100 ms', `${ms(first)} / ${cached.toFixed(1)} ms`, `${peaks.kind === 'peaks' ? peaks.peaks.length : 0} peaks`)
    const strips: number[] = []
    for (const assetVersionId of videoVersions) {
      started = performance.now()
      await admin.call('media.preview', { assetVersionId, kind: 'filmstrip' })
      strips.push(performance.now() - started)
      await admin.call('media.preview', { assetVersionId, kind: 'peaks' })
    }
    record('Filmstrip, 6 s 1080p clip, first', '—', `median ${ms(median(strips))}`, `max ${ms(Math.max(...strips))}`, strips)
  })

  it('opens the editor with 50 clips', async () => {
    await timeline('Fifty', 50, { music: true })
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      const { openedMs } = await openEditor('Fifty')
      times.push(openedMs)
      await closeEditor('Fifty')
    }
    record('Open editor, 50 clips, caches warm', '< 500 ms', `median ${ms(median(times))}`, `runs ${times.map(t => Math.round(t)).join(', ')} ms; includes Playwright round trips`, times)
  })

  it('plays: first frame, clip switches and memory', async () => {
    const memory: Record<string, ReturnType<typeof chromeMemory> & { heap: number }> = {}
    const sample = async (stage: string) => { memory[stage] = { ...chromeMemory(), heap: (await metrics()).JSHeapUsedSize! } }
    await sample('canvas')
    const { editor } = await openEditor('Fifty')
    await page.waitForTimeout(1000)
    await sample('editor open')
    const preview = editor.getByRole('group', { name: 'Preview', exact: true })
    const firsts: number[] = []
    // Decimal seconds: the timecode field reads "00:04.50" as 4 s + 50 frames
    for (const at of ['0', '31', '73', '125', '260']) {
      await seek(editor, at)
      const latency = await preview.evaluate(element => new Promise<number | null>(resolve => {
        const videos = [...element.querySelectorAll('video')]
        const button = element.querySelector('button[aria-label="Play"]') as HTMLButtonElement
        const visible = videos.find(v => getComputedStyle(v).visibility === 'visible')
        const from = visible?.currentTime ?? 0
        const started = performance.now()
        const timer = setTimeout(() => resolve(null), 10_000)
        // A new frame, not the paused one already on screen: wait until media time moves past the start
        const watch = (video: HTMLVideoElement) => video.requestVideoFrameCallback((now, frame) => {
          if (getComputedStyle(video).visibility === 'visible' && !video.paused && (video !== visible || frame.mediaTime > from + 0.001)) { clearTimeout(timer); resolve(now - started) } else watch(video)
        })
        videos.forEach(watch)
        button.click()
      }))
      if (latency !== null) firsts.push(latency)
      await page.waitForTimeout(600)
      await editor.getByRole('button', { name: 'Pause', exact: true }).click()
    }
    record('Play to first frame', '< 300 ms', `median ${ms(median(firsts))}`, `max ${ms(Math.max(...firsts))}; ${5 - firsts.length} of 5 timed out`, firsts)

    // Cross clip boundaries at 6, 12 and 18 s and sample the visible picture every frame
    await seek(editor, '4.5')
    const sampled = await preview.evaluate(element => new Promise<{ frames: number; black: { at: number; position: string; reason: string }[] }>(resolve => {
      const canvas = document.createElement('canvas')
      canvas.width = 16
      canvas.height = 9
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      const button = element.querySelector('button[aria-label="Play"]') as HTMLButtonElement
      const position = element.querySelector('input[aria-label="Playback position"]') as HTMLInputElement
      const started = performance.now()
      let frames = 0
      const black: { at: number; position: string; reason: string }[] = []
      button.click()
      const tick = () => {
        const elapsed = performance.now() - started
        if (elapsed > 16_000) { resolve({ frames, black }); return }
        // Skip the start-up gap that "play to first frame" already measures
        if (elapsed > 400) {
          frames++
          const videos = [...element.querySelectorAll('video')]
          const video = videos.find(v => getComputedStyle(v).visibility === 'visible')
          let reason = !video ? 'none visible' : video.readyState < 2 ? `readyState ${video.readyState}` : ''
          if (!reason && video) {
            context.drawImage(video, 0, 0, 16, 9)
            const data = context.getImageData(0, 0, 16, 9).data
            let luma = 0
            for (let i = 0; i < data.length; i += 4) luma += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
            if (luma / (data.length / 4) < 10) reason = `dark at ${video.currentTime.toFixed(3)} s, seeking ${video.seeking}`
          }
          if (reason) black.push({ at: Math.round(elapsed), position: position?.value ?? '', reason })
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }))
    await editor.getByRole('button', { name: 'Pause', exact: true }).click()
    record('Clip switches during playback (3 boundaries, 16 s)', 'no black frames', `${sampled.black.length} black of ${sampled.frames}`,
      sampled.black.slice(0, 6).map(b => `${b.position} ${b.reason}`).join('; ') || undefined, sampled)
    await sample('after playback')
    await closeEditor('Fifty')
    await page.waitForTimeout(1000)
    await sample('editor closed')
    const mb = (bytes: number) => `${Math.round(bytes / 2 ** 20)} MB`
    const after = memory['after playback']!
    record('Memory with the editor open after playback', '< 500 MB renderer', `renderer ${process.platform === 'win32' ? 'working set' : 'RSS'} ${mb(after.rendererMax)}`,
      Object.entries(memory).map(([stage, m]) => `${stage}: renderer ${mb(m.rendererMax)}, heap ${mb(m.heap)}, all Chrome ${mb(m.total)}`).join('; '), memory)
    if (process.platform === 'win32') record('Renderer private bytes by stage', '< 500 MB renderer', `${mb(after.rendererPrivateMax ?? 0)} after playback`,
      Object.entries(memory).map(([stage, m]) => `${stage}: ${mb(m.rendererPrivateMax ?? 0)} private, ${mb(m.rendererMax)} working set`).join('; '))
  })

  it('drags, zooms and scrolls 200 clips', async () => {
    await timeline('Two hundred', 200, { music: true })
    const { editor } = await openEditor('Two hundred')
    const video = editor.getByRole('group', { name: 'Video', exact: true })
    const box = (await video.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const zoom = await frames(async () => {
      await page.keyboard.down('Control')
      for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, i < 20 ? 40 : -40); await page.waitForTimeout(16) }
      await page.keyboard.up('Control')
      await page.waitForTimeout(200)
    })
    record('Zoom timeline (Ctrl+wheel), 200 clips', '60 fps, frame < 16 ms', framesText(zoom), framesDetail(zoom), zoom)
    await editor.getByRole('button', { name: 'Fit', exact: true }).click()
    await page.keyboard.down('Control')
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -60)
    await page.keyboard.up('Control')
    await page.waitForTimeout(300)
    const scroll = await frames(async () => {
      await page.keyboard.down('Shift')
      for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(16) }
      await page.keyboard.up('Shift')
      await page.waitForTimeout(200)
    })
    record('Scroll timeline (Shift+wheel), 200 clips', '60 fps, frame < 16 ms', framesText(scroll), framesDetail(scroll), scroll)
    const clip = (await video.getByRole('button').nth(2).boundingBox())!
    const drag = await frames(async () => {
      await page.mouse.move(clip.x + clip.width / 2, clip.y + clip.height / 2)
      await page.mouse.down()
      for (let i = 1; i <= 60; i++) { await page.mouse.move(clip.x + clip.width / 2 + i * 6, clip.y + clip.height / 2); await page.waitForTimeout(16) }
      await page.mouse.up()
      await page.waitForTimeout(300)
    })
    record('Drag a clip, 200 clips', '60 fps, frame < 16 ms', framesText(drag), framesDetail(drag), drag)
  })

  it('measures editor host invalidation by unrelated canvas events', async () => {
    // Still in "Two hundred". Each persisted canvas event hands the editor host a new nodes array (RFC 0024c leftovers).
    // The same events with the editor closed separate the editor's share from the rest of the app.
    const measure = async (action: () => Promise<void>) => {
      const before = await metrics()
      const f = await frames(action)
      const after = await metrics()
      return { taskMs: (after.TaskDuration! - before.TaskDuration!) * 1000, scriptMs: (after.ScriptDuration! - before.ScriptDuration!) * 1000, frames: f }
    }
    const events = 20
    const cost = async () => {
      await page.waitForTimeout(1000)
      const idle = await measure(() => page.waitForTimeout(6000))
      const busy = await measure(async () => {
        for (let i = 0; i < events; i++) {
          await apply([{ op: 'node.layout', nodeId: textNode, x: 400 + (i % 2) * 40 }])
          await page.waitForTimeout(300)
        }
      })
      const scale = busy.frames.count / Math.max(1, idle.frames.count)
      const perEvent = (busy.taskMs - idle.taskMs * scale) / events
      const scriptPerEvent = (busy.scriptMs - idle.scriptMs * scale) / events
      return { perEvent, scriptPerEvent, idle, busy }
    }
    const open = await cost()
    await closeEditor('Two hundred')
    const closed = await cost()
    const detail = (c: typeof open) => `idle 6 s ${Math.round(c.idle.taskMs)} ms, ${events} events ${Math.round(c.busy.taskMs)} ms (script ${Math.round(c.busy.scriptMs)} ms), max frame ${c.busy.frames.max.toFixed(0)} ms`
    record('Main-thread cost per unrelated canvas event, editor open (200 clips)', 'measure first', `${open.perEvent.toFixed(1)} ms per event`, detail(open), open)
    record('Main-thread cost per unrelated canvas event, editor closed', 'measure first', `${closed.perEvent.toFixed(1)} ms per event`, `editor share ≈ ${(open.perEvent - closed.perEvent).toFixed(1)} ms; ${detail(closed)}`, closed)
    // Script time isolates the editor's own rendering; total task time also carries style and layout of the larger page and is noisier
    record('Script cost per unrelated canvas event, editor open / closed', 'measure first', `${open.scriptPerEvent.toFixed(1)} / ${closed.scriptPerEvent.toFixed(1)} ms per event`, `editor script share ≈ ${(open.scriptPerEvent - closed.scriptPerEvent).toFixed(1)} ms`)
  })

  it('exports', async () => {
    const encoder = await detectVideoEncoder(paths)
    raw.encoder = encoder.name
    const copyId = await timeline('Copy ten', 10)
    const copyMs = await exportTimeline(copyId)
    record('Export, stream copy, 10 clips', '< 5 s', ms(copyMs))
    const encodeId = await timeline('Encode minute', 10, { fades: true, music: true })
    const encodeMs = await exportTimeline(encodeId)
    record('Export, re-encode 1 min 1080p30', 'hardware ≥ realtime', ms(encodeMs), `${(60_000 / encodeMs).toFixed(2)}x realtime with ${encoder.name}`)
  })

  it.skipIf(!toolDir)('LGPL build: software fallback is libopenh264 and it exports', async () => {
    const listed = execFileSync(paths.ffmpegPath!, ['-hide_banner', '-encoders'], { encoding: 'utf8' })
    const config = execFileSync(paths.ffmpegPath!, ['-hide_banner', '-buildconf'], { encoding: 'utf8' })
    // Detection is cached per executable path, so a distinct spelling of the same path gives a fresh trial; 'linux' has no listed hardware encoder here
    const fallback = await detectVideoEncoder({ ffmpegPath: `${toolDir}/./${executable('ffmpeg')}`, platform: 'linux' })
    const node = (await nodes()).find(n => n.title === 'Encode minute')!
    const doc = docOf(node)
    const space = daemon.spaces.get(spaceId)!
    const sources = new Map(doc.tracks.flatMap(track => track.clips).map(clip => {
      const version = space.assets.getVersion(space.db, clip.source.assetVersionId)!
      return [clip.source.assetVersionId, { kind: version.kind as 'video' | 'audio', path: space.assets.blobPath(version.blobHash), ...(version.durationMs ? { durationMs: version.durationMs } : {}), ...(version.width ? { width: version.width, height: version.height! } : {}) }] as const
    }))
    const started = performance.now()
    const rendered = await renderTimeline(doc, sources, { encoder: fallback, ...paths })
    const elapsed = performance.now() - started
    const codec = execFileSync(paths.ffprobePath!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', rendered.path], { encoding: 'utf8' }).trim()
    record('LGPL ffmpeg: software encoder fallback', 'libopenh264, no libx264', `${fallback.name}; ${codec}`,
      `gpl=${config.includes('--enable-gpl')}, libx264 listed=${/\slibx264\s/.test(listed)}, 1 min export ${ms(elapsed)} (${(60_000 / elapsed).toFixed(2)}x realtime)`)
  })

  it('studiod idle CPU', async () => {
    await page.waitForTimeout(3000)
    const before = process.cpuUsage()
    const started = performance.now()
    await new Promise(resolve => setTimeout(resolve, 10_000))
    const used = process.cpuUsage(before)
    const percent = (used.user + used.system) / 1000 / (performance.now() - started) * 100
    record('studiod idle CPU (10 s, page open)', '≈ 0', `${percent.toFixed(2)} % of one core`, 'same process also runs the web host and the Playwright client, so this is an upper bound')
  })
})
