import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FALLBACK_OUTPUT, overlayOpacityAt, timelineDurationMs, type TimelineClip, type TimelineDoc, type TimelineTrack } from '@vis/protocol'
import { mimeOf } from './media'
import { planTimelineRender, probeTimelineSource, renderTimeline, type ProbedStreams, type RenderedTimeline, type TimelineSource } from './timeline-render'
import type { VideoEncoder } from './video-encoder'
import { detectVideoEncoder } from './encoders'

const encoder: VideoEncoder = { name: 'libx264', args: ['-preset', 'ultrafast', '-crf', '23'], hardware: false }
const streams: ProbedStreams = {
  video: { codec: 'h264', width: 320, height: 240, pixelFormat: 'yuv420p', frameRate: '30/1', timeBase: '1/15360' },
  audio: { codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo', timeBase: '1/48000' },
}
type Source = TimelineSource & ProbedStreams
const source = (name = 'one', overrides: Partial<Source> = {}): Source => ({
  kind: 'video', path: resolve('timeline sources', `${name}.mp4`), durationMs: 2000, ...structuredClone(streams), ...overrides,
})
const clip = (id = 'one', overrides: Partial<TimelineClip> = {}): TimelineClip => ({
  id: `clip-${id}`, source: { nodeId: `node-${id}`, assetVersionId: id },
  startMs: 0, inMs: 0, outMs: 2000, volume: 1, fadeInMs: 0, fadeOutMs: 0, ...overrides,
})
const track = (clips: TimelineClip[], overrides: Partial<TimelineTrack> = {}): TimelineTrack => ({
  id: 'video-track', kind: 'video', muted: false, volume: 1, clips, ...overrides,
})
const doc = (...tracks: TimelineTrack[]): TimelineDoc => ({ version: 1, tracks })
const plan = (d: TimelineDoc, sources = new Map([['one', source()]]), e = encoder) => planTimelineRender(d, sources, { encoder: e })
const encodeDoc = () => doc(track([clip('one', { volume: 0.8 })]))
const overlayClip = (overrides: Partial<TimelineClip> = {}) => clip('image', { overlay: { x: 0.5, y: 0.5, width: 0.5, opacity: 1 }, ...overrides })
const overlayTrack = (clips = [overlayClip()], overrides: Partial<TimelineTrack> = {}) => track(clips, { id: 'overlay', kind: 'overlay', ...overrides })
function snapshot(d: TimelineDoc, sources?: Map<string, Source>) {
  const result = plan(d, sources)
  return { ...result, cwd: '<sources>' }
}

describe('Timeline render planning', () => {
  it.each([['25/1', 25], ['30000/1001', 30000 / 1001]] as const)('matches the first source frame rate %s when output is absent', (frameRate, fps) => {
    const result = plan(encodeDoc(), new Map([['one', source('one', { video: { ...streams.video!, frameRate } })]]))
    expect(result.fps).toBe(fps)
  })
  it('snapshots video only', () => {
    expect(snapshot(encodeDoc())).toMatchSnapshot()
  })
  it('snapshots a sped-up video with timeline fades', () => {
    expect(snapshot(doc(track([clip('one', { speed: 2, fadeInMs: 200, fadeOutMs: 300 })])))).toMatchSnapshot()
  })
  it('snapshots quarter-speed audio as two pitch-preserving tempo filters', () => {
    const result = snapshot(doc(track([clip('one', { speed: 0.25, startMs: 500, fadeOutMs: 500 })], { kind: 'audio' })))
    expect(result.files[0]!.content).toContain('atempo=0.5,atempo=0.5')
    expect(result).toMatchSnapshot()
  })
  it.each(['crossfade', 'dip'] as const)('snapshots a %s and the clips own audio crossfade', kind => {
    expect(snapshot(doc(track([clip('one'), clip('one', { id: 'second', startMs: 1500, transitionIn: { kind, durationMs: 500 } })])))).toMatchSnapshot()
  })
  it('snapshots mixed concat and transition folds with accumulated timeline offsets', () => {
    const clips = [clip('one'), clip('one', { id: 'two', startMs: 2000 }), clip('one', { id: 'three', startMs: 3500, transitionIn: { kind: 'dip', durationMs: 500 } }), clip('one', { id: 'four', startMs: 5500 }), clip('one', { id: 'five', startMs: 7000, transitionIn: { kind: 'crossfade', durationMs: 500 } })]
    const result = snapshot(doc(track(clips)))
    expect(result.files[0]!.content).toContain('offset=7.000')
    expect(result).toMatchSnapshot()
  })
  it('plans 200 transitions entirely in the filter file', () => {
    const clips = Array.from({ length: 200 }, (_, index) => clip('one', {
      id: `clip-${index}`, startMs: index * 1500,
      ...(index ? { transitionIn: { kind: 'crossfade' as const, durationMs: 500 } } : {}),
    }))
    const result = plan(doc(track(clips)))
    expect(result.args.join(' ').length).toBeLessThan(1000)
    expect(result.files[0]!.content.match(/xfade=transition=fade:/g)).toHaveLength(199)
    expect(result.durationMs).toBe(300500)
  })
  it('snapshots video and a music track', () => {
    expect(snapshot(doc(track([clip()]), track([clip('music', { outMs: 3000, fadeOutMs: 500 })], { id: 'music', kind: 'audio', volume: 0.5 })), new Map([
      ['one', source()], ['music', { kind: 'audio', path: resolve('timeline sources/music.wav'), durationMs: 3000, audio: streams.audio! }],
    ]))).toMatchSnapshot()
  })
  it('snapshots audio with gaps, fades and a muted track', () => {
    const sources = new Map([['music', { kind: 'audio' as const, path: resolve('timeline sources/music.wav'), durationMs: 3000, audio: streams.audio! }]])
    expect(snapshot(doc(
      track([clip('music', { id: 'a', startMs: 500, outMs: 1000, fadeInMs: 200, fadeOutMs: 300 })], { id: 'track-a', kind: 'audio' }),
      track([clip('music', { id: 'b', startMs: 2000, outMs: 1000 })], { id: 'track-b', kind: 'audio', volume: 0.7 }),
      track([clip('music', { id: 'c', startMs: 4000, outMs: 1000 })], { id: 'track-c', kind: 'audio', muted: true }),
    ), sources)).toMatchSnapshot()
  })
  it('snapshots an image clip and rounds odd dimensions down', () => {
    expect(snapshot(doc(track([clip()])), new Map([['one', { kind: 'image', path: resolve('timeline sources/card.png'), video: { ...streams.video!, width: 321, height: 241 } }]]))).toMatchSnapshot()
  })
  it('snapshots a different output aspect and encoder upload filter', () => {
    const d = { ...encodeDoc(), output: { width: 640, height: 360, fps: 24 } }
    const result = plan(d, undefined, { ...encoder, inputArgs: ['-init_hw_device', 'vaapi=gpu'], filter: 'format=nv12,hwupload' })
    expect({ ...result, cwd: '<sources>' }).toMatchSnapshot()
    expect(result.args.slice(0, 2)).toEqual(['-init_hw_device', 'vaapi=gpu'])
  })
  it('snapshots video without audio with a silent output bed', () => {
    const s = source()
    delete s.audio
    expect(snapshot(doc(track([clip()])), new Map([['one', s]]))).toMatchSnapshot()
  })
  it('snapshots reuse of the same source with split and asplit', () => {
    expect(snapshot(doc(track([clip('one', { volume: 0.8 }), clip('one', { id: 'two', startMs: 2000 })])))).toMatchSnapshot()
  })
  it('deduplicates different version IDs that reference the same file', () => {
    const sources = new Map([['one', source()], ['two', source()]])
    const result = plan(doc(track([clip('one', { volume: 0.8 }), clip('two', { startMs: 2000 })])), sources)
    expect(result.args.filter(arg => arg === '-i')).toHaveLength(1)
    expect(result.files[0]!.content).toContain('split=2')
    expect(result.files[0]!.content).toContain('asplit=2')
  })
  it('keeps 200 video clips and four times 200 audio clips outside the command line', () => {
    const clips = Array.from({ length: 200 }, (_, i) => clip('one', { id: `v${i}`, startMs: i * 2000, volume: 0.8 }))
    const audio = Array.from({ length: 4 }, (_, ti) => track(clips.map((c, i) => ({ ...c, id: `a${ti}-${i}` })), { id: `audio-${ti}`, kind: 'audio' }))
    const result = plan(doc(track(clips), ...audio))
    expect(result.args.filter(arg => arg === '-i')).toHaveLength(1)
    expect(result.args.join(' ').length).toBeLessThan(1000)
    expect(result.files[0]!.content.length).toBeGreaterThan(200_000)
    expect(result.files[0]!.content.length).toBeLessThan(500_000)
  })
  it('keeps 1000 distinct nearby sources within the Windows argument limit', () => {
    const sources = new Map<string, Source>()
    const tracks = Array.from({ length: 5 }, (_, ti) => track(Array.from({ length: 200 }, (_, ci) => {
      const id = `${ti}-${ci}`
      sources.set(id, source(id))
      return clip(id, { startMs: ci * 2000, volume: 0.8 })
    }), { id: `t${ti}`, kind: ti ? 'audio' : 'video' }))
    const result = plan(doc(...tracks), sources)
    expect(result.args.filter(arg => arg === '-i')).toHaveLength(1000)
    expect(result.args.join(' ').length).toBeLessThan(30_000)
    expect(result.args).toContain('0-0.mp4')
    expect(result.cwd).toBe(resolve('timeline sources'))
  })
  it('rejects an over-budget command before spawning ffmpeg', () => {
    const sources = new Map<string, Source>()
    const clips = Array.from({ length: 200 }, (_, i) => {
      sources.set(String(i), source(`${'a'.repeat(200)}-${i}`))
      return clip(String(i), { startMs: i * 2000, volume: 0.8 })
    })
    expect(() => plan(doc(track(clips)), sources)).toThrowError(expect.objectContaining({ code: 'invalid_params', details: { reason: 'timeline.too_many_sources', params: {} } }))
  })
  it('clamps the existing 50 ms duration allowance to real source timestamps', () => {
    const result = plan(doc(track([clip('one', { outMs: 2050, volume: 0.8 })])))
    expect(result.files[0]!.content).toContain('trim=start=0.000:end=2.000')
    expect(result.files[0]!.content).toContain('atrim=start=0.000:end=2.000')
    expect(result.durationMs).toBe(2050)
  })
  it('retains a silent audio-only timeline with all tracks muted', () => {
    const result = plan(doc(track([clip()], { kind: 'audio', muted: true })))
    expect(result.args).toContain('-vn')
    expect(result.args).not.toContain('-i')
    expect(result.files[0]!.content).toContain('anullsrc')
  })
})

describe('Timeline image overlay planning', () => {
  const sources = () => new Map<string, Source>([
    ['one', source()],
    ['image', { kind: 'image', path: resolve('timeline sources/logo.png'), video: { ...streams.video!, width: 160, height: 80 } }],
  ])
  it('composites in track order before captions and the encoder filter without mixing image audio', () => {
    const available = sources()
    // Even an image container reporting audio must never contribute overlay sound.
    available.get('image')!.audio = streams.audio!
    const document = doc(track([clip()]), overlayTrack([
      overlayClip({ startMs: 500, outMs: 1000, fadeInMs: 200, fadeOutMs: 300, overlay: { x: 0.25, y: 0.5, width: 0.5, opacity: 0.5 } }),
    ]), overlayTrack([overlayClip({ id: 'upper', overlay: { x: 0.75, y: 0.5, width: 0.25, opacity: 1 } })], { id: 'upper-track' }))
    document.textTracks = [{ id: 'text', hidden: false, clips: [{ id: 'caption', startMs: 0, durationMs: 2000, text: 'Above the logo', style: { preset: 'subtitle' }, fadeInMs: 0, fadeOutMs: 0 }] }]
    const result = planTimelineRender(document, available, { encoder: { ...encoder, filter: 'format=nv12' }, fonts: new Map([['builtin:noto-sans-sc', { family: 'Noto Sans SC', path: '/fonts/noto.ttf' }]]) })
    const graph = result.files[0]!.content
    expect(result.mode).toBe('encode')
    expect(result.args.filter(arg => arg === '-i')).toHaveLength(2)
    expect(graph).toContain('scale=160:80,format=yuva420p,colorchannelmixer=aa=0.5,tpad=stop_mode=clone:stop=1,fade=t=in:st=0:d=0.200:alpha=1,fade=t=out:st=0.700:d=0.300:alpha=1,setpts=PTS+0.500/TB')
    expect(graph).toContain("[base][ov0]overlay=x=0:y=80:eof_action=pass:enable='between(t,0.500,1.500)*lt(t,1.500)'[over0]")
    expect(graph).toContain("[over0][ov1]overlay=x=200:y=100:eof_action=pass:enable='between(t,0.000,2.000)*lt(t,2.000)'[over1]")
    expect(graph).toContain('[over1]format=yuv420p,ass=captions.ass:fontsdir=fonts,format=nv12[video]')
    expect(graph).not.toContain('[1:a:0]')
    expect(graph).toContain('amix=inputs=2:normalize=0')
    expect({ args: result.args, graph }).toMatchSnapshot()
  })
  it('skips hidden overlay pictures while disabling copy mode', () => {
    const document = doc(track([clip()]), overlayTrack(undefined, { hidden: true }))
    const result = plan(document, sources())
    expect(result.mode).toBe('encode')
    expect(result.args.filter(arg => arg === '-i')).toHaveLength(1)
    expect(result.files[0]!.content).not.toContain('overlay=')
  })
  it('keeps a hidden overlay tail in the document duration instead of copying a shorter picture', () => {
    const result = plan(doc(track([clip()]), overlayTrack([overlayClip({ outMs: 4000 })], { hidden: true })), sources())
    expect(result.mode).toBe('encode')
    expect(result.durationMs).toBe(4000)
    expect(result.files[0]!.content).not.toContain('overlay=')
  })
  it.each([undefined, { width: 640, height: 360, fps: 24 }])('uses a black base without a main picture with output %j', output => {
    const result = plan({ ...doc(overlayTrack()), ...(output ? { output } : {}) }, sources())
    const expected = output ?? FALLBACK_OUTPUT
    expect(result).toMatchObject({ mode: 'encode', output: 'video', ext: 'mp4', ...expected })
    expect(result.files[0]!.content).toContain(`color=c=black:s=${expected.width}x${expected.height}:r=${expected.fps}`)
    expect(result.files[0]!.content).toContain('[base][ov0]overlay=')
  })
  it('takes rotation-aware aspect from the probe rather than asset metadata', () => {
    const available = sources()
    // probeTimelineSource returns dimensions after applying the display rotation.
    Object.assign(available.get('image')!, { width: 900, height: 900, video: { ...streams.video!, width: 80, height: 160, rotation: -90 } })
    const result = plan(doc(track([clip()]), overlayTrack()), available)
    expect(result.files[0]!.content).toContain('scale=160:320,format=yuva420p')
    expect(result.files[0]!.content).toContain('overlay=x=80:y=-40:')
  })
  it('permits whole-film overlay images and keeps the main image duration limit', () => {
    expect(plan(doc(overlayTrack([overlayClip({ outMs: 60_000 })])), sources()).durationMs).toBe(60_000)
    expect(() => plan(doc(track([clip('image', { outMs: 60_000 })])), sources())).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'timeline.image_duration' }) }))
  })
  it('rejects audio on visible and hidden overlay tracks with the correct reason', () => {
    const available = sources()
    available.get('image')!.kind = 'audio'
    for (const hidden of [false, true]) expect(() => plan(doc(overlayTrack(undefined, { hidden })), available)).toThrowError(expect.objectContaining({ code: 'invalid_params', details: expect.objectContaining({ reason: 'timeline.source_kind' }) }))
  })
  it('requires a visual stream for overlay images', () => {
    const available = sources()
    delete available.get('image')!.video
    expect(() => plan(doc(overlayTrack()), available)).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'timeline.video_missing' }) }))
  })
})

