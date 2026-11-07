import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { VisError } from '@vis/domain'
import { TimelineDoc, TIMELINE_LIMITS, FALLBACK_OUTPUT, clipDurationMs, effectiveFades, imageMaxMs, isOverlayTrack, overlayRect, overlayTracks, sourceTimeAt, timelineDurationMs, visibleTextTracks } from '@vis/protocol'
import { abortError, runMedia, tool } from './media'
import { planCaptions, type CaptionFonts } from './timeline-captions'
import type { VideoEncoder } from './video-encoder'
import { streamHasAlpha, type AlphaStream } from './alpha'
import { videoFrameRate } from './frame-rate'
import { requireFfmpeg7 } from './ffmpeg-version'

const exec = promisify(execFile)
// Keep the browser/container rounding allowance aligned with local media operations (0021).
const DURATION_SLACK_MS = 50
const seconds = (ms: number) => (ms / 1000).toFixed(3)
const assFilters = new Map<string, Promise<boolean>>()

/** Cache capabilities by executable, as encoder detection does. */
export function detectAssFilter(ffmpeg: string): Promise<boolean> {
  let pending = assFilters.get(ffmpeg)
  if (!pending) {
    pending = exec(ffmpeg, ['-hide_banner', '-filters'], { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
      .then(({ stdout }) => /^\s*\S+\s+ass\s+V->V\b/m.test(stdout), () => false)
    assFilters.set(ffmpeg, pending)
  }
  return pending
}

export type TimelineSource = {
  kind: 'video' | 'image' | 'audio'
  path: string
  durationMs?: number
  width?: number
  height?: number
}

export type ProbedStreams = {
  video?: { codec: string; width: number; height: number; pixelFormat: string; frameRate: string; timeBase: string; rotation?: number; hasAlpha?: boolean }
  audio?: { codec: string; sampleRate: number; channels: number; channelLayout: string; timeBase: string }
  probedDurationMs?: number
}

export type TimelinePlan = {
  mode: 'copy' | 'encode'
  output: 'video' | 'audio'
  ext: 'mp4' | 'm4a'
  durationMs: number
  cwd?: string
  width?: number
  height?: number
  fps?: number
  args: string[]
  /** Arguments referring to these files are resolved inside the render's temporary directory. */
  files: { name: string; content: string }[]
  /** Files copied into the render's temporary directory under these relative names (caption fonts) */
  copies: { name: string; path: string }[]
}

type Source = TimelineSource & ProbedStreams
type Sources = ReadonlyMap<string, Source>
type Clip = TimelineDoc['tracks'][number]['clips'][number]

function invalid(reason: string, message: string, details: Record<string, string | number> = {}): never {
  throw VisError.of('invalid_params', `timeline.${reason}`, details, message)
}

function fpsValue(rate: string) {
  const [n, d = '1'] = rate.split('/')
  return Number(n) / Number(d)
}

function duration(source: Source) {
  const values = [source.durationMs, source.probedDurationMs].filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0)
  return values.length ? Math.min(...values) : undefined
}

function sourceFor(sources: Sources, clip: Clip) {
  const source = sources.get(clip.source.assetVersionId)
  if (!source) invalid('source_missing', 'A referenced asset version has no registered source', { assetVersionId: clip.source.assetVersionId })
  return source
}

function validateSources(doc: TimelineDoc, sources: Sources) {
  for (const track of doc.tracks) for (const clip of track.clips) {
    const source = sourceFor(sources, clip)
    if ((track.kind !== 'audio' && source.kind === 'audio') || (track.kind === 'audio' && source.kind === 'image')) {
      invalid('source_kind', 'The source kind does not match its timeline track', { clipId: clip.id })
    }
    if (source.kind === 'image') {
      if (clip.speed !== undefined) invalid('speed_image', 'Image clips cannot change speed', { clipId: clip.id })
      if (clip.inMs !== 0) invalid('image_in_point', 'An image clip must start at source time zero')
      if (clip.outMs < TIMELINE_LIMITS.imageMinMs || clip.outMs > imageMaxMs(track)) invalid('image_duration', 'The image display duration is outside the supported range')
    } else {
      const end = duration(source)
      if (!end) invalid('duration_missing', 'Cannot read the source duration')
      if (clip.inMs >= end || clip.outMs > end + DURATION_SLACK_MS) invalid('source_range', 'The clip range must fit within the source duration', { clipId: clip.id })
    }
    if (track.kind === 'audio' && !source.audio) invalid('audio_missing', 'The source has no audio stream')
    if (track.kind !== 'audio' && !source.video) invalid('video_missing', 'The source has no visual stream')
  }
}

function copyEligible(doc: TimelineDoc, sources: Sources) {
  const tracks = doc.tracks.filter(track => track.kind === 'video')
  const track = tracks[0]
  if (visibleTextTracks(doc).length || doc.tracks.some(track => isOverlayTrack(track) && track.clips.length)) return false
  if (tracks.length !== 1 || !track?.clips.length || track.muted || track.volume !== 1 || doc.tracks.some(t => t.kind === 'audio' && t.clips.length)) return false
  const last = track.clips.at(-1)!
  if (timelineDurationMs(doc) > last.startMs + clipDurationMs(last)) return false
  const first = sourceFor(sources, track.clips[0]!)
  if (!first.video || !first.audio) return false
  const signature = (source: Source) => {
    const v = source.video
    const a = source.audio
    return JSON.stringify([v?.codec, v?.width, v?.height, v?.pixelFormat, v?.frameRate, v?.timeBase, v?.rotation ?? 0, a?.codec, a?.sampleRate, a?.channels, a?.channelLayout, a?.timeBase])
  }
  for (const clip of track.clips) {
    const source = sourceFor(sources, clip)
    if (source.kind !== 'video' || source.video?.codec !== 'h264' || source.audio?.codec !== 'aac' || source.video.rotation) return false
    if (!source.video.pixelFormat || !source.video.timeBase || !source.audio.sampleRate || source.audio.channels !== 2 || !source.audio.timeBase || /[\r\n]/.test(source.path)) return false
    if (clip.inMs !== 0 || Math.abs(clip.outMs - (source.probedDurationMs ?? duration(source)!)) > DURATION_SLACK_MS || clip.volume !== 1 || clip.fadeInMs || clip.fadeOutMs || (clip.speed ?? 1) !== 1 || clip.transitionIn) return false
    if (signature(source) !== signature(first)) return false
    if (doc.output && (doc.output.width !== source.video.width || doc.output.height !== source.video.height || doc.output.fps !== fpsValue(source.video.frameRate))) return false
  }
  return first.video.width % 2 === 0 && first.video.height % 2 === 0
}

function commonDirectory(paths: string[]) {
  let dir = dirname(paths[0]!)
  for (const path of paths.slice(1)) {
    while (true) {
      const rel = relative(dir, path)
      if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) break
      const parent = dirname(dir)
      if (parent === dir) return process.cwd()
      dir = parent
    }
  }
  return dir
}

