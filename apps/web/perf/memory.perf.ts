import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { CanvasOp } from '@vis/protocol'
import { createFfmpegMedia } from '../../../packages/assets/src/index'
import { createMockProvider } from '../../../packages/generation/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from '../e2e/platform'

/*
 * Where the canvas page's memory goes, stage by stage. macOS only (uses `footprint`, which excludes shared pages).
 *   pnpm --filter @vis/web perf -- memory
 * VIS_PERF_DSF sets deviceScaleFactor (default 2), VIS_PERF_COUNT nodes per kind (default 10), VIS_PERF_OUT the report directory (default /tmp/vis-perf).
 * For editor close timings, heap snapshots and simultaneous decode, use the
 * separate RFC 0024e study: pnpm --filter @vis/web perf memory-lifecycle
 * Unlike this canvas comparison, that study does not force GC at every stage.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url))
const ready = process.platform === 'darwin' && existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const dsf = Number(process.env.VIS_PERF_DSF ?? 2) || 2
const outDir = process.env.VIS_PERF_OUT ?? '/tmp/vis-perf'
const COUNT = Number(process.env.VIS_PERF_COUNT ?? 10) || 10

let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let cdp: CDPSession
let spaceId: string
const lines: string[] = []

type Footprint = { pid: number; total: number; categories: [string, number][] }

function chromeProcesses() {
  const table = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(m => m !== null)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }))
  const mine = new Set<number>([process.pid])
  let grew = true
  while (grew) {
    grew = false
    for (const row of table) if (!mine.has(row.pid) && mine.has(row.ppid)) { mine.add(row.pid); grew = true }
  }
  return table.filter(row => mine.has(row.pid) && row.pid !== process.pid && /Chrome|chromium/i.test(row.command))
    .map(row => ({ pid: row.pid, type: row.command.match(/--type=([a-z-]+)/)?.[1] ?? 'browser', utility: row.command.match(/--utility-sub-type=([\w.]+)/)?.[1] }))
}

const unit = (value: string, suffix: string) => Number(value) * ({ B: 1, KB: 1024, MB: 2 ** 20, GB: 2 ** 30 }[suffix] ?? 1)

function footprint(pid: number): Footprint {
  const text = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8' })
  const total = text.match(/Footprint: ([\d.]+) (B|KB|MB|GB)/)
  const categories: [string, number][] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([\d.]+) (B|KB|MB|GB)\s+[\d.]+ (?:B|KB|MB|GB)\s+[\d.]+ (?:B|KB|MB|GB)\s+\d+\s+(.+)$/)
    if (m) categories.push([m[3]!.trim(), unit(m[1]!, m[2]!)])
  }
  return { pid, total: total ? unit(total[1]!, total[2]!) : 0, categories: categories.sort((a, b) => b[1] - a[1]) }
}

const mb = (bytes: number) => `${Math.round(bytes / 2 ** 20 * 10) / 10} MB`

async function stage(name: string) {
  await page.waitForTimeout(2500)
  await cdp.send('HeapProfiler.collectGarbage')
  await page.waitForTimeout(500)
  const { metrics } = await cdp.send('Performance.getMetrics')
  const m = Object.fromEntries(metrics.map(x => [x.name, x.value])) as Record<string, number>
  const media = await page.evaluate(() => [...document.querySelectorAll('video, img')].map(el => el instanceof HTMLVideoElement
    ? { tag: 'video', preload: el.preload, readyState: el.readyState, w: el.videoWidth, h: el.videoHeight }
    : { tag: 'img', w: (el as HTMLImageElement).naturalWidth, h: (el as HTMLImageElement).naturalHeight }))
  const procs = chromeProcesses().map(p => ({ ...p, fp: footprint(p.pid) }))
  const renderer = procs.filter(p => p.type === 'renderer').sort((a, b) => b.fp.total - a.fp.total)[0]
  const gpu = procs.find(p => p.type === 'gpu-process')
  const videos = media.filter(x => x.tag === 'video')
  lines.push(`## ${name}`, '',
    `- renderer footprint ${mb(renderer?.fp.total ?? 0)}; GPU process ${mb(gpu?.fp.total ?? 0)}; all Chrome ${mb(procs.reduce((s, p) => s + p.fp.total, 0))} in ${procs.length} processes`,
    `- JS heap ${mb(m.JSHeapUsedSize!)} used / ${mb(m.JSHeapTotalSize!)}; DOM nodes ${m.Nodes}; layout objects ${m.LayoutObjects}`,
    `- <video> ${videos.length} (${videos.map(v => `${v.preload}/rs${v.readyState}/${v.w}x${v.h}`).join(', ') || '—'}); <img> ${media.length - videos.length}`,
    `- renderer top: ${renderer?.fp.categories.slice(0, 8).map(([c, b]) => `${c} ${mb(b)}`).join(', ')}`,
    `- GPU top: ${gpu?.fp.categories.slice(0, 6).map(([c, b]) => `${c} ${mb(b)}`).join(', ')}`, '')
  console.log(`[memory] ${name}: renderer ${mb(renderer?.fp.total ?? 0)}, gpu ${mb(gpu?.fp.total ?? 0)}`)
}

async function register(path: string) {
  const info = await createFfmpegMedia().probe(path)
  const space = daemon.spaces.get(spaceId)!
  return space.assets.registerVersion(space.db, {
    staged: await space.assets.stageFile(path), kind: info.kind, mime: info.mime, origin: 'import',
    ...('width' in info && info.width ? { width: info.width, height: info.height } : {}),
    ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}),
  }).assetVersionId
}

const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })

describe.skipIf(!ready)('Canvas memory by stage', () => {
  beforeAll(async () => {
    mkdirSync(outDir, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-memory-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'memory', runtimes: {}, secretStore: createMemorySecretStore(), providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } } })
    spaceId = daemon.spaces.create('Memory').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  })

  afterAll(async () => {
    writeFileSync(join(outDir, `memory-dsf${dsf}-n${COUNT}.md`), [`# Canvas memory by stage (deviceScaleFactor ${dsf}, ${COUNT} items per kind)`, '', ...lines].join('\n'))
    console.log(`[memory] report: ${join(outDir, `memory-dsf${dsf}-n${COUNT}.md`)}`)
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('measures each stage', async () => {
    const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', '-y', ...args], { stdio: 'pipe' })
    const videos: string[] = []
    const images: string[] = []
    for (let i = 0; i < COUNT; i++) {
      const video = join(dir, `v${i}.mp4`)
      ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30:duration=6,hue=h=${i * 36}`, '-f', 'lavfi', '-i', 'sine=duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video])
      videos.push(await register(video))
      const image = join(dir, `i${i}.png`)
      ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=2048x2048,hue=h=${i * 36}`, '-frames:v', '1', image])
      images.push(await register(image))
    }

    const blank = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: dsf })
    page = blank
    cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor({ timeout: 30_000 })
    await stage('1. Empty project canvas')

    const v = await apply(videos.map((assetVersionId, i): CanvasOp => ({ op: 'node.create', tempId: `v${i}`, kind: 'video', title: `Video ${i}`, x: 40 + (i % 10) * 300, y: 40 + Math.floor(i / 10) * 220, w: 260, h: 146, content: { assetVersionId } })))
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    // Include every generated poster in the footprint rather than measuring a partly drained preview queue.
    await page.waitForFunction(count => {
      const posters = [...document.querySelectorAll<HTMLImageElement>('.vis-video-poster')]
      return posters.length === count && posters.every(image => image.complete && image.naturalWidth > 0)
    }, COUNT, { timeout: 60_000 })
    await stage(`2. + ${COUNT} video nodes (1080p)`)

    const im = await apply(images.map((assetVersionId, i): CanvasOp => ({ op: 'node.create', tempId: `i${i}`, kind: 'image', title: `Image ${i}`, x: 40 + (i % 10) * 300, y: 1200 + Math.floor(i / 10) * 300, w: 260, h: 260, content: { assetVersionId } })))
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await stage(`3. + ${COUNT} image nodes (2048²)`)

    await apply(Object.values(v.idMap).map((nodeId): CanvasOp => ({ op: 'node.delete', nodeId: nodeId as string })))
    await stage('4. video nodes deleted')

    await apply(Object.values(im.idMap).map((nodeId): CanvasOp => ({ op: 'node.delete', nodeId: nodeId as string })))
    await stage('5. image nodes deleted (back to empty)')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor({ timeout: 30_000 })
    await stage('6. empty canvas after reload')
  })
})
