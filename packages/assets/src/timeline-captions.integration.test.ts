import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BUILTIN_FONTS, BUILTIN_FONT_FAMILIES, type TextPreset, type TimelineDoc } from '@vis/protocol'
import { readAssFontFamily, readFontFamily } from './font-name'
import { readFileSync } from 'node:fs'
import { detectAssFilter, renderTimeline } from './timeline-render'
import type { CaptionFonts } from './timeline-captions'
import { BUILTIN_FONT_FILES } from '../../../resources/fonts/paths'

const fontDir = process.env['VIS_FONTS_DIR'] ?? fileURLToPath(new URL('../../../resources/fonts/files/', import.meta.url))
const fontFiles = BUILTIN_FONTS.map(id => join(fontDir, BUILTIN_FONT_FILES[id]))
const available = fontFiles.every(existsSync)
let ffmpeg = true
try { execFileSync('ffmpeg', ['-version'], { windowsHide: true, stdio: 'ignore' }) } catch { ffmpeg = false }
if (!available) console.info('Skipping real caption rendering: run pnpm fonts:fetch to install the four built-in fonts')
if (!ffmpeg) console.info('Skipping real caption rendering: ffmpeg is not on PATH')
// Some ffmpeg builds (e.g. without libass) cannot burn captions; the product reports media.captions_unavailable for them.
const assFilter = ffmpeg && await detectAssFilter('ffmpeg')
if (ffmpeg && !assFilter) console.info('Skipping real caption rendering: this ffmpeg has no ASS filter')
const fonts: CaptionFonts = new Map(BUILTIN_FONTS.map((id, index) => [`builtin:${id}`, { path: fontFiles[index]!, family: available ? readAssFontFamily(readFileSync(fontFiles[index]!)) : BUILTIN_FONT_FAMILIES[id] }]))
const encoder = { name: 'libx264', args: ['-preset', 'ultrafast', '-crf', '18'], hardware: false }
const screenshots = process.platform === 'win32' ? 'C:/tmp/vis-d2' : join(tmpdir(), 'vis-d2')
let dir: string
const document = (preset: TextPreset = 'subtitle'): TimelineDoc => ({ version: 1, tracks: [], textTracks: [{ id: 'text', hidden: false, clips: [
  { id: 'caption', startMs: 0, durationMs: 2000, text: 'Hello timeline\n第一镜：清晨', style: { preset }, fadeInMs: 100, fadeOutMs: 100 },
] }] })

describe.skipIf(!available || !assFilter)('real ASS caption rendering', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vis-caption-'))
    const renderDir = join(dir, 'render space 中文')
    mkdirSync(renderDir)
    vi.stubEnv('TMP', renderDir)
    vi.stubEnv('TEMP', renderDir)
    vi.stubEnv('TMPDIR', renderDir)
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=30:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-y', join(dir, 'source 中文.mp4')], { windowsHide: true })
  })
  afterAll(() => { vi.unstubAllEnvs(); if (dir) rmSync(dir, { recursive: true, force: true }) })
  it('burns text over a two-second video with spaces and Chinese in render and input paths', async () => {
    const doc = document()
    doc.tracks = [{ id: 'video', kind: 'video', muted: false, volume: 1, clips: [{ id: 'shot', startMs: 0, inMs: 0, outMs: 2000, source: { nodeId: 'shot', assetVersionId: 'source' }, volume: 1, fadeInMs: 0, fadeOutMs: 0 }] }]
    const result = await renderTimeline(doc, new Map([['source', { kind: 'video', path: join(dir, 'source 中文.mp4'), durationMs: 2000 }]]), { fonts, encoder })
    try {
      expect(existsSync(result.path)).toBe(true)
      expect(result.path.replaceAll('\\', '/')).toContain('/render space 中文/')
      expect(Math.abs(result.durationMs - 2000)).toBeLessThan(40)
      expect(result.width).toBe(320)
      const pixels = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', result.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
      expect(pixels.some((value, i) => i % 3 === 0 && value > 100)).toBe(true)
    } finally { await result.dispose() }
  }, 20_000)
  it('renders a default 1920×1080 text-only video and all bundled default font instances', async () => {
    for (const preset of ['subtitle', 'variety', 'cinema', 'title'] as const) {
      const id = { subtitle: 'noto-sans-sc', variety: 'zcool-kuaile', cinema: 'lxgw-wenkai', title: 'smiley-sans' } as const
      expect(readFontFamily(readFileSync(join(fontDir, BUILTIN_FONT_FILES[id[preset]])))).toBe(BUILTIN_FONT_FAMILIES[id[preset]])
      const result = await renderTimeline(document(preset), new Map(), { fonts, encoder })
      try {
        expect(existsSync(result.path)).toBe(true)
        expect(result.width).toBe(1920)
        expect(result.height).toBe(1080)
        expect(Math.abs(result.durationMs - 2000)).toBeLessThan(40)
        const selected = spawnSync('ffmpeg', ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:d=1', '-vf', 'ass=captions.ass:fontsdir=fonts', '-frames:v', '1', '-f', 'null', '-'], { cwd: dirname(result.path), windowsHide: true, encoding: 'utf8', shell: false })
        expect(selected.status).toBe(0)
        const postscript = { subtitle: 'NotoSansSC-Regular', variety: 'ZCOOLKuaiLe-Regular', cinema: 'LXGWWenKai-Regular', title: 'SmileySans-Oblique' }[preset]
        expect(selected.stderr.split('\n').filter(line => line.includes('fontselect:')).join('\n')).toContain(postscript)
        const png = join(screenshots, `caption-${preset}.png`)
        mkdirSync(screenshots, { recursive: true })
        execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', result.path, '-frames:v', '1', '-y', png], { windowsHide: true })
        const gray = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', result.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
        expect(gray[0]).toBe(0)
        expect(gray.some(value => value > 100)).toBe(true)
      } finally { await result.dispose() }
    }
  }, 30_000)
  it('keeps a literal backslash-N on one line while a newline produces two lines', async () => {
    const heights: number[] = []
    for (const text of ['{hello}\\Nworld', 'hello\nworld']) {
      const doc = document()
      doc.textTracks![0]!.clips[0]!.text = text
      const result = await renderTimeline(doc, new Map(), { fonts, encoder })
      try {
        const pixels = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', result.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
        let top = 1080
        let bottom = 0
        for (let i = 0; i < pixels.length; i++) if (pixels[i]! > 100) { const row = Math.floor(i / 1920); top = Math.min(top, row); bottom = Math.max(bottom, row) }
        heights.push(bottom - top + 1)
      } finally { await result.dispose() }
    }
    expect(heights[0]).toBeGreaterThan(20)
    expect(heights[1]).toBeGreaterThan(heights[0]! * 1.5)
  }, 20_000)
})