function checkCommandBudget(args: string[], executable = 'ffmpeg') {
  // Include Windows quoting expansion and reserve room for the executable and runtime file paths.
  const length = [executable, ...args].reduce((sum, arg) => sum + arg.length + 3 + (arg.match(/"/g)?.length ?? 0) + (arg.match(/\\*(?="|$)/g) ?? []).reduce((n, match) => n + match.length, 0), 0)
  if (length > 30_000) invalid('too_many_sources', 'The timeline sources exceed the command-line size limit')
}

function concatPath(path: string) {
  // The concat demuxer uses its own quoting rules, independent of the host shell.
  return `'${resolve(path).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
}

/** Compile a validated edit document without filesystem access or process execution. */
export function planTimelineRender(input: TimelineDoc, sources: Sources, opts: { encoder: VideoEncoder; fonts?: CaptionFonts }): TimelinePlan {
  const parsed = TimelineDoc.safeParse(input)
  if (!parsed.success) invalid('invalid_doc', 'The timeline document is invalid')
  const doc = parsed.data
  validateSources(doc, sources)
  const durationMs = timelineDurationMs(doc)
  if (!durationMs) invalid('empty', 'The timeline has no clips to export')
  const videoTrack = doc.tracks.find(track => track.kind === 'video' && track.clips.length)
  const first = videoTrack ? sourceFor(sources, videoTrack.clips[0]!) : undefined
  const visual = first?.video
  // Overlays and text without main video clips draw on a black background.
  const overlays = overlayTracks(doc)
  const blackBase = !videoTrack && (overlays.length > 0 || visibleTextTracks(doc).length > 0)
  const visualOutput = !!videoTrack || blackBase
  const fallback = blackBase ? FALLBACK_OUTPUT : undefined
  const fps = doc.output?.fps ?? fallback?.fps ?? (first?.kind === 'image' ? 30 : visual ? fpsValue(visual.frameRate) : undefined)
  const width = doc.output?.width ?? fallback?.width ?? (visual ? Math.floor(visual.width / 2) * 2 : undefined)
  const height = doc.output?.height ?? fallback?.height ?? (visual ? Math.floor(visual.height / 2) * 2 : undefined)
  if (visualOutput && (!width || !height || !fps || !Number.isFinite(fps))) invalid('output_invalid', 'Cannot determine the output size or frame rate')
  const base = { output: visualOutput ? 'video' as const : 'audio' as const, ext: visualOutput ? 'mp4' as const : 'm4a' as const, durationMs, ...(visualOutput ? { width: width!, height: height!, fps: fps! } : {}) }
  if (copyEligible(doc, sources)) {
    return {
      ...base, mode: 'copy',
      args: ['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart'],
      files: [{ name: 'list.txt', content: videoTrack!.clips.map(clip => `file ${concatPath(sourceFor(sources, clip).path)}`).join('\n') + '\n' }],
      copies: [],
    }
  }

  const graph: string[] = []
  const inputs: { path: string; decoder: string[]; video: string[]; audio: string[] }[] = []
  const byPath = new Map<string, number>()
  const use = (source: Source, kind: 'video' | 'audio') => {
    const path = resolve(source.path)
    let index = byPath.get(path)
    if (index === undefined) {
      index = inputs.length
      byPath.set(path, index)
      inputs.push({ path, decoder: source.video?.codec === 'vp9' && source.video.hasAlpha ? ['-c:v', 'libvpx-vp9'] : [], video: [], audio: [] })
    }
    const uses = inputs[index]![kind]
    const label = `i${index}${kind === 'video' ? 'v' : 'a'}${uses.length}`
    uses.push(label)
    return `[${label}]`
  }
  const videos: string[] = []
  const audios: string[] = []
  for (const track of doc.tracks) for (const [index, clip] of track.clips.entries()) {
    const source = sourceFor(sources, clip)
    const length = clipDurationMs(clip)
    const speed = clip.speed ?? 1
    const start = sourceTimeAt(clip, clip.startMs)
    const fades = effectiveFades(track, index)
    const end = source.kind === 'image' ? clip.outMs : Math.min(clip.outMs, duration(source)!)
    if (track.kind === 'video') {
      const label = `v${videos.length}`
      const opening = source.kind === 'image' ? `loop=loop=-1:size=1:start=0,setpts=N/(30*TB),trim=duration=${seconds(length)}` : `trim=start=${seconds(start)}:end=${seconds(end)},setpts=${speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${speed}`}`
      graph.push(`${use(source, 'video')}${opening},scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},setsar=1,${source.video?.hasAlpha ? 'format=yuva420p,premultiply=inplace=1,' : ''}format=yuv420p,tpad=stop_mode=clone:stop_duration=${seconds(DURATION_SLACK_MS / Math.min(1, speed))},trim=duration=${seconds(length)},settb=AVTB[${label}]`)
      videos.push(`[${label}]`)
    }
    if ((!isOverlayTrack(track) || source.kind === 'video') && !track.muted && track.volume && clip.volume && source.audio) {
      const label = `a${audios.length}`
      const filters = [
        `atrim=start=${seconds(start)}:end=${seconds(end)}`, 'asetpts=PTS-STARTPTS',
        ...(speed === 1 ? [] : speed < 0.5 ? ['atempo=0.5', `atempo=${speed / 0.5}`] : [`atempo=${speed}`]),
        'aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo',
        ...(speed === 1 ? [] : ['apad', `atrim=duration=${seconds(length)}`]),
        `volume=${clip.volume * track.volume}`,
        ...(fades.fadeInMs ? [`afade=t=in:st=0:d=${seconds(fades.fadeInMs)}`] : []),
        ...(fades.fadeOutMs ? [`afade=t=out:st=${seconds(length - fades.fadeOutMs)}:d=${seconds(fades.fadeOutMs)}`] : []),
        `adelay=${clip.startMs}:all=1`,
      ]
      graph.push(`${use(source, 'audio')}${filters.join(',')}[${label}]`)
      audios.push(`[${label}]`)
    }
  }
  let folded: string | undefined
  if (videoTrack?.clips.some(clip => clip.transitionIn)) {
    folded = videos[0]!
    for (let index = 1; index < videos.length; index++) {
      const clip = videoTrack.clips[index]!
      const transition = clip.transitionIn
      const joiner = transition
        ? `xfade=transition=${transition.kind === 'dip' ? 'fadeblack' : 'fade'}:duration=${seconds(transition.durationMs)}:offset=${seconds(clip.startMs)}`
        : 'concat=n=2:v=1:a=0'
      // concat marks its output rate unknown; xfade requires a constant rate and matching timebases.
      graph.push(`${folded}${videos[index]}${joiner},fps=${fps},settb=AVTB[fold${index}]`)
      folded = `[fold${index}]`
    }
  }
  const picture = videos.length
    ? `${folded ?? `${videos.join('')}concat=n=${videos.length}:v=1:a=0,`}tpad=stop_mode=clone:stop_duration=${seconds(durationMs)},trim=duration=${seconds(durationMs)}`
    : blackBase ? `color=c=black:s=${width}x${height}:r=${fps},trim=duration=${seconds(durationMs)},format=yuv420p,setsar=1` : undefined
  let composite = picture
  if (picture && overlays.length) {
    graph.push(`${picture}[base]`)
    let base = '[base]'
    let index = 0
    for (const track of overlays) for (const clip of track.clips) {
      const source = sourceFor(sources, clip)
      const visual = source.video!
      // The probe already applies display rotation to these dimensions.
      const aspect = visual.width / visual.height
      const rect = overlayRect(clip.overlay!, aspect, { width: width!, height: height! })
      const length = clipDurationMs(clip)
      const firstFrame = Math.ceil(clip.startMs * fps! / 1000)
      const speed = clip.speed ?? 1
      const opening = source.kind === 'image'
        ? ['loop=loop=-1:size=1:start=0', `fps=${fps}`, 'settb=AVTB', `trim=duration=${seconds(length)}`]
        : [
          `trim=start=${seconds(sourceTimeAt(clip, clip.startMs))}:end=${seconds(Math.min(clip.outMs, duration(source)!))}`,
          `setpts=${speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${speed}`}`, `fps=${fps}`, 'settb=AVTB',
          `tpad=stop_mode=clone:stop_duration=${seconds(DURATION_SLACK_MS / Math.min(1, speed))}`, `trim=duration=${seconds(length)}`,
        ]
      const filters = [
        ...opening,
        // Evaluate fades on the output frame clock, including starts between output frames.
        `setpts=round((N+${firstFrame})/(${fps}*TB))-${seconds(clip.startMs)}/TB`,
        `scale=${rect.width}:${rect.height}`, 'format=yuva420p', `colorchannelmixer=aa=${clip.overlay!.opacity}`,
        // Framesync passes the base through just after the last overlay PTS, before trim's EOF time.
        // Hold one extra frame and let the half-open timeline interval control visibility.
        'tpad=stop_mode=clone:stop=1',
        ...(clip.fadeInMs ? [`fade=t=in:st=0:d=${seconds(clip.fadeInMs)}:alpha=1`] : []),
        ...(clip.fadeOutMs ? [`fade=t=out:st=${seconds(length - clip.fadeOutMs)}:d=${seconds(clip.fadeOutMs)}:alpha=1`] : []),
        `setpts=PTS+${seconds(clip.startMs)}/TB`,
      ]
      graph.push(`${use(source, 'video')}${filters.join(',')}[ov${index}]`)
      graph.push(`${base}[ov${index}]overlay=x=${rect.x}:y=${rect.y}:eof_action=pass:enable='between(t,${seconds(clip.startMs)},${seconds(clip.startMs + length)})*lt(t,${seconds(clip.startMs + length)})'[over${index}]`)
      base = `[over${index++}]`
    }
    composite = `${base}format=yuv420p`
  }
  // Text is burned in after the picture is assembled, on top of everything else. captions.ass and fonts/
  // live in the render's temporary directory, not in cwd; renderTimeline must point the filter there (D2).
  const captions = picture ? planCaptions(doc, { width: width!, height: height! }, opts.fonts) : undefined
  if (composite) graph.push(`${composite}${captions ? ',ass=captions.ass:fontsdir=fonts' : ''}${opts.encoder.filter ? `,${opts.encoder.filter}` : ''}[video]`)
  // A finite silent bed retains gaps and makes every video export concatenable downstream.
  graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${seconds(durationMs)}[silence]`)
  graph.push(`[silence]${audios.join('')}amix=inputs=${audios.length + 1}:normalize=0,alimiter=level=0:latency=1,apad,atrim=duration=${seconds(durationMs)}[audio]`)
  const splits = inputs.flatMap((input, index) => (['video', 'audio'] as const).flatMap(kind => {
    const uses = input[kind]
    if (!uses.length) return []
    const stream = `${index}:${kind === 'video' ? 'v' : 'a'}:0`
    return [`[${stream}]${uses.length > 1 ? `${kind === 'video' ? 'split' : 'asplit'}=${uses.length}` : kind === 'video' ? 'null' : 'anull'}${uses.map(label => `[${label}]`).join('')}`]
  }))
  const cwd = inputs.length ? commonDirectory(inputs.map(input => input.path)) : process.cwd()
  const args = [
    ...(visualOutput ? opts.encoder.inputArgs ?? [] : []),
    ...inputs.flatMap(input => [...input.decoder, '-i', relative(cwd, input.path) || input.path]),
    '-/filter_complex', 'filter.txt',
    ...(visualOutput ? ['-map', '[video]', '-c:v', opts.encoder.name, ...opts.encoder.args] : ['-vn']),
    '-map', '[audio]', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-t', seconds(durationMs), '-movflags', '+faststart',
  ]
  checkCommandBudget(args)
  return {
    ...base, mode: 'encode',
    cwd, args,
    files: [{ name: 'filter.txt', content: [...splits, ...graph].join(';\n') + '\n' }, ...(captions ? [{ name: 'captions.ass', content: captions.ass }] : [])],
    copies: captions ? captions.fonts.map(font => ({ name: `fonts/${font.name}`, path: font.path })) : [],
  }
}

