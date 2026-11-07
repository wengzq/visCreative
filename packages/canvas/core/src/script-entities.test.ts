import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createEntityService, type EntityService } from '@vis/library-core'
import { type ScriptDoc, type ScriptOp } from '@vis/protocol'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createCanvasService, type CanvasService } from './service'
import { markScriptEntitiesChanged, migrateScriptEntities } from './script-entities'

let db: SpaceDb
let canvas: CanvasService
let settings: EntityService
let serial = 0
const rid = () => `request-${++serial}`
const user = { kind: 'user' } as const
beforeEach(() => {
  db = openSpaceDb(':memory:')
  canvas = createCanvasService({ db })
  settings = createEntityService({ db, onEntitiesChanged: (tx, ids) => markScriptEntitiesChanged(tx, ids) })
})
afterEach(() => db.$client.close())
function script(title = 'Episode') {
  const id = canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.create', kind: 'script', tempId: 'script', title }] }).idMap.script!
  const node = () => canvas.get({ nodeIds: [id] }).nodes[0]!
  const slot = () => node().slots[0]!
  const doc = () => { const content = slot().content; if (content.type !== 'script') throw new Error('Expected script'); return content.doc }
  const patch = (ops: ScriptOp[]) => canvas.apply(user, { requestId: rid(), ops: [{ op: 'script.patch', slotId: slot().slotId, ops }] })
  return { id, node, slot, doc, patch }
}
function image(id = rid()) {
  db.insert(s.blobs).values({ hash: id, byteSize: 1, createdAt: 1 }).run()
  db.insert(s.assets).values({ id, kind: 'image', origin: 'import', createdAt: 1 }).run()
  db.insert(s.assetVersions).values({ id, assetId: id, version: 1, blobHash: id, mime: 'image/png', createdAt: 1 }).run()
  return id
}
function cast(target: ReturnType<typeof script>, name = 'Hero') {
  return target.patch([
    { kind: 'asset.insert', tempId: 'hero', asset: { kind: 'character', name } },
    { kind: 'shot.insert', tempId: 'shot', afterShotId: null, shot: { description: 'Walk', characterIds: ['hero'], framePrompt: 'Walking' } },
  ]).idMap.hero!
}

it('reuses names across scripts and invalidates every referencing shot on shared edits and style changes', () => {
  const first = script('One')
  const second = script('Two')
  const id = cast(first)
  expect(cast(second, ' hero ')).toBe(id)
  const setting = settings.get({ entityId: id })
  expect(setting.usage).toEqual({ scriptNodeIds: [first.id, second.id], shotCount: 2 })
  settings.update({ entityId: id, expectedRevision: 1, description: 'Red coat' })
  for (const target of [first, second]) {
    expect(target.doc().shots[0]).toMatchObject({ promptState: 'stale', rev: 2 })
    expect(target.doc().assets[0]).toMatchObject({ rev: 2, description: 'Red coat' })
    const shot = target.doc().shots[0]!
    target.patch([{ kind: 'shot.update', shotId: shot.id, rev: shot.rev, fields: { framePrompt: 'New prompt' } }, { kind: 'doc.set', rev: 0, fields: { style: 'Ink' } }])
  }
  expect(first.doc().styleId).toBe(second.doc().styleId)
  const style = settings.get({ entityId: first.doc().styleId! })
  for (const target of [first, second]) {
    const shot = target.doc().shots[0]!
    target.patch([{ kind: 'shot.update', shotId: shot.id, rev: shot.rev, fields: { framePrompt: 'Ink prompt' } }])
  }
  settings.update({ entityId: style.id, expectedRevision: style.revision, description: 'Watercolor' })
  for (const target of [first, second]) expect(target.doc()).toMatchObject({ style: 'Watercolor', shots: [{ promptState: 'stale' }] })
})

