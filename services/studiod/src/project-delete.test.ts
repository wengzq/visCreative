import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import * as os from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newId } from '@vis/domain'
import { createMockProvider, localDate } from '@vis/generation'
import { PROTOCOL_VERSION, type MethodParams } from '@vis/protocol'
import { appSchema as a, eq, openAppDb, openSpaceDb, spaceSchema as s } from '@vis/storage'
import type { DispatchInput } from '@vis/workbench-core'
import { issueAgentToken } from './auth'
import { createMemorySecretStore } from './secret-store'
import type { AgentRuntimeFactory } from './space-host'
import { startStudiod, type Studiod } from './studiod'

vi.mock('node:os', { spy: true })
vi.mock('node:fs/promises', { spy: true })
const realFilesystem = await vi.importActual<typeof filesystem>('node:fs/promises')

let dir: string
let home: string
let studiod: Studiod
let appDb: ReturnType<typeof openAppDb>
let dispatched: (DispatchInput & { spaceId: string; token: string })[]
let interrupted: string[]
let disposed: string[]
let sockets: Socket[]
let sequence = 0
const rid = () => `project-delete-${++sequence}`
const defaults = { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } }
const provider = { ...createMockProvider(), getTask: vi.fn(async () => ({ state: 'running' as const })), cancel: vi.fn(async () => ({ cancelled: false })) }

const runtime: AgentRuntimeFactory = ({ spaceId, db, report }) => ({
  async ensureReady() {},
  async dispatchTurn(input) {
    const { token, tokenHash } = issueAgentToken(spaceId)
    const instanceId = newId('agentInstance')
    db.insert(s.agentInstances).values({ id: instanceId, sessionId: input.sessionId, status: 'ready', tokenHash, startedAt: Date.now() }).run()
    db.update(s.turns).set({ instanceId }).where(eq(s.turns.id, input.turnId)).run()
    dispatched.push({ ...input, spaceId, token })
  },
  async terminateTurn() {},
  async interruptTurn({ sessionId, turnId }) {
    interrupted.push(sessionId)
    db.update(s.agentInstances).set({ status: 'exited', exitedAt: Date.now() }).where(eq(s.agentInstances.sessionId, sessionId)).run()
    report({ type: 'turn_ended', sessionId, turnId, status: 'interrupted' })
  },
  async dispose() { disposed.push(spaceId) },
})

async function start() {
  return startStudiod({ dataDir: dir, studiodVersion: 'project-delete-test', runtimes: { codex: runtime }, providers: [provider], defaults, secretStore: createMemorySecretStore() })
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(os.tmpdir(), 'vis-project-delete-')))
  home = join(dir, 'home')
  mkdirSync(home)
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
  dispatched = []; interrupted = []; disposed = []; sockets = []
  provider.cancel.mockClear(); provider.getTask.mockClear()
  studiod = await start()
  appDb = openAppDb(join(dir, 'app.db'))
})

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  await studiod?.stop('user_quit')
  appDb?.$client.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

async function client(credential: { kind: 'ui' | 'agent'; token: string } = { kind: 'ui', token: readFileSync(studiod.tokenPath, 'utf8') }) {
  const socket = connect(studiod.socketPath)
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.setEncoding('utf8')
  const notifications: { method: string; params: unknown }[] = []
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  let buffer = '', id = 0
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      if (message.id === undefined) notifications.push(message)
      else {
        const request = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) request?.reject(Object.assign(new Error(message.error.message), { code: message.error.data?.code }))
        else request?.resolve(message.result)
      }
    }
  })
  const call = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const requestId = ++id
    pending.set(requestId, { resolve, reject })
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
  })
  await call('runtime.hello', { protocolVersion: PROTOCOL_VERSION, credential })
  return { call, notifications }
}

function create(name = '待删除项目') {
  const summary = studiod.spaces.create({ requestId: rid(), name })
  return { ...summary, host: studiod.spaces.get(summary.spaceId)!, dataDir: join(dir, 'spaces', summary.spaceId) }
}

function deletedRow(spaceId: string, rootPath: string) {
  appDb.update(a.spaces).set({ rootPath, deletedAt: Date.now() }).where(eq(a.spaces.id, spaceId)).run()
}

