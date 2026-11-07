import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assetLibrary, library } from '@vis/protocol'
import { currentSeq, eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createLibraryService, type LibraryService } from './service'
import { readLabelSnapshot } from './assets'
import * as assetReads from './assets'
import { createEntityService } from './entities'

let db: SpaceDb
let service: LibraryService
beforeEach(() => {
  db = openSpaceDb(':memory:')
  db.insert(s.blobs).values({ hash: 'blob', byteSize: 1, createdAt: 1 }).run()
  db.insert(s.operations).values({ id: 'op', actorKind: 'user', createdAt: 1 }).run()
  db.insert(s.workItems).values({ id: 'work', title: 'Library', workDir: '/work', status: 'in_progress',
    createdBy: { kind: 'user' }, createdAt: 1, statusChangedAt: 1 }).run()
  db.insert(s.sessions).values([
    { id: 'session', workItemId: 'work', agentKind: 'codex', title: 'Library', createdAt: 1 },
    { id: 'other', agentKind: 'codex', title: 'Other', createdAt: 1 },
  ]).run()
  service = createLibraryService({ db, blobPath: hash => resolve('blobs', hash), now: () => 100 })
})
afterEach(() => db.$client.close())

function asset(id: string, fields: Partial<typeof s.assets.$inferInsert> = {}) {
  db.insert(s.assets).values({ id, kind: 'image', origin: 'import', createdAt: 1, ...fields }).run()
  version(id, 1)
  return id
}
function version(assetId: string, version: number, sourceJobId?: string) {
  db.insert(s.assetVersions).values({ id: `${assetId}_${version}`, assetId, version, blobHash: 'blob', mime: 'image/png', createdAt: version,
    ...(sourceJobId ? { sourceJobId } : {}) }).run()
}
function node(id: string, assetId: string, fields: Partial<typeof s.nodes.$inferInsert> = {}) {
  db.insert(s.nodes).values({ id, kind: 'image', x: 0, y: 0, w: 100, h: 100, z: 0, createdAt: 1, ...fields }).run()
  db.insert(s.slots).values({ id: `${id}_slot`, nodeId: id, slotKey: 'main', contentType: 'image', currentRevision: 1 }).run()
  db.insert(s.slotRevisions).values({ slotId: `${id}_slot`, revision: 1, assetVersionId: `${assetId}_1`, operationId: 'op', createdAt: 1 }).run()
}
const list = (params: Record<string, unknown> = {}, caller: 'ui' | 'agent' = 'ui') => service.list(assetLibrary.list.params.parse(params), caller)
const find = (id: string) => list({ usage: 'unused' }).items.find(item => item.assetId === id)!
const update = (params: Record<string, unknown>) => service.update(assetLibrary.update.params.parse(params))
const label = (params: Record<string, unknown>, sessionId = 'session') => service.label(assetLibrary.label.params.parse(params), sessionId)
function run() {
  service.setSession({ sessionId: 'session' })
  return service.runStart({ requestId: 'start', kind: 'label' })
}