it('checks shared entity revisions on aliases and removes only the current cast even after the last use', () => {
  const first = script()
  const second = script()
  const id = cast(first)
  cast(second)
  first.patch([{ kind: 'asset.update', assetId: id, rev: 1, fields: { name: 'Renamed' } }])
  expect(() => second.patch([{ kind: 'asset.update', assetId: id, rev: 1, fields: { name: 'Old writer' } }])).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
  first.patch([{ kind: 'asset.delete', assetId: id, rev: 2 }])
  expect(first.doc().castIds).toEqual([])
  expect(settings.get({ entityId: id }).deletedAt).toBeUndefined()
  second.patch([{ kind: 'asset.delete', assetId: id, rev: 2 }])
  expect(settings.get({ entityId: id }).deletedAt).toBeUndefined()
  expect(second.doc().shots[0]!.characterIds).toEqual([])
  expect(settings.get({ entityId: id }).revision).toBe(2)
})

it('accepts castIds and styleId directly, and replacement aliases reuse existing settings', () => {
  const target = script()
  const hero = settings.create({ requestId: rid(), kind: 'character', name: 'Hero' })
  const style = settings.create({ requestId: rid(), kind: 'style', name: 'Ink', description: 'Ink look' })
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'script.replace', slotId: target.slot().slotId, expectedRevision: 1,
    doc: { castIds: [hero.id], styleId: style.id, assets: [], shots: [{ tempId: 'shot', description: 'Walk', characterIds: [hero.id] }] } }] })
  expect(target.doc()).toMatchObject({ castIds: [hero.id], styleId: style.id, style: 'Ink look', assets: [{ id: hero.id }] })
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'script.replace', slotId: target.slot().slotId, expectedRevision: target.slot().revision,
    doc: { style: 'Ink look', assets: [{ tempId: 'hero', kind: 'character', name: ' Hero ' }], shots: [{ tempId: 'shot', description: 'Walk', characterIds: ['hero'] }] } }] })
  expect(target.doc().castIds).toEqual([hero.id])
  expect(target.doc().styleId).toBe(style.id)
  expect(settings.list({ includeDeleted: false }).items).toHaveLength(2)
})

it('deduplicates aliases within one patch or replacement while retaining immutable historical projections', () => {
  const target = script()
  const result = target.patch([
    { kind: 'asset.insert', tempId: 'one', asset: { kind: 'character', name: 'Hero' } },
    { kind: 'asset.insert', tempId: 'two', asset: { kind: 'character', name: ' hero ' } },
  ])
  expect(result.idMap.one).toBe(result.idMap.two)
  const oldRevision = target.slot().revision
  settings.update({ entityId: result.idMap.one!, expectedRevision: 1, description: 'Current coat' })
  const historical = canvas.history({ slotId: target.slot().slotId, limit: 50, includeDeleted: false }).versions.find(version => version.revision === oldRevision)!.content
  expect(historical.type === 'script' && historical.doc.assets[0]!.description).toBe('')
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'script.replace', slotId: target.slot().slotId, expectedRevision: target.slot().revision, doc: {
    assets: [{ tempId: 'one', kind: 'character', name: 'Hero', description: 'Historical coat' }, { tempId: 'two', kind: 'character', name: ' hero ' }],
    shots: [{ tempId: 'shot', description: 'Walk', characterIds: ['two'] }],
  } }] })
  expect(target.doc().assets).toHaveLength(1)
  expect(target.doc().assets[0]!.description).toBe('Historical coat')
  expect(target.doc().shots[0]!.characterIds).toEqual([result.idMap.one])
})

it('adopts a pending empty image on slot writes, then keeps the ref after node deletion', () => {
  const target = script()
  const id = cast(target)
  const nodeId = canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'ref', kind: 'image' }] }).idMap.ref!
  const slot = canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!
  target.patch([{ kind: 'asset.update', assetId: id, rev: 1, fields: { imageNodeId: nodeId } }])
  expect(target.doc().assets[0]!.imageNodeId).toBe(nodeId)
  expect(settings.get({ entityId: id }).refs).toEqual([])
  const version = image()
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'slot.setAsset', slotId: slot.slotId, expectedRevision: 0, assetVersionId: version }] })
  expect(settings.get({ entityId: id })).toMatchObject({ revision: 3, refs: [{ assetVersionId: version, sourceNodeId: nodeId }], members: [] })
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'slot.setAsset', slotId: slot.slotId, expectedRevision: 1, assetVersionId: image() }] })
  expect(settings.get({ entityId: id }).refs[0]!.assetVersionId).toBe(version)
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.delete', nodeId }] })
  expect(target.doc().assets[0]!.imageNodeId).toBeNull()
  expect(settings.get({ entityId: id }).refs[0]!.assetVersionId).toBe(version)
})

