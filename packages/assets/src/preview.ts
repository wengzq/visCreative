import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { alphaDecoder, streamHasAlpha, type AlphaStream } from './alpha'
import { abortError, mediaError, runMedia, tool } from './media'

const run = promisify(execFile)
const SAMPLE_RATE = 8000
const FORMAT_VERSION = 2
type PreviewOptions = { ffmpegPath?: string; ffprobePath?: string; signal?: AbortSignal }
export type AudioPeaks = { durationMs: number; binsPerSecond: number; peaks: number[] }
export type Filmstrip = { durationMs: number; frameWidth: number; frameHeight: number; intervalMs: number; frames: number }
export type CachedFilmstrip = Filmstrip & { path: string }
export type Poster = { width: number; height: number }
export type CachedPoster = Poster & { path: string }
type Stream = AlphaStream & { index: number; codec_type?: string; width?: number; height?: number; sample_aspect_ratio?: string; duration?: string; disposition?: { attached_pic?: number }; side_data_list?: { rotation?: number }[] }

async function probe(path: string, opts: PreviewOptions) {
  if (opts.signal?.aborted) throw abortError(opts.signal)
  const ffmpeg = opts.ffmpegPath ?? 'ffmpeg'
  const probeName = /\.exe$/i.test(ffmpeg) ? 'ffprobe.exe' : 'ffprobe'
  const ffprobe = opts.ffprobePath ?? (basename(ffmpeg) === ffmpeg ? probeName : resolve(dirname(ffmpeg), probeName))
  try {
    const { stdout } = await run(ffprobe, [
      '-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,pix_fmt,width,height,sample_aspect_ratio,duration:stream_tags=alpha_mode:stream_disposition=attached_pic:stream_side_data=rotation:format=duration,format_name', '-of', 'json', path,
    ], { timeout: 30_000, windowsHide: true, shell: false, ...(opts.signal ? { signal: opts.signal } : {}) })
    return JSON.parse(stdout) as { streams?: Stream[]; format?: { duration?: string; format_name?: string } }
  } catch (error) {
    if (opts.signal?.aborted) throw abortError(opts.signal)
    throw mediaError('unavailable', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'media.tool_missing' : 'media.process_failed', `Cannot probe local media: ${tool(error, ffprobe)}`)
  }
}

function duration(stream: Stream, format?: { duration?: string }) {
  const seconds = [stream.duration, format?.duration].map(Number).find(value => Number.isFinite(value) && value > 0)
  if (!seconds) throw mediaError('invalid_params', 'media.duration_missing', 'Cannot read the source duration')
  return seconds * 1000
}

function positive(value: number, max: number, integer = false) {
  if (!Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isInteger(value))) {
    throw mediaError('invalid_params', 'media.invalid_params', 'Invalid media preview parameters')
  }
}

export async function audioPeaks(path: string, opts: PreviewOptions & { binsPerSecond?: number; maxBins?: number } = {}): Promise<AudioPeaks> {
  const requested = opts.binsPerSecond ?? 50
  const maxBins = opts.maxBins ?? 90000
  positive(requested, SAMPLE_RATE)
  positive(maxBins, 90000, true)
  const info = await probe(path, opts)
  const audio = info.streams?.find(stream => stream.codec_type === 'audio')
  if (!audio) throw mediaError('invalid_params', 'media.no_audio', 'The source contains no audio stream')
  const durationMs = duration(audio, info.format)
  let samplesPerBin = Math.max(Math.ceil(SAMPLE_RATE / requested), Math.ceil(durationMs * SAMPLE_RATE / 1000 / maxBins))
  const peaks: number[] = []
  let samples = 0
  let pending: number | undefined
  const signal = opts.signal ?? new AbortController().signal
  await pcm(opts.ffmpegPath ?? 'ffmpeg', ['-v', 'error', '-nostdin', '-i', path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], signal, chunk => {
    const sample = (value: number) => {
      let bin = Math.floor(samples / samplesPerBin)
      // Incorrect container durations must not allow unbounded peak storage.
      if (bin >= maxBins) {
        for (let i = 0; i < Math.ceil(peaks.length / 2); i++) peaks[i] = Math.max(peaks[i * 2]!, peaks[i * 2 + 1] ?? 0)
        peaks.length = Math.ceil(peaks.length / 2)
        samplesPerBin *= 2
        bin = Math.floor(samples / samplesPerBin)
      }
      peaks[bin] = Math.max(peaks[bin] ?? 0, Math.abs(value))
      samples++
    }
    let offset = 0
    if (pending !== undefined && chunk.length) {
      sample((pending | (chunk[0]! << 8)) << 16 >> 16)
      pending = undefined
      offset = 1
    }
    for (; offset + 1 < chunk.length; offset += 2) sample(chunk.readInt16LE(offset))
    if (offset < chunk.length) pending = chunk[offset]
  })
  if (!samples) throw mediaError('invalid_params', 'media.no_audio', 'The source contains no decoded audio')
  return { durationMs: Math.round(samples / SAMPLE_RATE * 1000), binsPerSecond: SAMPLE_RATE / samplesPerBin, peaks: peaks.map(value => Math.round(value / 32768 * 1000) / 1000) }
}

