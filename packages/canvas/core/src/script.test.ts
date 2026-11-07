import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { VisError } from '@vis/domain'
import { ASSET_REF_PATTERN, EMPTY_SCRIPT, SCRIPT_LIMITS, type ScriptDoc, type ScriptOp, type ShotFields } from '@vis/protocol'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createCanvasService, type CanvasService } from './service'
import type { Actor } from './apply'

const user = { kind: 'user' } as const
const agent = { kind: 'agent', sessionId: 'session' } as const
let db: SpaceDb
let canvas: CanvasService
let slotId: string
let nodeId: string
let serial: number
const rid = () => `r${++serial}`

beforeEach(() => {
  serial = 0
  db = openSpaceDb(':memory:')
  canvas = createCanvasService({ db })
  db.insert(s.sessions).values({ id: 'session', agentKind: 'codex', title: 'Writer', createdAt: Date.now() }).run()
  const created = canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'script', kind: 'script' }] })
  nodeId = created.idMap.script!
  slotId = canvas.get({}).nodes[0]!.slots[0]!.slotId
})
afterEach(() => db.$client.close())

function doc(): ScriptDoc {
  const content = canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!.content
  if (content.type !== 'script') throw new Error('Expected a script document')
  return content.doc
}
const patch = (ops: ScriptOp[], actor: Actor = user) => canvas.apply(actor, { requestId: rid(), ops: [{ op: 'script.patch', slotId, ops }] })
function insertShots() {
  return patch([
    { kind: 'shot.insert', tempId: 'a', afterShotId: null, shot: { description: 'Opening' } },
    { kind: 'shot.insert', tempId: 'b', afterShotId: 'a', shot: { description: 'Walk away', transition: 'continuous' } },
    { kind: 'shot.insert', tempId: 'c', afterShotId: 'b', shot: { description: 'Arrival', transition: 'continuous' } },
  ]).idMap
}
function update(fields: ShotFields, actor: Actor = user) {
  const shot = doc().shots[0]!
  patch([{ kind: 'shot.update', shotId: shot.id, rev: shot.rev, fields }], actor)
}

it('creates an empty script main slot and editable prompt with script defaults', () => {
  expect(canvas.get({}).nodes[0]).toMatchObject({
    kind: 'script', w: 480, h: 320,
    slots: [
      { slotKey: 'main', contentType: 'script', revision: 1, content: { type: 'script', doc: EMPTY_SCRIPT } },
      { slotKey: 'prompt', contentType: 'text', revision: 1, content: { type: 'text', body: '' } },
    ],
  })
})

it.each(['script.patch', 'script.replace'] as const)('%s wrong-slot errors include a guide hint without changing metadata', op => {
  const created = canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'text', kind: 'text' }] })
  const textSlot = canvas.get({ nodeIds: [created.idMap.text!] }).nodes[0]!.slots[0]!
  const edit = op === 'script.patch'
    ? { op, slotId: textSlot.slotId, ops: [{ kind: 'doc.set' as const, rev: 0, fields: {} }] }
    : { op, slotId: textSlot.slotId, expectedRevision: textSlot.revision, doc: { shots: [], assets: [] } }
  expect(() => canvas.apply(user, { requestId: rid(), ops: [edit] })).toThrow(expect.objectContaining({
    code: 'invalid_params', details: { reason: 'script.slot_required', params: {} },
    message: 'Script operations require a script slot. See guide "script".',
  }))
})

it.each(['script.patch', 'script.replace'] as const)('%s document errors include a guide hint without changing metadata', op => {
  const edit = op === 'script.patch'
    ? { op, slotId, ops: [{ kind: 'shot.insert' as const, tempId: 'shot', afterShotId: null, shot: { description: 'x'.repeat(SCRIPT_LIMITS.cell + 1) } }] }
    : { op, slotId, expectedRevision: 1, doc: { assets: [], shots: [{ tempId: 'shot', description: 'x'.repeat(SCRIPT_LIMITS.cell + 1) }] } }
  expect(() => canvas.apply(user, { requestId: rid(), ops: [edit] })).toThrow(expect.objectContaining({
    code: 'invalid_params', details: { reason: 'script.invalid_fields', params: {} },
    message: `Script ${op === 'script.patch' ? 'operation' : 'document'} fields are invalid or exceed their limits. See guide "script".`,
  }))
  expect(doc()).toEqual(EMPTY_SCRIPT)
})

