import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { appSchema as a, eq, openAppDb } from '@vis/storage'
import { createSpaceRegistry } from './space-host'

let dir: string
let db: ReturnType<typeof openAppDb>
let registry: ReturnType<typeof createSpaceRegistry>
let serial = 0
const rid = () => `registry-series-${++serial}`
const hostOptions = { runtimes: {}, providers: [], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } } }
function registryOpen() { return createSpaceRegistry({ appDb: db, dataDir: dir, host: hostOptions }) }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-series-registry-'))
  db = openAppDb(join(dir, 'app.db'))
  registry = registryOpen()
})
afterEach(async () => {
  await registry.closeAll()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})
function space(name: string, series?: { seriesId: string } | { name: string }, episode?: number) {
  return registry.create({ requestId: rid(), name, rootPath: join(dir, 'projects', name), ...(series ? { series } : {}), ...(episode ? { episode } : {}) })
}
function setting(spaceId: string, name = 'Hero') {
  return registry.get(spaceId)!.entities.create({ requestId: rid(), kind: 'character', name, description: 'Original' })
}

it('manages series names, idempotent creation, membership and live setting counts', () => {
  const params = { requestId: rid(), name: '  Series  ' }
  const series = registry.series.create(params)
  expect(series).toMatchObject({ name: 'Series', episodes: [], settingCount: 0 })
  expect(registry.series.create(params)).toEqual(series)
  expect(() => registry.series.create({ ...params, name: 'Different' })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
  expect(() => registry.series.create({ requestId: rid(), name: 'sErIeS' })).toThrow(expect.objectContaining({ code: 'invalid_params', details: { reason: 'series.name_taken', params: { seriesId: series.seriesId } } }))
  const episode = space('Episode', { seriesId: series.seriesId })
  const hero = setting(episode.spaceId)
  registry.get(episode.spaceId)!.seriesEntities.publish({ requestId: rid(), entityId: hero.id, expectedRevision: hero.revision })
  expect(registry.series.list().items[0]).toMatchObject({ settingCount: 1, episodes: [{ spaceId: episode.spaceId, episode: 1 }] })
  expect(registry.series.rename({ seriesId: series.seriesId, name: 'Renamed' })).toMatchObject({ name: 'Renamed', settingCount: 1 })
  expect(registry.list()[0]?.series?.name).toBe('Renamed')
  const other = registry.series.create({ requestId: rid(), name: 'Other' })
  expect(() => registry.series.rename({ seriesId: other.seriesId, name: 'renamed' })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  expect(() => space('Duplicate', { name: 'Renamed' })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
})

it('assigns free episode numbers, enforces uniqueness and preserves or reallocates them on restore', async () => {
  const first = space('One', { name: 'Series' })
  const target = { seriesId: first.series!.seriesId }
  const third = space('Three', target, 3)
  const second = space('Two', target, 2)
  expect([first.series!.episode, second.series!.episode, third.series!.episode]).toEqual([1, 2, 3])
  expect(() => space('Conflict', target, 2)).toThrow(expect.objectContaining({ code: 'invalid_params', details: { reason: 'series.episode_taken', params: { episode: 2 } } }))
  await registry.delete({ requestId: rid(), spaceId: second.spaceId })
  const replacement = space('Replacement', target)
  expect(replacement.series!.episode).toBe(4)
  const restored = await registry.restore({ requestId: rid(), spaceId: second.spaceId })
  expect(restored.series).toMatchObject({ ...target, episode: 2 })
  await registry.delete({ requestId: rid(), spaceId: third.spaceId })
  space('Occupied', target, 3)
  expect((await registry.restore({ requestId: rid(), spaceId: third.spaceId })).series?.episode).toBe(5)
  expect(registry.series.list().items[0]?.episodes.map(episode => episode.episode)).toEqual([1, 2, 3, 4, 5])
})

it('defaults new episodes after the highest live number without reusing deleted gaps', async () => {
  const first = space('One', { name: 'Series' })
  const target = { seriesId: first.series!.seriesId }
  const second = space('Two', target)
  space('Three', target)
  await registry.delete({ requestId: rid(), spaceId: second.spaceId })
  expect(space('Four', target).series?.episode).toBe(4)
})

it('falls back to the first gap when the highest episode reaches the limit', () => {
  const first = space('One', { name: 'Series' })
  const target = { seriesId: first.series!.seriesId }
  space('Last', target, 9999)
  expect(space('Two', target).series?.episode).toBe(2)
})

it('joins before publishing settings in order, reports individual failures, and keeps the join idempotent', () => {
  const project = space('One')
  const hero = setting(project.spaceId)
  const other = setting(project.spaceId, 'Other')
  const params = { requestId: rid(), spaceId: project.spaceId, series: { name: 'Series' }, publishEntityIds: [hero.id, 'missing', other.id] }
  const result = registry.series.setSeries(params)
  expect(result).toMatchObject({ published: [hero.id, other.id], failed: [{ entityId: 'missing', code: 'not_found' }], series: { episode: 1, name: 'Series' } })
  expect(registry.series.setSeries(params)).toEqual(result)
  expect(registry.series.libraries.latest(result.series!.seriesId)).toHaveLength(2)
  expect(() => registry.series.setSeries({ ...params, series: null })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
  const second = space('Two', { seriesId: result.series!.seriesId })
  expect(() => registry.series.setSeries({ requestId: rid(), spaceId: project.spaceId, series: { seriesId: result.series!.seriesId }, episode: second.series!.episode })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  expect(registry.series.setSeries({ requestId: rid(), spaceId: project.spaceId, series: { seriesId: result.series!.seriesId }, episode: 10 }).series?.episode).toBe(10)
})

it('replays a checklist publish that committed before the join plan recorded it', () => {
  const project = space('One')
  const hero = setting(project.spaceId)
  const params = { requestId: rid(), spaceId: project.spaceId, series: { name: 'Series' }, publishEntityIds: [hero.id] }
  const result = registry.series.setSeries(params)
  expect(result.published).toEqual([hero.id])
  // Simulate studiod dying after the publish committed in both databases but before the plan saved it.
  const key = db.select().from(a.idempotencyKeys).where(eq(a.idempotencyKeys.requestId, params.requestId)).get()!
  const plan = key.result as { finished: boolean; result: { published: string[] } }
  db.update(a.idempotencyKeys).set({ result: { ...plan, finished: false, result: { ...plan.result, published: [] } } })
    .where(eq(a.idempotencyKeys.requestId, params.requestId)).run()
  expect(registry.series.setSeries(params)).toMatchObject({ published: [hero.id], failed: [] })
  expect(registry.series.libraries.latest(result.series!.seriesId)).toHaveLength(1)
})

it('detaches on leave, keeps the copied content and media, and leaves other episodes intact', async () => {
  const first = space('One', { name: 'Series' })
  const host = registry.get(first.spaceId)!
  const media = host.assets.registerVersion(host.db, { staged: await host.assets.stageBytes(Buffer.from('local bytes')), kind: 'image', origin: 'import', mime: 'image/png' })
  const hero = host.entities.create({ requestId: rid(), kind: 'character', name: 'Hero', refs: [{ assetVersionId: media.assetVersionId }] })
  const published = host.seriesEntities.publish({ requestId: rid(), entityId: hero.id, expectedRevision: hero.revision })
  const second = space('Two', { seriesId: first.series!.seriesId })
  const other = registry.get(second.spaceId)!
  const linked = other.seriesEntities.link({ requestId: rid(), seriesEntityId: published.seriesEntityId })
  registry.series.setSeries({ requestId: rid(), spaceId: second.spaceId, series: null })
  expect(other.entities.get({ entityId: linked.id })).toMatchObject({ name: linked.name, refs: linked.refs, members: linked.members })
  expect(other.entities.get({ entityId: linked.id }).series).toBeUndefined()
  expect(other.seriesEntities.list({})).toEqual({ series: null, items: [] })
  const version = other.assets.getVersion(other.db, linked.refs[0]!.assetVersionId)!
  expect(readFileSync(other.assets.blobPath(version.blobHash), 'utf8')).toBe('local bytes')
  expect(host.entities.get({ entityId: hero.id }).series?.revision).toBe(1)
})

it('records pending detach on series deletion and applies it once when a closed project opens', async () => {
  const first = space('One', { name: 'Series' })
  const hero = setting(first.spaceId)
  const host = registry.get(first.spaceId)!
  host.seriesEntities.publish({ requestId: rid(), entityId: hero.id, expectedRevision: 1 })
  const linked = host.entities.get({ entityId: hero.id })
  await registry.closeAll()
  registry = registryOpen()
  const params = { requestId: rid(), seriesId: first.series!.seriesId }
  expect(registry.series.delete(params)).toMatchObject({ detachedSpaceIds: [first.spaceId] })
  expect(db.select().from(a.spaces).where(eq(a.spaces.id, first.spaceId)).get()).toMatchObject({ seriesId: null, seriesDetachPending: true })
  const reopened = registry.get(first.spaceId)!
  expect(reopened.entities.get({ entityId: hero.id })).toMatchObject({ revision: linked.revision + 1, description: 'Original' })
  expect(reopened.entities.get({ entityId: hero.id }).series).toBeUndefined()
  expect(db.select().from(a.spaces).where(eq(a.spaces.id, first.spaceId)).get()?.seriesDetachPending).toBe(false)
  expect(registry.series.delete(params).detachedSpaceIds).toEqual([first.spaceId])
  expect(registry.get(first.spaceId)!.entities.get({ entityId: hero.id }).revision).toBe(linked.revision + 1)
  expect(registry.series.list().items).toEqual([])
})

it('detaches open episodes on series deletion and keeps a deleted episode independent of its series', async () => {
  const first = space('One', { name: 'Series' })
  const hero = setting(first.spaceId)
  registry.get(first.spaceId)!.seriesEntities.publish({ requestId: rid(), entityId: hero.id, expectedRevision: 1 })
  const second = space('Two', { seriesId: first.series!.seriesId })
  await registry.delete({ requestId: rid(), spaceId: second.spaceId })
  expect(registry.series.list().items[0]).toMatchObject({ settingCount: 1, episodes: [{ spaceId: first.spaceId }] })
  registry.series.delete({ requestId: rid(), seriesId: first.series!.seriesId })
  expect(registry.get(first.spaceId)!.entities.get({ entityId: hero.id }).series).toBeUndefined()
  expect((await registry.restore({ requestId: rid(), spaceId: second.spaceId })).series).toBeUndefined()
})

it('keeps casts and marks prompts stale when replacing, updating and resetting a linked setting', () => {
  const first = space('One', { name: 'Series' })
  const hero = setting(first.spaceId)
  const source = registry.get(first.spaceId)!
  const published = source.seriesEntities.publish({ requestId: rid(), entityId: hero.id, expectedRevision: 1 })
  const second = space('Two', { seriesId: first.series!.seriesId })
  const host = registry.get(second.spaceId)!
  const local = setting(second.spaceId)
  const nodeId = host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'node.create', kind: 'script', tempId: 'script' }] }).idMap.script!
  const slot = () => host.canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!
  host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'script.replace', slotId: slot().slotId, expectedRevision: slot().revision,
    doc: { castIds: [local.id], assets: [], shots: [{ tempId: 'shot', description: 'Walk', characterIds: [local.id], framePrompt: 'Fresh prompt' }] } }] })
  const doc = () => { const content = slot().content; if (content.type !== 'script') throw new Error('Expected script'); return content.doc }
  const fresh = () => {
    const shot = doc().shots[0]!
    host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'script.patch', slotId: slot().slotId,
      ops: [{ kind: 'shot.update', shotId: shot.id, rev: shot.rev, fields: { framePrompt: 'Fresh prompt' } }] }] })
  }
  host.seriesEntities.link({ requestId: rid(), seriesEntityId: published.seriesEntityId, replaceEntityId: local.id, expectedRevision: local.revision })
  expect(doc()).toMatchObject({ castIds: [local.id], shots: [{ characterIds: [local.id], promptState: 'stale' }] })
  fresh()
  const edit = source.entities.update({ entityId: hero.id, expectedRevision: published.entity.revision, description: 'New coat' })
  source.seriesEntities.publish({ requestId: rid(), entityId: hero.id, expectedRevision: edit.revision })
  const updated = host.seriesEntities.updateFromSeries({ requestId: rid(), entityId: local.id, expectedRevision: host.entities.get({ entityId: local.id }).revision })
  expect(doc().shots[0]?.promptState).toBe('stale')
  fresh()
  host.seriesEntities.resetToSeries({ requestId: rid(), entityId: local.id, expectedRevision: updated.revision })
  expect(doc().shots[0]?.promptState).toBe('stale')
})
