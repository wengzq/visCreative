import { afterEach, beforeEach, expect, it } from 'vitest'
import type { CanvasOp, MediaKind, NodeView, TimelineClip, TimelineDoc } from '@vis/protocol'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createCanvasService, type CanvasService } from './service'
import type { Actor } from './apply'

const user = { kind: 'user' } as const
const agent = { kind: 'agent', sessionId: 'session' } as const
let db: SpaceDb
let canvas: CanvasService
let serial: number
const rid = () => `request_${++serial}`
const apply = (ops: CanvasOp[], actor: Actor = user) => canvas.apply(actor, { requestId: rid(), ops })
const node = (id: string) => canvas.get({ nodeIds: [id] }).nodes[0]!
const main = (id: string) => node(id).slots.find(slot => slot.slotKey === 'main')!
const document = (id: string): TimelineDoc => {
  const content = main(id).content
  if (content.type !== 'timeline') throw new Error('Expected a timeline document')
  return content.doc
}
const set = (id: string, doc: TimelineDoc, actor: Actor = user) => apply([
  { op: 'timeline.set', slotId: main(id).slotId, expectedRevision: main(id).revision, doc },
], actor)
const rejects = (ops: CanvasOp[], reason: string) => expect(() => apply(ops)).toThrow(expect.objectContaining({
  code: 'invalid_params', details: expect.objectContaining({ reason: `timeline.${reason}` }),
}))
const rejectDoc = (id: string, doc: TimelineDoc, reason: string) => rejects([
  { op: 'timeline.set', slotId: main(id).slotId, expectedRevision: main(id).revision, doc },
], reason)

beforeEach(() => {
  serial = 0
  db = openSpaceDb(':memory:')
  canvas = createCanvasService({ db })
  db.insert(s.sessions).values({ id: 'session', agentKind: 'codex', title: 'Editor', createdAt: 1 }).run()
})
afterEach(() => db.$client.close())

function asset(kind: MediaKind, durationMs: number | null = 5000, target = db) {
  const id = `version_${++serial}`
  target.insert(s.blobs).values({ hash: id, byteSize: 1, createdAt: 1 }).run()
  target.insert(s.assets).values({ id, kind, origin: 'import', createdAt: 1 }).run()
  target.insert(s.assetVersions).values({
    id, assetId: id, version: 1, blobHash: id, mime: { image: 'image/png', video: 'video/mp4', audio: 'audio/wav' }[kind],
    durationMs, createdAt: 1,
  }).run()
  return id
}

function source(kind: MediaKind, durationMs: number | null = 5000) {
  return apply([{ op: 'node.create', tempId: 'source', kind, content: { assetVersionId: asset(kind, durationMs) } }]).idMap.source!
}

function timeline(from?: string[]) {
  return apply([{ op: 'node.create', tempId: 'timeline', kind: 'timeline', ...(from ? { content: { timelineFrom: from } } : {}) }]).idMap.timeline!
}

function clip(id: string, outMs = 1000): TimelineClip {
  const content = main(id).content
  if (content.type !== 'asset') throw new Error('Expected a source asset')
  return { id: `clip_${++serial}`, source: { nodeId: id, assetVersionId: content.assetVersionId }, startMs: 0, inMs: 0, outMs, volume: 1, fadeInMs: 0, fadeOutMs: 0 }
}

it('creates an empty default document with unnamed video and audio tracks and a card size', () => {
  const id = timeline()
  expect(node(id)).toMatchObject({ w: 360, h: 300, exportOf: null })
  expect(main(id)).toMatchObject({ revision: 1, content: { type: 'timeline', doc: { version: 1, tracks: [
    { kind: 'video', muted: false, volume: 1, clips: [] },
    { kind: 'audio', muted: false, volume: 1, clips: [] },
  ] } } })
  const tracks = document(id).tracks
  expect(tracks.map(track => track.name)).toEqual([undefined, undefined])
  expect(new Set(tracks.map(track => track.id)).size).toBe(2)
  expect(tracks.every(track => track.id.length <= 16)).toBe(true)
})