it('adopts generated delivery into a pending setting in the delivery transaction', () => {
  const target = script()
  const id = cast(target)
  const nodeId = canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'ref', kind: 'image' }] }).idMap.ref!
  const slot = canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!
  target.patch([{ kind: 'asset.update', assetId: id, rev: 1, fields: { imageNodeId: nodeId } }])
  db.insert(s.generationJobs).values({ id: 'job', kind: 'image', provider: 'mock', model: 'mock-image-1', params: {}, status: 'succeeded', createdAt: 1, updatedAt: 1 }).run()
  db.insert(s.deliveryBindings).values({ id: 'binding', jobId: 'job', outputIndex: 0, targetKind: 'slot', nodeId, slotId: slot.slotId, expectedContentRevision: 0, status: 'pending' }).run()
  db.update(s.slots).set({ acceptedBindingId: 'binding' }).where(eq(s.slots.id, slot.slotId)).run()
  const version = image()
  const before = readEventsAfter(db, 0).length
  db.transaction(tx => canvas.deliverOutput(tx, { bindingId: 'binding', assetVersionId: version }))
  expect(settings.get({ entityId: id }).refs).toEqual([{ assetVersionId: version, sourceNodeId: nodeId }])
  expect(readEventsAfter(db, 0).slice(before).map(event => event.type)).toContain('entity.updated')
})

it('migrates duplicate legacy names and identical style text once, preserving ids and historical embedded data', () => {
  const first = script('One')
  const second = script('Two')
  const version = image()
  const nodeId = canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'ref', kind: 'image', content: { assetVersionId: version } }] }).idMap.ref!
  const legacy = (id: string): ScriptDoc => ({
    version: 1, rev: 3, style: 'Ink', assets: [{ id, rev: 2, kind: 'character', name: 'Hero', description: 'Coat', imageNodeId: nodeId }],
    shots: [{ id: `${id}-shot`, rev: 1, transition: 'cut', description: `{{asset:${id}}}`, characterIds: [id], propIds: [] }],
  })
  for (const [target, id] of [[first, 'hero-one'], [second, 'hero-two']] as const) {
    db.update(s.slotRevisions).set({ scriptDoc: legacy(id) }).where(eq(s.slotRevisions.slotId, target.slot().slotId)).run()
  }
  migrateScriptEntities(db)
  expect(first.doc()).toMatchObject({ castIds: ['hero-one'], assets: [{ id: 'hero-one', rev: 2, name: 'Hero' }] })
  expect(second.doc()).toMatchObject({ castIds: ['hero-two'], assets: [{ id: 'hero-two', name: 'Hero · Two' }] })
  expect(first.doc().styleId).toBe(second.doc().styleId)
  expect(settings.get({ entityId: 'hero-one' }).refs).toEqual([{ assetVersionId: version, sourceNodeId: nodeId }])
  expect(settings.get({ entityId: 'hero-two' }).members).toEqual([{ assetId: version, role: 'image' }])
  expect(canvas.history({ slotId: first.slot().slotId, limit: 50, includeDeleted: false }).versions.at(-1)!.content).toEqual({ type: 'script', doc: legacy('hero-one') })
  const revisions = [first.slot().revision, second.slot().revision]
  const count = settings.list({ includeDeleted: false }).items.length
  migrateScriptEntities(db)
  expect([first.slot().revision, second.slot().revision]).toEqual(revisions)
  expect(settings.list({ includeDeleted: false }).items).toHaveLength(count)
})

