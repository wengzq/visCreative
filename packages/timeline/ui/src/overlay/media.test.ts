import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineClip, TimelineDoc } from '@vis/protocol'
import type { EditorPartProps } from '../types'
import { createOverlayMediaPlayer, playingOverlayVideos, PREVIEW_OVERLAY_VIDEOS } from './media'

class Media extends EventTarget {
  alt = ''
  playsInline = false
  preload = ''
  playbackRate = 1
  preservesPitch = false
  readyState = 4
  seeking = false
  paused = true
  muted = false
  error: unknown = null
  complete = true
  naturalWidth = 1920
  style = {}
  parent?: Container
  private time = 0
  seeks: number[] = []
  private attributes = new Map<string, string>()
  constructor(readonly kind: string) { super() }
  get currentTime() { return this.time }
  set currentTime(value: number) { this.time = value; this.seeks.push(value) }
  get src() { return this.attributes.get('src') ?? '' }
  set src(value: string) { this.attributes.set('src', value) }
  hasAttribute(name: string) { return this.attributes.has(name) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  removeAttribute(name: string) { this.attributes.delete(name) }
  load = vi.fn()
  pause() { this.paused = true }
  async play() { this.paused = false }
  remove() { this.parent!.children = this.parent!.children.filter(child => child !== this) }
}
class Container {
  children: Media[] = []
  prepend(element: Media) { this.children.unshift(element); element.parent = this }
}
const clip = (id: string, startMs = 0): TimelineClip => ({ id, startMs, inMs: 1000, outMs: 5000, speed: 2, source: { nodeId: id, assetVersionId: id }, volume: 0.6, fadeInMs: 500, fadeOutMs: 500, overlay: { x: 0.5, y: 0.5, width: 0.25, opacity: 1 } })
function setup() {
  vi.useFakeTimers()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const created: Media[] = []
  vi.stubGlobal('document', { createElement: (kind: string) => { const media = new Media(kind); created.push(media); return media } })
  let position = 0
  let playing = false
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach(listener => listener())
  const gain = () => ({ gain: { setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn().mockReturnThis(), disconnect: vi.fn() })
  const context = { currentTime: 10, destination: {}, createGain: vi.fn(gain), createMediaElementSource: vi.fn(gain) }
  const clock = { now: () => position, playing: () => playing, context: () => context,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    play: () => { playing = true; emit() }, pause: () => { playing = false; emit() }, seek: (ms: number) => { position = ms; emit() } }
  const doc: TimelineDoc = { version: 1, tracks: [{ id: 'bottom', kind: 'overlay', muted: false, volume: 0.5, clips: [clip('a'), clip('b', 2200)] }] }
  const parts = { draft: { doc }, clock, host: { nodes: [], assetUrl: (id: string) => `/assets/${id}` }, track: doc.tracks[0]! } as unknown as EditorPartProps & { track: TimelineDoc['tracks'][number] }
  const containers = [new Container(), new Container()]
  const painted = vi.fn()
  const changed = vi.fn()
  const player = createOverlayMediaPlayer(containers as unknown as HTMLDivElement[], () => parts, item => !item.id.startsWith('image'), painted, changed)
  const step = (ms: number) => { position = ms; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(ms)) }
  const video = () => created.find(media => media.src === '/assets/a')!
  return { parts, clock, context, containers, created, painted, changed, frames, player, step, video }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('overlay media playback', () => {
  it('uses the topmost visible video with an explicit one-video limit', () => {
    const { parts, player } = setup()
    parts.draft.doc.tracks.push({ id: 'top', kind: 'overlay', muted: false, volume: 1, clips: [clip('top')] })
    expect(PREVIEW_OVERLAY_VIDEOS).toBe(1)
    expect(playingOverlayVideos(parts.draft.doc, 0, () => true).map(clip => clip.id)).toEqual(['top', 'a'])
    parts.draft.doc.tracks[1]!.hidden = true
    expect(playingOverlayVideos(parts.draft.doc, 0, () => true).map(clip => clip.id)).toEqual(['a'])
    player.dispose()
  })

  it('aligns speed and schedules clip gain, track volume, mute and sound fades through Web Audio', () => {
    const { player, clock, video, context, parts } = setup()
    clock.seek(250)
    clock.play()
    expect(video().currentTime).toBe(1.5)
    expect(video().playbackRate).toBe(2)
    expect(video().preservesPitch).toBe(true)
    expect(video().paused).toBe(false)
    const [clipGain, trackGain] = context.createGain.mock.results.map(result => result.value)
    expect(clipGain.gain.setValueAtTime).toHaveBeenCalledWith(0.3, 10)
    expect(clipGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.6, 10.25)
    expect(clipGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 11.75)
    expect(trackGain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.5, 10)
    parts.track.muted = true
    player.update()
    expect(trackGain.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 10)
    player.dispose()
  })

  it('freezes and silences excess videos, seeks every paused or scrubbed frame and resumes after the top clip ends', () => {
    const { parts, clock, player, step, video, changed } = setup()
    parts.draft.doc.tracks.push({ id: 'top', kind: 'overlay', muted: false, volume: 1, clips: [{ ...clip('top'), outMs: 3000 }] })
    clock.play()
    expect(video().paused).toBe(true)
    expect(video().muted).toBe(true)
    const seeks = video().seeks.length
    step(200)
    expect(video().seeks).toHaveLength(seeks)
    expect(changed.mock.lastCall?.[0].limited).toBe(true)
    clock.seek(220)
    expect(video().currentTime).toBe(1.44)
    clock.pause()
    expect(changed.mock.lastCall?.[0].limited).toBe(false)
    clock.seek(240)
    expect(video().currentTime).toBe(1.48)
    clock.play()
    step(1100)
    expect(video().paused).toBe(false)
    expect(video().muted).toBe(false)
    player.dispose()
  })

  it('keeps hidden overlay sound and excludes hidden pictures from the preview limit', () => {
    const { parts, clock, video, player, painted, changed } = setup()
    parts.track.hidden = true
    painted.mockClear()
    clock.play()
    expect(video().paused).toBe(false)
    expect(painted.mock.calls.some(call => call[1]?.id === 'a' && call[2])).toBe(false)
    expect(changed.mock.lastCall?.[0].limited).toBe(false)
    player.dispose()
  })

  it('preloads within 500ms, promotes without seeking again, releases unused sources and switches element type on clip changes', () => {
    const { player, clock, step, created, parts, video } = setup()
    clock.seek(1699)
    expect(created.some(media => media.src === '/assets/b')).toBe(false)
    clock.seek(1700)
    const spare = created.find(media => media.src === '/assets/b')!
    expect(spare.currentTime).toBe(1)
    expect(spare.paused).toBe(true)
    const seeks = spare.seeks.length
    clock.play()
    const loads = spare.load.mock.calls.length
    step(2000)
    expect(spare.src).toBe('/assets/b')
    expect(spare.load).toHaveBeenCalledTimes(loads)
    step(2200)
    expect(created.find(media => media.src === '/assets/b')).toBe(spare)
    expect(spare.paused).toBe(false)
    expect(spare.seeks).toHaveLength(seeks)
    const old = created.find(media => media.kind === 'video' && media !== spare)!
    expect(old.hasAttribute('src')).toBe(false)
    expect(old.load).toHaveBeenCalled()
    parts.track.clips = [{ ...clip('image'), inMs: 0, outMs: 5000, speed: undefined }]
    player.update()
    expect(created.find(media => media.src === '/assets/image')?.kind).toBe('img')
    expect(spare.hasAttribute('src')).toBe(false)
    expect(spare.paused).toBe(true)
    player.dispose()
  })

  it('uses 80ms drift realignment while playing but exact alignment for even small clock seeks', () => {
    const { clock, player, video, step } = setup()
    clock.play()
    const count = video().seeks.length
    step(20)
    expect(video().seeks).toHaveLength(count)
    step(50)
    expect(video().currentTime).toBe(1.1)
    clock.seek(60)
    expect(video().currentTime).toBe(1.12)
    player.dispose()
  })

  it('updates delayed loading and unavailable states from readiness events while remaining idle when paused', () => {
    const { clock, player, video, frames, changed } = setup()
    video().readyState = 0
    player.update()
    vi.advanceTimersByTime(299)
    expect(changed.mock.lastCall?.[0].loading).toBe(false)
    vi.advanceTimersByTime(1)
    expect(changed.mock.lastCall?.[0].loading).toBe(true)
    clock.seek(250)
    video().readyState = 1
    video().dispatchEvent(new Event('loadedmetadata'))
    expect(video().currentTime).toBe(1.5)
    video().readyState = 4
    video().dispatchEvent(new Event('canplay'))
    expect(changed.mock.lastCall?.[0].loading).toBe(false)
    video().error = new Error('Unavailable fixture')
    video().dispatchEvent(new Event('error'))
    expect(changed.mock.lastCall?.[0].unavailable).toBe(true)
    expect(frames.size).toBe(0)
    const released = video()
    player.dispose()
    const count = changed.mock.calls.length
    released.dispatchEvent(new Event('canplay'))
    vi.advanceTimersByTime(1000)
    expect(changed).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })
})
