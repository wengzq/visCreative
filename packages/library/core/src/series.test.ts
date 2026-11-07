import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAssetStore } from '@vis/assets'
import { eq, openSpaceDb, readEventsAfter, seriesSchema, spaceSchema as s } from '@vis/storage'
import { createEntityService } from './entities'
import { createSeriesEntityService } from './series-entities'
import { copySeriesBlob, createSeriesLibrary } from './series-library'

let serial = 0
const rid = () => `series-test-${++serial}`
let dir: string
let libraries: ReturnType<typeof createSeriesLibrary>
let projects: ReturnType<typeof project>[]
function project(id: string) {
  const db = openSpaceDb(':memory:')
  const assets = createAssetStore({ blobsDir: join(dir, id, 'blobs') })
  const onEntitiesChanged = vi.fn()
  const series = createSeriesEntityService({ db, assets, spaceId: id, libraries,
    series: () => ({ seriesId: 'series_one', name: 'Series', episode: 1 }), onEntitiesChanged })
  const entities = createEntityService({ db, latestSeriesRevisions: series.latestRevisions, onEntitiesChanged })
  return { id, db, assets, series, entities, onEntitiesChanged }
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-series-'))
  libraries = createSeriesLibrary({ dataDir: dir })
  projects = [project('one'), project('two')]
})
afterEach(() => {
  for (const project of projects) project.db.$client.close()
  libraries.closeAll()
  rmSync(dir, { recursive: true, force: true })
})
async function source() {
  const first = projects[0]!
  const image = first.assets.registerVersion(first.db, { staged: await first.assets.stageBytes(Buffer.from('reference image')), kind: 'image', mime: 'image/png', origin: 'import', width: 10, height: 20 })
  const voice = first.assets.registerVersion(first.db, { staged: await first.assets.stageBytes(Buffer.from('voice sample')), kind: 'audio', mime: 'audio/wav', origin: 'import', durationMs: 1234 })
  const entity = first.entities.create({ requestId: rid(), kind: 'character', name: 'Hero', description: 'Blue coat',
    refs: [{ assetVersionId: image.assetVersionId }], members: [{ assetId: image.assetId, role: 'image' }, { assetId: voice.assetId, role: 'voice' }] })
  const published = first.series.publish({ requestId: rid(), entityId: entity.id, expectedRevision: entity.revision })
  return { first, image, voice, ...published }
}

it('copies refs and voice into independent project assets, preserves metadata and deduplicates links by series setting', async () => {
  const { first, image, voice, seriesEntityId } = await source()
  const second = projects[1]!
  const linked = second.series.link({ requestId: rid(), seriesEntityId })
  expect(linked).toMatchObject({ name: 'Hero', description: 'Blue coat', series: { revision: 1, latestRevision: 1, modifiedLocally: false } })
  expect(linked.refs[0]!.assetVersionId).not.toBe(image.assetVersionId)
  expect(linked.members.map(member => member.role).sort()).toEqual(['image', 'voice'])
  expect(second.db.select().from(s.assets).all()).toEqual(expect.arrayContaining([expect.objectContaining({ origin: 'import', displayName: 'Hero' })]))
  for (const [originVersion, importedVersion] of [
    [image.assetVersionId, linked.refs[0]!.assetVersionId],
    [voice.assetVersionId, second.db.select().from(s.assetVersions).where(eq(s.assetVersions.assetId, linked.members.find(member => member.role === 'voice')!.assetId)).get()!.id],
  ]) {
    const original = first.assets.getVersion(first.db, originVersion!)!
    const imported = second.assets.getVersion(second.db, importedVersion!)!
    expect(readFileSync(second.assets.blobPath(imported.blobHash))).toEqual(readFileSync(first.assets.blobPath(original.blobHash)))
  }
  expect(second.series.link({ requestId: rid(), seriesEntityId }).id).toBe(linked.id)
  expect(second.entities.list({ includeDeleted: false }).items).toHaveLength(1)
  expect(second.series.list({}).items[0]).toMatchObject({ seriesEntityId, linkedEntityId: linked.id, linkedRevision: 1 })
  expect(second.series.list({ query: 'blue', kind: 'character' }).items).toHaveLength(1)
  expect(second.series.list({ kind: 'scene' }).items).toEqual([])
  expect(second.series.list({ query: 'unrelated' }).items).toEqual([])
  const media = libraries.mediaGet('series_one', libraries.revision('series_one', seriesEntityId).refs[0]!.refId)
  expect(media.mime).toBe('image/png')
  expect(readFileSync(media.path, 'utf8')).toBe('reference image')
  expect(() => libraries.mediaGet('series_other', libraries.revision('series_one', seriesEntityId).refs[0]!.refId)).toThrow(expect.objectContaining({ code: 'not_found' }))
})

