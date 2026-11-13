// Gateway end-to-end tests: real sockets, handshake and services; a fake Agent runtime issues tokens and binds turns as adapters do.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newId, VisError } from '@vis/domain'
import { createFfmpegMedia, type MediaTools } from '@vis/assets'
import { createMockProvider } from '@vis/generation'
import { EMPTY_PREVIZ, EMPTY_SCENE, emptyPrevizPanel, GuideTopic, METHODS, PROTOCOL_VERSION, type AgentModelOption, type CanvasOp, type SceneDoc, type SceneObject, type SceneView, type TransientEvent } from '@vis/protocol'
import { appSchema, openAppDb, currentSeq, eq, spaceSchema as s } from '@vis/storage'
import type { AgentEvent, DispatchInput, RequestApproval } from '@vis/workbench-core'
import { issueAgentToken } from './auth'
import type { AgentRuntimeFactory } from './space-host'
import { startStudiod, type Studiod, type StudiodOptions, StudiodRunningError } from './studiod'
import * as filesystem from './filesystem'

type Dispatched = DispatchInput & { token: string; instanceId: string; report: (e: AgentEvent) => void; stream: (e: TransientEvent) => void; requestApproval: RequestApproval; end(): void }

let dir: string
let studiod: Studiod
let dispatched: Dispatched[]
let spaceId: string
let media: MediaTools

const models: AgentModelOption[] = [{ id: 'model-a', label: '模型 A', isDefault: true, efforts: [{ id: 'high', label: '高' }], defaultEffort: 'high', serviceTiers: [] }]

const fakeRuntime: AgentRuntimeFactory = ({ spaceId, db, report, stream, requestApproval }) => ({
  async agentOptions() { return models },
  async ensureReady() {},
  async dispatchTurn(input) {
    const { token, tokenHash } = issueAgentToken(spaceId)
    const instanceId = newId('agentInstance')
    db.insert(s.agentInstances).values({ id: instanceId, sessionId: input.sessionId, status: 'ready', tokenHash, startedAt: Date.now() }).run()
    db.update(s.turns).set({ instanceId }).where(eq(s.turns.id, input.turnId)).run()
    dispatched.push({
      ...input, token, instanceId, report, stream, requestApproval,
      end() {
        db.update(s.agentInstances).set({ status: 'exited', exitedAt: Date.now(), exitReason: 'turn_ended' }).where(eq(s.agentInstances.id, instanceId)).run()
        report({ type: 'turn_ended', sessionId: input.sessionId, turnId: input.turnId, status: 'completed' })
      },
    })
  },
  async terminateTurn() {}, async interruptTurn() {},
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vis-studiod-'))
  vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
  dispatched = []
  media = createFfmpegMedia()
  studiod = await startStudiod({
    dataDir: dir,
    studiodVersion: '0.0.0-test',
    runtimes: { codex: fakeRuntime, claude: () => ({ async ensureReady() {}, async dispatchTurn() {}, async terminateTurn() {}, async interruptTurn() {} }) },
    providers: [createMockProvider({ latencyMs: 50 })],
    defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    media,
  })
  spaceId = studiod.spaces.create('测试空间').spaceId
})
afterEach(async () => {
  await studiod.stop('user_quit')
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

type Notification = { method: string; params: { seq?: number; type?: string } }

/** NDJSON test client */
async function client() {
  const socket = connect(studiod.socketPath)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.setEncoding('utf8')
  const pending = new Map<number, (msg: { result?: unknown; error?: { code: number; message: string; data?: { code: string } } }) => void>()
  const notifications: Notification[] = []
  let closed = false
  let buffer = ''
  let nextId = 0
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const msg = JSON.parse(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      if ('id' in msg) pending.get(msg.id)?.(msg)
      else notifications.push(msg)
    }
  })
  socket.on('close', () => { closed = true })
  const raw = (method: string, params?: unknown) => new Promise<{ result?: any; error?: { code: number; message: string; data?: { code: string } } }>(resolve => {
    const id = ++nextId
    pending.set(id, resolve)
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  return {
    raw,
    notifications,
    isClosed: () => closed,
    async call(method: string, params: unknown = {}) {
      const res = await raw(method, params)
      if (res.error) throw Object.assign(new Error(res.error.message), { rpc: res.error, code: res.error.data?.code })
      return res.result
    },
    close: () => socket.destroy(),
  }
}

async function ui() {
  const c = await client()
  await c.call('runtime.hello', { protocolVersion: PROTOCOL_VERSION, credential: { kind: 'ui', token: readFileSync(studiod.tokenPath, 'utf8') } })
  return c
}

it('routes media.preview through the subscribed project and preserves version and kind errors', async () => {
  const c = await ui()
  try {
    await c.call('events.subscribe', { spaceId })
    const host = studiod.spaces.get(spaceId)!
    const result = { kind: 'peaks' as const, durationMs: 1000, binsPerSecond: 1, peaks: [0.5] }
    const get = vi.spyOn(host.mediaPreviews, 'get').mockResolvedValueOnce(result)
    expect(await c.call('media.preview', { assetVersionId: 'audio-version', kind: 'peaks' })).toEqual(result)
    expect(get).toHaveBeenCalledWith({ assetVersionId: 'audio-version', kind: 'peaks' })
    get.mockRestore()
    await expect(c.call('media.preview', { assetVersionId: 'missing', kind: 'filmstrip' })).rejects.toMatchObject({
      code: 'not_found', rpc: { data: { reason: 'asset.version_not_found' } },
    })
    const asset = host.assets.registerVersion(host.db, { staged: await host.assets.stageBytes(Buffer.from('image')), kind: 'image', mime: 'image/png', origin: 'import' })
    await expect(c.call('media.preview', { assetVersionId: asset.assetVersionId, kind: 'peaks' })).rejects.toMatchObject({
      code: 'invalid_params', rpc: { data: { reason: 'media.kind_mismatch' } },
    })
  } finally { c.close() }
})

async function agent(token: string) {
  const c = await client()
  await c.call('runtime.hello', { protocolVersion: PROTOCOL_VERSION, credential: { kind: 'agent', token } })
  return c
}

const until = async (check: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise(r => setTimeout(r, 10))
  }
}

let req = 0
const rid = () => `req_${++req}`

describe('agent media purpose permissions', () => {
  async function callers() {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const { sessionId } = await c.call('session.create', { requestId: rid() })
    await c.call('session.sendMessage', { requestId: rid(), sessionId, text: 'Prepare media', refs: [] })
    await until(() => dispatched.some(turn => turn.sessionId === sessionId))
    const a = await agent(dispatched.find(turn => turn.sessionId === sessionId)!.token)
    return { c, a, sessionId, host: studiod.spaces.get(spaceId)! }
  }

  it.each(['image', 'video', 'audio'] as const)('refuses agent creation of a working %s without writing any part of the batch', async kind => {
    const { c, a, host } = await callers()
    try {
      const before = host.canvas.get({})
      const seq = currentSeq(host.db)
      const operations = host.db.select().from(s.operations).all()
      const slots = host.db.select().from(s.slots).all()
      const requests = host.db.select().from(s.idempotencyKeys).all()
      await expect(a.call('canvas.apply', { requestId: rid(), ops: [
        { op: 'node.create', tempId: 'notes', kind: 'text', purpose: 'working' },
        { op: 'node.create', tempId: 'media', kind, purpose: 'working' },
      ] })).rejects.toMatchObject({
        code: 'forbidden', message: expect.stringContaining('Leave purpose unset (artifact) for media'),
        rpc: { data: { reason: 'canvas.working_media_forbidden', params: { tempId: 'media' } } },
      })
      expect(host.canvas.get({})).toEqual(before)
      expect(currentSeq(host.db)).toBe(seq)
      expect(host.db.select().from(s.operations).all()).toEqual(operations)
      expect(host.db.select().from(s.slots).all()).toEqual(slots)
      expect(host.db.select().from(s.idempotencyKeys).all()).toEqual(requests)
    } finally { a.close(); c.close() }
  })

  it('allows agents to create working text, script and timeline documents', async () => {
    const { c, a, host } = await callers()
    try {
      const result = await a.call('canvas.apply', { requestId: rid(), ops: ['text', 'script', 'timeline'].map(kind => ({ op: 'node.create', tempId: kind, kind, purpose: 'working' })) })
      const nodes = host.canvas.get({ nodeIds: Object.values(result.idMap) }).nodes
      expect(nodes).toHaveLength(3)
      expect(nodes.every(node => node.purpose === 'working')).toBe(true)
    } finally { a.close(); c.close() }
  })

  it.each(['image', 'video', 'audio'] as const)('allows agent metadata that keeps an already-working %s working', async kind => {
    const { c, a, host } = await callers()
    try {
      const result = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'media', kind, purpose: 'working' }] })
      const nodeId = result.idMap.media
      await a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId, purpose: 'working', title: 'Author working media' }] })
      expect(host.canvas.get({}).nodes[0]).toMatchObject({ nodeId, purpose: 'working', title: 'Author working media' })
    } finally { a.close(); c.close() }
  })

  it('refuses re-hiding initially working media after promoting it within the batch', async () => {
    const { c, a, host } = await callers()
    try {
      const result = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'media', kind: 'video', purpose: 'working' }] })
      const nodeId = result.idMap.media
      const before = host.canvas.get({})
      const seq = currentSeq(host.db)
      await expect(a.call('canvas.apply', { requestId: rid(), ops: [
        { op: 'node.setMeta', nodeId, purpose: 'artifact' },
        { op: 'node.setMeta', nodeId, purpose: 'working' },
      ] })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'canvas.working_media_forbidden', params: { nodeId } } } })
      expect(host.canvas.get({})).toEqual(before)
      expect(currentSeq(host.db)).toBe(seq)
    } finally { a.close(); c.close() }
  })

  it.each(['node.create', 'node.setMeta'] as const)('replays a legacy working-media %s result before applying new permission checks', async op => {
    const { c, a, sessionId, host } = await callers()
    try {
      const created = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'existing', kind: 'video' }] })
      const params = METHODS['canvas.apply'].params.parse({ requestId: rid(), ops: [op === 'node.create'
        ? { op, tempId: 'legacy', kind: 'video', purpose: 'working' }
        : { op, nodeId: created.idMap.existing, purpose: 'working' }] })
      // Seed the persisted result through the trusted core, as an Agent could before the gateway policy existed.
      const original = host.canvas.apply({ kind: 'agent', sessionId }, params)
      const nodeId = op === 'node.create' ? original.idMap.legacy! : created.idMap.existing
      await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId, purpose: 'artifact' }] })
      const before = host.canvas.get({})
      const seq = currentSeq(host.db)
      expect(await a.call('canvas.apply', params)).toEqual(original)
      await expect(a.call('canvas.apply', { ...params, description: 'Different request content' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
      await expect(a.call('canvas.apply', { ...params, requestId: rid() })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'canvas.working_media_forbidden' } } })
      expect(host.canvas.get({})).toEqual(before)
      expect(currentSeq(host.db)).toBe(seq)
    } finally { a.close(); c.close() }
  })

  it.each(['image', 'video', 'audio'] as const)('refuses agent working metadata on an existing %s atomically', async kind => {
    const { c, a, host } = await callers()
    try {
      const result = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'media', kind }] })
      const nodeId = result.idMap.media
      const before = host.canvas.get({})
      const seq = currentSeq(host.db)
      await expect(a.call('canvas.apply', { requestId: rid(), ops: [
        { op: 'node.layout', nodeId, x: 5000 },
        { op: 'node.setMeta', nodeId, purpose: 'working' },
      ] })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'canvas.working_media_forbidden', params: { nodeId } } } })
      expect(host.canvas.get({})).toEqual(before)
      expect(currentSeq(host.db)).toBe(seq)
    } finally { a.close(); c.close() }
  })

  it('refuses working media in a batch that also takes the scene write path', async () => {
    const { c, a, host } = await callers()
    try {
      const result = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'media', kind: 'image' }, { op: 'node.create', tempId: 'note', kind: 'text' }] })
      const before = host.canvas.get({})
      const seq = currentSeq(host.db)
      // node.delete routes the batch through the scene checks, which must not skip the media guard.
      await expect(a.call('canvas.apply', { requestId: rid(), ops: [
        { op: 'node.delete', nodeId: result.idMap.note },
        { op: 'node.setMeta', nodeId: result.idMap.media, purpose: 'working' },
      ] })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'canvas.working_media_forbidden', params: { nodeId: result.idMap.media } } } })
      expect(host.canvas.get({})).toEqual(before)
      expect(currentSeq(host.db)).toBe(seq)
    } finally { a.close(); c.close() }
  })

  it.each(['image', 'video', 'audio'] as const)('refuses working metadata through a new %s tempId', async kind => {
    const { c, a, host } = await callers()
    try {
      const seq = currentSeq(host.db)
      await expect(a.call('canvas.apply', { requestId: rid(), ops: [
        { op: 'node.create', tempId: 'media', kind },
        { op: 'node.setMeta', nodeId: 'media', purpose: 'working' },
        { op: 'node.setMeta', nodeId: 'media', purpose: 'artifact' },
      ] })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'canvas.working_media_forbidden', params: { nodeId: 'media' } } } })
      expect(host.canvas.get({}).nodes).toEqual([])
      expect(currentSeq(host.db)).toBe(seq)
    } finally { a.close(); c.close() }
  })

  it('preserves author choices to create and mark media as working documents', async () => {
    const { c, a, host } = await callers()
    try {
      const result = await c.call('canvas.apply', { requestId: rid(), ops: ['image', 'video', 'audio'].map(kind => ({ op: 'node.create', tempId: kind, kind, purpose: 'working' })) })
      expect(host.canvas.get({}).nodes.every(node => node.purpose === 'working')).toBe(true)
      for (const purpose of ['artifact', 'working']) {
        await c.call('canvas.apply', { requestId: rid(), ops: Object.values(result.idMap).map(nodeId => ({ op: 'node.setMeta', nodeId, purpose })) })
        expect(host.canvas.get({}).nodes.every(node => node.purpose === purpose)).toBe(true)
      }
    } finally { a.close(); c.close() }
  })

  it('allows agents to restore a working video to artifact and leaves other author metadata intact', async () => {
    const { c, a, host } = await callers()
    try {
      const result = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'video', kind: 'video', purpose: 'working' }] })
      const nodeId = result.idMap.video
      await a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId, title: 'Video draft' }] })
      expect(host.canvas.get({}).nodes[0]!.purpose).toBe('working')
      await a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId, purpose: 'artifact' }] })
      expect(host.canvas.get({}).nodes[0]).toMatchObject({ purpose: 'artifact', title: 'Video draft' })
    } finally { a.close(); c.close() }
  })
})

it('records streaming and authenticated gateway activity for the bound turn, and fences writes after a forced end', async () => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const session = await c.call('session.create', { requestId: rid() })
  await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Hold', refs: [] })
  await until(() => dispatched.length === 1)
  const input = dispatched[0]!
  const host = studiod.spaces.get(spaceId)!
  const activity = vi.spyOn(host.sessions, 'recordActivity')
  const a = await agent(input.token)
  try {
    await a.call('canvas.get', {})
    expect(activity).toHaveBeenCalledWith(session.sessionId, input.turnId)
    activity.mockClear()
    expect((await a.raw('session.stop', {})).error?.data?.code).toBe('forbidden')
    expect(activity).toHaveBeenCalledExactlyOnceWith(session.sessionId, input.turnId)
    activity.mockClear()
    expect((await a.raw('unknown.method', {})).error).toBeDefined()
    expect(activity).toHaveBeenCalledExactlyOnceWith(session.sessionId, input.turnId)
    activity.mockClear()
    input.stream({ sessionId: session.sessionId, turnId: input.turnId, itemId: 'stream', revision: 1, kind: 'assistant_text', delta: 'Alive' })
    expect(activity).toHaveBeenCalledExactlyOnceWith(session.sessionId, input.turnId)
    host.sessions.handleAgentEvent({ type: 'turn_ended', sessionId: session.sessionId, turnId: input.turnId, status: 'interrupted' })
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'late', kind: 'text', content: { text: 'Late write' } }] })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'runtime.turn_inactive' } } })
    expect(host.canvas.get({}).nodes).toEqual([])
  } finally { activity.mockRestore(); a.close(); c.close() }
})

// Three clients, dozens of real RPCs and two disk-backed projects include Windows SQLite/filesystem latency.
it('enforces series caller rules, linked-session writes, collision replacement and UI notifications', async () => {
  const c = await ui()
  const otherUi = await ui()
  await c.call('events.subscribe', { spaceId })
  const series = await c.call('series.create', { requestId: rid(), name: 'Series' })
  await c.call('space.setSeries', { requestId: rid(), spaceId, series: { seriesId: series.seriesId } })
  const host = studiod.spaces.get(spaceId)!
  const hero = await c.call('entity.create', { requestId: rid(), kind: 'character', name: 'Hero' })
  const published = await c.call('entity.publish', { requestId: rid(), entityId: hero.id, expectedRevision: hero.revision })
  const second = await c.call('space.create', { requestId: rid(), name: 'Second', series: { seriesId: series.seriesId } })
  await c.call('events.subscribe', { spaceId: second.spaceId })
  const session = await c.call('session.create', { requestId: rid() })
  await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Use series setting', refs: [] })
  await until(() => dispatched.length === 1)
  const a = await agent(dispatched[0]!.token)
  const secondHost = studiod.spaces.get(second.spaceId)!
  try {
    for (const method of ['series.list', 'series.create', 'series.rename', 'series.delete', 'series.mediaGet', 'space.setSeries',
      'entity.seriesDiff', 'entity.publish', 'entity.updateFromSeries', 'entity.resetToSeries']) {
      expect((await a.raw(method, {})).error?.data?.code, method).toBe('forbidden')
    }
    expect((await a.call('series.entityList', {})).items[0]).toMatchObject({ seriesEntityId: published.seriesEntityId })
    // The join checklist reads another project's settings without switching to it; agents stay inside their own project.
    expect((await c.call('entity.list', { spaceId, includeDeleted: false })).items.map((item: { id: string }) => item.id)).toEqual([hero.id])
    expect((await c.call('entity.list', { includeDeleted: false })).items).toEqual([])
    expect((await a.raw('entity.list', { spaceId })).error?.data?.code).toBe('forbidden')
    await expect(a.call('entity.link', { requestId: rid(), seriesEntityId: published.seriesEntityId, replaceEntityId: 'missing', expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'entity.replace_ui_only' } } })
    // Like entity.create, linking needs an active turn but no work item: the library session has none.
    secondHost.db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, session.sessionId)).run()
    const linked = await a.call('entity.link', { requestId: rid(), seriesEntityId: published.seriesEntityId })
    expect(linked.series).toMatchObject({ revision: 1, latestRevision: 1, modifiedLocally: false })
    secondHost.db.update(s.sessions).set({ workItemId: session.workItemId }).where(eq(s.sessions.id, session.sessionId)).run()
    expect((await a.call('entity.link', { requestId: rid(), seriesEntityId: published.seriesEntityId })).id).toBe(linked.id)
    await expect(c.call('series.mediaGet', { seriesId: series.seriesId, refId: '../../outside' })).rejects.toMatchObject({ code: 'not_found' })
    expect(host.entities.get({ entityId: hero.id }).series?.revision).toBe(1)
    await until(() => otherUi.notifications.some(item => item.method === 'events.seriesChanged' && (item.params as { seriesId?: string }).seriesId === series.seriesId) && otherUi.notifications.some(item => item.method === 'events.spacesChanged'))
    dispatched[0]!.end()
    await expect(a.call('series.entityList', {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('entity.link', { requestId: rid(), seriesEntityId: published.seriesEntityId })).rejects.toMatchObject({ code: 'forbidden' })
  } finally { a.close(); c.close(); otherUi.close() }
}, process.platform === 'win32' ? 20_000 : undefined)

it('enforces library callers and refuses labels from unlinked, archived or stopped agent sessions', async () => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const host = studiod.spaces.get(spaceId)!
  const staged = await host.assets.stageBytes(Buffer.from('library-fixture'))
  const registered = host.db.transaction(tx => host.assets.registerVersion(tx, { staged, kind: 'image', mime: 'image/png', origin: 'import' }))
  const session = await c.call('session.create', { requestId: rid() })
  await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Organize media', refs: [] })
  await until(() => dispatched.length === 1)
  const a = await agent(dispatched[0]!.token)
  try {
    host.db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, session.sessionId)).run()
    await expect(c.call('library.setSession', { sessionId: session.sessionId })).rejects.toMatchObject({ code: 'forbidden' })
    host.db.update(s.sessions).set({ workItemId: session.workItemId }).where(eq(s.sessions.id, session.sessionId)).run()
    await c.call('library.setSession', { sessionId: session.sessionId })
    const run = await c.call('library.runStart', { requestId: rid(), kind: 'label' })
    const request = () => ({ requestId: rid(), runId: run.runId, items: [{ assetId: registered.assetId, category: 'Portrait' }] })
    await expect(c.call('asset.label', request())).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('asset.update', { assetId: registered.assetId, expectedRevision: 1, displayName: 'Forbidden' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('library.setSession', { sessionId: session.sessionId })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await a.call('asset.list')).items[0]).toHaveProperty('context')
    expect((await c.call('asset.list')).items[0]).not.toHaveProperty('context')
    expect((await a.call('library.state')).sessionId).toBe(session.sessionId)
    expect(await a.call('asset.label', request())).toEqual({ labeled: [registered.assetId], skippedFields: [] })
    host.db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, session.sessionId)).run()
    await expect(a.call('asset.label', request())).rejects.toMatchObject({ code: 'forbidden' })
    host.db.update(s.sessions).set({ workItemId: session.workItemId, archivedAt: Date.now() }).where(eq(s.sessions.id, session.sessionId)).run()
    await expect(a.call('asset.label', request())).rejects.toMatchObject({ code: 'forbidden' })
    expect((await c.call('library.state')).sessionId).toBeNull()
    await expect(c.call('library.runStart', { requestId: rid(), kind: 'label' })).rejects.toMatchObject({
      code: 'invalid_params', rpc: { data: { reason: 'library.session_required' } },
    })
    host.db.update(s.sessions).set({ archivedAt: null }).where(eq(s.sessions.id, session.sessionId)).run()
    dispatched[0]!.end()
    await expect(a.call('asset.label', request())).rejects.toMatchObject({ code: 'forbidden' })
  } finally { a.close(); c.close() }
})

it('enforces settings caller rules and active-session writes while allowing proposals for user review', async () => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const session = await c.call('session.create', { requestId: rid() })
  await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Organize settings', refs: [] })
  await until(() => dispatched.length === 1)
  const a = await agent(dispatched[0]!.token)
  try {
    const created = await a.call('entity.create', { requestId: rid(), kind: 'character', name: 'Hero' })
    expect((await a.call('entity.list', {})).items[0].id).toBe(created.id)
    for (const method of ['entity.delete', 'entity.proposalResolve', 'entity.unmerge']) {
      expect((await a.raw(method, {})).error?.data?.code).toBe('forbidden')
    }
    expect((await c.raw('entity.propose', {})).error?.data?.code).toBe('forbidden')
    expect((await a.raw('entity.update', { entityId: created.id, expectedRevision: 1, members: [] })).error?.data?.code).toBe('forbidden')
    expect((await a.raw('entity.create', { requestId: rid(), kind: 'scene', name: 'Park', members: [] })).error?.data?.code).toBe('forbidden')
    const host = studiod.spaces.get(spaceId)!
    const media = host.assets.registerVersion(host.db, { staged: await host.assets.stageBytes(Buffer.from('image')), kind: 'image', mime: 'image/png', origin: 'import' })
    const proposed = await a.call('entity.propose', { requestId: rid(), proposals: [{ entityId: created.id, kind: 'character', name: 'Hero', members: [{ assetId: media.assetId, role: 'image' }], reason: 'Same face' }] })
    const accepted = await c.call('entity.proposalResolve', { requestId: rid(), proposalId: proposed.proposalIds[0], accept: true })
    expect(accepted.entity.members).toHaveLength(1)
    dispatched[0]!.end()
    expect((await a.raw('entity.create', { requestId: rid(), kind: 'scene', name: 'Park' })).error?.data?.code).toBe('forbidden')
  } finally { a.close(); c.close() }
})

it.each(['stop', 'recall', 'recall-after-end'] as const)('%s cancels pending and running Agent batches but keeps user batches', async action => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const host = studiod.spaces.get(spaceId)!
  await host.scriptBatches.stop()
  await host.generation.stop()
  const created = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', kind: 'script', tempId: 'script' }] })
  const scriptNodeId = created.idMap.script
  const slot = host.canvas.get({ nodeIds: [scriptNodeId] }).nodes[0]!.slots.find(slot => slot.slotKey === 'main')!
  await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'script.patch', slotId: slot.slotId, ops: [
    { kind: 'shot.insert', tempId: 'shot', afterShotId: null, shot: { description: 'Station', framePrompt: 'Still frame' } },
  ] }] })
  const session = await c.call('session.create', { requestId: rid() })
  await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Request batches', refs: [] })
  await until(() => dispatched.length === 1)
  const a = await agent(dispatched[0]!.token)
  try {
    const start = () => a.call('script.batch.start', { requestId: rid(), scriptNodeId, media: 'frames' })
    const running = await start()
    await c.call('script.batch.approve', { requestId: rid(), batchId: running.batchId })
    await host.scriptBatches.pump()
    await host.generation.pump()
    const pending = await start()
    const queued = await start()
    await c.call('script.batch.approve', { requestId: rid(), batchId: queued.batchId })
    const userBatch = await c.call('script.batch.start', { requestId: rid(), scriptNodeId, media: 'frames' })
    if (action === 'stop') await c.call('session.stop', { requestId: rid(), sessionId: session.sessionId, turnId: dispatched[0]!.turnId })
    else {
      if (action === 'recall-after-end') dispatched[0]!.end()
      await c.call('work.recall', { requestId: rid(), workItemId: session.workItemId })
    }
    for (const batch of [running, pending, queued]) expect((await c.call('script.batch.get', { batchId: batch.batchId })).status).toBe('cancelled')
    const jobs = host.db.select().from(s.generationJobs).all()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ status: 'cancelled', providerCancelled: true, sessionId: null })
    expect((await c.call('script.batch.get', { batchId: userBatch.batchId })).status).toBe('running')
    await host.scriptBatches.pump()
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(2)
  } finally { a.close(); c.close() }
}, 30_000)