it('initializes both tracks in caller order with full pinned assets, image defaults, and distinct inputs', () => {
  const first = source('video', 1250)
  const second = source('video', 2500)
  const image = source('image', null)
  const audio = source('audio', 7000)
  const otherAudio = source('audio', 800)
  const id = timeline([second, audio, image, first, second, otherAudio])
  const doc = document(id)
  expect(doc.tracks[0]!.clips.map(c => [c.source.nodeId, c.startMs, c.inMs, c.outMs])).toEqual([
    [second, 0, 0, 2500], [image, 2500, 0, 3000], [first, 5500, 0, 1250], [second, 6750, 0, 2500],
  ])
  expect(doc.tracks[1]!.clips.map(c => [c.source.nodeId, c.startMs, c.outMs])).toEqual([[audio, 0, 7000], [otherAudio, 7000, 800]])
  for (const c of doc.tracks.flatMap(track => track.clips)) {
    expect(c).toMatchObject({ volume: 1, fadeInMs: 0, fadeOutMs: 0, source: { assetVersionId: (main(c.source.nodeId).content as { assetVersionId: string }).assetVersionId } })
  }
  expect(node(id).inputs).toEqual([second, image, first, audio, otherAudio])
})

it('retains an empty audio track and resolves source tempIds in a creation batch', () => {
  const result = apply([
    { op: 'node.create', kind: 'video', tempId: 'shot', content: { assetVersionId: asset('video', 1000) } },
    { op: 'node.create', kind: 'timeline', tempId: 'cut', content: { timelineFrom: ['shot'] } },
  ])
  expect(document(result.idMap.cut!).tracks[1]!.clips).toEqual([])
  expect(node(result.idMap.cut!).inputs).toEqual([result.idMap.shot])
})

it('sets image display lengths from timelineFrom items and rejects them on other kinds', () => {
  const video = source('video', 2000)
  const result = apply([
    { op: 'node.create', kind: 'image', tempId: 'still', content: { assetVersionId: asset('image', null) } },
    { op: 'node.create', kind: 'timeline', tempId: 'cut', content: { timelineFrom: [video, { nodeId: 'still', durationMs: 4000 }] } },
  ])
  expect(document(result.idMap.cut!).tracks[0]!.clips.map(c => [c.source.nodeId, c.startMs, c.inMs, c.outMs])).toEqual([
    [video, 0, 0, 2000], [result.idMap.still, 2000, 0, 4000],
  ])
  rejects([{ op: 'node.create', kind: 'timeline', tempId: 'invalid', content: { timelineFrom: [{ nodeId: video, durationMs: 4000 }] } }], 'duration_image_only')
})

it('rejects missing, deleted, unsupported, empty, and durationless initialization sources atomically', () => {
  const empty = apply([{ op: 'node.create', tempId: 'empty', kind: 'video' }]).idMap.empty!
  const text = apply([{ op: 'node.create', tempId: 'text', kind: 'text' }]).idMap.text!
  const script = apply([{ op: 'node.create', tempId: 'script', kind: 'script' }]).idMap.script!
  const cut = timeline()
  const frame = apply([{ op: 'frame.create', tempId: 'frame', title: 'Sources', x: 0, y: 0, w: 600, h: 400 }]).idMap.frame!
  const deleted = source('video')
  apply([{ op: 'node.delete', nodeId: deleted }])
  const cases: [string, string][] = [
    ['missing', 'source_node_missing'], [deleted, 'source_node_missing'], [empty, 'source_asset_required'],
    [text, 'source_node_kind'], [script, 'source_node_kind'], [cut, 'source_node_kind'], [frame, 'source_node_kind'],
    [source('video', null), 'duration_missing'], [source('audio', null), 'duration_missing'],
  ]
  const count = canvas.get({}).nodes.length
  for (const [nodeId, reason] of cases) {
    rejects([{ op: 'node.create', kind: 'timeline', tempId: 'invalid', content: { timelineFrom: [nodeId] } }], reason)
    expect(canvas.get({}).nodes).toHaveLength(count)
  }
})

