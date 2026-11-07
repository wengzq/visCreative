import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, openSpaceDb, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { type ApprovalRequest, type ChildLike, createSessionService, type DispatchInput, type SessionService } from '@vis/workbench-core'
import { createDeepseekRuntime } from './adapter'
import * as resolver from './resolve-dsh'
import * as sandbox from '@vis/workbench-core'

type Handler = (params: any, id: number) => unknown | 'hang' | { error: { code: number; message: string } }

/** Fake dsh ACP server: responds by method name; tests can push updates, defer prompt responses, send client requests, and exit the process */
class FakeAcpServer extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly received: { method: string; params: any; id?: number }[] = []
  readonly answers = new Map<number, any>()
  exited = false
  ignoreStdinEnd = false
  ignoreTerm = false
  readonly signals: NodeJS.Signals[] = []
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
    // Exit when the client closes stdin, like dsh
    this.stdin.on('end', () => { if (!this.ignoreStdinEnd) this.exit() })
  }
  private onMessage(msg: any) {
    if (msg.method === undefined) {
      this.answers.set(msg.id, msg.result ?? msg.error)
      return
    }
    this.received.push(msg)
    if (msg.id === undefined) return
    const handler = this.handlers[msg.method]
    const result = handler ? handler(msg.params, msg.id) : {}
    if (result === 'hang') return
    if (result && typeof result === 'object' && 'error' in result) this.send({ id: msg.id, error: result.error })
    else this.send({ id: msg.id, result })
  }
  send(msg: object) {
    if (!this.exited) this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  }
  update(update: object) {
    this.send({ method: 'session/update', params: { sessionId: 'dss_1', update } })
  }
  /** Answer the pending session/prompt */
  settlePrompt(result: object | { error: { code: number; message: string } }) {
    const id = this.requests('session/prompt').at(-1)!.id!
    if ('error' in result) this.send({ id, error: result.error })
    else this.send({ id, result })
  }
  request(method: string, params: object): number {
    const id = ++this.nextId
    this.send({ id, method, params })
    return id
  }
  requests(method: string) {
    return this.received.filter(m => m.method === method)
  }
  get pid() { return 4343 }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.signals.push(signal)
    if (signal === 'SIGKILL' || !this.ignoreTerm) this.exit()
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
let servers: FakeAcpServer[]
let handlers: Record<string, Handler>
let runtimeContext: Parameters<typeof createDeepseekRuntime>[0]
let runtime: ReturnType<typeof createDeepseekRuntime>
let projectContext: DispatchInput['projectContext']
let workContext: DispatchInput['workContext']
let agentConfig: DispatchInput['agentConfig']
let dir: string
let clock = 1_800_000_000_000
let tokenSeq = 0

const realPrepareSandbox = sandbox.prepareSandbox

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(sandbox, 'prepareSandbox').mockImplementation(options => realPrepareSandbox({ ...options, platform: 'linux' }))
  vi.spyOn(resolver, 'resolveDsh').mockReturnValue({ path: '/fake/dsh', version: 'test' })
  db = openSpaceDb(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'vis-dsh-'))
  servers = []
  tokenSeq = 0
  projectContext = undefined
  workContext = undefined
  agentConfig = undefined
  handlers = {
    'initialize': () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
    'session/new': () => ({ sessionId: 'dss_1', configOptions: [] }),
    'session/resume': () => ({ configOptions: [] }),
    'session/prompt': () => 'hang',
  }
  sessions = createSessionService({ db, runtime: { ensureReady: id => runtime.ensureReady(id), dispatchTurn: i => runtime.dispatchTurn({ ...i, ...(projectContext ? { projectContext } : {}), ...(workContext ? { workContext } : {}), ...(agentConfig ? { agentConfig } : {}) }), terminateTurn: i => runtime.terminateTurn(i), interruptTurn: i => runtime.interruptTurn(i) }, now: () => ++clock })
  runtimeContext = { db, report: e => sessions.handleAgentEvent(e) }
  runtime = createDeepseekRuntime(runtimeContext, {
    spawn: (_command, args, options) => {
      const server = new FakeAcpServer(args, options, handlers)
      servers.push(server)
      return server as unknown as ChildLike
    },
    workDir: id => db.select().from(s.sessions).where(eq(s.sessions.id, id)).get()?.workDir || join(dir, 'sessions', id),
    overlayPath: join(dir, 'agents', 'dsh-overlay.yml'),
    cliBinDir: join(dir, 'cli bin'),
    issueToken: () => ({ token: `spc_1.tok${++tokenSeq}`, tokenHash: `hash${tokenSeq}` }),
    socketPath: '/tmp/vis.sock',
    visMcp: { command: '/usr/bin/node', args: ['/opt/vis/vis.mjs', 'mcp'] },
    startTimeoutMs: 200,
    admissionMs: 50,
    interruptGraceMs: 50,
    env: { PATH: '/usr/bin', HOME: '/home/u', DEEPSEEK_API_KEY: 'sk-from-user-env' },
    now: () => ++clock,
  })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

let req = 0
function newSession() {
  return sessions.create({ requestId: `r${++req}`, title: '分镜', agentKind: 'deepseek' }).sessionId
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

const FLASH = 'opaque:flash/default'
const PRO = 'opaque:pro/model'
const PLAIN = 'opaque:no-reasoning'
function acpConfig(model = FLASH, effort = 'high', providerDefault = false) {
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [
      { group: 'deepseek-official', name: 'DeepSeek', options: [
        { value: FLASH, name: 'Flash', description: '快速模型' },
        { value: PRO, name: 'Pro' },
      ] },
      { group: 'other', name: 'Other', options: [{ value: PLAIN, name: 'Plain' }] },
    ] },
    ...(model === PLAIN ? [] : [{ id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: effort, options: [
      ...(providerDefault ? [{ value: '', name: 'Provider default' }] : []),
      { value: 'low', name: '低' },
      { value: 'high', name: '高', description: '仔细推理' },
      ...(model === PRO ? [{ value: 'max', name: '最高' }] : []),
    ] }]),
  ]
}