it('migrates untitled script styles with the specified fallback and preserves pending empty images', () => {
  const target = script()
  const pendingId = canvas.apply(user, { requestId: rid(), ops: [
    { op: 'node.setMeta', nodeId: target.id, title: null }, { op: 'node.create', kind: 'image', tempId: 'pending' },
  ] }).idMap.pending!
  db.update(s.slotRevisions).set({ scriptDoc: {
    version: 1, rev: 1, style: 'Ink', assets: [{ id: 'legacy', rev: 1, kind: 'character', name: 'Hero', description: '', imageNodeId: pendingId }], shots: [],
  } }).where(eq(s.slotRevisions.slotId, target.slot().slotId)).run()
  migrateScriptEntities(db)
  expect(settings.get({ entityId: target.doc().styleId! }).name).toBe('脚本 1 风格')
  expect(target.doc().assets[0]!.imageNodeId).toBe(pendingId)
  expect(settings.get({ entityId: 'legacy' })).toMatchObject({ refs: [], members: [] })
  const slot = canvas.get({ nodeIds: [pendingId] }).nodes[0]!.slots[0]!
  const version = image()
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'slot.setAsset', slotId: slot.slotId, expectedRevision: 0, assetVersionId: version }] })
  expect(settings.get({ entityId: 'legacy' }).refs).toEqual([{ assetVersionId: version, sourceNodeId: pendingId }])
})

it('applies provided fields when insert and replace reuse a shared name, preserving omitted fields', () => {
  const first = script()
  const second = script()
  const id = cast(first)
  const ref = image()
  const nodeId = canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.create', kind: 'image', tempId: 'ref', content: { assetVersionId: ref } }] }).idMap.ref!
  second.patch([{ kind: 'asset.insert', tempId: 'same', asset: { kind: 'character', name: 'hero', description: 'Red coat', imageNodeId: nodeId } }])
  expect(settings.get({ entityId: id })).toMatchObject({ revision: 2, description: 'Red coat', refs: [{ assetVersionId: ref }], members: [] })
  expect(first.doc().shots[0]!.promptState).toBe('stale')
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'script.replace', slotId: second.slot().slotId, expectedRevision: second.slot().revision,
    doc: { assets: [{ tempId: 'same', kind: 'character', name: 'Hero', description: '' }], shots: [] } }] })
  expect(settings.get({ entityId: id })).toMatchObject({ revision: 3, description: '', refs: [{ assetVersionId: ref }] })
  second.patch([{ kind: 'asset.insert', tempId: 'same', asset: { kind: 'character', name: 'Hero' } }])
  expect(settings.get({ entityId: id }).revision).toBe(3)
})

it('unions explicit cast ids with inserted rows in stable order and keeps shot references', () => {
  const target = script()
  const old = settings.create({ requestId: rid(), kind: 'character', name: 'Old' })
  const result = canvas.apply(user, { requestId: rid(), ops: [{ op: 'script.replace', slotId: target.slot().slotId, expectedRevision: 1,
    doc: { castIds: [old.id], assets: [{ tempId: 'new', kind: 'character', name: 'New' }], shots: [{ tempId: 'shot', description: 'Walk', characterIds: ['new', old.id] }] } }] })
  expect(target.doc().castIds).toEqual([old.id, result.idMap.new])
  expect(target.doc().shots[0]!.characterIds).toEqual([result.idMap.new, old.id])
})