it('rejects timelineFrom on other node kinds and text or asset content on timeline nodes', () => {
  const media = source('video')
  for (const kind of ['text', 'script', 'image', 'video', 'audio'] as const) {
    rejects([{ op: 'node.create', kind, tempId: 'invalid', content: { timelineFrom: [media] } }], 'content_mismatch')
  }
  rejects([{ op: 'node.create', kind: 'timeline', tempId: 'invalid', content: { text: 'Invalid' } }], 'content_mismatch')
  rejects([{ op: 'node.create', kind: 'timeline', tempId: 'invalid', content: { assetVersionId: asset('video') } }], 'content_mismatch')
})

it('writes a full revision, synchronizes inputs on add and remove, and emits current content and edges', () => {
  const a = source('video')
  const b = source('audio')
  const id = timeline()
  const doc = document(id)
  doc.tracks[0]!.clips = [clip(a)]
  doc.tracks[1]!.clips = [clip(b)]
  set(id, doc)
  expect(main(id).revision).toBe(2)
  expect(node(id).inputs).toEqual([a, b])
  const event = readEventsAfter(db, 0).filter(event => event.type === 'slot.revised').at(-1)!
  expect(event.payload).toMatchObject({ revision: 2, slot: { content: { type: 'timeline', doc } } })
  const updated = readEventsAfter(db, 0).filter(event => event.type === 'node.updated').at(-1)!
  expect(updated.payload).toMatchObject({ inputs: [a, b] })
  doc.tracks[0]!.clips = []
  set(id, doc)
  expect(node(id).inputs).toEqual([b])
  doc.tracks[1]!.clips = []
  set(id, doc)
  expect(node(id).inputs).toBeUndefined()
})

it('rejects foreign and missing asset versions and foreign or missing source nodes', () => {
  const media = source('video')
  const id = timeline([media])
  const other = openSpaceDb(':memory:')
  try {
    const foreign = asset('video', 5000, other)
    for (const assetVersionId of [foreign, 'missing']) {
      const doc = document(id)
      doc.tracks[0]!.clips[0]!.source.assetVersionId = assetVersionId
      rejectDoc(id, doc, 'source_missing')
    }
    const foreignCanvas = createCanvasService({ db: other })
    const foreignNode = foreignCanvas.apply(user, { requestId: 'foreign', ops: [{ op: 'node.create', tempId: 'n', kind: 'video' }] }).idMap.n!
    for (const nodeId of ['missing', foreignNode]) {
      const doc = document(id)
      doc.tracks[0]!.clips[0]!.source.nodeId = nodeId
      rejectDoc(id, doc, 'source_node_missing')
    }
  } finally { other.$client.close() }
})

it('checks asset kinds per track and permits video soundtracks on audio tracks', () => {
  const video = source('video')
  const image = source('image')
  const audio = source('audio')
  const id = timeline()
  for (const [index, media] of [[0, audio], [1, image]] as const) {
    const doc = document(id)
    doc.tracks[index]!.clips = [clip(media)]
    rejectDoc(id, doc, 'source_kind')
  }
  const doc = document(id)
  doc.tracks[0]!.clips = [clip(image)]
  doc.tracks[1]!.clips = [clip(video)]
  set(id, doc)
  expect(document(id)).toEqual(doc)
})

it.each(['video', 'audio'] as const)('enforces registered %s duration with the 50 ms boundary tolerance', kind => {
  const media = source(kind, 1000)
  const id = timeline()
  const doc = document(id)
  const track = doc.tracks[kind === 'video' ? 0 : 1]!
  track.clips = [clip(media, 1050)]
  set(id, doc)
  track.clips[0]!.outMs = 1051
  rejectDoc(id, doc, 'source_range')
  track.clips = [clip(source(kind, null))]
  rejectDoc(id, doc, 'duration_missing')
})

it('enforces image in-points and both display-duration boundaries', () => {
  const media = source('image', null)
  const id = timeline()
  for (const duration of [500, 30000]) {
    const doc = document(id)
    doc.tracks[0]!.clips = [clip(media, duration)]
    set(id, doc)
  }
  for (const duration of [499, 30001]) {
    const doc = document(id)
    doc.tracks[0]!.clips = [clip(media, duration)]
    rejectDoc(id, doc, 'image_duration')
  }
  const doc = document(id)
  doc.tracks[0]!.clips = [{ ...clip(media), inMs: 1 }]
  rejectDoc(id, doc, 'image_in_point')
})