describe('Model and reasoning effort (0014)', () => {
  it('Use the same sandbox and overlay, probe effort for each opaque model value, close sessions, and send no model requests', async () => {
    vi.spyOn(sandbox, 'prepareSandbox').mockReturnValue({ env: { HOME: dir }, policy: 'test-policy', notice: undefined, isolation: 'sandbox' })
    handlers['session/new'] = () => ({ sessionId: 'probe', configOptions: acpConfig() })
    handlers['session/set_config_option'] = ({ value }) => ({ configOptions: acpConfig(value, value === PRO ? 'max' : '', value === FLASH) })
    const models = await runtime.agentOptions('deepseek', {})
    expect(models).toEqual([
      { id: FLASH, label: 'Flash', description: '快速模型', isDefault: true, defaultEffort: null, efforts: [
        { id: 'low', label: '低' }, { id: 'high', label: '高', description: '仔细推理' },
      ], serviceTiers: [] },
      { id: PRO, label: 'Pro', isDefault: false, defaultEffort: 'max', efforts: [
        { id: 'low', label: '低' }, { id: 'high', label: '高', description: '仔细推理' }, { id: 'max', label: '最高' },
      ], serviceTiers: [] },
      { id: PLAIN, label: 'Plain', isDefault: false, defaultEffort: null, efforts: [], serviceTiers: [] },
    ])
    const server = servers[0]!
    expect(server.args.slice(0, 3)).toEqual(['-p', 'test-policy', '/fake/dsh'])
    expect(server.requests('session/new')[0]!.params).toEqual({ cwd: server.options.cwd, mcpServers: [] })
    expect(server.requests('session/set_config_option').map(request => request.params)).toEqual([FLASH, PRO, PLAIN].map(value => ({ sessionId: 'probe', configId: 'model', value })))
    expect(server.received.map(request => request.method)).toEqual(['initialize', 'session/new', ...Array(3).fill('session/set_config_option'), 'session/close'])
    expect(server.requests('session/close')[0]!.params).toEqual({ sessionId: 'probe' })
    expect(server.exited).toBe(true)
    expect(existsSync(server.options.cwd)).toBe(false)
    expect(existsSync(server.args.at(-1)!)).toBe(false)
    expect(tokenSeq).toBe(0)
    expect(db.select().from(s.agentInstances).all()).toEqual([])
  })

  it.each(['initialize', 'session/new', 'session/set_config_option'])('Stop the process without sending prompt when probing %s fails', async phase => {
    handlers['session/new'] = () => ({ sessionId: 'probe', configOptions: acpConfig() })
    handlers[phase] = () => ({ error: { code: -32603, message: 'Configuration unavailable' } })
    await expect(runtime.agentOptions('deepseek', {})).rejects.toThrow('Configuration unavailable')
    const server = servers[0]!
    expect(server.exited).toBe(true)
    expect(server.requests('session/prompt')).toEqual([])
    expect(existsSync(server.options.cwd)).toBe(false)
    if (phase === 'session/set_config_option') expect(server.requests('session/close')).toHaveLength(1)
  })

  it('Force-stop probe processes that ignore normal closure and SIGTERM, then clean up the working directory', async () => {
    handlers['session/new'] = () => {
      servers[0]!.ignoreStdinEnd = true
      servers[0]!.ignoreTerm = true
      return { sessionId: 'probe', configOptions: acpConfig() }
    }
    handlers['session/set_config_option'] = ({ value }) => ({ configOptions: acpConfig(value) })
    await runtime.agentOptions('deepseek', {})
    expect(servers[0]!.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(servers[0]!.exited).toBe(true)
    expect(existsSync(servers[0]!.options.cwd)).toBe(false)
  })

  it('Preserve the original cause and clean up when probe startup errors have no pid or exit event', async () => {
    handlers['initialize'] = () => {
      const server = servers[0]!
      Object.defineProperty(server, 'pid', { value: undefined })
      server.ignoreStdinEnd = true
      server.ignoreTerm = true
      setImmediate(() => server.emit('error', new Error('spawn ENOENT')))
      return 'hang'
    }
    await expect(runtime.agentOptions('deepseek', {})).rejects.toThrow('spawn ENOENT')
    expect(existsSync(servers[0]!.options.cwd)).toBe(false)
    expect(existsSync(servers[0]!.args.at(-1)!)).toBe(false)
    expect(servers[0]!.signals).not.toContain('SIGKILL')
  })

  it('Probe timeouts and missing model catalogs both fail and clean up', async () => {
    handlers['initialize'] = () => 'hang'
    await expect(runtime.agentOptions('deepseek', {})).rejects.toThrow('Timed out reading the DeepSeek Harness model list')
    expect(servers[0]!.exited).toBe(true)
    handlers['initialize'] = () => ({ protocolVersion: 1 })
    await expect(runtime.agentOptions('deepseek', {})).rejects.toThrow('returned no available models')
    expect(servers[1]!.exited).toBe(true)
    expect(servers[1]!.requests('session/close')).toHaveLength(1)
  })

  it('Missing dsh during probing preserves an actionable error without starting a process', async () => {
    vi.mocked(resolver.resolveDsh).mockReturnValue(undefined)
    await expect(runtime.agentOptions('deepseek', {})).rejects.toThrow('dsh was not found')
    expect(servers).toHaveLength(0)
  })

  it('Probes cannot treat missing update results as unsupported reasoning effort', async () => {
    handlers['session/new'] = () => ({ sessionId: 'probe', configOptions: acpConfig() })
    await expect(runtime.agentOptions('deepseek', {})).rejects.toThrow('did not return the updated model configuration')
    expect(servers[0]!.exited).toBe(true)
  })

  it('Set model before effort before prompt; do not repeat identical settings after resume', async () => {
    agentConfig = { model: PRO, effort: 'max', serviceTier: null }
    handlers['session/new'] = () => ({ sessionId: 'dss_1', configOptions: acpConfig() })
    handlers['session/resume'] = () => ({ configOptions: acpConfig(PRO, 'max') })
    handlers['session/set_config_option'] = ({ configId, value }) => ({ configOptions: acpConfig(PRO, configId === 'model' ? 'high' : value) })
    const sid = newSession()
    const first = send(sid, 'A')
    await sessions.idle()
    expect(servers[0]!.received.map(request => request.method)).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt'])
    expect(servers[0]!.requests('session/set_config_option').map(request => request.params)).toEqual([
      { sessionId: 'dss_1', configId: 'model', value: PRO },
      { sessionId: 'dss_1', configId: 'reasoning_effort', value: 'max' },
    ])
    servers[0]!.settlePrompt({ stopReason: 'end_turn' })
    await until(() => turnOf(first.messageId).status === 'completed')
    send(sid, 'B')
    await sessions.idle()
    expect(servers[1]!.received.map(request => request.method)).toEqual(['initialize', 'session/resume', 'session/prompt'])
  })

  it.each([true, false])('null resets resumed values to the overlay model and default effort (Provider default: %s)', async providerDefault => {
    agentConfig = { model: PRO, effort: 'max', serviceTier: null }
    handlers['session/new'] = () => ({ sessionId: 'dss_1', configOptions: acpConfig() })
    handlers['session/resume'] = () => ({ configOptions: acpConfig(PRO, 'max') })
    handlers['session/set_config_option'] = ({ configId, value }) => ({ configOptions: acpConfig(configId === 'model' ? value : FLASH, configId === 'model' ? 'low' : value, providerDefault) })
    const sid = newSession()
    const first = send(sid, 'A')
    await sessions.idle()
    servers[0]!.settlePrompt({ stopReason: 'end_turn' })
    await until(() => turnOf(first.messageId).status === 'completed')
    agentConfig = { model: null, effort: null, serviceTier: null }
    send(sid, 'B')
    await sessions.idle()
    expect(servers[1]!.requests('session/set_config_option').map(request => request.params)).toEqual([
      { sessionId: 'dss_1', configId: 'model', value: FLASH },
      { sessionId: 'dss_1', configId: 'reasoning_effort', value: providerDefault ? '' : 'high' },
    ])
  })

  it('After runtime restart, discover default opaque values from a temporary ACP session, then align the resumed session', async () => {
    handlers['session/resume'] = () => ({ configOptions: acpConfig(PRO, 'max') })
    handlers['session/new'] = () => ({ sessionId: 'default-probe', configOptions: acpConfig() })
    handlers['session/set_config_option'] = () => ({ configOptions: acpConfig() })
    const sid = newSession()
    db.update(s.sessions).set({ agentResumeId: 'dss_1' }).where(eq(s.sessions.id, sid)).run()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    expect(server.received.map(request => request.method)).toEqual(['initialize', 'session/resume', 'session/new', 'session/close', 'session/set_config_option', 'session/prompt'])
    expect(server.requests('session/new')[0]!.params.mcpServers).toEqual([])
    expect(server.requests('session/close')[0]!.params.sessionId).toBe('default-probe')
    expect(server.requests('session/set_config_option')[0]!.params).toEqual({ sessionId: 'dss_1', configId: 'model', value: FLASH })
  })

  it.each(['model', 'reasoning_effort'])('%s setting failure fails the turn and writes a notice without sending prompt', async configId => {
    agentConfig = { model: PRO, effort: 'max', serviceTier: null }
    handlers['session/new'] = () => ({ sessionId: 'dss_1', configOptions: acpConfig() })
    handlers['session/set_config_option'] = params => params.configId === configId
      ? { error: { code: -32602, message: 'Setting failed' } }
      : { configOptions: acpConfig(PRO) }
    const sid = newSession()
    const sent = send(sid, 'A')
    await sessions.idle()
    expect(message(sent.messageId).deliveryState).toBe('rejected')
    expect(turnOf(sent.messageId).status).toBe('failed')
    expect(notices(sid)).toEqual(['dispatch_rejected'])
    expect(JSON.stringify(sessions.getTranscript({ sessionId: sid }).items)).toContain('Setting failed')
    expect(servers[0]!.requests('session/prompt')).toHaveLength(0)
    expect(servers[0]!.requests('session/close')).toHaveLength(1)
    expect(servers[0]!.exited).toBe(true)
  })

  it.each(['model', 'reasoning_effort'])('Missing %s update results reject sending prompt with old configuration', async configId => {
    agentConfig = { model: configId === 'model' ? PRO : FLASH, effort: 'max', serviceTier: null }
    handlers['session/new'] = () => ({ sessionId: 'dss_1', configOptions: acpConfig() })
    const sid = newSession()
    const sent = send(sid, 'A')
    await sessions.idle()
    expect(message(sent.messageId).deliveryState).toBe('rejected')
    expect(notices(sid)).toEqual(['dispatch_rejected'])
    expect(servers[0]!.requests('session/prompt')).toHaveLength(0)
  })

  it.each([null, 'high'])('Models without reasoning support allow only default effort: %s', async effort => {
    agentConfig = { model: PLAIN, effort, serviceTier: null }
    handlers['session/new'] = () => ({ sessionId: 'dss_1', configOptions: acpConfig(PLAIN) })
    const sid = newSession()
    const sent = send(sid, 'A')
    await sessions.idle()
    expect(servers[0]!.requests('session/set_config_option')).toEqual([])
    expect(servers[0]!.requests('session/prompt')).toHaveLength(effort === null ? 1 : 0)
    expect(message(sent.messageId).deliveryState).toBe(effort === null ? 'delivered' : 'rejected')
  })
})

describe('A single turn', () => {
  it('Windows: allow writes without an isolation sandbox and retain tool approvals', async () => {
    vi.mocked(sandbox.prepareSandbox).mockImplementation(options => realPrepareSandbox({ ...options, platform: 'win32' }))
    const sid = newSession()
    send(sid, 'test')
    await sessions.idle()
    const yml = readFileSync(`${join(dir, 'agents', 'dsh-overlay.yml')}.${sid}.yml`, 'utf8')
    expect(servers[0]!.options.env.PATH).toBe([join(dir, 'cli bin'), '/usr/bin'].join(delimiter))
    expect(yml).toContain('mode: danger-full-access')
    expect(yml).toContain('policy: ask')
    expect(yml).toContain('write: true')
    expect(yml).not.toMatch(/- id: tool-pwsh\n {2}disabled: true/)
    expect(yml).toContain('Windows has no isolation sandbox')
    expect(yml).not.toContain('The outer sandbox blocks')
  })
  it('Rewrite the overlay and read the latest child work-item facts when resuming a session', async () => {
    const sid = newSession()
    const first = send(sid, '找个 DeepSeek 来验收')
    await sessions.idle()
    const overlayPath = `${join(dir, 'agents', 'dsh-overlay.yml')}.${sid}.yml`
    expect(readFileSync(overlayPath, 'utf8')).toContain('This workspace has no child work items.')
    const parentId = db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()!.workItemId!
    db.insert(s.workItems).values({ id: 'work_child', parentId, title: '子工作项', workDir: '', createdBy: { kind: 'user' }, statusChangedAt: clock, createdAt: clock }).run()
    servers[0]!.settlePrompt({ stopReason: 'end_turn' })
    await until(() => turnOf(first.messageId).status === 'completed')
    send(sid, '处理子工作项报告')
    await sessions.idle()
    expect(servers[1]!.requests('session/resume')[0]!.params.sessionId).toBe('dss_1')
    const overlay = readFileSync(overlayPath, 'utf8')
    expect(overlay).toContain('Child reports automatically wake you through durable work messages')
    expect(overlay).not.toContain('This workspace has no child work items.')
    expect(servers[1]!.requests('session/prompt')[0]!.params.prompt[0].text).toContain('Has children: yes')
  })

  it.each([null, 'work_parent'])('Native instructions and turns carry the current parent work item: %s', async parentId => {
    workContext = { workItemId: 'work_1', parentId, hasChildren: false }
    const sid = newSession()
    send(sid, '处理工作消息')
    await sessions.idle()

    const instructions = readFileSync(`${join(dir, 'agents', 'dsh-overlay.yml')}.${sid}.yml`, 'utf8')
    const prompt = servers[0]!.requests('session/prompt')[0]!.params.prompt[0].text
    expect(instructions).toContain(parentId === null ? 'This is a root workspace' : 'This workspace has a parent')
    expect(prompt).toContain(`Work item: work_1\nParent work item: ${parentId ?? 'none (root workspace)'}\nHas children: no`)
  })

  it('Native sessions and approvals share the session\'s persisted working directory', async () => {
    const approve = vi.fn(async (_request: ApprovalRequest) => 'allow_once' as const)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    const cwd = join(dir, 'custom-workspace')
    mkdirSync(cwd)
    db.update(s.sessions).set({ workDir: cwd }).where(eq(s.sessions.id, sid)).run()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    expect(server.options.cwd).toBe(cwd)
    expect(server.requests('session/new')[0]!.params.cwd).toBe(cwd)
    const id = server.request('session/request_permission', { sessionId: 'dss_1', toolCall: { toolCallId: 'x', title: '读取素材', kind: 'read' }, options: [{ optionId: 'once', kind: 'allow_once' }] })
    await until(() => server.answers.has(id))
    expect(approve.mock.lastCall?.[0].cwd).toBe(cwd)
  })

  it('Missing dsh yields an actionable notice without downloading or starting a process', async () => {
    vi.mocked(resolver.resolveDsh).mockReturnValue(undefined)
    const sid = newSession()
    const sent = send(sid, 'A')
    await sessions.idle()
    expect(message(sent.messageId).deliveryState).toBe('rejected')
    expect(servers).toHaveLength(0)
    expect(JSON.stringify(sessions.getTranscript({ sessionId: sid }).items)).toContain('dsh was not found; run npx @deepseek-ai/dsh once, or set VIS_DSH_PATH')
  })

  it.each(['allow_once', 'deny'] as const)('Outer isolation enables tools; reconstruct ACP command approvals by toolCallId: %s', async decision => {
    vi.spyOn(sandbox, 'prepareSandbox').mockReturnValue({ env: { HOME: dir }, policy: 'test-policy', notice: undefined, isolation: 'sandbox' })
    const approve = vi.fn(async (_request: ApprovalRequest) => decision)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    expect(server.args.slice(0, 3)).toEqual(['-p', 'test-policy', '/fake/dsh'])
    const overlay = readFileSync(`${join(dir, 'agents', 'dsh-overlay.yml')}.${sid}.yml`, 'utf8')
    expect(overlay).toContain('mode: danger-full-access')
    expect(overlay).toContain('policy: ask')
    expect(overlay).toContain('write: true')
    expect(overlay).not.toContain('- id: tool-bash')
    expect(overlay).not.toContain('You cannot run shell commands')
    server.update({ sessionUpdate: 'tool_call', toolCallId: 'bash-1', kind: 'other', title: 'bash', rawInput: { command: 'echo test' } })
    const id = server.request('session/request_permission', { sessionId: 'dss_1', toolCall: { toolCallId: 'bash-1' }, options: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] })
    await until(() => server.answers.has(id))
    expect(server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: decision === 'deny' ? 'no' : 'once' } })
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ kind: 'command', summary: 'bash', detail: expect.stringContaining('echo test') }))
  })

  it('Native write arguments prove targets; ACP locations only supplement checks; unknown tools do not fall back to cwd', async () => {
    vi.spyOn(sandbox, 'prepareSandbox').mockReturnValue({ env: { HOME: dir }, policy: 'test-policy', notice: undefined, isolation: 'sandbox' })
    const approve = vi.fn(async (_request: ApprovalRequest) => 'deny' as const)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const options = [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }]
    const cases = [
      { tool: { title: 'write', kind: 'other', rawInput: { file_path: '/tmp/work/new.txt', content: '' } }, paths: ['/tmp/work/new.txt'] },
      { tool: { title: 'edit', kind: 'other', rawInput: { file_path: '/tmp/work/a.txt' }, locations: [{ path: '/tmp/outside/b.txt' }] }, paths: ['/tmp/work/a.txt', '/tmp/outside/b.txt'] },
      { tool: { title: '移动文件', kind: 'move', locations: [{ path: '/tmp/work/old.txt' }, { path: '/tmp/outside/new.txt' }] }, paths: undefined },
      { tool: { title: '移动文件', kind: 'move', rawInput: { source: '/tmp/work/old.txt', destination: '/tmp/outside/new.txt' }, locations: [{ path: '/tmp/work/old.txt' }] }, paths: undefined },
      { tool: { title: '删除文件', kind: 'delete', locations: [{ path: '/tmp/work/a.txt' }] }, paths: undefined },
      { tool: { title: 'write', kind: 'move', rawInput: { file_path: '/tmp/work/old.txt', destination: '/tmp/outside/new.txt' } }, paths: undefined },
      { tool: { title: 'write', kind: 'other' }, paths: undefined },
      { tool: { title: 'write', kind: 'other', locations: [{ path: '/tmp/work/a.txt' }] }, paths: undefined },
      { tool: { title: 'write', kind: 'other', rawInput: { file_path: 42 } }, paths: undefined },
      { tool: { title: 'write', kind: 'other', rawInput: { file_path: ' ' } }, paths: undefined },
      { tool: { title: 'write', kind: 'other', rawInput: { file_path: '/tmp/work/a.txt' }, locations: [{ path: '/tmp/work/a.txt' }, {}] }, paths: undefined },
      { tool: { title: '未知修改工具', kind: 'edit', rawInput: { file_path: '/tmp/work/source.txt', target: '/tmp/outside/destination.txt' } }, paths: undefined },
    ]
    for (const [index, entry] of cases.entries()) {
      const toolCallId = `file-${index}`
      server.update({ sessionUpdate: 'tool_call', toolCallId, ...entry.tool })
      const id = server.request('session/request_permission', { sessionId: 'dss_1', toolCall: { toolCallId }, options })
      await until(() => server.answers.has(id))
      expect(approve.mock.lastCall?.[0]).toMatchObject({ kind: 'file_write', cwd: join(dir, 'sessions', sid) })
      expect(approve.mock.lastCall?.[0].paths).toEqual(entry.paths)
    }
  })

  it('Command directory overrides come from workdir; unknown directories and extra permissions are not auto-approved by session directory', async () => {
    vi.spyOn(sandbox, 'prepareSandbox').mockReturnValue({ env: { HOME: dir }, policy: 'test-policy', notice: undefined, isolation: 'sandbox' })
    const approve = vi.fn(async (_request: ApprovalRequest) => 'deny' as const)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const options = [{ optionId: 'no', kind: 'reject_once' }]
    const cases = [
      { input: { command: 'pwd' }, cwd: join(dir, 'sessions', sid), blocked: undefined },
      { input: { command: 'pwd', workdir: '/tmp/outside' }, cwd: '/tmp/outside', blocked: undefined },
      { input: { command: 'pwd', workdir: 'nested/../output' }, cwd: `${join(dir, 'sessions', sid)}/nested/../output`, blocked: undefined },
      { input: { command: 'pwd', workdir: 42 }, cwd: undefined, blocked: undefined },
      { input: { command: 'pwd', sandbox_permissions: 'danger-full-access' }, cwd: join(dir, 'sessions', sid), blocked: true },
    ]
    for (const [index, entry] of cases.entries()) {
      const id = server.request('session/request_permission', { sessionId: 'dss_1', toolCall: { toolCallId: `cmd-${index}`, title: 'bash', kind: 'other', rawInput: entry.input }, options })
      await until(() => server.answers.has(id))
      expect(approve.mock.lastCall?.[0].cwd).toBe(entry.cwd)
      expect(approve.mock.lastCall?.[0].autoApprovalBlocked).toBe(entry.blocked)
    }
  })

  it('Startup arguments: overlay read-only configuration and system prompts, inject token and socket through MCP', async () => {
    const sid = newSession()
    send(sid, '写一段旁白')
    await sessions.idle()
    const server = servers[0]!
    const overlay = `${join(dir, 'agents', 'dsh-overlay.yml')}.${sid}.yml`
    expect(server.args).toEqual(['--profile', 'acp', '--patch', overlay])
    expect(server.options.cwd).toBe(join(dir, 'sessions', sid))
    const yml = readFileSync(overlay, 'utf8')
    expect(yml).toContain('mode: read-only')
    expect(yml).toContain('policy: never')
    expect(yml).toMatch(/- id: tool-bash\n {2}disabled: true/)
    expect(yml).toMatch(/- id: session-log-deepseek\n {2}config:\n {4}enabled: false/)
    expect(yml).toContain('personaSuffix:')
    expect(yml).toContain('canvas_get')
    expect(existsSync(join(dir, 'sessions', sid, 'AGENTS.md'))).toBe(false)

    expect(server.received.map(m => m.method)).toEqual(['initialize', 'session/new', 'session/prompt'])
    expect(server.requests('initialize')[0]!.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    expect(server.requests('session/new')[0]!.params).toEqual({
      cwd: join(dir, 'sessions', sid),
      mcpServers: [{ name: 'vis', command: '/usr/bin/node', args: ['/opt/vis/vis.mjs', 'mcp'], env: [{ name: 'VIS_SOCKET', value: '/tmp/vis.sock' }, { name: 'VIS_AGENT_TOKEN', value: 'spc_1.tok1' }] }],
    })
    const workItemId = db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()!.workItemId
    expect(server.requests('session/prompt')[0]!.params).toEqual({ sessionId: 'dss_1', prompt: [{ type: 'text', text: `写一段旁白\n\n<session>\nTitle: "分镜"\nUser-named; do not change.\n</session>\n\n<work-item>\nWork item: ${workItemId}\nParent work item: none (root workspace)\nHas children: no\n</work-item>` }] })
    // Pass the user's configured key unchanged to dsh; give the token only to vis
    expect(server.options.env.DEEPSEEK_API_KEY).toBe('sk-from-user-env')
    expect(server.options.env.VIS_AGENT_TOKEN).toBeUndefined()
  })

  it('Discover natively from the project skill directory while preserving AGENTS.md in the existing working directory', async () => {
    const sid = newSession()
    const cwd = join(dir, 'sessions', sid)
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'AGENTS.md'), '用户的说明\n')
    projectContext = { rootPath: dir, assetsPath: join(dir, 'assets'), skillsPath: join(dir, 'skills'), workDir: cwd, skills: [] }
    send(sid, '制作分镜')
    await sessions.idle()
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe('用户的说明\n')
    const overlayPath = servers[0]!.args[3]!
    expect(overlayPath).toBe(`${join(dir, 'agents', 'dsh-overlay.yml')}.${sid}.yml`)
    const overlay = readFileSync(overlayPath, 'utf8')
    expect(overlay).toContain('includeDefaultRoots: false')
    expect(overlay).toContain(`customSkillDirs: [${JSON.stringify(join(dir, 'skills'))}]`)
    expect(overlay).toContain(JSON.stringify(sandbox.CORE_INSTRUCTIONS).slice(1, -1))
  })

  it('Persist thinking and plan revisions; duplicate and late revisions do not change entry order or content', async () => {
    const sid = newSession()
    const sent = send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    server.update({ sessionUpdate: 'agent_thought_chunk', messageId: 'r', content: { type: 'text', text: '先读' } })
    server.update({ sessionUpdate: 'plan', entries: [{ content: '读', status: 'in_progress' }] })
    await until(() => sessions.getTranscript({ sessionId: sid }).items.some(i => i.kind === 'plan'))
    const first = sessions.getTranscript({ sessionId: sid }).items.filter(i => i.kind !== 'user')
    server.update({ sessionUpdate: 'agent_thought_chunk', messageId: 'r', content: { type: 'text', text: '再写' } })
    server.update({ sessionUpdate: 'plan', entries: [{ content: '写', status: 'completed' }] })
    await until(() => sessions.getTranscript({ sessionId: sid }).items.some(i => i.kind === 'plan' && i.revision === 2))
    const updated = sessions.getTranscript({ sessionId: sid }).items.filter(i => i.kind !== 'user')
    expect(updated.map(i => i.createdSeq)).toEqual(first.map(i => i.createdSeq))
    expect(updated).toMatchObject([
      { itemId: 'ds:dss_1:r:thought', revision: 2, kind: 'reasoning', payload: { text: '先读再写' } },
      { itemId: `ds:dss_1:${turnOf(sent.messageId).id}:plan`, revision: 2, kind: 'plan', payload: { entries: [{ text: '写', status: 'completed' }] } },
    ])
    for (const entry of [...updated, ...first]) {
      sessions.handleAgentEvent({ type: 'item', sessionId: sid, turnId: entry.turnId, itemId: entry.itemId, revision: entry.revision, kind: entry.kind as 'reasoning' | 'plan', payload: entry.payload })
    }
    expect(sessions.getTranscript({ sessionId: sid }).items.filter(i => i.kind !== 'user')).toEqual(updated)
  })

  it('Receiving an update means acceptance; updates become transcript entries; close the session and exit on completion, then resume next turn', async () => {
    const sid = newSession()
    const a = send(sid, 'A')
    await until(() => servers.length === 1 && servers[0]!.requests('session/prompt').length === 1)
    const server = servers[0]!
    server.update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '我先读' } })
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('delivered')
    expect(instances(sid)).toEqual([expect.objectContaining({ status: 'ready', tokenHash: 'hash1', pid: 4343 })])

    server.update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '一下画布' } })
    server.update({ sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text: '思考' } })
    server.update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'mcp__vis__canvas_get', kind: 'other', status: 'in_progress', rawInput: { snapshot: 'turn' } })
    server.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '{"nodes":[]}' } }] })
    server.update({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: '画布是空的' } })
    server.settlePrompt({ stopReason: 'end_turn' })
    await until(() => turnOf(a.messageId).status === 'completed')

    const items = sessions.getTranscript({ sessionId: sid }).items.filter(i => i.kind !== 'user')
    expect(items.map(i => [i.itemId, i.kind])).toEqual([
      ['ds:dss_1:m1', 'assistant_text'], ['ds:dss_1:m1:thought', 'reasoning'], ['ds:dss_1:c1:call', 'tool_call'], ['ds:dss_1:c1:result', 'tool_result'], ['ds:dss_1:m2', 'assistant_text'],
    ])
    expect(items[0]!.payload).toEqual({ text: '我先读一下画布' })
    expect(items[1]!.payload).toEqual({ text: '思考' })
    expect(items[2]!.payload).toEqual({ toolUseId: 'c1', name: 'mcp__vis__canvas_get', input: { snapshot: 'turn' } })
    expect(items[3]!.payload).toEqual({ toolUseId: 'c1', isError: false, text: '{"nodes":[]}' })
    expect(server.requests('session/close')[0]!.params).toEqual({ sessionId: 'dss_1' })
    expect(server.exited).toBe(true)
    expect(db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()).toMatchObject({ agentResumeId: 'dss_1' })
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'completed' })

    send(sid, 'B')
    await sessions.idle()
    expect(servers[1]!.received.map(m => m.method)).toEqual(['initialize', 'session/resume', 'session/prompt'])
    expect(servers[1]!.requests('session/resume')[0]!.params).toMatchObject({ sessionId: 'dss_1', cwd: join(dir, 'sessions', sid), mcpServers: [expect.objectContaining({ name: 'vis' })] })
  })

  it('Without updates, expiration of the acceptance window still counts as acceptance', async () => {
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('delivered')
    servers[0]!.settlePrompt({ stopReason: 'max_tokens' })
    await until(() => turnOf(a.messageId).status === 'failed')
  })

  it('Auto-deny approvals; all client file and terminal requests are unsupported', async () => {
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const ids = {
      permission: server.request('session/request_permission', {
        sessionId: 'dss_1',
        toolCall: { toolCallId: 'x' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }],
      }),
      noReject: server.request('session/request_permission', { sessionId: 'dss_1', toolCall: { toolCallId: 'y' }, options: [{ optionId: 'allow-once', kind: 'allow_once' }] }),
      fs: server.request('fs/write_text_file', { sessionId: 'dss_1', path: '/etc/x', content: '' }),
    }
    await until(() => server.answers.size === 3)
    expect(server.answers.get(ids.permission)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })
    expect(server.answers.get(ids.noReject)).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(server.answers.get(ids.fs)).toMatchObject({ code: -32601 })
  })

  it.each([true, false])('Auto-approve vis tool confirmations while preserving approval boundaries for other tools and wrong sessions (workspace: %s)', async hasWorkItem => {
    const approve = vi.fn(async (_request: ApprovalRequest) => 'deny' as const)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    if (!hasWorkItem) db.update(s.sessions).set({ workItemId: null }).where(eq(s.sessions.id, sid)).run()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const options = [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }]
    server.update({ sessionUpdate: 'tool_call', toolCallId: 'vis-1', title: 'mcp__vis__canvas_apply', kind: 'other', status: 'in_progress' })
    await until(() => sessions.getTranscript({ sessionId: sid }).items.some(item => item.kind === 'tool_call'))
    const vis = server.request('session/request_permission', { sessionId: 'dss_1', toolCall: { toolCallId: 'vis-1' }, options })
    const other = server.request('session/request_permission', { sessionId: 'dss_1', toolCall: { toolCallId: 'other', title: 'mcp__other__canvas_apply', kind: 'other' }, options })
    const wrong = server.request('session/request_permission', { sessionId: 'wrong', toolCall: { toolCallId: 'vis-1', title: 'mcp__vis__canvas_apply', kind: 'other' }, options })
    const execute = server.request('session/request_permission', { sessionId: 'dss_1', toolCall: { toolCallId: 'exec', title: 'mcp__vis__canvas_apply', kind: 'execute' }, options })
    await until(() => [vis, other, wrong, execute].every(id => server.answers.has(id)))
    expect(server.answers.get(vis)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    for (const id of [other, wrong, execute]) expect(server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
    expect(approve).toHaveBeenCalledOnce()
    expect(approve.mock.lastCall?.[0].summary).toBe('mcp__other__canvas_apply')
  })

  it.each(['allow_once', 'allow_session', 'deny'] as const)('ACP approval selects the corresponding protocol option: %s', async decision => {
    const approve = vi.fn(async (_request: ApprovalRequest) => decision)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    const sent = send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const toolCall = { toolCallId: 'x', title: '读取外部素材', kind: 'fetch', rawInput: { url: 'https://example.com/asset.png' } }
    const options = [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }]
    const id = server.request('session/request_permission', { sessionId: 'dss_1', toolCall, options })
    await until(() => server.answers.has(id))
    expect(server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: decision === 'deny' ? 'no' : 'once' } })
    expect(approve).toHaveBeenCalledWith({ sessionId: sid, turnId: turnOf(sent.messageId).id, kind: 'network', summary: '读取外部素材', detail: JSON.stringify({ kind: 'fetch', title: toolCall.title, rawInput: toolCall.rawInput }, null, 2), cwd: join(dir, 'sessions', sid) })
  })

  it.each([
    { decision: 'allow_once', options: [{ optionId: 'always', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_always' }], expected: { outcome: 'selected', optionId: 'no' } },
    { decision: 'allow_session', options: [{ optionId: 'always', kind: 'allow_always' }], expected: { outcome: 'cancelled' } },
  ] as const)('Deny when ACP provides no matching allow option: $decision', async ({ decision, options, expected }) => {
    runtimeContext.requestApproval = async () => decision
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const id = server.request('session/request_permission', { sessionId: 'dss_1', toolCall: { toolCallId: 'x', title: '读取素材', kind: 'read' }, options })
    await until(() => server.answers.has(id))
    expect(server.answers.get(id)).toEqual({ outcome: expected })
  })

  it('DSH approvals do not permit execution, file modification, or wrong-session requests', async () => {
    const approve = vi.fn(async () => 'allow_session' as const)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const options = [{ optionId: 'always', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }]
    const ids = ['execute', 'edit', 'delete', 'move'].map(kind => server.request('session/request_permission', { sessionId: 'dss_1', toolCall: { toolCallId: kind, kind }, options }))
    ids.push(server.request('session/request_permission', { sessionId: 'wrong-session', toolCall: { toolCallId: 'read', kind: 'read' }, options }))
    await until(() => server.answers.size === ids.length)
    for (const id of ids) expect(server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
    expect(approve).not.toHaveBeenCalled()
  })

  it('ACP approval waits for a decision; approval errors return denial', async () => {
    let resolve!: (decision: 'allow_once') => void
    const approve = vi.fn((_request: ApprovalRequest) => new Promise<'allow_once'>(r => { resolve = r }))
    runtimeContext.requestApproval = approve
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    const params = { sessionId: 'dss_1', toolCall: { toolCallId: 'x', title: '读取素材', kind: 'read' }, options: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] }
    const id = server.request('session/request_permission', params)
    await until(() => approve.mock.calls.length === 1)
    expect(server.answers.has(id)).toBe(false)
    expect(approve.mock.lastCall?.[0].detail).toContain('"toolCallId": "x"')
    resolve('allow_once')
    await until(() => server.answers.has(id))
    expect(server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    runtimeContext.requestApproval = async () => { throw new Error('Approval channel is closed') }
    const failed = server.request('session/request_permission', params)
    await until(() => server.answers.has(failed))
    expect(server.answers.get(failed)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
  })
})

describe('Failure and interruption', () => {
  it.each(['initialize', 'session/prompt'])('Closing the runtime during startup stops the process in the %s phase and rejects subsequent turns', async phase => {
    handlers[phase] = () => 'hang'
    const sid = newSession()
    const sent = send(sid, 'A')
    await until(() => servers[0]?.requests(phase).length === 1)
    await runtime.dispose()
    expect(servers[0]!.exited).toBe(true)
    await sessions.idle()
    expect(message(sent.messageId).deliveryState).toBe(phase === 'initialize' ? 'rejected' : 'unknown')
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'start_failed' })
    const next = send(newSession(), 'B')
    await sessions.idle()
    expect(message(next.messageId).deliveryState).toBe('rejected')
    expect(servers).toHaveLength(1)
  })

  it('session/new failure: classify as rejected and exit the instance', async () => {
    handlers['session/new'] = () => ({ error: { code: -32602, message: 'mcp server vis failed to start' } })
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('rejected')
    expect(notices(sid)).toEqual(['dispatch_rejected'])
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'start_failed' })
    expect(servers[0]!.exited).toBe(true)
  })

  it.each(['bash', 'pwsh', 'write', 'edit'])('Read-only fallback rejects %s approvals with the actual ACP other type', async title => {
    const approve = vi.fn(async () => 'allow_once' as const)
    runtimeContext.requestApproval = approve
    const sid = newSession()
    send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    server.update({ sessionUpdate: 'tool_call', toolCallId: 'native-1', kind: 'other', title, rawInput: { command: 'test' } })
    const id = server.request('session/request_permission', { sessionId: 'dss_1', toolCall: { toolCallId: 'native-1' }, options: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] })
    await until(() => server.answers.has(id))
    expect(server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
    expect(approve).not.toHaveBeenCalled()
  })

  it('Handshake timeout: classify as rejected', async () => {
    handlers['initialize'] = () => 'hang'
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('rejected')
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'start_timeout' })
  })

  it('Prompt rejected immediately after sending: classify as rejected', async () => {
    handlers['session/prompt'] = () => ({ error: { code: -32603, message: 'turn failed: llm-deepseek: no API key for provider route' } })
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('rejected')
    expect(notices(sid)).toEqual(['dispatch_rejected'])
  })

  it('Process exit within the acceptance window: outcome unknown, no automatic resend', async () => {
    handlers['session/prompt'] = () => { setImmediate(() => servers[0]!.exit()); return 'hang' }
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('unknown')
    expect(notices(sid)).toEqual(['dispatch_unknown'])
  })

  it('Turn failure after acceptance: classify as failed and write the reason to the transcript', async () => {
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    servers[0]!.settlePrompt({ error: { code: -32603, message: 'turn failed: rate limited' } })
    await until(() => turnOf(a.messageId).status === 'failed')
    expect(notices(sid)).toEqual(['agent_error'])
  })

  it('User stop: send session/cancel and classify the turn as interrupted', async () => {
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    const server = servers[0]!
    await sessions.stop({ requestId: 'stop1', sessionId: sid, turnId: turnOf(a.messageId).id })
    await until(() => server.requests('session/cancel').length === 1)
    expect(server.requests('session/cancel')[0]!.params).toEqual({ sessionId: 'dss_1' })
    server.settlePrompt({ stopReason: 'cancelled' })
    await until(() => turnOf(a.messageId).status === 'interrupted')
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'interrupted' })
  })

  it('Unresponsive cancellation: stop the process after the grace period', async () => {
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
    expect(notices(sid)).toEqual([])
  })
})