it('enforces Agent batch approval, active turns, session ownership and UI execution at the gateway', async () => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const host = studiod.spaces.get(spaceId)!
  const created = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', kind: 'script', tempId: 'script' }] })
  const scriptNodeId = created.idMap.script
  const slot = (await c.call('canvas.get', { nodeIds: [scriptNodeId] })).nodes[0].slots.find((slot: { slotKey: string }) => slot.slotKey === 'main')
  await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'script.patch', slotId: slot.slotId, ops: [{ kind: 'shot.insert', tempId: 'shot', afterShotId: null, shot: { description: 'A quiet station', framePrompt: 'Still frame' } }] }] })
  const first = await c.call('session.create', { requestId: rid() })
  const second = await c.call('session.create', { requestId: rid() })
  for (const session of [first, second]) {
    host.db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, session.sessionId)).run()
    await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Request a batch', refs: [] })
  }
  await until(() => dispatched.length === 2)
  const a = await agent(dispatched[0]!.token)
  const other = await agent(dispatched[1]!.token)
  try {
    const params = { requestId: rid(), scriptNodeId, media: 'frames' }
    const pending = await a.call('script.batch.start', params)
    expect(pending).toMatchObject({ origin: 'agent', status: 'pending_approval', sessionId: first.sessionId })
    await host.scriptBatches.pump()
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(0)
    await expect(a.call('script.batch.approve', { requestId: rid(), batchId: pending.batchId })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(other.call('script.batch.cancel', { requestId: rid(), batchId: pending.batchId })).rejects.toMatchObject({ code: 'forbidden' })
    const transcript = await c.call('session.getTranscript', { sessionId: first.sessionId, limit: 50 })
    const approval = transcript.items.find((item: { kind: string }) => item.kind === 'approval')
    expect(approval.payload).toMatchObject({ kind: 'generation_batch', status: 'pending', batchId: pending.batchId })
    const generic = await c.raw('session.respondApproval', { requestId: rid(), approvalId: approval.itemId, decision: 'allow_once' })
    expect(generic.error?.data).toMatchObject({ code: 'invalid_params', reason: 'script.batch_approval_method_required' })
    dispatched[0]!.end()
    await expect(a.call('script.batch.start', params)).rejects.toMatchObject({ code: 'forbidden' })
    await c.call('script.batch.approve', { requestId: rid(), batchId: pending.batchId })
    await expect.poll(async () => (await c.call('script.batch.get', { batchId: pending.batchId })).status, { timeout: 10_000 }).toBe('succeeded')
    const userBatch = await c.call('script.batch.start', { requestId: rid(), scriptNodeId, media: 'frames' })
    expect(userBatch).toMatchObject({ origin: 'user', status: 'running' })
    await expect.poll(async () => (await c.call('script.batch.get', { batchId: userBatch.batchId })).status, { timeout: 10_000 }).toBe('succeeded')
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(2)
  } finally {
    a.close()
    other.close()
    c.close()
  }
}, 30_000)

describe('Local media gateway', () => {
  let finish: (() => void)[]

  async function setupMedia(timeoutMs?: number) {
    await studiod.stop('user_quit')
    finish = []
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'test', runtimes: { codex: fakeRuntime, claude: () => ({ async ensureReady() {}, async dispatchTurn() {}, async terminateTurn() {}, async interruptTurn() {} }) },
      providers: [createMockProvider({ latencyMs: 1 })],
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
      ...(timeoutMs !== undefined ? { mediaTaskTimeoutMs: timeoutMs } : {}),
      media: {
        async probe() { return { kind: 'image', mime: 'image/png', width: 20, height: 20 } },
        async extractFrames() { return [] },
        async analyzeSilence() { return { durationMs: 2000, pointsMs: [1000] } },
        async process(_path, _operation, _params, opts) {
          const path = join(dir, `output-${finish.length}.png`)
          writeFileSync(path, `processed-${finish.length}`)
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(opts!.signal!.reason)
            opts!.signal!.addEventListener('abort', abort, { once: true })
            finish.push(() => { opts!.signal!.removeEventListener('abort', abort); resolve() })
            opts!.onProgress?.(0.5)
          })
          return { outputs: [{ path, kind: 'image', mime: 'image/png', width: 10, height: 20 }], async dispose() {} }
        },
      },
    })
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const host = studiod.spaces.get(spaceId)!
    const staged = await host.assets.stageBytes(Buffer.from('source'))
    const asset = host.assets.registerVersion(host.db, { staged, kind: 'image', mime: 'image/png', origin: 'import', width: 20, height: 20 })
    const created = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'source', kind: 'image', content: { assetVersionId: asset.assetVersionId } }] })
    const node = host.canvas.get({ nodeIds: [created.idMap.source] }).nodes[0]!
    const params = { requestId: rid(), operation: 'image.crop', nodeId: node.nodeId, slotId: node.slots[0]!.slotId, expectedRevision: 1, params: { x: 0, y: 0, w: 10, h: 20 } }
    return { c, host, params, node }
  }

  it('enforces idempotency, returns active tasks in snapshots, publishes events, and records user undo', async () => {
    const { c, host, params } = await setupMedia()
    const task = await c.call('media.process', params)
    await until(() => finish.length === 1)
    expect((await c.call('media.process', { ...params, waitMs: 1 })).taskId).toBe(task.taskId)
    await expect(c.call('media.process', { ...params, params: { x: 1, y: 0, w: 10, h: 20 } })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    const snapshot = await c.call('events.subscribe', { spaceId })
    expect(snapshot.snapshot.activeMediaTasks).toMatchObject([{ taskId: task.taskId, status: 'running' }])
    await until(() => c.notifications.some(event => event.method === 'events.mediaProgress'))
    expect(c.notifications.find(event => event.method === 'events.mediaProgress')!.params).toEqual({ taskId: task.taskId, progress: 0.5 })
    expect(host.db.select().from(s.generationJobs).all()).toEqual([])
    finish[0]!()
    const result = await c.call('media.get', { taskId: task.taskId, waitMs: 1000 })
    expect(result).toMatchObject({ status: 'succeeded', operationId: expect.any(String) })
    await until(() => c.notifications.some(event => event.params.type === 'mediaTask.stateChanged'))
    expect(host.db.select().from(s.undoEntries).all()).toHaveLength(2)
    await c.call('canvas.undo', { requestId: rid() })
    expect(host.canvas.get({}).nodes[0]!.slots[0]!.content).toMatchObject({ assetVersionId: host.db.select().from(s.assetVersions).all()[0]!.id })
    c.close()
  })

  it('rejects stale revisions and edits during processing without leaving output assets', async () => {
    const { c, host, params } = await setupMedia()
    await expect(c.call('media.process', { ...params, expectedRevision: 0 })).rejects.toMatchObject({ code: 'revision_conflict' })
    const task = await c.call('media.process', params)
    await until(() => finish.length === 1)
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'slot.clear', slotId: params.slotId, expectedRevision: 1 }] })
    finish[0]!()
    expect(await c.call('media.get', { taskId: task.taskId, waitMs: 1000 })).toMatchObject({ status: 'failed', error: { code: 'revision_conflict' } })
    expect(host.db.select().from(s.assetVersions).all()).toHaveLength(1)
    expect(await host.assets.findOrphanBlobs(host.db)).toEqual([])
    c.close()
  })

  it('permits active agents in plain project sessions and makes writes without a user undo entry', async () => {
    const { c, host, params } = await setupMedia()
    const session = await c.call('session.create', { requestId: rid() })
    await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Process the image', refs: [] })
    await until(() => dispatched.length === 1)
    const a = await agent(dispatched[0]!.token)
    host.db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, session.sessionId)).run()
    await expect(a.call('media.process', { ...params, spaceId })).rejects.toMatchObject({ code: 'forbidden' })
    const task = await a.call('media.process', params)
    await until(() => finish.length === 1)
    finish[0]!()
    expect(await a.call('media.get', { taskId: task.taskId, waitMs: 1000 })).toMatchObject({ status: 'succeeded' })
    expect(host.db.select().from(s.undoEntries).all()).toHaveLength(1)
    expect(host.db.select().from(s.operations).all().at(-1)!.actorKind).toBe('agent')
    a.close()
    c.close()
  })

  it('runs only two local tasks and keeps the remaining task queued independently of generation jobs', async () => {
    const { c, host, params } = await setupMedia()
    const tasks = []
    for (let i = 0; i < 3; i++) tasks.push(await c.call('media.process', { ...params, requestId: rid() }))
    await until(() => finish.length === 2)
    expect((await c.call('media.get', { taskId: tasks[2].taskId })).status).toBe('queued')
    expect(host.db.select().from(s.generationJobs).all()).toEqual([])
    finish[0]!()
    await c.call('media.get', { taskId: tasks[0].taskId, waitMs: 1000 })
    await until(() => finish.length === 3)
    finish[1]!()
    finish[2]!()
    c.close()
  })

  it.each(['stop', 'recall', 'recall-after-end'] as const)('%s aborts queued and running tasks from the session', async action => {
    const { c, host, params } = await setupMedia()
    const session = await c.call('session.create', { requestId: rid() })
    await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Process', refs: [] })
    await until(() => dispatched.length === 1)
    const a = await agent(dispatched[0]!.token)
    const tasks = []
    for (let i = 0; i < 3; i++) tasks.push(await a.call('media.process', { ...params, requestId: rid() }))
    await until(() => finish.length === 2)
    if (action === 'recall-after-end') dispatched[0]!.end()
    if (action === 'stop') await c.call('session.stop', { requestId: rid(), sessionId: session.sessionId, turnId: dispatched[0]!.turnId })
    else {
      const recall = () => {
        const work = host.work.get({ workItemId: session.workItemId })
        return c.call('work.recall', { requestId: rid(), workItemId: session.workItemId, expectedRevision: work.item.revision })
      }
      try { await recall() } catch (error) {
        // Turn completion can revise derived work fields between the read and the RPC.
        if ((error as { code?: string }).code !== 'revision_conflict') throw error
        await recall()
      }
    }
    for (const task of tasks) expect(await c.call('media.get', { taskId: task.taskId, waitMs: 1000 })).toMatchObject({ status: 'failed', error: { code: 'media.cancelled' } })
    expect(host.db.select().from(s.assetVersions).all()).toHaveLength(1)
    expect(await host.assets.findOrphanBlobs(host.db)).toEqual([])
    a.close()
    c.close()
  })

  it('times out and recovers queued or running tasks as failed without registering output assets', async () => {
    const { c, host, params } = await setupMedia(40)
    const task = await c.call('media.process', params)
    expect(await c.call('media.get', { taskId: task.taskId, waitMs: 1000 })).toMatchObject({ status: 'failed', error: { code: 'media.timeout' } })
    expect(host.db.select().from(s.assetVersions).all()).toHaveLength(1)
    const row = host.db.select().from(s.mediaTasks).get()!
    host.db.update(s.mediaTasks).set({ status: 'running', error: null }).where(eq(s.mediaTasks.id, task.taskId)).run()
    host.db.insert(s.mediaTasks).values({ ...row, id: 'queued-before-restart', requestId: 'queued-before-restart', status: 'queued', error: null }).run()
    c.close()
    await studiod.stop('user_quit')
    // Persist unfinished records after graceful close to model an abrupt process exit.
    const db = (await import('@vis/storage')).openSpaceDb(join(dir, 'spaces', spaceId, 'space.db'))
    db.update(s.mediaTasks).set({ status: 'running', error: null }).where(eq(s.mediaTasks.id, task.taskId)).run()
    db.update(s.mediaTasks).set({ status: 'queued', error: null }).where(eq(s.mediaTasks.id, 'queued-before-restart')).run()
    db.$client.close()
    studiod = await startStudiod({ dataDir: dir, studiodVersion: 'test', runtimes: {}, providers: [createMockProvider()], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } } })
    const reopened = studiod.spaces.get(spaceId)!
    expect(reopened.db.select().from(s.mediaTasks).all().map(task => [task.status, task.error?.code])).toEqual([['failed', 'media.interrupted'], ['failed', 'media.interrupted']])
    expect(reopened.db.select().from(s.assetVersions).all()).toHaveLength(1)
    expect(await reopened.assets.findOrphanBlobs(reopened.db)).toEqual([])
  })

  it('delivers a mock generation operation to a connected new node with its operation in the view', async () => {
    const { c, host, params, node } = await setupMedia()
    const job = await c.call('generation.submit', {
      requestId: rid(), kind: 'image', operation: 'image.outpaint', prompt: `Use {{ref:${node.nodeId}}}`, inputs: [{ slotId: params.slotId }], params: { ratio: '16:9' },
    })
    expect(job.bindings[0].target).toEqual({ kind: 'new_node', nearNodeId: node.nodeId, nodeId: expect.any(String), slotId: expect.any(String) })
    let result = await c.call('generation.get', { jobId: job.jobId })
    await expect.poll(async () => {
      result = await c.call('generation.get', { jobId: job.jobId, waitMs: 1000 })
      return result.status
    }, { timeout: 10_000 }).toBe('succeeded')
    expect(result.operation).toBe('image.outpaint')
    expect(host.canvas.get({ nodeIds: [result.outputs[0].delivery.nodeId] }).nodes[0]!.inputs).toEqual([node.nodeId])
    expect(host.canvas.get({ nodeIds: [node.nodeId] }).nodes[0]!.slots[0]!.revision).toBe(1)
    const history = await c.call('slot.history', { slotId: result.outputs[0].delivery.slotId })
    expect(history.versions[0].source.prompt).toBe(`Use {{ref:${node.nodeId}}}`)
    expect(history.versions[0].source.params.resolvedPrompt).toBeUndefined()
    c.close()
  })

  it('rejects an undeclared generation operation without a job or global quota reservation', async () => {
    const { c, host, params } = await setupMedia()
    host.generation.configure([{ ...createMockProvider(), type: 'volcengine-ark', operationsFor: () => ['generate'] }], {
      image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' },
    })
    await expect(c.call('generation.submit', { requestId: rid(), kind: 'image', operation: 'image.upscale', inputs: [{ slotId: params.slotId }] }))
      .rejects.toMatchObject({ code: 'invalid_params' })
    expect(host.db.select().from(s.generationJobs).all()).toEqual([])
    const db = openAppDb(join(dir, 'app.db'))
    try { expect(db.select().from(appSchema.generationQuota).all()).toEqual([]) }
    finally { db.$client.close() }
    c.close()
  })

  it('analyzes only the registered audio slot and returns silence midpoints without a task or canvas write', async () => {
    const { c, host, params } = await setupMedia()
    await expect(c.call('media.analyze', { operation: 'audio.silence', nodeId: params.nodeId, slotId: params.slotId })).rejects.toMatchObject({ code: 'invalid_params' })
    const staged = await host.assets.stageBytes(Buffer.from('audio source'))
    const audio = host.assets.registerVersion(host.db, { staged, kind: 'audio', mime: 'audio/wav', origin: 'import', durationMs: 2000 })
    const created = host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'audio', kind: 'audio', content: { assetVersionId: audio.assetVersionId } }] })
    const node = host.canvas.get({ nodeIds: [created.idMap.audio!] }).nodes[0]!
    const seq = currentSeq(host.db)
    expect(await c.call('media.analyze', { operation: 'audio.silence', nodeId: node.nodeId, slotId: node.slots[0]!.slotId, params: { minSilenceMs: 200 } }))
      .toEqual({ durationMs: 2000, pointsMs: [1000] })
    expect(currentSeq(host.db)).toBe(seq)
    expect(host.db.select().from(s.mediaTasks).all()).toEqual([])
    c.close()
  })
})

describe('UI preferences (0018)', () => {
  it('defaults to browser preferences, sets idempotently, persists across app.db reopening, and deletes keys with null', async () => {
    const c = await ui()
    expect(await c.call('preferences.get')).toEqual({ locale: null })
    expect(await c.call('preferences.set', { locale: 'en' })).toEqual({ locale: 'en' })
    expect(await c.call('preferences.set', { locale: 'en' })).toEqual({ locale: 'en' })
    await expect(c.call('preferences.set', { locale: 'fr' })).rejects.toMatchObject({ code: 'invalid_params' })
    c.close()
    await studiod.stop('user_quit')
    studiod = await startStudiod({ dataDir: dir, studiodVersion: '0.0.0-test', runtimes: { codex: fakeRuntime, claude: () => ({ async ensureReady() {}, async dispatchTurn() {}, async terminateTurn() {}, async interruptTurn() {} }) }, providers: [createMockProvider()], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } } })
    const reopened = await ui()
    expect(await reopened.call('preferences.get')).toEqual({ locale: 'en' })
    expect(await reopened.call('preferences.set', { locale: 'zh-CN' })).toEqual({ locale: 'zh-CN' })
    expect(await reopened.call('preferences.set', { locale: null })).toEqual({ locale: null })
    expect(await reopened.call('preferences.set', { locale: null })).toEqual({ locale: null })
    expect(await reopened.call('preferences.get')).toEqual({ locale: null })
    const db = openAppDb(join(dir, 'app.db'))
    try { expect(db.select().from(appSchema.settings).where(eq(appSchema.settings.key, 'ui.locale')).get()).toBeUndefined() }
    finally { db.$client.close() }
    reopened.close()
  })

  it('Agents cannot read or write global UI preferences', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const { sessionId } = await c.call('session.create', { requestId: rid(), title: '语言偏好' })
    await c.call('session.sendMessage', { requestId: rid(), sessionId, text: '检查', refs: [] })
    await until(() => dispatched.length === 1)
    const a = await agent(dispatched[0]!.token)
    await expect(a.call('preferences.get')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('preferences.set', { locale: 'en' })).rejects.toMatchObject({ code: 'forbidden' })
    expect(await c.call('preferences.get')).toEqual({ locale: null })
    a.close()
    c.close()
  })

  it('preserves error reason, params and additional fields through the gateway', async () => {
    const c = await ui()
    expect((await c.raw('events.subscribe', { spaceId: 'missing-space' })).error).toMatchObject({
      message: 'Project does not exist', data: { code: 'not_found', reason: 'space.not_found', params: {} },
    })
    await c.call('events.subscribe', { spaceId })
    const host = studiod.spaces.get(spaceId)!
    const conflicts = [{ slotId: 'slot', expectedRevision: 1, currentRevision: 2 }]
    const quota = { kind: 'image' as const, count: 5, limit: 5 }
    const get = vi.spyOn(host.sessions, 'list').mockImplementation(() => { throw VisError.of('quota_exceeded', 'test.quota', { count: 5 }, 'Insufficient quota', undefined, quota, { extra: 'kept' }) })
    try {
      expect((await c.raw('session.list')).error).toMatchObject({ message: 'Insufficient quota', data: { code: 'quota_exceeded', reason: 'test.quota', params: { count: 5 }, ...quota, extra: 'kept' } })
      get.mockImplementation(() => { throw VisError.of('revision_conflict', 'test.conflict', { name: '场景' }, 'Revision conflict', conflicts) })
      expect((await c.raw('session.list')).error).toMatchObject({ data: { code: 'revision_conflict', reason: 'test.conflict', params: { name: '场景' }, conflicts } })
    } finally { get.mockRestore(); c.close() }
  })
})

describe('Author skill permissions (0033)', () => {
  it('allows linked active Agents to propose only; all library access and decisions are refused', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const work = await c.call('work.create', { requestId: rid(), title: 'Author method', chat: { agentKind: 'codex' } })
    const sessionId = work.item.sessions[0].sessionId
    await c.call('session.sendMessage', { requestId: rid(), sessionId, text: 'Save my stated method as a skill', refs: [] })
    await until(() => dispatched.length === 1)
    const a = await agent(dispatched[0]!.token)
    const params = { requestId: rid(), name: 'author-method', description: 'My reasons', body: 'Keep the pauses I asked for.' }
    const proposed = await a.call('skill.proposeDraft', params)
    expect(proposed.location).toBe('Settings > My skills')
    expect(proposed.draft).toMatchObject({ spaceId, sessionId, name: params.name })
    expect(await a.call('skill.proposeDraft', params)).toEqual(proposed)
    expect((await c.call('skill.libraryList')).skills).toEqual([])
    for (const [method, input] of [
      ...['copyUpdate', 'copyReset', 'copyPublish', 'setAutoAdd', 'libraryDelete', 'export', 'importDrafts', 'draftState'].map(name => [`skill.${name}`, {}] as const),
      ['skill.libraryList', {}], ['skill.libraryGet', { skillId: 'anything' }],
      ['skill.librarySave', { ...params, requestId: rid(), draftId: proposed.draft.draftId, expectedRevision: 1 }],
      ['skill.discardDraft', { draftId: proposed.draft.draftId, expectedRevision: 1 }],
      ['skill.use', { requestId: rid(), skillId: 'anything', version: 'a'.repeat(64), spaceId }],
    ] as const) await expect(a.call(method, input)).rejects.toMatchObject({ code: 'forbidden' })
    expect((await c.call('skill.libraryList')).drafts).toHaveLength(1)
    await expect(c.call('skill.proposeDraft', { ...params, requestId: rid() })).rejects.toMatchObject({ code: 'forbidden' })
    const saved = await c.call('skill.librarySave', { ...params, requestId: rid(), draftId: proposed.draft.draftId, expectedRevision: 1 })
    expect(await c.call('skill.libraryGet', { skillId: saved.skillId })).toMatchObject({ body: params.body })
    dispatched[0]!.end()
    await expect(a.call('skill.proposeDraft', { ...params, requestId: rid() })).rejects.toMatchObject({ code: 'forbidden' })
    a.close()
    c.close()
  })

  it('refuses proposals from sessions without a work item', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const { sessionId } = await c.call('session.create', { requestId: rid() })
    await c.call('session.sendMessage', { requestId: rid(), sessionId, text: 'Draft', refs: [] })
    await until(() => dispatched.length === 1)
    studiod.spaces.get(spaceId)!.db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, sessionId)).run()
    const a = await agent(dispatched[0]!.token)
    await expect(a.call('skill.proposeDraft', { requestId: rid(), name: 'method', description: 'Method', body: 'My method' })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await c.call('skill.libraryList')).drafts).toEqual([])
    a.close()
    c.close()
  })
})

describe('Project skill management', () => {
  it('UI stages, imports and removes by target project; discard needs no subscription; Agents are denied all five methods', async () => {
    const c = await ui()
    const other = studiod.spaces.create('技能来源')
    const source = join(other.rootPath, 'skills', 'source')
    mkdirSync(source)
    writeFileSync(join(source, 'SKILL.md'), '---\nname: 来源\ndescription: 示例\n---\n正文')
    const staged = await c.call('skill.stage', { spaceId, fromSpaceId: other.spaceId, names: ['来源'] })
    expect(staged.candidates).toMatchObject([{ name: '来源', exists: false }])
    await c.call('skill.import', { spaceId, stagingId: staged.stagingId, names: ['来源'] })
    expect((await c.call('skill.list', { spaceId })).skills).toMatchObject([{ name: '来源' }])
    const removed = await c.call('skill.remove', { spaceId, name: '来源' })
    expect(existsSync(join(removed.removedPath, 'SKILL.md'))).toBe(true)
    expect((await c.call('skill.list', { spaceId })).skills).toEqual([])
    const unused = await c.call('skill.stage', { spaceId, path: source })
    expect(await c.call('skill.discard', { stagingId: unused.stagingId })).toEqual({ ok: true })
    expect(await c.call('skill.discard', { stagingId: unused.stagingId })).toEqual({ ok: true })
    await expect(c.call('skill.import', { spaceId, stagingId: unused.stagingId, names: ['来源'] })).rejects.toMatchObject({ code: 'not_found' })
    await c.call('events.subscribe', { spaceId })
    const { sessionId } = await c.call('session.create', { requestId: rid(), title: '技能权限' })
    await c.call('session.sendMessage', { requestId: rid(), sessionId, text: '检查', refs: [] })
    await until(() => dispatched.length === 1)
    const a = await agent(dispatched[0]!.token)
    for (const [method, params] of [
      ['skill.list', {}], ['skill.stage', { path: source }],
      ['skill.import', { stagingId: staged.stagingId, names: ['来源'] }],
      ['skill.discard', { stagingId: staged.stagingId }], ['skill.remove', { name: '来源' }],
    ] as const) await expect(a.call(method, params)).rejects.toMatchObject({ code: 'forbidden' })
    a.close()
    c.close()
  })

  it('fs.reveal skills opens the specified project skills directory', async () => {
    const reveal = vi.spyOn(filesystem, 'reveal').mockImplementation(async path => ({ ok: true, path, revealed: false }))
    try {
      const c = await ui()
      expect(await c.call('fs.reveal', { spaceId, skills: true })).toMatchObject({ path: join(studiod.spaces.get(spaceId)!.rootPath, 'skills') })
      c.close()
    } finally { reveal.mockRestore() }
  })
})

describe('Work item directories', () => {
  it('fs.reveal resolves persistent working directories for current and specified projects, reuses reveal and keeps old targets valid', async () => {
    const reveal = vi.spyOn(filesystem, 'reveal').mockImplementation(async path => ({ ok: true, path, revealed: false }))
    try {
      const c = await ui()
      await c.call('events.subscribe', { spaceId })
      const current = (await c.call('work.create', { requestId: rid(), title: '当前工作项' })).item
      const otherSpace = studiod.spaces.create('后台项目').spaceId
      const other = (await c.call('work.create', { requestId: rid(), spaceId: otherSpace, title: '后台工作项' })).item
      expect(await c.call('fs.reveal', { workItemId: current.workItemId })).toEqual({ ok: true, path: current.workDir, revealed: false })
      expect(await c.call('fs.reveal', { spaceId: otherSpace, workItemId: other.workItemId })).toEqual({ ok: true, path: other.workDir, revealed: false })
      await expect(c.call('fs.reveal', { workItemId: other.workItemId })).rejects.toMatchObject({ code: 'not_found' })
      const session = await c.call('session.create', { requestId: rid(), title: '普通对话' })
      expect(await c.call('fs.reveal', { sessionId: session.sessionId })).toMatchObject({ path: session.workDir })
      expect(await c.call('fs.reveal', { spaceId })).toMatchObject({ path: join(studiod.spaces.get(spaceId)!.rootPath, 'assets') })
      expect(reveal).toHaveBeenCalledTimes(4)
      c.close()
    } finally { reveal.mockRestore() }
  })

  it('fs.reveal reports missing working directories or conflicting targets explicitly and denies Agents', async () => {
    const reveal = vi.spyOn(filesystem, 'reveal').mockImplementation(async path => ({ ok: true, path, revealed: false }))
    try {
      const c = await ui()
      await c.call('events.subscribe', { spaceId })
      const item = (await c.call('work.create', { requestId: rid(), title: '目录已删除' })).item
      rmSync(item.workDir, { recursive: true })
      await expect(c.call('fs.reveal', { workItemId: item.workItemId })).rejects.toMatchObject({ code: 'not_found' })
      await expect(c.call('fs.reveal', { spaceId: 'missing-space', workItemId: item.workItemId })).rejects.toMatchObject({ code: 'not_found' })
      const session = await c.call('session.create', { requestId: rid() })
      await expect(c.call('fs.reveal', { sessionId: session.sessionId, workItemId: item.workItemId })).rejects.toMatchObject({ code: 'invalid_params' })
      await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: '开始', refs: [] })
      await until(() => dispatched.length === 1)
      const a = await agent(dispatched[0]!.token)
      await expect(a.call('fs.reveal', { workItemId: item.workItemId })).rejects.toMatchObject({ code: 'forbidden' })
      expect(reveal).not.toHaveBeenCalled()
      a.close()
      c.close()
    } finally { reveal.mockRestore() }
  })
})

