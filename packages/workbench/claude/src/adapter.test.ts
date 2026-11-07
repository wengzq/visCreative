import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { and, eq, openSpaceDb, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createSessionService, type SessionService } from '@vis/workbench-core'
import { createClaudeRuntime } from './adapter'

/** Controllable fake SDK call: tests push messages one by one or fail the process */
class FakeQuery {
  readonly queue: (SDKMessage | Error | 'end')[] = []
  private wake: (() => void) | undefined
  interrupted = false
  ignoreAbort = false
  constructor(readonly options: Options, readonly prompt: string) {
    options.abortController?.signal.addEventListener('abort', () => { if (!this.ignoreAbort) this.push(new Error('aborted')) })
  }
  push(item: SDKMessage | Error | 'end') {
    this.queue.push(item)
    this.wake?.()
  }
  async *iterate(): AsyncGenerator<SDKMessage, void> {
    for (;;) {
      while (this.queue.length === 0) await new Promise<void>(r => { this.wake = r })
      const item = this.queue.shift()!
      if (item === 'end') return
      if (item instanceof Error) throw item
      yield item
    }
  }
  asQuery(): Query {
    const gen = this.iterate()
    return Object.assign(gen, {
      interrupt: async () => { this.interrupted = true; this.push(result('error_during_execution')); this.push('end'); return undefined },
      close: () => {},
    }) as unknown as Query
  }
}

let db: SpaceDb
let sessions: SessionService
let runtime: ReturnType<typeof createClaudeRuntime>
let calls: FakeQuery[]
let nextQuery: ((q: FakeQuery) => void) | undefined
let clock = 1_800_000_000_000
let tokenSeq = 0
let environment: Record<string, string | undefined>

const init = (sessionId = 'claude-ses-1') => ({ type: 'system', subtype: 'init', session_id: sessionId, uuid: 'u-init' }) as unknown as SDKMessage
const assistant = (uuid: string, content: unknown[]) => ({ type: 'assistant', uuid, parent_tool_use_id: null, session_id: 'x', message: { content } }) as unknown as SDKMessage
const toolResult = (uuid: string, toolUseId: string, text: string) =>
  ({ type: 'user', uuid, parent_tool_use_id: null, session_id: 'x', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] } }) as unknown as SDKMessage
const result = (subtype: 'success' | 'error_during_execution' = 'success') => ({ type: 'result', subtype, is_error: subtype !== 'success' }) as unknown as SDKMessage

beforeEach(() => {
  db = openSpaceDb(':memory:')
  calls = []
  tokenSeq = 0
  nextQuery = undefined
  environment = { PATH: '/usr/bin', HOME: '/home/u' }
  sessions = createSessionService({ db, runtime: { ensureReady: id => runtime.ensureReady(id), dispatchTurn: i => runtime.dispatchTurn(i), terminateTurn: i => runtime.terminateTurn(i), interruptTurn: i => runtime.interruptTurn(i) }, now: () => ++clock })
  runtime = createClaudeRuntime({ db, report: e => sessions.handleAgentEvent(e) }, {
    query: ({ prompt, options }) => {
      const q = new FakeQuery(options!, prompt)
      calls.push(q)
      nextQuery?.(q)
      return q.asQuery()
    },
    workDir: id => join(tmpdir(), 'vis-test-work', `${id}`),
    issueToken: () => ({ token: `spc_1.tok${++tokenSeq}`, tokenHash: `hash${tokenSeq}` }),
    socketPath: '/tmp/vis.sock',
    cliBinDir: '/opt/vis/bin',
    initTimeoutMs: 200,
    interruptGraceMs: 50,
    env: environment,
    now: () => ++clock,
  })
})

let req = 0
function newSession() {
  return sessions.create({ requestId: `r${++req}`, title: '分镜' }).sessionId
}
function send(sessionId: string, text: string) {
  return sessions.sendMessage({ requestId: `r${++req}`, sessionId, text, refs: [] })
}
const turnOf = (messageId: string) => db.select().from(s.turns).where(eq(s.turns.messageId, messageId)).get()!
const message = (id: string) => db.select().from(s.messages).where(eq(s.messages.id, id)).get()!
const instances = (sessionId: string) => db.select().from(s.agentInstances).where(eq(s.agentInstances.sessionId, sessionId)).all()
const notices = (sessionId: string) => db.select().from(s.transcriptEntries)
  .where(and(eq(s.transcriptEntries.sessionId, sessionId), eq(s.transcriptEntries.kind, 'notice'))).all().map(n => (n.payload as { code: string }).code)
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 5))
  expect(check()).toBe(true)
}