/** Consume PCM incrementally and wait for close before callers remove temporary files. */
function pcm(executable: string, args: string[], signal: AbortSignal, onData: (chunk: Buffer) => void): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    const stop = () => child.kill('SIGKILL')
    signal.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', onData)
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-65536) })
    child.once('error', error => {
      signal.removeEventListener('abort', stop)
      reject(mediaError('unavailable', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'media.tool_missing' : 'media.process_failed', `Cannot start local media processing: ${tool(error, executable)}`))
    })
    child.once('close', code => {
      signal.removeEventListener('abort', stop)
      if (signal.aborted) reject(abortError(signal))
      else if (code !== 0) reject(mediaError('unavailable', 'media.process_failed', `Local media processing failed: ${stderr.trim()}`))
      else resolve()
    })
    if (signal.aborted) stop()
  })
}

export async function filmstrip(path: string, outFile: string, opts: PreviewOptions & { frameHeight?: number; maxFrames?: number } = {}): Promise<Filmstrip> {
  const frameHeight = opts.frameHeight ?? 54
  const maxFrames = opts.maxFrames ?? 120
  positive(frameHeight, 2160, true)
  positive(maxFrames, 120, true)
  const info = await probe(path, opts)
  const video = info.streams?.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
  if (!video?.width || !video.height || ['image2', 'png_pipe', 'jpeg_pipe', 'webp_pipe', 'gif', 'apng'].includes(info.format?.format_name ?? '')) {
    throw mediaError('invalid_params', 'media.kind_mismatch', 'Filmstrips require a video source')
  }
  const durationMs = Math.max(1, Math.round(duration(video, info.format)))
  const frames = Math.min(maxFrames, Math.max(1, Math.ceil(durationMs / 1000)))
  const intervalMs = Math.max(1000, durationMs / frames)
  const rotation = video.side_data_list?.find(data => data.rotation !== undefined)?.rotation ?? 0
  const swapped = Math.abs(rotation % 180) === 90
  const width = swapped ? video.height : video.width
  const height = swapped ? video.width : video.height
  const frameWidth = Math.max(2, Math.round(width * frameHeight / height / 2) * 2)
  await runMedia(opts.ffmpegPath ?? 'ffmpeg', [
    '-v', 'error', '-nostdin', ...alphaDecoder(video), '-i', path, '-map', `0:${video.index}`, '-an',
    '-vf', `fps=fps=1000/${intervalMs}:start_time=0:round=up,scale=-2:${frameHeight},setsar=1,tile=${frames}x1:nb_frames=${frames}:padding=0:margin=0`,
    '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-update', '1', '-y', outFile,
  ], { signal: opts.signal ?? new AbortController().signal })
  return { durationMs: Math.round(durationMs), frameWidth, frameHeight, intervalMs, frames }
}