describe('Handshake', () => {
  it('rejects and disconnects when the first request is not hello', async () => {
    const c = await client()
    const res = await c.raw('canvas.get', {})
    expect(res.error?.data?.code).toBe('forbidden')
    await until(c.isClosed)
  })

  it('returns forbidden and disconnects on invalid credentials', async () => {
    const c = await client()
    const res = await c.raw('runtime.hello', { protocolVersion: PROTOCOL_VERSION, credential: { kind: 'ui', token: 'wrong' } })
    expect(res.error?.data?.code).toBe('forbidden')
    await until(c.isClosed)
    const a = await client()
    expect((await a.raw('runtime.hello', { protocolVersion: PROTOCOL_VERSION, credential: { kind: 'agent', token: `${spaceId}.bogus` } })).error?.data?.code).toBe('forbidden')
  })

  it('returns the protocol version and runtime epoch', async () => {
    const c = await client()
    const res = await c.call('runtime.hello', { protocolVersion: PROTOCOL_VERSION, credential: { kind: 'ui', token: readFileSync(studiod.tokenPath, 'utf8') } })
    expect(res).toMatchObject({ protocolVersion: PROTOCOL_VERSION, studiodVersion: '0.0.0-test', runtimeEpoch: expect.any(String) })
  })

  it('UI with a mismatched protocol version can only shut down studiod', async () => {
    const c = await client()
    const res = await c.call('runtime.hello', { protocolVersion: PROTOCOL_VERSION + 1, credential: { kind: 'ui', token: readFileSync(studiod.tokenPath, 'utf8') } })
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION)
    await expect(c.call('runtime.activity')).rejects.toMatchObject({ code: 'unavailable' })
    expect(await c.call('runtime.shutdown', { reason: 'upgrade' })).toEqual({ accepted: true })
    expect(await studiod.stopped).toBe('upgrade')
  })
})

