import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NodeView } from '../../../packages/protocol/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const chrome = chromePath()
const browserReady = existsSync(chrome)

function fixtures(dir: string) {
  const video = join(dir, 'video.mp4')
  const audio = join(dir, 'silences.wav')
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=15:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-shortest', video])
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=if(between(t\\,1\\,1.8)+between(t\\,3\\,3.8)\\,0\\,0.3*sin(2*PI*440*t)):s=22050:d=5', '-c:a', 'pcm_s16le', audio])
  return { video, audio }
}

async function moveHandle(page: Page, handle: Locator, track: Locator, fraction: number) {
  const from = (await handle.boundingBox())!
  const to = (await track.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width * fraction, to.y + to.height / 2, { steps: 8 })
  await page.mouse.up()
}

// This bundle exercises the real panels with deterministic callbacks, independently of N1/N2.
describe.skipIf(!browserReady)('Media panels in isolation', () => {
  let dir: string
  let server: Server
  let browser: Browser
  let page: Page
  let url: string
  const pageErrors: string[] = []
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-media-panels-isolated-'))
    const assets = fixtures(dir)
    const modulePath = (path: string) => JSON.stringify(join(root, path).replaceAll('\\', '/'))
    await build({
      stdin: {
        resolveDir: join(root, 'apps/web'), loader: 'tsx',
        contents: `
          import React, { useState } from 'react'
          import { createRoot } from 'react-dom/client'
          import { LocaleProvider } from '@vis/ui-kit'
          import ${modulePath('packages/ui-kit/src/theme.css')}
          import { MEDIA_PANELS } from ${modulePath('packages/canvas/ui/src/mediaPanels.tsx')}
          import { VideoPlayer } from ${modulePath('packages/canvas/ui/src/VideoPlayer.tsx')}
          import { AudioPlayer } from ${modulePath('packages/canvas/ui/src/AudioPlayer.tsx')}
          const query = new URLSearchParams(location.search)
          const operation = query.get('operation') || 'video.trim'
          const kind = operation.startsWith('video') ? 'video' : 'audio'
          const src = kind === 'video' ? '/video.mp4' : '/silences.wav'
          const slot = { slotId: 'fixture-slot', slotKey: 'main', revision: 1, contentType: kind, content: { type: 'asset', assetVersionId: 'fixture-asset', mime: kind + '/' + (kind === 'video' ? 'mp4' : 'wav') } }
          const view = { nodeId: 'fixture-node', kind, x: 0, y: 0, w: 480, h: 500, z: 0, layoutRevision: 1, slots: [slot] }
          function Harness() {
            const [result, setResult] = useState('')
            const [open, setOpen] = useState(!query.has('player'))
            const [attempt, setAttempt] = useState(0)
            const Panel = MEDIA_PANELS[operation]
            return <LocaleProvider locale="en" setLocale={() => {}}>
              <div style={{width:480,height:500,margin:30}}>
                {query.get('player') === 'audio' ? <AudioPlayer assetId="fixture-asset" src="/silences.wav" selected /> : !open
                  ? <><div style={{height:300}}><VideoPlayer src={src} compact source={{jobId:'fixture-job',inputNodeIds:[]}} /></div><button onClick={() => setOpen(true)}>Open frame panel</button></>
                  : Panel && <Panel view={view} slot={slot} assetVersionId="fixture-asset" src={src} variant={query.get('variant') || undefined}
                    onAnalyze={async () => ({durationMs:5000,pointsMs:[1400,3400]})}
                    onCancel={() => setResult('cancelled')}
                    onSubmit={async params => { setAttempt(attempt + 1); if(query.has('fail') && attempt === 0) throw new Error('Fixture submission failed'); setResult(JSON.stringify(params)) }} />}
              </div>
              <output aria-label="Submitted parameters">{result}</output>
            </LocaleProvider>
          }
          createRoot(document.getElementById('root')).render(<Harness />)
        `,
      },
      bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic',
      outfile: join(dir, 'panels.js'), define: { 'process.env.NODE_ENV': '"development"' },
    })
    server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname
      const files: Record<string, [string, string]> = {
        '/panels.js': [join(dir, 'panels.js'), 'text/javascript'],
        '/panels.css': [join(dir, 'panels.css'), 'text/css'],
        '/video.mp4': [assets.video, 'video/mp4'],
        '/silences.wav': [assets.audio, 'audio/wav'],
      }
      const file = files[path]
      if (!file) {
        response.setHeader('Content-Type', 'text/html')
        response.end('<html><head><link rel="stylesheet" href="/panels.css"></head><body><div id="root"></div><script type="module" src="/panels.js"></script></body></html>')
        return
      }
      const bytes = readFileSync(file[0])
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
      const start = range ? Number(range[1]) : 0
      const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1
      response.setHeader('Content-Type', file[1])
      response.setHeader('Accept-Ranges', 'bytes')
      response.setHeader('Content-Length', end - start + 1)
      if (range) { response.statusCode = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`) }
      response.end(bytes.subarray(start, end + 1))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    browser = await chromium.launch({ executablePath: chrome, headless: true })
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.setDefaultNavigationTimeout(15_000)
    page.on('pageerror', error => pageErrors.push(error.message))
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    removeTempDir(dir)
  })

  it('Video trim supports dragging, keyboard clamping, range playback and Enter confirmation', async () => {
    await page.goto(url)
    const start = page.getByRole('slider', { name: 'Range start', exact: true })
    const end = page.getByRole('slider', { name: 'Range end', exact: true })
    await expect.poll(() => end.getAttribute('aria-valuenow')).toBe('6000')
    await moveHandle(page, start, page.getByRole('slider', { name: 'Media timeline' }), .25)
    await expect.poll(() => start.getAttribute('aria-valuenow')).toBe('1500')
    await moveHandle(page, end, page.getByRole('slider', { name: 'Media timeline' }), .5)
    await expect.poll(() => end.getAttribute('aria-valuenow')).toBe('3000')
    await start.focus()
    await page.keyboard.press('ArrowRight')
    expect(await start.getAttribute('aria-valuenow')).toBe('1600')
    await page.getByRole('button', { name: 'Preview range', exact: true }).click()
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), { timeout: 6000 }).toBe(true)
    expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(3, 1)
    await start.press('Enter')
    await expect.poll(() => page.getByLabel('Submitted parameters').textContent()).toBe('{"startMs":1600,"endMs":3000}')
    await page.screenshot({ path: join(tmpdir(), 'vis-n3-video-trim.png'), animations: 'disabled' })
  })

  it('Audio trim reuses the waveform and stops its preview at the selected endpoint', async () => {
    await page.goto(`${url}?operation=audio.trim`)
    const end = page.getByRole('slider', { name: 'Range end', exact: true })
    await expect.poll(() => end.getAttribute('aria-valuenow')).toBe('5000')
    await end.focus()
    await page.keyboard.press('Home')
    expect(await end.getAttribute('aria-valuenow')).toBe('1')
    await page.keyboard.press('Shift+ArrowRight')
    await page.getByRole('button', { name: 'Preview range', exact: true }).click()
    await expect.poll(() => page.locator('audio').evaluate((a: HTMLAudioElement) => a.paused), { timeout: 5000 }).toBe(true)
    expect(await page.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime)).toBeCloseTo(1.001, 2)
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(() => page.getByLabel('Submitted parameters').textContent()).toBe('{"startMs":0,"endMs":1001}')
  })

  it('Frame selection starts at the replaced player position and exposes the AI source tag', async () => {
    await page.goto(`${url}?operation=video.frame&player=video`)
    await page.getByText('AI generated', { exact: true }).waitFor()
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.duration)).toBe(6)
    await page.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = 2.25 })
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(2.25)
    await page.getByRole('button', { name: 'Open frame panel' }).click()
    await expect.poll(() => page.getByRole('slider', { name: 'Frame time' }).inputValue()).toBe('2250')
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(() => page.getByLabel('Submitted parameters').textContent()).toBe('{"atMs":2250}')
  })

  it('Smart split candidates can be removed, dragged, added and confirmed in increasing order', async () => {
    await page.goto(`${url}?operation=audio.split&variant=smart`)
    await page.getByRole('slider', { name: 'Split point 2', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Remove split point 1', exact: true }).click()
    const point = page.getByRole('slider', { name: 'Split point 1', exact: true })
    await moveHandle(page, point, page.getByRole('slider', { name: 'Audio waveform' }), .6)
    await expect.poll(() => point.getAttribute('aria-valuenow')).toBe('3000')
    const wave = (await page.getByRole('slider', { name: 'Audio waveform' }).boundingBox())!
    await page.mouse.click(wave.x + wave.width * .2, wave.y + wave.height / 2)
    await page.getByRole('slider', { name: 'Split point 2', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(() => page.getByLabel('Submitted parameters').textContent()).toBe('{"pointsMs":[1000,3000]}')
  })

  it('Custom split prevents an empty submission and supports keyboard addition and deletion', async () => {
    await page.goto(`${url}?operation=audio.split`)
    expect(await page.getByRole('button', { name: 'Confirm', exact: true }).isDisabled()).toBe(true)
    const wave = page.getByRole('slider', { name: 'Audio waveform' })
    await expect.poll(() => wave.isEnabled()).toBe(true)
    await wave.focus()
    await wave.press('ArrowRight')
    await page.getByRole('button', { name: 'Add split point at playhead' }).click()
    const point = page.getByRole('slider', { name: 'Split point 1', exact: true })
    await point.waitFor()
    await point.press('Delete')
    expect(await page.getByRole('button', { name: 'Confirm', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: 'Cancel', exact: true }).press('Escape')
    await expect.poll(() => page.getByLabel('Submitted parameters').textContent()).toBe('cancelled')
  })

  it('Speed uses catalog values and retains a rejected submission error until retry', async () => {
    await page.goto(`${url}?operation=audio.speed&fail=1`)
    expect(await page.getByRole('button', { name: '1×', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: '1.5×', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await page.getByRole('alert').getByText('Fixture submission failed').waitFor()
    await page.getByRole('button', { name: '1.5×', exact: true }).focus()
    await page.keyboard.press('Tab')
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(() => page.getByLabel('Submitted parameters').textContent()).toBe('{"rate":1.5}')
  })

  it('The audio body seeks by waveform click and drag and shows the playhead', async () => {
    await page.goto(`${url}?player=audio`)
    const wave = page.getByRole('slider', { name: 'Playback progress', exact: true })
    await expect.poll(() => wave.isEnabled()).toBe(true)
    const rect = (await wave.boundingBox())!
    await page.mouse.move(rect.x + rect.width * .2, rect.y + rect.height / 2)
    await page.mouse.down()
    await page.mouse.move(rect.x + rect.width * .75, rect.y + rect.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => page.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime)).toBeCloseTo(3.75, 1)
    expect(await page.locator('.vis-media-playhead').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(239, 106, 106)')
    expect(pageErrors).toEqual([])
    await page.screenshot({ path: join(tmpdir(), 'vis-n3-audio-waveform.png'), animations: 'disabled' })
  })

  it('Compact video keeps its controls in one bottom row and fades them when the pointer leaves', async () => {
    await page.goto(`${url}?operation=video.frame&player=video`)
    await page.locator('.vis-video-player').evaluate(el => { (el.parentElement as HTMLElement).style.width = '300px' })
    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.duration)).toBe(6)
    expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.muted)).toBe(true)
    await page.locator('video').hover()
    await expect.poll(() => page.locator('.vis-video-controls').evaluate(el => getComputedStyle(el).opacity)).toBe('1')
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Unmute', exact: true }).waitFor()
    const centers = await page.locator('.vis-video-controls > *').evaluateAll(elements => elements.map(el => {
      const rect = el.getBoundingClientRect()
      return rect.y + rect.height / 2
    }))
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1)
    await page.screenshot({ path: join(tmpdir(), 'vis-n3-compact-video.png'), animations: 'disabled' })
    await page.mouse.move(1000, 800)
    await expect.poll(() => page.locator('.vis-video-controls').evaluate(el => getComputedStyle(el).opacity)).toBe('0')
    expect(pageErrors).toEqual([])
  })
})

describe.skipIf(!browserReady || !existsSync(join(root, 'apps/web/dist/client/index.html')))('Media operations through the node toolbar', () => {
  let dir: string
  let assets: ReturnType<typeof fixtures>
  let studiod: Studiod
  let host: WebHost
  let admin: StudiodLink
  let browser: Browser
  let page: Page
  const nodes = async () => (await admin.call('canvas.get')).nodes as NodeView[]
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-media-panels-e2e-'))
    assets = fixtures(dir)
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(), providers: [],
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    })
    const { spaceId } = studiod.spaces.create('Media operation panels')
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chrome, headless: true })
    page = await browser.newPage({ locale: 'en', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.setDefaultNavigationTimeout(15_000)
    await page.goto(host.url)
    await page.locator('.react-flow__pane').waitFor()
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await studiod?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  }, 30_000)

  async function upload(path: string) {
    const before = new Set((await nodes()).map(node => node.nodeId))
    await page.getByLabel('Upload images, videos or audio', { exact: true }).setInputFiles(path)
    await expect.poll(nodes).toHaveLength(before.size + 1)
    const created = (await nodes()).find(node => !before.has(node.nodeId))!
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    let previous = ''
    await expect.poll(async () => {
      const current = await page.locator('.react-flow__viewport').evaluate(el => getComputedStyle(el).transform)
      const settled = current === previous
      previous = current
      return settled
    }, { intervals: [100] }).toBe(true)
    const element = page.locator(`.react-flow__node[data-id="${created.nodeId}"]`)
    // The node body has no inline toolbar over it until selection.
    await element.locator('.vis-version-body').click({ position: { x: 8, y: 8 } })
    return created
  }

  async function operation(name: RegExp) {
    const direct = page.getByRole('button', { name })
    if (await direct.count()) { await direct.first().click(); return }
    await page.getByRole('button', { name: /More/, exact: false }).click()
    await page.getByRole('menuitem', { name }).click()
  }

  it('Video trim replaces the asset; frame and extract audio create connected nodes', async () => {
    const video = await upload(assets.video)
    const main = video.slots.find(slot => slot.slotKey === 'main')!
    await operation(/^Trim( video)?$/i)
    const start = page.getByRole('slider', { name: 'Range start', exact: true })
    const end = page.getByRole('slider', { name: 'Range end', exact: true })
    await expect.poll(() => end.getAttribute('aria-valuenow')).toBe('6000')
    await start.focus()
    await start.press('Shift+ArrowRight')
    await end.focus()
    await end.press('Shift+ArrowLeft')
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(async () => (await nodes()).find(node => node.nodeId === video.nodeId)?.slots.find(slot => slot.slotKey === 'main')?.revision, { timeout: 20_000 }).toBe(main.revision + 1)
    const trimmed = (await nodes()).find(node => node.nodeId === video.nodeId)!
    expect(trimmed.slots.find(slot => slot.slotKey === 'main')?.content).not.toEqual(main.content)
    const element = page.locator(`.react-flow__node[data-id="${video.nodeId}"]`)
    await element.hover()
    await expect.poll(() => element.locator('video').last().evaluate((v: HTMLVideoElement) => v.duration)).toBeCloseTo(4, 1)

    await operation(/^(Frame|Frame grab|Extract frame)$/i)
    const frame = page.getByRole('slider', { name: 'Frame time', exact: true })
    await expect.poll(() => frame.isEnabled()).toBe(true)
    await frame.focus()
    await frame.press('Home')
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.kind === 'image'), { timeout: 20_000 }).toHaveLength(1)
    const image = (await nodes()).find(node => node.kind === 'image')!
    expect(image.inputs).toContain(video.nodeId)

    await element.locator('.vis-version-body').click({ position: { x: 8, y: 8 } })
    await operation(/^(Extract audio|Separate audio)$/i)
    await expect.poll(async () => (await nodes()).filter(node => node.kind === 'audio'), { timeout: 20_000 }).toHaveLength(1)
    expect((await nodes()).find(node => node.kind === 'audio')!.inputs).toContain(video.nodeId)
  }, 60_000)

  it('Smart split draws silence candidates and removing one creates exactly two segments', async () => {
    const audio = await upload(assets.audio)
    const before = (await nodes()).length
    await operation(/^Smart split$/i)
    await page.getByRole('slider', { name: 'Split point 2', exact: true }).waitFor({ timeout: 20_000 })
    expect(await page.getByRole('slider', { name: /^Split point / }).count()).toBe(2)
    await page.getByRole('button', { name: 'Remove split point 1', exact: true }).click()
    expect(await page.getByRole('slider', { name: /^Split point / }).count()).toBe(1)
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(nodes, { timeout: 20_000 }).toHaveLength(before + 2)
    const segments = (await nodes()).filter(node => node.inputs?.includes(audio.nodeId))
    expect(segments).toHaveLength(2)
    expect(segments.every(node => node.kind === 'audio')).toBe(true)
    expect((await nodes()).find(node => node.nodeId === audio.nodeId)?.slots).toEqual(audio.slots)
  }, 45_000)
})