describe('media library reads', () => {
  it('excludes models and fonts from pagination, facets, search and unlabeled counts', () => {
    asset('a', { category: 'Media', displayName: 'Needle image', createdAt: 1 })
    asset('b', { kind: 'video', category: 'Media', displayName: 'Needle video', createdAt: 2 })
    for (const [index, kind] of (['font', 'model'] as const).entries()) {
      asset(kind, { kind, category: 'Nonmedia', displayName: 'Needle', createdAt: 10 + index })
      db.insert(s.assetTags).values({ assetId: kind, tag: 'Private', normalized: 'private' }).run()
    }
    db.insert(s.assetTags).values([{ assetId: 'a', tag: 'Visible', normalized: 'visible' }, { assetId: 'b', tag: 'Visible', normalized: 'visible' }]).run()
    const first = list({ limit: 1 })
    expect(first.items.map(item => item.assetId)).toEqual(['b'])
    expect(first.nextCursor).toBeDefined()
    expect(first.facets).toEqual({ categories: [{ name: 'Media', count: 2 }], tags: [{ name: 'Visible', count: 2 }] })
    const second = list({ limit: 1, cursor: first.nextCursor })
    expect(second.items.map(item => item.assetId)).toEqual(['a'])
    expect(second.nextCursor).toBeUndefined()
    expect(service.state().unlabeled).toEqual({ total: 2, needsViewing: 2 })
    expect(list({ query: 'needle' }).items.map(item => item.assetId)).toEqual(['b', 'a'])
    expect(list({ query: 'private' }).items).toEqual([])
    expect(list({ category: 'Nonmedia' }).items).toEqual([])
    expect(list({ tag: 'Private' }).items).toEqual([])
  })

  it.each(['font', 'model'] as const)('refuses %s metadata writes and version listing before changing asset metadata', kind => {
    asset(kind, { kind })
    const error = expect.objectContaining({ code: 'not_found', details: expect.objectContaining({ reason: 'asset.not_found' }) })
    expect(() => service.versions({ assetId: kind })).toThrow(error)
    expect(() => update({ assetId: kind, expectedRevision: 1, displayName: 'Renamed', category: 'Hidden', archived: true })).toThrow(error)
    expect(() => label({ requestId: `${kind}-label`, items: [{ assetId: kind, displayName: 'Renamed' }] })).toThrow(error)
    expect(db.query.assets.findFirst({ where: (assets, { eq }) => eq(assets.id, kind) }).sync()).toMatchObject({ revision: 1, displayName: null, category: null, archivedAt: null, labeledBy: null })
  })

  it('lists every version newest first without canvas references and rejects unknown assets', () => {
    asset('history')
    version('history', 2)
    const result = service.versions({ assetId: 'history' })
    expect(result.versions.map(version => version.assetVersionId)).toEqual(['history_2', 'history_1'])
    expect(result.versions.map(version => version.version)).toEqual([2, 1])
    expect(() => service.versions({ assetId: 'missing' })).toThrow(expect.objectContaining({ code: 'not_found' }))
  })
  it('leaves timeline fonts out of the media library', () => {
    asset('font', { kind: 'font' })
    asset('photo')
    expect(list({ usage: 'unused' }).items.map(item => item.assetId)).toEqual(['photo'])
    expect(list({ query: 'font' }).items).toEqual([])
    expect(service.state().unlabeled.total).toBe(1)
    expect(() => service.versions({ assetId: 'font' })).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() => label({ requestId: 'font-label', items: [{ assetId: 'font', displayName: 'Font' }] })).toThrow(expect.objectContaining({ code: 'not_found' }))
  })
  it('inherits the newest live node category, respects explicit categories and recognizes exported cuts', () => {
    asset('a')
    node('old', 'a', { category: 'Old', createdAt: 1 })
    node('new', 'a', { category: 'New', createdAt: 2 })
    node('uncategorized', 'a', { createdAt: 5 })
    node('deleted', 'a', { category: 'Deleted', createdAt: 3, deletedAt: 4 })
    expect(list().items[0]!.effectiveCategory).toBe('New')
    expect(list({ category: 'New' }).items.map(item => item.assetId)).toEqual(['a'])
    expect(list({ category: null }).items).toEqual([])
    db.update(s.assets).set({ category: 'Explicit' }).where(eq(s.assets.id, 'a')).run()
    expect(list().items[0]!.effectiveCategory).toBe('Explicit')
    asset('cut', { kind: 'video' })
    node('export', 'cut', { kind: 'video', exportOf: { timelineNodeId: 'timeline', timelineRevision: 1 } })
    expect(list().items.find(item => item.assetId === 'cut')!.effectiveCategory).toBe('成片')
    db.update(s.nodes).set({ deletedAt: 2 }).where(eq(s.nodes.id, 'export')).run()
    expect(find('cut').effectiveCategory).toBe('成片')
    node('cut-use', 'cut', { category: 'Review', createdAt: 5 })
    expect(list().items.find(item => item.assetId === 'cut')!.effectiveCategory).toBe('Review')
    update({ assetId: 'cut', expectedRevision: 1, category: 'Final' })
    expect(list().items.find(item => item.assetId === 'cut')!.effectiveCategory).toBe('Final')
  })

  it('counts distinct live nodes using any asset version only through current live slots', () => {
    asset('a')
    version('a', 2)
    asset('b')
    node('old-version', 'a')
    node('replaced', 'a')
    db.insert(s.slotRevisions).values({ slotId: 'replaced_slot', revision: 2, assetVersionId: 'b_1', operationId: 'op', createdAt: 2 }).run()
    db.update(s.slots).set({ currentRevision: 2 }).where(eq(s.slots.id, 'replaced_slot')).run()
    node('deleted', 'a', { deletedAt: 2 })
    node('deleted-slot', 'a')
    db.update(s.slots).set({ deletedAt: 2 }).where(eq(s.slots.id, 'deleted-slot_slot')).run()
    db.insert(s.slots).values({ id: 'second-slot', nodeId: 'old-version', slotKey: 'prompt', contentType: 'image', currentRevision: 1 }).run()
    db.insert(s.slotRevisions).values({ slotId: 'second-slot', revision: 1, assetVersionId: 'a_2', operationId: 'op', createdAt: 2 }).run()
    const a = list().items.find(item => item.assetId === 'a')!
    expect(a.usage).toEqual({ count: 1, nodeIds: ['old-version'] })
    expect(a.latest.assetVersionId).toBe('a_2')
    expect(a.versionCount).toBe(2)
    expect(list({ usage: 'used' }).items).toHaveLength(2)
    expect(list({ usage: 'unused' }).items).toHaveLength(0)
  })

  it('hides unused derived assets unless unused or query is explicitly requested', () => {
    asset('hidden', { origin: 'derived' })
    asset('visible', { origin: 'derived' })
    node('using', 'visible')
    expect(list().items.map(item => item.assetId)).toEqual(['visible'])
    expect(list({ usage: 'unused' }).items.map(item => item.assetId)).toEqual(['hidden'])
    for (const query of ['', '   ']) expect(list({ query }).items.map(item => item.assetId)).toEqual(['visible'])
    expect(list({ query: ' hidden ' }).items.map(item => item.assetId)).toEqual([])
    db.update(s.assets).set({ displayName: 'Hidden' }).where(eq(s.assets.id, 'hidden')).run()
    expect(list({ query: ' hidden ' }).items.map(item => item.assetId)).toEqual(['hidden'])
  })

  it('pages stably across equal timestamps and insertions and emits first-page facets under non-category/tag filters', () => {
    for (const id of ['a', 'b', 'c', 'd']) asset(id, { category: id < 'c' ? 'First' : 'Second' })
    label({ requestId: 'tags', items: [{ assetId: 'a', tags: ['Night'] }, { assetId: 'b', tags: ['night'] }, { assetId: 'c', tags: ['Day'] }] })
    const first = list({ category: 'Second', limit: 1 })
    expect(first.items.map(item => item.assetId)).toEqual(['d'])
    expect(first.facets!.categories).toEqual(expect.arrayContaining([{ name: 'First', count: 2 }, { name: 'Second', count: 2 }]))
    expect(first.facets!.tags).toEqual(expect.arrayContaining([expect.objectContaining({ count: 2 }), { name: 'Day', count: 1 }]))
    asset('newer', { createdAt: 2 })
    const second = list({ category: 'Second', limit: 1, cursor: first.nextCursor })
    expect(second.items.map(item => item.assetId)).toEqual(['c'])
    expect(second.facets).toBeUndefined()
    expect(second.nextCursor).toBeUndefined()
    const all = list({ limit: 2 })
    expect(list({ limit: 2, cursor: all.nextCursor }).items.map(item => item.assetId)).toEqual(['c', 'b'])
    expect(() => list({ cursor: 'bad' })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  })

  it('searches names, tags and live titles case-insensitively and returns context only to agents', () => {
    db.insert(s.generationJobs).values({ id: 'job', kind: 'image', provider: 'mock', model: 'mock', params: { prompt: 'A blue wolf' }, status: 'succeeded', createdAt: 1, updatedAt: 1 }).run()
    asset('a', { displayName: 'Wolf Portrait' })
    version('a', 2, 'job')
    node('using', 'a', { title: 'At SUNSET' })
    node('deleted', 'a', { title: 'Invisible', deletedAt: 2 })
    label({ requestId: 'tag', items: [{ assetId: 'a', tags: ['Moon'] }] })
    for (const query of ['wolf', 'MOON', 'sunset']) expect(list({ query }).items).toHaveLength(1)
    expect(list({ query: 'invisible' }).items).toHaveLength(0)
    expect(list().items[0]).not.toHaveProperty('context')
    expect(list({}, 'agent').items[0]!.context).toEqual({ nodeTitles: ['At SUNSET'], prompt: 'A blue wolf' })
    version('a', 3)
    expect(list({}, 'agent').items[0]!.context).toEqual({ nodeTitles: ['At SUNSET'] })
  })

  it('preserves Unicode case-insensitive searching when narrowing SQL candidates', () => {
    asset('named', { displayName: 'CAFÉ' })
    asset('titled')
    node('title', 'titled', { title: 'CAFÉ' })
    asset('tagged')
    label({ requestId: 'unicode', items: [{ assetId: 'tagged', tags: ['CAFÉ'] }] })
    expect(list({ query: ' café ' }).items.map(item => item.assetId)).toEqual(['titled', 'tagged', 'named'])
    expect(list({ query: 'café' }).facets!.categories).toEqual([{ name: null, count: 3 }])
  })

  it('filters archived, unlabeled and media kind, caps usage ids and retains full usage counts', () => {
    asset('a')
    asset('b', { kind: 'audio', archivedAt: 10 })
    for (let i = 0; i < 23; i++) node(`using-${i}`, 'a')
    expect(list().items[0]!.usage.count).toBe(23)
    expect(list().items[0]!.usage.nodeIds).toHaveLength(20)
    expect(list({ archived: true, kind: 'audio' }).items.map(item => item.assetId)).toEqual(['b'])
    label({ requestId: 'mark', items: [{ assetId: 'a', category: 'Portrait' }] })
    expect(list({ labeled: false }).items).toHaveLength(0)
    expect(list({ labeled: true, category: null }).items).toHaveLength(0)
    expect(list({ labeled: true, category: 'Portrait' }).items).toHaveLength(1)
  })

  it('prints listing time for 1000 assets and 2000 nodes without a wall-time assertion', () => {
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        asset(`asset-${i}`, { createdAt: i })
        node(`first-${i}`, `asset-${i}`, { title: `Portrait ${i}` })
        node(`second-${i}`, `asset-${i}`, { createdAt: 2, category: 'Portraits' })
      }
    })
    const started = performance.now()
    const page = list({}, 'agent')
    const elapsed = performance.now() - started
    console.info(`Library list: 1000 assets / 2000 nodes, first page ${elapsed.toFixed(1)} ms`)
    expect(page.items).toHaveLength(100)
    expect(page.items.every(item => item.usage.count === 2)).toBe(true)
    expect(page.facets!.categories).toEqual([{ name: 'Portraits', count: 1000 }])
    const stateStarted = performance.now()
    expect(service.state().unlabeled).toEqual({ total: 1000, needsViewing: 0 })
    console.info(`Library state: 1000 assets / 2000 nodes, ${(performance.now() - stateStarted).toFixed(1)} ms`)
    const blobPath = vi.fn((hash: string) => resolve('blobs', hash))
    const measured = createLibraryService({ db, blobPath })
    expect(measured.state().unlabeled.total).toBe(1000)
    expect(blobPath).not.toHaveBeenCalled()
    const updateStarted = performance.now()
    expect(measured.update({ assetId: 'asset-0', expectedRevision: 1, displayName: 'Mine' }).displayName).toBe('Mine')
    console.info(`Library update: 1000 assets / 2000 nodes, ${(performance.now() - updateStarted).toFixed(1)} ms`)
    expect(blobPath).toHaveBeenCalledTimes(1)
    blobPath.mockClear()
    expect(measured.list(assetLibrary.list.params.parse({ kind: 'audio' }), 'agent').items).toEqual([])
    expect(blobPath).not.toHaveBeenCalled()
    expect(measured.list(assetLibrary.list.params.parse({ tag: 'absent', cursor: Buffer.from(JSON.stringify([1000, 'z'])).toString('base64url') }), 'agent').items).toEqual([])
    expect(blobPath).not.toHaveBeenCalled()
  })
})