it.each([user, agent])('rejects clearing a script main slot for $kind without changing the document', actor => {
  insertShots()
  const before = doc()
  const slot = canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!
  expect(() => canvas.apply(actor, { requestId: rid(), ops: [{ op: 'slot.clear', slotId, expectedRevision: slot.revision }] }))
    .toThrow(expect.objectContaining({ code: 'invalid_params', details: { reason: 'canvas.script_clear_unsupported', params: {} } }))
  expect(doc()).toEqual(before)
  const prompt = canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[1]!
  expect(() => canvas.apply(actor, { requestId: rid(), ops: [{ op: 'slot.clear', slotId: prompt.slotId, expectedRevision: prompt.revision }] })).not.toThrow()
})

it('edits different rows without a slot revision condition and rejects same-row batches with current rows', () => {
  const ids = insertShots()
  const old = doc()
  patch([{ kind: 'shot.update', shotId: ids.a!, rev: 1, fields: { description: 'User edit' } }])
  patch([{ kind: 'shot.update', shotId: ids.b!, rev: old.shots[1]!.rev, fields: { dialogue: 'Agent edit' } }], agent)
  const before = doc()
  let error: VisError | undefined
  try {
    patch([
      { kind: 'shot.update', shotId: ids.b!, rev: 2, fields: { description: 'Must roll back' } },
      { kind: 'shot.update', shotId: ids.a!, rev: 1, fields: { description: 'Stale edit' } },
      { kind: 'shot.delete', shotId: ids.c!, rev: 0 },
    ])
  } catch (caught) { error = caught as VisError }
  expect(error?.code).toBe('revision_conflict')
  expect(JSON.parse((error?.details?.params as Record<string, string>).currentRows!)).toEqual([
    { kind: 'shot', id: ids.a, current: before.shots[0] },
    { kind: 'shot', id: ids.c, current: before.shots[2] },
  ])
  expect(doc()).toEqual(before)
})

it('resolves inserted row ids, asset ids, and asset tokens within the batch and emits one full revision', () => {
  const result = patch([
    { kind: 'asset.insert', tempId: 'hero', asset: { kind: 'character', name: ' Hero ' } },
    { kind: 'asset.insert', tempId: 'room', asset: { kind: 'scene', name: 'Room' } },
    { kind: 'asset.insert', tempId: 'key', asset: { kind: 'prop', name: 'Key' } },
    { kind: 'shot.insert', tempId: 'one', afterShotId: null, shot: { description: '{{asset:hero}} enters', transition: 'continuous', characterIds: ['hero'], sceneId: 'room', propIds: ['key'] } },
    { kind: 'shot.update', shotId: 'one', rev: 1, fields: { dialogue: 'Hello' } },
  ])
  expect(doc().shots[0]).toMatchObject({
    id: result.idMap.one, rev: 2, transition: 'cut', description: `{{asset:${result.idMap.hero}}} enters`,
    characterIds: [result.idMap.hero], sceneId: result.idMap.room, propIds: [result.idMap.key], dialogue: 'Hello',
  })
  const allEvents = readEventsAfter(db, 1)
  expect(allEvents.filter(event => event.type === 'entity.created')).toHaveLength(3)
  const events = allEvents.filter(event => event.type === 'slot.revised')
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: 'slot.revised', payload: { revision: 2, slot: { content: { type: 'script', doc: doc() } } } })
})

it('moves and deletes shots, normalizes the first shot, and validates afterShotId', () => {
  const ids = insertShots()
  patch([{ kind: 'shot.move', shotId: ids.b!, afterShotId: null }])
  expect(doc().shots.map(shot => [shot.id, shot.transition])).toEqual([[ids.b, 'cut'], [ids.a, 'cut'], [ids.c, 'continuous']])
  expect(doc().shots[0]!.rev).toBe(2)
  patch([{ kind: 'shot.delete', shotId: ids.b!, rev: doc().shots[0]!.rev }])
  patch([{ kind: 'shot.delete', shotId: ids.a!, rev: doc().shots[0]!.rev }])
  expect(doc().shots[0]).toMatchObject({ id: ids.c, transition: 'cut', rev: 2 })
  const before = doc()
  expect(() => patch([{ kind: 'shot.insert', tempId: 'x', afterShotId: 'missing', shot: { description: '' } }])).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  expect(() => patch([{ kind: 'shot.move', shotId: ids.c!, afterShotId: ids.c! }])).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  expect(doc()).toEqual(before)
})

