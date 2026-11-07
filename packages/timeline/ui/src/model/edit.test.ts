import { describe, expect, it } from 'vitest'
import { TimelineDoc, clipDurationMs, clipEndMs, type TimelineClip } from '@vis/protocol'
import { addAudioTrack, sameDocument, canPlace, deleteClips, diffClips, duplicateClip, insertVideo, moveAudio, moveVideo, newId, nextFreeTime, placeAudio, removeAudioTrack, reorderAudioTrack, splitClip, trimClip, updateClip, updateTrack, useNewVersion, type EditResult } from './edit'
import { pxToTime, snapCandidates, snapTime, timecode, timeToPx, visibleWindow, parseTimecode } from './geometry'
import { acceptsMedia, appendMedia, latestExport, mediaClip, mediaNodes, nodeAsset } from './media'
import type { NodeView } from '@vis/protocol'

const clip = (id: string, startMs = 0, inMs = 0, outMs = 2000): TimelineClip => ({
  id, startMs, inMs, outMs, source: { nodeId: `node_${id}`, assetVersionId: `asset_${id}` }, volume: 1, fadeInMs: 0, fadeOutMs: 0,
})
const document = (): TimelineDoc => ({
  version: 1, tracks: [
    { id: 'video', kind: 'video', muted: false, volume: 1, clips: [clip('v1'), clip('v2', 2000)] },
    { id: 'music', kind: 'audio', muted: false, volume: 1, clips: [clip('a1', 1000), clip('a2', 4000)] },
    { id: 'sfx', kind: 'audio', muted: false, volume: 1, clips: [] },
  ],
})
function valid(result: EditResult) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw result
  expect(TimelineDoc.safeParse(result.doc).success).toBe(true)
  return result.doc
}
const node = (id: string, kind: NodeView['kind'] = 'video', title = id): NodeView => ({
  nodeId: id, kind, title, x: 0, y: 0, w: 100, h: 100, z: 0, layoutRevision: 1,
  slots: [{ slotId: `slot_${id}`, slotKey: 'main', contentType: kind === 'image' || kind === 'audio' ? kind : 'video', revision: 2, content: { type: 'asset', assetVersionId: `asset_${id}`, mime: `${kind}/mock` } }],
})

