import { beforeEach, expect, it } from 'vitest'
import type { SpaceEvent } from '@vis/protocol'
import { createDevConsole } from './console'

let calls: { method: string; params: any }[]
let out: string[]
let statusLine: string | undefined
let dev: ReturnType<typeof createDevConsole>
const node = (nodeId: string, body: string) => ({ nodeId, kind: 'text', x: 0, y: 0, w: 320, h: 200, z: 0, layoutRevision: 1, slots: [{ slotId: `s_${nodeId}`, slotKey: 'main', contentType: 'text', revision: 1, content: { type: 'text', body } }] })

beforeEach(() => {
  calls = []
  out = []
  statusLine = undefined
  const responses: Record<string, unknown> = {
    'agents.list': { agents: [{ kind: 'codex' }, { kind: 'deepseek' }, { kind: 'claude' }] },
    'session.create': { sessionId: 'ses_1', agentKind: 'claude', title: '分镜', queuePaused: false, activeTurnId: null, createdAt: 1 },
    'session.sendMessage': { messageId: 'msg_1', deliveryState: 'submitted' },
    'canvas.get': { nodes: [node('node_a', '设定'), node('node_b', '旁白')] },
    'session.list': { sessions: [{ sessionId: 'ses_1', agentKind: 'claude', title: '分镜', queuePaused: false, activeTurnId: 'trn_1', createdAt: 1 }] },
  }
  dev = createDevConsole({
    call: async (method, params) => { calls.push({ method, params }); return responses[method] ?? {} },
    print: l => out.push(l),
    status: (prefix, body) => { statusLine = prefix + body },
    spaceId: 'spc_1',
    snapshot: { nodes: [], sessions: [], activeJobs: [], workItems: [] },
  })
})

it('sending without a session prompts creation; messages after /new include /ref references and clear them after sending', async () => {
  await expect(dev.handleLine('你好')).rejects.toThrow('/new')
  await dev.handleLine('/new 分镜')
  expect(dev.currentSession()).toBe('ses_1')
  await dev.handleLine('/canvas')
  expect(out.join('\n')).toContain('node_b')
  await dev.handleLine('/ref 2')
  await dev.handleLine('写得更紧凑')
  const send = calls.find(c => c.method === 'session.sendMessage')!
  expect(send.params).toMatchObject({ sessionId: 'ses_1', text: '写得更紧凑', refs: [{ nodeId: 'node_b', versionPolicy: 'latest-at-execution' }] })
  expect(dev.pendingRefs()).toEqual([])
})

it('/new uses the first word as the agent kind when recognized, otherwise uses the default', async () => {
  await dev.handleLine('/new claude 分镜 二')
  await dev.handleLine('/new 配音')
  expect(calls.filter(c => c.method === 'session.create').map(c => c.params)).toEqual([
    expect.objectContaining({ title: '分镜 二', agentKind: 'claude' }),
    expect.not.objectContaining({ agentKind: expect.anything() }),
  ])
})

it('/stop stops the active turn; unknown commands report an error', async () => {
  await dev.handleLine('/new 分镜')
  await dev.handleLine('/stop')
  expect(calls.find(c => c.method === 'session.stop')!.params).toMatchObject({ sessionId: 'ses_1', turnId: 'trn_1' })
  await expect(dev.handleLine('/nope')).rejects.toThrow('/help')
})

it('renders only the current session records; other sessions show a new-reply notice', async () => {
  await dev.handleLine('/new 分镜')
  const item = (sessionId: string, kind: string, payload: unknown, seq: number): SpaceEvent =>
    ({ seq, type: 'transcript.itemUpserted', entityType: 'session', entityId: sessionId, payload: { itemId: `i${seq}`, createdSeq: seq, revision: 1, turnId: null, kind, payload, createdAt: 1, updatedAt: 1 } })
  dev.handleEvent(item('ses_1', 'assistant_text', { text: '我先读画布' }, 1))
  dev.handleEvent(item('ses_1', 'tool_call', { name: 'canvas_get', input: {} }, 2))
  dev.handleEvent(item('ses_2', 'assistant_text', { text: '别处' }, 3))
  dev.handleEvent({ seq: 4, type: 'job.stateChanged', entityType: 'job', entityId: 'job_1', payload: { jobId: 'job_1', status: 'succeeded' } })
  expect(out.slice(-4)).toEqual(['Agent › 我先读画布', '  → canvas_get {}', '（ses_2 有新回复）', '· 生成 job_1：succeeded'])
})

it('streaming replies refresh in place; ignores other session fragments and discards drafts when the final entry arrives', async () => {
  await dev.handleLine('/new 分镜')
  dev.handleTransient({ sessionId: 'ses_1', itemId: 'cx:t1:m0', revision: 1, delta: '画布\n是' })
  dev.handleTransient({ sessionId: 'ses_1', itemId: 'cx:t1:m0', revision: 1, delta: '空的' })
  dev.handleTransient({ sessionId: 'ses_other', itemId: 'cx:t9:m0', revision: 1, delta: '别处' })
  expect(statusLine).toBe('Agent ✎ 画布 是空的')
  expect(dev.drafts().size).toBe(1)
  dev.handleEvent({ seq: 1, type: 'transcript.itemUpserted', entityType: 'session', entityId: 'ses_1',
    payload: { itemId: 'cx:t1:m0', kind: 'assistant_text', revision: 1, payload: { text: '画布是空的' } } } as SpaceEvent)
  expect(dev.drafts().size).toBe(0)
  expect(out.at(-1)).toBe('Agent › 画布是空的')
})
