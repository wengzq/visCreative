import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { removeTempDir } from './platform'
// Real studiod + Codex adapter + vis MCP; fake-codex runs deterministic scenarios only, without model or generation service connections.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkItemView, WorkMessageView } from '@vis/protocol'
import { createMockProvider } from '../../../packages/generation/src/index'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'

// Completed turns leave the runtime's active-run map before their OS processes exit.
// Track every spawn, including probes and already-completed turns, until stdio closes.
const pendingProcesses = vi.hoisted(() => new Set<Promise<void>>())
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, spawn: (...args: Parameters<typeof original.spawn>) => {
    const child = original.spawn(...args)
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    pendingProcesses.add(closed)
    void closed.then(() => pendingProcesses.delete(closed))
    return child
  } }
})

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = join(root, 'apps/cli/dist/vis.mjs')
const ready = existsSync(cli)
const requestId = () => crypto.randomUUID()
const script = (value: Record<string, unknown>) => `工作代理检查：${JSON.stringify(value)}`

let dir: string
let studiod: Studiod
let admin: StudiodLink
let spaceId: string

const detail = (workItemId: string): Promise<{ item: WorkItemView; messages: WorkMessageView[] }> => admin.call('work.get', { workItemId })
const evidence = (workDir: string): any[] => {
  const file = join(workDir, '.vis-e2e-agent.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
const prompts = (item: WorkItemView) => evidence(item.workDir).filter(entry => entry.method === 'turn/start').map(entry => entry.prompt as string)

async function start() {
  studiod = await startStudiod({
    dataDir: dir, studiodVersion: 'work-agent-e2e',
    runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), visMcp: { command: process.execPath, args: [cli, 'mcp'] }, codexPath: join(root, 'apps/web/e2e/fake-codex.mjs') }) },
    providers: [createMockProvider()], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } }, secretStore: createMemorySecretStore(),
  })
  admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
  spaceId ||= studiod.spaces.create('工作代理端到端').spaceId
  await admin.call('events.subscribe', { spaceId })
}

async function rootWork() {
  const { item } = await admin.call('work.create', { requestId: requestId(), title: '上级工作项', chat: { agentKind: 'codex' } })
  return item as WorkItemView
}

async function send(item: WorkItemView, value: Record<string, unknown>) {
  await admin.call('session.sendMessage', { requestId: requestId(), sessionId: item.sessions[0]!.sessionId, text: script(value), refs: [] })
}

async function children(parent: WorkItemView) {
  await expect.poll(async () => (await admin.call('work.list', { parentId: parent.workItemId })).items.length).toBe(2)
  return (await admin.call('work.list', { parentId: parent.workItemId })).items as WorkItemView[]
}

