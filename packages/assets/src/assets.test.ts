import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createAssetStore, type AssetStore, type RegisterVersionInput } from './index'

const now = 1_800_000_000_000
const bytes = Buffer.from('素材内容')

describe('AssetStore', () => {
  let dir: string
  let db: SpaceDb
  let store: AssetStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vis-assets-'))
    db = openSpaceDb(':memory:')
    store = createAssetStore({ blobsDir: join(dir, 'blobs'), now: () => now })
  })
  afterEach(() => {
    db.$client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function input(): Promise<RegisterVersionInput> {
    return { staged: await store.stageBytes(bytes), kind: 'image', mime: 'image/png', origin: 'import' }
  }

  it('discards failed staging without deleting a concurrent staging lease or registered content', async () => {
    const a = await store.stageBytes(Buffer.from('shared staging'))
    const b = await store.stageBytes(Buffer.from('shared staging'))
    store.discardStaged(db, a)
    expect(existsSync(store.blobPath(b.hash))).toBe(true)
    store.discardStaged(db, b)
    expect(existsSync(store.blobPath(b.hash))).toBe(false)
    const c = await input()
    store.registerVersion(db, c)
    store.discardStaged(db, c.staged)
    expect(existsSync(store.blobPath(c.staged.hash))).toBe(true)
  })

  it('persists identical content only once; concurrent stage calls preserve existing files and clear temporary directories', async () => {
    const a = await store.stageBytes(bytes)
    const inode = lstatSync(store.blobPath(a.hash)).ino
    const results = await Promise.all(Array.from({ length: 8 }, () => store.stageBytes(bytes)))
    expect(results).toEqual(Array.from({ length: 8 }, () => a))
    expect(a).toEqual({ hash: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length })
    expect(lstatSync(store.blobPath(a.hash)).ino).toBe(inode)
    expect(readFileSync(store.blobPath(a.hash))).toEqual(bytes)
    expect(readdirSync(join(dir, 'blobs', a.hash.slice(0, 2)))).toEqual([a.hash])
    expect(readdirSync(join(dir, 'blobs', '.tmp'))).toEqual([])
  })

  it('stageFile with multiple chunks and stageBytes share content addressing, and empty files can be imported', async () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 37)
    const path = join(dir, 'source')
    writeFileSync(path, data)
    expect(await store.stageFile(path)).toEqual(await store.stageBytes(data))
    writeFileSync(path, '')
    expect(await store.stageFile(path)).toEqual(await store.stageBytes(new Uint8Array()))
    expect(readdirSync(join(dir, 'blobs', '.tmp'))).toEqual([])
  })

  it('cleans temporary files even when reading the source fails', async () => {
    await expect(store.stageFile(join(dir, 'missing'))).rejects.toThrow()
    expect(readdirSync(join(dir, 'blobs', '.tmp'))).toEqual([])
  })

  it('registers new assets and later versions, preserves metadata and passes event operationId through', async () => {
    const data = await input()
    db.insert(s.operations).values({ id: 'op_1', actorKind: 'user', createdAt: now }).run()
    db.insert(s.generationJobs).values({ id: 'job_1', kind: 'image', provider: 'mock', model: 'm', params: {}, status: 'succeeded', createdAt: now, updatedAt: now }).run()
    const first = db.transaction(tx => store.registerVersion(tx, {
      ...data, displayName: '素材', width: 12, height: 34, durationMs: 50, sourceJobId: 'job_1', operationId: 'op_1',
    }))
    const second = db.transaction(tx => store.registerVersion(tx, { ...data, assetId: first.assetId }))
    expect(first.version).toBe(1)
    expect(second).toMatchObject({ assetId: first.assetId, version: 2 })
    expect(second.assetVersionId).not.toBe(first.assetVersionId)
    expect(store.getVersion(db, first.assetVersionId)).toEqual({
      id: first.assetVersionId, assetId: first.assetId, version: 1, blobHash: data.staged.hash,
      mime: 'image/png', kind: 'image', width: 12, height: 34, durationMs: 50, fps: null, hasAlpha: null, fontFamily: null, sourceJobId: 'job_1', createdAt: now,
    })
    expect(store.getVersion(db, second.assetVersionId)).toMatchObject({ width: null, height: null, durationMs: null, sourceJobId: null })
    expect(store.getVersion(db, 'missing')).toBeUndefined()
    expect(db.select().from(s.assets).all()).toEqual([{
      id: first.assetId, kind: 'image', origin: 'import', displayName: '素材', createdAt: now,
      category: null, archivedAt: null, revision: 1, labeledBy: null, userFields: [],
    }])
    expect(db.select().from(s.blobs).all()).toHaveLength(1)
    expect(readEventsAfter(db, 0).map(event => ({ type: event.type, entityType: event.entityType, entityId: event.entityId, payload: event.payload, operationId: event.operationId, createdAt: event.createdAt }))).toEqual([
      { type: 'asset.versionAdded', entityType: 'asset', entityId: first.assetId, payload: first, operationId: 'op_1', createdAt: now },
      { type: 'asset.versionAdded', entityType: 'asset', entityId: first.assetId, payload: second, operationId: null, createdAt: now },
    ])
    expect(await store.findOrphanBlobs(db)).toEqual([])
  })

  it('transaction rollback removes registrations and events but retains files identified as orphans', async () => {
    expect(await store.findOrphanBlobs(db)).toEqual([])
    const data = await input()
    expect(() => db.transaction(tx => {
      store.registerVersion(tx, data)
      throw new Error('rollback')
    })).toThrow('rollback')
    expect(db.select().from(s.blobs).all()).toEqual([])
    expect(db.select().from(s.assets).all()).toEqual([])
    expect(db.select().from(s.assetVersions).all()).toEqual([])
    expect(readEventsAfter(db, 0)).toEqual([])
    expect(existsSync(store.blobPath(data.staged.hash))).toBe(true)
    expect(await store.findOrphanBlobs(db)).toEqual([data.staged.hash])
    expect(existsSync(store.blobPath(data.staged.hash))).toBe(true)
  })

  it('stores only bounded video frame rates and rounds them to three decimals', async () => {
    const staged = await store.stageBytes(bytes)
    const register = (kind: RegisterVersionInput['kind'], fps: number | undefined) => store.registerVersion(db, {
      staged, kind, mime: kind === 'video' ? 'video/mp4' : kind === 'image' ? 'image/png' : 'audio/wav', origin: 'import',
      ...(fps !== undefined ? { fps } : {}),
    })
    expect(store.getVersion(db, register('video', 30000 / 1001).assetVersionId)?.fps).toBe(29.97)
    for (const fps of [undefined, 0, 0.5, 241, Infinity, NaN]) expect(store.getVersion(db, register('video', fps).assetVersionId)?.fps).toBeNull()
    for (const kind of ['image', 'audio'] as const) expect(store.getVersion(db, register(kind, 25).assetVersionId)?.fps).toBeNull()
  })

  it('audio versions preserve duration and mime without writing visual dimensions', async () => {
    const staged = await store.stageBytes(bytes)
    const { assetVersionId } = db.transaction(tx => store.registerVersion(tx, {
      staged, kind: 'audio', mime: 'audio/wav', origin: 'import', durationMs: 2000,
    }))
    expect(store.getVersion(db, assetVersionId)).toMatchObject({
      kind: 'audio', mime: 'audio/wav', durationMs: 2000, width: null, height: null,
    })
  })

  it('missing or size-mismatched files and invalid hashes cannot be registered', async () => {
    const data = await input()
    const path = store.blobPath(data.staged.hash)
    writeFileSync(path, 'x')
    expect(() => store.registerVersion(db, data)).toThrow(/size mismatch/)
    await expect(store.stageBytes(bytes)).rejects.toThrow(/size mismatch/)
    expect(readFileSync(path, 'utf8')).toBe('x')
    expect(readdirSync(join(dir, 'blobs', '.tmp'))).toEqual([])
    unlinkSync(path)
    expect(() => store.registerVersion(db, data)).toThrow()
    expect(() => store.blobPath('../outside')).toThrow(/Invalid blob hash/)
    expect(db.select().from(s.blobs).all()).toEqual([])
    expect(db.select().from(s.assets).all()).toEqual([])
    expect(readEventsAfter(db, 0)).toEqual([])
  })

  it('rejects overwriting an existing hash path that is a broken symlink', async () => {
    const staged = await store.stageBytes(bytes)
    const path = store.blobPath(staged.hash)
    unlinkSync(path)
    symlinkSync(join(dir, 'missing'), path)
    await expect(store.stageBytes(bytes)).rejects.toThrow(/size mismatch/)
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readdirSync(join(dir, 'blobs', '.tmp'))).toEqual([])
  })

  it('rejects missing assets and mismatched kinds without extra registrations', async () => {
    const data = await input()
    expect(() => store.registerVersion(db, { ...data, assetId: 'missing' })).toThrow(expect.objectContaining({ code: 'not_found', message: 'Asset missing does not exist', details: { reason: 'asset.not_found', params: { assetId: 'missing' } } }))
    expect(db.select().from(s.blobs).all()).toEqual([])
    const first = db.transaction(tx => store.registerVersion(tx, data))
    expect(() => store.registerVersion(db, { ...data, assetId: first.assetId, kind: 'video' })).toThrow(expect.objectContaining({ code: 'invalid_params', details: { reason: 'asset.kind_mismatch', params: { kind: 'image', versionKind: 'video' } } }))
    expect(db.select().from(s.assetVersions).all()).toHaveLength(1)
    expect(readEventsAfter(db, 0)).toHaveLength(1)
  })

  it('foreign key errors propagate unchanged and roll back in the caller transaction', async () => {
    const data = await input()
    expect(() => db.transaction(tx => store.registerVersion(tx, { ...data, operationId: 'missing' }))).toThrow(/FOREIGN KEY/)
    expect(db.select().from(s.blobs).all()).toEqual([])
    expect(db.select().from(s.assets).all()).toEqual([])
    expect(db.select().from(s.assetVersions).all()).toEqual([])
    expect(readEventsAfter(db, 0)).toEqual([])
  })
})
