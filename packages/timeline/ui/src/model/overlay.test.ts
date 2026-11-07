import { describe, expect, it } from 'vitest'
import { TIMELINE_LIMITS, TimelineDoc, clipEndMs, type NodeView, type TimelineClip } from '@vis/protocol'
import { addOverlayTrack, deleteClips, diffClips, duplicateClip, moveOverlay, placeOverlay, removeOverlayTrack, reorderAudioTrack, reorderOverlayTrack, sameDocument, setSpeed, setTransition, splitClip, trimClip, trimImageClip, updateClip, updateTrack, useNewVersion, type EditResult } from './edit'
import { snapCandidates } from './geometry'
import { linkCaptions } from './linkage'
import { acceptsMedia, mediaClip, trackSourceKind } from './media'

const placement = { x: 0.5, y: 0.5, width: 0.25, opacity: 1 }
const clip = (id: string, startMs = 0, outMs = 2000): TimelineClip => ({
  id, startMs, inMs: 0, outMs, source: { nodeId: id, assetVersionId: id }, volume: 1, fadeInMs: 0, fadeOutMs: 0,
})
const overlay = (id: string, startMs = 0, outMs = 2000): TimelineClip => ({ ...clip(id, startMs, outMs), overlay: { ...placement } })
const document = (): TimelineDoc => ({
  version: 1,
  tracks: [
    { id: 'main', kind: 'video', muted: false, volume: 1, clips: [clip('v1'), clip('v2', 2000)] },
    { id: 'bottom', kind: 'overlay', muted: false, volume: 1, clips: [overlay('o1', 1000), overlay('o2', 8000)] },
    { id: 'top', kind: 'overlay', muted: false, volume: 1, clips: [] },
    { id: 'music', kind: 'audio', muted: false, volume: 1, clips: [clip('a1', 1000)] },
    { id: 'sfx', kind: 'audio', muted: false, volume: 1, clips: [] },
  ],
  textTracks: [{ id: 'text', hidden: false, clips: [{ id: 'caption', startMs: 1000, durationMs: 500, text: 'Caption', style: { preset: 'subtitle' }, fadeInMs: 0, fadeOutMs: 0 }] }],
})
function valid(result: EditResult) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw result
  expect(TimelineDoc.safeParse(result.doc).success).toBe(true)
  return result.doc
}
const imageNode: NodeView = {
  nodeId: 'image', kind: 'image', x: 0, y: 0, w: 100, h: 100, z: 0, layoutRevision: 1,
  slots: [{ slotId: 'slot', slotKey: 'main', contentType: 'image', revision: 1, content: { type: 'asset', assetVersionId: 'image_asset', mime: 'image/png' } }],
}

