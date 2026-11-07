import { codexSandbox } from './descriptor'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, openSpaceDb, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { type ApprovalRequest, type ChildLike, createSessionService, type DispatchInput, type SessionService } from '@vis/workbench-core'
import { type CodexRuntimeOptions, createCodexRuntime } from './adapter'
import * as sandbox from '@vis/workbench-core'

type Handler = (params: any) => unknown | 'hang' | { error: { code: number; message: string } }

/** Fake codex app-server: responds by method name; tests can push notifications, send client requests, and exit the process */
class FakeAppServer extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly received: { method: string; params: any; id?: number }[] = []
  readonly answers = new Map<number, any>()
  exited = false
  private nextId = 1000
  constructor(readonly args: string[], readonly options: { cwd: string; env: Record<string, string | undefined> }, readonly handlers: Record<string, Handler>) {
    super()
    let buffer = ''
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        this.onMessage(JSON.parse(buffer.slice(0, nl)))
        buffer = buffer.slice(nl + 1)
      }
    })
  }
  private onMessage(msg: any) {
    if (msg.method === undefined) {
      this.answers.set(msg.id, msg.result ?? msg.error)
      return
    }
    this.received.push(msg)
    if (msg.id === undefined) return
    const handler = this.handlers[msg.method]
    const result = handler ? handler(msg.params) : {}
    if (result === 'hang') return
    if (result && typeof result === 'object' && 'error' in result) this.send({ id: msg.id, error: result.error })
    else this.send({ id: msg.id, result })
  }
  send(msg: object) {
    if (!this.exited) this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  }
  notify(method: string, params: object) {
    this.send({ method, params })
  }
  request(method: string, params: object): number {
    const id = ++this.nextId
    this.send({ id, method, params })
    return id
  }
  requests(method: string) {
    return this.received.filter(m => m.method === method)
  }
  get pid() { return 4242 }
  kill(_signal?: NodeJS.Signals) {
    this.exit()
    return true
  }
  exit() {
    if (this.exited) return
    this.exited = true
    this.stdout.end()
    setImmediate(() => this.emit('exit'))
  }
}

let db: SpaceDb
let sessions: SessionService
let servers: FakeAppServer[]
let streamed: { sessionId: string; itemId: string; revision: number; delta: string }[]
let handlers: Record<string, Handler>
let runtimeContext: Parameters<typeof createCodexRuntime>[0]
let runtimeOptions: CodexRuntimeOptions
let runtime: ReturnType<typeof createCodexRuntime>
let projectContext: DispatchInput['projectContext']
let workContext: DispatchInput['workContext']
let agentConfig: { model: string | null; effort: string | null; serviceTier: string | null } | undefined
let clock = 1_800_000_000_000
let tokenSeq = 0

const realPrepareSandbox = sandbox.prepareSandbox

beforeEach(() => {
  vi.spyOn(sandbox, 'prepareSandbox').mockImplementation(options => realPrepareSandbox({ ...options, platform: 'linux' }))
  db = openSpaceDb(':memory:')
  servers = []
  streamed = []
  tokenSeq = 0
  projectContext = undefined
  workContext = undefined
  agentConfig = undefined
  handlers = {
    'initialize': () => ({ userAgent: 'codex/0.164.0' }),
    'thread/start': () => ({ thread: { id: 'thr_new' } }),
    'thread/resume': p => ({ thread: { id: p.threadId } }),
    'turn/start': () => ({ turn: { id: `t${servers.length}`, status: 'inProgress' } }),
  }
  sessions = createSessionService({ db, runtime: { ensureReady: id => runtime.ensureReady(id), dispatchTurn: i => runtime.dispatchTurn({ ...i, ...(projectContext ? { projectContext, skills: projectContext.skills.map(skill => skill.name) } : {}), ...(workContext ? { workContext } : {}), ...(agentConfig ? { agentConfig } : {}) }), terminateTurn: i => runtime.terminateTurn(i), interruptTurn: i => runtime.interruptTurn(i) }, now: () => ++clock })
  runtimeContext = { db, report: e => sessions.handleAgentEvent(e), stream: e => streamed.push(e) }
  runtimeOptions = {
    spawn: (_command, args, options) => {
      const server = new FakeAppServer(args, options, handlers)
      servers.push(server)
      return server as unknown as ChildLike
    },
    workDir: id => db.select().from(s.sessions).where(eq(s.sessions.id, id)).get()?.workDir || join(tmpdir(), 'vis-test-work', `${id}`),
    issueToken: () => ({ token: `spc_1.tok${++tokenSeq}`, tokenHash: `hash${tokenSeq}` }),
    socketPath: '/tmp/vis.sock',
    visMcp: { command: '/usr/bin/node', args: ['/opt/vis/vis.mjs', 'mcp'] },
    startTimeoutMs: 200,
    interruptGraceMs: 50,
    env: { PATH: '/usr/bin', HOME: '/home/u' },
    now: () => ++clock,
  }
  runtime = createCodexRuntime(runtimeContext, runtimeOptions)
})
afterEach(() => vi.restoreAllMocks())

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
const item = (phase: 'started' | 'completed', turnId: string, it: object) => [`item/${phase}`, { threadId: 'thr_new', turnId, item: it }] as const