it('resolves node tempIds and asset markers in inserted and updated asset fields', () => {
  const result = canvas.apply(user, { requestId: rid(), ops: [
    { op: 'node.create', tempId: 'reference', kind: 'image' },
    { op: 'script.patch', slotId, ops: [
      { kind: 'asset.insert', tempId: 'hero', asset: { kind: 'character', name: 'Hero' } },
      { kind: 'asset.insert', tempId: 'room', asset: { kind: 'scene', name: 'Room', imageNodeId: 'reference', description: '{{asset:hero}} waits' } },
      { kind: 'asset.update', assetId: 'hero', rev: 1, fields: { imageNodeId: 'reference', description: '{{asset:room}} and {{asset:room}}' } },
    ] },
  ] })
  expect(doc().assets).toMatchObject([
    { id: result.idMap.hero, imageNodeId: result.idMap.reference, description: `{{asset:${result.idMap.room}}} and {{asset:${result.idMap.room}}}` },
    { id: result.idMap.room, imageNodeId: result.idMap.reference, description: `{{asset:${result.idMap.hero}}} waits` },
  ])
})

it('resolves replacement asset image ids and markers including forward asset references', () => {
  const result = canvas.apply(user, { requestId: rid(), ops: [
    { op: 'node.create', tempId: 'reference', kind: 'image' },
    { op: 'script.replace', slotId, expectedRevision: 1, doc: { shots: [], assets: [
      { tempId: 'hero', kind: 'character', name: 'Hero', imageNodeId: 'reference', description: '{{asset:room}}' },
      { tempId: 'room', kind: 'scene', name: 'Room', description: '{{asset:hero}}' },
    ] } },
  ] })
  expect(doc().assets).toMatchObject([
    { id: result.idMap.hero, imageNodeId: result.idMap.reference, description: `{{asset:${result.idMap.room}}}` },
    { id: result.idMap.room, description: `{{asset:${result.idMap.hero}}}` },
  ])
})

it('uses the shared protocol marker pattern for repeated fields regardless of its lastIndex', () => {
  const replace = vi.spyOn(ASSET_REF_PATTERN, Symbol.replace)
  const text = '{{asset:hero}} + {{asset:hero}}'
  ASSET_REF_PATTERN.lastIndex = 10
  try {
    const result = patch([
      { kind: 'asset.insert', tempId: 'hero', asset: { kind: 'character', name: 'Hero' } },
      { kind: 'shot.insert', tempId: 'one', afterShotId: null, shot: { description: text, dialogue: text } },
    ])
    const expected = `{{asset:${result.idMap.hero}}} + {{asset:${result.idMap.hero}}}`
    expect(doc().shots[0]).toMatchObject({ description: expected, dialogue: expected })
    expect(replace).toHaveBeenCalledWith(text, expect.any(Function))
    expect(ASSET_REF_PATTERN.lastIndex).toBe(0)
  } finally { replace.mockRestore(); ASSET_REF_PATTERN.lastIndex = 0 }
})

it('resolves copied image prompt markers and reassigns prompt ownership on replacement', () => {
  const result = canvas.apply(user, { requestId: rid(), ops: [
    { op: 'node.create', tempId: 'copy-image', kind: 'image' },
    { op: 'script.replace', slotId, expectedRevision: 1, doc: {
      style: 'Ink', sessionId: 'session', assets: [],
      shots: [{ tempId: 'copy-shot', description: 'Opening', framePrompt: '{{ref:copy-image}} + {{ref:copy-image}}' }],
    } },
  ] })
  expect(doc()).toMatchObject({ style: 'Ink', sessionId: 'session', shots: [{
    framePrompt: `{{ref:${result.idMap['copy-image']}}} + {{ref:${result.idMap['copy-image']}}}`, promptState: 'edited',
  }] })
})