describe('image overlay edits', () => {
  it('inserts overlay tracks after main and before audio, with a separate two-track limit', () => {
    const original = document()
    const base = { ...original, tracks: original.tracks.filter(track => track.kind !== 'overlay') }
    const once = valid(addOverlayTrack(base, 'Logo'))
    const twice = valid(addOverlayTrack(once))
    expect(twice.tracks.map(track => track.kind)).toEqual(['video', 'overlay', 'overlay', 'audio', 'audio'])
    expect(twice.tracks[1]).toMatchObject({ name: 'Logo', muted: false, volume: 1, hidden: false, clips: [] })
    expect(addOverlayTrack(twice)).toEqual({ ok: false, reason: 'limit' })
    expect(base.tracks).toHaveLength(3)
    expect(valid(addOverlayTrack({ version: 1, tracks: [] })).tracks[0]!.kind).toBe('overlay')
  })

  it('reorders each track kind inside its own section and only removes overlay tracks', () => {
    const next = valid(reorderOverlayTrack(document(), 'bottom', 1))
    expect(next.tracks.map(track => track.id)).toEqual(['main', 'top', 'bottom', 'music', 'sfx'])
    expect(valid(reorderAudioTrack(next, 'music', 1)).tracks.map(track => track.id)).toEqual(['main', 'top', 'bottom', 'sfx', 'music'])
    expect(reorderOverlayTrack(next, 'main', 0)).toEqual({ ok: false, reason: 'missing' })
    expect(valid(removeOverlayTrack(next, 'bottom')).tracks.map(track => track.id)).toEqual(['main', 'top', 'music', 'sfx'])
    expect(valid(removeOverlayTrack(next, 'main'))).toEqual(next)
  })

  it('places images at absolute times with default placement, shortening at the next clip', () => {
    const before = document()
    const next = valid(placeOverlay(before, 'bottom', clip('new', 0, 5000), 5000))
    expect(next.tracks[1]!.clips.map(clip => [clip.id, clip.startMs, clip.outMs])).toEqual([['o1', 1000, 2000], ['new', 5000, 3000], ['o2', 8000, 2000]])
    expect(next.tracks[1]!.clips[1]!.overlay).toEqual(placement)
    expect(next.tracks[0]).toEqual(before.tracks[0])
    expect(before).toEqual(document())
    expect(placeOverlay(before, 'bottom', clip('overlap'), 2000)).toEqual({ ok: false, reason: 'overlap' })
    expect(placeOverlay(before, 'bottom', clip('short'), 7750)).toEqual({ ok: false, reason: 'duration' })
    expect(placeOverlay(before, 'music', clip('wrong'), 0)).toEqual({ ok: false, reason: 'missing' })
    const last = valid(placeOverlay(before, 'top', clip('last', 0, 5000), TIMELINE_LIMITS.maxDurationMs - 1000))
    expect(last.tracks[2]!.clips[0]).toMatchObject({ startMs: TIMELINE_LIMITS.maxDurationMs - 1000, outMs: 1000 })
  })

  it('moves between overlay lanes without shortening, shifting neighbors or changing placement', () => {
    const before = document()
    before.tracks[1]!.clips[0]!.overlay = { x: 0.9, y: 0.1, width: 0.12, opacity: 0.6 }
    const moved = valid(moveOverlay(before, 'o1', 'top', 6000))
    expect(moved.tracks[1]!.clips.map(clip => clip.id)).toEqual(['o2'])
    expect(moved.tracks[2]!.clips[0]).toEqual({ ...before.tracks[1]!.clips[0], startMs: 6000 })
    expect(valid(moveOverlay(before, 'o1', 'bottom', 3000)).tracks[1]!.clips.map(clip => clip.startMs)).toEqual([3000, 8000])
    expect(moveOverlay(before, 'o1', 'bottom', 7000)).toEqual({ ok: false, reason: 'overlap' })
    expect(moveOverlay(before, 'o1', 'music', 0)).toEqual({ ok: false, reason: 'missing' })
    expect(moveOverlay(before, 'v1', 'top', 0)).toEqual({ ok: false, reason: 'missing' })
    expect(before.tracks[1]!.clips[0]!.startMs).toBe(1000)
  })

  it('trims image length up to the next boundary or whole timeline without ripple', () => {
    const before = document()
    const result = trimClip(before, 'o1', 'out', 60_000, { kind: 'image' })
    expect(result).toMatchObject({ ok: true, value: 7000, boundHit: true })
    const next = valid(result)
    expect(next.tracks[1]!.clips.map(clip => clip.startMs)).toEqual([1000, 8000])
    const whole = valid(trimClip(before, 'o2', 'out', TIMELINE_LIMITS.maxDurationMs, { kind: 'image' }))
    expect(clipEndMs(whole.tracks[1]!.clips[1]!)).toBe(TIMELINE_LIMITS.maxDurationMs)
    expect(valid(trimClip(before, 'v1', 'out', 60_000, { kind: 'image' })).tracks[0]!.clips[0]!.outMs).toBe(30_000)
    expect(trimClip(before, 'o1', 'out', 1000, { kind: 'audio', durationMs: 5000 })).toEqual({ ok: false, reason: 'kind' })
  })

  it('trims either image edge in timeline coordinates, retaining the opposite overlay edge', () => {
    const before = document()
    before.tracks[1]!.clips[1]!.fadeInMs = 1500
    const left = valid(trimImageClip(before, 'o2', 'in', 9500))
    expect(left.tracks[1]!.clips[1]).toMatchObject({ startMs: 9500, inMs: 0, outMs: 500, fadeInMs: 500 })
    const extended = valid(trimImageClip(before, 'o2', 'in', 0))
    expect(extended.tracks[1]!.clips[1]).toMatchObject({ startMs: 3000, outMs: 7000 })
    expect(trimImageClip(before, 'o2', 'in', 0)).toMatchObject({ boundHit: true })
    expect(valid(trimImageClip(before, 'o1', 'out', 9000)).tracks[1]!.clips[0]).toMatchObject({ startMs: 1000, outMs: 7000 })
    expect(valid(trimImageClip(before, 'v1', 'in', 500)).tracks[0]!.clips.map(clip => [clip.startMs, clip.outMs])).toEqual([[0, 1500], [1500, 2000]])
    expect(trimImageClip(before, 'o1', 'in', NaN)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('splits, duplicates and deletes images without ripple or lost placement', () => {
    const before = document()
    const split = valid(splitClip(before, 'o1', 2000, { kind: 'image' }))
    expect(split.tracks[1]!.clips.map(clip => [clip.startMs, clip.inMs, clip.outMs])).toEqual([[1000, 0, 1000], [2000, 0, 1000], [8000, 0, 2000]])
    expect(split.tracks[1]!.clips.every(clip => JSON.stringify(clip.overlay) === JSON.stringify(placement))).toBe(true)
    expect(splitClip(before, 'o1', 1250, { kind: 'image' })).toEqual({ ok: false, reason: 'duration' })
    const duplicate = valid(duplicateClip(before, 'o1'))
    expect(duplicate.tracks[1]!.clips.map(clip => clip.startMs)).toEqual([1000, 3000, 8000])
    expect(duplicate.tracks[1]!.clips[1]!.overlay).toEqual(placement)
    const deleted = valid(deleteClips(before, ['o1']))
    expect(deleted.tracks[1]!.clips[0]).toMatchObject({ id: 'o2', startMs: 8000 })
    expect(linkCaptions(before, deleted)).toEqual({ ok: true, doc: deleted })
    const mainDeleted = valid(deleteClips(before, ['v1']))
    const linked = linkCaptions(before, mainDeleted)
    expect(linked.ok && linked.doc.tracks[1]).toEqual(before.tracks[1])
  })

  it('applies the 50-clip limit to insert, split, duplicate and lane movement', () => {
    const before = document()
    before.tracks[2]!.clips = Array.from({ length: 50 }, (_, index) => overlay(`full_${index}`, index * 1000, 500))
    expect(placeOverlay(before, 'top', clip('extra', 0, 500), 60_000)).toEqual({ ok: false, reason: 'limit' })
    expect(duplicateClip(before, 'full_0')).toEqual({ ok: false, reason: 'limit' })
    expect(moveOverlay(before, 'o1', 'top', 60_000)).toEqual({ ok: false, reason: 'limit' })
    before.tracks[2]!.clips[0]!.outMs = 1000
    expect(splitClip(before, 'full_0', 500)).toEqual({ ok: false, reason: 'limit' })
    expect(valid(moveOverlay(before, 'full_0', 'top', 60_000)).tracks[2]!.clips).toHaveLength(50)
  })

  it('updates placement and visibility and detects these changes for drafts and diffs', () => {
    const before = document()
    const hidden = valid(updateTrack(before, 'bottom', { hidden: true }))
    expect(hidden.tracks[1]!.hidden).toBe(true)
    expect(sameDocument(before, hidden)).toBe(false)
    const moved = valid(updateClip(before, 'o1', { overlay: { ...placement, x: 0.9, opacity: 0.5 } }))
    expect(moved.tracks[1]!.clips[0]!.overlay).toEqual({ ...placement, x: 0.9, opacity: 0.5 })
    expect(sameDocument(before, moved)).toBe(false)
    expect(diffClips(before, moved)).toEqual([{ type: 'changed', clipId: 'o1', trackId: 'bottom', trackName: undefined, startMs: 1000 }])
    const reordered = structuredClone(before)
    reordered.tracks[1]!.clips[0]!.overlay = { opacity: 1, width: 0.25, y: 0.5, x: 0.5 }
    expect(sameDocument(before, reordered)).toBe(true)
    expect(updateClip(before, 'v1', { overlay: placement })).toEqual({ ok: false, reason: 'kind' })
    expect(updateTrack(before, 'main', { hidden: true })).toEqual({ ok: false, reason: 'kind' })
    expect(updateClip(before, 'o1', { overlay: { ...placement, x: 1.001 } }).ok).toBe(false)
  })

  it('keeps long image durations on version updates and rejects sound, image speed and transitions', () => {
    const before = document()
    before.tracks[1]!.clips[1]!.outMs = 120_000
    const next = valid(useNewVersion(before, 'o2', 'new_image', { kind: 'image' }))
    expect(next.tracks[1]!.clips[1]).toMatchObject({ startMs: 8000, inMs: 0, outMs: 120_000, source: { assetVersionId: 'new_image' }, overlay: placement })
    expect(useNewVersion(before, 'o2', 'sound', { kind: 'audio', durationMs: 2000 })).toEqual({ ok: false, reason: 'kind' })
    expect(setSpeed(before, 'o1', 2, { kind: 'image' })).toEqual({ ok: false, reason: 'kind' })
    expect(setTransition(before, 'o2', { kind: 'dip', durationMs: 500 })).toEqual({ ok: false, reason: 'kind' })
  })
})

describe('overlay media and snapping audit', () => {
  it('creates overlay images with placement and rejects unsupported source kinds', () => {
    expect(acceptsMedia('overlay', 'image')).toBe(true)
    expect(acceptsMedia('overlay', 'video')).toBe(true)
    expect(acceptsMedia('overlay', 'audio')).toBe(false)
    expect(trackSourceKind('overlay')).toBe('video')
    expect(mediaClip(document(), imageNode, undefined, 'overlay')).toMatchObject({ inMs: 0, outMs: 5000, overlay: placement })
    expect(mediaClip(document(), imageNode)).not.toHaveProperty('overlay')
    expect(mediaClip(document(), { ...imageNode, kind: 'video' }, 2000, 'overlay')).toMatchObject({ inMs: 0, outMs: 2000, overlay: placement })
  })

  it('snaps to overlay and text boundaries while excluding the dragged clip', () => {
    const candidates = snapCandidates(document(), 4500, ['o1', 'a1'])
    expect(candidates).toEqual(expect.arrayContaining([0, 4500, 8000, 10_000, 1500]))
    expect(candidates).not.toContain(3000)
  })
})


describe('video overlay edits', () => {
  const bounds = { kind: 'video' as const, durationMs: 12_000 }
  const videoDoc = () => {
    const doc = document()
    Object.assign(doc.tracks[1]!.clips[0]!, { inMs: 1000, outMs: 5000, speed: 2, volume: 0.6, fadeInMs: 500, fadeOutMs: 500 })
    return doc
  }

  it('places the source from zero, shortening to the gap and retaining sub-500ms videos', () => {
    const before = document()
    const result = valid(placeOverlay(before, 'bottom', clip('movie', 0, 12_000), 5000, bounds))
    expect(result.tracks[1]!.clips[1]).toMatchObject({ startMs: 5000, inMs: 0, outMs: 3000, overlay: placement })
    expect(valid(placeOverlay(before, 'bottom', clip('brief', 0, 12_000), 7900, bounds)).tracks[1]!.clips[1]!.outMs).toBe(100)
    expect(placeOverlay(before, 'bottom', clip('sound'), 0, { kind: 'audio', durationMs: 2000 })).toEqual({ ok: false, reason: 'kind' })
    expect(result.tracks[0]).toEqual(before.tracks[0])
    expect(before).toEqual(document())
  })

  it('trims source bounds and neighboring gaps at speed without rippling', () => {
    const before = videoDoc()
    const inward = valid(trimClip(before, 'o1', 'in', 2000, bounds))
    expect(inward.tracks[1]!.clips[0]).toMatchObject({ startMs: 1500, inMs: 2000, outMs: 5000, speed: 2 })
    const extended = valid(trimClip(before, 'o1', 'in', -1000, bounds))
    expect(extended.tracks[1]!.clips[0]).toMatchObject({ startMs: 500, inMs: 0 })
    const outward = valid(trimClip(before, 'o1', 'out', 20_000, bounds))
    expect(outward.tracks[1]!.clips[0]!.outMs).toBe(12_000)
    const neighborBound = valid(trimClip(before, 'o1', 'out', 30_000, { kind: 'video', durationMs: 30_000 }))
    expect(clipEndMs(neighborBound.tracks[1]!.clips[0]!)).toBe(8000)
    expect(outward.tracks[1]!.clips[1]).toEqual(before.tracks[1]!.clips[1])
    expect(outward.tracks[0]).toEqual(before.tracks[0])
  })

  it('splits the source range at speed and duplicates the full trimmed range', () => {
    const before = videoDoc()
    const split = valid(splitClip(before, 'o1', 2000, bounds))
    expect(split.tracks[1]!.clips.slice(0, 2)).toMatchObject([
      { startMs: 1000, inMs: 1000, outMs: 3000, speed: 2, fadeInMs: 500, fadeOutMs: 0, overlay: placement },
      { startMs: 2000, inMs: 3000, outMs: 5000, speed: 2, fadeInMs: 0, fadeOutMs: 500, overlay: placement },
    ])
    const duplicated = valid(duplicateClip(before, 'o1'))
    expect(duplicated.tracks[1]!.clips[1]).toEqual({ ...before.tracks[1]!.clips[0], id: expect.any(String), startMs: 3000 })
    expect(duplicated.tracks[1]!.clips[1]!.id).not.toBe('o1')
    expect(split.tracks[0]).toEqual(before.tracks[0])
  })

  it.each([0.25, 0.27, 0.3, 0.75, 1.01, 1.5])('keeps absolute ends and the adjacent successor when splitting at fractional speed %s', speed => {
    const before = videoDoc()
    const first = before.tracks[1]!.clips[0]!
    first.speed = speed
    const end = clipEndMs(first)
    before.tracks[1]!.clips[1]!.startMs = end
    for (const at of [first.startMs + 1033, first.startMs + 1067]) {
      const split = valid(splitClip(before, 'o1', at, bounds))
      const clips = split.tracks[1]!.clips
      expect(clips[0]!.startMs).toBe(first.startMs)
      expect(clipEndMs(clips[1]!)).toBe(end)
      expect(clipEndMs(clips[0]!)).toBeLessThanOrEqual(clips[1]!.startMs)
      expect(Math.abs(clips[1]!.startMs - at)).toBeLessThanOrEqual(4)
      expect(clips[1]!.inMs - clips[0]!.outMs).toBeLessThanOrEqual(1)
      expect(clips[2]).toEqual(before.tracks[1]!.clips[1])
      expect(split.tracks[0]).toEqual(before.tracks[0])
    }
  })

  it('rounds enough source milliseconds inward when a sped-up split would overlap', () => {
    const before = videoDoc()
    Object.assign(before.tracks[1]!.clips[0]!, { outMs: 1069, speed: 2.06, fadeInMs: 0, fadeOutMs: 0 })
    before.tracks[1]!.clips[1]!.startMs = 1033
    expect(TimelineDoc.safeParse(before).success).toBe(true)
    const next = valid(splitClip(before, 'o1', 1017, bounds))
    expect(next.tracks[1]!.clips.slice(0, 2)).toMatchObject([
      { startMs: 1000, inMs: 1000, outMs: 1033, speed: 2.06 },
      { startMs: 1016, inMs: 1035, outMs: 1069, speed: 2.06 },
    ])
    expect(clipEndMs(next.tracks[1]!.clips[0]!)).toBe(1016)
    expect(clipEndMs(next.tracks[1]!.clips[1]!)).toBe(1033)
    expect(next.tracks[1]!.clips[2]).toEqual(before.tracks[1]!.clips[1])
  })

  it('moves and deletes without changing source, speed, placement or caption linkage', () => {
    const before = videoDoc()
    const moved = valid(moveOverlay(before, 'o1', 'top', 6000))
    expect(moved.tracks[2]!.clips[0]).toEqual({ ...before.tracks[1]!.clips[0], startMs: 6000 })
    expect(moveOverlay(before, 'o1', 'bottom', 7000)).toEqual({ ok: false, reason: 'overlap' })
    const deleted = valid(deleteClips(before, ['o1']))
    expect(deleted.tracks[1]!.clips).toEqual([before.tracks[1]!.clips[1]])
    expect(linkCaptions(before, moved)).toEqual({ ok: true, doc: moved })
    const mainChanged = valid(deleteClips(before, ['v1']))
    const linked = linkCaptions(before, mainChanged)
    expect(linked.ok && linked.doc.tracks[1]).toEqual(before.tracks[1])
  })

  it('changes speed within the free gap, keeps source bounds and fits fades', () => {
    const before = videoDoc()
    const slowed = setSpeed(before, 'o1', 0.25, bounds)
    expect(slowed).toMatchObject({ ok: true, boundHit: true })
    const next = valid(slowed)
    expect(next.tracks[1]!.clips[0]).toMatchObject({ startMs: 1000, inMs: 1000, outMs: 5000, speed: 0.58 })
    expect(clipEndMs(next.tracks[1]!.clips[0]!)).toBeLessThanOrEqual(8000)
    expect(next.tracks[1]!.clips[1]).toEqual(before.tracks[1]!.clips[1])
    expect(next.tracks[0]).toEqual(before.tracks[0])
    const fast = valid(setSpeed(before, 'o1', 4, bounds))
    expect(fast.tracks[1]!.clips[0]).toMatchObject({ speed: 4, fadeInMs: 500, fadeOutMs: 500 })
    expect(setSpeed(before, 'o1', 0.1, bounds)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('updates video versions within the new source duration and retains placement', () => {
    const before = videoDoc()
    const next = valid(useNewVersion(before, 'o1', 'new_video', { kind: 'video', durationMs: 3000 }))
    expect(next.tracks[1]!.clips[0]).toMatchObject({ startMs: 1000, inMs: 1000, outMs: 3000, speed: 2, overlay: placement })
    expect(next.tracks[1]!.clips[1]).toEqual(before.tracks[1]!.clips[1])
  })
})