describe('timeline edit model', () => {
  it('chooses the highest export revision, breaking ties by canvas z', () => {
    const exported = (id: string, revision: number, z: number) => ({
      ...node(id), z, exportOf: { timelineNodeId: 'timeline', timelineRevision: revision },
    })
    const low = exported('z-last', 2, 1)
    const high = exported('a-first', 2, 5)
    const older = exported('older', 1, 10)
    expect(latestExport([low, older, high], 'timeline')).toBe(high)
    expect(latestExport([high, older, low], 'timeline')).toBe(high)
  })
  it('inserts multiple video clips and ripples without mutating the original', () => {
    const original = document()
    const next = valid(insertVideo(original, [clip('n1'), clip('n2')], 1))
    expect(next.tracks[0]!.clips.map(c => [c.id, c.startMs])).toEqual([['v1', 0], ['n1', 2000], ['n2', 4000], ['v2', 6000]])
    expect(original).toEqual(document())
    expect(valid(insertVideo({ version: 1, tracks: [] }, [clip('first')], 0)).tracks[0]!.kind).toBe('video')
  })
  it('moves video by final index and closes gaps after deletion', () => {
    const moved = valid(moveVideo(document(), 'v1', 1))
    expect(moved.tracks[0]!.clips.map(c => c.id)).toEqual(['v2', 'v1'])
    expect(moved.tracks[0]!.clips[1]!.startMs).toBe(2000)
    const deleted = valid(deleteClips(moved, ['v2', 'a1']))
    expect(deleted.tracks[0]!.clips[0]!.startMs).toBe(0)
    expect(deleted.tracks[1]!.clips[0]!.startMs).toBe(4000)
  })
  it('trims video with ripple, clamps source bounds, and reports the bound', () => {
    const result = trimClip(document(), 'v1', 'out', 6000, { kind: 'video', durationMs: 3000 })
    expect(result).toMatchObject({ ok: true, value: 3000, boundHit: true })
    const next = valid(result)
    expect(next.tracks[0]!.clips[1]!.startMs).toBe(3000)
    const trimmed = valid(trimClip(next, 'v1', 'in', 1000, { kind: 'video', durationMs: 3000 }))
    expect(trimmed.tracks[0]!.clips[1]!.startMs).toBe(2000)
    expect(trimClip(next, 'v1', 'in', -100, { kind: 'video' })).toMatchObject({ value: 0, boundHit: true })
    expect(trimClip(next, 'v1', 'out', 9000, { kind: 'video' })).toMatchObject({ value: 3000, boundHit: true })
  })
  it('enforces image range and keeps image in at zero', () => {
    const next = valid(trimClip(document(), 'v1', 'out', 50, { kind: 'image' }))
    expect(next.tracks[0]!.clips[0]).toMatchObject({ inMs: 0, outMs: 500 })
    expect(trimClip(next, 'v1', 'out', 40_000, { kind: 'image' })).toMatchObject({ value: 30_000, boundHit: true })
    expect(valid(trimClip(next, 'v1', 'in', 1000, { kind: 'image' })).tracks[0]!.clips[0]!.inMs).toBe(0)
  })
  it('places audio sorted and rejects overlaps and mismatched tracks', () => {
    const next = valid(placeAudio(document(), 'music', clip('new', 0, 0, 500), 3500))
    expect(next.tracks[1]!.clips.map(c => c.startMs)).toEqual([1000, 3500, 4000])
    expect(placeAudio(document(), 'music', clip('new'), 2500)).toEqual({ ok: false, reason: 'overlap' })
    expect(placeAudio(document(), 'video', clip('new'), 0).ok).toBe(false)
    expect(canPlace(document().tracks[1]!, 3000, 1000)).toBe(true)
    expect(canPlace(document().tracks[1]!, -1, 100)).toBe(false)
  })
  it('moves audio within and across tracks without changing its source range', () => {
    const within = valid(moveAudio(document(), 'a1', 'music', 0))
    expect(within.tracks[1]!.clips[0]).toMatchObject({ startMs: 0, inMs: 0, outMs: 2000 })
    expect(moveAudio(document(), 'a1', 'music', 4500).ok).toBe(false)
    const across = valid(moveAudio(document(), 'a1', 'sfx', 4500))
    expect(across.tracks[1]!.clips.map(c => c.id)).toEqual(['a2'])
    expect(across.tracks[2]!.clips[0]!.startMs).toBe(4500)
  })
  it('trims audio without ripple and stops at its neighbors', () => {
    const next = valid(trimClip(document(), 'a1', 'out', 9000, { kind: 'audio', durationMs: 10_000 }))
    expect(next.tracks[1]!.clips.map(c => c.startMs)).toEqual([1000, 4000])
    expect(next.tracks[1]!.clips[0]!.outMs).toBe(3000)
    const inward = valid(trimClip(document(), 'a1', 'in', 1000, { kind: 'audio', durationMs: 10_000 }))
    expect(inward.tracks[1]!.clips[0]).toMatchObject({ startMs: 2000, inMs: 1000 })
    const extend = structuredClone(inward)
    extend.tracks[1]!.clips[0]!.inMs = 1500
    expect(valid(trimClip(extend, 'a1', 'in', -1000, { kind: 'audio', durationMs: 10_000 })).tracks[1]!.clips[0]!.startMs).toBe(500)
  })
  it('splits video, audio and images with unique IDs and fitted fades', () => {
    for (const id of ['v1', 'a1']) {
      const doc = document()
      const entry = id === 'v1' ? doc.tracks[0]!.clips[0]! : doc.tracks[1]!.clips[0]!
      entry.fadeInMs = entry.fadeOutMs = 1000
      const next = valid(splitClip(doc, id, entry.startMs + 1000))
      const track = next.tracks[id === 'v1' ? 0 : 1]!
      const index = track.clips.findIndex(c => c.id === id)
      expect(track.clips[index]).toMatchObject({ outMs: 1000, fadeOutMs: 0 })
      expect(track.clips[index + 1]).toMatchObject({ inMs: 1000, fadeInMs: 0 })
    }
    const image = valid(splitClip(document(), 'v1', 1000, { kind: 'image' }))
    expect(image.tracks[0]!.clips.slice(0, 2).map(c => [c.inMs, c.outMs])).toEqual([[0, 1000], [0, 1000]])
    expect(splitClip(document(), 'v1', 400, { kind: 'image' }).ok).toBe(false)
    expect(splitClip(document(), 'v1', 0).ok).toBe(false)
  })
  it('duplicates video immediately after and audio into the next free space', () => {
    const video = valid(duplicateClip(document(), 'v1'))
    expect(video.tracks[0]!.clips.map(c => c.startMs)).toEqual([0, 2000, 4000])
    const audio = valid(duplicateClip(document(), 'a1'))
    expect(audio.tracks[1]!.clips.map(c => c.startMs)).toEqual([1000, 4000, 6000])
    expect(nextFreeTime(document().tracks[1]!, 0, 500)).toBe(0)
    expect(nextFreeTime(document().tracks[1]!, 3000, 1000)).toBe(3000)
  })
  it('adds at most four audio tracks, updates properties and only reorders audio', () => {
    let next = valid(addAudioTrack(document(), 'Voice'))
    next = valid(addAudioTrack(next))
    expect(addAudioTrack(next).ok).toBe(false)
    next = valid(updateTrack(next, 'music', { name: 'Renamed', muted: true, volume: 9 }))
    expect(next.tracks[1]).toMatchObject({ name: 'Renamed', muted: true, volume: 2 })
    next = valid(reorderAudioTrack(next, 'music', 3))
    expect(next.tracks[0]!.kind).toBe('video')
    expect(next.tracks.at(-1)!.id).toBe('music')
    expect(reorderAudioTrack(next, 'video', 1).ok).toBe(false)
    next = valid(removeAudioTrack(next, 'music'))
    expect(next.tracks.some(t => t.id === 'music')).toBe(false)
    expect(valid(removeAudioTrack(next, 'video')).tracks[0]!.id).toBe('video')
  })
  it('clamps volume and fades, and fits fades after a trim', () => {
    let next = valid(updateClip(document(), 'v1', { volume: -1, fadeInMs: 20_000, fadeOutMs: 20_000 }))
    expect(next.tracks[0]!.clips[0]).toMatchObject({ volume: 0, fadeInMs: 2000, fadeOutMs: 0 })
    next = valid(trimClip(next, 'v1', 'out', 500, { kind: 'video' }))
    expect(next.tracks[0]!.clips[0]!.fadeInMs).toBe(500)
    next = valid(updateClip(next, 'v1', { volume: 3 }))
    expect(next.tracks[0]!.clips[0]!.volume).toBe(2)
  })
  it('swaps pinned versions with duration clamping and rejects unknown duration or wrong kinds', () => {
    const doc = document()
    doc.tracks[0]!.clips[0]!.inMs = 1500
    doc.tracks[0]!.clips[1]!.startMs = 500
    const next = valid(useNewVersion(doc, 'v1', 'new_asset', { kind: 'video', durationMs: 1000 }))
    expect(next.tracks[0]!.clips[0]).toMatchObject({ source: { assetVersionId: 'new_asset' }, inMs: 999, outMs: 1000 })
    expect(next.tracks[0]!.clips[1]!.startMs).toBe(1)
    expect(useNewVersion(doc, 'v1', 'new_asset', { kind: 'video' }).ok).toBe(false)
    expect(useNewVersion(doc, 'v1', 'new_asset', { kind: 'audio', durationMs: 1000 }).ok).toBe(false)
    expect(valid(useNewVersion(doc, 'v1', 'new_image', { kind: 'image' })).tracks[0]!.clips[0]).toMatchObject({ inMs: 0, outMs: 500 })
  })
  it('reports added, removed and changed clips with their track and time', () => {
    const before = document()
    let next = valid(deleteClips(before, ['a1']))
    next = valid(updateClip(next, 'v1', { volume: 0 }))
    next = valid(placeAudio(next, 'sfx', clip('added'), 12_000))
    expect(diffClips(before, next)).toEqual([
      { type: 'changed', clipId: 'v1', trackId: 'video', trackName: undefined, startMs: 0 },
      { type: 'removed', clipId: 'a1', trackId: 'music', trackName: undefined, startMs: 1000 },
      { type: 'added', clipId: 'added', trackId: 'sfx', trackName: undefined, startMs: 12_000 },
    ])
    const moved = valid(moveAudio(before, 'a1', 'sfx', 1000))
    expect(diffClips(before, moved)[0]).toMatchObject({ type: 'changed', trackId: 'sfx' })
  })
  it('rejects duplicate IDs, invalid numbers, clip and timeline limits', () => {
    expect(insertVideo(document(), [clip('v1')], 0).ok).toBe(false)
    expect(trimClip(document(), 'v1', 'out', NaN, { kind: 'video' }).ok).toBe(false)
    expect(updateClip(document(), 'missing', {}).ok).toBe(false)
    expect(placeAudio(document(), 'sfx', clip('huge', 0, 0, 1_800_001), 0).ok).toBe(false)
    expect(insertVideo(document(), Array.from({ length: 200 }, (_, i) => clip(`new_${i}`)), 0).ok).toBe(false)
    expect(new Set(Array.from({ length: 100 }, () => newId(document()))).size).toBe(100)
  })

  it('0024d: document equality sees speed, transitions and text regardless of key order', () => {
    const base = document()
    const fast = structuredClone(base)
    fast.tracks[0]!.clips[0]!.speed = 2
    expect(sameDocument(base, fast)).toBe(false)
    const withTransition = structuredClone(base)
    withTransition.tracks[0]!.clips[1]!.transitionIn = { kind: 'dip', durationMs: 500 }
    expect(sameDocument(base, withTransition)).toBe(false)
    const text = { id: 'tx', startMs: 0, durationMs: 1000, text: '标题', style: { preset: 'title' as const, color: '#FFFFFF' }, fadeInMs: 0, fadeOutMs: 0 }
    const reordered = { fadeOutMs: 0, fadeInMs: 0, style: { color: '#FFFFFF', preset: 'title' as const }, text: '标题', durationMs: 1000, startMs: 0, id: 'tx' }
    expect(sameDocument({ ...base, textTracks: [{ id: 't', hidden: false, clips: [text] }] }, { ...base, textTracks: [{ clips: [reordered], hidden: false, id: 't' }] })).toBe(true)
    expect(sameDocument({ ...base, textTracks: [{ id: 't', hidden: false, clips: [text] }] }, { ...base, textTracks: [{ id: 't', hidden: false, clips: [{ ...text, text: '副标题' }] }] })).toBe(false)
    expect(sameDocument(base, { ...base, textTracks: [] })).toBe(true)
    // New ids avoid text ids too
    expect(newId({ ...base, textTracks: [{ id: 't', hidden: false, clips: [text] }] })).not.toBe('tx')
  })
})