it('falls back from hard links to copies, verifies hashes and rejects corrupt existing targets', () => {
  const sourcePath = join(dir, 'original')
  const target = join(dir, 'copied')
  const bytes = Buffer.from('verified bytes')
  writeFileSync(sourcePath, bytes)
  const media = { hash: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length }
  const crossVolume = vi.fn(() => { throw Object.assign(new Error('Different volumes'), { code: 'EXDEV' }) })
  copySeriesBlob(sourcePath, target, media, crossVolume)
  expect(crossVolume).toHaveBeenCalledOnce()
  expect(readFileSync(target)).toEqual(bytes)
  expect(statSync(target).ino).not.toBe(statSync(sourcePath).ino)
  copySeriesBlob(sourcePath, join(dir, 'linked'), media)
  expect(statSync(join(dir, 'linked')).ino).toBe(statSync(sourcePath).ino)
  writeFileSync(target, 'corruption')
  expect(() => copySeriesBlob(sourcePath, target, media)).toThrow('hash or size mismatch')
  expect(() => copySeriesBlob(sourcePath, join(dir, 'wrong'), { ...media, hash: '0'.repeat(64) })).toThrow('hash or size mismatch')
})

it('returns both collision ids, checks replacement revisions and keeps the existing setting id', async () => {
  const { seriesEntityId } = await source()
  const second = projects[1]!
  const local = second.entities.create({ requestId: rid(), kind: 'character', name: ' hero ', description: 'Local' })
  const attempt = () => second.series.link({ requestId: rid(), seriesEntityId })
  expect(attempt).toThrow(expect.objectContaining({ code: 'invalid_params', details: { reason: 'entity.name_taken', params: { entityId: local.id, seriesEntityId, kind: 'character', name: 'Hero' } } }))
  expect(() => second.series.link({ requestId: rid(), seriesEntityId, replaceEntityId: local.id })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  expect(() => second.series.link({ requestId: rid(), seriesEntityId, replaceEntityId: local.id, expectedRevision: 0 })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
  const replaced = second.series.link({ requestId: rid(), seriesEntityId, replaceEntityId: local.id, expectedRevision: 1 })
  expect(replaced).toMatchObject({ id: local.id, revision: 2, name: 'Hero', description: 'Blue coat', series: { modifiedLocally: false } })
  expect(second.onEntitiesChanged).toHaveBeenLastCalledWith(expect.anything(), [local.id])
})

it('tracks local modifications from their actual base, reads latest revisions once per list, and resets to the pin', async () => {
  const { first, entity, seriesEntityId } = await source()
  const second = projects[1]!
  const linked = second.series.link({ requestId: rid(), seriesEntityId })
  const edited = second.entities.update({ entityId: linked.id, expectedRevision: linked.revision, description: 'Local red coat' })
  expect(edited.series?.modifiedLocally).toBe(true)
  const changed = first.entities.update({ entityId: entity.id, expectedRevision: entity.revision, description: 'Green coat' })
  first.series.publish({ requestId: rid(), entityId: changed.id, expectedRevision: changed.revision })
  expect(second.entities.get({ entityId: linked.id }).series).toMatchObject({ revision: 1, latestRevision: 2, modifiedLocally: true })
  const latest = vi.spyOn(libraries, 'latestRevisions')
  second.entities.list({ includeDeleted: false })
  expect(latest).toHaveBeenCalledOnce()
  const reset = second.series.resetToSeries({ requestId: rid(), entityId: linked.id, expectedRevision: edited.revision })
  expect(reset).toMatchObject({ description: 'Blue coat', series: { revision: 1, latestRevision: 2, modifiedLocally: false } })
  expect(second.onEntitiesChanged).toHaveBeenLastCalledWith(expect.anything(), [linked.id])
  expect(second.series.diff({ entityId: linked.id })).toMatchObject({ pinned: { revision: 1, description: 'Blue coat' }, latest: { revision: 2, description: 'Green coat' } })
})

it('updates refs and voice while preserving episode members, bumps revision and calls the staleness hook', async () => {
  const { first, entity, seriesEntityId } = await source()
  const second = projects[1]!
  const linked = second.series.link({ requestId: rid(), seriesEntityId })
  const extra = second.assets.registerVersion(second.db, { staged: await second.assets.stageBytes(Buffer.from('extra clip')), kind: 'video', mime: 'video/mp4', origin: 'import' })
  const local = second.entities.update({ entityId: linked.id, expectedRevision: linked.revision, members: [...linked.members, { assetId: extra.assetId, role: 'video' }] })
  const sourceEdit = first.entities.update({ entityId: entity.id, expectedRevision: entity.revision, description: 'New description', refs: [] })
  first.series.publish({ requestId: rid(), entityId: entity.id, expectedRevision: sourceEdit.revision })
  const updated = second.series.updateFromSeries({ requestId: rid(), entityId: linked.id, expectedRevision: local.revision })
  expect(updated).toMatchObject({ revision: local.revision + 1, refs: [], description: 'New description', series: { revision: 2, modifiedLocally: false } })
  expect(updated.members).toEqual(expect.arrayContaining([{ assetId: extra.assetId, role: 'video' }]))
  expect(updated.members.filter(member => member.role === 'voice')).toHaveLength(1)
  expect(updated.members.filter(member => member.role === 'image')).toHaveLength(0)
  expect(second.onEntitiesChanged).toHaveBeenLastCalledWith(expect.anything(), [linked.id])
  expect(readEventsAfter(second.db, 0).at(-1)?.type).toBe('entity.updated')
})

it('treats the publishing project\'s own ref and voice members as series copies on later updates', async () => {
  const { first, entity, seriesEntityId } = await source()
  const second = projects[1]!
  const linked = second.series.link({ requestId: rid(), seriesEntityId })
  const edit = second.entities.update({ entityId: linked.id, expectedRevision: linked.revision, description: 'Series v2' })
  second.series.publish({ requestId: rid(), entityId: edit.id, expectedRevision: edit.revision })
  const current = first.entities.get({ entityId: entity.id })
  const updated = first.series.updateFromSeries({ requestId: rid(), entityId: current.id, expectedRevision: current.revision })
  expect(updated).toMatchObject({ description: 'Series v2', series: { revision: 2 } })
  expect(updated.members.filter(member => member.role === 'voice')).toHaveLength(1)
  expect(updated.members.filter(member => member.role === 'image')).toHaveLength(1)
})

it('requires a conflict choice and supports overwrite and taking the latest series copy', async () => {
  const { first, entity, seriesEntityId } = await source()
  const second = projects[1]!
  const linked = second.series.link({ requestId: rid(), seriesEntityId })
  const edit = first.entities.update({ entityId: entity.id, expectedRevision: entity.revision, description: 'Series v2' })
  first.series.publish({ requestId: rid(), entityId: edit.id, expectedRevision: edit.revision })
  const local = second.entities.update({ entityId: linked.id, expectedRevision: linked.revision, description: 'Episode two' })
  expect(() => second.series.publish({ requestId: rid(), entityId: linked.id, expectedRevision: local.revision })).toThrow(expect.objectContaining({
    code: 'revision_conflict', details: { reason: 'entity.series_moved', params: { seriesRevision: 2 } },
  }))
  const overwrite = second.series.publish({ requestId: rid(), entityId: local.id, expectedRevision: local.revision, resolve: 'overwrite' })
  expect(overwrite).toMatchObject({ seriesRevision: 3, entity: { series: { modifiedLocally: false } } })
  const current = first.entities.get({ entityId: entity.id })
  const take = first.series.publish({ requestId: rid(), entityId: current.id, expectedRevision: current.revision, resolve: 'takeSeries' })
  expect(take).toMatchObject({ seriesRevision: 3, entity: { description: 'Episode two', series: { revision: 3, modifiedLocally: false } } })
  const discard = first.entities.update({ entityId: take.entity.id, expectedRevision: take.entity.revision, description: 'Discard this edit' })
  expect(first.series.publish({ requestId: rid(), entityId: discard.id, expectedRevision: discard.revision, resolve: 'takeSeries' }))
    .toMatchObject({ seriesRevision: 3, entity: { description: 'Episode two', series: { modifiedLocally: false } } })
  expect(libraries.revision('series_one', seriesEntityId).revision).toBe(3)
})

it('publishes the latest version of the first voice member and rejects stale project writes', async () => {
  const { first, entity, voice, seriesEntityId } = await source()
  first.assets.registerVersion(first.db, { staged: await first.assets.stageBytes(Buffer.from('latest voice')), assetId: voice.assetId, kind: 'audio', mime: 'audio/wav', origin: 'import', durationMs: 2345 })
  const params = { requestId: rid(), entityId: entity.id, expectedRevision: entity.revision }
  first.series.publish(params)
  const revision = libraries.revision('series_one', seriesEntityId)
  expect(revision.voice?.durationMs).toBe(2345)
  expect(readFileSync(libraries.mediaGet('series_one', revision.voice!.refId).path, 'utf8')).toBe('latest voice')
  for (const method of [first.series.publish, first.series.updateFromSeries, first.series.resetToSeries]) {
    expect(() => method({ ...params, requestId: rid() })).toThrow(expect.objectContaining({ code: 'revision_conflict' }))
  }
  expect(libraries.revision('series_one', seriesEntityId).revision).toBe(2)
})

it('rejects series name collisions and changed publish request payloads', async () => {
  const { seriesEntityId } = await source()
  const second = projects[1]!
  const local = second.entities.create({ requestId: rid(), kind: 'character', name: ' hero ' })
  expect(() => second.series.publish({ requestId: rid(), entityId: local.id, expectedRevision: local.revision })).toThrow(expect.objectContaining({
    code: 'invalid_params', details: { reason: 'series.entity_name_taken', params: { seriesEntityId } },
  }))
  const linked = second.series.link({ requestId: rid(), seriesEntityId, replaceEntityId: local.id, expectedRevision: 1 })
  const params = { requestId: rid(), entityId: linked.id, expectedRevision: linked.revision }
  const result = second.series.publish(params)
  expect(second.series.publish(params)).toEqual(result)
  expect(() => second.series.publish({ ...params, resolve: 'overwrite' })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
})

it('finishes a same-requestId publication after a crash between the series and project commits', async () => {
  const first = projects[0]!
  const entity = first.entities.create({ requestId: rid(), kind: 'style', name: 'Ink' })
  const crash = vi.fn(() => { throw new Error('Crash after series commit') })
  const crashing = createSeriesEntityService({ db: first.db, assets: first.assets, spaceId: first.id, libraries,
    series: () => ({ seriesId: 'series_one', name: 'Series', episode: 1 }), afterSeriesWrite: crash })
  const params = { requestId: rid(), entityId: entity.id, expectedRevision: entity.revision }
  expect(() => crashing.publish(params)).toThrow('Crash after series commit')
  expect(first.entities.get({ entityId: entity.id }).series).toBeUndefined()
  expect(libraries.latest('series_one')).toHaveLength(1)
  const result = first.series.publish(params)
  expect(result.entity.series).toMatchObject({ revision: 1, modifiedLocally: false })
  expect(libraries.open('series_one').db.select().from(seriesSchema.seriesEntityRevisions).all()).toHaveLength(1)
  expect(first.series.publish(params)).toEqual(result)
})
