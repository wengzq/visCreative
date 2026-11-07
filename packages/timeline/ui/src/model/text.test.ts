import { describe, expect, it } from 'vitest'
import { type TimelineDoc } from '@vis/protocol'
import { addText, deleteText, removeTextTrack, updateText, updateTextTrack } from './text'

function added(doc: TimelineDoc, at = 0) {
  const result = addText(doc, at, 'Caption')
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('Expected text insertion')
  return result.doc
}

describe('text edits', () => {
  it('creates the first track and moves insertions to the next free two-second interval', () => {
    const first = added({ version: 1, tracks: [] })
    const second = added(first, 500)
    const third = added(second, 1500)
    expect(third.textTracks![0]!.clips.map(clip => [clip.startMs, clip.durationMs])).toEqual([[0, 2000], [2000, 2000], [4000, 2000]])
    expect(first.textTracks![0]!.clips).toHaveLength(1)
  })
  it('allows dragging and trimming within a track but refuses overlaps and length overflow', () => {
    const doc = added(added({ version: 1, tracks: [] }), 4000)
    const id = doc.textTracks![0]!.clips[0]!.id
    expect(updateText(doc, id, { startMs: 500 })).toMatchObject({ ok: true })
    expect(updateText(doc, id, { startMs: 3000 })).toEqual({ ok: false, reason: 'overlap' })
    expect(updateText(doc, id, { durationMs: 5000 })).toEqual({ ok: false, reason: 'overlap' })
    expect(updateText(doc, id, { startMs: 1_799_000 })).toEqual({ ok: false, reason: 'limit' })
  })
  it('clamps fades after a trim, edits visibility and name, and deletes only selected text', () => {
    const doc = added({ version: 1, tracks: [] })
    const track = doc.textTracks![0]!
    const clip = track.clips[0]!
    clip.fadeInMs = 1000
    clip.fadeOutMs = 1000
    const result = updateText(doc, clip.id, { durationMs: 800 })
    expect(result).toMatchObject({ ok: true, doc: { textTracks: [{ clips: [{ fadeInMs: 800, fadeOutMs: 0 }] }] } })
    expect(updateTextTrack(doc, track.id, { hidden: true, name: 'Title' })).toMatchObject({ ok: true, doc: { textTracks: [{ hidden: true, name: 'Title' }] } })
    expect(deleteText(doc, [clip.id]).textTracks![0]!.clips).toEqual([])
    expect(removeTextTrack(doc, track.id)).toMatchObject({ ok: true, doc: { textTracks: [] } })
  })
})