describe('A single turn', () => {
  it('Send now force-ends startup that ignores abort and starts its selected message before late init arrives', async () => {
    sessions.dispose()
    sessions = createSessionService({ db, runtime: { ensureReady: id => runtime.ensureReady(id), dispatchTurn: input => runtime.dispatchTurn(input), interruptTurn: input => runtime.interruptTurn(input), terminateTurn: input => runtime.terminateTurn(input) }, watchdog: { stopGraceMs: 10 }, now: () => ++clock })
    nextQuery = q => { if (calls.length === 1) q.ignoreAbort = true; else q.push(init('next-session')) }
    const sid = newSession()
    const first = send(sid, 'Hung startup')
    await until(() => calls.length === 1)
    const next = send(sid, 'Selected next')
    await sessions.sendNow({ requestId: 'force-starting', sessionId: sid, messageId: next.messageId })
    await sessions.idle()
    expect(calls).toHaveLength(2)
    expect(turnOf(first.messageId).status).toBe('interrupted')
    expect(turnOf(next.messageId).status).toBe('running')
    calls[0]!.push(init('late-session'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(db.select().from(s.sessions).get()?.agentResumeId).toBe('next-session')
    calls[1]!.push(result()); calls[1]!.push('end')
    await until(() => turnOf(next.messageId).status === 'completed')
  })

  it.runIf(process.platform === 'win32')('Windows: merge Path and PATH, preserve system environment, and leave the caller object unchanged', async () => {
    delete environment.PATH
    environment.Path = 'C:\\Windows\\System32'
    environment.SystemRoot = 'C:\\Windows'
    const sid = newSession()
    nextQuery = q => q.push(init())
    send(sid, 'test')
    await sessions.idle()
    expect(calls[0]!.options.env).toMatchObject({ PATH: ['/opt/vis/bin', environment.Path].join(delimiter), SystemRoot: 'C:\\Windows' })
    expect(calls[0]!.options.env).not.toHaveProperty('Path')
    expect(environment.Path).toBe('C:\\Windows\\System32')
    expect(environment.PATH).toBeUndefined()
  })
  it('Startup arguments: restrict tools, reject others, and inject token and socket', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init())
    send(sid, '写一段旁白')
    await sessions.idle()
    const { options, prompt } = calls[0]!
    const workItemId = db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()!.workItemId
    expect(prompt).toBe(`写一段旁白\n\n<工作项>\n所属工作项：${workItemId}\n父工作项：无（根工作区）\n有子工作项：否\n</工作项>`)
    expect(options).toMatchObject({
      cwd: join(tmpdir(), 'vis-test-work', `${sid}`),
      tools: ['Bash', 'Read', 'Glob', 'Grep'],
      allowedTools: ['Bash(vis:*)', 'Read', 'Glob', 'Grep'],
      permissionMode: 'dontAsk',
      settingSources: [],
      env: { VIS_SOCKET: '/tmp/vis.sock', VIS_AGENT_TOKEN: 'spc_1.tok1', PATH: ['/opt/vis/bin', '/usr/bin'].join(delimiter), HOME: '/home/u' },
    })
    expect(options.resume).toBeUndefined()
  })

  it('Resuming a session uses the latest workspace hierarchy system instructions', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init())
    const first = send(sid, '找个 DeepSeek 来验收')
    await sessions.idle()
    expect(calls[0]!.options.systemPrompt).toMatchObject({ append: expect.stringContaining('当前工作区没有子工作项') })
    const parentId = db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()!.workItemId!
    db.insert(s.workItems).values({ id: 'work_child', parentId, title: '子工作项', workDir: '', createdBy: { kind: 'user' }, statusChangedAt: clock, createdAt: clock }).run()
    calls[0]!.push(result())
    calls[0]!.push('end')
    await until(() => turnOf(first.messageId).status === 'completed')
    send(sid, '处理子工作项报告')
    await sessions.idle()
    expect(calls[1]!.options.resume).toBe('claude-ses-1')
    expect(calls[1]!.options.systemPrompt).toMatchObject({ append: expect.stringContaining('子工作项的报告会通过持久工作消息自动唤醒你') })
    expect(calls[1]!.options.systemPrompt).toMatchObject({ append: expect.not.stringContaining('当前工作区没有子工作项') })
    expect(calls[1]!.prompt).toContain('有子工作项：是')
  })

  it('init means accepted; messages become transcript entries; the instance exits after normal completion and the next turn uses resume', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init('claude-ses-9'))
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('delivered')
    expect(instances(sid)).toEqual([expect.objectContaining({ status: 'ready', tokenHash: 'hash1' })])
    expect(turnOf(a.messageId).instanceId).toBe(instances(sid)[0]!.id)

    const q = calls[0]!
    q.push(assistant('u1', [{ type: 'text', text: '我先读一下画布' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'vis canvas get' } }]))
    q.push(toolResult('u2', 'tu1', '{"nodes":[]}'))
    q.push(assistant('u3', [{ type: 'text', text: '画布是空的' }]))
    q.push(result())
    q.push('end')
    await until(() => turnOf(a.messageId).status === 'completed')

    const items = sessions.getTranscript({ sessionId: sid }).items.filter(i => i.kind !== 'user')
    expect(items.map(i => [i.itemId, i.kind])).toEqual([
      ['u1:0', 'assistant_text'], ['u1:1', 'tool_call'], ['u2:0', 'tool_result'], ['u3:0', 'assistant_text'],
    ])
    expect(items[2]!.payload).toEqual({ toolUseId: 'tu1', isError: false, text: '{"nodes":[]}' })
    expect(db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()).toMatchObject({ agentResumeId: 'claude-ses-9', providerLeafUuid: 'u3' })
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'completed' })

    nextQuery = q2 => q2.push(init('claude-ses-9'))
    send(sid, 'B')
    await sessions.idle()
    expect(calls[1]!.options.resume).toBe('claude-ses-9')
    expect(instances(sid).map(i => i.status)).toEqual(['exited', 'ready'])
  })

  it('Insert a notice when context is compacted', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init())
    send(sid, 'A')
    await sessions.idle()
    calls[0]!.push({ type: 'system', subtype: 'compact_boundary', uuid: 'c', session_id: 'x', compact_metadata: { trigger: 'auto', pre_tokens: 1 } } as unknown as SDKMessage)
    await until(() => notices(sid).includes('context_compacted'))
  })
})

