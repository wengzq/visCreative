import { describe, expect, it } from 'vitest'
import { TimelineDoc, clipDurationMs, clipEndMs, timelineDurationMs, type TimelineClip } from '@vis/protocol'
import { deleteClips, duplicateClip, insertVideo, moveVideo, setSpeed, setTransition, splitClip, trimClip, useNewVersion, type EditResult } from './edit'

const clip = (id: string, startMs: number, extra: Partial<TimelineClip> = {}): TimelineClip => ({
  id, startMs, inMs: 1000, outMs: 5000, source: { nodeId: id, assetVersionId: id }, volume: 1, fadeInMs: 0, fadeOutMs: 0, ...extra,
})
const document = (): TimelineDoc => ({
  version: 1, tracks: [{ id: 'v', kind: 'video', muted: false, volume: 1, clips: [
    clip('a', 0), clip('b', 3500, { transitionIn: { kind: 'crossfade', durationMs: 500 } }),
    clip('c', 7000, { transitionIn: { kind: 'dip', durationMs: 500 } }),
  ] }],
})
function valid(result: EditResult) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw result
  expect(TimelineDoc.safeParse(result.doc).success).toBe(true)
  return result.doc
}

describe('Speed and transition edits', () => {
  it('changes source speed, fits timeline fades and ripples later overlaps without mutating the input', () => {
    const original = document()
    original.tracks[0]!.clips[1]!.fadeInMs = 3000
    const next = valid(setSpeed(original, 'b', 2))
    expect(next.tracks[0]!.clips.map(c => c.startMs)).toEqual([0, 3500, 5000])
    expect(next.tracks[0]!.clips[1]).toMatchObject({ inMs: 1000, outMs: 5000, speed: 2, fadeInMs: 2000 })
    expect(timelineDurationMs(next)).toBe(9000)
    expect(original.tracks[0]!.clips[1]!.speed).toBeUndefined()
    for (const speed of [0, 0.24, 4.01, 1.001, NaN, Infinity]) expect(setSpeed(original, 'b', speed)).toEqual({ ok: false, reason: 'invalid' })
  })
  it('stops a slower audio clip at its next neighbor using the nearest hundredth', () => {
    const doc: TimelineDoc = { version: 1, tracks: [{ id: 'a', kind: 'audio', muted: false, volume: 1, clips: [clip('one', 500, { outMs: 3000 }), clip('two', 3500)] }] }
    const result = setSpeed(doc, 'one', 0.25)
    const next = valid(result)
    expect(result).toMatchObject({ boundHit: true })
    expect(next.tracks[0]!.clips[0]!.speed).toBe(0.67)
    expect(clipEndMs(next.tracks[0]!.clips[0]!)).toBeLessThanOrEqual(3500)
    expect(clipDurationMs({ ...next.tracks[0]!.clips[0]!, speed: 0.66 })).toBeGreaterThan(3000)
    expect(next.tracks[0]!.clips[1]!.startMs).toBe(3500)
    doc.tracks[0]!.clips[1]!.startMs = 501
    expect(setSpeed(doc, 'one', 0.25)).toEqual({ ok: false, reason: 'overlap' })
  })
  it('adds, changes, clamps and removes transitions and rejects first/audio clips', () => {
    const next = valid(setTransition(document(), 'b', { kind: 'dip', durationMs: 2000 }))
    expect(next.tracks[0]!.clips.map(c => c.startMs)).toEqual([0, 2000, 5500])
    const fast = valid(setSpeed(next, 'b', 4))
    expect(fast.tracks[0]!.clips[1]!.transitionIn?.durationMs).toBe(1000)
    expect(fast.tracks[0]!.clips[2]!.transitionIn).toBeUndefined()
    const removed = valid(setTransition(next, 'b', null))
    expect(removed.tracks[0]!.clips[1]!.startMs).toBe(4000)
    expect(setTransition(next, 'a', { kind: 'dip', durationMs: 500 })).toEqual({ ok: false, reason: 'kind' })
    const clamped = setTransition(document(), 'b', { kind: 'crossfade', durationMs: 3000 })
    expect(clamped).toMatchObject({ ok: true, boundHit: true })
    expect(valid(clamped).tracks[0]!.clips[1]!.transitionIn?.durationMs).toBe(2000)
  })
  it('repairs transitions after insertion, movement, deletion and duplication', () => {
    const inserted = valid(insertVideo(document(), [clip('short', 0, { outMs: 1100 })], 1))
    expect(inserted.tracks[0]!.clips[2]!.transitionIn).toBeUndefined()
    const moved = valid(moveVideo(document(), 'b', 0))
    expect(moved.tracks[0]!.clips[0]!.transitionIn).toBeUndefined()
    expect(moved.tracks[0]!.clips.map(c => c.startMs)).toEqual([0, 4000, 7500])
    const deleted = valid(deleteClips(document(), ['a']))
    expect(deleted.tracks[0]!.clips[0]).toMatchObject({ id: 'b', startMs: 0 })
    expect(deleted.tracks[0]!.clips[0]!.transitionIn).toBeUndefined()
    const duplicate = valid(duplicateClip(document(), 'b'))
    expect(duplicate.tracks[0]!.clips.map(c => c.startMs)).toEqual([0, 3500, 7000, 10500])
  })
  it('trims source times at speed, shrinks transitions, and removes them below 200 ms', () => {
    const fast = valid(setSpeed(document(), 'b', 2))
    const shrunk = valid(trimClip(fast, 'b', 'out', 1800, { kind: 'video', durationMs: 5000 }))
    expect(shrunk.tracks[0]!.clips[1]!.transitionIn?.durationMs).toBe(400)
    expect(shrunk.tracks[0]!.clips[2]!.transitionIn).toBeUndefined()
    const tiny = valid(trimClip(fast, 'b', 'out', 1300, { kind: 'video' }))
    expect(tiny.tracks[0]!.clips[1]!.transitionIn).toBeUndefined()
    expect(tiny.tracks[0]!.clips[2]!.transitionIn).toBeUndefined()
    const audio: TimelineDoc = { version: 1, tracks: [{ id: 'a', kind: 'audio', muted: false, volume: 1, clips: [clip('x', 1000, { speed: 2 }), clip('y', 3500)] }] }
    const trimmed = valid(trimClip(audio, 'x', 'in', 2000, { kind: 'audio', durationMs: 10_000 }))
    expect(trimmed.tracks[0]!.clips[0]).toMatchObject({ startMs: 1500, inMs: 2000 })
    expect(valid(trimClip(audio, 'x', 'out', 9000, { kind: 'audio', durationMs: 10_000 })).tracks[0]!.clips[0]!.outMs).toBe(6000)
  })
  it('splits at the speed-aware source offset and keeps the incoming transition on the first half', () => {
    const fast = valid(setSpeed(document(), 'b', 2))
    const next = valid(splitClip(fast, 'b', 4500))
    const clips = next.tracks[0]!.clips
    expect(clips[1]).toMatchObject({ inMs: 1000, outMs: 3000, transitionIn: { durationMs: 500 }, speed: 2 })
    expect(clips[2]).toMatchObject({ inMs: 3000, outMs: 5000, startMs: 4500, speed: 2 })
    expect(clips[2]!.transitionIn).toBeUndefined()
    expect(timelineDurationMs(next)).toBe(timelineDurationMs(fast))
  })
  it('keeps fractional-speed audio trim rounding inside both timeline boundaries', () => {
    const doc: TimelineDoc = { version: 1, tracks: [{ id: 'a', kind: 'audio', muted: false, volume: 1, clips: [
      clip('x', 0, { inMs: 0, outMs: 5000, speed: 1.5 }), clip('y', 3333),
    ] }] }
    const trimmed = valid(trimClip(doc, 'x', 'in', 1, { kind: 'audio', durationMs: 5000 }))
    expect(clipEndMs(trimmed.tracks[0]!.clips[0]!)).toBe(3333)
    const slow: TimelineDoc = { version: 1, tracks: [{ id: 'a', kind: 'audio', muted: false, volume: 1, clips: [
      clip('x', 0, { inMs: 0, outMs: 2000, speed: 0.25 }), clip('y', 12347),
    ] }] }
    const result = trimClip(slow, 'x', 'out', 9000, { kind: 'audio', durationMs: 10_000 })
    const extended = valid(result)
    expect(result).toMatchObject({ boundHit: true })
    expect(clipEndMs(extended.tracks[0]!.clips[0]!)).toBeLessThanOrEqual(12347)
  })
  it('repairs transitions when a new version shortens a clip and removes speed for an image version', () => {
    const fast = valid(setSpeed(document(), 'b', 2))
    const shorter = valid(useNewVersion(fast, 'b', 'short', { kind: 'video', durationMs: 1800 }))
    expect(shorter.tracks[0]!.clips[1]!.transitionIn?.durationMs).toBe(400)
    expect(shorter.tracks[0]!.clips[2]!.transitionIn).toBeUndefined()
    const image = valid(useNewVersion(fast, 'b', 'image', { kind: 'image' }))
    expect(image.tracks[0]!.clips[1]).toMatchObject({ inMs: 0, outMs: 2000 })
    expect(image.tracks[0]!.clips[1]!.speed).toBeUndefined()
  })
})