describe('library metadata writes', () => {
  it('reads an asset row once when a labeling batch touches it more than once', () => {
    asset('a')
    const { runId } = run()
    const read = vi.spyOn(assetReads, 'readAsset')
    try {
      expect(label({ requestId: 'repeated', runId, items: [
        { assetId: 'a', category: 'Portrait' },
        { assetId: 'a', tags: ['Night'] },
      ] }).labeled).toEqual(['a'])
      expect(read).toHaveBeenCalledTimes(1)
      expect(find('a')).toMatchObject({ category: 'Portrait', tags: ['Night'], revision: 3 })
      const change = db.select().from(s.libraryRunChanges).get()!
      expect(change.before).toMatchObject({ category: null, tags: [] })
      expect(change.after).toMatchObject({ category: 'Portrait', tags: ['Night'] })
    } finally { read.mockRestore() }
  })

  it('trims tags, deduplicates case-insensitively, enforces limits and supports case-insensitive tag filters', () => {
    asset('a')
    const updated = update({ assetId: 'a', expectedRevision: 1, tags: [' Moon ', 'moon', 'MOON', 'Night'] })
    expect(updated.tags).toEqual(['Moon', 'Night'])
    expect(list({ tag: 'mOoN' }).items).toHaveLength(1)
    expect(() => update({ assetId: 'a', expectedRevision: 2, tags: Array(11).fill('tag') })).toThrow()
    expect(() => label({ requestId: 'bad', items: [{ assetId: 'a', tags: ['x'.repeat(21)] }] })).toThrow()
    expect(() => label({ requestId: 'bad', items: Array(51).fill({ assetId: 'a', category: 'X' }) })).toThrow()
    expect(() => db.insert(s.assetTags).values({ assetId: 'a', tag: 'MOON', normalized: 'moon' }).run()).toThrow(/UNIQUE/)
  })

  it('checks revisions, protects edited fields and emits an asset update', () => {
    asset('a', { displayName: 'Original' })
    const before = currentSeq(db)
    const updated = update({ assetId: 'a', expectedRevision: 1, displayName: 'My name', category: null })
    expect(updated).toMatchObject({ displayName: 'My name', category: null, labeledBy: 'user', userFields: ['displayName', 'category'], revision: 2 })
    expect(readEventsAfter(db, before).map(event => ({ type: event.type, payload: event.payload }))).toEqual([{ type: 'asset.updated', payload: { assetId: 'a', revision: 2 } }])
    expect(() => update({ assetId: 'a', expectedRevision: 1, displayName: 'Stale' })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
    expect(find('a').displayName).toBe('My name')
    update({ assetId: 'a', expectedRevision: 2, archived: true })
    expect(list().items).toHaveLength(0)
    expect(list({ archived: true }).items[0]!.archived).toBe(true)
    update({ assetId: 'a', expectedRevision: 3, archived: false, displayName: null })
    expect(find('a').displayName).toBeUndefined()
  })

  it('applies submitted label fields before confirming all fields in one revision', () => {
    asset('a', { displayName: 'Original', category: 'Portrait' })
    label({ requestId: 'tags', items: [{ assetId: 'a', tags: ['Moon'] }] })
    const before = find('a')
    const confirmed = update({ assetId: 'a', expectedRevision: before.revision, confirm: true, displayName: 'Confirmed', category: 'Final', tags: ['Day'] })
    expect(confirmed).toMatchObject({ displayName: 'Confirmed', category: 'Final', tags: ['Day'], revision: before.revision + 1,
      labeledBy: 'user', userFields: ['displayName', 'category', 'tags'] })
    expect(label({ requestId: 'skip', items: [{ assetId: 'a', displayName: 'Other', category: 'Other', tags: ['Other'] }] })).toEqual({
      labeled: [], skippedFields: [{ assetId: 'a', fields: ['displayName', 'category', 'tags'] }],
    })
    expect(find('a').revision).toBe(confirmed.revision)
  })

  it('labels atomically, skips user fields, deduplicates retries and includes the session in the request identity', () => {
    asset('a', { displayName: 'Original' })
    asset('b')
    update({ assetId: 'a', expectedRevision: 1, displayName: 'My name' })
    const params = { requestId: 'label', items: [{ assetId: 'a', displayName: 'Agent name', tags: ['Night', 'night'] }, { assetId: 'b', category: 'Scene' }] }
    const result = label(params)
    expect(result).toEqual({ labeled: ['a', 'b'], skippedFields: [{ assetId: 'a', fields: ['displayName'] }] })
    expect(find('a')).toMatchObject({ displayName: 'My name', tags: ['Night'], labeledBy: 'agent', userFields: ['displayName'], revision: 3 })
    expect(find('b')).toMatchObject({ labeledBy: 'agent', revision: 2 })
    const seq = currentSeq(db)
    expect(label(params)).toEqual(result)
    expect(currentSeq(db)).toBe(seq)
    expect(() => label(params, 'other')).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
    expect(() => label({ requestId: 'atomic', items: [{ assetId: 'b', category: 'Changed' }, { assetId: 'missing', category: 'X' }] })).toThrow()
    expect(find('b').category).toBe('Scene')
    expect(currentSeq(db)).toBe(seq)
    expect(() => label({ ...params, items: [{ assetId: 'b', category: 'Other' }] })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
  })
})

describe('library sessions and organize runs', () => {
  it('refuses unlinked sessions and treats archived, deleted or unlinked selections as missing', () => {
    expect(() => service.setSession({ sessionId: 'other' })).toThrow(expect.objectContaining({ code: 'forbidden' }))
    for (const stale of ['archived', 'deleted', 'unlinked', 'work-archived', 'work-stopped', 'deleting']) {
      service.setSession({ sessionId: 'session' })
      if (stale === 'archived') db.update(s.sessions).set({ archivedAt: 2 }).where(eq(s.sessions.id, 'session')).run()
      if (stale === 'deleted') {
        db.$client.pragma('foreign_keys = OFF')
        db.delete(s.sessions).where(eq(s.sessions.id, 'session')).run()
        db.$client.pragma('foreign_keys = ON')
      }
      if (stale === 'unlinked') db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, 'session')).run()
      if (stale === 'work-archived') db.update(s.workItems).set({ archivedAt: 2 }).run()
      if (stale === 'work-stopped') db.update(s.workItems).set({ status: 'done' }).run()
      if (stale === 'deleting') db.insert(s.idempotencyKeys).values({
        requestId: 'deleting', method: 'work.delete', fingerprint: 'deleting', createdAt: 1,
        result: { workItemIds: ['work'], finished: false },
      }).run()
      expect(service.state().sessionId).toBeNull()
      expect(() => service.runStart({ requestId: `start-${stale}`, kind: 'label' })).toThrow(/Choose a library session/)
      db.insert(s.sessions).values({ id: 'session', workItemId: 'work', agentKind: 'codex', title: 'Library', createdAt: 1 })
        .onConflictDoUpdate({ target: s.sessions.id, set: { workItemId: 'work', archivedAt: null } }).run()
      db.update(s.workItems).set({ archivedAt: null, status: 'in_progress' }).run()
      db.delete(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, 'deleting')).run()
    }
  })

  it('requires an active project session and counts unlabeled media needing visual inspection', () => {
    expect(() => service.runStart({ requestId: 'start', kind: 'label' })).toThrow(/Choose a library session/)
    expect(() => service.setSession({ sessionId: 'absent' })).toThrow(expect.objectContaining({ code: 'not_found' }))
    db.update(s.sessions).set({ archivedAt: 1 }).where(eq(s.sessions.id, 'other')).run()
    expect(() => service.setSession({ sessionId: 'other' })).toThrow()
    asset('image')
    asset('video', { kind: 'video' })
    asset('audio', { kind: 'audio' })
    asset('context')
    node('named', 'context', { title: 'Reference' })
    asset('derived', { origin: 'derived' })
    asset('archived', { archivedAt: 2 })
    expect(service.setSession({ sessionId: 'session' })).toMatchObject({ sessionId: 'session', unlabeled: { total: 4, needsViewing: 2 } })
    const started = service.runStart({ requestId: 'start', kind: 'label' })
    expect(started).toMatchObject({ kind: 'label', sessionId: 'session', changeCount: 0 })
    expect(service.runStart({ requestId: 'start', kind: 'label' })).toEqual(started)
    expect(service.runList({ limit: 10 }).runs).toEqual([started])
    expect(service.setSession({ sessionId: null }).sessionId).toBeNull()
  })

  it('uses the latest version job prompt for needsViewing', () => {
    db.insert(s.generationJobs).values({ id: 'job', kind: 'video', provider: 'mock', model: 'mock', params: { prompt: 'A wolf running' }, status: 'succeeded', createdAt: 1, updatedAt: 1 }).run()
    asset('a')
    version('a', 2, 'job')
    expect(service.state().unlabeled).toEqual({ total: 1, needsViewing: 0 })
    version('a', 3)
    expect(service.state().unlabeled).toEqual({ total: 1, needsViewing: 1 })
    db.update(s.generationJobs).set({ params: { prompt: '\t\n ' } }).run()
    version('a', 4, 'job')
    expect(service.state().unlabeled).toEqual({ total: 1, needsViewing: 1 })
  })

  it('records the first before and latest after, reverts untouched labels and preserves user edits or confirmations', () => {
    for (const id of ['a', 'edited', 'confirmed']) asset(id, { displayName: 'Original' })
    const { runId } = run()
    label({ requestId: 'first', runId, items: ['a', 'edited', 'confirmed'].map(assetId => ({ assetId, displayName: 'First', tags: ['Night'] })) })
    label({ requestId: 'second', runId, items: [{ assetId: 'a', displayName: 'Second', category: 'Portrait' }] })
    expect(service.runList({ limit: 10 }).runs[0]!.changeCount).toBe(3)
    const change = db.select().from(s.libraryRunChanges).all().find(row => row.assetId === 'a')!
    expect(change.before).toMatchObject({ displayName: 'Original', category: null, labeledBy: null, tags: [] })
    expect(change.after).toEqual(readLabelSnapshot(db, 'a'))
    update({ assetId: 'edited', expectedRevision: 2, displayName: 'Mine' })
    update({ assetId: 'confirmed', expectedRevision: 2, confirm: true })
    const before = currentSeq(db)
    const result = service.runRevert({ requestId: 'revert', runId })
    expect(result.reverted).toEqual(['a'])
    expect(result.skipped).toEqual(['confirmed', 'edited'])
    expect(result.run).toMatchObject({ revertedAt: 100, changeCount: 3 })
    expect(find('a')).toMatchObject({ displayName: 'Original', category: null, tags: [], labeledBy: null, revision: 4 })
    expect(find('edited').displayName).toBe('Mine')
    expect(find('confirmed').labeledBy).toBe('user')
    expect(readEventsAfter(db, before).map(event => event.type)).toEqual(['asset.updated', 'library.changed'])
    expect(service.runRevert({ requestId: 'revert', runId })).toEqual(result)
    expect(() => service.runRevert({ requestId: 'again', runId })).toThrow(expect.objectContaining({ code: 'invalid_transition' }))
    expect(() => label({ requestId: 'after', runId, items: [{ assetId: 'a', category: 'X' }] })).toThrow(expect.objectContaining({ code: 'invalid_transition' }))
  })

  it('rejects labeling with absent, wrong-session or merge runs without writes', () => {
    asset('a')
    const { runId } = run()
    const params = { requestId: 'label', runId, items: [{ assetId: 'a', category: 'X' }] }
    expect(() => label(params, 'other')).toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(() => label({ ...params, runId: 'absent' })).toThrow(expect.objectContaining({ code: 'not_found' }))
    const merge = service.runStart({ requestId: 'merge', kind: 'merge' })
    expect(() => label({ ...params, runId: merge.runId })).toThrow(expect.objectContaining({ code: 'invalid_transition' }))
    expect(find('a').revision).toBe(1)
  })

  it('does not let an archive-only change prevent reverting labels', () => {
    asset('a')
    const { runId } = run()
    label({ requestId: 'label', runId, items: [{ assetId: 'a', category: 'Portrait' }] })
    update({ assetId: 'a', expectedRevision: 2, archived: true })
    expect(service.runRevert(library.runRevert.params.parse({ requestId: 'revert', runId })).reverted).toEqual(['a'])
    expect(list({ archived: true }).items[0]).toMatchObject({ archived: true, category: null, revision: 4 })
  })

  it('preserves user edits made between batches of the same run', () => {
    asset('new-protection')
    asset('existing-protection')
    update({ assetId: 'existing-protection', expectedRevision: 1, displayName: 'Original user name' })
    const { runId } = run()
    label({ requestId: 'first', runId, items: [
      { assetId: 'new-protection', category: 'Portrait' },
      { assetId: 'existing-protection', category: 'Portrait' },
    ] })
    update({ assetId: 'new-protection', expectedRevision: 2, displayName: 'New user name' })
    update({ assetId: 'existing-protection', expectedRevision: 3, displayName: 'Changed user name' })
    label({ requestId: 'second', runId, items: [
      { assetId: 'new-protection', tags: ['Night'] },
      { assetId: 'existing-protection', tags: ['Night'] },
    ] })
    const result = service.runRevert({ requestId: 'revert', runId })
    expect(result.reverted).toEqual([])
    expect(result.skipped).toEqual(['existing-protection', 'new-protection'])
    expect(find('new-protection').displayName).toBe('New user name')
    expect(find('existing-protection').displayName).toBe('Changed user name')
  })
})

