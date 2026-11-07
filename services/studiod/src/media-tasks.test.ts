import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAssetStore, type MediaTools, type ProcessedMedia } from '@vis/assets'
import { createCanvasService } from '@vis/canvas-core'
import { VisError } from '@vis/domain'
import { eq, openSpaceDb, readEventsAfter, spaceSchema as s } from '@vis/storage'
import type { MediaTaskProgress } from '@vis/protocol'
import { createMediaLimiter, createMediaTaskService, hasActiveMediaTasks, MediaScheduler, readActiveMediaTasks } from './media-tasks'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(options: { scheduler?: MediaScheduler; timeoutMs?: number; now?: () => number; onProgress?: (event: MediaTaskProgress) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vis-media-task-'))
  const db = openSpaceDb(':memory:')
  const assets = createAssetStore({ blobsDir: join(dir, 'blobs') })
  const canvas = createCanvasService({ db })
  const staged = await assets.stageBytes(Buffer.from('source image'))
  const source = assets.registerVersion(db, { staged, kind: 'image', mime: 'image/png', origin: 'import', width: 200, height: 100 })
  const created = canvas.apply({ kind: 'user' }, { requestId: 'source', ops: [{ op: 'node.create', tempId: 'source', kind: 'image', content: { assetVersionId: source.assetVersionId } }] })
  const node = canvas.get({}).nodes[0]!
  const slot = node.slots[0]!
  const pending: { complete(): void; fail(error: unknown): void; disposed: ReturnType<typeof vi.fn> }[] = []
  const media: MediaTools = {
    async probe() { throw new Error('Unexpected probe') },
    async extractFrames() { throw new Error('Unexpected frame extraction') },
    async process(_path, operation, _params, opts) {
      const ordinal = pending.length
      const path = join(dir, `output-${ordinal}.png`)
      writeFileSync(path, `output image ${ordinal}`)
      const disposed = vi.fn(async () => {})
      return await new Promise<ProcessedMedia>((resolve, reject) => {
        const abort = () => reject(opts!.signal!.reason)
        opts!.signal!.addEventListener('abort', abort, { once: true })
        const settle = (value: ProcessedMedia | unknown, failed = false) => {
          opts!.signal!.removeEventListener('abort', abort)
          if (failed) reject(value)
          else resolve(value as ProcessedMedia)
        }
        pending.push({
          disposed,
          complete: () => settle({
            outputs: Array.from({ length: operation === 'image.gridSplit' ? 4 : 1 }, () => ({ path, kind: 'image', mime: 'image/png', width: 100, height: 100 })),
            dispose: disposed,
          }),
          fail: error => settle(error, true),
        })
        opts!.onProgress?.(0.5)
      })
    },
    analyzeSilence: vi.fn(async () => ({ durationMs: 2000, pointsMs: [1000] })),
  }
  const service = createMediaTaskService({ db, assets, media, exportDir: join(dir, 'exports'), ...options })
  const params = { requestId: 'crop', operation: 'image.crop' as const, nodeId: node.nodeId, slotId: slot.slotId, expectedRevision: slot.revision, params: { x: 0, y: 0, w: 100, h: 100 } }
  const f = { dir, db, assets, canvas, source, node, slot, created, service, pending, params, media }
  cleanups.push(async () => {
    await service.stop()
    db.$client.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return f
}

const user = { kind: 'user' } as const

it('rejects a queued preview limit on stop and propagates generation errors without creating task records', async () => {
  const scheduler = new MediaScheduler()
  const f = await fixture({ scheduler })
  let stopped = false
  const limiter = createMediaLimiter(scheduler, {}, () => stopped, () => VisError.of('unavailable', 'media.interrupted', {}, 'Media processing was interrupted'))
  const failure = new Error('Preview generation failed')
  await expect(limiter.limit(async () => { throw failure })).rejects.toBe(failure)
  for (const requestId of ['first', 'second']) await f.service.process(user, { ...f.params, requestId })
  await expect.poll(() => f.pending.length).toBe(2)
  const generate = vi.fn(async () => 'preview')
  const queued = limiter.limit(generate)
  const rejected = expect(queued).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
  stopped = true
  const drained = limiter.drain()
  await f.service.stop()
  await drained
  await rejected
  expect(generate).not.toHaveBeenCalled()
  expect(f.db.select().from(s.mediaTasks).all()).toHaveLength(2)
  await expect(limiter.limit(generate)).rejects.toMatchObject({ details: { reason: 'media.interrupted' } })
})

it('checks idle media activity with one bounded query instead of hydrating task history', async () => {
  const f = await fixture()
  const prepare = vi.spyOn(f.db.$client, 'prepare')
  try {
    expect(hasActiveMediaTasks(f.db)).toBe(false)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(prepare.mock.calls[0]![0]).toMatch(/select "id".*limit/i)
    prepare.mockClear()
    const task = await f.service.process(user, f.params)
    prepare.mockClear()
    expect(hasActiveMediaTasks(f.db)).toBe(true)
    expect(prepare).toHaveBeenCalledTimes(1)
    await expect.poll(() => f.pending.length).toBe(1)
    f.pending[0]!.complete()
    await f.service.get({ taskId: task.taskId, waitMs: 1000 })
    expect(hasActiveMediaTasks(f.db)).toBe(false)
  } finally { prepare.mockRestore() }
})

it('deduplicates requests independently of waitMs, rejects content conflicts, exposes progress, and makes one undoable aspect-ratio edit', async () => {
  const f = await fixture()
  const task = await f.service.process(user, f.params)
  await expect.poll(() => f.pending.length).toBe(1)
  expect((await f.service.get({ taskId: task.taskId })).progress).toBe(0.5)
  expect((await f.service.process(user, { ...f.params, waitMs: 1 })).taskId).toBe(task.taskId)
  await expect(f.service.process(user, { ...f.params, params: { ...f.params.params, w: 90 } })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  expect(readActiveMediaTasks(f.db)).toHaveLength(1)
  f.pending[0]!.complete()
  const result = await f.service.get({ taskId: task.taskId, waitMs: 1000 })
  expect(result).toMatchObject({ status: 'succeeded', assetVersionIds: [expect.any(String)], nodeIds: [], operationId: expect.any(String) })
  expect(f.db.select().from(s.undoEntries).all()).toHaveLength(2)
  const updated = f.canvas.get({}).nodes[0]!
  expect(updated.h).toBe(updated.w)
  expect(updated.slots[0]!.revision).toBe(2)
  f.canvas.undo({ requestId: 'undo-crop' })
  expect(f.canvas.get({}).nodes[0]).toMatchObject({ h: f.node.h, slots: [{ content: { assetVersionId: f.source.assetVersionId } }] })
  f.canvas.redo({ requestId: 'redo-crop' })
  expect(f.canvas.get({}).nodes[0]!.slots[0]!.content).toMatchObject({ assetVersionId: result.assetVersionIds![0] })
  expect(readActiveMediaTasks(f.db)).toEqual([])
  expect(readEventsAfter(f.db, 0).filter(event => event.type === 'mediaTask.stateChanged').map(event => (event.payload as { status: string }).status)).toEqual(['queued', 'running', 'succeeded'])
})

it('throttles transient progress to four updates per second without writing progress to SQLite', async () => {
  let clock = 1000
  const events: MediaTaskProgress[] = []
  const f = await fixture({ now: () => clock, onProgress: event => events.push(event) })
  let progress: ((value: number) => void) | undefined
  const process = f.media.process.bind(f.media)
  vi.spyOn(f.media, 'process').mockImplementation((path, operation, params, opts) => {
    progress = opts?.onProgress
    return process(path, operation, params, opts)
  })
  const task = await f.service.process(user, f.params)
  await expect.poll(() => f.pending.length).toBe(1)
  for (let i = 1; i <= 99; i++) { clock = 1000 + i * 10; progress!(0.5 + i / 200) }
  expect(events).toHaveLength(4)
  expect(events.map(event => event.progress)).toEqual([0.5, 0.625, 0.75, 0.875])
  expect(f.db.select().from(s.mediaTasks).get()!.progress).toBeNull()
  expect(readEventsAfter(f.db, 0).filter(event => event.type === 'mediaTask.stateChanged')).toHaveLength(2)
  f.pending[0]!.complete()
  expect((await f.service.get({ taskId: task.taskId, waitMs: 1000 })).status).toBe('succeeded')
  clock += 1000
  progress!(1)
  expect(events).toHaveLength(4)
})

it('creates non-overlapping derived nodes in output order, with source inputs, and undoes the whole split as one step', async () => {
  const f = await fixture()
  const task = await f.service.process(user, { ...f.params, operation: 'image.gridSplit', params: { rows: 2, cols: 2 } })
  await expect.poll(() => f.pending.length).toBe(1)
  f.pending[0]!.complete()
  const result = await f.service.get({ taskId: task.taskId, waitMs: 1000 })
  expect(result.status).toBe('succeeded')
  expect(result.nodeIds).toHaveLength(4)
  const nodes = f.canvas.get({}).nodes
  for (const id of result.nodeIds!) expect(nodes.find(node => node.nodeId === id)!.inputs).toEqual([f.node.nodeId])
  for (const a of nodes) for (const b of nodes) {
    if (a.nodeId !== b.nodeId) expect(a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h).toBe(true)
  }
  expect(f.canvas.get({ nodeIds: [f.node.nodeId] }).nodes[0]!.slots[0]!.revision).toBe(1)
  expect(f.db.select().from(s.undoEntries).all()).toHaveLength(2)
  f.canvas.undo({ requestId: 'undo-grid' })
  expect(f.canvas.get({}).nodes).toHaveLength(1)
  f.canvas.redo({ requestId: 'redo-grid' })
  expect(f.canvas.get({}).nodes).toHaveLength(5)
})

it.each(['content', 'layout', 'staging'] as const)('rejects %s changes during processing without registering assets or orphan blobs', async change => {
  const f = await fixture()
  const task = await f.service.process(user, f.params)
  await expect.poll(() => f.pending.length).toBe(1)
  const mutate = () => f.canvas.apply(user, { requestId: 'external-edit', ops: change === 'content'
    ? [{ op: 'slot.setAsset', slotId: f.slot.slotId, expectedRevision: 1, assetVersionId: f.source.assetVersionId }]
    : [{ op: 'node.layout', nodeId: f.node.nodeId, x: 100 }] })
  if (change === 'staging') {
    const stage = f.assets.stageFile.bind(f.assets)
    vi.spyOn(f.assets, 'stageFile').mockImplementation(async path => { const blob = await stage(path); mutate(); return blob })
  } else mutate()
  f.pending[0]!.complete()
  expect(await f.service.get({ taskId: task.taskId, waitMs: 1000 })).toMatchObject({ status: 'failed', error: { code: 'revision_conflict' } })
  await expect.poll(() => f.pending[0]!.disposed.mock.calls.length).toBe(1)
  expect(f.db.select().from(s.assetVersions).all()).toHaveLength(1)
  expect(await f.assets.findOrphanBlobs(f.db)).toEqual([])
})

it('rejects an initial stale revision without queuing a task', async () => {
  const f = await fixture()
  await expect(f.service.process(user, { ...f.params, expectedRevision: 0 })).rejects.toMatchObject({ code: 'revision_conflict' })
  expect(f.db.select().from(s.mediaTasks).all()).toEqual([])
})

it('checks active turns and archives, permits plain sessions, and agent edits create no undo entry', async () => {
  const f = await fixture()
  f.db.insert(s.sessions).values({ id: 'agent', agentKind: 'codex', title: 'Agent', createdAt: 1 }).run()
  const agent = { kind: 'agent', sessionId: 'agent' } as const
  await expect(f.service.process(agent, f.params)).rejects.toMatchObject({ code: 'forbidden' })
  seedTurn(f.db)
  const task = await f.service.process(agent, f.params)
  await expect.poll(() => f.pending.length).toBe(1)
  f.pending[0]!.complete()
  const result = await f.service.get({ taskId: task.taskId, waitMs: 1000 })
  expect(result.status).toBe('succeeded')
  expect(result.operationId).toBeUndefined()
  expect(f.db.select().from(s.undoEntries).all()).toHaveLength(1)
  expect(f.db.select().from(s.operations).all().at(-1)).toMatchObject({ actorKind: 'agent', actorSessionId: 'agent' })
  f.db.update(s.sessions).set({ archivedAt: 1 }).where(eq(s.sessions.id, 'agent')).run()
  await expect(f.service.process(agent, { ...f.params, requestId: 'archived' })).rejects.toMatchObject({ code: 'forbidden' })
})

function seedTurn(db: Awaited<ReturnType<typeof fixture>>['db']) {
  db.insert(s.agentInstances).values({ id: 'instance', sessionId: 'agent', status: 'ready', tokenHash: 'fake', startedAt: 1 }).run()
  db.insert(s.messages).values({ id: 'message', sessionId: 'agent', text: 'Process', deliveryState: 'submitted', createdAt: 1 }).run()
  db.insert(s.turns).values({ id: 'turn', sessionId: 'agent', instanceId: 'instance', messageId: 'message', status: 'running', startedAt: 1 }).run()
}

it('cancels queued and running session tasks and never writes their assets', async () => {
  const f = await fixture()
  f.db.insert(s.sessions).values({ id: 'agent', agentKind: 'codex', title: 'Agent', createdAt: 1 }).run()
  seedTurn(f.db)
  const tasks = []
  for (let i = 0; i < 3; i++) tasks.push(await f.service.process({ kind: 'agent', sessionId: 'agent' }, { ...f.params, requestId: `cancel-${i}` }))
  await expect.poll(() => f.pending.length).toBe(2)
  f.service.cancelSession('agent')
  for (const task of tasks) expect(await f.service.get({ taskId: task.taskId, waitMs: 1000 })).toMatchObject({ status: 'failed', error: { code: 'media.cancelled' } })
  expect(f.db.select().from(s.assetVersions).all()).toHaveLength(1)
  expect(readActiveMediaTasks(f.db)).toEqual([])
})

it.each(['ended', 'instance', 'staging'] as const)('rejects writeback after the originating turn becomes inactive: %s', async change => {
  const f = await fixture()
  f.db.insert(s.sessions).values({ id: 'agent', agentKind: 'codex', title: 'Agent', createdAt: 1 }).run()
  seedTurn(f.db)
  const task = await f.service.process({ kind: 'agent', sessionId: 'agent' }, f.params)
  await expect.poll(() => f.pending.length).toBe(1)
  const end = () => change === 'instance'
    ? f.db.update(s.agentInstances).set({ status: 'exited' }).where(eq(s.agentInstances.id, 'instance')).run()
    : f.db.update(s.turns).set({ status: 'completed' }).where(eq(s.turns.id, 'turn')).run()
  if (change === 'staging') {
    const stage = f.assets.stageFile.bind(f.assets)
    vi.spyOn(f.assets, 'stageFile').mockImplementation(async path => { const blob = await stage(path); end(); return blob })
  } else end()
  f.pending[0]!.complete()
  expect(await f.service.get({ taskId: task.taskId, waitMs: 1000 })).toMatchObject({ status: 'failed', error: { code: 'media.cancelled' } })
  await expect.poll(() => f.pending[0]!.disposed.mock.calls.length).toBe(1)
  expect(f.db.select().from(s.assetVersions).all()).toHaveLength(1)
  expect(await f.assets.findOrphanBlobs(f.db)).toEqual([])
})

it('caps concurrent work at two across projects, queues the rest, and starts the next after a task settles', async () => {
  const scheduler = new MediaScheduler()
  const first = await fixture({ scheduler })
  const second = await fixture({ scheduler })
  const a = await first.service.process(user, first.params)
  const b = await second.service.process(user, second.params)
  const c = await first.service.process(user, { ...first.params, requestId: 'third' })
  await expect.poll(() => first.pending.length + second.pending.length).toBe(2)
  expect((await first.service.get({ taskId: c.taskId })).status).toBe('queued')
  first.pending[0]!.complete()
  expect((await first.service.get({ taskId: a.taskId, waitMs: 1000 })).status).toBe('succeeded')
  await expect.poll(() => first.pending.length).toBe(2)
  expect((await first.service.get({ taskId: c.taskId })).status).toBe('running')
  second.pending[0]!.complete()
  first.pending[1]!.complete()
  await second.service.get({ taskId: b.taskId, waitMs: 1000 })
  expect((await first.service.get({ taskId: c.taskId, waitMs: 1000 })).status).toBe('failed')
})

it('times out, aborts processing and leaves no output assets', async () => {
  const f = await fixture({ timeoutMs: 30 })
  const task = await f.service.process(user, f.params)
  expect(await f.service.get({ taskId: task.taskId, waitMs: 1000 })).toMatchObject({ status: 'failed', error: { code: 'media.timeout' } })
  expect(f.db.select().from(s.assetVersions).all()).toHaveLength(1)
  expect(await f.assets.findOrphanBlobs(f.db)).toEqual([])
})

it('marks queued and running tasks interrupted on recovery, and never resumes them', async () => {
  const f = await fixture()
  const task = await f.service.process(user, f.params)
  await expect.poll(() => f.pending.length).toBe(1)
  await f.service.stop()
  const row = f.db.select().from(s.mediaTasks).get()!
  f.db.update(s.mediaTasks).set({ status: 'running', error: null }).where(eq(s.mediaTasks.id, task.taskId)).run()
  f.db.insert(s.mediaTasks).values({ ...row, id: 'queued-before-restart', requestId: 'queued-before-restart', status: 'queued', error: null }).run()
  const recovered = createMediaTaskService({ db: f.db, assets: f.assets, media: f.media })
  try {
    expect(f.db.select().from(s.mediaTasks).all().map(row => [row.status, row.error?.code])).toEqual([['failed', 'media.interrupted'], ['failed', 'media.interrupted']])
    expect(readActiveMediaTasks(f.db)).toEqual([])
    expect(f.pending).toHaveLength(1)
    expect(f.db.select().from(s.assetVersions).all()).toHaveLength(1)
    expect(await f.assets.findOrphanBlobs(f.db)).toEqual([])
  } finally { await recovered.stop() }
})

it('rolls back registered assets and canvas changes if finalization fails', async () => {
  const f = await fixture()
  const register = f.assets.registerVersion.bind(f.assets)
  vi.spyOn(f.assets, 'registerVersion').mockImplementation((tx, input) => {
    register(tx, input)
    throw VisError.of('unavailable', 'media.process_failed', {}, 'Simulated transaction failure')
  })
  const task = await f.service.process(user, f.params)
  await expect.poll(() => f.pending.length).toBe(1)
  f.pending[0]!.complete()
  expect(await f.service.get({ taskId: task.taskId, waitMs: 1000 })).toMatchObject({ status: 'failed', error: { code: 'media.process_failed' } })
  await expect.poll(() => f.pending[0]!.disposed.mock.calls.length).toBe(1)
  expect(f.db.select().from(s.assetVersions).all()).toHaveLength(1)
  expect(f.canvas.get({}).nodes[0]!.slots[0]!.revision).toBe(1)
  expect(await f.assets.findOrphanBlobs(f.db)).toEqual([])
})


async function exportFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options)
  const source = f.assets.registerVersion(f.db, { staged: await f.assets.stageBytes(Buffer.from('video')), kind: 'video', mime: 'video/webm', origin: 'import' })
  const created = f.canvas.apply(user, { requestId: 'video', ops: [{ op: 'node.create', tempId: 'video', kind: 'video', content: { assetVersionId: source.assetVersionId } }] })
  const node = f.canvas.get({ nodeIds: [created.idMap.video!] }).nodes[0]!
  const params = { requestId: 'export', operation: 'video.exportMov' as const, nodeId: node.nodeId, slotId: node.slots[0]!.slotId, expectedRevision: 1, params: {} }
  return { ...f, params }
}

it('cancels a running delivery task with no canvas or asset output', async () => {
  const f = await exportFixture()
  const before = f.db.select().from(s.assetVersions).all()
  const task = await f.service.process(user, f.params)
  await expect.poll(() => f.pending.length).toBe(1)
  expect(f.service.cancel(task.taskId)).toMatchObject({ status: 'failed', error: { code: 'media.cancelled' } })
  await expect.poll(() => f.service.get({ taskId: task.taskId })).toMatchObject({ status: 'failed' })
  expect(f.db.select().from(s.assetVersions).all()).toEqual(before)
  expect(existsSync(join(f.dir, 'exports', `${task.taskId}.mov`))).toBe(false)
})

it('expires delivery files and deletes retained output when the project closes', async () => {
  let time = 1000
  const f = await exportFixture({ now: () => time })
  const path = join(f.dir, 'output.mov')
  writeFileSync(path, 'MOV output')
  vi.spyOn(f.media, 'process').mockResolvedValue({ outputs: [{ path, kind: 'video', mime: 'video/quicktime' }], async dispose() {} })
  const first = await f.service.process(user, { ...f.params, waitMs: 1000 })
  const firstFile = f.service.exportDownload(first.taskId)
  expect(existsSync(firstFile.path)).toBe(true)
  time = first.download!.expiresAt
  expect(() => f.service.exportDownload(first.taskId)).toThrow('expired')
  expect(existsSync(firstFile.path)).toBe(false)
  const second = await f.service.process(user, { ...f.params, requestId: 'second', waitMs: 1000 })
  const secondFile = f.service.exportDownload(second.taskId)
  await f.service.stop()
  expect(existsSync(secondFile.path)).toBe(false)
  expect((await f.service.get({ taskId: second.taskId })).download).toBeUndefined()
})
