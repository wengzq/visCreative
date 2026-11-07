import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '@vis/generation'
import type { AgentModelOption, ApprovalDecision } from '@vis/protocol'
import { eq, openAppDb, openSpaceDb, spaceSchema as s } from '@vis/storage'
import type { DispatchInput } from '@vis/workbench-core'
import { createSpaceRegistry, openSpaceHost, type AgentRuntimeFactory } from './space-host'

const defaults = { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } }

const models: AgentModelOption[] = [{ id: 'model-a', label: '模型 A', isDefault: true, efforts: [{ id: 'high', label: '高' }], defaultEffort: 'high', serviceTiers: [] }]

it('skips removed adapters in the global FIFO and lets users move their cards without starting turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-removed-queue-'))
  const appDb = openAppDb(join(dir, 'app.db'))
  const dispatch = vi.fn(async () => {})
  const runtime: AgentRuntimeFactory = () => ({ ensureReady: async () => {}, dispatchTurn: dispatch, terminateTurn: async () => {}, interruptTurn: async () => {} })
  const registry = createSpaceRegistry({ appDb, dataDir: dir, host: { runtimes: { codex: runtime }, providers: [], defaults } })
  try {
    const first = registry.get(registry.create({ requestId: 'a', name: 'A', rootPath: join(dir, 'a') }).spaceId)!
    const second = registry.get(registry.create({ requestId: 'b', name: 'B', rootPath: join(dir, 'b') }).spaceId)!
    registry.workSlots.setLimit({ limit: 1 })
    const active = first.work.create({ requestId: 'active', title: 'Active', chat: { agentKind: 'codex' } }).item
    const missing = first.work.create({ requestId: 'missing', title: 'Missing' }).item
    first.work.activate({ requestId: 'queue-missing', workItemId: missing.workItemId, agentKind: 'codex' })
    const valid = second.work.create({ requestId: 'valid', title: 'Valid' }).item
    second.work.activate({ requestId: 'queue-valid', workItemId: valid.workItemId, agentKind: 'codex' })
    first.db.update(s.sessions).set({ agentKind: 'removed' }).where(eq(s.sessions.workItemId, missing.workItemId)).run()
    first.work.move({ requestId: 'release', workItemId: active.workItemId, status: 'done' })
    expect(() => registry.workSlots.drain()).not.toThrow()
    expect(second.work.get({ workItemId: valid.workItemId }).item.status).toBe('in_progress')
    expect(registry.workSlots.view().used).toBe(1)
    expect(registry.workSlots.view().queue.map(item => item.workItemId)).toEqual([missing.workItemId])
    expect(() => first.work.activate({ requestId: 'reject', workItemId: missing.workItemId })).toThrowError(expect.objectContaining({ code: 'unavailable' }))
    const moved = first.work.move({ requestId: 'move', workItemId: missing.workItemId, status: 'in_progress' })
    expect(moved.item.status).toBe('in_progress')
    expect(moved.item.waitingSlotSince).toBeNull()
    expect(first.db.select().from(s.sessions).where(eq(s.sessions.workItemId, missing.workItemId)).get()?.queuePaused).toBe(true)
    await first.sessions.idle()
    expect(dispatch).not.toHaveBeenCalled()
    expect(registry.workSlots.view().used).toBe(1)
  } finally {
    await registry.closeAll()
    appDb.$client.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Model options', () => {
  it('caches by Agent kind across projects, shares concurrent probes and expires ten minutes after success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vis-options-cache-'))
    const appDb = openAppDb(join(dir, 'app.db'))
    let at = 1000
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const probe = vi.fn(async () => { await blocked; return models })
    const deepseekProbe = vi.fn(async () => [{ ...models[0]!, id: 'deepseek-model' }])
    const runtime: AgentRuntimeFactory = () => ({ agentOptions: probe, ensureReady: async () => {}, dispatchTurn: async () => {}, terminateTurn: async () => {}, interruptTurn: async () => {} })
    const registry = createSpaceRegistry({ appDb, dataDir: dir, now: () => at, host: {
      runtimes: { codex: runtime, deepseek: ctx => ({ ...runtime(ctx), agentOptions: deepseekProbe }) },
      providers: [], defaults, now: () => at,
    } })
    try {
      const hosts = ['first', 'second'].map(name => registry.get(registry.create({ requestId: name, name, rootPath: join(dir, name) }).spaceId)!)
      expect(registry.agents?.().map(agent => agent.capabilities.models)).toEqual([true, true])
      expect(registry.agents?.().map(agent => agent.capabilities.effort)).toEqual([true, true])
      const sessions = hosts.map((host, index) => host.sessions.create({ requestId: `create-${index}` }))
      const first = hosts[0]!.sessions.agentOptions({ sessionId: sessions[0]!.sessionId })
      const second = hosts[1]!.sessions.agentOptions({ sessionId: sessions[1]!.sessionId })
      await Promise.resolve()
      expect(probe).toHaveBeenCalledTimes(1)
      expect(probe).toHaveBeenCalledWith('codex', {})
      at += 100
      release()
      expect(await first).toEqual({ models })
      expect(await second).toEqual({ models })
      at += 10 * 60_000 - 1
      expect(await hosts[1]!.sessions.agentOptions({ sessionId: sessions[1]!.sessionId })).toEqual({ models })
      expect(probe).toHaveBeenCalledTimes(1)
      at++
      await hosts[1]!.sessions.setAgentConfig({ requestId: 'config', sessionId: sessions[1]!.sessionId, model: 'model-a', effort: 'high', serviceTier: null })
      expect(probe).toHaveBeenCalledTimes(2)
      expect(probe).toHaveBeenLastCalledWith('codex', { model: 'model-a' })
      const deepseek = hosts[0]!.sessions.create({ requestId: 'create-deepseek', agentKind: 'deepseek' })
      expect(await hosts[0]!.sessions.agentOptions({ sessionId: deepseek.sessionId })).toMatchObject({ models: [{ id: 'deepseek-model' }] })
      expect(deepseekProbe).toHaveBeenCalledWith('deepseek', {})
      expect(probe).toHaveBeenCalledTimes(2)
    } finally {
      release()
      await registry.closeAll()
      appDb.$client.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('failed probes return unavailable and a reason without caching failures; unconfigured and unsupported Agents fail explicitly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vis-options-unavailable-'))
    const probe = vi.fn().mockRejectedValueOnce(new Error('Not logged in')).mockResolvedValue(models)
    const runtime: AgentRuntimeFactory = () => ({ ensureReady: async () => {}, dispatchTurn: async () => {}, terminateTurn: async () => {}, interruptTurn: async () => {} })
    const host = openSpaceHost('space_options', dir, { runtimes: { codex: ctx => ({ ...runtime(ctx), agentOptions: probe }), claude: runtime }, providers: [], defaults })
    try {
      const codex = host.sessions.create({ requestId: 'codex' })
      await expect(host.sessions.agentOptions({ sessionId: codex.sessionId })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('Not logged in') })
      expect(await host.sessions.agentOptions({ sessionId: codex.sessionId })).toEqual({ models })
      expect(probe).toHaveBeenCalledTimes(2)
      const missing = host.sessions.create({ requestId: 'missing', agentKind: 'codex' })
      host.db.update(s.sessions).set({ agentKind: 'deepseek' }).where(eq(s.sessions.id, missing.sessionId)).run()
      await expect(host.sessions.agentOptions({ sessionId: missing.sessionId })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('deepseek Agent is not configured') })
      const unsupported = host.sessions.create({ requestId: 'unsupported', agentKind: 'claude' })
      await expect(host.sessions.agentOptions({ sessionId: unsupported.sessionId })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('claude Agent does not support') })
      expect((await host.sessions.setAgentConfig({ requestId: 'reset', sessionId: unsupported.sessionId, model: null, effort: null, serviceTier: null })).agentConfig).toEqual({ model: null, effort: null, serviceTier: null })
    } finally {
      await host.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Space closing', () => {
  it('preserves the next draft without starting a new Agent when runtime exit reports turn completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vis-host-close-'))
    const dispatched: DispatchInput[] = []
    let approval: Promise<ApprovalDecision> | undefined
    const runtime: AgentRuntimeFactory = ({ report, workDir, requestApproval }) => ({
      async ensureReady() {},
      async dispatchTurn(input) {
        dispatched.push(input)
        approval = requestApproval({ sessionId: input.sessionId, turnId: input.turnId, kind: 'command', summary: '查看目录', detail: 'pwd', cwd: workDir(input.sessionId) })
      },
      async terminateTurn() {}, async interruptTurn() {},
      async dispose() {
        const current = dispatched[0]!
        report({ type: 'turn_ended', sessionId: current.sessionId, turnId: current.turnId, status: 'interrupted' })
        await Promise.resolve()
      },
    })
    const host = openSpaceHost('space_close', dir, { runtimes: { codex: runtime }, providers: [], defaults })
    try {
      const { sessionId } = host.sessions.create({ requestId: 'create', title: '关闭测试' })
      host.sessions.sendMessage({ requestId: 'first', sessionId, text: 'A', refs: [] })
      await host.sessions.idle()
      const workDir = host.workDir(sessionId)
      expect(host.sessions.list({}).sessions[0]).toMatchObject({ workDir, pendingApprovals: 1 })
      expect(dispatched[0]?.projectContext).toMatchObject({ rootPath: host.rootPath, workDir })
      const queued = host.sessions.sendMessage({ requestId: 'second', sessionId, text: 'B', refs: [] })
      await host.sessions.idle()
      await host.close()
      await expect(approval).resolves.toBe('deny')
      expect(dispatched.map(input => input.text)).toEqual(['A'])
      const reopened = openSpaceDb(join(dir, 'space.db'))
      try {
        expect(reopened.select().from(s.messages).where(eq(s.messages.id, queued.messageId)).get()?.deliveryState).toBe('draft')
        expect(reopened.select().from(s.turns).where(eq(s.turns.messageId, queued.messageId)).get()).toBeUndefined()
      } finally {
        reopened.$client.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('waits for in-flight deliveries before closing the database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vis-host-drain-'))
    let entered!: () => void
    let release!: () => void
    let disposed!: () => void
    const dispatchEntered = new Promise<void>(resolve => { entered = resolve })
    const dispatchBlocked = new Promise<void>(resolve => { release = resolve })
    const runtimeDisposed = new Promise<void>(resolve => { disposed = resolve })
    const runtime: AgentRuntimeFactory = () => ({
      async ensureReady() {},
      async dispatchTurn() { entered(); await dispatchBlocked },
      async terminateTurn() {}, async interruptTurn() {},
      async dispose() { disposed() },
    })
    const host = openSpaceHost('space_drain', dir, { runtimes: { codex: runtime }, providers: [], defaults })
    const { sessionId } = host.sessions.create({ requestId: 'create', title: '关闭测试' })
    const message = host.sessions.sendMessage({ requestId: 'first', sessionId, text: 'A', refs: [] })
    await dispatchEntered
    let closed = false
    const closing = host.close().then(() => { closed = true })
    try {
      await runtimeDisposed
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
      release()
      await closing
      const reopened = openSpaceDb(join(dir, 'space.db'))
      try {
        expect(reopened.select().from(s.messages).where(eq(s.messages.id, message.messageId)).get()?.deliveryState).toBe('delivered')
      } finally {
        reopened.$client.close()
      }
    } finally {
      release()
      await closing
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Deletion recovery', () => {
  it('does not schedule queued generation before recovering the deletion plan; starts other jobs only after cancellation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vis-host-delete-recovery-'))
    const provider = createMockProvider()
    const submit = vi.spyOn(provider, 'submit')
    const runtime: AgentRuntimeFactory = () => ({ ensureReady: async () => {}, dispatchTurn: async () => {}, terminateTurn: async () => {}, interruptTurn: async () => {} })
    let host = openSpaceHost('space_delete_recovery', dir, { runtimes: { codex: runtime }, providers: [provider], defaults })
    try {
      await host.generation.stop()
      const item = host.work.create({ requestId: 'recover-create', title: '待删除', chat: { agentKind: 'codex' } }).item
      const { jobId } = host.generation.submit({ sessionId: item.sessions[0]!.sessionId, turnId: null, inputSnapshotId: null }, { requestId: 'recover-generation', kind: 'image', prompt: '不要实际提交' })
      host.db.insert(s.idempotencyKeys).values({ requestId: 'recover-delete', method: 'work.delete', fingerprint: 'pending', result: { workItemIds: [item.workItemId], stops: [], cancelledJobs: [{ jobId, providerCancelled: false }], finished: false }, createdAt: Date.now() }).run()
      await host.close()
      host = openSpaceHost('space_delete_recovery', dir, { runtimes: { codex: runtime }, providers: [provider], defaults })
      await host.generation.pump()
      expect(submit).not.toHaveBeenCalled()
      await host.work.recoverRecalls()
      host.generation.start()
      await host.generation.pump()
      expect(submit).not.toHaveBeenCalled()
      expect(host.db.select().from(s.generationJobs).where(eq(s.generationJobs.id, jobId)).get()?.status).toBe('cancelled')
      expect(host.work.list({}).items).toEqual([])
    } finally {
      await host.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Generation cancellation fence during deletion', () => {
  it.each(['停止回合', '取消生成'] as const)('when %s is slow, all queued generation is already cancelled locally and no new provider submissions occur', async slow => {
    const dir = mkdtempSync(join(tmpdir(), 'vis-host-delete-cancel-'))
    const submitted: string[] = []
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const blocked = new Promise<void>(resolve => { entered = resolve })
    const provider = {
      ...createMockProvider(),
      submit: vi.fn(async (request: { prompt: string }) => { submitted.push(request.prompt); return { externalTaskId: request.prompt } }),
      getTask: async () => ({ state: 'running' as const }),
      cancel: async (externalTaskId: string) => {
        if (slow === '取消生成' && externalTaskId === 'first') { entered(); await gate }
        return { cancelled: true }
      },
    }
    const runtime: AgentRuntimeFactory = () => ({
      ensureReady: async () => {}, dispatchTurn: async () => {},
      terminateTurn: async () => {},
      interruptTurn: async () => { if (slow === '停止回合') { entered(); await gate } },
    })
    const host = openSpaceHost('space_delete_cancel', dir, { runtimes: { codex: runtime }, providers: [provider], defaults })
    let deleting: Promise<unknown> | undefined
    try {
      const item = host.work.create({ requestId: 'create-delete-race', title: '删除中的排队生成', chat: { agentKind: 'codex' } }).item
      const sessionId = item.sessions[0]!.sessionId
      host.db.insert(s.generationJobs).values({ id: 'first', sessionId, kind: 'image', provider: 'mock', model: 'mock-image-1', params: { prompt: 'first' }, status: 'running', createdAt: Date.now(), updatedAt: Date.now() }).run()
      host.db.insert(s.generationAttempts).values({ id: 'attempt-first', jobId: 'first', attemptNo: 1, externalTaskId: 'first', status: 'running', startedAt: Date.now() }).run()
      const later = host.generation.submit({ sessionId, turnId: null, inputSnapshotId: null }, { requestId: 'later-queued-generation', kind: 'image', prompt: 'later' })
      if (slow === '停止回合') {
        host.db.insert(s.messages).values({ id: 'running-message', sessionId, text: '运行中', deliveryState: 'delivered', createdAt: Date.now() }).run()
        host.db.insert(s.turns).values({ id: 'running-turn', sessionId, messageId: 'running-message', status: 'running', startedAt: Date.now() }).run()
      }
      deleting = host.work.delete({ requestId: 'delete-race', workItemId: item.workItemId })
      await blocked
      await host.generation.pump()
      expect(submitted).toEqual([])
      expect(host.db.select().from(s.generationJobs).all().every(job => job.status === 'cancelled')).toBe(true)
      expect(host.work.list({}).items).toHaveLength(1)
      release()
      expect(await deleting).toMatchObject({ cancelledJobs: [{ jobId: 'first', providerCancelled: true }, { jobId: later.jobId, providerCancelled: true }] })
      expect(host.work.list({}).items).toEqual([])
    } finally {
      release()
      if (deleting) await Promise.allSettled([deleting])
      await host.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