/** Probe only the first visual and audio streams, matching ffmpeg's explicit stream maps. */
export async function probeTimelineSource(path: string, opts: { ffprobePath?: string; signal?: AbortSignal } = {}): Promise<ProbedStreams> {
  const ffprobe = opts.ffprobePath ?? 'ffprobe'
  if (opts.signal?.aborted) throw abortError(opts.signal)
  try {
    const { stdout } = await exec(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { windowsHide: true, timeout: 30_000, signal: opts.signal, maxBuffer: 4 * 1024 * 1024 })
    type Stream = AlphaStream & { codec_type?: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; avg_frame_rate?: string; r_frame_rate?: string; time_base?: string; sample_rate?: string; channels?: number; channel_layout?: string; duration?: string; disposition?: { attached_pic?: number }; side_data_list?: { rotation?: number }[] }
    const info = JSON.parse(stdout) as { streams?: Stream[]; format?: { duration?: string } }
    const v = info.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
    const a = info.streams?.find(stream => stream.codec_type === 'audio')
    const rotation = v?.side_data_list?.find(data => data.rotation !== undefined)?.rotation ?? 0
    const swapped = Math.abs(rotation % 180) === 90
    const durations = [v?.duration, a?.duration, info.format?.duration].map(value => Number(value) * 1000).filter(value => Number.isFinite(value) && value > 0)
    return {
      ...(v ? { video: { codec: v.codec_name ?? '', width: (swapped ? v.height : v.width) ?? 0, height: (swapped ? v.width : v.height) ?? 0, pixelFormat: v.pix_fmt ?? '', hasAlpha: streamHasAlpha(v), frameRate: fpsValue(v.avg_frame_rate ?? '') > 0 ? v.avg_frame_rate! : v.r_frame_rate ?? '', timeBase: v.time_base ?? '', ...(rotation ? { rotation } : {}) } } : {}),
      ...(a ? { audio: { codec: a.codec_name ?? '', sampleRate: Number(a.sample_rate), channels: a.channels ?? 0, channelLayout: a.channel_layout ?? '', timeBase: a.time_base ?? '' } } : {}),
      ...(durations.length ? { probedDurationMs: durations[0]! } : {}),
    }
  } catch (error) {
    if (opts.signal?.aborted) throw abortError(opts.signal)
    throw VisError.of('unavailable', 'timeline.probe_failed', { tool: ffprobe }, `Cannot probe timeline source: ${tool(error, ffprobe)}`)
  }
}