it('changes only the cover for imageNodeId aliases, including pending images and null', () => {
  const target = script()
  const cover = image()
  const other = image()
  const hero = settings.create({ requestId: rid(), kind: 'character', name: 'Hero', refs: [{ assetVersionId: cover }, { assetVersionId: other }] })
  target.patch([{ kind: 'doc.set', rev: 0, fields: { castIds: [hero.id] } }])
  const newCover = image()
  const nodes = canvas.apply(user, { requestId: rid(), ops: [
    { op: 'node.create', kind: 'image', tempId: 'filled', content: { assetVersionId: newCover } },
    { op: 'node.create', kind: 'image', tempId: 'pending' },
  ] }).idMap
  const update = (imageNodeId: string | null) => target.patch([{ kind: 'asset.update', assetId: hero.id, rev: target.doc().assets[0]!.rev, fields: { imageNodeId } }])
  update(nodes.filled!)
  expect(settings.get({ entityId: hero.id }).refs.map(ref => ref.assetVersionId)).toEqual([newCover, other])
  update(null)
  expect(settings.get({ entityId: hero.id }).refs.map(ref => ref.assetVersionId)).toEqual([other])
  settings.update({ entityId: hero.id, expectedRevision: 3, refs: [{ assetVersionId: cover }, { assetVersionId: other }] })
  update(nodes.pending!)
  expect(target.doc().assets[0]!.imageNodeId).toBe(nodes.pending)
  const slot = canvas.get({ nodeIds: [nodes.pending!] }).nodes[0]!.slots[0]!
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'slot.setAsset', slotId: slot.slotId, expectedRevision: 0, assetVersionId: newCover }] })
  expect(settings.get({ entityId: hero.id }).refs.map(ref => ref.assetVersionId)).toEqual([newCover, other])
})

it('adopts only the new image despite archived members and unrelated refs', () => {
  const target = script()
  const archived = image()
  const pending = canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.create', kind: 'image', tempId: 'pending' }] }).idMap.pending!
  const hero = settings.create({ requestId: rid(), kind: 'character', name: 'Hero', members: [{ assetId: archived, role: 'image' }], refs: [{ assetVersionId: image() }, { assetVersionId: archived }] })
  target.patch([{ kind: 'doc.set', rev: 0, fields: { castIds: [hero.id] } }, { kind: 'asset.update', assetId: hero.id, rev: 1, fields: { imageNodeId: pending } }])
  db.update(s.assets).set({ archivedAt: 1 }).where(eq(s.assets.id, archived)).run()
  const slot = canvas.get({ nodeIds: [pending] }).nodes[0]!.slots[0]!
  const ref = image()
  expect(() => canvas.apply(user, { requestId: rid(), ops: [{ op: 'slot.setAsset', slotId: slot.slotId, expectedRevision: 0, assetVersionId: ref }] })).not.toThrow()
  expect(settings.get({ entityId: hero.id })).toMatchObject({ refs: [{ assetVersionId: ref }, { assetVersionId: archived }], members: [{ assetId: archived, role: 'image' }] })
})

it('keeps paid delivery when a pending image cannot be adopted, leaving the setting unchanged and logging', () => {
  const target = script()
  const id = cast(target)
  const nodeId = canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.create', kind: 'image', tempId: 'pending' }] }).idMap.pending!
  target.patch([{ kind: 'asset.update', assetId: id, rev: 1, fields: { imageNodeId: nodeId } }])
  const before = settings.get({ entityId: id })
  const ref = image()
  db.update(s.assets).set({ archivedAt: 1 }).where(eq(s.assets.id, ref)).run()
  const slot = canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!
  db.insert(s.generationJobs).values({ id: 'job', kind: 'image', provider: 'mock', model: 'mock-image-1', params: {}, status: 'succeeded', createdAt: 1, updatedAt: 1 }).run()
  db.insert(s.deliveryBindings).values({ id: 'binding', jobId: 'job', outputIndex: 0, targetKind: 'slot', nodeId, slotId: slot.slotId, expectedContentRevision: 0, status: 'pending' }).run()
  db.update(s.slots).set({ acceptedBindingId: 'binding' }).where(eq(s.slots.id, slot.slotId)).run()
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(db.transaction(tx => canvas.deliverOutput(tx, { bindingId: 'binding', assetVersionId: ref })).status).toBe('delivered')
    expect(settings.get({ entityId: id })).toEqual(before)
    expect(log).toHaveBeenCalled()
  } finally { log.mockRestore() }
})

