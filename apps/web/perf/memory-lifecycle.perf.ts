import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { cpus, totalmem, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { CanvasOp, NodeView, TimelineDoc } from '@vis/protocol'
import { createFfmpegMedia } from '../../../packages/assets/src/index'
import { createMockProvider } from '../../../packages/generation/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from '../e2e/platform'
import { heapSnapshot, mib, physicalMemory } from './memory-tools'

/*
 * RFC 0024e M. Run after pnpm build:
 *   pnpm --filter @vis/web perf memory-lifecycle
 * Typecheck the standalone perf harness: pnpm --filter @vis/web exec tsc -p perf
 * Four isolated runs (three at 1x, one at 4x), five same-page cycles, metadata
 * probe interventions, and 16 simultaneous-decode cases.
 * VIS_PERF_MEMORY_ONLY=lifecycle|decode|retention selects one experiment. Reports and raw
 * snapshots go to VIS_PERF_OUT (default /tmp/vis-perf), never to the repository.
 * Heap snapshots force GC: collect them in a SECOND cycle after timed samples.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url))
const ready = process.platform === 'darwin' && existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const out = join(process.env.VIS_PERF_OUT ?? '/tmp/vis-perf', `memory-${new Date().toISOString().replaceAll(':', '-')}`)
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let spaceId: string
let browser: Browser | undefined
let decode720: string
let decode1080: string
const lifecycle: Record<string, unknown>[] = []
const decode: Record<string, unknown>[] = []
const retention: Record<string, unknown>[] = []
const probes: Record<string, unknown>[] = []
const lifecycleRows: string[] = []
const decodeRows: string[] = []
const retentionRows: string[] = []
const probeRows: string[] = []
const only = process.env.VIS_PERF_MEMORY_ONLY
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-y', ...args], { stdio: 'pipe' })

async function register(path: string) {
  const info = await createFfmpegMedia().probe(path)
  const space = daemon.spaces.get(spaceId)!
  return space.assets.registerVersion(space.db, {
    staged: await space.assets.stageFile(path), kind: info.kind, mime: info.mime, origin: 'import',
    ...('width' in info && info.width ? { width: info.width, height: info.height } : {}),
    ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}),
    ...('fps' in info && info.fps !== undefined ? { fps: info.fps } : {}),
  }).assetVersionId
}

async function freshBrowser(rate: number) {
  await browser?.close()
  browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
  page.setDefaultTimeout(30_000)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('Emulation.setCPUThrottlingRate', { rate })
  return { page, cdp, browserCdp: await browser.newBrowserCDPSession() }
}

async function open(page: Page) {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.getByRole('region', { name: /^Timeline Memory cut,/ }).getByText(/ clips · /).click()
  await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Memory cut', exact: true })
  await editor.getByRole('group', { name: 'Video', exact: true }).getByRole('button').first().waitFor()
  // Cached CSS images may not create a new resource-timing entry after reload.
  await page.waitForFunction(() => new Set([...document.querySelectorAll<HTMLElement>('[role="dialog"] [style]')]
    .map(element => element.style.backgroundImage).filter(url => url.includes('/filmstrip?'))).size === 10)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForLoadState('networkidle')
  return editor
}

async function play(page: Page) {
  const editor = page.getByRole('dialog', { name: 'Memory cut', exact: true })
  await editor.getByRole('button', { name: 'Play', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => !video.paused && video.currentTime > 0.2))
  await page.waitForTimeout(16_000)
  await editor.getByRole('button', { name: 'Pause', exact: true }).click()
}

async function close(page: Page) {
  const editor = page.getByRole('dialog', { name: 'Memory cut', exact: true })
  await editor.getByRole('button', { name: 'Close editor', exact: true }).click()
  await editor.waitFor({ state: 'detached' })
}

async function sample(page: Page, cdp: CDPSession, browserCdp: CDPSession, directory: string, label: string, closedAt?: number) {
  const elapsedMs = closedAt === undefined ? undefined : performance.now() - closedAt
  const memory = await physicalMemory(browserCdp, directory, label)
  const { metrics } = await cdp.send('Performance.getMetrics')
  const metricsByName = Object.fromEntries(metrics.map(metric => [metric.name, metric.value]))
  const dom = await page.evaluate(() => ({ videos: document.querySelectorAll('video').length, images: document.querySelectorAll('img').length }))
  const result = { label, elapsedMs, ...memory, heap: metricsByName.JSHeapUsedSize, nodes: metricsByName.Nodes, dom }
  console.log(`[memory] ${label}: renderer ${mib(memory.renderer)} MiB, GPU ${mib(memory.gpu)} MiB`)
  return result
}

describe.skipIf(!ready)('Memory lifecycle and simultaneous video decode (RFC 0024e M)', () => {
  beforeAll(async () => {
    mkdirSync(out, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-memory-lifecycle-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'memory', runtimes: {}, secretStore: createMemorySecretStore(), media: createFfmpegMedia(), providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } } })
    spaceId = daemon.spaces.create('Memory investigation').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const versions: string[] = []
    for (let i = 0; i < 10; i++) {
      const path = join(dir, `shot-${i}.mp4`)
      ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=6,hue=h=${i * 36},noise=alls=12:allf=t`, '-f', 'lavfi', '-i', `sine=frequency=${220 + i * 55}:sample_rate=48000:duration=6`, '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-ac', '2', '-shortest', '-movflags', '+faststart', path])
      versions.push(await register(path))
    }
    decode1080 = versions[0]!
    const small = join(dir, '720.mp4')
    ffmpeg(['-i', join(dir, 'shot-0.mp4'), '-vf', 'scale=1280:720', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '20', '-g', '30', '-an', '-movflags', '+faststart', small])
    decode720 = await register(small)
    const music = join(dir, 'score.m4a')
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=196:sample_rate=44100:duration=180', '-c:a', 'aac', '-ac', '2', music])
    const musicVersion = await register(music)
    const { idMap } = await apply([
      ...versions.map((assetVersionId, i): CanvasOp => ({ op: 'node.create', tempId: `v${i}`, kind: 'video', title: `Shot ${i + 1}`, x: 40 + i % 5 * 280, y: 40 + Math.floor(i / 5) * 200, w: 240, h: 135, content: { assetVersionId } })),
      { op: 'node.create', tempId: 'music', kind: 'audio', title: 'Score', x: 40, y: 480, w: 300, h: 140, content: { assetVersionId: musicVersion } },
    ])
    const created = await apply([{ op: 'node.create', tempId: 'cut', kind: 'timeline', title: 'Memory cut', x: 1500, y: 40, content: { timelineFrom: versions.map((_, i) => idMap[`v${i}`]!) } }])
    const node = ((await admin.call('canvas.get', {})).nodes as NodeView[]).find(node => node.nodeId === created.idMap.cut)!
    const slot = node.slots.find(slot => slot.slotKey === 'main')!
    if (slot.content.type !== 'timeline') throw new Error('Expected a timeline')
    const doc: TimelineDoc = structuredClone(slot.content.doc)
    const video = doc.tracks.find(track => track.kind === 'video')!
    const template = video.clips
    video.clips = Array.from({ length: 50 }, (_, i) => ({ ...template[i % template.length]!, id: crypto.randomUUID(), startMs: i * 6000 }))
    doc.tracks.push({ id: crypto.randomUUID(), kind: 'audio', muted: false, volume: 1, clips: [{ id: crypto.randomUUID(), source: { nodeId: idMap.music!, assetVersionId: musicVersion }, startMs: 0, inMs: 0, outMs: 180_000, volume: 0.8, fadeInMs: 0, fadeOutMs: 2000 }] })
    doc.output = { width: 1920, height: 1080, fps: 30 }
    await apply([{ op: 'timeline.set', slotId: slot.slotId, expectedRevision: slot.revision, doc }])
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    writeFileSync(join(out, 'environment.json'), JSON.stringify({ date: new Date().toISOString(), cpu: cpus()[0]?.model, cores: cpus().length, totalMemory: totalmem(), chrome: execFileSync(chromePath(), ['--version'], { encoding: 'utf8' }).trim(), ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0], fixture: '10 busy 6s 1080p30 H.264/AAC sources, 50 clips, 180s music; DSF 2; decode loops a 6s source for 30s' }, null, 2))
  })

  afterAll(async () => {
    writeFileSync(join(out, 'results.json'), JSON.stringify({ lifecycle, decode, retention, probes }, null, 2))
    writeFileSync(join(out, 'report.md'), [
      '# RFC 0024e M memory measurements', '',
      'Physical footprint from macOS footprint, MiB (not RSS). Renderer sums all renderer PIDs in this isolated browser. See environment.json, per-stage raw footprint files, heap snapshots and per-case results.json.', '',
      'CPU throttling does not emulate 8 GB memory pressure or weaker hardware decoders. Timed lifecycle samples precede the separate heap-snapshot cycle, because heap snapshots trigger GC.', '',
      '| Run | CPU | Stage | Seconds since close | Renderer MiB | GPU MiB | JS heap MiB |',
      '|---|---|---|---|---|---|---|', ...lifecycleRows, '',
      '| Resolution | Videos | CPU | Renderer MiB | GPU MiB | Delta renderer / GPU MiB | Dropped / total frames | Long tasks / total ms / max ms |',
      '|---|---|---|---|---|---|---|---|', ...decodeRows, '',
      '| Repeated cycle | Stage | Renderer MiB | GPU MiB | JS heap MiB |',
      '|---|---|---|---|---|', ...retentionRows, '',
      '| Metadata probe case | Suppressed / early released | Renderer MiB | GPU MiB |',
      '|---|---|---|---|', ...probeRows, '',
    ].join('\n'))
    console.log(`[memory] reports: ${out}`)
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  for (const [index, rate] of [1, 1, 1, 4].entries()) it.skipIf(only !== undefined && only !== 'lifecycle')(`lifecycle run ${index + 1}, CPU ${rate}x`, async () => {
    const directory = join(out, `lifecycle-${index + 1}-cpu${rate}`)
    mkdirSync(directory)
    const { page, cdp, browserCdp } = await freshBrowser(rate)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.mouse.move(1590, 990)
    await page.waitForFunction(() => {
      const posters = [...document.querySelectorAll<HTMLImageElement>('.vis-video-poster')]
      return posters.length === 10 && posters.every(image => image.complete && image.naturalWidth > 0)
    })
    await page.waitForTimeout(3500)
    const samples = [await sample(page, cdp, browserCdp, directory, 'canvas')]
    await open(page)
    samples.push(await sample(page, cdp, browserCdp, directory, 'editor-open'))
    await play(page)
    samples.push(await sample(page, cdp, browserCdp, directory, 'after-playback'))
    await close(page)
    const closedAt = performance.now()
    for (const seconds of [1, 10, 30]) {
      await page.waitForTimeout(Math.max(0, seconds * 1000 - (performance.now() - closedAt)))
      samples.push(await sample(page, cdp, browserCdp, directory, `closed-${seconds}s`, closedAt))
    }
    await cdp.send('HeapProfiler.collectGarbage')
    samples.push(await sample(page, cdp, browserCdp, directory, 'forced-gc', closedAt))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor()
    await page.waitForTimeout(3500)
    samples.push(await sample(page, cdp, browserCdp, directory, 'reload'))
    writeFileSync(join(directory, 'timed-results.json'), JSON.stringify({ run: index + 1, rate, samples }, null, 2))

    // Observe context lifecycle events without keeping JS context wrappers alive.
    const audioEvents: unknown[] = []
    for (const name of ['contextCreated', 'contextChanged', 'contextWillBeDestroyed'] as const) cdp.on(`WebAudio.${name}`, event => audioEvents.push({ name, event }))
    await cdp.send('WebAudio.enable')
    await page.evaluate(() => {
      const active = new Set<string>()
      const create = URL.createObjectURL.bind(URL)
      const revoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = object => { const url = create(object); active.add(url); return url }
      URL.revokeObjectURL = url => { active.delete(url); revoke(url) }
      Object.assign(window, { memoryObjectUrls: () => active.size })
    })
    const heaps: Record<string, unknown> = {}
    heaps.canvas = await heapSnapshot(cdp, directory, 'heap-canvas')
    await open(page)
    heaps.open = await heapSnapshot(cdp, directory, 'heap-open')
    await play(page)
    heaps.played = await heapSnapshot(cdp, directory, 'heap-played')
    await close(page)
    await page.waitForTimeout(1000)
    heaps.closed = await heapSnapshot(cdp, directory, 'heap-closed')
    const urls = await page.evaluate(() => (window as unknown as { memoryObjectUrls(): number }).memoryObjectUrls())
    lifecycle.push({ run: index + 1, rate, samples, heaps, audioEvents, activeObjectUrlsAfterClose: urls })
    for (const result of samples) lifecycleRows.push(`| ${index + 1} | ${rate}x | ${result.label} | ${result.elapsedMs === undefined ? '' : (result.elapsedMs / 1000).toFixed(2)} | ${mib(result.renderer)} | ${mib(result.gpu)} | ${mib(result.heap ?? 0)} |`)
    writeFileSync(join(directory, 'results.json'), JSON.stringify(lifecycle.at(-1), null, 2))
    await browser!.close()
    browser = undefined
  })

  it.skipIf(only !== undefined && only !== 'retention')('retention across five open/play/close cycles in one page', async () => {
    const directory = join(out, 'retention-five-cycles')
    mkdirSync(directory)
    const { page, cdp, browserCdp } = await freshBrowser(1)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor()
    await page.waitForTimeout(3500)
    await cdp.send('HeapProfiler.collectGarbage')
    const baseline = await sample(page, cdp, browserCdp, directory, 'baseline')
    retention.push({ cycle: 0, samples: [baseline] })
    for (let cycle = 1; cycle <= 5; cycle++) {
      await open(page)
      await play(page)
      await close(page)
      const closedAt = performance.now()
      await page.waitForTimeout(30_000)
      const closed = await sample(page, cdp, browserCdp, directory, `cycle-${cycle}-closed-30s`, closedAt)
      await cdp.send('HeapProfiler.collectGarbage')
      const gc = await sample(page, cdp, browserCdp, directory, `cycle-${cycle}-forced-gc`, closedAt)
      retention.push({ cycle, samples: [closed, gc] })
      for (const result of [closed, gc]) retentionRows.push(`| ${cycle} | ${result.label} | ${mib(result.renderer)} | ${mib(result.gpu)} | ${mib(result.heap ?? 0)} |`)
      writeFileSync(join(directory, 'results.json'), JSON.stringify(retention, null, 2))
    }
    await heapSnapshot(cdp, directory, 'after-five-cycles')
    await cdp.send('Memory.simulatePressureNotification', { level: 'critical' })
    await page.waitForTimeout(1000)
    const pressure = await sample(page, cdp, browserCdp, directory, 'after-critical-memory-pressure')
    retention.push({ pressure })
    writeFileSync(join(directory, 'results.json'), JSON.stringify(retention, null, 2))
    await browser!.close()
    browser = undefined
  })

  for (const mode of ['normal', 'suppressed', 'released']) it.skipIf(only !== undefined && only !== 'retention')(`canvas metadata-video probes ${mode}`, async () => {
    const directory = join(out, `metadata-probes-${mode}`)
    mkdirSync(directory)
    const { page, cdp, browserCdp } = await freshBrowser(1)
    await page.addInitScript(mode => {
      let count = 0
      let released = 0
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        ...descriptor,
        set(this: HTMLMediaElement, value: string) {
          const probe = this instanceof HTMLVideoElement && !this.isConnected && this.preload === 'metadata'
          if (mode === 'suppressed' && probe) { count++; return }
          if (mode === 'released' && probe) {
            const element = this
            const release = () => {
              element.removeEventListener('loadedmetadata', release)
              element.removeEventListener('error', release)
              released++
              element.removeAttribute('src')
              element.load()
            }
            // NodeTitle's metadata reader was registered before this src setter.
            element.addEventListener('loadedmetadata', release)
            element.addEventListener('error', release)
          }
          descriptor.set!.call(this, value)
        },
      })
      Object.assign(window, { memoryProbeCounts: () => ({ suppressed: count, released }) })
    }, mode)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.mouse.move(1590, 990)
    await page.waitForFunction(() => {
      const posters = [...document.querySelectorAll<HTMLImageElement>('.vis-video-poster')]
      return posters.length === 10 && posters.every(image => image.complete && image.naturalWidth > 0)
    })
    await page.waitForTimeout(10_000)
    await cdp.send('HeapProfiler.collectGarbage')
    const memory = await sample(page, cdp, browserCdp, directory, 'canvas')
    const heap = await heapSnapshot(cdp, directory, 'canvas')
    const counts = await page.evaluate(() => (window as unknown as { memoryProbeCounts(): { suppressed: number; released: number } }).memoryProbeCounts())
    const metadataLabels = await page.locator('.vis-node-metadata').allTextContents()
    probes.push({ mode, counts, memory, heap, metadataLabels })
    probeRows.push(`| ${mode} | ${counts.suppressed} / ${counts.released} | ${mib(memory.renderer)} | ${mib(memory.gpu)} |`)
    writeFileSync(join(directory, 'results.json'), JSON.stringify(probes.at(-1), null, 2))
    await browser!.close()
    browser = undefined
  })

  for (const rate of [1, 4]) for (const height of [1080, 720]) for (const count of [1, 2, 3, 4]) it.skipIf(only !== undefined && only !== 'decode')(`decode ${height}p, ${count} videos, CPU ${rate}x`, async () => {
    const directory = join(out, `decode-${height}p-${count}-cpu${rate}`)
    mkdirSync(directory)
    const { page, cdp, browserCdp } = await freshBrowser(rate)
    const mediaEvents: unknown[] = []
    cdp.on('Media.playerPropertiesChanged', event => mediaEvents.push(event))
    cdp.on('Media.playerErrorsRaised', event => mediaEvents.push(event))
    await cdp.send('Media.enable')
    writeFileSync(join(directory, 'gpu-info.json'), JSON.stringify(await browserCdp.send('SystemInfo.getInfo'), null, 2))
    // A fresh document avoids retaining app resources or decoding a baseline video.
    const origin = new URL(host.url).origin
    const token = new URLSearchParams(new URL(host.url).hash.slice(1)).get('t')!
    const src = `${origin}/assets/${encodeURIComponent(spaceId)}/${encodeURIComponent(height === 1080 ? decode1080 : decode720)}?t=${encodeURIComponent(token)}`
    await page.route('**/memory-decode.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0;background:black;display:grid;grid-template-columns:repeat(2,1fr)"></body></html>' }))
    await page.goto(`${origin}/memory-decode.html`)
    const baseline = await physicalMemory(browserCdp, directory, 'baseline')
    await page.evaluate(async ({ src, count }) => {
      const observer = new PerformanceObserver(list => {
        const tasks = (window as unknown as { memoryLongTasks: number[] }).memoryLongTasks
        tasks.push(...list.getEntries().map(entry => entry.duration))
      })
      Object.assign(window, { memoryLongTasks: [] })
      observer.observe({ type: 'longtask', buffered: false })
      const videos = Array.from({ length: count }, (_, i) => {
        const video = document.createElement('video')
        video.src = `${src}&decoder=${i}`
        video.loop = true
        video.muted = true
        video.playsInline = true
        video.style.cssText = 'width:100%;height:500px;object-fit:contain'
        document.body.append(video)
        return video
      })
      await Promise.all(videos.map(video => video.play()))
      Object.assign(window, { memoryDecodeStarted: performance.now() })
    }, { src, count })
    await page.waitForTimeout(30_000)
    const quality = await page.evaluate(() => {
      const w = window as unknown as { memoryLongTasks: number[]; memoryDecodeStarted: number }
      return { elapsedMs: performance.now() - w.memoryDecodeStarted, longTasks: w.memoryLongTasks, videos: [...document.querySelectorAll('video')].map(video => {
        const q = video.getVideoPlaybackQuality()
        return { total: q.totalVideoFrames, dropped: q.droppedVideoFrames, width: video.videoWidth, height: video.videoHeight, paused: video.paused, error: video.error?.code ?? null }
      }) }
    })
    const memory = await physicalMemory(browserCdp, directory, 'playing-30s')
    const result = { rate, height, count, baseline, memory, quality, mediaEvents }
    decode.push(result)
    const total = quality.videos.reduce((sum, video) => sum + video.total, 0)
    const dropped = quality.videos.reduce((sum, video) => sum + video.dropped, 0)
    decodeRows.push(`| ${height}p | ${count} | ${rate}x | ${mib(memory.renderer)} | ${mib(memory.gpu)} | ${mib(memory.renderer - baseline.renderer)} / ${mib(memory.gpu - baseline.gpu)} | ${dropped} / ${total} | ${quality.longTasks.length} / ${quality.longTasks.reduce((sum, ms) => sum + ms, 0).toFixed(0)} / ${Math.max(0, ...quality.longTasks).toFixed(0)} |`)
    writeFileSync(join(directory, 'results.json'), JSON.stringify(result, null, 2))
    console.log(`[decode] ${height}p x${count} CPU${rate}: renderer ${mib(memory.renderer)}, GPU ${mib(memory.gpu)} MiB; dropped ${quality.videos.map(v => `${v.dropped}/${v.total}`).join(', ')}; long tasks ${quality.longTasks.length}`)
    await browser!.close()
    browser = undefined
  })
})