it('rejects document and asset revision mismatches without losing any changes', () => {
  const { idMap } = patch([{ kind: 'asset.insert', tempId: 'hero', asset: { kind: 'character', name: 'Hero' } }, { kind: 'doc.set', rev: 0, fields: { style: 'Ink' } }])
  const before = doc()
  expect(() => patch([{ kind: 'doc.set', rev: 0, fields: { sessionId: 'other' } }, { kind: 'asset.update', assetId: idMap.hero!, rev: 0, fields: { name: 'New' } }]))
    .toThrow(expect.objectContaining({ code: 'revision_conflict' }))
  expect(doc()).toEqual(before)
})

it('deletes asset references and marks affected prompts stale while preserving broken inline tags', () => {
  const { idMap } = patch([
    { kind: 'asset.insert', tempId: 'hero', asset: { kind: 'character', name: 'Hero' } },
    { kind: 'asset.insert', tempId: 'scene', asset: { kind: 'scene', name: 'Room' } },
    { kind: 'asset.insert', tempId: 'key', asset: { kind: 'prop', name: 'Key' } },
    { kind: 'shot.insert', tempId: 'a', afterShotId: null, shot: { description: '{{asset:hero}}', characterIds: ['hero'], sceneId: 'scene', propIds: ['key'], framePrompt: 'A still' } },
  ], agent)
  patch([{ kind: 'asset.delete', assetId: idMap.hero!, rev: 1 }, { kind: 'asset.delete', assetId: idMap.scene!, rev: 1 }, { kind: 'asset.delete', assetId: idMap.key!, rev: 1 }])
  expect(doc().shots[0]).toMatchObject({ rev: 4, characterIds: [], sceneId: null, propIds: [], promptState: 'stale', description: `{{asset:${idMap.hero}}}` })
})

it('sets prompt ownership, marks source changes stale, and clears state with the last prompt', () => {
  insertShots()
  update({ framePrompt: 'First', endFramePrompt: 'Last', videoPrompt: 'Move' }, agent)
  expect(doc().shots[0]!.promptState).toBe('agent')
  update({ dialogue: 'Hello', durationSec: 5 })
  expect(doc().shots[0]!.promptState).toBe('agent')
  update({ camera: 'Pan' })
  expect(doc().shots[0]!.promptState).toBe('stale')
  update({ framePrompt: 'User first' })
  expect(doc().shots[0]!.promptState).toBe('edited')
  update({ description: 'Changed' })
  expect(doc().shots[0]!.promptState).toBe('stale')
  update({ videoPrompt: 'New movement' }, agent)
  expect(doc().shots[0]!.promptState).toBe('agent')
  update({ framePrompt: null, endFramePrompt: '', videoPrompt: null })
  expect(doc().shots[0]!.promptState).toBeNull()
})

it.each(['name', 'description', 'imageNodeId'] as const)('asset %s changes stale prompts and bump affected rows only', field => {
  const { idMap } = patch([
    { kind: 'asset.insert', tempId: 'hero', asset: { kind: 'character', name: 'Hero' } },
    { kind: 'shot.insert', tempId: 'a', afterShotId: null, shot: { description: 'One', characterIds: ['hero'], framePrompt: 'Still' } },
    { kind: 'shot.insert', tempId: 'b', afterShotId: 'a', shot: { description: 'Two', framePrompt: 'Other' } },
  ], agent)
  patch([{ kind: 'asset.update', assetId: idMap.hero!, rev: 1, fields: { [field]: 'New value' } }])
  expect(doc().shots[0]).toMatchObject({ promptState: 'stale', rev: 2 })
  expect(doc().shots[1]).toMatchObject({ promptState: 'agent', rev: 1 })
})