it('0024e: overlay tracks take images for up to the whole timeline and videos within their source, and reject audio', () => {
  const image = source('image', null)
  const id = timeline()
  const base = document(id)
  const withOverlay = (clips: TimelineClip[]) => {
    const doc = structuredClone(base)
    doc.tracks.splice(1, 0, { id: 'overlay', kind: 'overlay', muted: false, volume: 1, clips })
    return doc
  }
  const placed = (media: string, outMs: number) => ({ ...clip(media, outMs), overlay: { x: 0.9, y: 0.1, width: 0.12, opacity: 1 } })
  set(id, withOverlay([placed(image, 30 * 60_000)]))
  expect(document(id).tracks[1]).toMatchObject({ kind: 'overlay', clips: [{ outMs: 30 * 60_000 }] })
  expect(node(id).inputs).toContain(image)
  rejectDoc(id, withOverlay([placed(image, 499)]), 'image_duration')
  // E2: video picture-in-picture follows the main-track source rules
  const video = source('video')
  set(id, withOverlay([{ ...placed(video, 1000), speed: 2 }]))
  expect(document(id).tracks[1]!.clips[0]).toMatchObject({ outMs: 1000, speed: 2 })
  rejectDoc(id, withOverlay([placed(video, 60_000)]), 'source_range')
  rejectDoc(id, withOverlay([placed(source('audio'), 1000)]), 'source_kind')
})

it.each([1, 2])('rejects explicit image speed %s without replacing the committed timeline', speed => {
  const id = timeline([source('image', null)])
  const before = document(id)
  const doc = structuredClone(before)
  doc.tracks[0]!.clips[0]!.speed = speed
  rejectDoc(id, doc, 'speed_image')
  expect(document(id)).toEqual(before)
})

it('validates document structure even for internal callers and rolls back invalid replacements', () => {
  const id = timeline([source('video')])
  const before = document(id)
  const doc = structuredClone(before)
  doc.tracks[0]!.clips[0]!.startMs = 1
  rejectDoc(id, doc, 'invalid_doc')
  expect(document(id)).toEqual(before)
  expect(main(id).revision).toBe(1)
})

it('timeline.set errors include a guide hint and retain source validation metadata', () => {
  const id = timeline([source('video')])
  const doc = document(id)
  doc.tracks[0]!.clips[0]!.source.nodeId = 'missing-source'
  expect(() => set(id, doc)).toThrow(expect.objectContaining({
    code: 'invalid_params', details: { reason: 'timeline.source_node_missing', params: { nodeId: 'missing-source' } },
    message: 'The timeline source node does not exist in this project. See guide "timeline".',
  }))
  expect(main(id).revision).toBe(1)
})

it('timeline.set wrong-slot errors include a guide hint without changing metadata', () => {
  const media = source('video')
  const id = timeline()
  expect(() => apply([{ op: 'timeline.set', slotId: main(media).slotId, expectedRevision: 1, doc: document(id) }]))
    .toThrow(expect.objectContaining({
      code: 'invalid_params', details: { reason: 'timeline.slot_required', params: {} },
      message: 'Timeline operations require a timeline slot. See guide "timeline".',
    }))
})

it('preserves old pinned versions after regeneration and accepts deleted sources while excluding their inputs', () => {
  const media = source('video')
  const id = timeline([media])
  const doc = document(id)
  const sourceSlot = main(media)
  apply([{ op: 'slot.setAsset', slotId: sourceSlot.slotId, expectedRevision: sourceSlot.revision, assetVersionId: asset('video') }])
  set(id, doc)
  expect(document(id).tracks[0]!.clips[0]!.source).toEqual(doc.tracks[0]!.clips[0]!.source)
  apply([{ op: 'node.delete', nodeId: media }])
  set(id, doc)
  expect(document(id)).toEqual(doc)
  expect(node(id).inputs).toBeUndefined()
})