it('migrates deleted script heads so undoing deletion leaves editable settings', () => {
  const target = script()
  const slotId = target.slot().slotId
  db.update(s.slotRevisions).set({ scriptDoc: { version: 1, rev: 0, assets: [{ id: 'legacy', rev: 1, kind: 'character', name: 'Hero', description: '' }], shots: [] } }).where(eq(s.slotRevisions.slotId, slotId)).run()
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.delete', nodeId: target.id }] })
  migrateScriptEntities(db)
  expect(canvas.undo({ requestId: rid() })).not.toHaveProperty('nothing', true)
  target.patch([{ kind: 'asset.update', assetId: 'legacy', rev: 1, fields: { description: 'Editable after restore' } }])
  expect(target.doc().assets[0]!.description).toBe('Editable after restore')
})

it('skips archived and missing legacy image versions and reports each migration omission', () => {
  const target = script()
  const archived = image()
  const missing = image()
  const nodes = canvas.apply(user, { requestId: rid(), ops: [
    { op: 'node.create', kind: 'image', tempId: 'archived', content: { assetVersionId: archived } },
    { op: 'node.create', kind: 'image', tempId: 'missing', content: { assetVersionId: missing } },
  ] }).idMap
  db.update(s.assets).set({ archivedAt: 1 }).where(eq(s.assets.id, archived)).run()
  db.$client.exec('PRAGMA foreign_keys = OFF')
  db.delete(s.assetVersions).where(eq(s.assetVersions.id, missing)).run()
  db.$client.exec('PRAGMA foreign_keys = ON')
  db.update(s.slotRevisions).set({ scriptDoc: { version: 1, rev: 0, assets: [
    { id: 'legacy-archived', rev: 1, kind: 'character', name: 'Archived', description: '', imageNodeId: nodes.archived },
    { id: 'legacy-missing', rev: 1, kind: 'scene', name: 'Missing', description: '', imageNodeId: nodes.missing },
  ], shots: [] } }).where(eq(s.slotRevisions.slotId, target.slot().slotId)).run()
  const result = migrateScriptEntities(db)
  expect(result).toMatchObject({ migrated: 1, skippedRefs: [
    { entityId: 'legacy-archived', assetVersionId: archived },
    { entityId: 'legacy-missing', assetVersionId: missing },
  ] })
  expect(settings.get({ entityId: 'legacy-archived' })).toMatchObject({ refs: [], members: [] })
  expect(settings.get({ entityId: 'legacy-missing' })).toMatchObject({ refs: [], members: [] })
})

it('projects ten scripts with a hundred cast rows each using one settings query per canvas read', () => {
  const targets = Array.from({ length: 10 }, () => script())
  const nodeId = canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.create', kind: 'image', tempId: 'source' }] }).idMap.source!
  const castIds = Array.from({ length: 100 }, (_, i) => `cast-${i}`)
  db.insert(s.entities).values(castIds.map(id => ({ id, kind: 'character' as const, name: id, pendingSourceNodeId: nodeId, createdAt: 1, updatedAt: 1 }))).run()
  for (const target of targets) db.update(s.slotRevisions).set({ scriptDoc: { version: 1, rev: 0, castIds, assets: [], shots: [] } }).where(eq(s.slotRevisions.slotId, target.slot().slotId)).run()
  const prepare = vi.spyOn(db.$client, 'prepare')
  const start = performance.now()
  try {
    const nodes = canvas.get({ nodeIds: targets.map(target => target.id) }).nodes
    expect(nodes).toHaveLength(10)
    for (const node of nodes) expect(node.slots[0]!.content).toMatchObject({ type: 'script', doc: { assets: castIds.map(id => ({ id, imageNodeId: nodeId })) } })
    const queries = prepare.mock.calls.map(([query]) => query).filter(query => /^\s*select\b/i.test(query))
    console.info(`Projected 10 scripts x 100 cast in ${(performance.now() - start).toFixed(1)} ms with ${queries.length} SELECTs`)
    expect(queries.filter(query => query.includes('from "entities"'))).toHaveLength(1)
    expect(queries).toHaveLength(4)
  } finally { prepare.mockRestore() }
})
