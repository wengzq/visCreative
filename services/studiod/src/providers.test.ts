import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newId } from '@vis/domain'
import { createMockProvider } from '@vis/generation'
import { PROTOCOL_VERSION, type ProviderConfig } from '@vis/protocol'
import { eq, spaceSchema as s } from '@vis/storage'
import { issueAgentToken } from './auth'
import { createMemorySecretStore } from './secret-store'
import type { AgentRuntimeFactory } from './space-host'
import { startStudiod, type Studiod, type StudiodOptions } from './studiod'

const Database = createRequire(import.meta.url)('better-sqlite3')
const SECRET = 'integration-secret-never-persist-7f31e4'
const PROVIDER = 'ark-test'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64')
type Reply = { result?: any; error?: { code: number; message: string; data?: { code: string } } }
type Message = Reply & { method?: string; params?: unknown }
type Request = { method: string; path: string; body: Record<string, any>; authorization?: string }

let dir: string
let studiod: Studiod
let server: Server
let origin: string
let spaceId: string
let clock: number
let agentToken: string | undefined
let requests: Request[]
let received: Message[]
let logs: string[]
let sockets: Socket[]
let options: StudiodOptions

const fakeRuntime: AgentRuntimeFactory = ({ spaceId, db }) => ({
  async ensureReady() {},
  async dispatchTurn(input) {
    const { token, tokenHash } = issueAgentToken(spaceId)
    const instanceId = newId('agentInstance')
    db.insert(s.agentInstances).values({ id: instanceId, sessionId: input.sessionId, status: 'ready', tokenHash, startedAt: Date.now() }).run()
    db.update(s.turns).set({ instanceId }).where(eq(s.turns.id, input.turnId)).run()
    agentToken = token
  },
  async terminateTurn() {}, async interruptTurn() {},
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vis-providers-'))
  vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
  clock = Date.now()
  agentToken = undefined
  requests = []
  received = []
  logs = []
  sockets = []
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args) => { logs.push(inspect(args)) })
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const path = req.url!
    requests.push({ method: req.method!, path, body, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) })
    res.setHeader('content-type', 'application/json')
    if (path.endsWith('/images/generations')) {
      if (body.prompt === 'drop-response') {
        res.destroy()
      } else if (body.prompt === 'echo-key-error') {
        res.writeHead(400).end(JSON.stringify({ error: { message: `request rejected: ${SECRET}` } }))
      } else {
        const data: unknown[] = [{ url: `${origin}/image.png`, output_format: 'png', size: '1x1' }]
        if (body.prompt === 'partial') data.push({ error: { code: 'output_failed', message: 'second image unavailable' } })
        res.end(JSON.stringify({ data }))
      }
    } else if (req.method === 'POST' && path.endsWith('/contents/generations/tasks')) {
      res.end(JSON.stringify({ id: `${path.startsWith('/old/') ? 'old' : 'new'}-video-${requests.length}` }))
    } else if (req.method === 'GET' && path.includes('/contents/generations/tasks/')) {
      res.end(JSON.stringify({ status: 'succeeded', content: { video_url: `${origin}/video.mp4` } }))
    } else if (path === '/image.png') {
      res.setHeader('content-type', 'image/png')
      res.end(PNG)
    } else if (path === '/video.mp4') {
      res.setHeader('content-type', 'video/mp4')
      res.end(readFileSync(new URL('../../../packages/generation/src/providers/mock/fixtures/sample.mp4', import.meta.url)))
    } else res.writeHead(404).end('{}')
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as { port: number }
  origin = `http://127.0.0.1:${address.port}`
  options = {
    dataDir: dir, studiodVersion: 'test', runtimes: { codex: fakeRuntime },
    providers: [createMockProvider({ latencyMs: 0 })],
    defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    secretStore: createMemorySecretStore(), now: () => clock,
    media: {
      async process() { throw new Error('Unexpected local processing') },
      async analyzeSilence() { throw new Error('Unexpected silence analysis') },
      async probe(path) {
        return path.endsWith('.mp4')
          ? { kind: 'video', mime: 'video/mp4', width: 320, height: 180, durationMs: 1000 }
          : { kind: 'image', mime: 'image/png', width: 1, height: 1 }
      },
      async extractFrames() { return [] },
    },
  }
  studiod = await startStudiod(options)
  spaceId = studiod.spaces.create('供应商测试').spaceId
})

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  await studiod?.stop('user_quit')
  server?.closeAllConnections()
  await new Promise<void>(resolve => { server?.close(() => resolve()) })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