describe('UI', () => {
  it('checks registration without probing availability on kind-bearing RPCs', async () => {
    const probe = vi.spyOn(studiod.spaces, 'agents')
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    await c.call('session.create', { requestId: rid(), agentKind: 'codex' })
    await c.call('work.create', { requestId: rid(), title: 'No probe', chat: { agentKind: 'codex' } })
    expect(probe).not.toHaveBeenCalled()
    await c.call('agents.list', {})
    expect(probe).toHaveBeenCalledOnce()
    c.close()
  })

  it('lists registered Agents before subscription and rejects unregistered kinds at every creation boundary', async () => {
    const c = await ui()
    expect((await c.call('agents.list', {})).agents.map((agent: { kind: string }) => agent.kind)).toEqual(['codex', 'claude'])
    await c.call('events.subscribe', { spaceId })
    const unavailable = { code: 'unavailable', rpc: { data: { reason: 'session.agent_unconfigured' } } }
    await expect(c.call('session.create', { requestId: rid(), agentKind: 'example-missing' })).rejects.toMatchObject(unavailable)
    await expect(c.call('work.create', { requestId: rid(), title: 'Missing adapter', chat: { agentKind: 'example-missing' } })).rejects.toMatchObject(unavailable)
    const { item } = await c.call('work.create', { requestId: rid(), title: 'Pending adapter' })
    for (const [method, extra] of [
      ['work.activate', {}], ['work.review', { decision: 'reject' }],
    ] as const) {
      await expect(c.call(method, { requestId: rid(), workItemId: item.workItemId, expectedRevision: item.revision, agentKind: 'example-missing', ...extra })).rejects.toMatchObject(unavailable)
    }
    expect((await c.call('work.move', { requestId: rid(), workItemId: item.workItemId, status: 'in_progress', agentKind: 'example-missing' })).item.status).toBe('in_progress')
    const stored = await c.call('session.create', { requestId: rid() })
    studiod.spaces.get(spaceId)!.db.update(s.sessions).set({ agentKind: 'removed-adapter' }).where(eq(s.sessions.id, stored.sessionId)).run()
    expect((await c.call('session.list', {})).sessions.some((session: { agentKind: string }) => session.agentKind === 'removed-adapter')).toBe(true)
    await expect(c.call('session.sendMessage', { requestId: rid(), sessionId: stored.sessionId, text: 'Do not start', refs: [] })).rejects.toMatchObject(unavailable)
    expect(dispatched).toHaveLength(0)
    c.close()
  })

  it('reads and sets session model and effort, broadcasts summaries to all windows and keeps retries idempotent', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const watcher = await ui()
    await watcher.call('events.subscribe', { spaceId })
    const session = await c.call('session.create', { requestId: rid() })
    expect(session.agentConfig).toEqual({ model: null, effort: null, serviceTier: null })
    expect(await c.call('session.agentOptions', { sessionId: session.sessionId })).toEqual({ models })
    await expect(c.call('session.agentOptions', { sessionId: 'missing' })).rejects.toMatchObject({ code: 'not_found' })
    const params = { requestId: rid(), sessionId: session.sessionId, model: 'model-a', effort: 'high', serviceTier: null }
    const updated = await c.call('session.setAgentConfig', params)
    expect(updated.agentConfig).toEqual({ model: 'model-a', effort: 'high', serviceTier: null })
    const db = studiod.spaces.get(spaceId)!.db
    const seq = currentSeq(db)
    expect(await c.call('session.setAgentConfig', params)).toEqual(updated)
    expect(currentSeq(db)).toBe(seq)
    await expect(c.call('session.setAgentConfig', { ...params, effort: null })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(c.call('session.setAgentConfig', { ...params, requestId: rid(), model: 'unknown' })).rejects.toMatchObject({ code: 'invalid_params' })
    await until(() => watcher.notifications.some(n => n.params.type === 'session.updated'))
    expect(watcher.notifications.filter(n => n.params.type === 'session.updated')).toMatchObject([{ params: { payload: updated } }])
    const unsupported = await c.call('session.create', { requestId: rid(), agentKind: 'claude' })
    await expect(c.call('session.agentOptions', { sessionId: unsupported.sessionId })).rejects.toMatchObject({ code: 'unavailable' })
    expect((await c.call('session.setAgentConfig', { requestId: rid(), sessionId: unsupported.sessionId, model: null, effort: null, serviceTier: null })).agentConfig).toEqual({ model: null, effort: null, serviceTier: null })
    watcher.close()
    c.close()
  })

  it('allows creating projects, reading the default root, picking directories and previewing skills before subscribing', async () => {
    const c = await ui()
    const params = { requestId: rid(), name: '新项目' }
    const project = await c.call('space.create', params)
    expect(project).toMatchObject({ name: '新项目', rootPath: join(dir, 'projects', '新项目') })
    expect(await c.call('space.create', params)).toEqual(project)
    expect(await c.call('space.list')).toMatchObject({ projectsDir: join(dir, 'projects'), spaces: expect.arrayContaining([project]) })
    expect(await c.call('fs.listSkills', { spaceId: project.spaceId })).toEqual({ skills: [] })
    expect(await c.call('fs.validateDirectory', { path: project.rootPath })).toEqual({ valid: true })
    vi.stubEnv('VIS_PICK_DIRECTORY', project.rootPath)
    expect(await c.call('fs.pickDirectory')).toMatchObject({ path: project.rootPath, cancelled: false, unsupported: false })
    await c.call('events.subscribe', { spaceId: project.spaceId })
    const session = await c.call('session.create', { requestId: rid() })
    expect(session).toMatchObject({ title: 'Codex 1', titleSource: 'default', workDir: expect.stringContaining(`${sep}workspaces${sep}ws-`) })
    await expect(c.call('asset.importFile', { requestId: rid(), path: join(session.workDir, 'none.png') })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('rename and restore automatic naming return summaries and emit events without duplicate changes on retry', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const watcher = await ui()
    await watcher.call('events.subscribe', { spaceId })
    const created = await c.call('session.create', { requestId: rid(), title: '新会话' })
    expect(created).toMatchObject({ title: '新会话', titleSource: 'user' })
    const params = { requestId: rid(), sessionId: created.sessionId, title: '  我的任务  ' }
    const renamed = await c.call('session.rename', params)
    expect(renamed).toMatchObject({ title: '我的任务', titleSource: 'user' })
    const db = studiod.spaces.get(spaceId)!.db
    const afterRename = currentSeq(db)
    expect(await c.call('session.rename', params)).toEqual(renamed)
    expect(currentSeq(db)).toBe(afterRename)
    await expect(c.call('session.rename', { ...params, title: '其他任务' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    const resetParams = { requestId: rid(), sessionId: created.sessionId }
    const reset = await c.call('session.resetTitle', resetParams)
    expect(reset).toMatchObject({ title: '我的任务', titleSource: 'default' })
    const afterReset = currentSeq(db)
    expect(await c.call('session.resetTitle', resetParams)).toEqual(reset)
    expect(currentSeq(db)).toBe(afterReset)
    await until(() => c.notifications.filter(n => n.params.type === 'session.updated').length === 2)
    expect(c.notifications.filter(n => n.params.type === 'session.updated')).toMatchObject([
      { params: { payload: renamed } },
      { params: { payload: reset } },
    ])
    await until(() => watcher.notifications.filter(n => n.params.type === 'session.updated').length === 2)
    expect(watcher.notifications.filter(n => n.params.type === 'session.updated')).toEqual(c.notifications.filter(n => n.params.type === 'session.updated'))
    expect((await c.call('session.list')).sessions).toEqual([reset])
    for (const title of [' \n ', '字'.repeat(61)]) {
      await expect(c.call('session.rename', { requestId: rid(), sessionId: created.sessionId, title })).rejects.toMatchObject({ code: 'invalid_params' })
    }
    await expect(c.call('session.rename', { requestId: rid(), sessionId: 'missing', title: '任务' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(c.call('session.resetTitle', { requestId: rid(), sessionId: 'missing' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(c.call('session.setTitle', { requestId: rid(), title: '任务' })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('UI generation has no session association, populates main and preserves prompt', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'n', kind: 'image', x: 0, y: 0, w: 320, h: 320, prompt: '屋顶花园' }] })
    const [node] = (await c.call('canvas.get')).nodes
    const main = node.slots.find((s: { slotKey: string }) => s.slotKey === 'main')
    const prompt = node.slots.find((s: { slotKey: string }) => s.slotKey === 'prompt')
    const { jobId } = await c.call('generation.submit', {
      requestId: rid(), kind: 'image', prompt: '屋顶花园',
      inputs: [{ slotId: prompt.slotId }], targets: [{ outputIndex: 0, kind: 'slot', slotId: main.slotId }],
    })
    const db = studiod.spaces.get(spaceId)!.db
    expect(db.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()).toMatchObject({ sessionId: null, turnId: null, inputSnapshotId: null })
    let view = await c.call('generation.get', { jobId, waitMs: 5000 })
    for (let i = 0; i < 5 && view.status !== 'succeeded'; i++) view = await c.call('generation.get', { jobId, waitMs: 5000 })
    expect(view).toMatchObject({ status: 'succeeded', outputs: [{ delivery: { status: 'delivered', slotId: main.slotId } }] })
    expect((await c.call('canvas.get')).nodes[0].slots).toMatchObject([
      { slotKey: 'main', content: { type: 'asset' } },
      { slotKey: 'prompt', revision: 1, content: { type: 'text', body: '屋顶花园' } },
    ])
    // The turn snapshot view still puts main first when reference order is the reverse of slot order.
    const { sessionId } = await c.call('session.create', { requestId: rid(), title: '检查生成结果' })
    await c.call('session.sendMessage', { requestId: rid(), sessionId, text: '检查', refs: [prompt, main].map(slot => ({ nodeId: node.nodeId, slotId: slot.slotId, versionPolicy: 'latest-at-execution' })) })
    await until(() => dispatched.length === 1)
    const a = await agent(dispatched[0]!.token)
    expect((await a.call('canvas.get', { snapshot: 'turn' })).nodes[0].slots.map((slot: { slotKey: string }) => slot.slotKey)).toEqual(['main', 'prompt'])
  })

  it('denies space operations before subscribing; subscription returns a snapshot followed by events', async () => {
    const c = await ui()
    await expect(c.call('canvas.get')).rejects.toMatchObject({ code: 'busy' })

    const sub = await c.call('events.subscribe', { spaceId })
    expect(sub).toEqual({ reset: true, seq: 0, snapshot: { nodes: [], sessions: [], activeJobs: [], activeMediaTasks: [], activeScriptBatches: [], workItems: [] } })

    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'n', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: '旁白' } }] })
    await until(() => c.notifications.some(n => n.params.type === 'node.created'))
    const seqs = c.notifications.map(n => n.params.seq!)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('cursors before the upgrade boundary fetch the current snapshot; old requests cannot be replayed or executed again', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const params = { requestId: rid(), title: '升级前工作区' }
    const created = await c.call('work.create', params)
    const host = studiod.spaces.get(spaceId)!
    const { changeCount: _count, lastChangeSeq: _last, ...fields } = created.item
    const legacy = { ...created, item: { ...fields, frameNodeId: null, frameNodeCount: null } }
    host.db.update(s.idempotencyKeys).set({ result: legacy }).where(eq(s.idempotencyKeys.requestId, params.requestId)).run()
    host.db.update(s.events).set({ payload: legacy.item }).where(eq(s.events.type, 'work.itemChanged')).run()
    const eventSeq = currentSeq(host.db)
    const { rowid } = host.db.$client.prepare('SELECT max(rowid) AS rowid FROM idempotency_keys').get() as { rowid: number }
    host.db.update(s.contractMigrations).set({ eventSeq, idempotencyRowid: rowid }).where(eq(s.contractMigrations.id, '0010')).run()

    const reconnected = await ui()
    const snapshot = await reconnected.call('events.subscribe', { spaceId, afterSeq: eventSeq - 1 })
    expect(snapshot.reset).toBe(true)
    expect(METHODS['events.subscribe'].result.safeParse(snapshot).success).toBe(true)
    expect(snapshot.snapshot.workItems).toEqual([expect.objectContaining({ workItemId: created.item.workItemId, changeCount: 0, lastChangeSeq: null })])
    const before = currentSeq(host.db)
    await expect(reconnected.call('work.create', params)).rejects.toMatchObject({ code: 'request_not_replayable' })
    expect(currentSeq(host.db)).toBe(before)
    expect(host.db.select().from(s.workItems).all()).toHaveLength(1)
    expect(host.db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, params.requestId)).get()!.result).toEqual(legacy)
    expect(host.db.select().from(s.events).where(eq(s.events.type, 'work.itemChanged')).all().map(event => event.payload)).toEqual([legacy.item])
    expect(await reconnected.call('events.subscribe', { spaceId, afterSeq: eventSeq })).toMatchObject({ reset: true })
    await c.call('work.create', { requestId: rid(), title: '升级后工作区' })
    await until(() => reconnected.notifications.some(n => n.params.type === 'work.itemChanged'))
    expect(reconnected.notifications.every(n => n.params.seq! > eventSeq)).toBe(true)
    expect(await reconnected.call('events.subscribe', { spaceId, afterSeq: currentSeq(host.db) })).toEqual({ reset: false })
    c.close()
    reconnected.close()
  })

  it('UI undo and redo emit full content events via RPC without duplicate events on retry', async () => {
    const c = await ui()
    await expect(c.call('canvas.undo', { requestId: rid() })).rejects.toMatchObject({ code: 'busy' })
    await expect(c.call('canvas.redo', { requestId: rid() })).rejects.toMatchObject({ code: 'busy' })
    await c.call('events.subscribe', { spaceId })
    await expect(c.call('canvas.undo')).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(c.call('canvas.redo', { requestId: '' })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(await c.call('canvas.undo', { requestId: rid() })).toEqual({ nothing: true })
    expect(await c.call('canvas.redo', { requestId: rid() })).toEqual({ nothing: true })

    const created = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'n', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: '初稿' } }] })
    const [node] = (await c.call('canvas.get')).nodes
    const slotId = node.slots[0].slotId
    await c.call('canvas.apply', { requestId: rid(), description: '编辑正文', ops: [{ op: 'slot.setText', slotId, body: '定稿', expectedRevision: 1 }] })
    await until(() => c.notifications.length === 2)
    const undoParams = { requestId: rid() }
    const undone = await c.call('canvas.undo', undoParams)
    expect(undone).toEqual({ operationId: undoParams.requestId, description: '撤销：编辑正文' })
    await until(() => c.notifications.length === 3)
    expect(c.notifications[2]).toMatchObject({ method: 'events.event', params: {
      type: 'slot.revised',
      payload: { nodeId: created.idMap.n, slotId, revision: 3, slot: { slotId, revision: 3, content: { type: 'text', body: '初稿' } } },
    } })
    expect(await c.call('canvas.undo', undoParams)).toEqual(undone)
    expect(c.notifications).toHaveLength(3)

    const redone = await c.call('canvas.redo', { requestId: rid() })
    expect(redone.description).toBe('重做：编辑正文')
    await until(() => c.notifications.length === 4)
    expect(c.notifications[3]).toMatchObject({ params: {
      type: 'slot.revised',
      payload: { revision: 4, slot: { revision: 4, content: { type: 'text', body: '定稿' } } },
    } })
    expect((await c.call('canvas.get')).nodes[0].slots[0]).toMatchObject({ revision: 4, content: { body: '定稿' } })
    expect(c.notifications.map(n => n.params.seq)).toEqual([1, 2, 3, 4])

    await c.call('canvas.undo', { requestId: rid() })
    await c.call('canvas.undo', { requestId: rid() })
    await until(() => c.notifications.length === 6)
    expect(c.notifications[5]).toMatchObject({ params: { type: 'node.deleted', payload: { nodeId: node.nodeId } } })
    expect((await c.call('canvas.get')).nodes).toEqual([])
    await c.call('canvas.redo', { requestId: rid() })
    await until(() => c.notifications.length === 7)
    expect(c.notifications[6]).toMatchObject({ params: { type: 'node.created', payload: {
      nodeId: node.nodeId, slots: [{ slotId, revision: 5, content: { type: 'text', body: '初稿' } }],
    } } })
  })

  it('reconnects with a cursor: sends only subsequent events without resending the snapshot', async () => {
    const a = await ui()
    await a.call('events.subscribe', { spaceId })
    await a.call('session.create', { requestId: rid(), title: '分镜' })
    await until(() => a.notifications.length > 0)
    const cursor = a.notifications.at(-1)!.params.seq!
    a.close()

    const writer = await ui()
    await writer.call('events.subscribe', { spaceId })
    await writer.call('session.create', { requestId: rid(), title: '配音' })

    const b = await ui()
    expect(await b.call('events.subscribe', { spaceId, afterSeq: cursor })).toEqual({ reset: false })
    await until(() => b.notifications.some(n => n.params.type === 'session.created'))
    expect(b.notifications.every(n => n.params.seq! > cursor)).toBe(true)
  })

  it('parameter validation, unknown methods and caller permissions', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    await expect(c.call('canvas.apply', { requestId: rid(), ops: [] })).rejects.toMatchObject({ code: 'invalid_params' })
    expect((await c.raw('canvas.nope', {})).error?.code).toBe(-32601)
    await expect(c.call('capabilities.list')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(c.call('events.subscribe', { spaceId: 'spc_missing' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('Agent', () => {
  async function startTurn() {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const { idMap } = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'n', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: 'v1' } }] })
    const nodeId = idMap.n as string
    const { sessionId } = await c.call('session.create', { requestId: rid(), title: '分镜' })
    await c.call('session.resetTitle', { requestId: rid(), sessionId })
    await c.call('session.sendMessage', { requestId: rid(), sessionId, text: '写得更紧凑', refs: [{ nodeId, versionPolicy: 'latest-at-execution' }] })
    await until(() => dispatched.length === 1)
    return { ui: c, nodeId, sessionId, turn: dispatched[0]! }
  }

  it('guide.get returns the guide index and a requested guide for an Agent', async () => {
    const { ui: c, turn } = await startTurn()
    const a = await agent(turn.token)
    try {
      const index = await a.call('guide.get')
      expect(index.guide).toBeUndefined()
      expect(index.topics.map((entry: { topic: string }) => entry.topic)).toEqual(GuideTopic.options)
      for (const entry of index.topics) {
        expect(entry.title.trim().length).toBeGreaterThan(0)
        expect(entry.when.trim().length).toBeGreaterThan(0)
      }
      const result = await a.call('guide.get', { topic: 'script' })
      expect(result.topics).toEqual(index.topics)
      expect(result.guide).toMatchObject({ topic: 'script', title: index.topics[0].title })
      expect(result.guide.body.trim().length).toBeGreaterThan(0)
    } finally {
      a.close()
      c.close()
    }
  })

  it('guide.get rejects unknown topics through parameter validation', async () => {
    const { ui: c, turn } = await startTurn()
    const a = await agent(turn.token)
    try {
      expect((await a.raw('guide.get', { topic: 'unknown' })).error).toMatchObject({
        data: { code: 'invalid_params', reason: 'runtime.invalid_params' },
      })
    } finally {
      a.close()
      c.close()
    }
  })

  it('guide.get refuses UI callers for both the index and a guide', async () => {
    const c = await ui()
    try {
      for (const params of [{}, { topic: 'script' }]) {
        await expect(c.call('guide.get', params)).rejects.toMatchObject({
          code: 'forbidden', rpc: { data: { reason: 'runtime.caller_forbidden', params: { method: 'guide.get', caller: 'ui' } } },
        })
      }
    } finally { c.close() }
  })

  it.each([
    { op: 'script.patch', ops: [{ kind: 'doc.set', rev: 0, fields: {} }], topic: 'script' },
    { op: 'script.replace', expectedRevision: 1, doc: { shots: [], assets: [] }, topic: 'script' },
    { op: 'timeline.set', expectedRevision: 1, doc: { version: 1, tracks: [] }, topic: 'timeline' },
  ])('canvas.apply schema errors for $op include a guide hint and preserve error metadata', async ({ topic, ...op }) => {
    const c = await ui()
    try {
      const detail = 'ops.0.slotId: Invalid input: expected string, received number'
      expect((await c.raw('canvas.apply', { requestId: rid(), ops: [{ ...op, slotId: 0 }] })).error).toMatchObject({
        message: `${detail}. See guide "${topic}".`,
        data: { code: 'invalid_params', reason: 'runtime.invalid_params', params: { detail } },
      })
    } finally { c.close() }
  })

  it('canvas.apply schema errors only point to guides for the invalid operations', async () => {
    const c = await ui()
    try {
      const detail = 'ops.0.nodeId: Invalid input: expected string, received number'
      expect((await c.raw('canvas.apply', { requestId: rid(), ops: [
        { op: 'node.delete', nodeId: 0 },
        { op: 'script.replace', slotId: 'script-slot', expectedRevision: 1, doc: { shots: [], assets: [] } },
      ] })).error).toMatchObject({
        message: detail,
        data: { code: 'invalid_params', reason: 'runtime.invalid_params', params: { detail } },
      })
    } finally { c.close() }
  })

  it('canvas.apply schema errors include each relevant guide once in a mixed invalid batch', async () => {
    const c = await ui()
    try {
      const detail = [0, 1, 2].map(index => `ops.${index}.slotId: Invalid input: expected string, received number`).join('; ')
      expect((await c.raw('canvas.apply', { requestId: rid(), ops: [
        { op: 'script.patch', slotId: 0, ops: [{ kind: 'doc.set', rev: 0, fields: {} }] },
        { op: 'script.replace', slotId: 0, expectedRevision: 1, doc: { shots: [], assets: [] } },
        { op: 'timeline.set', slotId: 0, expectedRevision: 1, doc: { version: 1, tracks: [] } },
      ] })).error).toMatchObject({
        message: `${detail}. See guide "script". See guide "timeline".`,
        data: { code: 'invalid_params', reason: 'runtime.invalid_params', params: { detail } },
      })
    } finally { c.close() }
  })

  it('forwards runtime approvals to the UI, denies Agent self-approval and preserves pending counts in reconnect snapshots', async () => {
    const { ui: c, sessionId, turn } = await startTurn()
    const a = await agent(turn.token)
    const outcome = turn.requestApproval({ sessionId, turnId: turn.turnId, kind: 'command', summary: '创建导出目录', detail: 'mkdir -p exports', cwd: '/workspace' })
    const item = (await c.call('session.getTranscript', { sessionId })).items.find((item: { kind: string }) => item.kind === 'approval')
    expect(item.payload.status).toBe('pending')
    const reconnected = await ui()
    const snapshot = await reconnected.call('events.subscribe', { spaceId })
    expect(snapshot.snapshot.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId)).toMatchObject({ pendingApprovals: 1 })
    const params = { requestId: rid(), approvalId: item.itemId, decision: 'allow_session' }
    await expect(a.call('session.respondApproval', params)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(c.call('session.respondApproval', { ...params, decision: 'unknown' })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(await c.call('session.respondApproval', params)).toEqual({ status: 'approved' })
    await expect(outcome).resolves.toBe('allow_session')
    const updated = await c.call('session.getTranscript', { sessionId })
    expect(updated.items.find((entry: { itemId: string }) => entry.itemId === item.itemId)).toMatchObject({ revision: 2, payload: { status: 'approved' } })
    expect((await c.call('session.list')).sessions.find((s: { sessionId: string }) => s.sessionId === sessionId)).toMatchObject({ pendingApprovals: 0 })
    const otherSpace = studiod.spaces.create('其他空间').spaceId
    await reconnected.call('events.subscribe', { spaceId: otherSpace })
    await expect(reconnected.call('session.respondApproval', { ...params, requestId: rid() })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('only names the token session, protects manual names and allows renaming after restoration', async () => {
    const { ui: c, sessionId, turn } = await startTurn()
    const a = await agent(turn.token)
    const watcher = await ui()
    await watcher.call('events.subscribe', { spaceId })
    const other = await c.call('session.create', { requestId: rid(), title: '其他会话' })
    await expect(a.call('session.rename', { requestId: rid(), sessionId, title: '不允许' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('session.resetTitle', { requestId: rid(), sessionId })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('session.setTitle', { requestId: rid(), sessionId: other.sessionId, title: '越权' })).rejects.toMatchObject({ code: 'invalid_params' })
    for (const title of [' \n ', '字'.repeat(25)]) {
      await expect(a.call('session.setTitle', { requestId: rid(), title })).rejects.toMatchObject({ code: 'invalid_params' })
    }
    const db = studiod.spaces.get(spaceId)!.db
    const params = { requestId: rid(), title: '  海报任务  ' }
    const result = await a.call('session.setTitle', params)
    expect(result).toEqual({ applied: true, title: '海报任务' })
    const afterTitle = currentSeq(db)
    expect(await a.call('session.setTitle', params)).toEqual(result)
    expect(await a.call('session.setTitle', { requestId: rid(), title: '海报任务' })).toEqual(result)
    expect(currentSeq(db)).toBe(afterTitle)
    expect((await c.call('session.list')).sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId, title: '海报任务', titleSource: 'agent' }),
      expect.objectContaining({ sessionId: other.sessionId, title: '其他会话', titleSource: 'user' }),
    ]))
    await until(() => watcher.notifications.some(n => n.params.type === 'session.updated'))
    const titleEvent = watcher.notifications.find(n => n.params.type === 'session.updated')
    expect(titleEvent).toMatchObject({ params: { payload: { sessionId, title: '海报任务', titleSource: 'agent' } } })
    expect(c.notifications).toContainEqual(titleEvent)
    await c.call('session.rename', { requestId: rid(), sessionId, title: '用户标题' })
    const protectedParams = { requestId: rid(), title: 'Agent 改名' }
    const afterUser = currentSeq(db)
    expect(await a.call('session.setTitle', protectedParams)).toEqual({ applied: false, reason: 'user_named', title: '用户标题' })
    expect(currentSeq(db)).toBe(afterUser)
    await c.call('session.resetTitle', { requestId: rid(), sessionId })
    expect(await a.call('session.setTitle', protectedParams)).toEqual({ applied: false, reason: 'user_named', title: '用户标题' })
    expect(await a.call('session.setTitle', { requestId: rid(), title: '重新自动命名' })).toEqual({ applied: true, title: '重新自动命名' })
  })

  it('rejects initial naming and idempotent replay when the runtime instance remains but the turn has ended', async () => {
    const { turn } = await startTurn()
    const a = await agent(turn.token)
    const params = { requestId: rid(), title: '有效回合标题' }
    await a.call('session.setTitle', params)
    const db = studiod.spaces.get(spaceId)!.db
    db.update(s.turns).set({ status: 'completed' }).where(eq(s.turns.id, turn.turnId)).run()
    expect(db.select().from(s.agentInstances).where(eq(s.agentInstances.id, turn.instanceId)).get()?.status).toBe('ready')
    await expect(a.call('session.setTitle', params)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('session.setTitle', { requestId: rid(), title: '迟到标题' })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('allows script patches in plain project sessions only while the turn remains active and preserves snapshots', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const created = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'script', kind: 'script' }] })
    const nodeId = created.idMap.script
    const slot = (await c.call('canvas.get', { nodeIds: [nodeId] })).nodes[0].slots[0]
    const session = await c.call('session.create', { requestId: rid() })
    const host = studiod.spaces.get(spaceId)!
    host.db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, session.sessionId)).run()
    await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Write the script', refs: [{ nodeId, slotId: slot.slotId, versionPolicy: 'latest-at-execution' }] })
    await until(() => dispatched.length === 1)
    const a = await agent(dispatched[0]!.token)
    const undoCount = host.db.select().from(s.undoEntries).all().length
    const params = { requestId: rid(), ops: [{ op: 'script.patch', slotId: slot.slotId, ops: [{ kind: 'shot.insert', tempId: 'one', afterShotId: null, shot: { description: 'A still platform' } }] }] }
    await a.call('canvas.apply', params)
    const current = (await a.call('canvas.get', {})).nodes.find((node: { nodeId: string }) => node.nodeId === nodeId)
    expect(current.slots[0]).toMatchObject({ revision: 2, content: { type: 'script', doc: { shots: [{ description: 'A still platform' }] } } })
    expect((await a.call('canvas.get', { snapshot: 'turn' })).nodes[0].slots[0]).toMatchObject({ revision: 1, content: { type: 'script', doc: { shots: [] } } })
    expect(host.db.select().from(s.undoEntries).all()).toHaveLength(undoCount)
    const shot = current.slots[0].content.doc.shots[0]
    const conflict = await a.raw('canvas.apply', { requestId: rid(), ops: [{ op: 'script.patch', slotId: slot.slotId, ops: [{ kind: 'shot.delete', shotId: shot.id, rev: 0 }] }] })
    expect(conflict.error?.data).toMatchObject({ code: 'revision_conflict', reason: 'script.revision_conflict', params: { currentRows: JSON.stringify([{ kind: 'shot', id: shot.id, current: shot }]) } })
    host.db.update(s.turns).set({ status: 'completed' }).where(eq(s.turns.id, dispatched[0]!.turnId)).run()
    await expect(a.call('canvas.apply', params)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('canvas.apply', { ...params, requestId: rid() })).rejects.toMatchObject({ code: 'forbidden' })
    a.close()
    c.close()
  })

  it('reads turn snapshots by token: subsequent edits do not affect this turn', async () => {
    const { ui: c, nodeId, turn } = await startTurn()
    const slotId = (await c.call('canvas.get', { nodeIds: [nodeId] })).nodes[0].slots[0].slotId
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'slot.setText', slotId, body: 'v2', expectedRevision: 1 }] })

    const a = await agent(turn.token)
    expect((await a.call('canvas.get', { snapshot: 'turn' })).nodes[0].slots[0]).toMatchObject({ revision: 1, content: { body: 'v1' } })
    expect((await a.call('canvas.get', {})).nodes[0].slots[0]).toMatchObject({ revision: 2, content: { body: 'v2' } })
    await expect(c.call('canvas.get', { snapshot: 'turn' })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('UI and Agents can paginate slot history in their space', async () => {
    const { ui: c, nodeId, turn } = await startTurn()
    const slotId = (await c.call('canvas.get', { nodeIds: [nodeId] })).nodes[0].slots[0].slotId
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId, format: 'code' }] })
    const a = await agent(turn.token)
    await a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'slot.setText', slotId, body: 'v2', expectedRevision: 1 }] })
    const history = await c.call('slot.history', { slotId })
    expect(await a.call('slot.history', { slotId })).toEqual(history)
    expect(history).toMatchObject({ versions: [
      { revision: 2, content: { type: 'text', body: 'v2' }, actor: 'agent', isCurrent: true },
      { revision: 1, content: { type: 'text', body: 'v1' }, actor: 'user', isCurrent: false },
    ], hasMore: false })
    expect(await a.call('slot.history', { slotId, limit: 1 })).toMatchObject({ versions: [{ revision: 2 }], hasMore: true })
    expect(await a.call('slot.history', { slotId, beforeRevision: 2 })).toMatchObject({ versions: [{ revision: 1 }], hasMore: false })
    expect(await a.call('slot.history', { slotId, includeDeleted: false })).toEqual(history)
    await expect(a.call('slot.history', { slotId, includeDeleted: true })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await a.call('capabilities.list')).capabilities).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'slot.history', command: 'slot history' })]))
    expect(await a.call('capabilities.describe', { method: 'slot.history' })).toMatchObject({ method: 'slot.history', params: { properties: { limit: { default: 50, maximum: 200 } } } })
    await expect(c.call('slot.history', { slotId, limit: 201 })).rejects.toMatchObject({ code: 'invalid_params' })
    const other = await ui()
    await other.call('events.subscribe', { spaceId: studiod.spaces.create('其他空间').spaceId })
    await expect(other.call('slot.history', { slotId })).rejects.toMatchObject({ code: 'not_found' })
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.delete', nodeId }] })
    await expect(c.call('slot.history', { slotId })).rejects.toMatchObject({ code: 'not_found' })
    expect(await c.call('slot.history', { slotId, includeDeleted: true })).toEqual(history)
    await expect(a.call('slot.history', { slotId, includeDeleted: true })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(other.call('slot.history', { slotId, includeDeleted: true })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('Agents cannot call UI methods; generation submissions are associated with the turn', async () => {
    const { turn } = await startTurn()
    const a = await agent(turn.token)
    await expect(a.call('session.list')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('session.agentOptions', { sessionId: turn.sessionId })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('session.setAgentConfig', { requestId: rid(), sessionId: turn.sessionId, model: null, effort: null, serviceTier: null })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('events.subscribe', { spaceId })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('canvas.undo', { requestId: rid() })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('canvas.redo', { requestId: rid() })).rejects.toMatchObject({ code: 'forbidden' })
    const { capabilities } = await a.call('capabilities.list')
    expect(capabilities.map((c: { command: string }) => c.command)).toEqual(expect.arrayContaining(['canvas get', 'gen submit', 'gen get']))
    expect(capabilities.filter((c: { method: string }) => c.method.startsWith('session.'))).toEqual([
      expect.objectContaining({ method: 'session.setTitle', command: 'session set title' }),
    ])
    expect(capabilities.some((c: { method: string }) => c.method === 'canvas.undo' || c.method === 'canvas.redo')).toBe(false)
    await expect(a.call('capabilities.describe', { method: 'session.list' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(a.call('capabilities.describe', { method: 'canvas.undo' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(a.call('capabilities.describe', { method: 'canvas.redo' })).rejects.toMatchObject({ code: 'not_found' })

    const { jobId } = await a.call('generation.submit', { requestId: rid(), kind: 'image', prompt: '屋顶花园' })
    const job = studiod.spaces.get(spaceId)!.db.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()
    expect(job).toMatchObject({ sessionId: turn.sessionId, turnId: turn.turnId, inputSnapshotId: turn.inputSnapshotId })
    // Each status change returns waitMs early; loop as vis gen wait does.
    let view = await a.call('generation.get', { jobId, waitMs: 5000 })
    for (let i = 0; i < 5 && view.status !== 'succeeded'; i++) view = await a.call('generation.get', { jobId, waitMs: 5000 })
    expect(view).toMatchObject({ status: 'succeeded', outputs: [{ delivery: { status: 'delivered' } }] })
  })

  it('Agents can only cancel jobs in their own session', async () => {
    const { ui: c, turn } = await startTurn()
    const a = await agent(turn.token)
    const foreign = await c.call('generation.submit', { requestId: rid(), kind: 'image', prompt: '其他任务' })
    await expect(a.call('generation.cancel', { requestId: rid(), jobId: foreign.jobId })).rejects.toMatchObject({ code: 'forbidden' })
    const own = await a.call('generation.submit', { requestId: rid(), kind: 'image', prompt: '本会话任务' })
    expect(await a.call('generation.cancel', { requestId: rid(), jobId: own.jobId })).toMatchObject({ status: 'cancelled' })
    await expect(c.call('generation.cancel', { requestId: rid(), jobId: own.jobId })).rejects.toMatchObject({ code: 'job_terminal' })
  })

  it('Agents retain a session notice when hitting the daily quota', async () => {
    const { turn } = await startTurn()
    const a = await agent(turn.token)
    const host = studiod.spaces.get(spaceId)!
    const params = { kind: 'image' as const, count: 50, limit: 50 }
    vi.spyOn(host.generation, 'submit').mockImplementation(() => { throw VisError.of('quota_exceeded', 'generation.daily_limit', params, 'Daily quota exhausted', undefined, params) })
    expect((await a.raw('generation.submit', { requestId: rid(), kind: 'image', prompt: '超额' })).error).toMatchObject({
      message: 'Daily quota exhausted',
      data: { code: 'quota_exceeded', reason: 'generation.daily_limit', params, kind: 'image', count: 50, limit: 50 },
    })
    const notices = host.db.select().from(s.transcriptEntries).all().filter(row => row.kind === 'notice')
    expect(notices).toEqual(expect.arrayContaining([expect.objectContaining({
      sessionId: turn.sessionId,
      payload: { code: 'quota_exceeded', message: 'Daily quota exhausted', reason: 'generation.daily_limit', params },
    })]))
  })

  it('tokens expire after the turn ends: existing connections reject calls and new handshakes fail', async () => {
    const { turn } = await startTurn()
    const a = await agent(turn.token)
    turn.end()
    await expect(a.call('canvas.get', {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('slot.history', { slotId: 'any' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('session.setTitle', { requestId: rid(), title: '迟到标题' })).rejects.toMatchObject({ code: 'forbidden' })
    const b = await client()
    expect((await b.raw('runtime.hello', { protocolVersion: PROTOCOL_VERSION, credential: { kind: 'agent', token: turn.token } })).error?.data?.code).toBe('forbidden')
  })

  it('streams text only to UI clients subscribed to the space', async () => {
    const { ui: c, sessionId, turn } = await startTurn()
    const other = await ui()
    const otherSpace = studiod.spaces.create('别的空间').spaceId
    await other.call('events.subscribe', { spaceId: otherSpace })
    turn.stream({ sessionId, itemId: 'cx:t1:m0', revision: 1, delta: '写' })
    await until(() => c.notifications.some(n => n.method === 'events.transient'))
    expect(c.notifications.find(n => n.method === 'events.transient')!.params).toEqual({ sessionId, itemId: 'cx:t1:m0', revision: 1, delta: '写' })
    expect(other.notifications.some(n => n.method === 'events.transient')).toBe(false)
  })

  it('runtime.activity counts active turns and generation jobs', async () => {
    const { ui: c, turn } = await startTurn()
    expect(await c.call('runtime.activity')).toEqual({ activeTurns: 1, activeJobs: 0 })
    turn.end()
    await until(() => studiod.gateway.activity().activeTurns === 0)
  })
})

describe('Work item gateway', () => {
  it.each([false, true])('routes an unreported child notice to the parent main session or the inbox when archived=%s', async archived => {
    const c = await ui()
    let parentAgent: Awaited<ReturnType<typeof agent>> | undefined
    try {
      await c.call('events.subscribe', { spaceId })
      const parent = (await c.call('work.create', { requestId: rid(), title: 'Unreported parent', chat: { agentKind: 'codex' } })).item
      const db = studiod.spaces.get(spaceId)!.db
      db.insert(s.sessions).values({ id: 'later-parent-session', workItemId: parent.workItemId, agentKind: 'codex', title: 'Later parent', workDir: parent.workDir, createdAt: Date.now() + 100 }).run()
      const child = (await c.call('work.dispatch', { requestId: rid(), parentId: parent.workItemId, title: 'Unreported child', brief: 'Finish the assigned work', agentKind: 'codex' })).item
      await until(() => dispatched.some(turn => turn.sessionId === child.sessions[0].sessionId))
      const childTurn = dispatched.find(turn => turn.sessionId === child.sessions[0].sessionId)!
      if (archived) {
        db.update(s.workItems).set({ archivedAt: Date.now() }).where(eq(s.workItems.id, parent.workItemId)).run()
        db.update(s.sessions).set({ archivedAt: Date.now() }).where(eq(s.sessions.workItemId, parent.workItemId)).run()
      }
      childTurn.report({ type: 'item', sessionId: childTurn.sessionId, turnId: childTurn.turnId, itemId: 'unreported-final', revision: 1, kind: 'assistant_text', payload: { text: 'Which option should I use?' } })
      childTurn.end()
      const detail = await c.call('work.get', { workItemId: child.workItemId })
      const notice = detail.messages.find((message: { kind: string }) => message.kind === 'failure')
      expect(notice).toMatchObject({ from: { kind: 'system', failure: { reason: 'turn_unreported' } } })
      expect(detail.item).toMatchObject({ status: 'in_progress', activity: 'idle', failure: { reason: 'turn_unreported' } })
      expect(notice.body).toContain('Which option should I use?')
      const stored = db.select().from(s.workMessages).where(eq(s.workMessages.id, notice.messageId)).get()!
      if (archived) {
        expect(stored.targetSessionId).toBeNull()
        expect(dispatched.filter(turn => turn.sessionId === parent.sessions[0].sessionId)).toHaveLength(0)
        const inbox = await c.call('work.inbox')
        expect(inbox.groups[0].items.find((item: { workItemId: string }) => item.workItemId === child.workItemId).messages).toEqual(expect.arrayContaining([expect.objectContaining({ messageId: notice.messageId })]))
      } else {
        expect(stored.targetSessionId).toBe(parent.sessions[0].sessionId)
        await until(() => dispatched.some(turn => turn.sessionId === parent.sessions[0].sessionId))
        const parentTurn = dispatched.find(turn => turn.sessionId === parent.sessions[0].sessionId)!
        expect(parentTurn.text).toContain(notice.body)
        expect(dispatched.filter(turn => turn.sessionId === 'later-parent-session')).toHaveLength(0)
        parentAgent = await agent(parentTurn.token)
        await expect(parentAgent.call('work.reply', { requestId: rid(), workItemId: child.workItemId, replyTo: notice.messageId, body: 'Use option A' })).rejects.toMatchObject({ code: 'invalid_params' })
        await parentAgent.call('work.reply', { requestId: rid(), workItemId: child.workItemId, body: 'Use option A' })
        await until(() => dispatched.filter(turn => turn.sessionId === childTurn.sessionId).length === 2)
        const resumed = dispatched.filter(turn => turn.sessionId === childTurn.sessionId).at(-1)!
        expect(resumed.text).toContain('Use option A')
        expect((await c.call('work.get', { workItemId: child.workItemId })).item.failure).toBeNull()
      }
    } finally { parentAgent?.close(); c.close() }
  })

  async function runningAgent(c: Awaited<ReturnType<typeof ui>>, targetSpaceId: string, sessionId: string) {
    await c.call('events.subscribe', { spaceId: targetSpaceId })
    await c.call('session.sendMessage', { requestId: rid(), sessionId, text: '执行工作', refs: [] })
    await until(() => dispatched.some(turn => turn.sessionId === sessionId))
    return agent(dispatched.find(turn => turn.sessionId === sessionId)!.token)
  }

  async function workAgent() {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const { item } = await c.call('work.create', { requestId: rid(), title: '共享画布任务', chat: { agentKind: 'codex' } })
    const sessionId = item.sessions[0].sessionId
    const a = await runningAgent(c, spaceId, sessionId)
    const created = await c.call('canvas.apply', { requestId: rid(), ops: [
      { op: 'frame.create', tempId: 'ordinary', title: '普通框', x: 0, y: 0, w: 1000, h: 1000 },
      { op: 'node.create', tempId: 'inside', kind: 'text', x: 50, y: 50, w: 100, h: 100, content: { text: '内部' } },
      { op: 'node.create', tempId: 'outside', kind: 'text', x: 2000, y: 50, w: 100, h: 100, content: { text: '外部标题' } },
      { op: 'node.create', tempId: 'other', kind: 'text', x: 2200, y: 50, w: 100, h: 100, content: { text: '另一个节点' } },
      { op: 'node.create', tempId: 'image', kind: 'image', x: 2500, y: 50, w: 100, h: 100 },
    ] })
    const host = studiod.spaces.get(spaceId)!
    const approvals = () => host.sessions.getTranscript({ sessionId }).items.filter(item => item.kind === 'approval')
    return { c, a, sessionId, host, ids: created.idMap, approvals }
  }

  it('0032: child text including code stays working, promotion is refused atomically, and parents and users can promote it', async () => {
    const { c, a: parent } = await workAgent()
    const child = (await parent.call('work.dispatch', { requestId: rid(), title: 'Child review', brief: 'Read the draft', agentKind: 'codex' })).item
    await until(() => dispatched.some(turn => turn.sessionId === child.sessions[0].sessionId))
    const a = await agent(dispatched.find(turn => turn.sessionId === child.sessions[0].sessionId)!.token)
    const initialNodeCount = (await c.call('canvas.get', {})).nodes.length
    const created = await a.call('canvas.apply', { requestId: rid(), ops: [
      { op: 'node.create', tempId: 'plain', kind: 'text', content: { text: 'Review notes' } },
      { op: 'node.create', tempId: 'code', kind: 'text', format: 'code', purpose: 'artifact', content: { text: '<html>Animation</html>' } },
      { op: 'node.create', tempId: 'image', kind: 'image' },
      { op: 'node.create', tempId: 'video', kind: 'video' },
      { op: 'node.create', tempId: 'script', kind: 'script' },
      { op: 'node.create', tempId: 'timeline', kind: 'timeline' },
      { op: 'node.create', tempId: 'previz', kind: 'previz' },
    ] })
    const nodes = (await c.call('canvas.get', { nodeIds: Object.values(created.idMap) })).nodes
    expect(nodes.filter((node: any) => node.kind === 'text').map((node: any) => node.purpose)).toEqual(['working', 'working'])
    expect(nodes.filter((node: any) => node.kind !== 'text').every((node: any) => node.purpose === 'artifact')).toBe(true)
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId: created.idMap.code, purpose: 'artifact' }] })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'writing.child_artifact_forbidden' } } })
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'bypass', kind: 'text' }, { op: 'node.setMeta', nodeId: 'bypass', purpose: 'artifact' }] })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await c.call('canvas.get', {})).nodes).toHaveLength(nodes.length + initialNodeCount)
    await parent.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId: created.idMap.plain, purpose: 'artifact' }] })
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId: created.idMap.code, purpose: 'artifact' }] })
    expect((await c.call('canvas.get', { nodeIds: [created.idMap.plain, created.idMap.code] })).nodes.every((node: any) => node.purpose === 'artifact')).toBe(true)
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId: created.idMap.code, purpose: 'working' }] })
    const report = await a.call('work.report', { requestId: rid(), kind: 'done', body: 'Review complete' })
    const details = await c.call('work.get', { workItemId: child.workItemId })
    expect(details.messages.find((message: any) => message.messageId === report.messageId).refs.nodeIds).toEqual([created.idMap.code])
    const changes = await c.call('work.changes', { workItemId: child.workItemId })
    expect(changes.changes.some((change: any) => change.nodeId === created.idMap.code)).toBe(true)
  })

  it('deleting archives invalidates Agent tokens on existing connections and new handshakes, and broadcasts silent deletion to other projects', async () => {
    const { c, a, sessionId, host } = await workAgent()
    const token = dispatched.find(turn => turn.sessionId === sessionId)!.token
    const item = host.sessions.list({}).sessions.find(session => session.sessionId === sessionId)!.workItemId!
    const other = await ui(), otherSpace = studiod.spaces.create('观察项目').spaceId
    await other.call('events.subscribe', { spaceId: otherSpace })
    await expect(a.call('work.deletePlan', { workItemId: item })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('work.delete', { requestId: rid(), workItemId: item })).rejects.toMatchObject({ code: 'forbidden' })
    await c.call('work.delete', { requestId: rid(), workItemId: item })
    await expect(a.call('canvas.get', {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('providers.list', {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('capabilities.list', {})).rejects.toMatchObject({ code: 'forbidden' })
    const reconnect = await client()
    expect((await reconnect.raw('runtime.hello', { protocolVersion: PROTOCOL_VERSION, credential: { kind: 'agent', token } })).error?.data?.code).toBe('forbidden')
    expect(await c.call('session.list', {})).toMatchObject({ sessions: [] })
    await until(() => other.notifications.some(note => note.method === 'events.workInboxChanged'))
    const quiet = await c.call('work.create', { requestId: rid(), title: '安静待办' })
    await until(() => c.notifications.some(note => note.method === 'events.event' && (note.params as { entityId?: string }).entityId === quiet.item.workItemId))
    other.notifications.length = 0
    await c.call('work.delete', { requestId: rid(), workItemId: quiet.item.workItemId })
    await until(() => other.notifications.some(note => note.method === 'events.workInboxChanged'))
    expect(other.notifications.some(note => note.method === 'events.workSlotsChanged')).toBe(true)
    await expect(c.call('work.get', { workItemId: quiet.item.workItemId })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('Agents can edit all nodes inside and outside ordinary frames without outside-frame approvals, while revision conflicts still roll back the entire batch', async () => {
    const { c, a, host, ids, approvals } = await workAgent()
    const ops = [ids.inside, ids.outside, ids.other].map(nodeId => ({ op: 'node.layout', nodeId, z: 20 }))
    await a.call('canvas.apply', { requestId: rid(), ops })
    expect(host.canvas.get({ nodeIds: [ids.inside, ids.outside, ids.other] }).nodes.every(node => node.z === 20)).toBe(true)
    expect(approvals()).toEqual([])
    const slotId = host.canvas.get({ nodeIds: [ids.outside] }).nodes[0]!.slots[0]!.slotId
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId: ids.outside, format: 'code' }] })
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'slot.setText', slotId, expectedRevision: 1, body: '用户修改' }] })
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [
      { op: 'node.layout', nodeId: ids.inside, z: 30 },
      { op: 'slot.setText', slotId, expectedRevision: 1, body: '旧版本覆盖' },
    ] })).rejects.toMatchObject({ code: 'revision_conflict' })
    expect(host.canvas.get({ nodeIds: [ids.inside] }).nodes[0]!.z).toBe(20)
    expect(host.canvas.get({ nodeIds: [ids.outside] }).nodes[0]!.slots[0]!.content).toEqual({ type: 'text', body: '用户修改' })
    expect(approvals()).toEqual([])
  })

  it('generation can populate project nodes outside ordinary frames with version checks and no outside-frame approvals', async () => {
    const { a, host, ids, approvals, sessionId } = await workAgent()
    const item = host.sessions.list({}).sessions.find(session => session.sessionId === sessionId)!.workItemId!
    expect(host.work.get({ workItemId: item }).item.changeCount).toBe(0)
    const slotId = host.canvas.get({ nodeIds: [ids.image] }).nodes[0]!.slots[0]!.slotId
    const params = { requestId: rid(), kind: 'image', prompt: 'p', targets: [{ outputIndex: 0, kind: 'slot', slotId }] }
    const submitted = await a.call('generation.submit', params)
    expect(await a.call('generation.submit', params)).toEqual(submitted)
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(1)
    await until(() => host.db.select().from(s.generationJobs).where(eq(s.generationJobs.id, submitted.jobId)).get()?.status === 'succeeded', 5000)
    expect(await a.call('generation.get', { jobId: submitted.jobId })).toMatchObject({ status: 'succeeded', outputs: [{ delivery: { status: 'delivered', nodeId: ids.image } }], targets: [{ status: 'delivered', nodeId: ids.image }] })
    expect(host.canvas.get({ nodeIds: [ids.image] }).nodes[0]!.slots[0]!.revision).toBe(1)
    expect(approvals()).toEqual([])
    expect(host.work.get({ workItemId: item }).item.changeCount).toBe(1)
    expect(host.work.changes({ workItemId: item }).changes).toEqual([expect.objectContaining({ nodeId: ids.image, sessionId, lastSeq: expect.any(Number) })])
  })

  it('pushes doing changes at most once per second per session; continued polling delivers the final state', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const session = await c.call('session.create', { requestId: rid(), title: '节流' })
    const a = await runningAgent(c, spaceId, session.sessionId)
    const turn = dispatched.find(turn => turn.sessionId === session.sessionId)!
    const report = (name: string, revision: number) => turn.report({ type: 'item', sessionId: session.sessionId, turnId: turn.turnId, itemId: 'tool:throttle', revision, kind: 'tool_call', payload: { name, arguments: {} } })
    c.notifications.length = 0
    report('first', 1)
    await until(() => c.notifications.some(n => n.params.type === 'work.itemChanged'))
    c.notifications.length = 0
    report('second', 2)
    await a.call('capabilities.list')
    report('last', 3)
    await a.call('capabilities.list')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(c.notifications.filter(n => n.params.type === 'work.itemChanged')).toHaveLength(0)
    await until(() => c.notifications.some(n => n.params.type === 'work.itemChanged'))
    expect(c.notifications.filter(n => n.params.type === 'work.itemChanged')).toHaveLength(1)
    expect(c.notifications.find(n => n.params.type === 'work.itemChanged')).toMatchObject({ params: { payload: { sessions: [{ doing: '正在调用 last' }] } } })
  })

  it('UI can read and modify work items across projects without subscribing; snapshots return current project cards', async () => {
    const c = await ui()
    const otherSpace = studiod.spaces.create('第二项目').spaceId
    expect(await c.call('work.inbox')).toMatchObject({ groups: [], counts: { unread: 0, unresolved: 0 } })
    expect(await c.call('work.slots')).toMatchObject({ used: 0, limit: 6 })
    const first = (await c.call('work.create', { requestId: rid(), spaceId, title: '当前卡片' })).item
    const second = (await c.call('work.create', { requestId: rid(), spaceId: otherSpace, title: '后台卡片' })).item
    const all = (await c.call('work.list', { scope: 'all', status: 'todo' })).items
    expect(all).toEqual(expect.arrayContaining([
      expect.objectContaining({ workItemId: first.workItemId, spaceId, spaceName: '测试空间' }),
      expect.objectContaining({ workItemId: second.workItemId, spaceId: otherSpace, spaceName: '第二项目' }),
    ]))
    expect(all).toHaveLength(2)
    const snapshot = await c.call('events.subscribe', { spaceId })
    expect(snapshot.snapshot.workItems).toEqual([first])
    expect((await c.call('work.get', { spaceId: otherSpace, workItemId: second.workItemId })).item).toEqual(second)
    const updated = await c.call('work.update', { requestId: rid(), spaceId: otherSpace, workItemId: second.workItemId, expectedRevision: second.revision, pinned: true })
    expect(updated).toMatchObject({ pinned: true, revision: second.revision + 1 })
    expect((await c.call('work.list')).items).toEqual([first])
    expect(await c.call('work.changes', { spaceId: otherSpace, workItemId: second.workItemId })).toMatchObject({ changes: [] })
    expect(await c.call('work.markRead', { spaceId: otherSpace, workItemId: second.workItemId })).toEqual({ marked: 0 })
    await expect(c.call('work.list', { spaceId: 'missing' })).rejects.toMatchObject({ code: 'not_found' })
    const conflict = await c.raw('work.update', { requestId: rid(), spaceId: otherSpace, workItemId: second.workItemId, expectedRevision: second.revision, pinned: false })
    expect(conflict.error?.data).toMatchObject({ code: 'revision_conflict', expectedRevision: second.revision, currentRevision: updated.revision })
  })

  it('authorizes by workspace relationships with equal rights for the second session; roots cannot report and children cannot dispatch or operate on parents or siblings', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const session = await c.call('session.create', { requestId: rid(), title: '父任务' })
    const a = await runningAgent(c, spaceId, session.sessionId)
    const own = (await a.call('work.get')).item
    const unrelated = (await c.call('work.create', { requestId: rid(), title: '其他根项' })).item
    const db = studiod.spaces.get(spaceId)!.db
    db.insert(s.sessions).values({ id: 'second-root', workItemId: own.workItemId, agentKind: 'codex', title: 'Codex 2', workDir: own.workDir, createdAt: Date.now() + 10 }).run()
    const second = await runningAgent(c, spaceId, 'second-root')
    const child = (await second.call('work.dispatch', { requestId: rid(), title: '子任务', brief: '完成子任务', agentKind: 'codex', activate: false, reviewBy: 'parent' })).item
    const sibling = (await a.call('work.dispatch', { requestId: rid(), title: '兄弟任务', brief: '其他任务', agentKind: 'codex', activate: false })).item
    const denied = [unrelated.workItemId, own.workItemId]
    for (const parent of [a, second]) {
      expect((await parent.call('work.list')).items.map((item: { workItemId: string }) => item.workItemId).sort()).toEqual([own.workItemId, child.workItemId, sibling.workItemId].sort())
      expect(await parent.call('capabilities.describe', { method: 'work.report' })).toMatchObject({ method: 'work.report' })
      await expect(parent.call('work.report', { requestId: rid(), kind: 'question', body: '根项不报告' })).rejects.toMatchObject({ code: 'forbidden' })
      for (const method of ['work.create', 'work.update', 'work.markRead', 'work.move', 'work.reopen', 'work.submitReview', 'work.inbox', 'work.slots', 'work.setSlotLimit']) {
        await expect(parent.call(method)).rejects.toMatchObject({ code: 'forbidden' })
      }
      for (const method of ['work.list', 'work.get', 'canvas.get', 'canvas.apply']) await expect(parent.call(method, { spaceId })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(parent.call('work.list', { scope: 'all' })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(parent.call('work.get', { workItemId: unrelated.workItemId })).rejects.toMatchObject({ code: 'forbidden' })
      for (const workItemId of denied) {
        await expect(parent.call('work.activate', { requestId: rid(), workItemId })).rejects.toMatchObject({ code: 'forbidden' })
        await expect(parent.call('work.recall', { requestId: rid(), workItemId })).rejects.toMatchObject({ code: 'forbidden' })
        await expect(parent.call('work.reply', { requestId: rid(), workItemId, body: '越界' })).rejects.toMatchObject({ code: 'forbidden' })
        await expect(parent.call('work.review', { requestId: rid(), workItemId, decision: 'approve' })).rejects.toMatchObject({ code: 'forbidden' })
      }
    }
    await second.call('work.activate', { requestId: rid(), workItemId: child.workItemId })
    const worker = await runningAgent(c, spaceId, child.sessions[0].sessionId)
    db.insert(s.sessions).values({ id: 'second-child', workItemId: child.workItemId, agentKind: 'codex', title: 'Codex 2', workDir: child.workDir, createdAt: Date.now() + 20 }).run()
    const childSecond = await runningAgent(c, spaceId, 'second-child')
    for (const childAgent of [worker, childSecond]) {
      expect((await childAgent.call('work.list')).items.map((item: { workItemId: string }) => item.workItemId)).toEqual([child.workItemId])
      expect(await childAgent.call('capabilities.describe', { method: 'work.review' })).toMatchObject({ method: 'work.review' })
      await expect(childAgent.call('work.dispatch', { requestId: rid(), title: '嵌套', brief: '禁止', agentKind: 'codex' })).rejects.toMatchObject({ code: 'forbidden' })
      for (const workItemId of [own.workItemId, sibling.workItemId, unrelated.workItemId, child.workItemId]) {
        if (workItemId !== child.workItemId) await expect(childAgent.call('work.get', { workItemId })).rejects.toMatchObject({ code: 'forbidden' })
        await expect(childAgent.call('work.activate', { requestId: rid(), workItemId })).rejects.toMatchObject({ code: 'forbidden' })
        await expect(childAgent.call('work.recall', { requestId: rid(), workItemId })).rejects.toMatchObject({ code: 'forbidden' })
        await expect(childAgent.call('work.reply', { requestId: rid(), workItemId, body: '越界' })).rejects.toMatchObject({ code: 'forbidden' })
        await expect(childAgent.call('work.review', { requestId: rid(), workItemId, decision: 'approve' })).rejects.toMatchObject({ code: 'forbidden' })
      }
    }
    await expect(childSecond.call('work.report', { requestId: rid(), kind: 'question', body: '问', spaceId })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(childSecond.call('work.report', { requestId: rid(), kind: 'question', body: '问', workItemId: own.workItemId })).rejects.toMatchObject({ code: 'invalid_params' })
    const question = await childSecond.call('work.report', { requestId: rid(), kind: 'question', body: '需要决定' })
    expect(question).toMatchObject({ item: { workItemId: child.workItemId, unresolvedCount: 1 } })
    expect(db.select().from(s.workMessages).where(eq(s.workMessages.id, question.messageId)).get()).toMatchObject({ to: 'parent', targetSessionId: session.sessionId })
    await second.call('work.reply', { requestId: rid(), workItemId: child.workItemId, replyTo: question.messageId, body: '继续' })
    await childSecond.call('work.report', { requestId: rid(), kind: 'done', body: '已完成' })
    await expect(second.call('work.review', { requestId: rid(), workItemId: child.workItemId, decision: 'reject' })).rejects.toMatchObject({ code: 'invalid_params' })
    expect((await second.call('work.review', { requestId: rid(), workItemId: child.workItemId, decision: 'reject', feedback: '请补充' })).item.status).toBe('in_progress')
    expect((await second.call('work.recall', { requestId: rid(), workItemId: child.workItemId })).items[0].status).toBe('todo')
  })

  it('ordinary sessions without a workspace cannot call work item write operations', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const session = await c.call('session.create', { requestId: rid(), title: '旧普通会话' })
    const host = studiod.spaces.get(spaceId)!
    host.db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, session.sessionId)).run()
    const a = await runningAgent(c, spaceId, session.sessionId)
    for (const [method, params] of [
      ['work.dispatch', { requestId: rid(), title: '禁止', brief: '禁止', agentKind: 'codex', parentId: session.workItemId }],
      ['work.activate', { requestId: rid(), workItemId: session.workItemId }],
      ['work.recall', { requestId: rid(), workItemId: session.workItemId }],
      ['work.reply', { requestId: rid(), workItemId: session.workItemId, body: '禁止' }],
      ['work.review', { requestId: rid(), workItemId: session.workItemId, decision: 'approve' }],
      ['work.report', { requestId: rid(), kind: 'question', body: '禁止' }],
    ] as const) await expect(a.call(method, params)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('broadcasts background project inbox and slot changes to all UI clients without duplicate unchanged updates', async () => {
    const c = await ui()
    const observer = await ui()
    await observer.call('events.subscribe', { spaceId })
    const otherSpace = studiod.spaces.create('后台项目').spaceId
    const root = (await c.call('work.create', { requestId: rid(), spaceId: otherSpace, title: '父任务' })).item
    const child = (await c.call('work.dispatch', { requestId: rid(), spaceId: otherSpace, parentId: root.workItemId, title: '子任务', brief: '执行', agentKind: 'codex', activate: true })).item
    const worker = await runningAgent(c, otherSpace, child.sessions[0].sessionId)
    const unselected = await ui()
    const report = await worker.call('work.report', { requestId: rid(), kind: 'blocked', body: '等待素材' })
    for (const connection of [c, observer, unselected]) {
      await until(() => connection.notifications.some(n => n.method === 'events.workInboxChanged' && (n.params as { unread?: number }).unread === 1))
      expect(connection.notifications.filter(n => n.method === 'events.workInboxChanged').at(-1)).toMatchObject({ params: { unread: 1, unresolved: 1, bySpace: expect.arrayContaining([{ spaceId: otherSpace, unread: 1, unresolved: 1 }]) } })
    }
    expect(observer.notifications.some(n => n.params.type === 'work.messageAdded')).toBe(false)
    expect((await observer.call('work.inbox')).groups).toMatchObject([{ spaceId: otherSpace, spaceName: '后台项目', items: [{ workItemId: child.workItemId, messages: [{ messageId: report.messageId }] }] }])
    const count = unselected.notifications.filter(n => n.method === 'events.workInboxChanged').length
    await worker.call('work.get')
    await observer.call('work.inbox')
    expect(unselected.notifications.filter(n => n.method === 'events.workInboxChanged')).toHaveLength(count)
    await unselected.call('work.setSlotLimit', { limit: 5 })
    for (const connection of [c, observer, unselected]) {
      await until(() => connection.notifications.some(n => n.method === 'events.workSlotsChanged' && (n.params as { limit?: number }).limit === 5))
    }
  })

  it('Agent changes in this activation and session changes push complete new cards; ordinary canvas edits do not change the workspace', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const created = await c.call('session.create', { requestId: rid(), title: '改动任务' })
    const a0 = await runningAgent(c, spaceId, created.sessionId)
    const item = (await a0.call('work.get')).item
    c.notifications.length = 0
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'n', kind: 'text', x: 80, y: 80, w: 100, h: 100 }] })
    expect(c.notifications.filter(n => n.params.type === 'work.itemChanged')).toEqual([])
    c.notifications.length = 0
    const drawn = await a0.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'own', kind: 'text', x: 180, y: 80, w: 100, h: 100 }] })
    await until(() => c.notifications.some(n => n.params.type === 'work.itemChanged'))
    expect(c.notifications.find(n => n.params.type === 'work.itemChanged')).toMatchObject({ params: { payload: { workItemId: item.workItemId, revision: item.revision + 1, changeCount: 1 } } })
    let previous = (await a0.call('work.get')).item
    expect(previous.lastChangeSeq).toEqual(expect.any(Number))
    for (const body of ['第一次修改', '第二次修改']) {
      const node = (await a0.call('canvas.get', { nodeIds: [drawn.idMap.own] })).nodes[0]
      const slot = node.slots[0]
      c.notifications.length = 0
      await a0.call('canvas.apply', { requestId: rid(), ops: [{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: slot.revision, body }] })
      await until(() => c.notifications.some(n => n.params.type === 'work.itemChanged'))
      const changed = (await a0.call('work.get')).item
      expect(changed.changeCount).toBe(1)
      expect(changed.lastChangeSeq).toBeGreaterThan(previous.lastChangeSeq)
      expect(changed.revision).toBeGreaterThan(previous.revision)
      previous = changed
    }
    c.notifications.length = 0
    await a0.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.delete', nodeId: drawn.idMap.own }] })
    await until(() => c.notifications.some(n => n.params.type === 'work.itemChanged'))
    expect(c.notifications.find(n => n.params.type === 'work.itemChanged')).toMatchObject({ params: { payload: { workItemId: item.workItemId, changeCount: 0 } } })
    const session = await c.call('session.create', { requestId: rid(), title: '会话卡片' })
    c.notifications.length = 0
    await c.call('session.rename', { requestId: rid(), sessionId: session.sessionId, title: '新会话标题' })
    // Creation responses and notifications may arrive in separate batches; wait for the renamed revision rather than taking a creation notification still in transit.
    await expect.poll(() => c.notifications.filter(n => n.params.type === 'work.itemChanged').at(-1))
      .toMatchObject({ params: { payload: { workItemId: session.workItemId, revision: 2, sessions: [{ sessionId: session.sessionId, title: '新会话标题' }] } } })
    const renamed = (await c.call('work.get', { workItemId: session.workItemId })).item
    c.notifications.length = 0
    const a = await runningAgent(c, spaceId, session.sessionId)
    await until(() => c.notifications.some(n => n.params.type === 'work.itemChanged'))
    const active = (await a.call('work.get')).item
    expect(active.revision).toBeGreaterThan(renamed.revision)
    expect(active).toMatchObject({ activity: 'active', sessions: [{ activeTurnId: expect.any(String), doing: '正在处理' }] })
    c.notifications.length = 0
    const turn = dispatched.find(turn => turn.sessionId === session.sessionId)!
    await new Promise(resolve => setTimeout(resolve, 2))
    turn.report({ type: 'item', sessionId: session.sessionId, turnId: turn.turnId, itemId: 'tool:work', revision: 1, kind: 'tool_call', payload: { name: 'canvas.get', arguments: {} } })
    await until(() => c.notifications.some(n => n.params.type === 'work.itemChanged'))
    const tool = (await a.call('work.get')).item
    expect(tool.revision).toBeGreaterThan(active.revision)
    expect(tool.sessions[0].lastActivityAt).toBeGreaterThan(active.sessions[0].lastActivityAt)
    c.notifications.length = 0
    turn.end()
    await until(() => c.notifications.some(n => n.params.type === 'work.itemChanged'))
    const idle = (await c.call('work.get', { workItemId: session.workItemId })).item
    expect(idle.revision).toBeGreaterThan(tool.revision)
    expect(idle).toMatchObject({ activity: 'idle', sessions: [{ activeTurnId: null }] })
    await expect(c.call('work.update', { requestId: rid(), workItemId: idle.workItemId, expectedRevision: active.revision, pinned: true })).rejects.toMatchObject({ code: 'revision_conflict' })
  })

  it('recall releases slots and automatically activates the next item in the cross-project queue', async () => {
    const c = await ui()
    const otherSpace = studiod.spaces.create('队列项目').spaceId
    await c.call('work.setSlotLimit', { limit: 1 })
    const active = (await c.call('work.create', { requestId: rid(), spaceId, title: '进行中', chat: { agentKind: 'codex' } })).item
    const first = await c.call('work.create', { requestId: rid(), spaceId: otherSpace, title: '先排队', chat: { agentKind: 'codex' } })
    const second = await c.call('work.create', { requestId: rid(), spaceId, title: '后排队', chat: { agentKind: 'codex' } })
    expect(first.queued).toBe(true)
    expect(second.queued).toBe(true)
    studiod.spaces.get(otherSpace)!.db.update(s.workItems).set({ waitingSlotSince: 1 }).where(eq(s.workItems.id, first.item.workItemId)).run()
    studiod.spaces.get(spaceId)!.db.update(s.workItems).set({ waitingSlotSince: 2 }).where(eq(s.workItems.id, second.item.workItemId)).run()
    await c.call('work.recall', { requestId: rid(), spaceId, workItemId: active.workItemId })
    expect((await c.call('work.get', { spaceId: otherSpace, workItemId: first.item.workItemId })).item.status).toBe('in_progress')
    expect(await c.call('work.slots')).toMatchObject({ used: 1, queue: [{ spaceId, workItemId: second.item.workItemId }] })
    await c.call('work.recall', { requestId: rid(), spaceId: otherSpace, workItemId: first.item.workItemId })
    expect((await c.call('work.get', { spaceId, workItemId: second.item.workItemId })).item.status).toBe('in_progress')
    expect(await c.call('work.slots')).toMatchObject({ used: 1, queue: [] })
  })

  it('revokes old token permissions once stop is accepted even before the turn ends, and reactivation cannot restore them', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const session = await c.call('session.create', { requestId: rid(), title: '等待中断的协调者' })
    const host = studiod.spaces.get(spaceId)!
    const a = await runningAgent(c, spaceId, session.sessionId)
    const turn = dispatched.find(turn => turn.sessionId === session.sessionId)!
    const child = await a.call('work.dispatch', { requestId: rid(), title: '原子项', brief: '等待执行', agentKind: 'codex', activate: false })
    expect(child.item.parentId).toBe(session.workItemId)

    await c.call('work.recall', { requestId: rid(), workItemId: session.workItemId })
    expect(host.db.select().from(s.turns).where(eq(s.turns.id, turn.turnId)).get()?.status).toBe('running')
    expect(host.sessions.isTurnStopping(turn.turnId)).toBe(true)
    for (const reactivated of [false, true]) {
      if (reactivated) {
        expect((await c.call('work.activate', { requestId: rid(), workItemId: session.workItemId })).item.status).toBe('in_progress')
        expect(host.db.select().from(s.sessions).where(eq(s.sessions.id, session.sessionId)).get()?.queuePaused).toBe(false)
        expect(host.sessions.isTurnStopping(turn.turnId)).toBe(true)
      }
      await expect(a.call('generation.submit', { requestId: rid(), kind: 'image', prompt: '迟到的生成' })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(a.call('work.dispatch', { requestId: rid(), title: '迟到的子项', brief: '不应创建', agentKind: 'codex', activate: false })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(a.call('canvas.get')).rejects.toMatchObject({ code: 'forbidden' })
    }
    expect(host.db.select().from(s.generationJobs).all()).toHaveLength(0)
    expect((await c.call('work.list', { parentId: session.workItemId })).items).toHaveLength(1)
  })

  it('old active turns cannot call generation or canvas methods once the work item is submitted for review', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const session = await c.call('session.create', { requestId: rid(), title: '用户送审' })
    const a = await runningAgent(c, spaceId, session.sessionId)
    await c.call('work.submitReview', { requestId: rid(), workItemId: session.workItemId })
    await expect(a.call('generation.submit', { requestId: rid(), kind: 'image', prompt: '送审后生成' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('canvas.get')).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('Single instance', () => {
  const options = (): StudiodOptions => ({
    dataDir: dir,
    studiodVersion: '0.0.0-test',
    runtimes: { codex: fakeRuntime, claude: () => ({ async ensureReady() {}, async dispatchTurn() {}, async terminateTurn() {}, async interruptTurn() {} }) },
    providers: [createMockProvider({ latencyMs: 50 })],
    defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
  })

  it('rejects another instance using the same data directory without affecting the running instance', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    await c.call('session.create', { requestId: rid(), title: '分镜' })

    await expect(startStudiod(options())).rejects.toBeInstanceOf(StudiodRunningError)
    // The original instance still has its connections, tokens and data.
    expect(readFileSync(studiod.tokenPath, 'utf8')).toBeTruthy()
    expect((await c.call('session.list')).sessions).toHaveLength(1)
  })

  it('allows restarting after the original instance exits', async () => {
    await studiod.stop('user_quit')
    studiod = await startStudiod(options())
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
  })

  it('does not restore execution reservations for removed-adapter cards moved to in_progress', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    await c.call('work.setSlotLimit', { limit: 1 })
    const { item } = await c.call('work.create', { requestId: rid(), title: 'Removed after creation', chat: { agentKind: 'codex' } })
    await c.call('work.move', { requestId: rid(), workItemId: item.workItemId, status: 'todo' })
    studiod.spaces.get(spaceId)!.db.update(s.sessions).set({ agentKind: 'removed' }).where(eq(s.sessions.workItemId, item.workItemId)).run()
    await c.call('work.move', { requestId: rid(), workItemId: item.workItemId, status: 'in_progress' })
    expect(studiod.spaces.workSlots.view().used).toBe(0)
    await studiod.stop('user_quit')
    studiod = await startStudiod(options())
    expect(studiod.spaces.workSlots.view().used).toBe(0)
    expect(studiod.spaces.get(spaceId)!.work.get({ workItemId: item.workItemId }).item.status).toBe('in_progress')
    const reconnected = await ui()
    const next = await reconnected.call('work.create', { requestId: rid(), spaceId, title: 'Runnable', chat: { agentKind: 'codex' } })
    expect(next.queued).toBe(false)
    expect(studiod.spaces.workSlots.view().used).toBe(1)
  })

  it('stops recovery when global reservations exist but the project database is missing, without releasing unknown job quota', async () => {
    await studiod.stop('user_quit')
    const db = openAppDb(join(dir, 'app.db'))
    try {
      db.insert(appSchema.generationQuota).values({ jobId: 'missing-job', spaceId, kind: 'image', date: '2026-10-27', state: 'active', createdAt: Date.now() }).run()
      await expect(startStudiod(options())).rejects.toThrow('job database is missing')
      expect(db.select().from(appSchema.generationQuota).get()?.state).toBe('active')
    } finally { db.$client.close() }
  })

  it('opens existing spaces at startup so unfinished jobs recover without waiting for a UI connection', async () => {
    await studiod.stop('user_quit')
    studiod = await startStudiod(options())
    expect(studiod.spaces.opened().map(h => h.spaceId)).toEqual([spaceId])
  })

  it('scans all projects at startup to rebuild work slots, replacing the old ledger and preserving actual work items above the limit', async () => {
    const c = await ui()
    const otherSpace = studiod.spaces.create('重建项目').spaceId
    await c.call('work.setSlotLimit', { limit: 8 })
    const items: { workItemId: string; spaceId: string }[] = []
    for (let index = 0; index < 7; index++) {
      const targetSpace = index < 4 ? spaceId : otherSpace
      const { item } = await c.call('work.create', { requestId: rid(), spaceId: targetSpace, title: `工作 ${index}`, chat: { agentKind: 'codex' } })
      items.push({ workItemId: item.workItemId, spaceId: targetSpace })
    }
    await c.call('work.setSlotLimit', { limit: 6 })
    await studiod.stop('user_quit')
    const db = openAppDb(join(dir, 'app.db'))
    db.delete(appSchema.workSlots).run()
    db.insert(appSchema.workSlots).values({ workItemId: 'stale', spaceId, acquiredAt: 1 }).run()
    db.$client.close()
    studiod = await startStudiod(options())
    expect(studiod.spaces.opened().map(host => host.spaceId).sort()).toEqual([spaceId, otherSpace].sort())
    expect(studiod.spaces.workSlots.view()).toMatchObject({ used: 7, limit: 6, bySpace: expect.arrayContaining([{ spaceId, used: 4, limit: null }, { spaceId: otherSpace, used: 3, limit: null }]) })
    const restored = openAppDb(join(dir, 'app.db'))
    try { expect(restored.select().from(appSchema.workSlots).all().map(row => ({ workItemId: row.workItemId, spaceId: row.spaceId }))).toEqual(expect.arrayContaining(items)) }
    finally { restored.$client.close() }
    const reconnected = await ui()
    expect((await reconnected.call('work.create', { requestId: rid(), spaceId, title: '继续排队', chat: { agentKind: 'codex' } })).queued).toBe(true)
  })

  it('aborts startup when a previously opened project database is missing during upgrade, even if the new slot ledger is empty', async () => {
    studiod.spaces.get(spaceId)
    await studiod.stop('user_quit')
    const file = join(dir, 'spaces', spaceId, 'space.db')
    rmSync(file)
    const db = openAppDb(join(dir, 'app.db'))
    try {
      expect(db.select().from(appSchema.workSlots).all()).toHaveLength(0)
      expect(db.select().from(appSchema.spaces).where(eq(appSchema.spaces.id, spaceId)).get()?.lastOpenedAt).not.toBeNull()
    } finally { db.$client.close() }
    await expect(startStudiod(options())).rejects.toThrow('work item database is missing')
  })

  it('aborts startup when a project database is unreadable, preserving the existing work slot ledger', async () => {
    const c = await ui()
    const { item } = await c.call('work.create', { requestId: rid(), spaceId, title: '恢复保护', chat: { agentKind: 'codex' } })
    await studiod.stop('user_quit')
    writeFileSync(join(dir, 'spaces', spaceId, 'space.db'), 'invalid sqlite database')
    await expect(startStudiod(options())).rejects.toThrow()
    const db = openAppDb(join(dir, 'app.db'))
    try { expect(db.select().from(appSchema.workSlots).all()).toMatchObject([{ workItemId: item.workItemId, spaceId }]) }
    finally { db.$client.close() }
  })
})

it('Agent SVG imports preserve dimensions and reject dangerous declarations and disguised content', async () => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const { sessionId, workDir } = await c.call('session.create', { requestId: rid(), title: 'SVG 图形' })
  await c.call('session.sendMessage', { requestId: rid(), sessionId, text: '创建图形', refs: [] })
  await until(() => dispatched.length === 1)
  const a = await agent(dispatched[0]!.token)
  const path = join(workDir, 'graphic.svg')
  writeFileSync(path, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="100" height="100"/></svg>')
  const imported = await a.call('asset.importFile', { requestId: rid(), path })
  expect(imported).toMatchObject({ kind: 'image', mime: 'image/svg+xml', width: 640, height: 360 })
  expect(await a.call('asset.get', { assetVersionId: imported.assetVersionId })).toMatchObject({ mime: 'image/svg+xml', width: 640, height: 360 })
  await expect(a.call('asset.extractFrames', { requestId: rid(), assetVersionId: imported.assetVersionId })).rejects.toMatchObject({ code: 'invalid_params' })
  for (const contents of ['<!DOCTYPE svg><svg/>', '<html>not svg</html>']) {
    writeFileSync(path, contents)
    await expect(a.call('asset.importFile', { requestId: rid(), path })).rejects.toMatchObject({ code: 'invalid_params' })
  }
})

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()

describe.skipIf(!hasFfmpeg)('Import and frame extraction', () => {
  /** Generate a 3-second, 320x180 test video on demand with ffmpeg. */
  function makeVideo() {
    const file = join(dir, 'ref.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x180:rate=10', '-pix_fmt', 'yuv420p', '-y', file])
    return file
  }

  async function blockoutFixture(c: Awaited<ReturnType<typeof ui>>, durations: (number | null)[] = [0.5, 1, 1.5]) {
    const { EMPTY_PREVIZ, emptyPrevizPanel } = await import('@vis/protocol')
    await c.call('events.subscribe', { spaceId })
    const video = await c.call('asset.import', { requestId: rid(), path: makeVideo() })
    const host = studiod.spaces.get(spaceId)!
    const picture = host.assets.registerVersion(host.db, { staged: await host.assets.stageBytes(Buffer.from('protected')), kind: 'image', mime: 'image/png', origin: 'import' }).assetVersionId
    const created = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'p', kind: 'previz' }] })
    const nodeId = created.idMap.p
    const slotId = host.canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!.slotId
    const doc = { ...EMPTY_PREVIZ, rev: 4, panels: durations.map((durationSec, index) => ({
      ...emptyPrevizPanel(`panel-${index + 1}`), rev: index + 2, durationSec, note: `Camera ${index}`,
      underlay: picture, sketch: picture, image: picture,
    })) }
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId, expectedRevision: 1, doc }] })
    return { host, nodeId, slotId, doc, params: { requestId: rid(), slotId, expectedRevision: 2, assetVersionId: video.assetVersionId } }
  }

  it('extracts exact panel starts for the user, refuses Agents, preserves drawings and metadata, and replays without another write', async () => {
    const c = await ui()
    const { host, nodeId, slotId, doc, params } = await blockoutFixture(c)
    const session = await c.call('session.create', { requestId: rid() })
    await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Extract blockout', refs: [] })
    await until(() => dispatched.length === 1)
    const a = await agent(dispatched[0]!.token)
    try {
      await expect(a.call('previz.extractBlockout', params)).rejects.toMatchObject({ code: 'forbidden' })
      const result = await c.call('previz.extractBlockout', params)
      expect(result.revision).toBe(3)
      expect(result.frames.map((frame: { panelId: string; atMs: number }) => [frame.panelId, frame.atMs])).toEqual([['panel-1', 0], ['panel-2', 500], ['panel-3', 1500]])
      const slot = host.canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!
      expect(slot).toMatchObject({ revision: 3, writer: { actor: 'user' }, content: { type: 'previz', doc: {
        ...doc, rev: 5, panels: doc.panels.map((panel, i) => ({ ...panel, rev: panel.rev + 1, blockout: result.frames[i].assetVersionId })),
      } } })
      for (const frame of result.frames) expect(await c.call('asset.get', { assetVersionId: frame.assetVersionId })).toMatchObject({ kind: 'image', width: 320, height: 180, mime: 'image/jpeg' })
      const seq = currentSeq(host.db)
      const extraction = vi.spyOn(media, 'extractFrames')
      expect(await c.call('previz.extractBlockout', params)).toEqual(result)
      expect(extraction).not.toHaveBeenCalled()
      expect(currentSeq(host.db)).toBe(seq)
      extraction.mockRestore()
      await expect(c.call('previz.extractBlockout', { ...params, assetVersionId: 'different' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
      const userResult = await c.call('previz.extractBlockout', { ...params, requestId: rid(), expectedRevision: 3 })
      expect(userResult.revision).toBe(4)
      expect(userResult.frames.map((frame: { atMs: number }) => frame.atMs)).toEqual([0, 500, 1500])
      const protectedDoc = host.canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!.content
      if (protectedDoc.type !== 'previz') throw new Error('Expected previz')
      await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId, expectedRevision: 4, doc: { ...protectedDoc.doc, panels: protectedDoc.doc.panels.map(panel => ({ ...panel, image: null })) } }] })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'previz.drawing_protected' } } })
      for (const blockout of ['other-frame', null]) {
        await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId, expectedRevision: 4, doc: { ...protectedDoc.doc, panels: protectedDoc.doc.panels.map(panel => ({ ...panel, blockout })) } }] })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'previz.blockout_user_only' } } })
      }
    } finally { a.close(); c.close() }
  })

  it('names missing panel durations and rejects timing mismatches using the measured video frame rate', async () => {
    const c = await ui()
    try {
      const fixture = await blockoutFixture(c, [null, 1, null])
      await expect(c.call('previz.extractBlockout', fixture.params)).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('panel-1, panel-3'), rpc: { data: { reason: 'previz.duration_required' } } })
      const doc = { ...fixture.doc, panels: fixture.doc.panels.map(panel => ({ ...panel, durationSec: 1 })) }
      await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: fixture.slotId, expectedRevision: 2, doc: { ...doc, panels: doc.panels.map((panel, index) => ({ ...panel, durationSec: index === 2 ? 0.8 : 1 })) } }] })
      await expect(c.call('previz.extractBlockout', { ...fixture.params, requestId: rid(), expectedRevision: 3 })).rejects.toMatchObject({ code: 'invalid_params', rpc: { data: { reason: 'previz.duration_mismatch', params: { panelDurationMs: 2800, videoDurationMs: 3000, toleranceMs: 100 } } } })
      await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: fixture.slotId, expectedRevision: 3, doc: { ...doc, panels: doc.panels.map((panel, index) => ({ ...panel, durationSec: index === 2 ? 1.09 : 1 })) } }] })
      const accepted = await c.call('previz.extractBlockout', { ...fixture.params, requestId: rid(), expectedRevision: 4 })
      expect(accepted.frames.map((frame: { atMs: number }) => frame.atMs)).toEqual([0, 1000, 2000])
    } finally { c.close() }
  })

  it('checks revision before extraction and at writeback without registering frames after a concurrent edit', async () => {
    const c = await ui()
    const { host, nodeId, doc, params } = await blockoutFixture(c)
    const original = media.extractFrames.bind(media)
    let release!: () => void
    let entered = false
    const barrier = new Promise<void>(resolve => { release = resolve })
    const extraction = vi.spyOn(media, 'extractFrames').mockImplementation(async (...args) => { entered = true; await barrier; return original(...args) })
    try {
      await expect(c.call('previz.extractBlockout', { ...params, expectedRevision: 1 })).rejects.toMatchObject({ code: 'revision_conflict' })
      expect(extraction).not.toHaveBeenCalled()
      const versions = host.db.select().from(s.assetVersions).all().length
      const pending = c.call('previz.extractBlockout', params)
      await until(() => entered)
      const edited = { ...doc, panels: doc.panels.map(panel => ({ ...panel, note: 'User edited during extraction' })) }
      await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: params.slotId, expectedRevision: 2, doc: edited }] })
      release()
      await expect(pending).rejects.toMatchObject({ code: 'revision_conflict' })
      expect(host.db.select().from(s.assetVersions).all()).toHaveLength(versions)
      expect(host.canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!.content).toEqual({ type: 'previz', doc: edited })
    } finally { release(); extraction.mockRestore(); c.close() }
  })

  it('UI imports video; Agent extracts evenly spaced frames during the turn and registers image assets; retries with the same requestId return the first result', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const video = await c.call('asset.import', { requestId: 'imp_1', path: makeVideo() })
    expect(video).toMatchObject({ kind: 'video', mime: 'video/mp4', displayName: 'ref.mp4', width: 320, height: 180, durationMs: expect.any(Number) })
    expect(await c.call('asset.get', { assetVersionId: video.assetVersionId })).toMatchObject({ displayName: 'ref.mp4' })
    expect(Math.abs(video.durationMs - 3000)).toBeLessThan(200)

    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'v', kind: 'video', x: 0, y: 0, w: 320, h: 180, content: { assetVersionId: video.assetVersionId } }] })
    const { sessionId, workDir } = await c.call('session.create', { requestId: rid(), title: '复刻' })
    await c.call('session.sendMessage', { requestId: rid(), sessionId, text: '拆解参考视频', refs: [] })
    await until(() => dispatched.length === 1)
    const a = await agent(dispatched[0]!.token)
    await expect(a.call('asset.import', { requestId: 'imp_2', path: makeVideo() })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('fs.listSkills', { spaceId })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('asset.importFile', { requestId: rid(), path: join(dir, 'ref.mp4') })).rejects.toMatchObject({ code: 'forbidden' })
    const produced = join(workDir, 'output.mp4')
    copyFileSync(join(dir, 'ref.mp4'), produced)
    const importParams = { requestId: rid(), path: produced }
    const imported = await a.call('asset.importFile', importParams)
    expect(imported).toMatchObject({ kind: 'video', mime: 'video/mp4', width: 320, height: 180 })
    expect(await a.call('asset.importFile', importParams)).toEqual(imported)

    const params = { requestId: 'frames_1', assetVersionId: video.assetVersionId, count: 3 }
    const result = await a.call('asset.extractFrames', params)
    expect(result.frames.map((f: { atMs: number }) => f.atMs)).toEqual([500, 1500, 2500])
    for (const f of result.frames) {
      expect(f).toMatchObject({ kind: 'image', mime: 'image/jpeg', width: 320, height: 180 })
      expect(existsSync(fileURLToPath(f.url))).toBe(true)
      expect(f.path).toBe(fileURLToPath(f.url))
    }
    expect(await a.call('asset.extractFrames', params)).toEqual(result)
  })

  it('paths must be absolute and exist; images cannot provide extracted frames', async () => {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    await expect(c.call('asset.import', { requestId: rid(), path: 'ref.mp4' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(c.call('asset.import', { requestId: rid(), path: join(dir, 'missing.mp4') })).rejects.toMatchObject({ code: 'not_found' })
    const txt = join(dir, 'notes.txt')
    writeFileSync(txt, 'x')
    await expect(c.call('asset.import', { requestId: rid(), path: txt })).rejects.toMatchObject({ code: 'invalid_params' })
    const png = join(dir, 'still.png')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64', '-frames:v', '1', '-y', png])
    const image = await c.call('asset.import', { requestId: rid(), path: png, displayName: '镜头' })
    expect(image).toMatchObject({ kind: 'image', mime: 'image/png', displayName: '镜头', width: 64, height: 64 })
    await expect(c.call('asset.extractFrames', { requestId: rid(), assetVersionId: image.assetVersionId })).rejects.toMatchObject({ code: 'invalid_params' })
  })
})

it('0015: UI can change approval mode and parent items, Agents cannot; public attachment paths enter the turn', async () => {
  const c = await ui()
  try {
    await c.call('events.subscribe', { spaceId, afterSeq: 0 })
    const parent = await c.call('session.create', { spaceId, requestId: 's15-parent' })
    const child = await c.call('session.create', { spaceId, requestId: 's15-child' })
    expect(await c.call('session.setApprovalMode', { spaceId, requestId: 's15-mode', sessionId: child.sessionId, mode: 'auto' })).toMatchObject({ approvalMode: 'auto' })
    expect(await c.call('work.reparent', { spaceId, requestId: 's15-reparent', workItemId: child.workItemId, parentId: parent.workItemId })).toMatchObject({ oldParentId: null, item: { parentId: parent.workItemId } })
    const host = studiod.spaces.get(spaceId)!
    const staged = await host.assets.stageBytes(Buffer.from('attachment image'))
    const { assetVersionId } = host.assets.registerVersion(host.db, { staged, kind: 'image', mime: 'image/png', origin: 'import', displayName: '参考.png' })
    await c.call('session.sendMessage', { spaceId, requestId: 's15-send', sessionId: child.sessionId, text: '参考附件', refs: [{ assetVersionId }] })
    await host.sessions.idle()
    const turn = dispatched[0]!
    const attachment = JSON.parse(turn.text.split('<素材附件>\n')[1]!.split('\n</素材附件>')[0]!)
    expect(attachment).toMatchObject({ assetVersionId, kind: 'image', filename: '参考.png' })
    expect(attachment.path).toContain(`${sep}assets${sep}attachment-`)
    expect(readFileSync(attachment.path).toString()).toBe('attachment image')
    expect(await turn.requestApproval({ sessionId: child.sessionId, turnId: turn.turnId, kind: 'command', summary: '读取目录', detail: 'ls', cwd: child.workDir })).toBe('allow_once')
    const a = await agent(turn.token)
    try {
      await expect(a.call('session.setApprovalMode', { spaceId, requestId: 's15-agent-mode', sessionId: child.sessionId, mode: 'ask' })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(a.call('work.reparent', { spaceId, requestId: 's15-agent-reparent', workItemId: child.workItemId, parentId: null })).rejects.toMatchObject({ code: 'forbidden' })
    } finally { a.close() }
  } finally { c.close() }
})

it('allows only the UI to create or restore a prompt slot and rejects agent batches atomically', async () => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const host = studiod.spaces.get(spaceId)!
  const { idMap } = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'legacy', kind: 'image' }] })
  const session = await c.call('session.create', { requestId: rid() })
  await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Inspect provenance', refs: [] })
  await until(() => dispatched.length === 1)
  const a = await agent(dispatched[0]!.token)
  try {
    const seq = currentSeq(host.db)
    const op = { op: 'node.setPrompt', nodeId: idMap.legacy, body: 'Restored {{ref:source}}', expectedRevision: 0 }
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.layout', nodeId: idMap.legacy, x: 900 }, op] })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'runtime.caller_forbidden' } } })
    expect(currentSeq(host.db)).toBe(seq)
    await c.call('canvas.apply', { requestId: rid(), ops: [op] })
    const prompt = host.canvas.get({ nodeIds: [idMap.legacy] }).nodes[0]!.slots.find(slot => slot.slotKey === 'prompt')!
    expect(prompt.content).toEqual({ type: 'text', body: op.body })
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ ...op, expectedRevision: prompt.revision }] })).rejects.toMatchObject({ code: 'forbidden' })
    expect(host.canvas.get({ nodeIds: [idMap.legacy] }).nodes[0]!.slots.find(slot => slot.slotKey === 'prompt')).toEqual(prompt)
  } finally { a.close(); c.close() }
})