export async function poster(path: string, outFile: string, opts: PreviewOptions & { stillImage?: boolean } = {}): Promise<Poster> {
  const info = await probe(path, opts)
  const video = info.streams?.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
  if (!video?.width || !video.height || (!opts.stillImage && ['image2', 'png_pipe', 'jpeg_pipe', 'webp_pipe', 'gif', 'apng'].includes(info.format?.format_name ?? ''))) {
    throw mediaError('invalid_params', 'media.kind_mismatch', 'Posters require a video source')
  }
  const rotation = video.side_data_list?.find(data => data.rotation !== undefined)?.rotation ?? 0
  const swapped = Math.abs(rotation % 180) === 90
  const [sarWidth = 1, sarHeight = 1] = (video.sample_aspect_ratio ?? '1:1').split(':').map(Number)
  const sar = sarWidth > 0 && sarHeight > 0 && Number.isFinite(sarWidth / sarHeight) ? sarWidth / sarHeight : 1
  const displayWidth = video.width * sar
  const sourceWidth = swapped ? video.height : displayWidth
  const sourceHeight = swapped ? displayWidth : video.height
  const scale = Math.min(1, 960 / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const checker = "if(mod(floor(X/12)+floor(Y/12),2),190,220)"
  const filter = `scale=${width}:${height},setsar=1${streamHasAlpha(video) ? `,format=rgba,split[fg][bg];[bg]geq=r='${checker}':g='${checker}':b='${checker}':a=255[checker];[checker][fg]overlay` : ''}`
  // Still images have no seekable frame; preserve the existing first-frame seek for videos.
  await runMedia(opts.ffmpegPath ?? 'ffmpeg', [
    '-v', 'error', '-nostdin', ...(opts.stillImage ? [] : ['-ss', '0.001', '-noaccurate_seek']), ...alphaDecoder(video), '-i', path, '-map', `0:${video.index}`, '-an',
    '-vf', filter, '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '3', '-f', 'image2', '-update', '1', '-y', outFile,
  ], { signal: opts.signal ?? new AbortController().signal })
  return { width, height }
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const finitePositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
function validPeaks(value: AudioPeaks) {
  return finitePositive(value.durationMs) && finitePositive(value.binsPerSecond) && value.binsPerSecond <= SAMPLE_RATE
    && Array.isArray(value.peaks) && value.peaks.length > 0 && value.peaks.length <= 90000
    && value.peaks.every(peak => typeof peak === 'number' && Number.isFinite(peak) && peak >= 0 && peak <= 1)
    && Math.abs(value.peaks.length - Math.ceil(value.durationMs * value.binsPerSecond / 1000)) <= 1
}
function validFilmstrip(value: Filmstrip) {
  return finitePositive(value.durationMs) && Number.isInteger(value.frameWidth) && value.frameWidth > 0 && value.frameWidth % 2 === 0
    && Number.isInteger(value.frameHeight) && value.frameHeight > 0 && value.frameHeight <= 2160
    && finitePositive(value.intervalMs) && value.intervalMs >= 1000 && Number.isInteger(value.frames) && value.frames > 0 && value.frames <= 120
    && value.frames === Math.min(120, Math.max(1, Math.ceil(value.durationMs / 1000)))
}
function validPoster(value: Poster) {
  return Number.isInteger(value.width) && value.width > 0 && value.width <= 960
    && Number.isInteger(value.height) && value.height > 0 && value.height <= 960
}

export function createPreviewCache(opts: { dir: string; ffmpegPath?: string; ffprobePath?: string; limit?: <T>(task: () => Promise<T>) => Promise<T> }) {
  const flights = new Map<string, Promise<unknown>>()
  let clearing: Promise<void> | undefined
  const controller = new AbortController()
  const options: PreviewOptions = {
    signal: controller.signal,
    ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
    ...(opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {}),
  }
  const limit = opts.limit ?? (<T>(task: () => Promise<T>) => task())
  const keyFor = (id: string, kind: string) => `${id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}-${hash(id)}-${kind}-v${FORMAT_VERSION}`

  async function single<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (controller.signal.aborted) throw abortError(controller.signal)
    if (clearing) await clearing
    if (controller.signal.aborted) throw abortError(controller.signal)
    const existing = flights.get(key)
    if (existing) return existing as Promise<T>
    const flight = task()
    flights.set(key, flight)
    try { return await flight } finally { flights.delete(key) }
  }

  async function atomic(path: string, content: string) {
    const temp = `${path}.${randomUUID()}.tmp`
    try { await writeFile(temp, content); await rename(temp, path) } finally { await rm(temp, { force: true }) }
  }

  return {
    peaks(assetVersionId: string, path: string): Promise<AudioPeaks> {
      const key = keyFor(assetVersionId, 'peaks')
      return single(key, async () => {
        const file = join(opts.dir, `${key}.json`)
        try {
          const { sha256, ...cached } = JSON.parse(await readFile(file, 'utf8')) as AudioPeaks & { sha256: string }
          if (validPeaks(cached) && sha256 === hash(JSON.stringify(cached))) return cached
        } catch {}
        return limit(async () => {
          const result = await audioPeaks(path, options)
          await mkdir(opts.dir, { recursive: true })
          await atomic(file, JSON.stringify({ ...result, sha256: hash(JSON.stringify(result)) }))
          return result
        })
      })
    },
    filmstrip(assetVersionId: string, path: string): Promise<CachedFilmstrip> {
      const key = keyFor(assetVersionId, 'filmstrip')
      return single(key, async () => {
        const file = join(opts.dir, `${key}.json`)
        const jpeg = join(opts.dir, `${key}.jpg`)
        try {
          const { sha256, metadataSha256, ...result } = JSON.parse(await readFile(file, 'utf8')) as Filmstrip & { sha256: string; metadataSha256: string }
          if (validFilmstrip(result) && metadataSha256 === hash(JSON.stringify(result)) && sha256 === hash(await readFile(jpeg))) {
            return { ...result, path: jpeg }
          }
        } catch {}
        return limit(async () => {
          await mkdir(opts.dir, { recursive: true })
          const temp = join(opts.dir, `${key}.${randomUUID()}.jpg`)
          try {
            const result = await filmstrip(path, temp, options)
            const sha256 = hash(await readFile(temp))
            await rename(temp, jpeg)
            await atomic(file, JSON.stringify({ ...result, sha256, metadataSha256: hash(JSON.stringify(result)) }))
            return { ...result, path: jpeg }
          } finally { await rm(temp, { force: true }) }
        })
      })
    },
    poster(assetVersionId: string, path: string, stillImage = false): Promise<CachedPoster> {
      const key = keyFor(assetVersionId, 'poster')
      return single(key, async () => {
        const file = join(opts.dir, `${key}.json`)
        const jpeg = join(opts.dir, `${key}.jpg`)
        try {
          const { sha256, metadataSha256, ...result } = JSON.parse(await readFile(file, 'utf8')) as Poster & { sha256: string; metadataSha256: string }
          if (validPoster(result) && metadataSha256 === hash(JSON.stringify(result)) && sha256 === hash(await readFile(jpeg))) {
            return { ...result, path: jpeg }
          }
        } catch {}
        return limit(async () => {
          await mkdir(opts.dir, { recursive: true })
          const temp = join(opts.dir, `${key}.${randomUUID()}.jpg`)
          try {
            const result = await poster(path, temp, { ...options, stillImage })
            const sha256 = hash(await readFile(temp))
            await rename(temp, jpeg)
            await atomic(file, JSON.stringify({ ...result, sha256, metadataSha256: hash(JSON.stringify(result)) }))
            return { ...result, path: jpeg }
          } finally { await rm(temp, { force: true }) }
        })
      })
    },
    clear(): Promise<void> {
      if (clearing) return clearing
      clearing = (async () => {
        await Promise.allSettled([...flights.values()])
        const exists = await stat(opts.dir).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return undefined
        })
        if (exists) await rm(opts.dir, { recursive: true, force: true })
      })().finally(() => { clearing = undefined })
      return clearing
    },
    async close(): Promise<void> {
      controller.abort()
      await Promise.allSettled([...flights.values()])
    },
  }
}