async function client(token?: string) {
  const socket = connect(studiod.socketPath)
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.setEncoding('utf8')
  const pending = new Map<number, (message: Reply) => void>()
  const notifications: Message[] = []
  let buffer = ''
  let nextId = 0
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      received.push(message)
      if ('id' in message) {
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      } else notifications.push(message)
    }
  })
  const raw = (method: string, params: unknown = {}) => new Promise<Reply>(resolve => {
    const id = ++nextId
    pending.set(id, resolve)
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  const call = async (method: string, params: unknown = {}) => {
    const reply = await raw(method, params)
    if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.data?.code })
    return reply.result
  }
  await call('runtime.hello', {
    protocolVersion: PROTOCOL_VERSION,
    credential: token ? { kind: 'agent', token } : { kind: 'ui', token: readFileSync(studiod.tokenPath, 'utf8') },
  })
  return { call, raw, notifications }
}

const until = async (check: () => boolean) => {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function config(version = '', video = false): ProviderConfig {
  return {
    limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 },
    providers: [{
      id: PROVIDER, type: 'volcengine-ark', label: 'Ark', baseUrl: `${origin}/${version || 'old'}`,
      imageModels: [{ id: `test-image${version ? `-${version}` : ''}`, label: 'Image' }],
      audioModels: [],
      videoModels: video ? [{ id: `test-video-${version}`, label: 'Video' }] : [],
    }],
    defaults: {
      image: { provider: PROVIDER, model: `test-image${version ? `-${version}` : ''}` },
      ...(video ? { video: { provider: PROVIDER, model: `test-video-${version}` } } : {}),
    },
  }
}

let requestId = 0
const rid = () => `providers_${++requestId}`

async function finish(c: Awaited<ReturnType<typeof client>>, jobId: string) {
  for (let i = 0; i < 5; i++) {
    clock += 5000
    await studiod.spaces.get(spaceId)!.generation.pump()
    const view = await c.call('generation.get', { jobId })
    if (['succeeded', 'failed', 'unknown'].includes(view.status)) return view
  }
  throw new Error(`Generation job ${jobId} has not finished`)
}

function filesUnder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const file = join(path, entry.name)
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : []
  })
}

function expectNoPersistedSecret() {
  const files = filesUnder(dir)
  expect(files.some(file => file.endsWith('-wal'))).toBe(true)
  expect(files.some(file => file.endsWith('providers.json'))).toBe(true)
  expect(files.some(file => file.includes(`${sep}blobs${sep}`))).toBe(true)
  for (const file of files) {
    expect(readFileSync(file).includes(Buffer.from(SECRET)), file).toBe(false)
    if (!file.endsWith('.db')) continue
    const db = new Database(file, { readonly: true })
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
      for (const { name } of tables) {
        const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
        expect(JSON.stringify(rows), `${file}:${name}`).not.toContain(SECRET)
      }
    } finally { db.close() }
  }
  expect(JSON.stringify(received)).not.toContain(SECRET)
  expect(logs.join('\n')).not.toContain(SECRET)
}

