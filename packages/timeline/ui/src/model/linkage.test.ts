import { describe, expect, it } from 'vitest'
import { type TextClip, type TimelineClip, type TimelineDoc } from '@vis/protocol'
import { linkCaptions } from './linkage'

const video = (id: string, startMs: number, length = 2000): TimelineClip => ({ id, startMs, inMs: 0, outMs: length, source: { nodeId: id, assetVersionId: id }, volume: 1, fadeInMs: 0, fadeOutMs: 0 })
const text = (id: string, startMs: number, durationMs = 400): TextClip => ({ id, startMs, durationMs, text: id, style: { preset: 'subtitle' }, fadeInMs: 0, fadeOutMs: 0 })
function document(): TimelineDoc {
  return { version: 1, tracks: [{ id: 'video', kind: 'video', muted: false, volume: 1, clips: [video('one', 0), video('two', 2000), video('three', 4000)] },
    { id: 'audio', kind: 'audio', muted: false, volume: 1, clips: [video('music', 1000)] }],
  textTracks: [{ id: 'text', hidden: false, clips: [text('a', 500), text('b', 2500), text('c', 4500), text('unlinked', 7000)] }] }
}
function linked(before: TimelineDoc, after: TimelineDoc) {
  const result = linkCaptions(before, after)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('Expected successful linkage')
  return result.doc
}

describe('caption linkage', () => {
  it.each(['trim', 'speed', 'transition'])('moves captions by changed start positions after %s', action => {
    const before = document()
    const after = structuredClone(before)
    const [first, second, third] = after.tracks[0]!.clips
    if (action === 'trim') first!.outMs = 1000
    if (action === 'speed') first!.speed = 2
    if (action === 'transition') second!.transitionIn = { kind: 'crossfade', durationMs: 1000 }
    second!.startMs = 1000
    third!.startMs = 3000
    const result = linked(before, after)
    expect(result.textTracks![0]!.clips.map(c => c.startMs)).toEqual([500, 1500, 3500, 7000])
    expect(result.tracks[1]).toEqual(before.tracks[1])
    expect(before.textTracks![0]!.clips[1]!.startMs).toBe(2500)
  })
  it('moves captions with their original owners when video clips are reordered', () => {
    const before = document()
    const after = structuredClone(before)
    const clips = after.tracks[0]!.clips
    after.tracks[0]!.clips = [clips[1]!, clips[0]!, clips[2]!]
    after.tracks[0]!.clips[0]!.startMs = 0
    after.tracks[0]!.clips[1]!.startMs = 2000
    expect(linked(before, after).textTracks![0]!.clips.map(c => [c.id, c.startMs])).toEqual([['b', 500], ['a', 2500], ['c', 4500], ['unlinked', 7000]])
  })
  it('deletes captions with a deleted video and shifts the following captions', () => {
    const before = document()
    const after = structuredClone(before)
    after.tracks[0]!.clips.shift()
    after.tracks[0]!.clips.forEach(c => { c.startMs -= 2000 })
    expect(linked(before, after).textTracks![0]!.clips.map(c => [c.id, c.startMs])).toEqual([['b', 500], ['c', 2500], ['unlinked', 7000]])
  })
  it('assigns text in a transition overlap to the later video clip', () => {
    const before = document()
    before.tracks[0]!.clips[1]!.startMs = 1500
    before.tracks[0]!.clips[1]!.transitionIn = { kind: 'crossfade', durationMs: 500 }
    before.textTracks![0]!.clips = [text('overlap', 1750)]
    const after = structuredClone(before)
    after.tracks[0]!.clips.shift()
    after.tracks[0]!.clips[0]!.startMs = 0
    expect(linked(before, after).textTracks![0]!.clips[0]!.startMs).toBe(250)
  })
  it('leaves text after the final end, at its boundary, or without any video unlinked', () => {
    const before = document()
    before.textTracks![0]!.clips = [text('boundary', 6000), text('after', 7000)]
    const after = structuredClone(before)
    after.tracks[0]!.clips = []
    expect(linked(before, after).textTracks).toEqual(before.textTracks)
    expect(linked(after, after)).toBe(after)
  })
  it('refuses the entire edit on overlap, including hidden text tracks', () => {
    const before = document()
    before.textTracks![0]!.hidden = true
    before.textTracks![0]!.clips = [text('long', 500, 1800), text('next', 2500)]
    const after = structuredClone(before)
    after.tracks[0]!.clips[1]!.startMs = 1000
    expect(linkCaptions(before, after)).toEqual({ ok: false, reason: 'captions' })
  })
  it('refuses moves beyond 30 minutes and negative starts', () => {
    const before = document()
    const after = structuredClone(before)
    after.tracks[0]!.clips[1]!.startMs = 1_799_500
    expect(linkCaptions(before, after)).toEqual({ ok: false, reason: 'captions' })
    after.tracks[0]!.clips[1]!.startMs = -1000
    expect(linkCaptions(before, after)).toEqual({ ok: false, reason: 'captions' })
  })
  it('returns the original after document when no existing video start changed', () => {
    const before = document()
    const after = structuredClone(before)
    after.textTracks![0]!.clips[0]!.text = 'Edited'
    after.tracks[1]!.clips[0]!.startMs = 2000
    expect(linked(before, after)).toBe(after)
  })
})