describe('Project deletion', () => {
  it('stops work items and ordinary sessions, cancels all generation and releases slots; restoration preserves canvas history without automatically continuing', async () => {
    studiod.spaces.workSlots.setLimit({ limit: 1 })
    const first = create()
    const other = create('等名额的项目')
    const work = first.host.work.create({ requestId: rid(), title: '执行中的工作', brief: '保留说明', chat: { agentKind: 'codex' } }).item
    const queuedHere = first.host.work.create({ requestId: rid(), title: '本项目排队' }).item
    expect(first.host.work.activate({ requestId: rid(), workItemId: queuedHere.workItemId, agentKind: 'codex' }).queued).toBe(true)
    const waiting = other.host.work.create({ requestId: rid(), title: '另一个项目排队' }).item
    expect(other.host.work.activate({ requestId: rid(), workItemId: waiting.workItemId, agentKind: 'codex' }).queued).toBe(true)
    const standalone = { sessionId: 'standalone-session', workDir: join(first.rootPath, 'standalone') }
    mkdirSync(standalone.workDir)
    first.host.db.insert(s.sessions).values({ id: standalone.sessionId, title: '普通会话', agentKind: 'codex', workDir: standalone.workDir, createdAt: Date.now() }).run()
    const workSession = work.sessions[0]!.sessionId
    first.host.sessions.sendMessage({ requestId: rid(), sessionId: workSession, text: '继续工作', refs: [] })
    first.host.sessions.sendMessage({ requestId: rid(), sessionId: standalone.sessionId, text: '保留对话', refs: [] })
    await first.host.sessions.idle()
    first.host.db.insert(s.workMessages).values({ id: 'unresolved-question', workItemId: work.workItemId, kind: 'question', from: { kind: 'session', sessionId: workSession }, to: 'user', body: '保留提问', createdAt: Date.now() }).run()
    const canvas = first.host.canvas.apply({ kind: 'user' }, { requestId: rid(), ops: [{ op: 'node.create', tempId: 'text', kind: 'text', x: 1, y: 2, w: 100, h: 80 }] })
    const nodes = first.host.canvas.get({}).nodes
    expect(canvas.idMap.text).toBeDefined()
    await first.host.generation.stop()
    for (const [index, sessionId] of [workSession, standalone.sessionId, null].entries()) {
      first.host.db.insert(s.generationJobs).values({ id: `delete-job-${index}`, sessionId, kind: 'image', provider: 'mock', model: 'mock-image-1', params: { prompt: '保留产物' }, status: index === 1 ? 'queued' : 'running', createdAt: Date.now(), updatedAt: Date.now() }).run()
      if (index !== 1) first.host.db.insert(s.generationAttempts).values({ id: `delete-attempt-${index}`, jobId: `delete-job-${index}`, attemptNo: 1, externalTaskId: `external-${index}`, status: 'running', startedAt: Date.now() }).run()
    }
    expect(studiod.spaces.deletePlan({ spaceId: first.spaceId })).toEqual({ runningTurns: 2, unfinishedJobs: 3, workInProgress: 1, unresolvedMessages: 1, rootPath: first.rootPath })
    const params = { requestId: rid(), spaceId: first.spaceId }
    const result = await studiod.spaces.delete(params)
    expect(result.spaceId).toBe(first.spaceId)
    expect(result.cancelledJobs).toEqual(expect.arrayContaining([{ jobId: 'delete-job-0', providerCancelled: false }, { jobId: 'delete-job-1', providerCancelled: true }, { jobId: 'delete-job-2', providerCancelled: false }]))
    expect(result.cancelledJobs).toHaveLength(3)
    expect(interrupted.sort()).toEqual([workSession, standalone.sessionId].sort())
    expect(disposed).toContain(first.spaceId)
    expect(first.host.db.$client.open).toBe(false)
    expect(studiod.spaces.opened().map(host => host.spaceId)).not.toContain(first.spaceId)
    expect(studiod.spaces.list().map(space => space.spaceId)).toEqual([other.spaceId])
    expect(() => studiod.spaces.get(first.spaceId)).toThrow(expect.objectContaining({ code: 'not_found', message: 'Project has been deleted' }))
    expect(studiod.spaces.workSlots.view()).toMatchObject({ used: 1, queue: [] })
    expect(other.host.work.get({ workItemId: waiting.workItemId }).item.status).toBe('in_progress')
    expect(await studiod.spaces.delete(params)).toEqual(result)
    expect(provider.cancel).toHaveBeenCalledTimes(2)
    expect(existsSync(first.rootPath)).toBe(true)
    const stoppedDb = openSpaceDb(join(first.dataDir, 'space.db'))
    try {
      expect(stoppedDb.select().from(s.workItems).all().every(item => item.archivedAt === null)).toBe(true)
      expect(stoppedDb.select().from(s.sessions).all().every(session => session.archivedAt === null)).toBe(true)
      expect(stoppedDb.select().from(s.generationJobs).all().every(job => job.status === 'cancelled')).toBe(true)
    } finally { stoppedDb.$client.close() }
    const beforeRestore = dispatched.length
    await studiod.spaces.restore({ requestId: rid(), spaceId: first.spaceId })
    const restored = studiod.spaces.get(first.spaceId)!
    expect(restored.canvas.get({}).nodes).toEqual(nodes)
    expect(restored.work.get({ workItemId: work.workItemId }).item).toMatchObject({ title: work.title, brief: '保留说明', status: 'todo', waitingSlotSince: null, archivedAt: null })
    expect(restored.work.get({ workItemId: queuedHere.workItemId }).item).toMatchObject({ status: 'todo', waitingSlotSince: null })
    expect(restored.work.get({ workItemId: work.workItemId }).messages.some(message => message.messageId === 'unresolved-question')).toBe(true)
    expect(restored.db.select().from(s.messages).all().some(message => message.text === '保留对话')).toBe(true)
    await restored.sessions.idle()
    expect(dispatched).toHaveLength(beforeRestore)
  })

  it('deletion and restoration replay and detect conflicts by global requestId; duplicate names and missing directories still allow restoration', async () => {
    const first = create('同名')
    const second = create('同名')
    const params = { requestId: rid(), spaceId: first.spaceId }
    const result = await studiod.spaces.delete(params)
    const deletedAt = (await studiod.spaces.listDeleted({})).spaces[0]!.deletedAt
    await studiod.stop('user_quit')
    appDb.$client.close()
    studiod = await start()
    appDb = openAppDb(join(dir, 'app.db'))
    expect(await studiod.spaces.delete(params)).toEqual(result)
    await expect(studiod.spaces.delete({ ...params, spaceId: second.spaceId })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(studiod.spaces.restore(params)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect((await studiod.spaces.listDeleted({})).spaces[0]!.deletedAt).toBe(deletedAt)
    rmSync(first.rootPath, { recursive: true })
    expect((await studiod.spaces.listDeleted({})).spaces[0]).toMatchObject({ spaceId: first.spaceId, rootPathExists: false })
    const restoring = { requestId: rid(), spaceId: first.spaceId }
    expect(await studiod.spaces.restore(restoring)).toMatchObject({ spaceId: first.spaceId, name: '同名' })
    expect(await studiod.spaces.restore(restoring)).toMatchObject({ spaceId: first.spaceId })
    expect(existsSync(first.rootPath)).toBe(false)
    expect(studiod.spaces.list().filter(space => space.name === '同名')).toHaveLength(2)
    expect((await studiod.spaces.listDeleted({})).spaces).toEqual([])
  })

  it('global views and startup recovery skip deleted projects, usage retains daily counts and old Agent tokens expire', async () => {
    const c = await client()
    const watcher = await client()
    const created = await c.call('space.create', { requestId: rid(), name: '全局视图项目' })
    await expect.poll(() => watcher.notifications.filter(event => event.method === 'events.spacesChanged').length).toBe(1)
    const project = { ...created, host: studiod.spaces.get(created.spaceId)! }
    await c.call('events.subscribe', { spaceId: project.spaceId })
    const session = project.host.sessions.create({ requestId: rid(), title: '令牌会话' })
    project.host.sessions.sendMessage({ requestId: rid(), sessionId: session.sessionId, text: '开始', refs: [] })
    await project.host.sessions.idle()
    const workItemId = project.host.db.select().from(s.sessions).where(eq(s.sessions.id, session.sessionId)).get()!.workItemId!
    project.host.db.insert(s.workMessages).values({ id: 'global-question', workItemId, kind: 'question', from: { kind: 'session', sessionId: session.sessionId }, to: 'user', body: '等用户回复', createdAt: Date.now() }).run()
    expect(await watcher.call('work.list', { scope: 'all' })).toMatchObject({ items: [{ workItemId }] })
    expect(await watcher.call('work.inbox')).toMatchObject({ counts: { unread: 1, unresolved: 1 } })
    const token = dispatched.find(turn => turn.sessionId === session.sessionId)!.token
    const agent = await client({ kind: 'agent', token })
    for (const method of ['space.deletePlan', 'space.delete', 'space.listDeleted', 'space.diskUsage', 'space.restore', 'space.purge']) {
      await expect(agent.call(method, { requestId: rid(), spaceId: project.spaceId })).rejects.toMatchObject({ code: 'forbidden' })
    }
    appDb.insert(a.generationQuota).values({ jobId: 'paid-deleted', spaceId: project.spaceId, kind: 'image', date: localDate(Date.now()), state: 'released', createdAt: Date.now() }).run()
    await c.call('space.delete', { requestId: rid(), spaceId: project.spaceId })
    await expect.poll(() => watcher.notifications.filter(event => event.method === 'events.spacesChanged').length).toBe(2)
    expect(await watcher.call('space.list')).toMatchObject({ spaces: [] })
    expect(await watcher.call('work.list', { scope: 'all' })).toEqual({ items: [] })
    expect(await watcher.call('work.inbox')).toMatchObject({ groups: [], counts: { unread: 0, unresolved: 0, bySpace: [] } })
    expect(await watcher.call('work.slots')).toMatchObject({ used: 0, queue: [], bySpace: [] })
    expect(await watcher.call('generation.usage')).toMatchObject({ image: 1, jobs: [], deletedProjectJobs: 1 })
    for (const method of ['events.subscribe', 'fs.listSkills', 'work.list']) {
      await expect(watcher.call(method, { spaceId: project.spaceId })).rejects.toMatchObject({ code: 'not_found', message: 'Project has been deleted' })
    }
    await expect(agent.call('canvas.get')).rejects.toMatchObject({ code: 'not_found' })
    await expect(client({ kind: 'agent', token })).rejects.toMatchObject({ code: 'not_found' })
    expect(studiod.spaces.opened()).toEqual([])
    for (const socket of sockets) socket.destroy()
    await studiod.stop('user_quit')
    appDb.$client.close()
    const databasePath = join(dir, 'spaces', project.spaceId, 'space.db')
    rmSync(databasePath)
    studiod = await start()
    appDb = openAppDb(join(dir, 'app.db'))
    expect(studiod.spaces.list()).toEqual([])
    expect(studiod.spaces.opened()).toEqual([])
    expect(existsSync(databasePath)).toBe(false)
  })

  it.each(['restore', 'purge'] as const)('%s finishes closing old connections when the deletion marker is committed but closing fails', async action => {
    const project = create()
    const originalClose = project.host.close.bind(project.host)
    const close = vi.spyOn(project.host, 'close').mockRejectedValueOnce(new Error('Test: close failed')).mockImplementation(originalClose)
    const deleting = { requestId: rid(), spaceId: project.spaceId }
    await expect(studiod.spaces.delete(deleting)).rejects.toThrow('close failed')
    expect(appDb.select().from(a.spaces).where(eq(a.spaces.id, project.spaceId)).get()?.deletedAt).not.toBeNull()
    expect(project.host.db.$client.open).toBe(true)
    const result = await studiod.spaces[action]({ requestId: rid(), spaceId: project.spaceId })
    expect(result.spaceId).toBe(project.spaceId)
    expect(close).toHaveBeenCalledTimes(2)
    expect(project.host.db.$client.open).toBe(false)
    if (action === 'restore') {
      expect(studiod.spaces.get(project.spaceId)).not.toBe(project.host)
      expect(existsSync(project.dataDir)).toBe(true)
    } else expect(existsSync(project.dataDir)).toBe(false)
    expect(existsSync(project.rootPath)).toBe(true)
  })
})

describe('Permanent project deletion', () => {
  it('rejects creation in the same directory while permanent deletion awaits file operations, then allows creation again', async () => {
    const project = create()
    await studiod.spaces.delete({ requestId: rid(), spaceId: project.spaceId })
    let entered!: () => void
    let release!: () => void
    const removing = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const remove = vi.spyOn(filesystem, 'rm').mockImplementation(async (path, options) => {
      if (resolve(String(path)) === project.dataDir) { entered(); await blocked }
      return realFilesystem.rm(path, options)
    })
    const params = { requestId: rid(), name: project.name }
    const purging = studiod.spaces.purge({ requestId: rid(), spaceId: project.spaceId, deleteProjectDir: true })
    try {
      await removing
      expect(() => studiod.spaces.create(params)).toThrow(expect.objectContaining({ code: 'busy' }))
      expect(() => studiod.spaces.create({ requestId: rid(), name: '同目录新项目', rootPath: project.rootPath })).toThrow(expect.objectContaining({ code: 'busy' }))
      expect(studiod.spaces.list()).toEqual([])
      release()
      await purging
      const recreated = studiod.spaces.create(params)
      expect(recreated.rootPath).toBe(project.rootPath)
      expect(recreated.spaceId).not.toBe(project.spaceId)
      expect(existsSync(join(recreated.rootPath, 'assets'))).toBe(true)
    } finally {
      release()
      await purging
      remove.mockRestore()
    }
  })

  it.each([false, true])('deletes application data; deleteProjectDir=%s deletes the project directory only when explicitly selected and does not follow symlinks', async deleteProjectDir => {
    const project = create()
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'user-file'), '外部文件')
    writeFileSync(join(project.rootPath, 'user-file'), '用户文件')
    symlinkSync(outside, join(project.rootPath, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(project.dataDir, 'history'), '历史')
    appDb.insert(a.generationQuota).values({ jobId: 'purged-paid-job', spaceId: project.spaceId, kind: 'image', date: localDate(Date.now()), state: 'released', createdAt: Date.now() }).run()
    await expect(studiod.spaces.purge({ requestId: rid(), spaceId: project.spaceId })).rejects.toMatchObject({ code: 'invalid_transition' })
    await studiod.spaces.delete({ requestId: rid(), spaceId: project.spaceId })
    const params: MethodParams<'space.purge'> = { requestId: rid(), spaceId: project.spaceId, ...(deleteProjectDir ? { deleteProjectDir: true } : {}) }
    const result = await studiod.spaces.purge(params)
    expect(result).toEqual({ spaceId: project.spaceId, projectDirDeleted: deleteProjectDir })
    expect(existsSync(project.dataDir)).toBe(false)
    expect(existsSync(project.rootPath)).toBe(!deleteProjectDir)
    expect(readFileSync(join(outside, 'user-file'), 'utf8')).toBe('外部文件')
    if (!deleteProjectDir) expect(readFileSync(join(project.rootPath, 'user-file'), 'utf8')).toBe('用户文件')
    expect(appDb.select().from(a.spaces).where(eq(a.spaces.id, project.spaceId)).get()).toBeUndefined()
    expect(appDb.select().from(a.generationQuota).where(eq(a.generationQuota.jobId, 'purged-paid-job')).get()?.spaceId).toBe(project.spaceId)
    expect(await studiod.spaces.purge(params)).toEqual(result)
    await expect(studiod.spaces.purge({ ...params, deleteProjectDir: !deleteProjectDir })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it.each([false, true])('moves legacy embedded project directories to orphaned-projects, preserving all user files (intermediate failure: %s)', async failAfterMove => {
    const legacyId = 'legacy-project'
    const dataDir = join(dir, 'spaces', legacyId)
    const rootPath = join(dataDir, 'project')
    mkdirSync(rootPath, { recursive: true })
    writeFileSync(join(rootPath, 'user-file'), '旧项目文件')
    appDb.insert(a.spaces).values({ id: legacyId, name: '旧版项目', dir: join('spaces', legacyId), rootPath, createdAt: 1 }).run()
    studiod.spaces.get(legacyId)
    await studiod.spaces.delete({ requestId: rid(), spaceId: legacyId })
    const params = { requestId: rid(), spaceId: legacyId }
    if (failAfterMove) {
      const failure = vi.spyOn(filesystem, 'rm').mockImplementationOnce(async () => { throw new Error('Test: deletion failed after moving') })
      try {
        await expect(studiod.spaces.purge(params)).rejects.toThrow('deletion failed after moving')
        expect(readFileSync(join(dir, 'orphaned-projects', legacyId, 'user-file'), 'utf8')).toBe('旧项目文件')
      } finally { failure.mockRestore() }
    }
    const result = await studiod.spaces.purge(params)
    expect(result).toEqual({ spaceId: legacyId, projectDirDeleted: false, movedProjectDir: join(dir, 'orphaned-projects', legacyId) })
    expect(existsSync(dataDir)).toBe(false)
    expect(readFileSync(join(result.movedProjectDir!, 'user-file'), 'utf8')).toBe('旧项目文件')
  })

  it('still moves out and preserves real project files in application data when the legacy project parent is a symlink', async () => {
    const legacyId = 'linked-legacy-project'
    const dataDir = join(dir, 'spaces', legacyId)
    const actualRoot = join(dataDir, 'project')
    mkdirSync(actualRoot, { recursive: true })
    writeFileSync(join(actualRoot, 'user-file'), '经过链接的旧项目')
    const alias = join(dir, 'legacy-data-alias')
    symlinkSync(dataDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const rootPath = join(alias, 'project')
    appDb.insert(a.spaces).values({ id: legacyId, name: '链接旧版项目', dir: join('spaces', legacyId), rootPath, createdAt: 1 }).run()
    studiod.spaces.get(legacyId)
    await studiod.spaces.delete({ requestId: rid(), spaceId: legacyId })
    const result = await studiod.spaces.purge({ requestId: rid(), spaceId: legacyId })
    expect(result).toEqual({ spaceId: legacyId, projectDirDeleted: false, movedProjectDir: join(dir, 'orphaned-projects', legacyId) })
    expect(existsSync(dataDir)).toBe(false)
    expect(readFileSync(join(result.movedProjectDir!, 'user-file'), 'utf8')).toBe('经过链接的旧项目')
  })

  it('deletes only the link when the project root itself is a symlink, preserving its target user directory', async () => {
    const project = create()
    await studiod.spaces.delete({ requestId: rid(), spaceId: project.spaceId })
    const target = join(dir, 'symlink-target')
    mkdirSync(target)
    writeFileSync(join(target, 'user-file'), '链接指向的用户文件')
    const link = join(dir, 'linked-project')
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    deletedRow(project.spaceId, link)
    expect(await studiod.spaces.purge({ requestId: rid(), spaceId: project.spaceId, deleteProjectDir: true })).toEqual({ spaceId: project.spaceId, projectDirDeleted: true })
    expect(existsSync(link)).toBe(false)
    expect(readFileSync(join(target, 'user-file'), 'utf8')).toBe('链接指向的用户文件')
  })

  it('counts actual file bytes without following symlinks and returns null for missing directories', async () => {
    const project = create()
    const outside = join(dir, 'large-external')
    mkdirSync(outside)
    writeFileSync(join(outside, 'payload'), Buffer.alloc(100_000))
    writeFileSync(join(project.rootPath, 'payload'), '12345')
    symlinkSync(outside, join(project.rootPath, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(outside, join(project.dataDir, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
    await studiod.spaces.delete({ requestId: rid(), spaceId: project.spaceId })
    const usage = await studiod.spaces.diskUsage({ spaceId: project.spaceId })
    expect(usage.projectDirBytes).toBeGreaterThanOrEqual(5)
    expect(usage.projectDirBytes).toBeLessThan(100_000)
    expect(usage.dataBytes).toBeGreaterThan(0)
    rmSync(project.rootPath, { recursive: true })
    expect(await studiod.spaces.diskUsage({ spaceId: project.spaceId })).toEqual({ dataBytes: usage.dataBytes, projectDirBytes: null })
  })

  it('retains errors after partial file deletion; the same requestId can retry and replay after success', async () => {
    const project = create()
    await studiod.spaces.delete({ requestId: rid(), spaceId: project.spaceId })
    const params = { requestId: rid(), spaceId: project.spaceId }
    const remove = realFilesystem.rm
    const failure = vi.spyOn(filesystem, 'rm').mockImplementationOnce(async (path, options) => {
      rmSync(join(project.dataDir, 'space.db'), { force: true })
      throw Object.assign(new Error('Test: file is in use'), { code: 'EBUSY', path, options })
    })
    try {
      await expect(studiod.spaces.purge(params)).rejects.toThrow()
      expect((await studiod.spaces.listDeleted({})).spaces[0]).toMatchObject({ spaceId: project.spaceId, purgeError: expect.stringContaining('file is in use') })
      expect(appDb.select().from(a.spaces).where(eq(a.spaces.id, project.spaceId)).get()?.deletedAt).not.toBeNull()
      await expect(studiod.spaces.restore({ requestId: rid(), spaceId: project.spaceId })).rejects.toMatchObject({ code: 'invalid_transition' })
      failure.mockImplementation(remove)
      const result = await studiod.spaces.purge(params)
      expect(result).toEqual({ spaceId: project.spaceId, projectDirDeleted: false })
      expect(await studiod.spaces.purge(params)).toEqual(result)
      expect(existsSync(project.dataDir)).toBe(false)
      expect(existsSync(project.rootPath)).toBe(true)
    } finally { failure.mockRestore() }
  })

  it('permanent deletion refuses to damage another project with a directory inside this project application data', async () => {
    const project = create()
    const rootPath = join(project.dataDir, 'another-project')
    const other = studiod.spaces.create({ requestId: rid(), name: '嵌套项目', rootPath })
    writeFileSync(join(rootPath, 'keep.txt'), '保留')
    await studiod.spaces.delete({ requestId: rid(), spaceId: project.spaceId })
    await expect(studiod.spaces.purge({ requestId: rid(), spaceId: project.spaceId })).rejects.toMatchObject({ code: 'forbidden' })
    expect(readFileSync(join(rootPath, 'keep.txt'), 'utf8')).toBe('保留')
    expect(existsSync(join(project.dataDir, 'space.db'))).toBe(true)
    expect(studiod.spaces.list().some(space => space.spaceId === other.spaceId)).toBe(true)
  })

  it.each(['filesystemRoot', 'home', 'projectsRoot', 'defaultProjectsRoot', 'containsAppData', 'containsProject', 'containsDeletedProject', 'containsProjectData', 'containsDeletedProjectData'] as const)('rejects dangerous project directories: %s; preserves application data and directories without recording cleanup errors', async danger => {
    const project = create()
    await studiod.spaces.delete({ requestId: rid(), spaceId: project.spaceId })
    let protectedRoot = project.rootPath
    if (danger === 'filesystemRoot') protectedRoot = resolve('/')
    if (danger === 'home') protectedRoot = home
    if (danger === 'projectsRoot') protectedRoot = studiod.spaces.projectsDir
    if (danger === 'defaultProjectsRoot') { protectedRoot = join(home, 'visCreative'); mkdirSync(protectedRoot) }
    if (danger === 'containsAppData') protectedRoot = dir
    if (danger === 'containsProject' || danger === 'containsDeletedProject') {
      const other = studiod.spaces.create({ requestId: rid(), name: '被保护的项目', rootPath: join(project.rootPath, 'other-project') })
      if (danger === 'containsDeletedProject') await studiod.spaces.delete({ requestId: rid(), spaceId: other.spaceId })
    }
    if (danger === 'containsProjectData' || danger === 'containsDeletedProjectData') {
      const other = create('被保护的数据')
      appDb.update(a.spaces).set({ dir: join('projects', '待删除项目', 'other-data') }).where(eq(a.spaces.id, other.spaceId)).run()
      if (danger === 'containsDeletedProjectData') await studiod.spaces.delete({ requestId: rid(), spaceId: other.spaceId })
    }
    deletedRow(project.spaceId, protectedRoot)
    expect((await studiod.spaces.listDeleted({})).spaces.find(space => space.spaceId === project.spaceId)).toMatchObject({ canDeleteProjectDir: false, canDeleteProjectDirReason: expect.any(String) })
    // Even if the safety check regresses, this test must never delete real paths outside the temporary directory.
    const remove = realFilesystem.rm
    const guarded = vi.spyOn(filesystem, 'rm').mockImplementation(async (path, options) => {
      const target = resolve(String(path))
      if (target === protectedRoot || !target.startsWith(`${dir}${sep}`)) throw new Error(`Test forbids deleting protected directory: ${target}`)
      return remove(path, options)
    })
    try {
      const params = { requestId: rid(), spaceId: project.spaceId, deleteProjectDir: true }
      const reason = danger === 'containsAppData' ? 'space.purge_contains_data'
        : danger.startsWith('contains') ? 'space.purge_contains_project' : 'space.purge_protected_root'
      await expect(studiod.spaces.purge(params)).rejects.toMatchObject({ code: 'forbidden', details: { reason, params: {} } })
      expect(existsSync(project.dataDir)).toBe(true)
      expect(existsSync(join(project.dataDir, 'space.db'))).toBe(true)
      expect(existsSync(protectedRoot)).toBe(true)
      expect((await studiod.spaces.listDeleted({})).spaces.find(space => space.spaceId === project.spaceId)?.purgeError).toBeNull()
      expect(guarded).not.toHaveBeenCalled()
      expect(await studiod.spaces.purge({ requestId: rid(), spaceId: project.spaceId })).toEqual({ spaceId: project.spaceId, projectDirDeleted: false })
    } finally { guarded.mockRestore() }
  })
})