export type RenderedTimeline = {
  path: string
  kind: 'video' | 'audio'
  mime: string
  width?: number
  height?: number
  durationMs: number
  fps?: number
  mode: TimelinePlan['mode']
  dispose(): Promise<void>
}

export async function renderTimeline(doc: TimelineDoc, sources: ReadonlyMap<string, TimelineSource>, opts: {
  encoder: VideoEncoder
  fonts?: CaptionFonts
  ffmpegPath?: string
  ffprobePath?: string
  signal?: AbortSignal
  onProgress?: (progress: number) => void
}): Promise<RenderedTimeline> {
  const signal = opts.signal ?? new AbortController().signal
  const ffmpeg = opts.ffmpegPath && /[/\\]/.test(opts.ffmpegPath) ? resolve(opts.ffmpegPath) : opts.ffmpegPath ?? 'ffmpeg'
  if (signal.aborted) throw abortError(signal)
  await requireFfmpeg7(ffmpeg)
  if (signal.aborted) throw abortError(signal)
  const parsed = TimelineDoc.safeParse(doc)
  if (!parsed.success) invalid('invalid_doc', 'The timeline document is invalid')
  if (visibleTextTracks(parsed.data).length && !(await detectAssFilter(ffmpeg))) {
    throw VisError.of('unavailable', 'media.captions_unavailable', {}, 'This ffmpeg executable does not provide the ASS caption filter')
  }
  const probed = new Map<string, Source>()
  const paths = new Map<string, ProbedStreams>()
  for (const clip of parsed.data.tracks.flatMap(track => track.clips)) {
    const source = sources.get(clip.source.assetVersionId)
    if (!source) invalid('source_missing', 'A referenced asset version has no registered source')
    const path = resolve(source.path)
    let streams = paths.get(path)
    if (!streams) {
      streams = await probeTimelineSource(path, { ...(opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {}), signal })
      paths.set(path, streams)
    }
    probed.set(clip.source.assetVersionId, { ...source, ...streams })
  }
  const plan = planTimelineRender(parsed.data, probed, opts)
  const dir = await mkdtemp(join(tmpdir(), 'vis-timeline-'))
  const dispose = () => rm(dir, { recursive: true, force: true })
  try {
    for (const file of plan.files) await writeFile(join(dir, file.name), file.content, 'utf8')
    for (const copy of plan.copies) {
      await mkdir(dirname(join(dir, copy.name)), { recursive: true })
      await copyFile(copy.path, join(dir, copy.name))
    }
    const captions = plan.files.some(file => file.name === 'captions.ass')
    // Run caption filters in their own directory: relative ASS paths avoid two layers of filter
    // escaping, including Windows drive colons and Unicode paths. Media inputs stay absolute.
    const args = plan.args.map((arg, index) => {
      if (plan.args[index - 1] === '-/filter_complex' || (plan.mode === 'copy' && plan.args[index - 1] === '-i')) return join(dir, arg)
      if (captions && plan.args[index - 1] === '-i') return resolve(plan.cwd ?? process.cwd(), arg)
      return arg
    })
    const path = join(dir, `output.${plan.ext}`)
    checkCommandBudget([...args, path], ffmpeg)
    let progress = 0
    opts.onProgress?.(0)
    await runMedia(ffmpeg, ['-v', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats', ...args, '-y', path], {
      signal,
      ...(captions ? { cwd: dir } : plan.cwd ? { cwd: plan.cwd } : {}),
      onTime(ms) {
        progress = Math.max(progress, Math.min(1, ms / plan.durationMs))
        opts.onProgress?.(progress)
      },
    })
    if (signal.aborted) throw abortError(signal)
    // Copy mode preserves real source lengths, which can differ from the document within its rounding allowance.
    const output = await probeTimelineSource(path, { ...(opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {}), signal })
    const fps = plan.output === 'video' ? videoFrameRate(output.video?.frameRate) : undefined
    opts.onProgress?.(1)
    return { path, kind: plan.output, mime: plan.output === 'video' ? 'video/mp4' : 'audio/mp4', ...(plan.width ? { width: plan.width, height: plan.height! } : {}), ...(fps !== undefined ? { fps } : {}), durationMs: Math.round(output.probedDurationMs ?? plan.durationMs), mode: plan.mode, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
