import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { VisError } from '@vis/domain'
import { LOCAL_OPERATION_PARAMS, operationKind, type LocalOperation, type MediaKind } from '@vis/protocol'
import { probeSvg } from './svg'
import { alphaDecoder, streamHasAlpha, type AlphaStream } from './alpha'
import { videoFrameRate } from './frame-rate'
import { detectVideoEncoder, SOFTWARE_FIRST_H264_ENCODERS, type EncoderRunner } from './encoders'

const run = promisify(execFile)

const MIME_BY_EXT: Record<string, string> = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
}

export type MediaInfo = { kind: MediaKind; mime: string; width?: number; height?: number; durationMs?: number; fps?: number; hasAlpha?: boolean }
type VideoStream = AlphaStream & { width: number; height: number }
type StreamInfo = { kind: MediaKind; video?: VideoStream; durationMs?: number; fps?: number; hasAudio: boolean }
export type ExtractedFrame = { atMs: number; data: Uint8Array; mime: string; width: number; height: number }
export type MediaRunOptions = { signal?: AbortSignal; onProgress?: (progress: number) => void }
export type ProcessedMedia = { outputs: (MediaInfo & { path: string })[]; dispose(): Promise<void> }

/** Local media processing (ffmpeg / ffprobe); the caller registers the output assets. */
export interface MediaTools {
  readonly paths?: { ffmpegPath?: string; ffprobePath?: string }
  /** expectedMime supplies the known type of an extensionless asset blob. */
  probe(path: string, expectedMime?: string): Promise<MediaInfo>
  /** Extract segment midpoints for a count, or explicit millisecond timestamps, with the long side no larger than maxSide. */
  extractFrames(path: string, selection: number | readonly number[], maxSide?: number): Promise<ExtractedFrame[]>
  process(path: string, operation: LocalOperation, params: Record<string, unknown>, opts?: MediaRunOptions): Promise<ProcessedMedia>
  analyzeSilence(path: string, params?: { minSilenceMs?: number; thresholdDb?: number }, opts?: MediaRunOptions): Promise<{ durationMs: number; pointsMs: number[] }>
}

export function mimeOf(path: string): string | undefined {
  return MIME_BY_EXT[extname(path).toLowerCase()]
}