describe.skipIf(!ready)('Work messages and fake Codex end-to-end', () => {
  beforeEach(async () => {
    vi.setConfig({ expect: { poll: { timeout: 5000 } } })
    dir = mkdtempSync(join(tmpdir(), 'vis-work-agent-'))
    spaceId = ''
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    await start()
  })

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && admin && !admin.closed) {
      const { items } = await admin.call('work.list', {})
      writeFileSync(join(tmpdir(), 'vis-u-work-agents-failure.json'), JSON.stringify(await Promise.all(items.map(async (item: WorkItemView) => ({ ...await detail(item.workItemId), evidence: evidence(item.workDir) }))), null, 2))
    }
    admin?.close()
    await studiod?.stop('user_quit')
    await Promise.all(pendingProcesses)
    vi.unstubAllEnvs()
    vi.resetConfig()
    removeTempDir(dir)
  })

  it('a scripted agent reads the guide index and timeline guide through MCP and the real gateway', async () => {
    const item = await rootWork()
    await send(item, { scenario: 'guide', topic: 'timeline' })
    await expect.poll(() => evidence(item.workDir).filter(entry => entry.tool === 'guide').length).toBe(2)
    await expect.poll(async () => (await detail(item.workItemId)).item.sessions[0]?.activeTurnId).toBeNull()
    const [index, topic] = evidence(item.workDir).filter(entry => entry.tool === 'guide').map(entry => entry.output)
    expect(index.topics.map((guide: { topic: string }) => guide.topic)).toEqual(['script', 'timeline', 'code-render', 'media', 'generation', 'canvas', 'library', 'previz', 'writing', 'scene'])
    expect(index.guide).toBeUndefined()
    expect(topic.guide).toMatchObject({ topic: 'timeline', title: 'Timeline editing', body: expect.stringContaining('timeline.export') })
    expect(topic.topics).toEqual(index.topics)
  })

  it('parent dispatches two agents with shared canvas writes, questions and replies, rejection, approval, and archiving', async () => {
    const parent = await rootWork()
    const outside = await admin.call('canvas.apply', { requestId: requestId(), ops: [{ op: 'node.create', tempId: 'outside', kind: 'text', x: 2200, y: 0, w: 200, h: 100, content: { text: '共享画布原文' } }] })
    await send(parent, { scenario: 'dispatch', children: [
      { title: '镜头 A', script: { scenario: 'question', outsideNodeId: outside.idMap.outside } },
      { title: '镜头 B', script: { scenario: 'hold' } },
    ] })
    const [worker, other] = await children(parent)
    await expect.poll(async () => (await detail(other!.workItemId)).item.sessions[0]?.activeTurnId).toBeTruthy()
    await expect.poll(async () => (await detail(worker!.workItemId)).item.unresolvedCount).toBe(1)
    const transcript = await admin.call('session.getTranscript', { sessionId: worker!.sessions[0]!.sessionId })
    expect(transcript.items.filter((item: any) => item.kind === 'approval')).toEqual([])
    const nodes = (await admin.call('canvas.get')).nodes
    expect(nodes.find((node: any) => node.slots[0]?.content.body === '工作草稿')).toMatchObject({ x: 40, y: 80, frameId: null })
    const question = (await detail(worker!.workItemId)).messages.find(message => message.kind === 'question')!
    await expect.poll(() => prompts(parent).some(prompt => prompt.includes(question.messageId) && prompt.includes('批次 dlv_'))).toBe(true)
    await expect.poll(async () => (await detail(worker!.workItemId)).messages.find(message => message.messageId === question.messageId)?.ackedAt).toBeTruthy()
    const outsideSlot = (await admin.call('canvas.get')).nodes.find((node: any) => node.nodeId === outside.idMap.outside).slots[0]
    expect(outsideSlot.content.body).toBe('共享画布原文')
    const proposal = (await admin.call('text.proposal.list', { slotId: outsideSlot.slotId })).proposals[0]
    expect(proposal.edits).toMatchObject([{ find: '共享画布原文', replace: '共享画布修改', status: 'pending' }])
    await admin.call('text.proposal.resolve', { requestId: requestId(), slotId: outsideSlot.slotId, action: 'accept', expectedRevision: outsideSlot.revision, body: '共享画布修改', edits: [{ proposalId: proposal.proposalId, editId: proposal.edits[0].editId }] })
    expect((await admin.call('canvas.get')).nodes.find((node: any) => node.nodeId === outside.idMap.outside).slots[0].content.body).toBe('共享画布修改')
    expect((await admin.call('work.inbox')).groups[0].items[0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ messageId: question.messageId })]))

    const reply = await admin.call('work.reply', { requestId: requestId(), workItemId: worker!.workItemId, replyTo: question.messageId, body: script({ scenario: 'done', body: '采用版本 A，完成初稿' }) })
    await expect.poll(async () => (await detail(worker!.workItemId)).item.status).toBe('in_review')
    await expect.poll(async () => (await detail(worker!.workItemId)).item.sessions[0]?.activeTurnId).toBeNull()
    await expect.poll(async () => (await detail(worker!.workItemId)).messages.find(message => message.messageId === reply.messageId)?.ackedAt).toBeTruthy()
    expect((await detail(worker!.workItemId)).messages.find(message => message.messageId === question.messageId)?.resolvedBy).toBe(reply.messageId)
    expect(prompts(worker!).some(prompt => prompt.includes(reply.messageId) && prompt.includes('reply'))).toBe(true)

    await admin.call('work.review', { requestId: requestId(), workItemId: worker!.workItemId, decision: 'reject', feedback: script({ scenario: 'done', body: '按打回意见完成修改' }) })
    await expect.poll(async () => (await detail(worker!.workItemId)).messages.filter(message => message.kind === 'done').length).toBe(2)
    await expect.poll(async () => (await detail(worker!.workItemId)).item.sessions[0]?.activeTurnId).toBeNull()
    const feedback = (await detail(worker!.workItemId)).messages.find(message => message.kind === 'review_feedback')!
    expect(feedback.ackedAt).toBeTruthy()
    expect(prompts(worker!).some(prompt => prompt.includes(feedback.messageId) && prompt.includes('review_feedback'))).toBe(true)
    const approved = await admin.call('work.review', { requestId: requestId(), workItemId: worker!.workItemId, decision: 'approve' })
    expect(approved.item).toMatchObject({ status: 'done', sessions: [expect.objectContaining({ archived: true })] })
    expect(evidence(parent.workDir).filter(entry => entry.tool === 'work_dispatch')).toHaveLength(2)
    const instructions = evidence(worker!.workDir).filter(entry => entry.method.startsWith('thread/')).map(entry => entry.developerInstructions)
    expect(instructions.length).toBeGreaterThan(0)
    for (const text of instructions) {
      expect(text).toContain('<workspace>')
      expect(text).toContain('This workspace has a parent; dispatching further children is unavailable.')
      expect(text).toContain('work_report')
      expect(text).toContain('</workspace>')
    }
    await admin.call('work.recall', { requestId: requestId(), workItemId: parent.workItemId })
  })

  it('recalling the parent interrupts three active agents in parent and child workspaces while preserving all work items and messages', async () => {
    const parent = await rootWork()
    await send(parent, { scenario: 'dispatch', hold: true, children: [
      { title: '等待 A', script: { scenario: 'hold' } },
      { title: '等待 B', script: { scenario: 'hold' } },
    ] })
    const workers = await children(parent)
    await expect.poll(async () => (await Promise.all(workers.map(worker => detail(worker.workItemId)))).every(value => value.item.sessions[0]?.activeTurnId !== null && prompts(value.item).length === 1)).toBe(true)
    const recalled = await admin.call('work.recall', { requestId: requestId(), workItemId: parent.workItemId })
    expect(recalled.items.map((item: WorkItemView) => item.workItemId).sort()).toEqual([parent.workItemId, ...workers.map(worker => worker.workItemId)].sort())
    await expect.poll(async () => (await admin.call('work.list')).items.every((item: WorkItemView) => item.status === 'todo' && item.sessions.every(session => session.activeTurnId === null))).toBe(true)
    for (const item of [parent, ...workers]) {
      expect((await detail(item.workItemId)).messages.some(message => message.kind === 'recall')).toBe(true)
      expect(prompts(item)).toHaveLength(1)
    }
    expect(await admin.call('work.slots')).toMatchObject({ used: 0, queue: [] })
  })

  it('studiod restart redelivers unacknowledged batches and merges two messages queued while busy', async () => {
    const parent = await rootWork()
    const { item: worker } = await admin.call('work.dispatch', { requestId: requestId(), parentId: parent.workItemId, title: '重启 worker', brief: script({ scenario: 'restart' }), agentKind: 'codex' })
    await expect.poll(async () => (await detail(worker.workItemId)).messages.find(message => message.kind === 'brief')?.deliveredAt).toBeTruthy()
    const initial = (await detail(worker.workItemId)).messages.find(message => message.kind === 'brief')!
    // deliveredAt is persisted before the adapter starts; confirm actual agent receipt before testing a restart during execution.
    await expect.poll(() => prompts(worker).some(prompt => prompt.includes(initial.messageId) && !prompt.includes('重新投递'))).toBe(true)
    expect(initial.ackedAt).toBeNull()
    const first = await admin.call('work.reply', { requestId: requestId(), workItemId: worker.workItemId, body: '补充消息 A' })
    const second = await admin.call('work.reply', { requestId: requestId(), workItemId: worker.workItemId, body: '补充消息 B' })
    admin.close()
    await studiod.stop('user_quit')
    await Promise.all(pendingProcesses)
    await start()
    await expect.poll(async () => (await detail(worker.workItemId)).messages.every(message => !!message.ackedAt), { timeout: 10_000 }).toBe(true)
    const messages = (await detail(worker.workItemId)).messages
    expect(messages.find(message => message.messageId === initial.messageId)).toMatchObject({ deliveryId: initial.deliveryId, redelivered: true })
    const queued = [first, second].map(reply => messages.find(message => message.messageId === reply.messageId)!)
    expect(queued[0]!.deliveryId).toBeTruthy()
    expect(queued[0]!.deliveryId).toBe(queued[1]!.deliveryId)
    expect(queued[0]!.deliveryId).not.toBe(initial.deliveryId)
    const received = prompts(worker)
    expect(received.filter(prompt => prompt.includes(initial.messageId))).toHaveLength(2)
    expect(received.filter(prompt => prompt.includes(initial.messageId) && prompt.includes('重新投递'))).toHaveLength(1)
    expect(received.filter(prompt => prompt.includes(first.messageId) && prompt.includes(second.messageId))).toHaveLength(1)
    await admin.call('work.recall', { requestId: requestId(), workItemId: parent.workItemId })
  })

  it('reparenting a child redirects unacknowledged and subsequent reports to the new parent main session', async () => {
    const previous = await rootWork()
    const next = await rootWork()
    await send(previous, { scenario: 'hold' })
    await expect.poll(async () => (await detail(previous.workItemId)).item.sessions[0]?.activeTurnId).toBeTruthy()
    const { item: worker } = await admin.call('work.dispatch', { requestId: requestId(), parentId: previous.workItemId, title: '挪动回报路由检查', brief: script({ scenario: 'question' }), agentKind: 'codex' })
    await expect.poll(async () => (await detail(worker.workItemId)).item.unresolvedCount).toBe(1)
    await expect.poll(async () => (await detail(worker.workItemId)).item.sessions[0]?.activeTurnId).toBeNull()
    const question = (await detail(worker.workItemId)).messages.find(message => message.kind === 'question')!
    expect(question.ackedAt).toBeNull()
    const moved = await admin.call('work.reparent', { requestId: requestId(), workItemId: worker.workItemId, parentId: next.workItemId })
    expect(moved).toMatchObject({ oldParentId: previous.workItemId, item: { parentId: next.workItemId, status: 'in_progress' } })
    await expect.poll(() => prompts(next).some(prompt => prompt.includes(question.messageId))).toBe(true)
    await expect.poll(async () => (await detail(worker.workItemId)).messages.find(message => message.messageId === question.messageId)?.ackedAt).toBeTruthy()
    expect(prompts(previous).some(prompt => prompt.includes(question.messageId))).toBe(false)
    await admin.call('work.reply', { requestId: requestId(), workItemId: worker.workItemId, replyTo: question.messageId, body: script({ scenario: 'done', body: '挪动后完成报告' }) })
    await expect.poll(async () => (await detail(worker.workItemId)).item.status).toBe('in_review')
    const done = (await detail(worker.workItemId)).messages.find(message => message.kind === 'done')!
    await expect.poll(() => prompts(next).some(prompt => prompt.includes(done.messageId))).toBe(true)
    expect(prompts(previous).some(prompt => prompt.includes(done.messageId))).toBe(false)
    await admin.call('work.recall', { requestId: requestId(), workItemId: previous.workItemId })
    await admin.call('work.recall', { requestId: requestId(), workItemId: next.workItemId })
  })
})