describe('Provider Gateway integration', () => {
  it('uses an available default for implicit submissions when the stored default is invalid', async () => {
    await studiod.stop('user_quit')
    const invalid = config()
    invalid.providers[0]!.region = 'unregistered'
    writeFileSync(join(dir, 'providers.json'), JSON.stringify(invalid))
    studiod = await startStudiod(options)
    const c = await client()
    await c.call('events.subscribe', { spaceId })
    expect(await c.call('providers.list')).toMatchObject({ unavailableDefaults: ['image'], providers: expect.arrayContaining([expect.objectContaining({ id: PROVIDER, available: false, unavailableReason: 'provider.region_invalid' })]) })
    const { jobId } = await c.call('generation.submit', { requestId: rid(), kind: 'image', prompt: 'Fallback' })
    expect(await finish(c, jobId)).toMatchObject({ status: 'succeeded' })
    expect(studiod.spaces.get(spaceId)!.db.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()?.provider).toBe('mock')
    expect(requests).toHaveLength(0)
  })

  it('settles an invalid pinned snapshot as unknown before sending a paid request', async () => {
    const c = await client()
    await c.call('providers.update', { config: config() })
    await c.call('events.subscribe', { spaceId })
    const host = studiod.spaces.get(spaceId)!
    await host.generation.stop()
    const { jobId } = await c.call('generation.submit', { requestId: rid(), kind: 'image', prompt: 'Invalid pin' })
    const job = host.db.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()!
    host.db.update(s.generationJobs).set({ params: { ...job.params as Record<string, unknown>, providerConfiguration: { ...config().providers[0], region: 'unregistered' } } }).where(eq(s.generationJobs.id, jobId)).run()
    expect(await finish(c, jobId)).toMatchObject({ status: 'unknown', error: { code: 'provider_config_invalid' } })
    expect(requests).toHaveLength(0)
  })
  it('catalog includes two Mock audio models and configured Ark audio models, and rejects submissions for unsupported models locally', async () => {
    const c = await client()
    await c.call('events.subscribe', { spaceId })
    const initial = await c.call('providers.list')
    expect(initial.agentIsolation).toBe(process.platform === 'darwin' ? 'sandbox' : 'none')
    expect(initial.defaults.audio).toEqual({ provider: 'mock', model: 'mock-music-1' })
    expect(initial.providers.find((provider: { id: string }) => provider.id === 'mock').models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'mock-music-1', kind: 'audio', label: 'Mock 音乐' }),
      expect.objectContaining({ id: 'mock-sfx-1', kind: 'audio', label: 'Mock 音效' }),
    ]))
    const next = config()
    next.providers[0]!.audioModels = [{ id: 'seed-audio-invite', label: '音频邀测模型' }]
    next.defaults.audio = { provider: PROVIDER, model: 'seed-audio-invite' }
    const updated = await c.call('providers.update', { config: next })
    expect(updated.defaults.audio).toEqual(next.defaults.audio)
    expect(updated.providers.find((provider: { id: string }) => provider.id === PROVIDER).models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'seed-audio-invite', kind: 'audio', label: '音频邀测模型' }),
    ]))
    await expect(c.call('generation.submit', { requestId: rid(), kind: 'audio', prompt: '音乐' })).rejects.toMatchObject({ code: 'invalid_params' })
    expect(requests).toHaveLength(0)
    expect((await c.call('generation.usage')).audio).toBe(0)
  })

  it('consecutive UI paid submissions bypass Agent daily limits; total and Agent usage are returned separately', async () => {
    const c = await client()
    const next = config()
    await c.call('events.subscribe', { spaceId })
    next.limits.dailyImage = 1
    await c.call('providers.update', { config: next })
    await c.call('providers.setKey', { providerId: PROVIDER, apiKey: SECRET })
    for (let i = 0; i < 2; i++) {
      const { jobId } = await c.call('generation.submit', { requestId: rid(), kind: 'image', prompt: `界面图片 ${i}` })
      expect(await finish(c, jobId)).toMatchObject({ status: 'succeeded' })
    }
    expect(await c.call('generation.usage')).toMatchObject({ image: 2, video: 0, audio: 0, agent: { image: 0, video: 0, audio: 0 } })
  })

  it('concurrent configuration updates during key status reads still yield catalog models and defaults from the same snapshot', async () => {
    const reader = await client()
    const writer = await client()
    const before = await writer.call('providers.update', { config: config('old', true) })
    let entered!: () => void
    let release!: () => void
    const blocked = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    const has = options.secretStore!.has
    vi.spyOn(options.secretStore!, 'has').mockImplementationOnce(async id => {
      entered()
      await barrier
      return has(id)
    })

    const pending = reader.call('providers.list')
    await blocked
    const updated = await writer.call('providers.update', { config: config('new', true) }).finally(release)

    expect(await pending).toEqual(before)
    expect(updated).toMatchObject({
      defaults: config('new', true).defaults,
      providers: expect.arrayContaining([expect.objectContaining({
        id: PROVIDER,
        models: [expect.objectContaining({ id: 'test-image-new' }), expect.objectContaining({ id: 'test-video-new' })],
      })]),
    })
    expect(await reader.call('providers.list')).toEqual(updated)
  })

  it('UI configures and generates images; Agents only read the catalog; keys never enter responses, logs, databases or outputs', async () => {
    const c = await client()
    const observer = await client()
    const catalog = await c.call('providers.update', { config: config() })
    expect(catalog).toMatchObject({ defaults: { image: { provider: PROVIDER, model: 'test-image' } } })
    expect(catalog.providers.find((p: { id: string }) => p.id === PROVIDER)).toMatchObject({ hasKey: false })
    await until(() => observer.notifications.some(n => n.method === 'events.providersChanged'))
    expect(observer.notifications.find(n => n.method === 'events.providersChanged')?.params).toEqual({})

    expect(await c.call('providers.setKey', { providerId: PROVIDER, apiKey: SECRET })).toEqual({ providerId: PROVIDER, hasKey: true })
    await until(() => observer.notifications.filter(n => n.method === 'events.providersChanged').length === 2)
    const list = await c.call('providers.list')
    expect(list.providers.find((p: { id: string }) => p.id === PROVIDER)).toMatchObject({
      hasKey: true, models: [{ id: 'test-image', kind: 'image', paramsSchema: { type: 'object' } }],
    })
    const invalid = await c.raw('providers.setKey', { providerId: PROVIDER, apiKey: { [SECRET]: SECRET } })
    expect(invalid.error?.data?.code).toBe('invalid_params')
    expect(JSON.stringify(invalid)).not.toContain(SECRET)
    expect(await options.secretStore!.get(PROVIDER)).toBe(SECRET)

    await c.call('events.subscribe', { spaceId })
    await c.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'image', kind: 'image', x: 0, y: 0, w: 320, h: 320, prompt: '远山' }] })
    const [node] = (await c.call('canvas.get')).nodes
    const main = node.slots.find((slot: { slotKey: string }) => slot.slotKey === 'main')
    const { jobId } = await c.call('generation.submit', { requestId: rid(), kind: 'image', prompt: '远山', targets: [{ outputIndex: 0, kind: 'slot', slotId: main.slotId }] })
    expect(await finish(c, jobId)).toMatchObject({ status: 'succeeded', outputs: [{ delivery: { status: 'delivered', slotId: main.slotId } }] })
    expect((await c.call('canvas.get')).nodes[0].slots.find((slot: { slotKey: string }) => slot.slotKey === 'main')).toMatchObject({ content: { type: 'asset' } })
    expect(requests.find(r => r.path.endsWith('/images/generations'))).toMatchObject({ authorization: `Bearer ${SECRET}`, body: { model: 'test-image', prompt: '远山' } })

    const { sessionId } = await c.call('session.create', { requestId: rid(), title: '检查模型目录' })
    await c.call('session.sendMessage', { requestId: rid(), sessionId, text: '列出模型', refs: [] })
    await until(() => agentToken !== undefined)
    const a = await client(agentToken!)
    expect(await a.call('providers.list')).toEqual(list)
    for (const method of ['providers.setKey', 'providers.clearKey', 'providers.update']) {
      expect((await a.raw(method, method === 'providers.update' ? { config: config() } : { providerId: PROVIDER, ...(method === 'providers.setKey' ? { apiKey: SECRET } : {}) })).error?.data?.code).toBe('forbidden')
    }
    const failed = await c.call('generation.submit', { requestId: rid(), kind: 'image', prompt: 'echo-key-error' })
    expect(await finish(c, failed.jobId)).toMatchObject({ status: 'failed' })
    await c.call('generation.get', { jobId: failed.jobId })
    await until(() => c.notifications.some(n => n.method === 'events.event'))
    expectNoPersistedSecret()

    expect(await c.call('providers.clearKey', { providerId: PROVIDER })).toEqual({ providerId: PROVIDER, hasKey: false })
    await until(() => observer.notifications.filter(n => n.method === 'events.providersChanged').length === 3)
    expect(observer.notifications.filter(n => n.method === 'events.providersChanged').every(n => JSON.stringify(n.params) === '{}')).toBe(true)
    expect(a.notifications).toEqual([])
    expect((await a.call('providers.list')).providers.find((p: { id: string }) => p.id === PROVIDER).hasKey).toBe(false)
    expect(await options.secretStore!.get(PROVIDER)).toBeUndefined()
  })

  it('after a lost submission response, restart only confirms results until unknown; partial image success delivers existing outputs and marks missing indices', async () => {
    const c = await client()
    await c.call('providers.update', { config: config() })
    await c.call('providers.setKey', { providerId: PROVIDER, apiKey: SECRET })
    await c.call('events.subscribe', { spaceId })
    const dropped = await c.call('generation.submit', { requestId: rid(), kind: 'image', prompt: 'drop-response' })
    await studiod.spaces.get(spaceId)!.generation.pump()
    expect((await c.call('generation.get', { jobId: dropped.jobId })).status).toBe('running')
    expect(requests.filter(r => r.method === 'POST' && r.body.prompt === 'drop-response')).toHaveLength(1)

    await studiod.stop('user_quit')
    studiod = await startStudiod(options)
    const restored = await client()
    await restored.call('events.subscribe', { spaceId })
    let unknown
    for (let i = 0; i < 15; i++) {
      clock += 60_000
      await studiod.spaces.get(spaceId)!.generation.pump()
      unknown = await restored.call('generation.get', { jobId: dropped.jobId })
      if (unknown.status !== 'running') break
    }
    expect(unknown).toMatchObject({ status: 'unknown', outputs: [], error: { code: 'retries_exhausted' } })
    expect(requests.filter(r => r.method === 'POST' && r.body.prompt === 'drop-response')).toHaveLength(1)

    const partial = await restored.call('generation.submit', { requestId: rid(), kind: 'image', prompt: 'partial', params: { n: 2 } })
    expect(await finish(restored, partial.jobId)).toMatchObject({
      status: 'succeeded',
      outputs: [{ outputIndex: 0, delivery: { status: 'delivered' } }],
      missingOutputIndexes: [1],
      targets: [{ outputIndex: 0, status: 'delivered' }, { outputIndex: 1, status: 'no_output' }],
    })
    expect((await restored.call('canvas.get')).nodes).toHaveLength(1)
    expect(requests.filter(r => r.method === 'POST' && r.body.prompt === 'partial')).toHaveLength(1)
    expectNoPersistedSecret()
  })

  it('queued and running image and video jobs retain original configuration across restart after endpoint and model changes under the same ID; new jobs use new defaults', async () => {
    const c = await client()
    await c.call('providers.update', { config: config('old', true) })
    await c.call('providers.setKey', { providerId: PROVIDER, apiKey: SECRET })
    await c.call('events.subscribe', { spaceId })
    const host = studiod.spaces.get(spaceId)!
    const oldJobs: string[] = []
    for (const kind of ['image', 'video'] as const) {
      oldJobs.push((await c.call('generation.submit', { requestId: rid(), kind, prompt: `running-${kind}` })).jobId)
    }
    await host.generation.pump()
    await host.generation.stop()
    for (const jobId of oldJobs) expect((await c.call('generation.get', { jobId })).status).toBe('running')
    for (const kind of ['image', 'video'] as const) {
      const job = await c.call('generation.submit', { requestId: rid(), kind, prompt: `queued-${kind}` })
      oldJobs.push(job.jobId)
      expect((await c.call('generation.get', { jobId: job.jobId })).status).toBe('queued')
    }

    await c.call('providers.update', { config: config('new', true) })
    const newJobs: string[] = []
    for (const kind of ['image', 'video'] as const) {
      newJobs.push((await c.call('generation.submit', { requestId: rid(), kind, prompt: `new-${kind}` })).jobId)
    }
    for (const [version, jobs] of [['old', oldJobs], ['new', newJobs]] as const) {
      for (const jobId of jobs) {
        const job = host.db.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()!
        expect(job).toMatchObject({ provider: PROVIDER, model: `test-${job.kind}-${version}`, params: { providerConfiguration: config(version, true).providers[0] } })
      }
    }

    await studiod.stop('user_quit')
    studiod = await startStudiod(options)
    const restored = await client()
    await restored.call('events.subscribe', { spaceId })
    expect(await restored.call('providers.list')).toMatchObject({ defaults: config('new', true).defaults })
    for (const jobId of [...oldJobs, ...newJobs]) expect(await finish(restored, jobId)).toMatchObject({ status: 'succeeded' })
    const latest = await restored.call('generation.submit', { requestId: rid(), kind: 'image', prompt: 'after-restart' })
    expect(await finish(restored, latest.jobId)).toMatchObject({ status: 'succeeded' })

    const submissions = requests.filter(r => r.method === 'POST')
    for (const kind of ['image', 'video'] as const) {
      const old = submissions.filter(r => r.body.model === `test-${kind}-old`)
      const current = submissions.filter(r => r.body.model === `test-${kind}-new`)
      expect(old).toHaveLength(2)
      expect(old.every(r => r.path.startsWith('/old/'))).toBe(true)
      expect(current).toHaveLength(kind === 'image' ? 2 : 1)
      expect(current.every(r => r.path.startsWith('/new/'))).toBe(true)
    }
    const oldPolls = requests.filter(r => r.method === 'GET' && r.path.includes('/contents/generations/tasks/old-video-'))
    expect(oldPolls).toHaveLength(2)
    expect(oldPolls.every(r => r.path.startsWith('/old/'))).toBe(true)
    expectNoPersistedSecret()
  })
})