export function createFfmpegMedia(opts: { ffmpegPath?: string; ffprobePath?: string; encoderRunner?: EncoderRunner } = {}): MediaTools {
  const ffmpeg = opts.ffmpegPath ?? 'ffmpeg'
  const ffprobe = opts.ffprobePath ?? 'ffprobe'

  /** Distinguish visuals and audio by streams, not extension; also works for asset blobs. */
  async function streams(path: string, signal?: AbortSignal): Promise<StreamInfo> {
    let out: string
    try {
      ;({ stdout: out } = await run(ffprobe, ['-v', 'error', '-read_intervals', '%+#1', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,duration,avg_frame_rate,r_frame_rate:stream_tags=alpha_mode:stream_disposition=attached_pic:stream_side_data=rotation:frame_side_data=rotation:format=duration,format_name', '-of', 'json', path], { timeout: 30_000, ...(signal ? { signal } : {}), windowsHide: true }))
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      const detail = tool(error, ffprobe)
      throw VisError.of('invalid_params', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'asset.media_probe_tool_missing' : 'asset.media_probe_failed', { tool: ffprobe, detail }, `Cannot read media file: ${detail}`)
    }
    const info = JSON.parse(out) as { streams?: (AlphaStream & { codec_type?: string; width?: number; height?: number; duration?: string; avg_frame_rate?: string; r_frame_rate?: string; disposition?: { attached_pic?: number }; side_data_list?: { rotation?: number }[] })[]; frames?: { side_data_list?: { rotation?: number }[] }[]; format?: { duration?: string; format_name?: string } }
    const video = info.streams?.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
    const audio = info.streams?.find(stream => stream.codec_type === 'audio')
    if (!video && !audio) throw VisError.of('invalid_params', 'asset.no_media_stream', {}, 'File contains no image, video or audio streams')
    if (video && (!video.width || !video.height)) throw VisError.of('invalid_params', 'asset.dimensions_unreadable', {}, 'Cannot read visual dimensions')
    const duration = [info.format?.duration, audio?.duration, video?.duration].map(Number).find(value => Number.isFinite(value) && value > 0)
    // ffmpeg autorotates before filters; bounds must use the same orientation as browser pixels.
    const rotation = [...(video?.side_data_list ?? []), ...(info.frames?.flatMap(frame => frame.side_data_list ?? []) ?? [])].find(data => data.rotation !== undefined)?.rotation ?? 0
    const swapped = Math.abs(rotation % 180) === 90
    const fps = videoFrameRate(video?.avg_frame_rate, video?.r_frame_rate)
    return {
      kind: video ? (['image2', 'apng', 'png_pipe', 'jpeg_pipe', 'webp_pipe', 'gif'].includes(info.format?.format_name ?? '') ? 'image' : 'video') : 'audio',
      hasAudio: !!audio,
      ...(video ? { video: { ...video, width: (swapped ? video.height : video.width)!, height: (swapped ? video.width : video.height)! } } : {}),
      ...(duration !== undefined ? { durationMs: Math.round(duration * 1000) } : {}),
      ...(fps !== undefined ? { fps } : {}),
    }
  }

  async function probe(path: string, expectedMime?: string, signal?: AbortSignal): Promise<MediaInfo> {
    const mime = mimeOf(path) ?? expectedMime
    if (!mime) throw VisError.of('invalid_params', 'asset.unsupported_extension', { extension: extname(path) }, `Unsupported file type: ${extname(path) || '(no extension)'}`)
    if (mime === 'image/svg+xml') return probeSvg(path)
    const { kind, video, durationMs, fps } = await streams(path, signal)
    if ((mime.startsWith('image/') && kind !== 'image') || (mime.startsWith('audio/') && kind !== 'audio') || (mime.startsWith('video/') && kind === 'image')) throw VisError.of('invalid_params', 'asset.extension_mismatch', {}, 'File content does not match its extension')
    if (!video) return { kind: 'audio', mime: mime.replace(/^video\//, 'audio/'), ...(durationMs !== undefined ? { durationMs } : {}) }
    return { kind, mime, width: video.width, height: video.height, ...(kind === 'video' ? { hasAlpha: streamHasAlpha(video) } : {}), ...(kind === 'video' && durationMs !== undefined ? { durationMs } : {}), ...(kind === 'video' && fps !== undefined ? { fps } : {}) }
  }

  return {
    paths: { ffmpegPath: ffmpeg, ffprobePath: ffprobe },
    probe,
    async process(path, operation, params, options = {}) {
      const parsed = LOCAL_OPERATION_PARAMS[operation].safeParse(params)
      if (!parsed.success) throw mediaError('invalid_params', 'media.invalid_params', 'Invalid local operation parameters')
      const signal = options.signal ?? new AbortController().signal
      const info = await streams(path, signal)
      if (info.kind !== operationKind(operation)) throw mediaError('invalid_params', 'media.kind_mismatch', 'The source media kind does not match the operation')
      const decoder = info.video ? alphaDecoder(info.video) : []
      const durationMs = info.durationMs ?? 0
      const p = parsed.data as Record<string, any>
      const range = (start: number, end: number) => {
        if (!durationMs || start < 0 || end > durationMs || start >= end) throw mediaError('invalid_params', 'media.time_out_of_bounds', 'The time range must be within the source duration')
      }
      const plans: { args: string[]; ext: string; durationMs?: number }[] = []
      const seconds = (ms: number) => (ms / 1000).toFixed(3)
      const crop = (x: number, y: number, w: number, h: number) => plans.push({ args: [...decoder, '-i', path, '-vf', `crop=${w}:${h}:${x}:${y}:exact=1`, '-frames:v', '1'], ext: 'png' })
      const trim = async (start: number, end: number, video: boolean) => {
        range(start, end)
        const encoder = video ? await detectVideoEncoder({ ffmpegPath: ffmpeg, priority: SOFTWARE_FIRST_H264_ENCODERS, ...(opts.encoderRunner ? { exec: opts.encoderRunner } : {}) }) : undefined
        plans.push({ args: [...(encoder?.inputArgs ?? []), ...decoder, '-i', path, '-ss', seconds(start), '-t', seconds(end - start), ...(video ? ['-map', '0:v:0', '-map', '0:a?', ...(encoder!.filter ? ['-vf', encoder!.filter] : []), '-c:v', encoder!.name, ...encoder!.args, '-c:a', 'aac'] : ['-vn', '-c:a', 'pcm_s16le'])], ext: video ? 'mp4' : 'wav', durationMs: end - start })
      }
      const clampEnd = (end: number) => end > durationMs && end <= durationMs + 50 ? durationMs : end
      switch (operation) {
        case 'image.crop': {
          if (p.x + p.w > info.video!.width || p.y + p.h > info.video!.height) throw mediaError('invalid_params', 'media.crop_out_of_bounds', 'The crop rectangle must fit within the source image')
          crop(p.x, p.y, p.w, p.h)
          break
        }
        case 'image.gridSplit': {
          const { width, height } = info.video!
          if (width < p.cols || height < p.rows) throw mediaError('invalid_params', 'media.grid_too_small', 'The image must have at least one pixel per grid cell')
          for (let row = 0; row < p.rows; row++) for (let col = 0; col < p.cols; col++) {
            const x = Math.floor(col * width / p.cols)
            const y = Math.floor(row * height / p.rows)
            crop(x, y, Math.floor((col + 1) * width / p.cols) - x, Math.floor((row + 1) * height / p.rows) - y)
          }
          break
        }
        case 'video.trim': await trim(p.startMs, clampEnd(p.endMs), true); break
        case 'audio.trim': await trim(p.startMs, clampEnd(p.endMs), false); break
        case 'video.frame': {
          const atMs = clampEnd(p.atMs)
          if (!durationMs || atMs > durationMs) throw mediaError('invalid_params', 'media.time_out_of_bounds', 'The frame time must be within the source duration')
          // End-of-clip seeks may land after the final frame PTS. Decode the final segment and retain its last frame.
          plans.push({ args: atMs === durationMs
            ? ['-sseof', seconds(-Math.min(durationMs, 2000)), ...decoder, '-i', path, '-an', '-update', '1', '-fps_mode', 'passthrough']
            : ['-ss', seconds(atMs), ...decoder, '-i', path, '-frames:v', '1'], ext: 'png' })
          break
        }
        case 'video.exportMov': {
          let encoders: string
          try { ({ stdout: encoders } = await run(ffmpeg, ['-hide_banner', '-encoders'], { signal, timeout: 30_000, windowsHide: true })) }
          catch (error) {
            if (signal.aborted) throw abortError(signal)
            throw mediaError('unavailable', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'media.tool_missing' : 'media.process_failed', 'Cannot inspect local media encoders')
          }
          if (!/\bprores_ks\b/.test(encoders)) throw mediaError('unavailable', 'media.prores_encoder_missing', 'This ffmpeg lacks prores_ks; MOV ProRes 4444 export is unavailable')
          plans.push({ args: [...decoder, '-i', path, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-c:a', 'pcm_s24le'], ext: 'mov', durationMs })
          break
        }
        case 'video.extractAudio':
          if (!info.hasAudio) throw mediaError('invalid_params', 'media.no_audio', 'The video contains no audio stream')
          plans.push({ args: [...decoder, '-i', path, '-vn', '-map', '0:a:0', '-c:a', 'pcm_s16le'], ext: 'wav', durationMs })
          break
        case 'audio.split': {
          const points = [0, ...p.pointsMs as number[], durationMs]
          for (let i = 1; i < points.length; i++) await trim(points[i - 1]!, points[i]!, false)
          break
        }
        case 'audio.speed':
          if (!durationMs) throw mediaError('invalid_params', 'media.duration_missing', 'Cannot read the source duration')
          plans.push({ args: [...decoder, '-i', path, '-vn', '-af', `atempo=${p.rate}`, '-c:a', 'pcm_s16le'], ext: 'wav', durationMs: durationMs / p.rate })
          break
      }
      const dir = await mkdtemp(join(tmpdir(), 'vis-process-'))
      const dispose = () => rm(dir, { recursive: true, force: true })
      try {
        const outputs: ProcessedMedia['outputs'] = []
        for (const [i, plan] of plans.entries()) {
          const file = join(dir, `${i}.${plan.ext}`)
          await runMedia(ffmpeg, ['-v', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats', ...plan.args, '-y', file], {
            signal,
            onTime: ms => options.onProgress?.((i + Math.min(1, ms / (plan.durationMs || 1))) / plans.length),
          })
          // A timestamp after the final frame but before container EOF still refers to the last displayed frame.
          if (operation === 'video.frame' && !existsSync(file)) {
            await runMedia(ffmpeg, ['-v', 'error', '-nostdin', '-sseof', '-1', ...decoder, '-i', path, '-an', '-update', '1', '-fps_mode', 'passthrough', '-y', file], { signal })
          }
          const outputInfo = await probe(file, undefined, signal)
          outputs.push({ ...outputInfo, path: file })
          options.onProgress?.((i + 1) / plans.length)
        }
        return { outputs, dispose }
      } catch (error) {
        await dispose()
        if (signal.aborted) throw abortError(signal)
        throw error
      }
    },
    async analyzeSilence(path, params = {}, options = {}) {
      const signal = options.signal ?? new AbortController().signal
      const info = await streams(path, signal)
      if (info.kind !== 'audio') throw mediaError('invalid_params', 'media.kind_mismatch', 'Silence analysis requires an audio source')
      if (!info.durationMs) throw mediaError('invalid_params', 'media.duration_missing', 'Cannot read the source duration')
      const min = params.minSilenceMs ?? 500
      const threshold = params.thresholdDb ?? -35
      if (!Number.isInteger(min) || min < 100 || min > 5000 || !Number.isFinite(threshold) || threshold < -90 || threshold > -10) throw mediaError('invalid_params', 'media.invalid_params', 'Invalid silence detection parameters')
      const pointsMs: number[] = []
      let start: number | undefined
      await runMedia(ffmpeg, ['-v', 'info', '-nostdin', '-i', path, '-af', `silencedetect=noise=${threshold}dB:d=${min / 1000}`, '-f', 'null', '-'], {
        signal,
        onLine(line) {
          const opening = /silence_start: ([\d.]+)/.exec(line)
          if (opening) start = Number(opening[1]) * 1000
          const closing = /silence_end: ([\d.]+)/.exec(line)
          if (closing && start !== undefined) {
            pointsMs.push(Math.round((start + Number(closing[1]) * 1000) / 2))
            start = undefined
          }
        },
      })
      if (start !== undefined) pointsMs.push(Math.round((start + info.durationMs) / 2))
      return { durationMs: info.durationMs, pointsMs: [...new Set(pointsMs)].filter(ms => ms > 0 && ms < info.durationMs!) }
    },
    async extractFrames(path, selection, maxSide = 1024) {
      const info = await streams(path)
      if (!info.video || !info.durationMs) throw VisError.of('invalid_params', 'asset.frame_source_invalid', {}, 'Frames can only be extracted from videos with a duration')
      const times = typeof selection === 'number'
        ? Array.from({ length: selection }, (_, i) => Math.floor(((i + 0.5) * info.durationMs!) / selection))
        : selection
      if (times.some(atMs => !Number.isInteger(atMs) || atMs < 0 || atMs >= info.durationMs!)) {
        throw VisError.of('invalid_params', 'asset.frame_time_invalid', {}, 'Frame timestamps must be nonnegative milliseconds before the video end')
      }
      const dir = await mkdtemp(join(tmpdir(), 'vis-frames-'))
      try {
        const frames: ExtractedFrame[] = []
        const scale = info.video.width >= info.video.height ? `scale='min(${maxSide},iw)':-2` : `scale=-2:'min(${maxSide},ih)'`
        for (const [i, atMs] of times.entries()) {
          const file = join(dir, `${i}.jpg`)
          try {
            await run(ffmpeg, ['-v', 'error', '-ss', (atMs / 1000).toFixed(3), ...alphaDecoder(info.video), '-i', path, '-frames:v', '1', '-vf', scale, '-q:v', '3', '-y', file])
          } catch (error) {
            const detail = tool(error, ffmpeg)
            throw VisError.of('unavailable', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'asset.frame_tool_missing' : 'asset.frame_extraction_failed', { tool: ffmpeg, detail }, `Frame extraction failed: ${detail}`)
          }
          const data = await readFile(file)
          const size = await streams(file)
          if (!size.video) throw VisError.of('unavailable', 'asset.frame_image_missing', {}, 'Extracted frame has no visual content')
          frames.push({ atMs, data, mime: 'image/jpeg', width: size.video.width, height: size.video.height })
        }
        return frames
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}

export function tool(error: unknown, name: string): string {
  if ((error as { code?: string }).code === 'ENOENT') return `${name} not found; install ffmpeg first`
  const stderr = (error as { stderr?: string }).stderr?.trim()
  return stderr || (error instanceof Error ? error.message : String(error))
}

export function mediaError(code: 'invalid_params' | 'unavailable', reason: string, message: string) {
  return VisError.of(code, reason, {}, message)
}

export function abortError(signal: AbortSignal) {
  if (signal.reason instanceof VisError) return signal.reason
  return mediaError('unavailable', signal.reason?.name === 'TimeoutError' ? 'media.timeout' : 'media.interrupted', 'Local media processing stopped')
}

/** Read both pipes continuously; retain a bounded diagnostic tail and wait for exit before deleting temporary files. */
export function runMedia(executable: string, args: string[], opts: { signal: AbortSignal; cwd?: string; onTime?: (ms: number) => void; onLine?: (line: string) => void }): Promise<void> {
  if (opts.signal.aborted) return Promise.reject(abortError(opts.signal))
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(opts.cwd ? { cwd: opts.cwd } : {}) })
    let stderr = ''
    let pendingOut = ''
    let pendingErr = ''
    const stop = () => child.kill('SIGKILL')
    opts.signal.addEventListener('abort', stop, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      pendingOut += chunk
      const lines = pendingOut.split(/\r?\n/)
      pendingOut = lines.pop()!
      for (const line of lines) {
        const time = /^out_time_us=(\d+)$/.exec(line)
        if (time) opts.onTime?.(Number(time[1]) / 1000)
      }
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-65536)
      pendingErr += chunk
      const lines = pendingErr.split(/\r?\n/)
      pendingErr = lines.pop()!.slice(-65536)
      for (const line of lines) opts.onLine?.(line)
    })
    child.once('error', error => {
      opts.signal.removeEventListener('abort', stop)
      reject(mediaError('unavailable', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'media.tool_missing' : 'media.process_failed', 'Cannot start local media processing'))
    })
    child.once('close', code => {
      opts.signal.removeEventListener('abort', stop)
      if (opts.signal.aborted) reject(abortError(opts.signal))
      else if (code !== 0) reject(mediaError('unavailable', 'media.process_failed', `Local media processing failed: ${stderr.trim()}`))
      else {
        if (pendingErr) opts.onLine?.(pendingErr)
        resolve()
      }
    })
    if (opts.signal.aborted) stop()
  })
}