describe('Agent scene gateway permissions', () => {
  const object = (fields: Partial<SceneObject> = {}): SceneObject => ({
    id: 'figure', name: 'Figure', hidden: false, createdBy: 'agent', userTouched: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    source: { type: 'figure', bodyId: 'human', heightM: 1.8, pose: {} }, ...fields,
  })
  const view = (fields: Partial<SceneView> = {}): SceneView => ({
    id: 'wide', name: 'Wide', camera: { position: [0, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 },
    aspectRatio: '16:9', still: null, createdBy: 'agent', userTouched: false, ...fields,
  })
  async function setup(doc: SceneDoc = EMPTY_SCENE) {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const host = studiod.spaces.get(spaceId)!
    const created = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', kind: 'scene', tempId: 'stage' }] })
    const nodeId = created.idMap.stage as string
    const main = () => host.canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!
    // Seed historical ownership through the trusted service, then exercise all writes through RPC.
    host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'scene.set', slotId: main().slotId, expectedRevision: 1, doc }] })
    const session = await c.call('session.create', { requestId: rid() })
    await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Work on the stage', refs: [] })
    await until(() => dispatched.length === 1)
    const a = await agent(dispatched[0]!.token)
    const set = (next: SceneDoc): CanvasOp => ({ op: 'scene.set', slotId: main().slotId, expectedRevision: main().revision, doc: next })
    const write = (next: SceneDoc, caller = a) => caller.call('canvas.apply', { requestId: rid(), ops: [set(next)] })
    const refuse = async (ops: CanvasOp[], reason: string, params = {}, hint?: string) => {
      const seq = currentSeq(host.db)
      const before = host.canvas.get({})
      await expect(a.call('canvas.apply', { requestId: rid(), ops })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason, params, ...(hint === undefined ? {} : { hint }) } } })
      expect(currentSeq(host.db)).toBe(seq)
      expect(host.canvas.get({})).toEqual(before)
    }
    return { c, a, host, nodeId, session, main, set, write, refuse, close() { a.close(); c.close() } }
  }

  it('offers protected proposals while keeping resolution UI-only under auto approval and checking session write gates', async () => {
    const f = await setup({ ...EMPTY_SCENE, objects: [object({ userTouched: true })] })
    try {
      const { createdBy: _createdBy, userTouched: _userTouched, ...content } = object()
      const params = { requestId: rid(), slotId: f.main().slotId, baseRevision: f.main().revision, summary: 'Move the figure', changes: [{ target: 'object', id: content.id, action: 'update', item: { ...content, name: 'Moved' } }] }
      const before = f.main().content
      const proposal = await f.a.call('scene.propose', params)
      expect(proposal.sessionId).toBe(f.session.sessionId)
      expect(f.main().content).toEqual(before)
      expect((await f.a.call('scene.proposal.list', {})).proposals).toEqual([proposal])
      f.host.db.update(s.sessions).set({ approvalMode: 'auto' }).where(eq(s.sessions.id, f.session.sessionId)).run()
      const resolve = { requestId: rid(), slotId: params.slotId, action: 'accept', expectedRevision: f.main().revision, changes: proposal.changes.map((change: any) => ({ proposalId: proposal.proposalId, changeId: change.changeId })) }
      await expect(f.a.call('scene.proposal.resolve', resolve)).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'runtime.caller_forbidden' } } })
      expect(f.main().content).toEqual(before)
      expect((await f.c.call('scene.proposal.resolve', resolve)).revision).toBe(params.baseRevision + 1)
      expect(f.main().content).toMatchObject({ type: 'scene', doc: { objects: [{ name: 'Moved', userTouched: true }] } })
      await expect(f.a.call('canvas.apply', { requestId: rid(), ops: [f.set({ ...EMPTY_SCENE, objects: [object()] })] })).rejects.toMatchObject({ rpc: { data: { reason: 'scene.object_protected', hint: expect.stringContaining('scene.propose') } } })
      const blocked = async (reason: string) => {
        await expect(f.a.call('scene.propose', { ...params, requestId: rid(), baseRevision: f.main().revision })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason } } })
      }
      f.host.db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, f.session.sessionId)).run()
      await blocked('runtime.work_item_required')
      f.host.db.update(s.sessions).set({ workItemId: f.session.workItemId }).where(eq(s.sessions.id, f.session.sessionId)).run()
      f.host.db.update(s.workItems).set({ status: 'todo' }).where(eq(s.workItems.id, f.session.workItemId)).run()
      await blocked('work.execution_forbidden')
      f.host.db.update(s.workItems).set({ status: 'in_progress' }).where(eq(s.workItems.id, f.session.workItemId)).run()
      f.host.db.update(s.sessions).set({ archivedAt: Date.now() }).where(eq(s.sessions.id, f.session.sessionId)).run()
      await blocked('runtime.session_inactive')
    } finally { f.close() }
  })

  it('creates scenes in temp-slot batches, stamps Agent additions and discards forged stills and metadata', async () => {
    const f = await setup()
    try {
      expect((await f.a.call('canvas.get', { nodeIds: [f.nodeId] })).nodes[0].slots[0].content).toEqual({ type: 'scene', doc: EMPTY_SCENE })
      const doc: SceneDoc = { ...EMPTY_SCENE, objects: [object({ createdBy: 'user', userTouched: true })], views: [view({ createdBy: 'user', userTouched: true, still: 'nonexistent-forged-still' })] }
      const params = { requestId: rid(), ops: [
        { op: 'node.create', kind: 'scene', tempId: 'fresh' },
        { op: 'scene.set', slotId: 'fresh:main', expectedRevision: 1, doc },
      ] }
      const created = await f.a.call('canvas.apply', params)
      expect(await f.a.call('canvas.apply', params)).toEqual(created)
      expect(f.host.canvas.get({ nodeIds: [created.idMap.fresh] }).nodes[0]!.slots[0]!.content).toEqual({ type: 'scene', doc: { ...EMPTY_SCENE, objects: [object()], views: [view()] } })
      await f.write(doc)
      expect(f.main().content).toEqual({ type: 'scene', doc: { ...EMPTY_SCENE, objects: [object()], views: [view()] } })
      await expect(f.a.call('model.list', {})).rejects.toMatchObject({ code: 'forbidden' })
    } finally { f.close() }
  })

  it('replays original scene requests after later author edits without recomputing stamps or overwriting work', async () => {
    const f = await setup({ ...EMPTY_SCENE, objects: [object()], views: [view()] })
    try {
      const params = { requestId: rid(), ops: [f.set({ ...EMPTY_SCENE, objects: [object({ name: 'Agent revision', createdBy: 'user', userTouched: true })], views: [view({ still: 'forged' })] })] }
      const written = await f.a.call('canvas.apply', params)
      const still = f.host.assets.registerVersion(f.host.db, { staged: await f.host.assets.stageBytes(Buffer.from('saved frame')), kind: 'image', mime: 'image/png', origin: 'import' }).assetVersionId
      const authorParams = { requestId: rid(), ops: [f.set({ ...EMPTY_SCENE, objects: [object({ name: 'Author revision' })], views: [view({ still })] })] }
      const authorWrite = await f.c.call('canvas.apply', authorParams)
      const saved = f.main()
      expect(await f.a.call('canvas.apply', params)).toEqual(written)
      expect(f.main()).toEqual(saved)
      await expect(f.a.call('canvas.apply', { ...params, ops: [f.set(EMPTY_SCENE)] })).rejects.toMatchObject({ code: 'idempotency_conflict' })
      await f.write({ ...EMPTY_SCENE, objects: [object({ name: 'Later author revision' })], views: [view({ still })] }, f.c)
      const later = f.main()
      expect(await f.c.call('canvas.apply', authorParams)).toEqual(authorWrite)
      expect(f.main()).toEqual(later)
    } finally { f.close() }
  })

  it.each([{ createdBy: 'user' as const, userTouched: false }, { createdBy: 'agent' as const, userTouched: true }])('protects existing object edits, tracks and deletion atomically: %j', async protection => {
    const doc: SceneDoc = { ...EMPTY_SCENE, durationS: 5, objects: [object(protection)] }
    const f = await setup(doc)
    try {
      for (const objects of [[], [object({ name: 'Forged name' })], [object({ hidden: true })],
        [object({ transform: { ...object().transform, position: [1, 0, 0] } })],
        [object({ source: { type: 'primitive', shape: 'box', size: [1, 1, 1] } })],
        [object({ tracks: { hidden: [{ t: 3, value: true }] } })]]) {
        await f.refuse([{ op: 'node.layout', nodeId: f.nodeId, x: 999 }, f.set({ ...doc, objects })], 'scene.object_protected', { name: 'Figure' })
      }
      await f.write({ ...doc, objects: [object()] })
      expect(f.main().content).toEqual({ type: 'scene', doc })
    } finally { f.close() }
  })

  it.each([{ createdBy: 'user' as const, userTouched: false }, { createdBy: 'agent' as const, userTouched: true }])('protects existing view content and camera keys while preserving saved stills: %j', async protection => {
    const f = await setup()
    try {
      const still = f.host.assets.registerVersion(f.host.db, { staged: await f.host.assets.stageBytes(Buffer.from('saved frame')), kind: 'image', mime: 'image/png', origin: 'import' }).assetVersionId
      const doc: SceneDoc = { ...EMPTY_SCENE, durationS: 5, views: [view({ ...protection, still })] }
      f.host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [f.set(doc)] })
      for (const views of [[], [view({ name: 'Forged' })], [view({ aspectRatio: '1:1' })],
        [view({ camera: { ...view().camera, focalLengthMm: 85 } })],
        [view({ cameraKeys: [{ t: 3, value: view().camera, ease: 'hold' }] })]]) {
        await f.refuse([f.set({ ...doc, views })], 'scene.view_protected', { name: 'Wide' })
      }
      await f.write({ ...doc, views: [view({ still: 'nonexistent-forged-still' })] })
      expect(f.main().content).toEqual({ type: 'scene', doc })
    } finally { f.close() }
  })

  it('allows reordering protected objects and views, and editing or removing untouched Agent content', async () => {
    const doc: SceneDoc = { ...EMPTY_SCENE, durationS: 5,
      objects: [object({ createdBy: 'user' }), object({ id: 'agent' })],
      views: [view({ userTouched: true }), view({ id: 'agent' })] }
    const f = await setup(doc)
    try {
      const edited: SceneDoc = { ...doc,
        objects: [object({ id: 'agent', name: 'Walker', tracks: { pose: { leftKnee: [{ t: 2, value: [0, 0, 0, 1], ease: 'linear' }] } } }), doc.objects[0]!],
        views: [view({ id: 'agent', name: 'Tracking', still: 'forged', cameraKeys: [{ t: 2, value: view().camera, ease: 'easeInOut' }] }), doc.views[0]!] }
      await f.write(edited)
      expect(f.main().content).toEqual({ type: 'scene', doc: { ...edited, views: [{ ...edited.views[0], still: null }, doc.views[0]] } })
      await f.write({ ...doc, objects: [doc.objects[0]!], views: [doc.views[0]!] })
      expect(f.main().content).toEqual({ type: 'scene', doc: { ...doc, objects: [doc.objects[0]], views: [doc.views[0]] } })
    } finally { f.close() }
  })

  it('protects duration against every protected track kind, allows boundary shortening and trims Agent keys', async () => {
    const f = await setup()
    try {
      for (const protection of [{ createdBy: 'user' as const }, { userTouched: true }]) {
        const tracks: NonNullable<SceneObject['tracks']>[] = [
          { transform: [{ t: 4, value: object().transform, ease: 'linear' }] },
          { hidden: [{ t: 4, value: false }] },
          { pose: { leftKnee: [{ t: 4, value: [0, 0, 0, 1], ease: 'hold' }] } },
        ]
        const docs: SceneDoc[] = [
          ...tracks.map(tracks => ({ ...EMPTY_SCENE, durationS: 5, objects: [object({ ...protection, tracks })] })),
          { ...EMPTY_SCENE, durationS: 5, views: [view({ ...protection, cameraKeys: [{ t: 4, value: view().camera, ease: 'linear' }] })] },
        ]
        for (const doc of docs) {
          f.host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [f.set(doc)] })
          const pruned = { ...doc, objects: doc.objects.map(({ tracks: _tracks, ...item }) => item), views: doc.views.map(({ cameraKeys: _keys, ...item }) => item) }
          await f.refuse([f.set({ ...pruned, durationS: 3 })], 'scene.duration_protected')
          const { durationS: _duration, ...staticDoc } = pruned
          await f.refuse([f.set(staticDoc)], 'scene.duration_protected')
          await f.write({ ...doc, durationS: 4 })
          await f.write({ ...doc, durationS: 7 })
        }
      }
      const editable: SceneDoc = { ...EMPTY_SCENE, durationS: 5, objects: [object({ tracks: { hidden: [{ t: 4, value: true }] } })], views: [view({ createdBy: 'user' })] }
      f.host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [f.set(editable)] })
      await f.write({ ...editable, durationS: 2, objects: [object()] })
      const staticDoc = { ...EMPTY_SCENE, objects: [object()], views: editable.views }
      await f.write(staticDoc)
      await f.write({ ...staticDoc, durationS: 3 })
    } finally { f.close() }
  })

  it('deletes empty and fully Agent-owned scenes while refusing scenes containing any protected item', async () => {
    const f = await setup()
    const hint = 'Ask the author to delete the scene, or use scene.propose to propose deleting individual objects or views for the author to review'
    try {
      for (const doc of [
        { ...EMPTY_SCENE, objects: [object({ createdBy: 'user' })] },
        { ...EMPTY_SCENE, objects: [object({ userTouched: true })] },
        { ...EMPTY_SCENE, views: [view({ createdBy: 'user' })] },
        { ...EMPTY_SCENE, views: [view({ userTouched: true })] },
      ]) {
        f.host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [f.set(doc)] })
        await f.refuse([{ op: 'node.setMeta', nodeId: f.nodeId, title: 'Changed' }, { op: 'node.delete', nodeId: f.nodeId }], 'scene.user_only', {}, hint)
      }
      await f.a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', kind: 'image', tempId: f.nodeId }, { op: 'node.delete', nodeId: f.nodeId }] })
      expect(f.host.canvas.get({ nodeIds: [f.nodeId] }).nodes).toHaveLength(1)
      for (const doc of [EMPTY_SCENE, { ...EMPTY_SCENE, objects: [object()], views: [view()] }]) {
        f.host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [f.set(doc)] })
        const params = { requestId: rid(), ops: [{ op: 'node.create', kind: 'scene', tempId: 'fresh' }, { op: 'scene.set', slotId: 'fresh:main', expectedRevision: 1, doc }, { op: 'node.delete', nodeId: 'fresh' }] }
        const result = await f.a.call('canvas.apply', params)
        expect(f.host.canvas.get({ nodeIds: [result.idMap.fresh] }).nodes).toEqual([])
      }
      await f.write({ ...EMPTY_SCENE, objects: [object({ name: 'Author revision' })], views: [view()] }, f.c)
      await f.refuse([{ op: 'node.delete', nodeId: f.nodeId }], 'scene.user_only', {}, hint)
      f.host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [f.set({ ...EMPTY_SCENE, objects: [object()], views: [view()] })] })
      await f.a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.delete', nodeId: f.nodeId }] })
      expect(f.host.canvas.get({ nodeIds: [f.nodeId] }).nodes).toEqual([])
    } finally { f.close() }
  })

  it('stamps UI views from content diffs, retaining Agent ownership and ignoring still-only changes', async () => {
    const doc: SceneDoc = { ...EMPTY_SCENE, durationS: 5, objects: [object()], views: [view(), view({ id: 'already-touched', userTouched: true })] }
    const f = await setup(doc)
    try {
      const still = f.host.assets.registerVersion(f.host.db, { staged: await f.host.assets.stageBytes(Buffer.from('saved frame')), kind: 'image', mime: 'image/png', origin: 'import' }).assetVersionId
      const saved: SceneDoc = { ...doc, views: [view({ id: 'already-touched' }), view({ createdBy: 'user', userTouched: true, still })] }
      await f.write(saved, f.c)
      expect(f.main().content).toEqual({ type: 'scene', doc: { ...saved, views: [doc.views[1], view({ still })] } })
      await f.write({ ...saved, views: [view({ cameraKeys: [{ t: 3, value: view().camera, ease: 'linear' }] }), view({ id: 'new', still })] }, f.c)
      expect(f.main().content).toMatchObject({ type: 'scene', doc: { objects: [object()], views: [
        { id: 'wide', createdBy: 'agent', userTouched: true }, { id: 'new', createdBy: 'user', userTouched: true, still },
      ] } })
      await f.refuse([f.set(doc)], 'scene.view_protected', { name: 'Wide' })
    } finally { f.close() }
  })

  it('retains linked-session, active-workspace, archived-session and project write gates', async () => {
    const f = await setup()
    try {
      const blocked = async (ops: CanvasOp[], reason: string) => {
        const before = f.host.canvas.get({})
        await expect(f.a.call('canvas.apply', { requestId: rid(), ops })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason } } })
        expect(f.host.canvas.get({})).toEqual(before)
      }
      f.host.db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, f.session.sessionId)).run()
      await blocked([f.set(EMPTY_SCENE)], 'runtime.work_item_required')
      await blocked([{ op: 'node.create', kind: 'scene', tempId: 'fresh' }], 'runtime.work_item_required')
      await blocked([{ op: 'node.delete', nodeId: f.nodeId }], 'runtime.work_item_required')
      f.host.db.update(s.sessions).set({ workItemId: f.session.workItemId }).where(eq(s.sessions.id, f.session.sessionId)).run()
      f.host.db.update(s.workItems).set({ status: 'todo' }).where(eq(s.workItems.id, f.session.workItemId)).run()
      await blocked([f.set(EMPTY_SCENE)], 'work.execution_forbidden')
      f.host.db.update(s.workItems).set({ status: 'in_progress' }).where(eq(s.workItems.id, f.session.workItemId)).run()
      f.host.db.update(s.sessions).set({ archivedAt: Date.now() }).where(eq(s.sessions.id, f.session.sessionId)).run()
      await blocked([f.set(EMPTY_SCENE)], 'runtime.session_inactive')
      f.host.db.update(s.sessions).set({ archivedAt: null }).where(eq(s.sessions.id, f.session.sessionId)).run()
      await expect(f.a.call('canvas.apply', { requestId: rid(), spaceId: 'other-project', ops: [f.set(EMPTY_SCENE)] })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'runtime.agent_project_forbidden' } } })
    } finally { f.close() }
  })
})