it('replaces the document with assigned ids and keeps history, undo, and redo contents', () => {
  const before = doc()
  const result = canvas.apply(user, { requestId: rid(), ops: [{ op: 'script.replace', slotId, expectedRevision: 1, doc: {
    style: 'Ink', assets: [{ tempId: 'hero', kind: 'character', name: 'Hero' }],
    shots: [{ tempId: 'one', description: '{{asset:hero}}', transition: 'continuous', characterIds: ['hero'], framePrompt: 'Still' }],
  } }] })
  const replaced = doc()
  expect(replaced.shots[0]).toMatchObject({ id: result.idMap.one, rev: 1, transition: 'cut', characterIds: [result.idMap.hero], promptState: 'edited' })
  expect(canvas.history({ slotId, limit: 10 }).versions.map(version => version.content)).toEqual([{ type: 'script', doc: replaced }, { type: 'script', doc: before }])
  canvas.undo({ requestId: rid() })
  expect(doc()).toEqual(before)
  canvas.redo({ requestId: rid() })
  expect(doc()).toEqual(replaced)
  expect(() => canvas.apply(user, { requestId: rid(), ops: [{ op: 'script.replace', slotId, expectedRevision: 1, doc: { shots: [], assets: [] } }] })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
})

it('treats user patches as one undo step and does not add undo entries for agent patches', () => {
  insertShots()
  canvas.undo({ requestId: rid() })
  expect(doc().shots).toEqual([])
  canvas.redo({ requestId: rid() })
  const undoCount = db.select().from(s.undoEntries).all().length
  update({ framePrompt: 'Written' }, agent)
  expect(db.select().from(s.undoEntries).all()).toHaveLength(undoCount)
  expect(() => canvas.undo({ requestId: rid() })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
})

it('replacement keeps omitted document fields, accepts values or explicit null, and advances document revisions', () => {
  patch([{ kind: 'doc.set', rev: 0, fields: { style: 'Ink', sessionId: 'owner' } }])
  const replace = (fields: { style?: string | null; sessionId?: string | null }) => {
    const revision = canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!.revision
    canvas.apply(agent, { requestId: rid(), ops: [{ op: 'script.replace', slotId, expectedRevision: revision, doc: { shots: [], assets: [], ...fields } }] })
  }
  replace({})
  expect(doc()).toMatchObject({ style: 'Ink', sessionId: 'owner', rev: 2 })
  expect(() => patch([{ kind: 'doc.set', rev: 1, fields: { style: 'Old' } }])).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
  replace({ style: 'Photo', sessionId: 'other' })
  expect(doc()).toMatchObject({ style: 'Photo', sessionId: 'other', rev: 3 })
  replace({ style: null, sessionId: null })
  expect(doc()).toMatchObject({ style: null, sessionId: null, rev: 4 })
})

it.each(['transition', 'description', 'endState', 'shotSize', 'camera', 'sceneId', 'characterIds', 'propIds'] as const)('changing source field %s stales prompts', field => {
  const ids = insertShots()
  const assets = patch([
    { kind: 'asset.insert', tempId: 'scene', asset: { kind: 'scene', name: 'Room' } },
    { kind: 'asset.insert', tempId: 'hero', asset: { kind: 'character', name: 'Hero' } },
    { kind: 'asset.insert', tempId: 'prop', asset: { kind: 'prop', name: 'Key' } },
  ]).idMap
  patch([{ kind: 'shot.update', shotId: ids.c!, rev: 1, fields: { framePrompt: 'Still' } }], agent)
  const fields: Record<string, unknown> = {
    transition: 'cut', description: 'New frame', endState: 'New ending', shotSize: 'Close',
    camera: 'Pan', sceneId: assets.scene, characterIds: [assets.hero], propIds: [assets.prop],
  }
  patch([{ kind: 'shot.update', shotId: ids.c!, rev: 2, fields: { [field]: fields[field] } }])
  expect(doc().shots[2]!.promptState).toBe('stale')
})

it('rejects wrong slot types, duplicate temporary ids, invalid replace fields, and clearing all prompts resets state', () => {
  const node = canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'text', kind: 'text' }] })
  const textSlot = canvas.get({ nodeIds: [node.idMap.text!] }).nodes[0]!.slots[0]!
  expect(() => canvas.apply(user, { requestId: rid(), ops: [{ op: 'script.patch', slotId: textSlot.slotId, ops: [{ kind: 'doc.set', rev: 0, fields: {} }] }] })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  expect(() => patch([
    { kind: 'asset.insert', tempId: 'same', asset: { kind: 'scene', name: 'Scene' } },
    { kind: 'shot.insert', tempId: 'same', afterShotId: null, shot: { description: '' } },
  ])).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  expect(() => canvas.apply(user, { requestId: rid(), ops: [{ op: 'script.replace', slotId, expectedRevision: 1, doc: {
    assets: [], shots: [{ tempId: 'a', description: 'x'.repeat(SCRIPT_LIMITS.cell + 1) }],
  } }] })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  const count = db.select().from(s.undoEntries).all().length
  canvas.apply(agent, { requestId: rid(), ops: [{ op: 'script.replace', slotId, expectedRevision: 1, doc: { assets: [], shots: [{ tempId: 'a', description: 'Frame', framePrompt: 'Still' }] } }] })
  expect(doc().shots[0]!.promptState).toBe('agent')
  expect(db.select().from(s.undoEntries).all()).toHaveLength(count)
  update({ framePrompt: 'Still' })
  expect(doc().shots[0]!.promptState).toBe('edited')
  update({ framePrompt: null })
  expect(doc().shots[0]!.promptState).toBeNull()
})

