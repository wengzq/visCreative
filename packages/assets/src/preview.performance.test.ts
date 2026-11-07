import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { cpus, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { detectVideoEncoder } from './encoders'
import { createPreviewCache } from './preview'

it.skipIf(process.env.VIS_MEASURE_PREVIEWS !== '1')('measures previews without enforcing timing targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vis-preview-measure-'))
  try {
    const audio = join(dir, 'three minutes stereo.wav')
    const video = join(dir, 'one minute 1080p.mp4')
    const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-nostdin', ...args], { stdio: 'pipe' })
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=180', '-ac', '2', '-c:a', 'pcm_s16le', '-y', audio])
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:size=1920x1080:rate=30:duration=60', '-c:v', 'mpeg4', '-q:v', '5', '-y', video])
    const encoder = await detectVideoEncoder()
    const cache = createPreviewCache({ dir: join(dir, 'cache') })
    const start = performance.now()
    const peaks = await cache.peaks('three-minutes', audio)
    const peaksFirstMs = performance.now() - start
    const hitStart = performance.now()
    await cache.peaks('three-minutes', audio)
    const peaksHitMs = performance.now() - hitStart
    const filmStart = performance.now()
    const strip = await cache.filmstrip('one-minute', video)
    const filmstripMs = performance.now() - filmStart
    const result = {
      measuredAt: new Date().toISOString(),
      machine: { platform: process.platform, release: release(), node: process.version, cpu: cpus()[0]?.model, logicalCores: cpus().length, memoryGiB: totalmem() / 1024 ** 3 },
      encoder, peaksFirstMs, peaksHitMs, filmstripMs,
      audio: { sourceDurationMs: 180000, sourceSampleRate: 44100, sourceChannels: 2, bins: peaks.peaks.length, binsPerSecond: peaks.binsPerSecond },
      video: { sourceDurationMs: 60000, sourceWidth: 1920, sourceHeight: 1080, sourceFps: 30, sourceCodec: 'mpeg4', ...strip, path: '(temporary JPEG removed after measurement)' },
    }
    await mkdir('artifacts', { recursive: true })
    await writeFile('artifacts/W2-timings.json', JSON.stringify(result, null, 2))
    console.info(JSON.stringify(result))
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 120_000)
