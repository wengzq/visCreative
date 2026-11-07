import { describe, expect, it } from 'vitest'
import { effectiveFades, type TimelineClip, type TimelineDoc, type TimelineTrack } from '@vis/protocol'
import { activeClip, activeClips, clipGain, gainRamp, nextVideoClip, shouldRealign, transitionOpacity, upcomingClips, visualClips } from './model'

const clip = (id: string, startMs: number): TimelineClip => ({ id, startMs, inMs: 100, outMs: 1100, source: { nodeId: id, assetVersionId: id }, volume: 0.8, fadeInMs: 200, fadeOutMs: 300 })
const track: TimelineTrack = { id: 'v', kind: 'video', muted: false, volume: 1, clips: [clip('a', 0), clip('b', 1000), clip('c', 2000)] }
const doc: TimelineDoc = { version: 1, tracks: [track] }

describe('Timeline playback planning', () => {
  it('uses half-open cuts and a bounded lookahead', () => {
    expect(activeClip(track, 999)?.id).toBe('a')
    expect(activeClip(track, 1000)?.id).toBe('b')
    expect(activeClip(track, 3000)).toBeUndefined()
    expect(nextVideoClip(track, 1000)?.id).toBe('c')
    expect(upcomingClips(doc, 600).map(item => item.clip.id)).toEqual(['a', 'b'])
    expect(upcomingClips(doc, 1500).map(item => item.clip.id)).toEqual(['b', 'c'])
  })
  it('schedules trim-relative fades and zero gain outside a clip', () => {
    const first = track.clips[0]!
    expect(clipGain(first, -1)).toBe(0)
    expect(clipGain(first, 100)).toBeCloseTo(0.4)
    expect(clipGain(first, 850)).toBeCloseTo(0.4)
    expect(clipGain(first, 1000)).toBe(0)
    expect(gainRamp(first, 100)).toEqual([{ ms: 100, gain: 0.4 }, { ms: 200, gain: 0.8 }, { ms: 700, gain: 0.8 }, { ms: 1000, gain: 0 }])
  })
  it('only realigns drift over eighty milliseconds', () => {
    expect(shouldRealign(1.08, 1000)).toBe(false)
    expect(shouldRealign(1.081, 1000)).toBe(true)
    expect(shouldRealign(0.919, 1000)).toBe(true)
  })
  it('blends crossfades linearly and dips through black at the midpoint', () => {
    expect(transitionOpacity('crossfade', 0.25)).toEqual({ outgoing: 0.75, incoming: 0.25 })
    expect(transitionOpacity('dip', 0.25)).toEqual({ outgoing: 0.5, incoming: 0 })
    expect(transitionOpacity('dip', 0.5)).toEqual({ outgoing: 0, incoming: 0 })
    expect(transitionOpacity('dip', 0.75)).toEqual({ outgoing: 0, incoming: 0.5 })
    expect(transitionOpacity('crossfade', -1)).toEqual({ outgoing: 1, incoming: 0 })
    expect(transitionOpacity('dip', 2)).toEqual({ outgoing: 0, incoming: 1 })
  })
  it('plays both clips in an overlap, chooses incoming as current, and preloads before its start', () => {
    const overlapping: TimelineTrack = { ...track, clips: [
      { ...clip('a', 0), speed: 0.5 }, { ...clip('b', 1500), transitionIn: { kind: 'crossfade', durationMs: 500 } },
    ] }
    expect(upcomingClips({ version: 1, tracks: [overlapping] }, 1000).map(({ clip }) => clip.id)).toEqual(['a', 'b'])
    expect(activeClips(overlapping, 1750).map(clip => clip.id)).toEqual(['a', 'b'])
    expect(activeClip(overlapping, 1750)?.id).toBe('b')
    expect(visualClips(overlapping, 1750).map(({ opacity, blend }) => ({ opacity, blend }))).toEqual([{ opacity: 0.5, blend: true }, { opacity: 0.5, blend: true }])
    expect(activeClips(overlapping, 2000).map(clip => clip.id)).toEqual(['b'])
    expect(clipGain(overlapping.clips[0]!, 1750, effectiveFades(overlapping, 0))).toBeCloseTo(0.4)
    expect(clipGain(overlapping.clips[1]!, 1750, effectiveFades(overlapping, 1))).toBeCloseTo(0.4)
  })
  it('multiplies intersecting effective fades and samples their curved product in time order', () => {
    const clip = track.clips[0]!
    const fades = { fadeInMs: 800, fadeOutMs: 800 }
    expect(clipGain(clip, 500, fades)).toBeCloseTo(0.8 * 0.625 * 0.625)
    const ramp = gainRamp(clip, 300, fades)
    expect(ramp.find(point => point.ms === 500)?.gain).toBeCloseTo(0.3125)
    expect(ramp.map(point => point.ms)).toEqual(ramp.map(point => point.ms).sort((a, b) => a - b))
    expect(ramp.at(-1)).toEqual({ ms: 1000, gain: 0 })
  })
})