describe('Timeline video overlay planning', () => {
  const c = () => overlayClip({ source: { nodeId: 'node-one', assetVersionId: 'one' }, startMs: 500, inMs: 250, outMs: 1750, speed: 2, volume: 0.5, fadeInMs: 200, fadeOutMs: 300 })
  it.each([1, 2, 0.25])('trims and retimes overlay video at speed %s before the shared picture and sound fades', speed => {
    const result = plan({ ...doc(overlayTrack([{ ...c(), speed }], { volume: 0.4 })), output: { width: 320, height: 240, fps: 24 } })
    const graph = result.files[0]!.content
    const length = 1.5 / speed
    expect(graph).toContain(`trim=start=0.250:end=1.750,setpts=${speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${speed}`},fps=24,settb=AVTB,tpad=stop_mode=clone:stop_duration=${(0.05 / Math.min(1, speed)).toFixed(3)},trim=duration=${length.toFixed(3)},setpts=round((N+12)/(24*TB))-0.500/TB`)
    expect(graph).toContain('scale=160:120,format=yuva420p,colorchannelmixer=aa=1,tpad=stop_mode=clone:stop=1,fade=t=in:st=0:d=0.200:alpha=1')
    expect(graph).toContain(`fade=t=out:st=${(length - 0.3).toFixed(3)}:d=0.300:alpha=1,setpts=PTS+0.500/TB`)
    expect(graph).toContain('atrim=start=0.250:end=1.750,asetpts=PTS-STARTPTS')
    expect(graph).toContain(`volume=0.2,afade=t=in:st=0:d=0.200,afade=t=out:st=${(length - 0.3).toFixed(3)}:d=0.300,adelay=500:all=1`)
    if (speed !== 1) expect(graph).toContain(speed === 0.25 ? 'atempo=0.5,atempo=0.5' : 'atempo=2')
    expect(graph).toContain('amix=inputs=2:normalize=0')
  })
  it.each([
    ['muted track', { muted: true }, {}],
    ['zero track volume', { volume: 0 }, {}],
    ['zero clip volume', {}, { volume: 0 }],
  ] as const)('omits overlay sound for %s', (_name, overrides, clipOverrides) => {
    const result = plan(doc(overlayTrack([{ ...c(), ...clipOverrides }], overrides)))
    expect(result.files[0]!.content).not.toContain('[0:a:0]')
    expect(result.files[0]!.content).toContain('amix=inputs=1:normalize=0')
    expect(result.files[0]!.content).toContain('overlay=')
  })
  it('keeps hidden overlay sound and disables copy even within the main picture duration', () => {
    const result = plan(doc(track([clip()]), overlayTrack([c()], { hidden: true, volume: 0.4 })))
    expect(result.mode).toBe('encode')
    const graph = result.files[0]!.content
    expect(graph).not.toContain('overlay=')
    expect(graph).toContain('volume=0.2,afade=t=in:st=0:d=0.200')
    expect(graph).toContain('amix=inputs=3:normalize=0')
  })
  it('renders an audio-less overlay video using only the silent audio bed', () => {
    const available = new Map([['one', source()]])
    delete available.get('one')!.audio
    const result = plan(doc(overlayTrack([c()])), available)
    expect(result.files[0]!.content).toContain('overlay=')
    expect(result.files[0]!.content).not.toContain('[0:a:0]')
    expect(result.files[0]!.content).toContain('amix=inputs=1:normalize=0')
  })
  it.each([false, true])('validates video duration, range, stream and speed when hidden is %s', hidden => {
    const cases: [string, (source: Source, clip: TimelineClip) => void][] = [
      ['duration_missing', s => { delete s.durationMs }],
      ['source_range', (_s, c) => { c.outMs = 2051 }],
      ['source_range', (_s, c) => { Object.assign(c, { inMs: 2000, outMs: 2050, fadeInMs: 0, fadeOutMs: 0 }) }],
      ['video_missing', s => { delete s.video }],
      ['invalid_doc', (_s, c) => { c.speed = 5 }],
    ]
    for (const [reason, mutate] of cases) {
      const s = source()
      const overlay = c()
      mutate(s, overlay)
      expect(() => plan(doc(overlayTrack([overlay], { hidden })), new Map([['one', s]]))).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: `timeline.${reason}` }) }))
    }
  })
})

describe('Timeline copy eligibility', () => {
  const make = () => ({ d: doc(track([clip(), clip('two', { startMs: 2000 })])), sources: new Map([['one', source()], ['two', source('two')]]) })
  it('copies whole identical H.264 and stereo AAC sources, allowing empty audio tracks', () => {
    const { d, sources } = make()
    expect(plan(d, sources).mode).toBe('copy')
    d.tracks.push(track([], { id: 'empty', kind: 'audio' }))
    expect(plan(d, sources).mode).toBe('copy')
    d.output = { width: 320, height: 240, fps: 30 }
    expect(plan(d, sources).mode).toBe('copy')
  })
  const cases: [string, (d: TimelineDoc, sources: Map<string, Source>) => void][] = [
    ['a music clip', d => { d.tracks.push(track([clip('one', { id: 'music-clip' })], { id: 'music', kind: 'audio' })) }],
    ['a muted music clip', d => { d.tracks.push(track([clip('one', { id: 'music-clip' })], { id: 'music', kind: 'audio', muted: true })) }],
    ['a trimmed in point', d => { d.tracks[0]!.clips[1]!.inMs = 50 }],
    ['a trimmed out point', d => { d.tracks[0]!.clips[1]!.outMs = 1949 }],
    ['clip gain', d => { d.tracks[0]!.clips[1]!.volume = 0.9 }],
    ['fade in', d => { d.tracks[0]!.clips[1]!.fadeInMs = 100 }],
    ['fade out', d => { d.tracks[0]!.clips[1]!.fadeOutMs = 100 }],
    ['a muted video track', d => { d.tracks[0]!.muted = true }],
    ['video track gain', d => { d.tracks[0]!.volume = 0.9 }],
    ['output width', d => { d.output = { width: 640, height: 240, fps: 30 } }],
    ['output height', d => { d.output = { width: 320, height: 480, fps: 30 } }],
    ['output frame rate', d => { d.output = { width: 320, height: 240, fps: 24 } }],
    ['an image', (_d, s) => { s.get('two')!.kind = 'image' }],
    ['non-H.264 video', (_d, s) => { s.get('two')!.video!.codec = 'hevc' }],
    ['different width', (_d, s) => { s.get('two')!.video!.width = 640 }],
    ['different height', (_d, s) => { s.get('two')!.video!.height = 480 }],
    ['different pixel format', (_d, s) => { s.get('two')!.video!.pixelFormat = 'yuv444p' }],
    ['different frame rate', (_d, s) => { s.get('two')!.video!.frameRate = '24/1' }],
    ['different video time base', (_d, s) => { s.get('two')!.video!.timeBase = '1/90000' }],
    ['missing audio', (_d, s) => { delete s.get('two')!.audio }],
    ['different audio codec', (_d, s) => { s.get('two')!.audio!.codec = 'mp3' }],
    ['different audio sample rate', (_d, s) => { s.get('two')!.audio!.sampleRate = 44100 }],
    ['different audio channels', (_d, s) => { s.get('two')!.audio!.channels = 1 }],
    ['different audio layout', (_d, s) => { s.get('two')!.audio!.channelLayout = 'mono' }],
    ['different audio time base', (_d, s) => { s.get('two')!.audio!.timeBase = '1/44100' }],
    ['rotation metadata', (_d, s) => { s.get('two')!.video!.rotation = 90 }],
    ['a longer probed source duration', (_d, s) => { s.get('two')!.probedDurationMs = 3000 }],
  ]
  it.each(cases)('encodes when there is %s', (_name, mutate) => {
    const { d, sources } = make()
    expect(plan(d, sources).mode).toBe('copy')
    mutate(d, sources)
    expect(plan(d, sources).mode).toBe('encode')
  })
  it('allows the same 50 ms whole-source tolerance as local media', () => {
    const { d, sources } = make()
    d.tracks[0]!.clips[1]!.outMs = 2050
    expect(plan(d, sources).mode).toBe('copy')
  })
  it('0024d: speed and transitions re-encode, and images cannot change speed', () => {
    const sources = new Map([['one', source()], ['two', source('two')]])
    expect(plan(doc(track([clip('one', { speed: 2 })])), sources).mode).toBe('encode')
    expect(plan(doc(track([clip('one'), clip('two', { startMs: 1500, transitionIn: { kind: 'crossfade', durationMs: 500 } })])), sources).mode).toBe('encode')
    const image = new Map<string, Source>([['one', { kind: 'image', path: resolve('timeline sources/card.png'), video: streams.video! }]])
    expect(() => plan(doc(track([clip('one', { speed: 2 })])), image)).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'timeline.speed_image' }) }))
  })
  it('0024d: visible text needs captions, and text without video exports video on black', () => {
    const textTracks = [{ id: 'text', hidden: false, clips: [{ id: 'caption', startMs: 0, durationMs: 1000, text: '第一镜', style: { preset: 'subtitle' as const }, fadeInMs: 0, fadeOutMs: 0 }] }]
    // Visible text requires a resolved font and never falls back to copying the sources.
    expect(() => plan({ ...doc(track([clip()])), textTracks })).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'timeline.font_missing' }) }))
    expect(() => plan({ version: 1, tracks: [], textTracks })).toThrowError(expect.objectContaining({ details: expect.objectContaining({ reason: 'timeline.font_missing' }) }))
    // Hidden text is not drawn: the whole-source copy still applies
    expect(plan({ ...doc(track([clip()])), textTracks: [{ ...textTracks[0]!, hidden: true }] }).mode).toBe('copy')
  })
  it('uses concat quoting for spaces, apostrophes, backslashes and non-ASCII paths', () => {
    const { d, sources } = make()
    sources.get('two')!.path = resolve('media space', "剪辑's clip.mp4")
    const result = plan(d, sources)
    expect(result.files[0]!.content).toContain("剪辑'\\''s clip.mp4'")
    expect(result.files[0]!.content).not.toContain('\\clip')
    expect(result.args).toContain('copy')
  })
})

describe('Timeline source validation', () => {
  const cases: [string, (d: TimelineDoc, sources: Map<string, Source>) => void][] = [
    ['source_missing', (_d, s) => { s.clear() }],
    ['source_kind', (_d, s) => { s.get('one')!.kind = 'audio' }],
    ['source_kind', d => { d.tracks[0]!.kind = 'audio' }],
    ['image_in_point', (d, s) => { s.get('one')!.kind = 'image'; d.tracks[0]!.clips[0]!.inMs = 1 }],
    ['image_duration', (d, s) => { s.get('one')!.kind = 'image'; d.tracks[0]!.clips[0]!.outMs = 499 }],
    ['image_duration', (d, s) => { s.get('one')!.kind = 'image'; d.tracks[0]!.clips[0]!.outMs = 30001 }],
    ['duration_missing', (_d, s) => { delete s.get('one')!.durationMs }],
    ['source_range', (d) => { d.tracks[0]!.clips[0]!.outMs = 2051 }],
    ['source_range', d => { d.tracks[0]!.clips[0]!.inMs = 2000; d.tracks[0]!.clips[0]!.outMs = 2050 }],
    ['audio_missing', (d, s) => { d.tracks[0]!.kind = 'audio'; delete s.get('one')!.audio }],
    ['video_missing', (_d, s) => { delete s.get('one')!.video }],
    ['output_invalid', (_d, s) => { s.get('one')!.video!.frameRate = '0/0' }],
    ['empty', d => { d.tracks[0]!.clips = [] }],
    ['invalid_doc', d => { d.tracks[0]!.clips[0]!.volume = 3 }],
  ]
  it.each(cases)('reports timeline.%s', (reason, mutate) => {
    const d = encodeDoc()
    const s = new Map([['one', source()]])
    if (reason === 'source_kind') s.get('one')!.kind = 'image'
    mutate(d, s)
    expect(() => plan(d, s)).toThrowError(expect.objectContaining({ code: 'invalid_params', details: { reason: `timeline.${reason}`, params: expect.any(Object) } }))
  })
})

const available = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const openh264 = available && execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).includes('libopenh264')

describe.skipIf(!available)('Timeline ffmpeg exports', () => {
  let dir: string
  let one: string
  let two: string
  let music: string
  let image: string
  let grey: string
  let logo: string
  let pip: string
  const results: RenderedTimeline[] = []
  const ffmpeg = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-nostdin', ...args], { stdio: 'pipe', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  const probe = (path: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { encoding: 'utf8', windowsHide: true })) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number; channels?: number; sample_rate?: string }[]; format: { duration: string } }
  const sources = () => new Map<string, TimelineSource>([
    ['one', { kind: 'video', path: one, durationMs: 2000 }],
    ['two', { kind: 'video', path: two, durationMs: 2000 }],
    ['music', { kind: 'audio', path: music, durationMs: 3000 }],
    ['image', { kind: 'image', path: image }],
    ['grey', { kind: 'video', path: grey, durationMs: 2000 }],
    ['logo', { kind: 'image', path: logo }],
    ['pip', { kind: 'video', path: pip, durationMs: 2000 }],
  ])
  async function render(d: TimelineDoc, options: Partial<Parameters<typeof renderTimeline>[2]> = {}) {
    const result = await renderTimeline(d, sources(), { encoder, ...options })
    results.push(result)
    return result
  }
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "vis-timeline-fixture-space 剪辑's-"))
    one = join(dir, "space 剪辑's one.mp4")
    two = join(dir, 'two.mp4')
    music = join(dir, 'music.wav')
    image = join(dir, 'card.png')
    grey = join(dir, 'grey.mp4')
    logo = join(dir, 'logo.png')
    pip = join(dir, 'pip.mp4')
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-y', one])
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-y', two])
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', '-y', music])
    ffmpeg(['-f', 'lavfi', '-i', 'color=red:size=320x240', '-frames:v', '1', '-y', image])
    ffmpeg(['-f', 'lavfi', '-i', 'color=gray:size=320x240:rate=30:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-y', grey])
    ffmpeg(['-f', 'lavfi', '-i', 'color=red:size=160x80:rate=24:duration=1', '-f', 'lavfi', '-i', 'color=blue:size=160x80:rate=24:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-y', pip])
    const rgba = Buffer.alloc(80 * 40 * 4)
    for (let y = 8; y < 32; y++) for (let x = 8; x < 72; x++) {
      rgba[(y * 80 + x) * 4] = 255
      rgba[(y * 80 + x) * 4 + 3] = 255
    }
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '80x40', '-i', 'pipe:0', '-frames:v', '1', '-y', logo], { input: rgba, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  }, 20_000)
  afterAll(async () => {
    await Promise.all(results.map(result => result.dispose()))
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const frameAt = (path: string, ms: number) => ffmpeg(['-ss', String(ms / 1000), '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
  const expectPixel = (frame: Buffer, x: number, y: number, expected: number[]) => {
    expect(frame.length).toBe(320 * 240 * 3)
    const pixel = frame.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)
    expected.forEach((value, channel) => expect(Math.abs(pixel[channel]! - value)).toBeLessThan(9))
  }
  it.each([1, 2])('exports overlay video pixels and sound only within its timeline interval at speed %s', async speed => {
    const c = overlayClip({ source: { nodeId: 'pip-node', assetVersionId: 'pip' }, startMs: 500, inMs: speed === 1 ? 250 : 0, outMs: speed === 1 ? 1250 : 2000, speed, overlay: { x: 0.75, y: 0.75, width: 0.5, opacity: 1 } })
    const result = await render(doc(track([clip('grey')]), overlayTrack([c])))
    expect(result).toMatchObject({ mode: 'encode', durationMs: 2000 })
    for (const ms of [200, 1500, 1800]) expectPixel(frameAt(result.path, ms), 240, 180, [128, 128, 128])
    for (const ms of [500, 1000, 1466]) {
      const frame = frameAt(result.path, ms)
      // The source turns blue at 1 s: trimming moves that change to 1.25 s; 2x to 1 s.
      expectPixel(frame, 240, 180, ms >= (speed === 1 ? 1250 : 1000) ? [0, 0, 255] : [255, 0, 0])
      expectPixel(frame, 120, 180, [128, 128, 128])
      expectPixel(frame, 240, 100, [128, 128, 128])
    }
    const samples = ffmpeg(['-i', result.path, '-vn', '-ar', '48000', '-ac', '1', '-f', 'f32le', 'pipe:1'])
    const rms = (start: number, end: number) => {
      let sum = 0
      const from = Math.round(start * 48000) * 4
      const to = Math.round(end * 48000) * 4
      expect(samples.length).toBeGreaterThanOrEqual(to)
      for (let i = from; i < to; i += 4) sum += samples.readFloatLE(i) ** 2
      return Math.sqrt(sum / ((to - from) / 4))
    }
    expect(rms(0.8, 1.2)).toBeGreaterThan(0.05)
    expect(rms(0.1, 0.3)).toBeLessThan(0.0001)
    expect(rms(1.7, 1.9)).toBeLessThan(0.0001)
  }, 20_000)
  it.each([1, 0.5])('preserves image alpha, placement and time bounds at opacity %s', async opacity => {
    const c = overlayClip({ source: { nodeId: 'logo-node', assetVersionId: 'logo' }, startMs: 500, outMs: 1000, overlay: { x: 0.5, y: 0.5, width: 0.5, opacity } })
    const result = await render(doc(track([clip('grey')]), overlayTrack([c])))
    expect(result.mode).toBe('encode')
    expectPixel(frameAt(result.path, 200), 160, 120, [128, 128, 128])
    expectPixel(frameAt(result.path, 1800), 160, 120, [128, 128, 128])
    expectPixel(frameAt(result.path, 1466), 160, 120, [255 * opacity + 128 * (1 - opacity), 128 * (1 - opacity), 128 * (1 - opacity)])
    expectPixel(frameAt(result.path, 1500), 160, 120, [128, 128, 128])
    const frame = frameAt(result.path, 1000)
    expectPixel(frame, 160, 120, [255 * opacity + 128 * (1 - opacity), 128 * (1 - opacity), 128 * (1 - opacity)])
    expectPixel(frame, 40, 120, [128, 128, 128])
    expectPixel(frame, 84, 84, [128, 128, 128])
  }, 20_000)
  it.each([24, 30, 60])('keeps the final visible frame at %s fps for an overlay starting between output frames', async fps => {
    const c = overlayClip({ source: { nodeId: 'logo-node', assetVersionId: 'logo' }, startMs: 501, outMs: 1000 })
    const result = await render({ ...doc(track([clip('grey')]), overlayTrack([c])), output: { width: 320, height: 240, fps } })
    expectPixel(frameAt(result.path, 500), 160, 120, [128, 128, 128])
    expectPixel(frameAt(result.path, 533), 160, 120, [255, 0, 0])
    expectPixel(frameAt(result.path, 1500), 160, 120, [255, 0, 0])
    expectPixel(frameAt(result.path, 1550), 160, 120, [128, 128, 128])
  }, 20_000)
  it.each([500, 501])('fades the overlay picture starting at %s ms according to the shared opacity curve', async startMs => {
    const c = overlayClip({ source: { nodeId: 'logo-node', assetVersionId: 'logo' }, startMs, outMs: 1000, fadeInMs: 400, fadeOutMs: 400 })
    const result = await render(doc(track([clip('grey')]), overlayTrack([c])))
    for (const ms of [600, 1000, 1400]) {
      const opacity = overlayOpacityAt(c, ms)
      const frame = frameAt(result.path, ms)
      expectPixel(frame, 160, 120, [255 * opacity + 128 * (1 - opacity), 128 * (1 - opacity), 128 * (1 - opacity)])
      expectPixel(frame, 84, 84, [128, 128, 128])
    }
  }, 20_000)
  it('composites both overlay tracks in order and skips a hidden upper picture', async () => {
    const lower = overlayClip({ source: { nodeId: 'logo-node', assetVersionId: 'logo' }, overlay: { x: 0.5, y: 0.5, width: 0.5, opacity: 1 } })
    const upper = overlayClip({ id: 'upper', source: { nodeId: 'image-node', assetVersionId: 'image' }, overlay: { x: 0.5, y: 0.5, width: 0.25, opacity: 0.5 } })
    // Put the upper clip over the transparent border: its half opacity must blend with grey.
    upper.overlay!.y = 0.35
    const document = doc(track([clip('grey')]), overlayTrack([lower]), overlayTrack([upper], { id: 'upper-track' }))
    const visible = await render(document)
    expectPixel(frameAt(visible.path, 1000), 160, 84, [192, 64, 64])
    document.tracks[2]!.hidden = true
    const hidden = await render(document)
    expectPixel(frameAt(hidden.path, 1000), 160, 84, [128, 128, 128])
  }, 20_000)
  it('renders overlays over black with no main video and keeps silent stereo audio', async () => {
    const c = overlayClip({ source: { nodeId: 'logo-node', assetVersionId: 'logo' }, startMs: 500, outMs: 1000 })
    const result = await render({ ...doc(overlayTrack([c])), output: { width: 320, height: 240, fps: 30 } })
    expect(result).toMatchObject({ kind: 'video', durationMs: 1500, width: 320, height: 240 })
    expectPixel(frameAt(result.path, 200), 160, 120, [0, 0, 0])
    expectPixel(frameAt(result.path, 1000), 160, 120, [255, 0, 0])
    expectPixel(frameAt(result.path, 1000), 84, 84, [0, 0, 0])
    expect(ffmpeg(['-i', result.path, '-vn', '-f', 's16le', 'pipe:1']).every(value => value === 0)).toBe(true)
  }, 20_000)

  it('encodes mixed sizes and missing soundtracks to one H.264 and stereo AAC stream', async () => {
    const progress: number[] = []
    const result = await render(doc(
      track([clip(), clip('two', { startMs: 2000 })]),
      track([clip('music', { startMs: 500, outMs: 3000, fadeInMs: 200, fadeOutMs: 500 })], { id: 'music', kind: 'audio', volume: 0.4 }),
    ), { onProgress: value => progress.push(value) })
    expect(result).toMatchObject({ mode: 'encode', kind: 'video', mime: 'video/mp4', width: 320, height: 240, fps: 30 })
    const info = probe(result.path)
    expect(info.streams).toHaveLength(2)
    expect(info.streams).toMatchObject([{ codec_name: 'h264', width: 320, height: 240 }, { codec_name: 'aac', channels: 2, sample_rate: '48000' }])
    expect(Math.abs(Number(info.format.duration) - 4)).toBeLessThanOrEqual(1 / 30)
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(1)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
  }, 20_000)
  it.each(['crossfade', 'dip'] as const)('exports three clips and two %s transitions to the document duration', async kind => {
    const d = doc(track([
      clip('one'), clip('two', { startMs: 1500, transitionIn: { kind, durationMs: 500 } }),
      clip('one', { id: 'again', startMs: 3000, transitionIn: { kind, durationMs: 500 } }),
    ]))
    const result = await render(d)
    const info = probe(result.path)
    expect(info.streams).toMatchObject([{ codec_name: 'h264' }, { codec_name: 'aac', channels: 2, sample_rate: '48000' }])
    expect(Math.abs(Number(info.format.duration) * 1000 - timelineDurationMs(d))).toBeLessThanOrEqual(1000 / 30)
    const samples = ffmpeg(['-i', result.path, '-vn', '-f', 's16le', '-ac', '2', '-ar', '48000', 'pipe:1'])
    expect(Math.abs(samples.length / (48000 * 4) * 1000 - timelineDurationMs(d))).toBeLessThanOrEqual(1000 / 30)
  }, 20_000)
  it('exports 2x video and quarter-speed audio with the exact sped-up source range', async () => {
    const d = doc(track([clip('one', { speed: 2 }), clip('two', { speed: 2, startMs: 500, transitionIn: { kind: 'crossfade', durationMs: 500 } })]))
    const result = await render(d)
    const info = probe(result.path)
    expect(info.streams).toMatchObject([{ codec_name: 'h264' }, { codec_name: 'aac', channels: 2 }])
    expect(Math.abs(Number(info.format.duration) * 1000 - timelineDurationMs(d))).toBeLessThanOrEqual(1000 / 30)
    const slowDoc = doc(track([clip('music', { inMs: 500, outMs: 1000, speed: 0.25, startMs: 200, fadeOutMs: 200 })], { kind: 'audio' }))
    const slow = await render(slowDoc)
    expect(Math.abs(Number(probe(slow.path).format.duration) * 1000 - timelineDurationMs(slowDoc))).toBeLessThanOrEqual(1000 / 30)
  }, 20_000)
  it('keeps mixed concat and xfade folds on one constant-rate timeline', async () => {
    const d = doc(track([
      clip('one'), clip('two', { startMs: 2000 }),
      clip('one', { id: 'third', startMs: 3500, transitionIn: { kind: 'crossfade', durationMs: 500 } }),
      clip('two', { id: 'fourth', startMs: 5500 }),
      clip('one', { id: 'fifth', startMs: 7000, transitionIn: { kind: 'dip', durationMs: 500 } }),
    ]))
    const result = await render(d)
    expect(Math.abs(Number(probe(result.path).format.duration) * 1000 - timelineDurationMs(d))).toBeLessThanOrEqual(1000 / 30)
  }, 20_000)
  it('crossfades images and video and pads a slowed source through its rounding allowance', async () => {
    const mixed = doc(track([
      clip('image', { outMs: 1000 }), clip('one', { startMs: 500, transitionIn: { kind: 'crossfade', durationMs: 500 } }),
      clip('image', { id: 'still-again', startMs: 2000, outMs: 1000, transitionIn: { kind: 'dip', durationMs: 500 } }),
    ]))
    const mixedResult = await render(mixed)
    expect(Math.abs(Number(probe(mixedResult.path).format.duration) * 1000 - timelineDurationMs(mixed))).toBeLessThanOrEqual(1000 / 30)
    const slow = doc(track([clip('one', { outMs: 2050, speed: 0.25 }), clip('two', { startMs: 7700, transitionIn: { kind: 'crossfade', durationMs: 500 } })]))
    const slowResult = await render(slow)
    expect(Math.abs(Number(probe(slowResult.path).format.duration) * 1000 - timelineDurationMs(slow))).toBeLessThanOrEqual(1000 / 30)
  }, 20_000)
  it('copies compatible whole clips and preserves the compressed video packets', async () => {
    const result = await render(doc(track([clip(), clip('one', { id: 'again', startMs: 2000 })])))
    expect(result.mode).toBe('copy')
    expect(result.fps).toBe(30)
    expect(Math.abs(Number(probe(result.path).format.duration) - 4)).toBeLessThanOrEqual(1 / 30)
    const packets = (path: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v:0', '-c', 'copy', '-f', 'h264', 'pipe:1'])
    const original = packets(one)
    expect(packets(result.path)).toEqual(Buffer.concat([original, original]))
  }, 20_000)
  it('reports the real copied duration when document timestamps use the rounding allowance', async () => {
    const result = await render(doc(track([clip('one', { outMs: 2050 }), clip('one', { id: 'again', startMs: 2050, outMs: 2050 })])))
    expect(result.mode).toBe('copy')
    expect(result.durationMs).toBe(4000)
  }, 20_000)
  it('exports audio-only AAC in m4a with the requested duration', async () => {
    const result = await render(doc(track([clip('music', { startMs: 500, outMs: 2000, fadeOutMs: 200 })], { kind: 'audio' })))
    expect(result).toMatchObject({ kind: 'audio', mime: 'audio/mp4', mode: 'encode', durationMs: 2500 })
    expect(result).not.toHaveProperty('fps')
    expect(result.path).toMatch(/\.m4a$/)
    expect(mimeOf(result.path)).toBe('audio/mp4')
    const info = probe(result.path)
    expect(info.streams).toMatchObject([{ codec_type: 'audio', codec_name: 'aac', channels: 2 }])
    expect(info.streams).toHaveLength(1)
    expect(Math.abs(Number(info.format.duration) - 2.5)).toBeLessThan(0.03)
  }, 20_000)
  it('retains audio gaps, clip and track gain, fades, and mixing without automatic ducking', async () => {
    const first = track([clip('music', { startMs: 500, outMs: 2000, volume: 0.5, fadeInMs: 200, fadeOutMs: 400 })], { kind: 'audio', volume: 0.5 })
    const second = track([clip('music', { id: 'overlap', startMs: 500, outMs: 2000, volume: 0.5, fadeInMs: 200, fadeOutMs: 400 })], { id: 'second', kind: 'audio', volume: 0.5 })
    const muted = track([clip('music', { id: 'muted-clip', outMs: 3000 })], { id: 'muted-track', kind: 'audio', muted: true })
    const single = await render(doc(first, muted))
    const mixed = await render(doc(first, second, muted))
    const decode = (path: string) => ffmpeg(['-i', path, '-vn', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1'])
    const rms = (bytes: Buffer, start: number, end: number) => {
      let sum = 0
      const from = Math.floor(start * 48000) * 8
      const to = Math.min(bytes.length, Math.floor(end * 48000) * 8)
      for (let i = from; i < to; i += 8) sum += bytes.readFloatLE(i) ** 2
      return Math.sqrt(sum / ((to - from) / 8))
    }
    const samples = decode(single.path)
    const steady = rms(samples, 0.9, 1.1)
    expect(steady).toBeGreaterThan(0.01)
    expect(steady).toBeLessThan(0.025)
    expect(rms(samples, 0.1, 0.3)).toBeLessThan(0.0001)
    expect(rms(samples, 0.51, 0.55)).toBeLessThan(steady * 0.4)
    expect(rms(samples, 2.4, 2.45)).toBeLessThan(steady * 0.4)
    expect(rms(samples, 2.7, 2.9)).toBeLessThan(0.0001)
    expect(rms(decode(mixed.path), 0.9, 1.1) / steady).toBeCloseTo(2, 1)
  }, 20_000)
  it('loops an image and extends the final video frame to the end of a longer audio track', async () => {
    const result = await render(doc(track([clip('image', { outMs: 1000 })]), track([clip('music', { outMs: 3000 })], { id: 'music', kind: 'audio' })))
    expect(result.durationMs).toBe(3000)
    expect(Math.abs(Number(probe(result.path).format.duration) - 3)).toBeLessThanOrEqual(1 / 30)
    const pixel = ffmpeg(['-ss', '2.5', '-i', result.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    expect(pixel[0]).toBeGreaterThan(200)
    expect(pixel[1]).toBeLessThan(30)
  }, 20_000)
  it('writes a silent stereo soundtrack when the video has no audio', async () => {
    const result = await render(doc(track([clip('two')])))
    const info = probe(result.path)
    expect(info.streams).toHaveLength(2)
    expect(info.streams[1]).toMatchObject({ codec_name: 'aac', channels: 2 })
    const samples = ffmpeg(['-i', result.path, '-vn', '-f', 's16le', 'pipe:1'])
    expect(samples.every(value => value === 0)).toBe(true)
  }, 20_000)
  it.skipIf(!openh264)('exports with libopenh264 without libx264 encoder options', async () => {
    const result = await render(encodeDoc(), { encoder: { name: 'libopenh264', args: ['-b:v', '1M'], hardware: false } })
    expect(probe(result.path).streams[0]!.codec_name).toBe('h264')
  }, 20_000)
  it('rejects an abort during rendering and removes the temporary directory', async () => {
    const controller = new AbortController()
    let active = false
    let during: string[] = []
    const left = await withOwnTmpdir(() => expect(render({ ...encodeDoc(), output: { width: 1920, height: 1080, fps: 30 } }, {
      signal: controller.signal,
      onProgress(value) {
        if (value > 0 && !active) {
          active = true
          during = readdirSync(tmpdir()).filter(name => name.startsWith('vis-timeline-'))
          controller.abort()
        }
      },
    })).rejects.toMatchObject({ details: { reason: 'media.interrupted' } }))
    expect(active).toBe(true)
    // The render really used the isolated directory, so the empty result below is meaningful
    expect(during).toHaveLength(1)
    expect(left).toEqual([])
  }, 20_000)
  it('cleans a failed ffmpeg invocation and returns a reason-coded probe error', async () => {
    const left = await withOwnTmpdir(() => expect(render(encodeDoc(), { ffmpegPath: join(dir, 'missing.exe') })).rejects.toMatchObject({ details: { reason: 'media.tool_missing' } }))
    expect(left).toEqual([])
    await expect(probeTimelineSource(join(dir, 'missing.mp4'))).rejects.toMatchObject({ details: { reason: 'timeline.probe_failed' } })
    await expect(render(encodeDoc(), { signal: AbortSignal.abort() })).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
  })
  it.skipIf(!process.env.VIS_TIMELINE_BENCHMARK)('measures a 30-clip 1080p30 encode without a timing assertion', async () => {
    const start = performance.now()
    const result = await render({
      ...doc(track(Array.from({ length: 30 }, (_, i) => clip('one', { id: `benchmark-${i}`, startMs: i * 2000, volume: 0.8 })))),
      output: { width: 1920, height: 1080, fps: 30 },
    })
    const measurement = { clips: 30, durationMs: 60_000, width: 1920, height: 1080, fps: 30, encoder, wallTimeMs: performance.now() - start }
    writeFileSync(join(tmpdir(), 'vis-W1-timeline-benchmark.json'), JSON.stringify(measurement, null, 2))
    expect(result.durationMs).toBe(60_000)
  }, 300_000)
  it.skipIf(!process.env.VIS_TIMELINE_OVERLAY_BENCHMARK)('measures 100 distinct images on two overlay tracks over one minute at 1080p30', async () => {
    const hardware = await detectVideoEncoder()
    expect(hardware.hardware).toBe(true)
    const picture = join(dir, 'minute.mp4')
    const sticker = join(dir, 'benchmark-logo.png')
    ffmpeg(['-f', 'lavfi', '-i', 'color=gray:size=1920x1080:rate=30:duration=60', '-c:v', hardware.name, ...hardware.args, '-an', '-y', picture])
    ffmpeg(['-i', logo, '-vf', 'scale=512:256', '-frames:v', '1', '-y', sticker])
    const available = new Map<string, TimelineSource>([['picture', { kind: 'video', path: picture, durationMs: 60_000 }]])
    const tracks = Array.from({ length: 2 }, (_, ti) => overlayTrack(Array.from({ length: 50 }, (_, ci) => {
      const id = `benchmark-${ti}-${ci}`
      const path = join(dir, `${id}.png`)
      copyFileSync(sticker, path)
      available.set(id, { kind: 'image', path })
      return overlayClip({ id, source: { nodeId: `node-${id}`, assetVersionId: id }, startMs: ci * 1200, outMs: 1000, fadeInMs: 100, fadeOutMs: 100, overlay: { x: ti ? 0.75 : 0.25, y: 0.5, width: 0.25, opacity: 0.5 } })
    }), { id: `overlay-${ti}` }))
    const document = { ...doc(track([clip('picture', { outMs: 60_000 })]), ...tracks), output: { width: 1920, height: 1080, fps: 30 } }
    const start = performance.now()
    const result = await renderTimeline(document, available, { encoder: hardware })
    results.push(result)
    const wallTimeMs = performance.now() - start
    writeFileSync(join(tmpdir(), 'vis-0024e-overlay-benchmark.json'), JSON.stringify({
      cpu: cpus()[0]?.model, memoryBytes: totalmem(), ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
      tracks: 2, clipsPerTrack: 50, distinctImages: 100, imageWidth: 512, imageHeight: 256, durationMs: 60_000,
      ...document.output, encoder: hardware, wallTimeMs, realtimeFactor: 60_000 / wallTimeMs, durationActualMs: result.durationMs,
    }, null, 2))
    expect(result.durationMs).toBe(60_000)
  }, 300_000)
  it.skipIf(!process.env.VIS_TIMELINE_VIDEO_OVERLAY_BENCHMARK)('measures a full-minute 1080p30 main picture and overlay video', async () => {
    const selected = await detectVideoEncoder()
    const picture = join(dir, 'video-overlay-main.mp4')
    const overlay = join(dir, 'video-overlay-pip.mp4')
    const upload = selected.filter ? ['-vf', selected.filter] : []
    ffmpeg([...(selected.inputArgs ?? []), '-f', 'lavfi', '-i', 'color=gray:size=1920x1080:rate=30:duration=60', ...upload, '-c:v', selected.name, ...selected.args, '-an', '-y', picture])
    ffmpeg([...(selected.inputArgs ?? []), '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=60', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=60', ...upload, '-c:v', selected.name, ...selected.args, '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-y', overlay])
    const available = new Map<string, TimelineSource>([
      ['picture', { kind: 'video', path: picture, durationMs: 60_000 }],
      ['pip', { kind: 'video', path: overlay, durationMs: 60_000 }],
    ])
    const document = {
      ...doc(track([clip('picture', { outMs: 60_000 })]), overlayTrack([overlayClip({ source: { nodeId: 'pip-node', assetVersionId: 'pip' }, outMs: 60_000, overlay: { x: 0.75, y: 0.75, width: 0.5, opacity: 1 } })])),
      output: { width: 1920, height: 1080, fps: 30 },
    }
    const start = performance.now()
    const result = await renderTimeline(document, available, { encoder: selected })
    results.push(result)
    const wallTimeMs = performance.now() - start
    writeFileSync(join(tmpdir(), 'vis-0024e2-video-overlay-benchmark.json'), JSON.stringify({
      cpu: cpus()[0]?.model, memoryBytes: totalmem(), ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
      mainSource: '1080p30 grey video', overlaySource: '1080p30 testsrc2 video with 1 kHz sine', overlayTracks: 1, overlayWidthFraction: 0.5,
      durationMs: 60_000, ...document.output, encoder: selected, wallTimeMs, realtimeFactor: 60_000 / wallTimeMs, durationActualMs: result.durationMs,
    }, null, 2))
    expect(result).toMatchObject({ mode: 'encode', durationMs: 60_000, width: 1920, height: 1080, fps: 30 })
  }, 300_000)
})

// Other test files render timelines in parallel into the shared system temp directory, so cleanup
// checks look only at a temp directory of their own.
async function withOwnTmpdir(work: () => Promise<unknown>): Promise<string[]> {
  const own = mkdtempSync(join(tmpdir(), 'vis-timeline-test-'))
  const keys = ['TMPDIR', 'TMP', 'TEMP'] as const
  const saved = keys.map(key => process.env[key])
  keys.forEach(key => { process.env[key] = own })
  try {
    await work()
    return readdirSync(own).filter(name => name.startsWith('vis-timeline-'))
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
    rmSync(own, { recursive: true, force: true })
  }
}