describe('timeline geometry and media rules', () => {
  it('converts time and pixels and overscans one screen in both directions', () => {
    expect(timeToPx(2500, 80)).toBe(200)
    expect(pxToTime(200, 80)).toBe(2500)
    expect(visibleWindow(1600, 800, 80)).toEqual({ fromMs: 10_000, toMs: 40_000 })
    expect(visibleWindow(0, 800, 80).fromMs).toBe(0)
  })
  it('snaps within eight pixels at two zoom levels and exposes a guide', () => {
    expect(snapTime(1100, [1000], 60)).toEqual({ time: 1000, guide: 1000 })
    expect(snapTime(1100, [1000], 120)).toEqual({ time: 1100, guide: null })
    expect(snapTime(1050, [1000, 1075], 120)).toEqual({ time: 1075, guide: 1075 })
    expect(snapCandidates(document(), 1234, ['v1'])).toContain(1234)
    expect(snapCandidates(document(), 1234)).toContain(clipEndMs(document().tracks[1]!.clips[1]!))
  })
  it('formats and parses timecodes with the output frame rate', () => {
    expect(timecode(1500, 30)).toBe('00:01.15')
    expect(parseTimecode('00:01.15', 30)).toBe(1500)
    expect(parseTimecode('01:02:03.12', 30)).toBe(3723400)
    expect(parseTimecode('00:60.00', 30)).toBeNull()
    expect(timecode(12_500, 30, String)).toBe('00:12.15')
    expect(timecode(3_612_500, 30, String)).toBe('01:00:12.15')
    expect(parseTimecode('00:12.15')).toBe(12_500)
    expect(parseTimecode('12.5')).toBe(12_500)
    expect(parseTimecode('01:00:12.15')).toBe(3_612_500)
    expect(parseTimecode('00:99.00')).toBeNull()
    expect(parseTimecode('00:01.30')).toBeNull()
  })
  it('filters media by kind, asset availability and title search', () => {
    const media = [node('one', 'video', 'Morning'), node('two', 'image', 'Evening'), node('three', 'audio', 'Music'), { ...node('empty'), slots: [] }]
    expect(mediaNodes(media, 'all', '').length).toBe(3)
    expect(mediaNodes(media, 'video', 'morn').map(n => n.nodeId)).toEqual(['one'])
    expect(mediaNodes(media, 'all', 'MUSIC').map(n => n.nodeId)).toEqual(['three'])
    expect(nodeAsset(media[0]!)).toEqual({ assetVersionId: 'asset_one', revision: 2 })
    expect(acceptsMedia('video', 'audio')).toBe(false)
    expect(acceptsMedia('audio', 'image')).toBe(false)
    expect(acceptsMedia('audio', 'video')).toBe(true)
  })
  it('creates images at five seconds and waits for other source durations', () => {
    expect(mediaClip(document(), node('image', 'image'))).toMatchObject({ inMs: 0, outMs: 5000 })
    expect(mediaClip(document(), node('movie'))).toBeNull()
    const next = valid(appendMedia(document(), node('movie'), 3000, 0))
    expect(next.tracks[0]!.clips.at(-1)).toMatchObject({ startMs: 4000, outMs: 3000 })
  })
  it('appends audio at the playhead to a free track or creates another', () => {
    const next = valid(appendMedia(document(), node('sound', 'audio'), 1000, 1000))
    expect(next.tracks[2]!.clips[0]!.startMs).toBe(1000)
    const occupied = valid(placeAudio(document(), 'sfx', clip('busy'), 1000))
    const added = valid(appendMedia(occupied, node('sound', 'audio'), 1000, 1000))
    expect(added.tracks).toHaveLength(4)
    expect(clipDurationMs(added.tracks[3]!.clips[0]!)).toBe(1000)
  })
})