it('lists only the latest project model versions through the UI gateway', async () => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const host = studiod.spaces.get(spaceId)!
  try {
    const staged = await host.assets.stageBytes(Buffer.from('model list fixture'))
    const first = host.assets.registerVersion(host.db, { staged, kind: 'model', mime: 'model/gltf-binary', origin: 'import', displayName: 'Bench' })
    const latest = host.assets.registerVersion(host.db, { staged, assetId: first.assetId, kind: 'model', mime: 'model/gltf-binary', origin: 'import' })
    const other = host.assets.registerVersion(host.db, { staged, kind: 'model', mime: 'model/gltf-binary', origin: 'import', displayName: 'Table' })
    host.assets.registerVersion(host.db, { staged, kind: 'font', mime: 'font/ttf', origin: 'import' })
    expect(await c.call('model.list', {})).toMatchObject({ models: expect.arrayContaining([
      expect.objectContaining({ assetVersionId: latest.assetVersionId, kind: 'model', displayName: 'Bench' }),
      expect.objectContaining({ assetVersionId: other.assetVersionId, kind: 'model', displayName: 'Table' }),
    ]) })
    expect((await c.call('model.list', {})).models).toHaveLength(2)
    expect((await c.call('asset.list', { usage: 'unused' })).items).toEqual([])
  } finally { c.close() }
})