describe('A single turn', () => {
  it('Windows: allow writes without an isolation sandbox, retain approvals, and pass the vis PATH', async () => {
    vi.mocked(sandbox.prepareSandbox).mockImplementation(options => realPrepareSandbox({ ...options, platform: 'win32' }))
    runtimeOptions.cliBinDir = join(tmpdir(), 'vis cli bin')
    runtime = createCodexRuntime(runtimeContext, runtimeOptions)
    const sid = newSession()
    send(sid, 'test')
    await sessions.idle()
    const server = servers[0]!
    expect(server.options.env.PATH).toBe([runtimeOptions.cliBinDir, '/usr/bin'].join(delimiter))
    const params = server.requests('thread/start')[0]!.params
    expect(params).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'on-request' })
    expect(params.developerInstructions).toContain('Windows has no isolation sandbox')
    expect(params.developerInstructions).not.toContain('this session is read-only')
    expect(params.config.shell_environment_policy).toBeUndefined()
  })
  it('macOS sandbox: hand TMPPREFIX to the Codex shell so zsh here-documents avoid the blocked /tmp', async () => {
    vi.mocked(sandbox.prepareSandbox).mockImplementation(() => ({ env: { PATH: '/usr/bin', TMPDIR: '/work/.vis-tmp', TMPPREFIX: '/work/.vis-tmp/zsh' }, policy: undefined, notice: undefined, isolation: 'sandbox' }) as unknown as ReturnType<typeof realPrepareSandbox>)
    runtime = createCodexRuntime(runtimeContext, runtimeOptions)
    const sid = newSession()
    send(sid, 'test')
    await sessions.idle()
    const params = servers[0]!.requests('thread/start')[0]!.params
    expect(params.sandbox).toBe('danger-full-access')
    expect(params.config.shell_environment_policy).toEqual({ set: { TMPPREFIX: '/work/.vis-tmp/zsh' } })
  })
  it.each([
    { model: 'model-a', effort: 'xhigh', serviceTier: null },
    { model: 'model-a', effort: null, serviceTier: null },
    { model: null, effort: 'high', serviceTier: null },
    { model: null, effort: null, serviceTier: null },
  ])('turn/start uses this turn\'s model and effort, explicitly filling defaults from the model catalog: %j', async config => {
    // turn/start overrides persist into later thread turns; restoring defaults requires sending the default values explicitly
    const option = (id: string, isDefault: boolean, effort: string) => ({ id, model: id, displayName: id, description: '', isDefault, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: effort, description: '' }, { reasoningEffort: 'xhigh', description: '' }], defaultReasoningEffort: effort })
    handlers['model/list'] = () => ({ data: [option('model-a', false, 'low'), option('model-d', true, 'medium')] })
    agentConfig = config
    const sid = newSession()
    const first = send(sid, 'A')
    await sessions.idle()
    const params = servers[0]!.requests('turn/start')[0]!.params
    const model = config.model ?? 'model-d'
    expect(params.model).toBe(model)
    expect(params.effort).toBe(config.effort ?? (model === 'model-a' ? 'low' : 'medium'))
    expect(servers[0]!.requests('model/list')).toHaveLength(config.model && config.effort ? 0 : 1)
    // Omit speed when unselected, preserving Codex's own configuration
    expect(params).not.toHaveProperty('serviceTierForTurn')
    servers[0]!.notify('turn/completed', { turn: { id: 't1', status: 'completed' } })
    await until(() => turnOf(first.messageId).status === 'completed')
    agentConfig = { model: 'model-b', effort: 'low', serviceTier: 'fast' }
    send(sid, 'B')
    await sessions.idle()
    expect(servers[1]!.requests('thread/resume')).toHaveLength(1)
    // Speed uses only turn-level serviceTierForTurn without changing thread settings
    expect(servers[1]!.requests('turn/start')[0]!.params).toMatchObject({ model: 'model-b', effort: 'low', serviceTierForTurn: 'fast' })
    expect(servers[1]!.requests('turn/start')[0]!.params).not.toHaveProperty('serviceTier')
  })

  it('Auto-confirm vis and read the latest child work-item facts when resuming a session', async () => {
    const approve = vi.fn(async (_request: ApprovalRequest) => 'allow_once' as const)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    const first = send(sid, '找个 DeepSeek 来验收')
    await sessions.idle()
    const server = servers[0]!
    const confirmation = { serverName: 'vis', mode: 'form', requestedSchema: {}, message: 'Allow the vis MCP server to run tool "work_dispatch"?' }
    const request = server.request('mcpServer/elicitation/request', confirmation)
    await until(() => server.answers.has(request))
    expect(server.answers.get(request)).toEqual({ action: 'accept', content: {} })
    expect(approve).not.toHaveBeenCalled()
    expect(server.requests('thread/start')[0]!.params.developerInstructions).toContain('This workspace has no child work items.')

    const parentId = db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()!.workItemId!
    db.insert(s.workItems).values({ id: 'work_child', parentId, title: '子工作项', workDir: '', createdBy: { kind: 'user' }, statusChangedAt: clock, createdAt: clock }).run()
    server.notify('turn/completed', { turn: { id: 't1', status: 'completed' } })
    await until(() => turnOf(first.messageId).status === 'completed')
    send(sid, '处理子工作项报告')
    await sessions.idle()
    const resumed = servers[1]!
    const instructions = resumed.requests('thread/resume')[0]!.params.developerInstructions
    expect(instructions).toContain('Child reports automatically wake you through durable work messages')
    expect(instructions).not.toContain('This workspace has no child work items.')
    expect(resumed.requests('turn/start')[0]!.params.input[0].text).toContain('Has children: yes')
    const nextRequest = resumed.request('mcpServer/elicitation/request', confirmation)
    await until(() => resumed.answers.has(nextRequest))
    expect(resumed.answers.get(nextRequest)).toEqual({ action: 'accept', content: {} })
    expect(approve).not.toHaveBeenCalled()
  })

  it.each([null, 'work_parent'])('Native instructions and turns carry the current parent work item: %s', async parentId => {
    workContext = { workItemId: 'work_1', parentId, hasChildren: false }
    const sid = newSession()
    send(sid, '处理工作消息')
    await sessions.idle()
    const server = servers[0]!
    const instructions = server.requests('thread/start')[0]!.params.developerInstructions
    const prompt = server.requests('turn/start')[0]!.params.input[0].text
    expect(instructions).toContain(parentId === null ? 'This is a root workspace' : 'This workspace has a parent')
    expect(prompt).toContain(`Work item: work_1\nParent work item: ${parentId ?? 'none (root workspace)'}\nHas children: no`)
  })

  it('The sandbox, native thread, and approvals share the session\'s persisted working directory', async () => {
    const prepare = vi.spyOn(sandbox, 'prepareSandbox').mockReturnValue({ env: {}, policy: 'test-secure-sandbox', notice: undefined, isolation: 'sandbox' })
    const approve = vi.fn(async (_request: ApprovalRequest) => 'allow_once' as const)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    const cwd = join(tmpdir(), 'vis-test-work', `custom-${sid}`)
    db.update(s.sessions).set({ workDir: cwd }).where(eq(s.sessions.id, sid)).run()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ cwd }))
    expect(server.options.cwd).toBe(cwd)
    expect(server.requests('thread/start')[0]!.params.cwd).toBe(cwd)
    const id = server.request('item/commandExecution/requestApproval', { command: 'ls' })
    await until(() => server.answers.has(id))
    expect(approve.mock.lastCall?.[0].cwd).toBe(cwd)
  })

  it.each([false, true])('Register the project\'s native skill root and pass selected skills; older versions without the API can still read paths (%s)', async unsupported => {
    projectContext = { rootPath: '/project', assetsPath: '/project/assets', skillsPath: '/project/skills', workDir: '/project/workspaces/session', skills: [{ name: 'storyboard', description: '分镜', path: '/project/skills/storyboard/SKILL.md' }] }
    if (unsupported) handlers['skills/extraRoots/set'] = () => ({ error: { code: -32601, message: 'Method not found' } })
    const sid = newSession()
    send(sid, '制作分镜')
    await sessions.idle()
    const server = servers[0]!
    expect(server.requests('skills/extraRoots/set')[0]!.params).toEqual({ extraRoots: ['/project/skills'] })
    expect(server.received.findIndex(m => m.method === 'skills/extraRoots/set')).toBeLessThan(server.received.findIndex(m => m.method === 'thread/start'))
    expect(server.requests('turn/start')[0]!.params.input).toContainEqual({ type: 'skill', name: 'storyboard', path: '/project/skills/storyboard/SKILL.md' })
    expect(server.requests('turn/start')[0]!.params.input[0].text).toContain('<selected-skills>')
  })

  it('Startup arguments: read-only sandbox, explicit approval policy, token and socket injected through MCP', async () => {
    const sid = newSession()
    send(sid, '写一段旁白')
    await sessions.idle()
    const server = servers[0]!
    expect(server.args).toEqual(['app-server', '-c', 'model_reasoning_summary="auto"'])
    expect(server.options.cwd).toBe(join(tmpdir(), 'vis-test-work', `${sid}`))
    expect(server.received.map(m => m.method)).toEqual(['initialize', 'initialized', 'thread/start', 'model/list', 'turn/start'])
    expect(server.requests('thread/start')[0]!.params).toMatchObject({
      cwd: join(tmpdir(), 'vis-test-work', `${sid}`),
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      developerInstructions: expect.stringContaining('canvas_get'),
      config: { mcp_servers: { vis: { command: '/usr/bin/node', args: ['/opt/vis/vis.mjs', 'mcp'], env: { VIS_SOCKET: '/tmp/vis.sock', VIS_AGENT_TOKEN: 'spc_1.tok1' } } } },
    })
    const instructions = server.requests('thread/start')[0]!.params.developerInstructions
    expect(instructions).toContain('You cannot run shell commands or modify files; deliver everything to the canvas.')
    expect(instructions).not.toContain('You may run commands, edit files')
    const workItemId = db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()!.workItemId
    expect(server.requests('turn/start')[0]!.params).toMatchObject({ threadId: 'thr_new', input: [{ type: 'text', text: `写一段旁白\n\n<session>\nTitle: "分镜"\nUser-named; do not change.\n</session>\n\n<work-item>\nWork item: ${workItemId}\nParent work item: none (root workspace)\nHas children: no\n</work-item>` }] })
    // Pass the token to vis only through MCP configuration, never through the Codex process environment
    expect(server.options.env.VIS_AGENT_TOKEN).toBeUndefined()
  })

  it('turn/start response means accepted; items become transcript entries; the instance exits normally and the next turn resumes the thread', async () => {
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('delivered')
    expect(instances(sid)).toEqual([expect.objectContaining({ status: 'ready', tokenHash: 'hash1', pid: 4242 })])
    expect(turnOf(a.messageId).instanceId).toBe(instances(sid)[0]!.id)

    const server = servers[0]!
    const call = { id: 'c1', type: 'mcpToolCall', server: 'vis', tool: 'canvas_get', arguments: { snapshot: 'turn' }, status: 'inProgress' }
    server.notify(...item('started', 't1', { id: 'm0', type: 'agentMessage', text: '' }))
    server.notify(...item('completed', 't1', { id: 'm0', type: 'agentMessage', text: '我先读一下画布' }))
    server.notify(...item('started', 't1', call))
    server.notify(...item('completed', 't1', { ...call, status: 'completed', result: { content: [{ type: 'text', text: '{"nodes":[]}' }] } }))
    server.notify(...item('completed', 't1', { id: 'm1', type: 'agentMessage', text: '画布是空的' }))
    server.notify('turn/completed', { threadId: 'thr_new', turn: { id: 't1', status: 'completed' } })
    await until(() => turnOf(a.messageId).status === 'completed')

    const items = sessions.getTranscript({ sessionId: sid }).items.filter(i => i.kind !== 'user')
    expect(items.map(i => [i.itemId, i.kind])).toEqual([
      ['cx:t1:m0', 'assistant_text'], ['cx:t1:c1:call', 'tool_call'], ['cx:t1:c1:result', 'tool_result'], ['cx:t1:m1', 'assistant_text'],
    ])
    expect(items[1]!.payload).toEqual({ toolUseId: 'c1', name: 'vis.canvas_get', input: { snapshot: 'turn' } })
    expect(items[2]!.payload).toEqual({ toolUseId: 'c1', isError: false, text: '{"nodes":[]}' })
    expect(db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()).toMatchObject({ agentResumeId: 'thr_new' })
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'completed' })
    expect(server.exited).toBe(true)

    send(sid, 'B')
    await sessions.idle()
    expect(servers[1]!.received.map(m => m.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'model/list', 'turn/start'])
    expect(servers[1]!.requests('thread/resume')[0]!.params).toMatchObject({ threadId: 'thr_new', sandbox: 'read-only', approvalPolicy: 'on-request' })
    expect(instances(sid).map(i => i.status)).toEqual(['exited', 'ready'])
  })

  it('Streaming text goes through stream rather than the transcript; entry IDs match the final text', async () => {
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    server.notify('item/agentMessage/delta', { threadId: 'thr_new', turnId: 't1', itemId: 'm0', delta: '画布' })
    server.notify('item/agentMessage/delta', { threadId: 'thr_new', turnId: 't1', itemId: 'm0', delta: '是空的' })
    await until(() => streamed.length === 2)
    expect(streamed).toEqual([
      { sessionId: sid, turnId: expect.any(String), kind: 'assistant_text', itemId: 'cx:t1:m0', revision: 1, delta: '画布' },
      { sessionId: sid, turnId: expect.any(String), kind: 'assistant_text', itemId: 'cx:t1:m0', revision: 1, delta: '是空的' },
    ])
    expect(sessions.getTranscript({ sessionId: sid }).items.filter(i => i.kind === 'assistant_text')).toEqual([])
    server.notify(...item('completed', 't1', { id: 'm0', type: 'agentMessage', text: '画布是空的' }))
    await until(() => sessions.getTranscript({ sessionId: sid }).items.some(i => i.itemId === 'cx:t1:m0'))
  })

  it('Reasoning summary streams share IDs with completed entries; plan updates replace in place', async () => {
    const sid = newSession()
    const sent = send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const turnId = turnOf(sent.messageId).id
    server.notify(...item('started', 't1', { id: 'r', type: 'reasoning' }))
    await until(() => sessions.getTranscript({ sessionId: sid }).items.some(i => i.kind === 'reasoning'))
    const initial = sessions.getTranscript({ sessionId: sid }).items.find(i => i.kind === 'reasoning')!
    server.notify('item/reasoning/summaryPartAdded', { turnId: 't1', itemId: 'r', summaryIndex: 0 })
    server.notify('item/reasoning/summaryTextDelta', { turnId: 't1', itemId: 'r', summaryIndex: 0, delta: '先读' })
    server.notify('item/reasoning/summaryPartAdded', { turnId: 't1', itemId: 'r', summaryIndex: 1 })
    server.notify('item/reasoning/summaryTextDelta', { turnId: 't1', itemId: 'r', summaryIndex: 1, delta: '再写' })
    await until(() => streamed.length === 3)
    expect(streamed).toEqual(['先读', '\n\n', '再写'].map(delta => ({ sessionId: sid, turnId, itemId: 'cx:t1:r', revision: 2, kind: 'reasoning', delta })))
    expect(sessions.getTranscript({ sessionId: sid }).items.filter(i => i.kind === 'reasoning')).toEqual([initial])
    server.notify(...item('completed', 't1', { id: 'r', type: 'reasoning', summary: ['先读', '再写'] }))
    server.notify(...item('completed', 't1', { id: 'r', type: 'reasoning', summary: ['先读', '再写'] }))
    server.notify('turn/plan/updated', { turnId: 't1', plan: [{ step: '读', status: 'inProgress' }], explanation: '先读' })
    await until(() => sessions.getTranscript({ sessionId: sid }).items.some(i => i.kind === 'plan'))
    expect(sessions.getTranscript({ sessionId: sid }).items.find(i => i.kind === 'plan')).toMatchObject({ revision: 1, payload: { entries: [{ text: '读', status: 'in_progress' }], explanation: '先读' } })
    server.notify('turn/plan/updated', { turnId: 't1', plan: [{ step: '写', status: 'completed' }], explanation: null })
    await until(() => sessions.getTranscript({ sessionId: sid }).items.some(i => i.kind === 'plan' && i.revision === 2))
    const items = sessions.getTranscript({ sessionId: sid }).items
    const completed = items.find(i => i.kind === 'reasoning')!
    expect(completed.createdAt).toBe(initial.createdAt)
    expect(completed.createdSeq).toBe(initial.createdSeq)
    expect(completed.updatedAt).toBeGreaterThan(initial.updatedAt)
    expect(items.filter(i => i.kind === 'reasoning')).toMatchObject([{ itemId: 'cx:t1:r', revision: 2, payload: { text: '先读\n\n再写' } }])
    expect(items.filter(i => i.kind === 'plan')).toMatchObject([{ itemId: 'cx:t1:plan', revision: 2, payload: { entries: [{ text: '写', status: 'completed' }] } }])
  })

  it('Without an approval callback, reject command, file, permission, and all MCP requests; error on others', async () => {
    vi.spyOn(sandbox, 'prepareSandbox').mockReturnValue({ env: {}, policy: 'test-secure-sandbox', notice: undefined, isolation: 'sandbox' })
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const ids = {
      command: server.request('item/commandExecution/requestApproval', { threadId: 'thr_new', turnId: 't1', itemId: 'x', command: 'rm -rf /' }),
      file: server.request('item/fileChange/requestApproval', { threadId: 'thr_new', turnId: 't1', itemId: 'y' }),
      legacyCommand: server.request('execCommandApproval', { conversationId: 'thr_new', callId: 'z', command: ['ls'], cwd: '/tmp/work' }),
      legacyFile: server.request('applyPatchApproval', { conversationId: 'thr_new', callId: 'patch', fileChanges: {} }),
      permissions: server.request('item/permissions/requestApproval', { threadId: 'thr_new', turnId: 't1', permissions: { network: { enabled: true } } }),
      // english-exempt: Agent-provided approval prompt fixture; preserve original content.
      vis: server.request('mcpServer/elicitation/request', { serverName: 'vis', threadId: 'thr_new', mode: 'form', message: '允许调用 canvas_get？', requestedSchema: {} }),
      other: server.request('mcpServer/elicitation/request', { serverName: 'evil', threadId: 'thr_new', mode: 'form', message: '?', requestedSchema: {} }),
      unknown: server.request('item/tool/call', { tool: 'x' }),
    }
    await until(() => server.answers.size === 8)
    expect(server.answers.get(ids.command)).toEqual({ decision: 'decline' })
    expect(server.answers.get(ids.file)).toEqual({ decision: 'decline' })
    expect(server.answers.get(ids.legacyCommand)).toMatchObject({ decision: { denied: { rejection: expect.any(String) } } })
    expect(server.answers.get(ids.legacyFile)).toMatchObject({ decision: { denied: { rejection: expect.any(String) } } })
    expect(server.answers.get(ids.permissions)).toEqual({ permissions: {}, scope: 'turn' })
    expect(server.answers.get(ids.vis)).toEqual({ action: 'decline' })
    expect(server.answers.get(ids.other)).toEqual({ action: 'decline' })
    expect(server.answers.get(ids.unknown)).toMatchObject({ code: -32601 })
  })

  it.each(['allow_once', 'allow_session', 'deny'] as const)('Native approval mapping for the isolation sandbox: %s', async decision => {
    vi.spyOn(sandbox, 'prepareSandbox').mockReturnValue({ env: {}, policy: 'test-secure-sandbox', notice: undefined, isolation: 'sandbox' })
    const approve = vi.fn(async (_request: ApprovalRequest) => decision)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    const sent = send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const changes = [{ path: '/tmp/work/a.txt', kind: { type: 'update', move_path: null }, diff: '-old\n+new' }]
    server.notify(...item('started', 't1', { id: 'file-item', type: 'fileChange', changes }))
    const permissions = { network: { enabled: true }, fileSystem: { write: ['/tmp/work/a.txt'] } }
    const ids = {
      command: server.request('item/commandExecution/requestApproval', { threadId: 'thr_new', turnId: 't1', itemId: 'command-item', command: 'ls -la', cwd: '/tmp/work', reason: '查看工作目录' }),
      network: server.request('item/commandExecution/requestApproval', { threadId: 'thr_new', turnId: 't1', itemId: 'network-item', command: 'curl https://example.com', networkApprovalContext: { host: 'example.com', protocol: 'https' } }),
      file: server.request('item/fileChange/requestApproval', { threadId: 'thr_new', turnId: 't1', itemId: 'file-item', reason: '更新文案' }),
      permissions: server.request('item/permissions/requestApproval', { threadId: 'thr_new', turnId: 't1', itemId: 'permission-item', permissions, cwd: '/tmp/work' }),
      legacyCommand: server.request('execCommandApproval', { conversationId: 'thr_new', callId: 'legacy-command', command: ['printf', 'a b'], cwd: '/tmp/work' }),
      legacyFile: server.request('applyPatchApproval', { conversationId: 'thr_new', callId: 'legacy-patch', fileChanges: { '/tmp/work/b.txt': { type: 'add', content: 'text' } } }),
      // english-exempt: Agent-provided approval prompt fixture; preserve original content.
      mcp: server.request('mcpServer/elicitation/request', { serverName: 'vis', threadId: 'thr_new', turnId: 't1', mode: 'url', message: '授权资源访问', url: 'https://example.com/auth', elicitationId: 'el_1' }),
    }
    await until(() => server.answers.size === 7)
    const native = decision === 'deny' ? 'decline' : 'accept'
    for (const id of [ids.command, ids.network, ids.file]) expect(server.answers.get(id)).toEqual({ decision: native })
    for (const id of [ids.legacyCommand, ids.legacyFile]) {
      expect(server.answers.get(id)).toEqual({ decision: decision === 'deny' ? { denied: { rejection: expect.any(String) } } : 'approved' })
    }
    expect(server.answers.get(ids.permissions)).toEqual({ permissions: decision === 'deny' ? {} : permissions, scope: 'turn' })
    expect(server.answers.get(ids.mcp)).toEqual(decision === 'deny' ? { action: 'decline' } : { action: 'accept', content: {} })
    const requests = approve.mock.calls.map(call => call[0])
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: sid, turnId: turnOf(sent.messageId).id, kind: 'command', summary: 'ls -la', detail: 'ls -la\n查看工作目录', cwd: '/tmp/work' }),
      expect.objectContaining({ kind: 'file_write', detail: `${JSON.stringify(changes, null, 2)}\n更新文案`, paths: ['/tmp/work/a.txt'] }),
      expect.objectContaining({ kind: 'network', detail: expect.stringContaining('example.com') }),
      expect.objectContaining({ kind: 'network', detail: JSON.stringify(permissions, null, 2) }),
      expect.objectContaining({ kind: 'command', detail: '["printf","a b"]' }),
    ]))
    expect(requests.every(request => !/threadId|turnId|itemId|callId|elicitationId/.test(request.detail))).toBe(true)
    server.notify(...item('started', 't1', { id: 'missing-file-detail', type: 'fileChange', changes: [] }))
    const incomplete = server.request('item/fileChange/requestApproval', { itemId: 'missing-file-detail' })
    await until(() => server.answers.has(incomplete))
    expect(approve.mock.lastCall?.[0]).toMatchObject({ kind: 'file_write', detail: '文件变更详情未提供：missing-file-detail' })
    expect(approve.mock.lastCall?.[0].paths).toBeUndefined()
    const stdinIds = ['terminal-a', 'terminal-b'].map(itemId => server.request('item/commandExecution/requestApproval', { itemId, kind: 'writeStdin', command: 'yes\n' }))
    await until(() => stdinIds.every(id => server.answers.has(id)))
    expect(approve.mock.calls.slice(-2).map(call => call[0].detail)).toEqual(['yes\n\n写入终端输入：terminal-a', 'yes\n\n写入终端输入：terminal-b'])
    expect(approve.mock.calls.slice(-2).every(call => call[0].autoApprovalBlocked)).toBe(true)
  })

  it('Automatic approval evidence includes every file and move destination; grantRoot or cwd cannot stand in for unknown changes', async () => {
    vi.spyOn(sandbox, 'prepareSandbox').mockReturnValue({ env: {}, policy: 'test-secure-sandbox', notice: undefined, isolation: 'sandbox' })
    const approve = vi.fn(async (_request: ApprovalRequest) => 'deny' as const)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const cases = [
      { method: 'item/fileChange/requestApproval', params: { fileChanges: [{ path: '/tmp/work/old.txt', kind: { type: 'update', move_path: '/tmp/outside/new.txt' } }, { path: '/tmp/work/add.txt', kind: { type: 'add' } }] }, paths: ['/tmp/work/old.txt', '/tmp/outside/new.txt', '/tmp/work/add.txt'] },
      { method: 'item/fileChange/requestApproval', params: { fileChanges: [{ path: '/tmp/work/old.txt', kind: { type: 'update', movePath: '/tmp/work/new.txt' } }] }, paths: ['/tmp/work/old.txt', '/tmp/work/new.txt'] },
      { method: 'applyPatchApproval', params: { fileChanges: { '/tmp/work/old.txt': { type: 'update', move_path: '/tmp/outside/new.txt' } } }, paths: ['/tmp/work/old.txt', '/tmp/outside/new.txt'] },
      { method: 'item/fileChange/requestApproval', params: { fileChanges: [{ path: '/tmp/work/a.txt', kind: { type: 'add' } }], grantRoot: '/tmp/outside' }, paths: ['/tmp/work/a.txt', '/tmp/outside'] },
      { method: 'item/fileChange/requestApproval', params: { grantRoot: '/tmp/work', cwd: '/tmp/work' }, paths: undefined },
      { method: 'item/fileChange/requestApproval', params: { fileChanges: [{ kind: { type: 'add' } }] }, paths: undefined },
      { method: 'item/fileChange/requestApproval', params: { fileChanges: [{ path: '/tmp/work/a.txt', kind: { type: 'unknown' } }] }, paths: undefined },
      { method: 'item/fileChange/requestApproval', params: { fileChanges: [{ path: '/tmp/work/a.txt', kind: { type: 'update', movePath: 42 } }] }, paths: undefined },
    ]
    for (const entry of cases) {
      const id = server.request(entry.method, entry.params)
      await until(() => server.answers.has(id))
      expect(approve.mock.lastCall?.[0].paths).toEqual(entry.paths)
    }
  })

  it('Extra command permissions and external environments are not auto-approved by cwd; invalid cwd has no fallback', async () => {
    vi.spyOn(sandbox, 'prepareSandbox').mockReturnValue({ env: {}, policy: 'test-secure-sandbox', notice: undefined, isolation: 'sandbox' })
    const approve = vi.fn(async (_request: ApprovalRequest) => 'deny' as const)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    for (const evidence of [{ additionalPermissions: { fileSystem: { write: ['/outside'] } } }, { additional_permissions: { network: { enabled: true } } }, { environmentId: 'remote' }]) {
      const id = server.request('item/commandExecution/requestApproval', { command: 'echo test', cwd: '/tmp/work', ...evidence })
      await until(() => server.answers.has(id))
      expect(approve.mock.lastCall?.[0]).toMatchObject({ kind: 'command', cwd: '/tmp/work', autoApprovalBlocked: true })
    }
    const malformed = server.request('item/commandExecution/requestApproval', { command: 'echo test', cwd: 42 })
    await until(() => server.answers.has(malformed))
    expect(approve.mock.lastCall?.[0].cwd).toBeUndefined()
  })

  it('Without outer isolation, native permissions cannot be elevated even with an allow callback', async () => {
    const approve = vi.fn(async () => 'allow_once' as const)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const ids = [
      server.request('item/commandExecution/requestApproval', { command: 'ls' }),
      server.request('item/fileChange/requestApproval', { itemId: 'patch' }),
      server.request('item/permissions/requestApproval', { permissions: { network: { enabled: true } } }),
    ]
    await until(() => server.answers.size === 3)
    expect(server.answers.get(ids[0]!)).toEqual({ decision: 'decline' })
    expect(server.answers.get(ids[1]!)).toEqual({ decision: 'decline' })
    expect(server.answers.get(ids[2]!)).toEqual({ permissions: {}, scope: 'turn' })
    expect(approve).not.toHaveBeenCalled()
  })

  it('MCP approval waits for the callback; required forms and approval errors remain denied', async () => {
    let resolve!: (decision: 'allow_once') => void
    const approve = vi.fn(() => new Promise<'allow_once'>(r => { resolve = r }))
    runtimeContext.requestApproval = approve
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    // english-exempt: Agent-provided approval prompt fixture; preserve original content.
    const id = server.request('mcpServer/elicitation/request', { serverName: 'other', mode: 'form', message: '允许读取？', requestedSchema: {} })
    await until(() => approve.mock.calls.length === 1)
    expect(server.answers.has(id)).toBe(false)
    resolve('allow_once')
    await until(() => server.answers.has(id))
    expect(server.answers.get(id)).toEqual({ action: 'accept', content: {} })
    const required = server.request('mcpServer/elicitation/request', { serverName: 'vis', mode: 'form', requestedSchema: { required: ['email'] } })
    await until(() => server.answers.has(required))
    expect(server.answers.get(required)).toEqual({ action: 'decline' })
    runtimeContext.requestApproval = async () => { throw new Error('Approval channel is closed') }
    const failed = server.request('mcpServer/elicitation/request', { serverName: 'vis', mode: 'form', requestedSchema: {} })
    await until(() => server.answers.has(failed))
    expect(server.answers.get(failed)).toEqual({ action: 'decline' })
  })

  it.each([
    { params: { serverName: 'vis', message: 'Allow the vis MCP server to run tool "canvas_get"?' }, expected: { serverName: 'vis', toolName: 'canvas_get' } },
    // english-exempt: Agent-provided tool confirmation fixture; preserve original content.
    { params: { serverName: 'vis', toolName: 'canvas_apply', message: '调用画布工具' }, expected: { serverName: 'vis', toolName: 'canvas_apply' } },
    { params: { serverName: 'other', toolName: 'canvas_get', message: 'Allow the vis MCP server to run tool "canvas_get"?' }, expected: undefined },
    { params: { serverName: 'vis', message: 'Allow the vis MCP server to run tool "canvas_get"? Extra request' }, expected: undefined },
    { params: { serverName: 'vis', message: 'Allow the vis MCP server to run tool "canvas_get"?\n' }, expected: undefined },
    // english-exempt: Agent-provided tool confirmation fixture; preserve original content.
    { params: { serverName: 'vis', toolName: 'canvas_get()', message: '调用画布工具' }, expected: undefined },
    { params: { serverName: 'vis', message: 'Allow the vis MCP server to run tool "canvas_get"?', requestedSchema: { type: 'object', properties: { input: { type: 'string' } } } }, expected: undefined },
    { params: { serverName: 'vis', message: 'Allow the vis MCP server to run tool "canvas_get"?', mode: 'url' }, expected: undefined },
  ])('Auto-approve only recognized vis tool confirmations: $params.message', async ({ params, expected }) => {
    const approve = vi.fn(async (_request: ApprovalRequest) => 'allow_once' as const)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const id = server.request('mcpServer/elicitation/request', { mode: 'form', requestedSchema: {}, ...params })
    await until(() => server.answers.has(id))
    if (expected) expect(approve).not.toHaveBeenCalled()
    else expect(approve).toHaveBeenCalledOnce()
    expect(server.answers.get(id)).toEqual({ action: 'accept', content: {} })
  })

  it.each([undefined, null, 'work_parent'])('Auto-approve vis tool confirmations and ask normally for others: %s', async parentId => {
    workContext = parentId === undefined ? undefined : { workItemId: 'work_1', parentId, hasChildren: false }
    const approve = vi.fn(async (_request: ApprovalRequest) => 'deny' as const)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    if (parentId === undefined) db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, sid)).run()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const vis = server.request('mcpServer/elicitation/request', { serverName: 'vis', mode: 'form', requestedSchema: {}, message: 'Allow the vis MCP server to run tool "work_report"?' })
    const other = server.request('mcpServer/elicitation/request', { serverName: 'evil', mode: 'form', requestedSchema: {}, message: 'Allow the evil MCP server to run tool "x"?' })
    await until(() => server.answers.has(vis) && server.answers.has(other))
    expect(server.answers.get(vis)).toEqual({ action: 'accept', content: {} })
    expect(server.answers.get(other)).toEqual({ action: 'decline' })
    expect(approve.mock.calls.map(([request]) => request.mcpTool?.toolName ?? null)).toEqual([null])
  })

  it('Denied commands become failed tool results; context compaction inserts a notice', async () => {
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    server.notify(...item('completed', 't1', { id: 'x1', type: 'commandExecution', command: 'ls', status: 'declined', aggregatedOutput: null, exitCode: null }))
    server.notify('thread/compacted', { threadId: 'thr_new', turnId: 't1' })
    await until(() => notices(sid).includes('context_compacted'))
    const result = sessions.getTranscript({ sessionId: sid }).items.find(i => i.kind === 'tool_result')!
    expect(result.payload).toMatchObject({ isError: true })
  })
})