it('validates asset reference kinds, cell lengths, and row limits atomically', () => {
  const before = doc()
  const invalid: ScriptOp[][] = [
    [{ kind: 'asset.insert', tempId: 'a', asset: { kind: 'prop', name: 'Key' } }, { kind: 'shot.insert', tempId: 'b', afterShotId: null, shot: { description: '', characterIds: ['a'] } }],
    [{ kind: 'shot.insert', tempId: 'a', afterShotId: null, shot: { description: 'x'.repeat(SCRIPT_LIMITS.cell + 1) } }],
    [{ kind: 'asset.insert', tempId: 'a', asset: { kind: 'character', name: 'Hero' } }, { kind: 'shot.insert', tempId: 'b', afterShotId: null, shot: { description: 'x'.repeat(SCRIPT_LIMITS.cell - '{{asset:a}}'.length) + '{{asset:a}}' } }],
    Array.from({ length: SCRIPT_LIMITS.assets + 1 }, (_, i) => ({ kind: 'asset.insert' as const, tempId: `a${i}`, asset: { kind: 'prop' as const, name: `Prop ${i}` } })),
    Array.from({ length: SCRIPT_LIMITS.opsPerBatch + 1 }, () => ({ kind: 'doc.set' as const, rev: 0, fields: {} })),
  ]
  for (const ops of invalid) {
    expect(() => patch(ops)).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(doc()).toEqual(before)
  }
  patch(Array.from({ length: SCRIPT_LIMITS.shots }, (_, i) => ({ kind: 'shot.insert', tempId: `s${i}`, afterShotId: null, shot: { description: '' } })))
  expect(() => patch([{ kind: 'shot.insert', tempId: 'overflow', afterShotId: null, shot: { description: '' } }])).toThrow(expect.objectContaining({ code: 'invalid_params' }))
})

it('stores shot links without requiring a live script and preserves linked nodes after script deletion', () => {
  const shot = { scriptNodeId: nodeId, shotId: 'shot', role: 'first' as const }
  const result = canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'image', kind: 'image', shot }] })
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.delete', nodeId }] })
  const image = canvas.get({ nodeIds: [result.idMap.image!] }).nodes[0]!
  expect(image.shot).toEqual(shot)
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId: image.nodeId, shot: null }] })
  expect(canvas.get({ nodeIds: [image.nodeId] }).nodes[0]!.shot).toBeNull()
  canvas.undo({ requestId: rid() })
  expect(canvas.get({ nodeIds: [image.nodeId] }).nodes[0]!.shot).toEqual(shot)
})

it('persists shot sources through replacement and row edits without touching the manuscript', () => {
  const created = canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'book', kind: 'text', content: { text: 'Dawn over the river.' } }] })
  const book = created.idMap.book!
  const source = { nodeId: book, quote: 'Dawn over the river.' }
  canvas.apply(agent, { requestId: rid(), ops: [{ op: 'script.replace', slotId, expectedRevision: 1, doc: { assets: [], shots: [{ tempId: 'shot', description: 'River at dawn', framePrompt: 'Fog', source }] } }] })
  expect(doc().shots[0]).toMatchObject({ source, promptState: 'agent' })
  update({ dialogue: 'Hello' })
  expect(doc().shots[0]!.source).toEqual(source)
  update({ source: { ...source, quote: 'A quote that is now stale' } })
  expect(doc().shots[0]).toMatchObject({ source: { ...source, quote: 'A quote that is now stale' }, promptState: 'agent' })
  update({ source: null })
  expect(doc().shots[0]!.source).toBeNull()
  expect(canvas.get({ nodeIds: [book] }).nodes[0]!.slots[0]!.content).toEqual({ type: 'text', body: 'Dawn over the river.' })
})