it('stamps UI scene object authorship and touched state from authoritative diffs including temp-slot batches', async () => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const host = studiod.spaces.get(spaceId)!
  const object = (id: string, fields: Partial<SceneObject> = {}): SceneObject => ({
    id, name: 'Figure', hidden: false, createdBy: 'agent', userTouched: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    source: { type: 'primitive', shape: 'box', size: [1, 1, 1] }, ...fields,
  })
  try {
    const params = { requestId: rid(), ops: [
      { op: 'node.create', kind: 'scene', tempId: 'stage' },
      { op: 'scene.set', slotId: 'stage:main', expectedRevision: 1, doc: { ...EMPTY_SCENE, objects: [object('new')] } },
    ] }
    const created = await c.call('canvas.apply', params)
    const nodeId = created.idMap.stage
    const main = () => host.canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!
    expect(main().content).toMatchObject({ type: 'scene', doc: { objects: [object('new', { createdBy: 'user', userTouched: true })] } })
    expect(await c.call('canvas.apply', params)).toEqual(created)
    const doc: SceneDoc = { ...EMPTY_SCENE, objects: [object('untouched'), object('changed'), object('touched', { userTouched: true })] }
    host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'scene.set', slotId: main().slotId, expectedRevision: 2, doc }] })
    const edited: SceneDoc = { ...doc, objects: [
      object('untouched', { createdBy: 'user', userTouched: true }),
      object('changed', { name: 'Moved', createdBy: 'user', userTouched: false }),
      object('touched', { userTouched: false }),
      object('added'),
    ] }
    await c.call('canvas.apply', { requestId: rid(), ops: [
      { op: 'scene.set', slotId: main().slotId, expectedRevision: 3, doc: edited },
      { op: 'scene.set', slotId: main().slotId, expectedRevision: 4, doc: { ...edited, objects: edited.objects.map(item => item.id === 'changed' ? object('changed') : item) } },
    ] })
    expect(main().content).toEqual({ type: 'scene', doc: { ...edited, objects: [
      object('untouched'),
      object('changed', { userTouched: true }),
      object('touched', { userTouched: true }),
      object('added', { createdBy: 'user', userTouched: true }),
    ] } })
  } finally { c.close() }
})

it('keeps panel scene references user-only while allowing absent and null round trips and unchanged blockouts', async () => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const host = studiod.spaces.get(spaceId)!
  const created = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', kind: 'previz', tempId: 'p' }] })
  const nodeId = created.idMap.p
  const slot = () => host.canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!
  const doc = { ...EMPTY_PREVIZ, panels: [emptyPrevizPanel('panel')] }
  await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: slot().slotId, expectedRevision: 1, doc }] })
  const session = await c.call('session.create', { requestId: rid() })
  await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Annotate the panel', refs: [] })
  await until(() => dispatched.length === 1)
  const a = await agent(dispatched[0]!.token)
  const reference = { sceneNodeId: 'scene', viewId: 'wide', sceneRev: 1 }
  const forbidden = { code: 'forbidden', rpc: { data: { reason: 'previz.scene_ref_user_only' } } }
  try {
    for (const sceneRef of [null, undefined]) {
      const panels = [{ ...emptyPrevizPanel('panel'), ...(sceneRef === null ? { sceneRef } : {}), note: 'Agent note' }]
      await a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: slot().slotId, expectedRevision: slot().revision, doc: { ...doc, panels } }] })
    }
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: slot().slotId, expectedRevision: slot().revision, doc: { ...doc, panels: [{ ...doc.panels[0], sceneRef: reference }] } }] })).rejects.toMatchObject(forbidden)
    const blockout = host.assets.registerVersion(host.db, { staged: await host.assets.stageBytes(Buffer.from('blockout')), kind: 'image', mime: 'image/png', origin: 'import' }).assetVersionId
    const linked = { ...doc, panels: [{ ...emptyPrevizPanel('panel'), blockout, sceneRef: reference }] }
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: slot().slotId, expectedRevision: slot().revision, doc: linked }] })
    await a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: slot().slotId, expectedRevision: slot().revision, doc: { ...linked, panels: [{ ...linked.panels[0], sceneRef: { ...reference }, note: 'Allowed' }] } }] })
    for (const sceneRef of [null, undefined, { ...reference, sceneRev: 2 }, { ...reference, viewId: 'close' }, { ...reference, sceneNodeId: 'other' }]) {
      const panel = { ...emptyPrevizPanel('panel'), blockout, ...(sceneRef === undefined ? {} : { sceneRef }) }
      await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: slot().slotId, expectedRevision: slot().revision, doc: { ...doc, panels: [panel] } }] })).rejects.toMatchObject(forbidden)
    }
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: slot().slotId, expectedRevision: slot().revision, doc: { ...doc, panels: [] } }] })).rejects.toMatchObject(forbidden)
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [
      { op: 'previz.set', slotId: slot().slotId, expectedRevision: slot().revision, doc: { ...linked, panels: [{ ...linked.panels[0], note: 'Earlier edit' }] } },
      { op: 'previz.set', slotId: slot().slotId, expectedRevision: slot().revision + 1, doc: { ...doc, panels: [] } },
    ] })).rejects.toMatchObject(forbidden)
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [
      { op: 'node.create', kind: 'previz', tempId: 'fresh' },
      { op: 'previz.set', slotId: 'fresh:main', expectedRevision: 1, doc: { ...doc, panels: [{ ...emptyPrevizPanel('new'), sceneRef: reference }] } },
      { op: 'previz.set', slotId: 'fresh:main', expectedRevision: 2, doc },
    ] })).rejects.toMatchObject(forbidden)
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: slot().slotId, expectedRevision: slot().revision, doc: { ...linked, panels: [{ ...linked.panels[0], blockout: null }] } }] })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'previz.blockout_user_only' } } })
  } finally { a.close(); c.close() }
})

it('protects previz pictures in the gateway while allowing agent metadata edits and new panels', async () => {
  const { EMPTY_PREVIZ, emptyPrevizPanel } = await import('@vis/protocol')
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const host = studiod.spaces.get(spaceId)!
  const asset = host.assets.registerVersion(host.db, { staged: await host.assets.stageBytes(Buffer.from('image')), kind: 'image', mime: 'image/png', origin: 'import' }).assetVersionId
  const created = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'p', kind: 'previz' }] })
  const nodeId = created.idMap.p
  const slot = host.canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!
  const doc = { ...EMPTY_PREVIZ, panels: [{ ...emptyPrevizPanel('protected'), underlay: asset, sketch: asset, image: asset }] }
  await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: slot.slotId, expectedRevision: 1, doc }] })
  const session = await c.call('session.create', { requestId: rid() })
  await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Annotate the previz', refs: [] })
  await until(() => dispatched.length === 1)
  const a = await agent(dispatched[0]!.token)
  try {
    for (const key of ['underlay', 'sketch', 'image']) for (const value of [null, 'replacement']) {
      await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: slot.slotId, expectedRevision: 2, doc: { ...doc, panels: [{ ...doc.panels[0], [key]: value }] } }] })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'previz.drawing_protected' } } })
    }
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: slot.slotId, expectedRevision: 2, doc: EMPTY_PREVIZ }] })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.delete', nodeId }] })).rejects.toMatchObject({ code: 'forbidden' })
    const allowed = { ...doc, panels: [{ ...doc.panels[0], note: 'Pan left', durationSec: 2 }, emptyPrevizPanel('new')] }
    await a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: slot.slotId, expectedRevision: 2, doc: allowed }] })
    expect(host.canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!.content).toEqual({ type: 'previz', doc: allowed })
    const fresh = { ...EMPTY_PREVIZ, panels: [{ ...emptyPrevizPanel('new'), image: asset }] }
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [
      { op: 'node.create', kind: 'previz', tempId: 'fresh' },
      { op: 'previz.set', slotId: 'fresh:main', expectedRevision: 1, doc: fresh },
      { op: 'previz.set', slotId: 'fresh:main', expectedRevision: 2, doc: EMPTY_PREVIZ },
    ] })).rejects.toMatchObject({ code: 'forbidden' })
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'previz.set', slotId: slot.slotId, expectedRevision: 3, doc: EMPTY_PREVIZ }] })
  } finally { a.close(); c.close() }
})

it('protects the latest user text against Agent replacement, clear and code conversion, while allowing Agent drafts', async () => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const created = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'book', kind: 'text', format: 'markdown', content: { text: '清晨有雾。林舟回家。' } }] })
  const nodeId = created.idMap.book
  const session = await c.call('session.create', { requestId: rid() })
  await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Review prose', refs: [] })
  await until(() => dispatched.length === 1)
  const a = await agent(dispatched[0]!.token)
  const get = async (id: string) => (await c.call('canvas.get', { nodeIds: [id] })).nodes[0]
  try {
    const slot = (await get(nodeId)).slots[0]
    for (const ops of [
      [{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: 1, body: 'Overwritten' }],
      [{ op: 'slot.clear', slotId: slot.slotId, expectedRevision: 1 }],
      [{ op: 'node.setMeta', nodeId, format: 'code' }],
      [{ op: 'node.setMeta', nodeId, format: 'code' }, { op: 'slot.setText', slotId: slot.slotId, expectedRevision: 1, body: 'Overwritten' }],
    ]) await expect(a.call('canvas.apply', { requestId: rid(), ops })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'writing.propose_required' } } })
    expect(await get(nodeId)).toMatchObject({ format: 'markdown', slots: [{ revision: 1, content: { type: 'text', body: '清晨有雾。林舟回家。' } }] })
    const proposal = await a.call('text.propose', { requestId: rid(), slotId: slot.slotId, baseRevision: 1, summary: 'Clarify', edits: [{ find: '清晨有雾', replace: '晨雾弥漫' }] })
    expect(proposal.sessionId).toBe(session.sessionId)
    await expect(a.call('text.proposal.resolve', { requestId: rid(), slotId: slot.slotId, action: 'reject', edits: [{ proposalId: proposal.proposalId, editId: proposal.edits[0].editId }] })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(c.call('text.propose', { requestId: rid(), slotId: slot.slotId, baseRevision: 1, summary: 'Wrong caller', edits: [{ find: '雾', replace: '' }] })).rejects.toMatchObject({ code: 'forbidden' })
    const draft = await a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'draft', kind: 'text', content: { text: 'Agent first draft' } }] })
    const draftId = draft.idMap.draft
    const draftSlot = (await get(draftId)).slots[0]
    await a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'slot.setText', slotId: draftSlot.slotId, expectedRevision: 1, body: 'Agent second draft' }] })
    expect((await get(draftId)).slots[0]).toMatchObject({ revision: 2, content: { body: 'Agent second draft' }, writer: { actor: 'agent' } })
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'slot.setText', slotId: draftSlot.slotId, expectedRevision: 2, body: 'Writer revision' }] })
    await expect(a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'slot.setText', slotId: draftSlot.slotId, expectedRevision: 3, body: 'Agent third draft' }] })).rejects.toMatchObject({ rpc: { data: { reason: 'writing.propose_required' } } })
    dispatched[0]!.end()
    await expect(a.call('text.propose', { requestId: rid(), slotId: slot.slotId, baseRevision: 1, summary: 'Inactive', edits: [{ find: '雾', replace: '' }] })).rejects.toMatchObject({ code: 'forbidden' })
  } finally { a.close(); c.close() }
})

it('reads only other manuscript nodes in the same series, in episode order, with empty standalone results', async () => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const session = await c.call('session.create', { requestId: rid() })
  await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Read continuity', refs: [] })
  await until(() => dispatched.length === 1)
  const a = await agent(dispatched[0]!.token)
  try {
    expect(await a.call('series.textList')).toEqual({ episodes: [] })
    const series = await c.call('series.create', { requestId: rid(), name: 'Novel' })
    await c.call('space.setSeries', { requestId: rid(), spaceId, episode: 3, series: { seriesId: series.seriesId } })
    const later = await c.call('space.create', { requestId: rid(), name: 'Second chapter', episode: 2, series: { seriesId: series.seriesId } })
    const earlier = await c.call('space.create', { requestId: rid(), name: 'First chapter', episode: 1, series: { seriesId: series.seriesId } })
    const outside = await c.call('space.create', { requestId: rid(), name: 'Outside' })
    await c.call('events.subscribe', { spaceId: earlier.spaceId })
    const created = await c.call('canvas.apply', { requestId: rid(), ops: [
      { op: 'node.create', tempId: 'chapter', kind: 'text', title: '第一章', format: 'markdown', content: { text: '# 第一章\n林舟回家。' } },
      { op: 'node.create', tempId: 'notes', kind: 'text', purpose: 'working', content: { text: 'Private work notes' } },
      { op: 'node.create', tempId: 'code', kind: 'text', format: 'code', content: { text: 'HTML' } },
    ] })
    const openedBefore = studiod.spaces.opened().map(host => host.spaceId).sort()
    const list = await a.call('series.textList')
    expect(list.episodes.map((episode: { spaceId: string; episode: number }) => [episode.spaceId, episode.episode])).toEqual([[earlier.spaceId, 1], [later.spaceId, 2]])
    expect(list.episodes[0].nodes).toEqual([{ nodeId: created.idMap.chapter, slotId: expect.any(String), title: '第一章', revision: 1, words: 7 }])
    expect(list.episodes[1].nodes).toEqual([])
    expect(await a.call('series.textRead', { spaceId: earlier.spaceId, nodeId: created.idMap.chapter })).toMatchObject({ body: '# 第一章\n林舟回家。', format: 'markdown', revision: 1 })
    for (const nodeId of [created.idMap.notes, created.idMap.code]) await expect(a.call('series.textRead', { spaceId: earlier.spaceId, nodeId })).rejects.toMatchObject({ code: 'not_found' })
    await expect(a.call('series.textRead', { spaceId: outside.spaceId, nodeId: created.idMap.chapter })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'writing.same_series_required' } } })
    expect(studiod.spaces.opened().map(host => host.spaceId).sort()).toEqual(openedBefore)
  } finally { dispatched[0]!.end(); a.close(); c.close() }
})

it('requires real, revision-pinned user approval for Agent deletion of writer-owned text', async () => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const session = await c.call('session.create', { requestId: rid() })
  await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Delete manuscript', refs: [] })
  await until(() => dispatched.length === 1)
  const a = await agent(dispatched[0]!.token)
  const make = async () => {
    const result = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'book', kind: 'text', title: 'Author chapter', content: { text: 'Writer prose' } }] })
    return result.idMap.book as string
  }
  const live = async (nodeId: string) => (await c.call('canvas.get', { nodeIds: [nodeId] })).nodes[0]
  try {
    const nodeId = await make()
    const frame = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'frame.create', tempId: 'frame', title: 'Chapter frame', x: 0, y: 0, w: 600, h: 600 }] })
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.layout', nodeId, x: 50, y: 50 }] })
    expect((await live(nodeId)).frameId).toBe(frame.idMap.frame)
    await a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.delete', nodeId: frame.idMap.frame }] })
    expect(await live(nodeId)).toBeDefined()
    for (const ops of [[{ op: 'node.delete', nodeId }], [{ op: 'node.layout', nodeId, z: 99 }, { op: 'node.delete', nodeId }]]) {
      await expect(a.call('canvas.apply', { requestId: rid(), ops })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'writing.delete_protected' } } })
    }
    expect((await live(nodeId)).z).not.toBe(99)
    const request = { requestId: rid(), nodeId, expectedRevision: 1 }
    const approval = await a.call('text.requestDelete', request)
    expect(await a.call('text.requestDelete', request)).toEqual(approval)
    expect(approval.status).toBe('pending')
    const item = (await c.call('session.getTranscript', { sessionId: session.sessionId })).items.find((item: { itemId: string }) => item.itemId === approval.approvalId)
    expect(item.payload).toMatchObject({ kind: 'text_delete', status: 'pending', textDelete: { nodeId, title: 'Author chapter', revision: 1 } })
    await expect(a.call('session.respondApproval', { requestId: rid(), approvalId: approval.approvalId, decision: 'allow_once' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(c.call('session.respondApproval', { requestId: rid(), approvalId: approval.approvalId, decision: 'allow_session' })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(await live(nodeId)).toBeDefined()
    const decision = { requestId: rid(), approvalId: approval.approvalId, decision: 'allow_once' }
    expect(await c.call('session.respondApproval', decision)).toEqual({ status: 'approved' })
    expect(await c.call('session.respondApproval', decision)).toEqual({ status: 'approved' })
    expect(await live(nodeId)).toBeUndefined()
    const deniedId = await make()
    const denied = await a.call('text.requestDelete', { requestId: rid(), nodeId: deniedId, expectedRevision: 1 })
    expect(await c.call('session.respondApproval', { requestId: rid(), approvalId: denied.approvalId, decision: 'deny' })).toEqual({ status: 'denied' })
    expect(await live(deniedId)).toBeDefined()
    const changed = await a.call('text.requestDelete', { requestId: rid(), nodeId: deniedId, expectedRevision: 1 })
    const slotId = (await live(deniedId)).slots[0].slotId
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'slot.setText', slotId, expectedRevision: 1, body: 'New author draft' }] })
    expect(await c.call('session.respondApproval', { requestId: rid(), approvalId: changed.approvalId, decision: 'allow_once' })).toEqual({ status: 'expired' })
    expect((await live(deniedId)).slots[0]).toMatchObject({ revision: 2, content: { body: 'New author draft' } })
    const own = await a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'own', kind: 'text', content: { text: 'Agent draft' } }] })
    await a.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.delete', nodeId: own.idMap.own }] })
    expect(await live(own.idMap.own)).toBeUndefined()
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.delete', nodeId: deniedId }] })
    expect(await live(deniedId)).toBeUndefined()
  } finally { dispatched[0]!.end(); a.close(); c.close() }
})

it('splits a frozen manuscript sequentially, reports partial failures and replays completed chapters without writes', async () => {
  const { writingChapters } = await import('@vis/protocol')
  const c = await ui()
  try {
    await c.call('events.subscribe', { spaceId })
    const body = '# Dawn\n\nA quiet river.\n\n# Night\n\nThe letter arrives.\n'
    const created = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'book', kind: 'text', format: 'markdown', content: { text: body } }] })
    const nodeId = created.idMap.book
    const series = await c.call('series.create', { requestId: rid(), name: 'River letters' })
    await c.call('space.setSeries', { requestId: rid(), spaceId, series: { seriesId: series.seriesId }, episode: 1 })
    const occupied = await c.call('space.create', { requestId: rid(), name: 'Occupied episode', series: { seriesId: series.seriesId }, episode: 3 })
    const chapters = writingChapters(body).map((chapter, index) => ({ from: chapter.from, to: chapter.to, name: chapter.title, episode: index + 2 }))
    const params = { requestId: rid(), nodeId, expectedRevision: 1, chapters }
    const first = await c.call('writing.split', params)
    expect(first.chapters.map((chapter: any) => [chapter.name, chapter.status, chapter.skipped])).toEqual([['Dawn', 'succeeded', false], ['Night', 'failed', false]])
    const episode = studiod.spaces.get(first.chapters[0].spaceId)!
    const copy = episode.canvas.get({}).nodes[0]!
    expect(copy.slots[0]!.content).toEqual({ type: 'text', body: body.slice(chapters[0]!.from, chapters[0]!.to) })
    const original = studiod.spaces.get(spaceId)!.canvas.get({ nodeIds: [nodeId] }).nodes[0]!
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'slot.setText', slotId: original.slots[0]!.slotId, expectedRevision: 1, body: 'The writer keeps working.' }] })
    // Completed copies belong to the writer too; retry must not restore the original snapshot over a later edit.
    episode.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'slot.setText', slotId: copy.slots[0]!.slotId, expectedRevision: 1, body: 'Edited episode' }] })
    await c.call('space.setSeries', { requestId: rid(), spaceId: occupied.spaceId, series: null })
    const second = await c.call('writing.split', params)
    expect(second.chapters.map((chapter: any) => [chapter.status, chapter.skipped])).toEqual([['succeeded', true], ['succeeded', false]])
    expect(second.chapters[0].spaceId).toBe(first.chapters[0].spaceId)
    expect(episode.canvas.get({}).nodes).toHaveLength(1)
    expect(episode.canvas.get({}).nodes[0]!.slots[0]).toMatchObject({ revision: 2, content: { type: 'text', body: 'Edited episode' } })
    expect(studiod.spaces.get(second.chapters[1].spaceId)!.canvas.get({}).nodes[0]!.slots[0]!.content).toEqual({ type: 'text', body: body.slice(chapters[1]!.from, chapters[1]!.to) })
    expect(studiod.spaces.get(spaceId)!.canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!.content).toEqual({ type: 'text', body: 'The writer keeps working.' })
    expect((await c.call('writing.split', params)).chapters.map((chapter: any) => chapter.skipped)).toEqual([true, true])
    await expect(c.call('writing.split', { ...params, chapters: [{ ...chapters[0], name: 'Changed request' }] })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect((await c.call('space.list')).spaces).toHaveLength(4)
  } finally { c.close() }
})