describe('Model catalog probing', () => {
  const model = { id: 'model-a', model: 'native-a', displayName: '模型 A', description: '说明', isDefault: true, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '深入思考' }], defaultReasoningEffort: 'high' }

  it('Use the same isolation and configuration as real turns, paginate and filter hidden models, and create no thread or runtime instance', async () => {
    runtimeOptions.dataDir = join(tmpdir(), 'vis-test-data')
    const prepare = vi.spyOn(sandbox, 'prepareSandbox').mockReturnValue({ env: { PATH: '/usr/bin' }, policy: 'test-secure-sandbox', notice: undefined, isolation: 'sandbox' })
    handlers['model/list'] = p => p.cursor === 'next'
      ? { data: [{ ...model, id: 'model-b', displayName: '模型 B', isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'none' }], nextCursor: null }
      : { data: [model, { ...model, id: 'hidden', hidden: true }], nextCursor: 'next' }
    expect(await runtime.agentOptions('codex', {})).toEqual([
      { id: 'model-a', label: '模型 A', description: '说明', isDefault: true, efforts: [{ id: 'high', label: 'high', description: '深入思考' }], defaultEffort: 'high', serviceTiers: [] },
      { id: 'model-b', label: '模型 B', description: '说明', isDefault: false, efforts: [], defaultEffort: 'none', serviceTiers: [] },
    ])
    const server = servers[0]!
    expect(prepare).toHaveBeenCalledWith({ agent: codexSandbox, cwd: server.options.cwd, dataDir: join(tmpdir(), 'vis-test-data'), env: { PATH: '/usr/bin', HOME: '/home/u' } })
    expect(server.args).toEqual(['-p', 'test-secure-sandbox', 'codex', 'app-server', '-c', 'model_reasoning_summary="auto"'])
    expect(server.options.env).toEqual({ PATH: '/usr/bin' })
    expect(server.received.map(m => m.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list'])
    expect(server.requests('model/list').map(request => request.params)).toEqual([{ includeHidden: false }, { includeHidden: false, cursor: 'next' }])
    expect(server.exited).toBe(true)
    expect(existsSync(server.options.cwd)).toBe(false)
    expect(db.select().from(s.agentInstances).all()).toEqual([])
    expect(tokenSeq).toBe(0)
  })

  it('Speed tiers use serviceTiers with legacy additionalSpeedTiers fallback, excluding standard speed and invalid entries', async () => {
    handlers['model/list'] = () => ({ data: [
      { ...model, serviceTiers: [{ id: 'fast', name: 'Fast', description: '更快，消耗更多额度' }, { id: 'default', name: 'Standard', description: '' }, { id: '', name: 'x', description: '' }], additionalSpeedTiers: ['ignored'] },
      { ...model, id: 'model-b', isDefault: false, additionalSpeedTiers: ['fast', 'default', 1] },
      { ...model, id: 'model-c', isDefault: false, serviceTiers: 'bad' },
    ] })
    expect((await runtime.agentOptions('codex', {})).map(option => [option.id, option.serviceTiers])).toEqual([
      ['model-a', [{ id: 'fast', label: 'Fast', description: '更快，消耗更多额度' }]],
      ['model-b', [{ id: 'fast', label: 'fast' }]],
      ['model-c', []],
    ])
  })

  it.each(['model-b', 'native-b'])('Configuration override %s determines the actual default model', async configuredModel => {
    runtimeOptions.model = configuredModel
    handlers['model/list'] = () => ({ data: [model, { ...model, id: 'model-b', model: 'native-b', isDefault: false }] })
    expect((await runtime.agentOptions('codex', {})).map(option => [option.id, option.isDefault])).toEqual([['model-a', false], ['model-b', true]])
  })

  it('Force-stop probe processes that ignore SIGTERM; delete the working directory only after confirmed exit', async () => {
    let kill: ReturnType<typeof vi.spyOn>
    handlers['model/list'] = () => {
      const server = servers[0]!
      kill = vi.spyOn(server, 'kill').mockImplementation(signal => {
        expect(existsSync(server.options.cwd)).toBe(true)
        if (signal === 'SIGKILL') server.exit()
        return true
      })
      return { data: [model] }
    }
    await runtime.agentOptions('codex', {})
    expect(kill!.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(servers[0]!.exited).toBe(true)
    expect(existsSync(servers[0]!.options.cwd)).toBe(false)
  })

  it.each([
    { data: null },
    { data: [null] },
    { data: [{ ...model, supportedReasoningEfforts: null }] },
    { data: [model], nextCursor: 1 },
    { data: [model], nextCursor: 'repeated' },
  ])('Reject invalid catalogs or repeated pagination cursors and clean up: %j', async response => {
    handlers['model/list'] = () => response
    await expect(runtime.agentOptions('codex', {})).rejects.toThrow()
    expect(servers[0]!.exited).toBe(true)
    expect(existsSync(servers[0]!.options.cwd)).toBe(false)
  })

  it.each(['initialize', 'model/list'])('Throw and clean up the probe process when %s fails', async method => {
    handlers[method] = () => ({ error: { code: -32603, message: 'Not logged in' } })
    await expect(runtime.agentOptions('codex', {})).rejects.toThrow('Not logged in')
    expect(servers[0]!.exited).toBe(true)
    expect(existsSync(servers[0]!.options.cwd)).toBe(false)
  })

  it('Process startup errors fail promptly and clean up the working directory', async () => {
    handlers['initialize'] = () => {
      setImmediate(() => servers[0]!.emit('error', new Error('spawn ENOENT')))
      return 'hang'
    }
    await expect(runtime.agentOptions('codex', {})).rejects.toThrow('ENOENT')
    expect(servers[0]!.exited).toBe(true)
    expect(existsSync(servers[0]!.options.cwd)).toBe(false)
  })

  it.each(['initialize', 'model/list'])('Clean up the probe process when %s times out', async method => {
    handlers[method] = () => 'hang'
    await expect(runtime.agentOptions('codex', {})).rejects.toThrow('Timed out')
    expect(servers[0]!.exited).toBe(true)
    expect(existsSync(servers[0]!.options.cwd)).toBe(false)
  })

  it('disposal waits for an already-finishing model catalog probe with delayed process exit', async () => {
    handlers['model/list'] = () => ({ data: [] })
    let stopping!: () => void
    const stopSeen = new Promise<void>(resolve => { stopping = resolve })
    const probing = runtime.agentOptions('codex', {})
    const server = servers[0]!
    server.kill = () => { stopping(); return true }
    await stopSeen
    let disposed = false
    const disposal = runtime.dispose().then(() => { disposed = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(disposed).toBe(false)
    } finally { server.exit(); await Promise.all([disposal, probing]) }
    expect(existsSync(server.options.cwd)).toBe(false)
  })

  it('Closing the runtime aborts probes and rejects new probes after closure', async () => {
    handlers['model/list'] = () => 'hang'
    const probing = runtime.agentOptions('codex', {})
    const rejected = expect(probing).rejects.toThrow()
    await until(() => servers[0]?.requests('model/list').length === 1)
    await runtime.dispose()
    await rejected
    expect(servers[0]!.exited).toBe(true)
    expect(existsSync(servers[0]!.options.cwd)).toBe(false)
    await expect(runtime.agentOptions('codex', {})).rejects.toThrow('is closed')
    expect(servers).toHaveLength(1)
  })
})

describe('Failure and interruption', () => {
  it('disposes a failed spawn that never emits exit after recording its startup failure', async () => {
    handlers['initialize'] = () => 'hang'
    const sid = newSession()
    send(sid, 'Hold')
    await until(() => servers[0]?.requests('initialize').length === 1)
    const server = servers[0]!
    Object.defineProperty(server, 'pid', { value: undefined })
    server.kill = () => true
    server.emit('error', new Error('spawn codex ENOENT'))
    await sessions.idle()
    let disposed = false
    const disposal = runtime.dispose().then(() => { disposed = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(disposed).toBe(true)
      expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'start_failed' })
    } finally { server.exit(); await disposal }
  })

  it('hard termination waits for delayed process exit before releasing the workspace', async () => {
    const sid = newSession()
    const sent = send(sid, 'Hold')
    await sessions.idle()
    const server = servers[0]!
    server.kill = () => true
    let terminated = false
    const termination = runtime.terminateTurn({ sessionId: sid, turnId: turnOf(sent.messageId).id }).then(() => { terminated = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(terminated).toBe(false)
      expect(server.exited).toBe(false)
    } finally { server.exit(); await termination }
    expect(instances(sid)[0]?.status).toBe('exited')
    await runtime.dispose()
  })

  it('Closing the runtime during startup handshake stops the starting process and rejects subsequent turns', async () => {
    handlers['initialize'] = () => 'hang'
    const sid = newSession()
    const sent = send(sid, 'A')
    await until(() => servers[0]?.requests('initialize').length === 1)
    await runtime.dispose()
    expect(servers[0]!.exited).toBe(true)
    await sessions.idle()
    expect(message(sent.messageId).deliveryState).toBe('rejected')
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'start_failed' })
    const next = send(newSession(), 'B')
    await sessions.idle()
    expect(message(next.messageId).deliveryState).toBe('rejected')
    expect(servers).toHaveLength(1)
  })

  it('Failure before turn/start: classify as rejected and exit the instance', async () => {
    handlers['thread/start'] = () => ({ error: { code: -32600, message: 'Not logged in' } })
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('rejected')
    expect(notices(sid)).toEqual(['dispatch_rejected'])
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'start_failed' })
    expect(servers[0]!.exited).toBe(true)
  })

  it('Handshake timeout: the message was not sent, so classify as rejected', async () => {
    handlers['initialize'] = () => 'hang'
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('rejected')
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'start_timeout' })
  })

  it('Timeout waiting for turn/start response: outcome unknown, no automatic resend', async () => {
    handlers['turn/start'] = () => 'hang'
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('unknown')
    expect(notices(sid)).toEqual(['dispatch_unknown'])
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'start_timeout' })
  })

  it('Process exit before turn/start response: outcome unknown', async () => {
    handlers['turn/start'] = () => { setImmediate(() => servers[0]!.exit()); return 'hang' }
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('unknown')
  })

  it('User stop: send turn/interrupt and classify the turn as interrupted', async () => {
    handlers['turn/interrupt'] = p => {
      setImmediate(() => servers[0]!.notify('turn/completed', { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted' } }))
      return {}
    }
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    await sessions.stop({ requestId: 'stop1', sessionId: sid, turnId: turnOf(a.messageId).id })
    expect(servers[0]!.requests('turn/interrupt')[0]!.params).toEqual({ threadId: 'thr_new', turnId: 't1' })
    await until(() => turnOf(a.messageId).status === 'interrupted')
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'interrupted' })
  })

  it('Unresponsive interruption: stop the process after the grace period', async () => {
    handlers['turn/interrupt'] = () => 'hang'
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    await sessions.stop({ requestId: 'stop1', sessionId: sid, turnId: turnOf(a.messageId).id })
    await until(() => turnOf(a.messageId).status === 'interrupted')
    expect(servers[0]!.exited).toBe(true)
  })

  it('Process exit mid-turn: classify as interrupted', async () => {
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    servers[0]!.exit()
    await until(() => turnOf(a.messageId).status === 'interrupted')
    expect(message(a.messageId).deliveryState).toBe('delivered')
  })
})