it('deduplicates inputs in track and clip order and excludes the timeline itself', () => {
  const a = source('video')
  const b = source('audio')
  const id = timeline()
  const doc = document(id)
  const first = clip(a)
  doc.tracks[0]!.clips = [first, { ...clip(a), startMs: first.outMs }]
  doc.tracks[1]!.clips = [clip(b), { ...clip(a), startMs: 1000 }, { ...clip(a), source: { ...first.source, nodeId: id }, startMs: 2000 }]
  set(id, doc)
  expect(node(id).inputs).toEqual([a, b])
})

it('undoes and redoes a user edit as one step restoring both the document and input relationships', () => {
  const a = source('video')
  const b = source('audio')
  const id = timeline([a])
  const before = document(id)
  const doc = structuredClone(before)
  doc.tracks[0]!.clips = []
  doc.tracks[1]!.clips = [clip(b)]
  const undoCount = db.select().from(s.undoEntries).all().length
  set(id, doc)
  expect(db.select().from(s.undoEntries).all()).toHaveLength(undoCount + 1)
  canvas.undo({ requestId: rid() })
  expect(document(id)).toEqual(before)
  expect(node(id).inputs).toEqual([a])
  canvas.redo({ requestId: rid() })
  expect(document(id)).toEqual(doc)
  expect(node(id).inputs).toEqual([b])
  set(id, before, agent)
  expect(db.select().from(s.undoEntries).all()).toHaveLength(undoCount + 1)
  expect(() => canvas.undo({ requestId: rid() })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
})

it('returns the pinned document in turn snapshot reads and immutable version history after edits and deletion', () => {
  const id = timeline([source('video')])
  const before = document(id)
  const slotId = main(id).slotId
  db.insert(s.messages).values({ id: 'message', sessionId: 'session', text: 'Edit', deliveryState: 'delivered', createdAt: 1 }).run()
  db.insert(s.turns).values({ id: 'turn', sessionId: 'session', messageId: 'message', status: 'running' }).run()
  db.insert(s.inputSnapshots).values({ id: 'snapshot', turnId: 'turn', createdAt: 1 }).run()
  db.insert(s.snapshotItems).values({ snapshotId: 'snapshot', ordinal: 0, nodeId: id, slotId, slotRevision: 1 }).run()
  const changed = structuredClone(before)
  changed.tracks[0]!.clips = []
  set(id, changed)
  expect(canvas.history({ slotId, limit: 10 }).versions.map(version => version.content)).toEqual([
    { type: 'timeline', doc: changed }, { type: 'timeline', doc: before },
  ])
  apply([{ op: 'node.delete', nodeId: id }])
  const snapshot = canvas.get({ snapshot: 'turn' }, { inputSnapshotId: 'snapshot' }).nodes[0] as NodeView
  expect(snapshot.slots[0]).toMatchObject({ revision: 1, content: { type: 'timeline', doc: before } })
})

it('reports revision conflicts through the batch conflict path and rolls back earlier operations', () => {
  const id = timeline()
  const slotId = main(id).slotId
  const before = document(id)
  set(id, before)
  expect(() => apply([
    { op: 'node.setMeta', nodeId: id, title: 'Rolled back' },
    { op: 'timeline.set', slotId, expectedRevision: 1, doc: before },
  ])).toThrow(expect.objectContaining({ code: 'revision_conflict', conflicts: [{ slotId, expectedRevision: 1, currentRevision: 2 }] }))
  expect(node(id).title).toBeNull()
  expect(main(id).revision).toBe(2)
})

it('rejects non-timeline slots and all generic content edits on a timeline slot', () => {
  const media = source('video')
  const id = timeline()
  rejects([{ op: 'timeline.set', slotId: main(media).slotId, expectedRevision: 1, doc: document(id) }], 'slot_required')
  for (const op of [
    { op: 'slot.clear' as const },
    { op: 'slot.setText' as const, body: 'Invalid' },
    { op: 'slot.setAsset' as const, assetVersionId: asset('video') },
  ]) {
    rejects([{ ...op, slotId: main(id).slotId, expectedRevision: 1 }], 'edit_required')
  }
  expect(main(id).revision).toBe(1)
  expect(db.select().from(s.slotRevisions).where(eq(s.slotRevisions.slotId, main(id).slotId)).all()).toHaveLength(1)
})