describe('Failure and interruption', () => {
  it('Process failure before init: classify as rejected and exit the instance', async () => {
    const sid = newSession()
    nextQuery = q => q.push(new Error('spawn claude ENOENT'))
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('rejected')
    expect(notices(sid)).toEqual(['dispatch_rejected'])
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'start_failed' })
  })

  it('Timeout waiting for init: outcome unknown, no automatic resend', async () => {
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('unknown')
    expect(notices(sid)).toEqual(['dispatch_unknown'])
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'start_timeout' })
  })

  it('User stop: interrupt this call and classify the turn as interrupted', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init())
    const a = send(sid, 'A')
    await sessions.idle()
    await sessions.stop({ requestId: 'stop1', sessionId: sid, turnId: turnOf(a.messageId).id })
    expect(calls[0]!.interrupted).toBe(true)
    await until(() => turnOf(a.messageId).status === 'interrupted')
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'interrupted' })
  })

  it.each(['dispose', 'interrupt'] as const)('%s while waiting for init aborts startup; late init cannot continue running', async action => {
    const sid = newSession()
    const a = send(sid, '启动期间删除')
    await until(() => calls.length === 1)
    if (action === 'dispose') {
      sessions.dispose()
      await runtime.dispose()
    } else await sessions.stop({ requestId: 'stop-starting', sessionId: sid, turnId: turnOf(a.messageId).id })
    await sessions.idle()
    expect(calls[0]!.options.abortController?.signal.aborted).toBe(true)
    expect(instances(sid)[0]?.status).toBe('exited')
    calls[0]!.push(init())
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(instances(sid)[0]?.status).toBe('exited')
    expect(db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()?.agentResumeId).toBeNull()
    if (action === 'dispose') await expect(runtime.ensureReady(sid)).rejects.toThrow('Runtime is closed')
  })

  it('Process exit mid-turn: classify as interrupted', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init())
    const a = send(sid, 'A')
    await sessions.idle()
    calls[0]!.push(new Error('process exited with code 1'))
    await until(() => turnOf(a.messageId).status === 'interrupted')
    expect(message(a.messageId).deliveryState).toBe('delivered')
  })
})