describe('settings in the media library', () => {
  const settings = () => createEntityService({ db, now: () => 100 })
  const propose = (runId: string | undefined, assetId: string, requestId = `propose-${assetId}`, sessionId = 'session') =>
    settings().propose(sessionId, { requestId, ...(runId ? { runId } : {}), proposals: [{ kind: 'character', name: `Hero ${assetId}`, members: [{ assetId, role: 'image' }], reason: 'Same subject' }] }).proposalIds[0]!

  it('shows member and ref settings as chips and filters by the same relation', () => {
    asset('member')
    asset('ref')
    asset('loose')
    const hero = settings().create({ requestId: 'hero', kind: 'character', name: 'Hero', members: [{ assetId: 'member', role: 'image' }], refs: [{ assetVersionId: 'ref_1' }] })
    expect(find('member').entityIds).toEqual([hero.id])
    expect(find('ref').entityIds).toEqual([hero.id])
    expect(find('loose').entityIds).toEqual([])
    expect(list({ usage: 'unused', entityId: hero.id }).items.map(item => item.assetId).sort()).toEqual(['member', 'ref'])
    settings().delete({ entityId: hero.id, expectedRevision: hero.revision })
    expect(list({ usage: 'unused', entityId: hero.id }).items).toEqual([])
    expect(find('member').entityIds).toEqual([])
  })

  it('counts pending proposals in library state', () => {
    asset('a')
    asset('b')
    service.setSession({ sessionId: 'session' })
    propose(undefined, 'a')
    const accepted = propose(undefined, 'b')
    expect(service.state().pendingProposals).toBe(2)
    settings().proposalResolve({ requestId: 'accept', proposalId: accepted, accept: true })
    expect(service.state().pendingProposals).toBe(1)
  })

  it('ties proposals to the caller\'s active merge run, counts them and withdraws pending ones on revert', () => {
    asset('a')
    asset('b')
    asset('c')
    const labelRun = run()
    const mergeRun = service.runStart({ requestId: 'merge', kind: 'merge' })
    expect(() => propose(labelRun.runId, 'a')).toThrow(expect.objectContaining({ code: 'invalid_transition' }))
    expect(() => propose(mergeRun.runId, 'a', 'other-session', 'other')).toThrow(expect.objectContaining({ code: 'forbidden' }))
    expect(() => propose('absent', 'a')).toThrow(expect.objectContaining({ code: 'not_found' }))
    const pending = propose(mergeRun.runId, 'a')
    const accepted = propose(mergeRun.runId, 'b')
    const rejected = propose(mergeRun.runId, 'c')
    const resolve = settings().proposalResolve
    resolve({ requestId: 'accept', proposalId: accepted, accept: true })
    resolve({ requestId: 'reject', proposalId: rejected, accept: false })
    expect(service.runList({ limit: 10 }).runs.find(item => item.runId === mergeRun.runId)!.changeCount).toBe(3)
    // Each kind keeps its own history, so many merge runs never push label runs out of the list.
    expect(service.runList({ limit: 1, kind: 'label' }).runs.map(item => item.runId)).toEqual([labelRun.runId])
    expect(service.runList({ limit: 1, kind: 'merge' }).runs.map(item => item.runId)).toEqual([mergeRun.runId])
    const result = service.runRevert({ requestId: 'revert', runId: mergeRun.runId })
    expect(result).toMatchObject({ reverted: [pending], skipped: [accepted], run: { revertedAt: 100 } })
    expect(settings().proposalList({ status: 'pending' }).items).toEqual([])
    expect(find('b').entityIds).toHaveLength(1)
    expect(() => propose(mergeRun.runId, 'a', 'after-revert')).toThrow(expect.objectContaining({ code: 'invalid_transition' }))
  })
})