it('joins a standalone manuscript to a series and refuses invalid splitting ranges or stale revisions before creating projects', async () => {
  const c = await ui()
  try {
    await c.call('events.subscribe', { spaceId })
    const body = '# Opening\n\nA traveler arrives.'
    const nodeId = (await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'book', kind: 'text', content: { text: body } }] })).idMap.book
    const params = { nodeId, expectedRevision: 1, series: { name: 'Travelers' }, chapters: [{ from: 0, to: body.length, name: 'Opening', episode: 2 }] }
    await expect(c.call('writing.split', { ...params, requestId: rid(), expectedRevision: 0 })).rejects.toMatchObject({ code: 'revision_conflict' })
    await expect(c.call('writing.split', { ...params, requestId: rid(), chapters: [{ ...params.chapters[0], from: 1 }] })).rejects.toMatchObject({ code: 'invalid_params' })
    expect((await c.call('space.list')).spaces).toHaveLength(1)
    const result = await c.call('writing.split', { ...params, requestId: rid() })
    expect(result.chapters[0]).toMatchObject({ status: 'succeeded', skipped: false, episode: 2 })
    const spaces = (await c.call('space.list')).spaces
    expect(spaces.map((space: any) => space.series.name)).toEqual(['Travelers', 'Travelers'])
    expect(spaces.map((space: any) => space.series.episode).sort()).toEqual([1, 2])
    const session = await c.call('session.create', { requestId: rid() })
    await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Probe split permissions', refs: [] })
    await until(() => dispatched.length === 1)
    const a = await agent(dispatched[0]!.token)
    try { expect((await a.raw('writing.split', {})).error?.data?.code).toBe('forbidden') } finally { a.close() }
  } finally { c.close() }
})

it('resumes split receipts after a daemon restart and never duplicates a committed text write whose response was lost', async () => {
  const { writingChapters } = await import('@vis/protocol')
  let c = await ui()
  try {
    await c.call('events.subscribe', { spaceId })
    const body = '# First\n\nOne.\n\n# Middle\n\nTwo.\n\n# Last\n\nThree.'
    const nodeId = (await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'book', kind: 'text', content: { text: body } }] })).idMap.book
    const chapters = writingChapters(body).map((chapter, index) => ({ from: chapter.from, to: chapter.to, name: chapter.title, episode: index + 2 }))
    const params = { requestId: 'r'.repeat(128), nodeId, expectedRevision: 1, series: { name: 'Restart series' }, chapters }
    const create = studiod.spaces.create
    const order: string[] = []
    const fault = vi.spyOn(studiod.spaces, 'create').mockImplementation(input => {
      const project = create(input)
      order.push(project.name)
      if (project.name === 'Middle') {
        const target = studiod.spaces.get(project.spaceId)!
        const apply = target.canvas.apply
        vi.spyOn(target.canvas, 'apply').mockImplementationOnce((actor, params) => {
          apply(actor, params)
          throw new Error('Injected loss of a committed chapter response')
        })
      }
      return project
    })
    const first = await c.call('writing.split', params)
    fault.mockRestore()
    expect(order).toEqual(['First', 'Middle', 'Last'])
    expect(first.chapters.map((chapter: any) => chapter.status)).toEqual(['succeeded', 'failed', 'succeeded'])
    const middleId = first.chapters[1].spaceId
    expect(studiod.spaces.get(middleId)!.canvas.get({}).nodes).toHaveLength(1)
    c.close()
    await studiod.stop('user_quit')
    studiod = await startStudiod({ dataDir: dir, studiodVersion: 'split-restart-test', runtimes: { codex: fakeRuntime }, providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } } })
    c = await ui()
    await c.call('events.subscribe', { spaceId })
    const result = await c.call('writing.split', params)
    expect(result.chapters.map((chapter: any) => [chapter.status, chapter.skipped])).toEqual([['succeeded', true], ['succeeded', false], ['succeeded', true]])
    expect(result.chapters[1].spaceId).toBe(middleId)
    const middle = studiod.spaces.get(middleId)!.canvas.get({}).nodes
    expect(middle).toHaveLength(1)
    expect(middle[0]!.slots[0]).toMatchObject({ revision: 1, content: { type: 'text', body: body.slice(chapters[1]!.from, chapters[1]!.to) } })
    expect((await c.call('space.list')).spaces).toHaveLength(4)
    expect(studiod.spaces.get(spaceId)!.canvas.get({ nodeIds: [nodeId] }).nodes[0]!.slots[0]!.content).toEqual({ type: 'text', body })
  } finally { c.close() }
})

describe('Agent-requested child cleanup at the gateway', () => {
  async function setup() {
    const c = await ui()
    await c.call('events.subscribe', { spaceId })
    const session = await c.call('session.create', { requestId: rid(), title: 'Cleanup author' })
    await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Clean up selected children', refs: [] })
    await until(() => dispatched.some(turn => turn.sessionId === session.sessionId))
    const turn = dispatched.find(turn => turn.sessionId === session.sessionId)!
    const a = await agent(turn.token)
    const child = async (title: string, activate = false) => (await a.call('work.dispatch', { requestId: rid(), title, brief: 'Keep useful results', agentKind: 'codex', activate })).item
    const first = await child('Exploration A')
    const second = await child('Exploration B')
    const host = studiod.spaces.get(spaceId)!
    const request = (workItemIds = [first.workItemId, second.workItemId]) => a.call('work.requestDelete', { requestId: rid(), workItemIds })
    const payload = async (approvalId: string) => (await c.call('session.getTranscript', { sessionId: session.sessionId })).items.find((item: any) => item.itemId === approvalId).payload
    const respond = (approvalId: string, decision = 'allow_once', requestId = rid()) => c.call('session.respondApproval', { requestId, approvalId, decision })
    return { c, a, session, turn, child, first, second, host, request, payload, respond }
  }

  it('recovers approved target plans across a daemon restart without repeating deletions or delivering the audit records', async () => {
    const x = await setup()
    const approval = await x.request()
    const original = x.host.work.delete.bind(x.host.work)
    const remove = vi.spyOn(x.host.work, 'delete').mockImplementation(async params => {
      if (params.workItemId === x.first.workItemId) throw new Error('Simulated interruption before deletion')
      return original(params)
    })
    expect(await x.respond(approval.approvalId)).toEqual({ status: 'approved' })
    remove.mockRestore()
    x.a.close(); x.c.close()
    await studiod.stop('user_quit')
    studiod = await startStudiod({ dataDir: dir, studiodVersion: 'cleanup-restart', runtimes: { codex: fakeRuntime }, providers: [createMockProvider()], defaults: { image: { provider: 'mock' } }, media })
    const c = await ui()
    try {
      await c.call('events.subscribe', { spaceId })
      const host = studiod.spaces.get(spaceId)!
      for (const id of [x.first.workItemId, x.second.workItemId]) expect(host.db.select().from(s.workItems).where(eq(s.workItems.id, id)).get()?.archivedAt).not.toBeNull()
      expect((await c.call('work.list')).items.map((item: any) => item.workItemId)).toEqual([x.session.workItemId])
      const audits = host.db.select().from(s.workMessages).where(eq(s.workMessages.workItemId, x.session.workItemId)).all().filter(message => message.kind === 'deleted')
      expect(audits).toHaveLength(2)
      expect(audits.every(message => message.targetSessionId === null && message.deliveryId === null)).toBe(true)
      const seq = currentSeq(host.db)
      expect(await c.call('session.respondApproval', { requestId: rid(), approvalId: approval.approvalId, decision: 'allow_once' })).toEqual({ status: 'approved' })
      expect(currentSeq(host.db)).toBe(seq)
      expect(dispatched.filter(turn => turn.sessionId === x.session.sessionId)).toHaveLength(1)
    } finally { c.close() }
  })

  it('refuses children, unlinked sessions, inactive turns and whole requests with a non-child or grandchild without creating a card', async () => {
    const x = await setup()
    try {
      const unrelated = (await x.c.call('work.create', { requestId: rid(), title: 'Unrelated root' })).item
      const grandchild = (await x.c.call('work.create', { requestId: rid(), title: 'Nested legacy child' })).item
      x.host.db.update(s.workItems).set({ parentId: x.first.workItemId }).where(eq(s.workItems.id, grandchild.workItemId)).run()
      for (const invalid of [unrelated.workItemId, grandchild.workItemId, x.session.workItemId, 'missing']) {
        await expect(x.request([x.first.workItemId, invalid])).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'work.delete_not_child' } } })
      }
      await x.c.call('work.activate', { requestId: rid(), workItemId: x.first.workItemId })
      await until(() => dispatched.some(turn => turn.sessionId === x.first.sessions[0].sessionId))
      const childAgent = await agent(dispatched.find(turn => turn.sessionId === x.first.sessions[0].sessionId)!.token)
      await expect(childAgent.call('work.requestDelete', { requestId: rid(), workItemIds: [grandchild.workItemId] })).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'work.delete_root_required' } } })
      childAgent.close()
      x.host.db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, x.session.sessionId)).run()
      await expect(x.request()).rejects.toMatchObject({ code: 'forbidden', rpc: { data: { reason: 'runtime.work_item_required' } } })
      const entries = (await x.c.call('session.getTranscript', { sessionId: x.session.sessionId })).items
      expect(entries.filter((item: any) => item.kind === 'approval')).toEqual([])
      expect((await x.c.call('work.get', { workItemId: x.first.workItemId })).item.archivedAt).toBeNull()
      x.turn.end()
      await expect(x.request()).rejects.toMatchObject({ code: 'forbidden' })
    } finally { x.a.close(); x.c.close() }
  })

  it('requires a once-only UI click even in auto mode, deduplicates retries, keeps canvas and the requesting turn, and never delivers a stale parent batch', async () => {
    const x = await setup()
    try {
      await x.c.call('session.setApprovalMode', { requestId: rid(), sessionId: x.session.sessionId, mode: 'auto' })
      const canvas = await x.c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'kept', kind: 'text', content: { text: 'Author keeps this result' } }] })
      const params = { requestId: rid(), workItemIds: [x.first.workItemId, x.second.workItemId] }
      const approval = await x.a.call('work.requestDelete', params)
      expect(await x.a.call('work.requestDelete', params)).toEqual(approval)
      expect(await x.payload(approval.approvalId)).toMatchObject({ kind: 'work_delete', status: 'pending', workDelete: { items: [{ workItemId: x.first.workItemId, title: x.first.title }, { workItemId: x.second.workItemId, title: x.second.title }], runningTurns: 0 } })
      expect((await x.payload(approval.approvalId)).auto).toBeUndefined()
      expect(x.host.db.select().from(s.turns).where(eq(s.turns.id, x.turn.turnId)).get()?.status).toBe('running')
      await expect(x.a.call('session.respondApproval', { requestId: rid(), approvalId: approval.approvalId, decision: 'allow_once' })).rejects.toMatchObject({ code: 'forbidden' })
      await expect(x.respond(approval.approvalId, 'allow_session')).rejects.toMatchObject({ code: 'invalid_params', rpc: { data: { reason: 'work.delete_once_only' } } })
      expect((await x.c.call('work.list')).items).toHaveLength(3)
      const click = rid()
      expect(await x.respond(approval.approvalId, 'allow_once', click)).toEqual({ status: 'approved' })
      const seq = currentSeq(x.host.db)
      expect(await x.respond(approval.approvalId, 'allow_once', click)).toEqual({ status: 'approved' })
      expect(await x.respond(approval.approvalId)).toEqual({ status: 'approved' })
      expect(currentSeq(x.host.db)).toBe(seq)
      expect((await x.c.call('work.list')).items.map((item: any) => item.workItemId)).toEqual([x.session.workItemId])
      expect((await x.c.call('canvas.get', { nodeIds: [canvas.idMap.kept] })).nodes[0].slots[0].content.body).toBe('Author keeps this result')
      expect(x.host.db.select().from(s.turns).where(eq(s.turns.id, x.turn.turnId)).get()?.status).toBe('running')
      const audit = x.host.db.select().from(s.workMessages).where(eq(s.workMessages.workItemId, x.session.workItemId)).all().filter(message => message.kind === 'deleted')
      expect(audit).toHaveLength(2)
      expect(audit.every(message => message.targetSessionId === null && message.deliveryId === null)).toBe(true)
      x.turn.end()
      await until(() => !x.host.sessions.list({}).sessions.find(session => session.sessionId === x.session.sessionId)?.activeTurnId)
      await x.host.sessions.idle()
      expect(dispatched.filter(turn => turn.sessionId === x.session.sessionId)).toHaveLength(1)
      await x.c.call('session.sendMessage', { requestId: rid(), sessionId: x.session.sessionId, text: 'What remains?', refs: [] })
      await until(() => dispatched.filter(turn => turn.sessionId === x.session.sessionId).length === 2)
      const next = dispatched.filter(turn => turn.sessionId === x.session.sessionId)[1]!
      expect(next.text).toBe('What remains?')
      for (const message of audit) expect(next.text).not.toContain(message.id)
      next.end()
    } finally { x.a.close(); x.c.close() }
  })

  it.each(['runningTurns', 'unfinishedJobs', 'childrenTotal', 'unresolvedMessages', 'hasUnreviewedReport'] as const)('expires the whole card when %s grows and deletes nothing', async field => {
    const x = await setup()
    try {
      const approval = await x.request()
      const db = x.host.db, at = Date.now()
      if (field === 'runningTurns') {
        await x.c.call('work.activate', { requestId: rid(), workItemId: x.second.workItemId })
        await until(() => dispatched.some(turn => turn.sessionId === x.second.sessions[0].sessionId))
      } else if (field === 'unfinishedJobs') {
        db.insert(s.generationJobs).values({ id: 'growth-job', sessionId: x.second.sessions[0].sessionId, kind: 'image', provider: 'mock', model: 'mock-image', params: {}, status: 'queued', createdAt: at, updatedAt: at }).run()
      } else if (field === 'childrenTotal') {
        db.insert(s.workItems).values({ id: 'nested-growth', parentId: x.second.workItemId, title: 'Legacy nested work', workDir: x.second.workDir, createdBy: { kind: 'user' }, createdAt: at, statusChangedAt: at }).run()
      } else {
        db.insert(s.workMessages).values({ id: 'new-report', workItemId: x.second.workItemId, kind: field === 'hasUnreviewedReport' ? 'done' : 'question', from: { kind: 'user' }, to: 'user', body: 'New consequence', createdAt: at }).run()
        if (field === 'hasUnreviewedReport') db.update(s.workItems).set({ status: 'in_review', reviewReportId: 'new-report' }).where(eq(s.workItems.id, x.second.workItemId)).run()
      }
      expect(await x.respond(approval.approvalId)).toEqual({ status: 'expired' })
      expect((await x.payload(approval.approvalId)).status).toBe('expired')
      for (const id of [x.first.workItemId, x.second.workItemId]) expect((await x.c.call('work.get', { workItemId: id })).item.archivedAt).toBeNull()
      expect(db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.method, 'work.delete')).all()).toEqual([])
    } finally { x.a.close(); x.c.close() }
  })

  it('approves shrinking plans, archives nested children, and treats denial as keeping everything', async () => {
    const x = await setup()
    try {
      const db = x.host.db, at = Date.now()
      await x.c.call('work.activate', { requestId: rid(), workItemId: x.first.workItemId })
      await until(() => dispatched.some(turn => turn.sessionId === x.first.sessions[0].sessionId))
      db.insert(s.workItems).values({ id: 'nested', parentId: x.first.workItemId, title: 'Nested', workDir: x.first.workDir, createdBy: { kind: 'user' }, createdAt: at, statusChangedAt: at }).run()
      db.insert(s.workMessages).values({ id: 'question', workItemId: x.first.workItemId, kind: 'question', from: { kind: 'user' }, to: 'user', body: 'A question', createdAt: at }).run()
      const approval = await x.request([x.first.workItemId])
      expect((await x.payload(approval.approvalId)).workDelete).toMatchObject({ runningTurns: 1, childrenTotal: 1, unresolvedMessages: 1 })
      dispatched.find(turn => turn.sessionId === x.first.sessions[0].sessionId)!.end()
      db.update(s.workMessages).set({ resolvedBy: 'question' }).where(eq(s.workMessages.id, 'question')).run()
      await x.c.call('work.delete', { requestId: rid(), workItemId: 'nested' })
      expect(await x.respond(approval.approvalId)).toEqual({ status: 'approved' })
      const kept = await x.request([x.second.workItemId])
      expect(await x.respond(kept.approvalId, 'deny')).toEqual({ status: 'denied' })
      expect(await x.respond(kept.approvalId)).toEqual({ status: 'denied' })
      expect((await x.c.call('work.get', { workItemId: x.second.workItemId })).item.archivedAt).toBeNull()
      expect(x.host.db.select().from(s.turns).where(eq(s.turns.id, x.turn.turnId)).get()?.status).toBe('running')
    } finally { x.a.close(); x.c.close() }
  })

  it.each(['deadline', 'archived_session', 'ended_work', 'gone_target', 'reparented_target'] as const)('expires when %s invalidates the request', async cause => {
    const x = await setup()
    try {
      const approval = await x.request(), db = x.host.db
      if (cause === 'deadline') {
        const row = db.select().from(s.transcriptEntries).where(eq(s.transcriptEntries.itemId, approval.approvalId)).get()!
        const payload = row.payload as any
        db.update(s.transcriptEntries).set({ payload: { ...payload, workDelete: { ...payload.workDelete, expiresAt: Date.now() - 1 } } }).where(eq(s.transcriptEntries.itemId, row.itemId)).run()
      } else if (cause === 'archived_session') db.update(s.sessions).set({ archivedAt: Date.now() }).where(eq(s.sessions.id, x.session.sessionId)).run()
      else if (cause === 'ended_work') await x.c.call('work.move', { requestId: rid(), workItemId: x.session.workItemId, status: 'done' })
      else if (cause === 'gone_target') await x.c.call('work.delete', { requestId: rid(), workItemId: x.second.workItemId })
      else await x.c.call('work.reparent', { requestId: rid(), workItemId: x.second.workItemId, parentId: null })
      expect((await x.payload(approval.approvalId)).status).toBe('expired')
      expect(await x.respond(approval.approvalId)).toEqual({ status: 'expired' })
      expect((await x.c.call('work.get', { workItemId: x.first.workItemId })).item.archivedAt).toBeNull()
    } finally { x.a.close(); x.c.close() }
  })

  it('records approval before stopping, persists all target plans, reports one failed target and continues the others', async () => {
    const x = await setup()
    try {
      const approval = await x.request()
      const original = x.host.work.delete.bind(x.host.work)
      const remove = vi.spyOn(x.host.work, 'delete').mockImplementation(async params => {
        expect((await x.payload(approval.approvalId)).status).toBe('approved')
        expect(x.host.db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.method, 'work.delete')).all()).toHaveLength(2)
        if (params.workItemId === x.first.workItemId) throw new Error('Injected stop failure')
        return original(params)
      })
      expect(await x.respond(approval.approvalId)).toEqual({ status: 'approved' })
      remove.mockRestore()
      expect(x.host.db.select().from(s.workItems).where(eq(s.workItems.id, x.second.workItemId)).get()?.archivedAt).not.toBeNull()
      const transcript = await x.c.call('session.getTranscript', { sessionId: x.session.sessionId })
      expect(transcript.items.find((item: any) => item.payload.reason === 'work.delete_failed')?.payload).toMatchObject({ params: { title: x.first.title } })
      await x.host.work.recoverRecalls()
      await x.host.workDeletion.recover()
      expect(x.host.db.select().from(s.workItems).where(eq(s.workItems.id, x.first.workItemId)).get()?.archivedAt).not.toBeNull()
      const after = currentSeq(x.host.db)
      expect(await x.respond(approval.approvalId)).toEqual({ status: 'approved' })
      expect(currentSeq(x.host.db)).toBe(after)
    } finally { x.a.close(); x.c.close() }
  })

  it('starts every approved target before waiting for a slow deletion to finish', async () => {
    const x = await setup()
    let release!: () => void
    const slow = new Promise<void>(resolve => { release = resolve })
    const original = x.host.work.delete.bind(x.host.work)
    const remove = vi.spyOn(x.host.work, 'delete').mockImplementation(async params => {
      if (params.workItemId === x.first.workItemId) await slow
      return original(params)
    })
    let click: Promise<unknown> | undefined
    try {
      const approval = await x.request()
      click = x.respond(approval.approvalId)
      await expect.poll(() => x.host.db.select().from(s.workItems).where(eq(s.workItems.id, x.second.workItemId)).get()?.archivedAt).not.toBeNull()
      await x.host.work.recoverRecalls()
      expect(x.host.db.select().from(s.workItems).where(eq(s.workItems.id, x.first.workItemId)).get()?.archivedAt).toBeNull()
      expect((await x.payload(approval.approvalId)).status).toBe('approved')
      release()
      expect(await click).toEqual({ status: 'approved' })
    } finally { release(); await click; remove.mockRestore(); x.a.close(); x.c.close() }
  })

  it('keeps provider cancellation truth in the existing delete result and a localized session notice without repeating cancellation', async () => {
    const x = await setup()
    try {
      const at = Date.now(), db = x.host.db
      db.insert(s.generationJobs).values({ id: 'cleanup-cancel', sessionId: x.first.sessions[0].sessionId, kind: 'image', provider: 'mock', model: 'mock-image', params: {}, status: 'queued', createdAt: at, updatedAt: at }).run()
      const cancel = vi.spyOn(x.host.generation, 'cancel').mockImplementation(async (_actor, params) => {
        db.update(s.generationJobs).set({ status: 'cancelled', providerCancelled: false }).where(eq(s.generationJobs.id, params.jobId)).run()
        return x.host.generation.get({ jobId: params.jobId })
      })
      const approval = await x.request([x.first.workItemId])
      expect(await x.respond(approval.approvalId)).toEqual({ status: 'approved' })
      const plan = db.select().from(s.idempotencyKeys).where(eq(s.idempotencyKeys.requestId, `${approval.approvalId}:delete:${x.first.workItemId}`)).get()!.result
      expect(plan).toMatchObject({ cancelledJobs: [{ jobId: 'cleanup-cancel', providerCancelled: false }], finished: true, suppressParentDelivery: true })
      const transcript = await x.c.call('session.getTranscript', { sessionId: x.session.sessionId })
      expect(transcript.items.find((item: any) => item.payload.reason === 'work.delete_cancelled_jobs')?.payload).toMatchObject({ params: { title: x.first.title, jobs: 1, confirmed: 0 }, message: expect.stringContaining('cancellation is not a refund') })
      expect(await x.respond(approval.approvalId)).toEqual({ status: 'approved' })
      expect(cancel).toHaveBeenCalledTimes(1)
      cancel.mockRestore()
    } finally { x.a.close(); x.c.close() }
  })
})


it('keeps MOV export, cancellation and file download UI-only without registering assets or changing the canvas', async () => {
  const c = await ui()
  await c.call('events.subscribe', { spaceId })
  const host = studiod.spaces.get(spaceId)!
  const source = host.assets.registerVersion(host.db, { staged: await host.assets.stageBytes(Buffer.from('video')), kind: 'video', mime: 'video/webm', origin: 'import', width: 64, height: 64 })
  const created = await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'video', kind: 'video', content: { assetVersionId: source.assetVersionId } }] })
  const node = host.canvas.get({ nodeIds: [created.idMap.video] }).nodes[0]!
  const params = { requestId: rid(), operation: 'video.exportMov', nodeId: node.nodeId, slotId: node.slots[0]!.slotId, expectedRevision: 1, params: {} }
  const output = join(dir, 'delivery.mov')
  writeFileSync(output, 'MOV output')
  vi.spyOn(media, 'process').mockResolvedValue({ outputs: [{ path: output, kind: 'video', mime: 'video/quicktime' }], async dispose() {} })
  const versions = host.db.select().from(s.assetVersions).all()
  const canvas = host.canvas.get({}).nodes
  const undo = host.db.select().from(s.undoEntries).all()
  const task = await c.call('media.process', { ...params, waitMs: 1000 })
  expect(task).toMatchObject({ status: 'succeeded', download: { byteSize: 10 } })
  expect(task).not.toHaveProperty('assetVersionIds')
  expect(task).not.toHaveProperty('nodeIds')
  expect(host.db.select().from(s.assetVersions).all()).toEqual(versions)
  expect(host.db.select().from(s.undoEntries).all()).toEqual(undo)
  expect(host.canvas.get({}).nodes).toEqual(canvas)
  const file = await c.call('media.exportDownload', { taskId: task.taskId })
  expect(readFileSync(file.path, 'utf8')).toBe('MOV output')
  const session = await c.call('session.create', { requestId: rid() })
  await c.call('session.sendMessage', { requestId: rid(), sessionId: session.sessionId, text: 'Export boundary', refs: [] })
  await until(() => dispatched.length === 1)
  const a = await agent(dispatched[0]!.token)
  await expect(a.call('media.process', { ...params, requestId: rid() })).rejects.toMatchObject({ code: 'forbidden' })
  for (const method of ['media.cancel', 'media.dismiss', 'media.exportDownload']) await expect(a.call(method, { taskId: task.taskId })).rejects.toMatchObject({ code: 'forbidden' })
  await c.call('media.dismiss', { taskId: task.taskId })
  expect(existsSync(file.path)).toBe(false)
  await expect(c.call('media.exportDownload', { taskId: task.taskId })).rejects.toMatchObject({ code: 'not_found' })
  const retained = await c.call('media.process', { ...params, requestId: rid(), waitMs: 1000 })
  const retainedFile = await c.call('media.exportDownload', { taskId: retained.taskId })
  dispatched[0]!.end()
  a.close()
  await c.call('space.delete', { requestId: rid(), spaceId })
  expect(existsSync(retainedFile.path)).toBe(false)
  c.close()
})
