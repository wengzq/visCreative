import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openSpaceDb, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createSessionService, type SessionService } from '../session-service'
import { agentInstructions, turnPrompt } from '../instructions'
import type { AgentEvent, DispatchInput } from '../runtime-port'
import * as sandbox from '../sandbox'
import type { AcpAgentProfile } from './profile'
import { createAcpRuntime, type AcpRuntimeOptions } from './runtime'

const HANG = Symbol('pending response')
type Handler = (params: any, id: number) => unknown

/** In-memory bidirectional ACP transport; spawning never reaches the operating system. */
class ScriptedAcp extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly received: { method: string; params: any; id?: number }[] = []
  readonly answers = new Map<number, any>()
  readonly signals: NodeJS.Signals[] = []
  exited = false
  ignoreStdinEnd = false
  private nextId = 1000

  constructor(readonly handlers: Record<string, Handler>) {
    super()
    let buffer = ''
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        if (!message.method) {
          this.answers.set(message.id, message.result ?? message.error)
          continue
        }
        this.received.push(message)
        if (message.id === undefined) continue
        const result = this.handlers[message.method]?.(message.params, message.id) ?? {}
        if (result === HANG) continue
        this.send({ id: message.id, ...(result && typeof result === 'object' && 'error' in result ? result : { result }) })
      }
    })
    this.stdin.on('end', () => { if (!this.ignoreStdinEnd) this.exit() })
  }

  requests(method: string) { return this.received.filter(request => request.method === method) }
  send(message: object) { if (!this.exited) this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
  update(update: object) { this.send({ method: 'session/update', params: { sessionId: 'native-session', update } }) }
  settlePrompt() { this.send({ id: this.requests('session/prompt').at(-1)!.id, result: { stopReason: 'end_turn' } }) }
  permission(toolCall: object, sessionId = 'native-session') {
    const id = ++this.nextId
    this.send({ id, method: 'session/request_permission', params: { sessionId, toolCall, options: [
      { optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' },
    ] } })
    return id
  }
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.signals.push(signal)
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

let dir: string
let db: SpaceDb
let sessions: SessionService
let runtime: ReturnType<typeof createAcpRuntime>
let profile: AcpAgentProfile
let servers: ScriptedAcp[]
let events: AgentEvent[]
let handlers: Record<string, Handler>
let options: AcpRuntimeOptions
let sequence = 0
const approval = vi.fn(async () => 'allow_once' as const)
const realPrepare = sandbox.prepareSandbox

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-acp-'))
  db = openSpaceDb(':memory:')
  servers = []
  events = []
  handlers = {
    initialize: () => ({ protocolVersion: 1 }),
    'session/new': () => ({ sessionId: 'native-session', configOptions: [] }),
    'session/resume': () => ({ configOptions: [] }),
    'session/load': () => ({ configOptions: [] }),
    'session/prompt': () => HANG,
  }
  approval.mockReset().mockResolvedValue('allow_once')
  vi.spyOn(sandbox, 'prepareSandbox').mockImplementation(options => realPrepare({ ...options, platform: 'linux' }))
  profile = {
    kind: 'test-acp', label: 'Test ACP', processLabel: 'fake-acp',
    sandbox: { envPassthrough: [], runtimeDirectory: '.fake-acp' },
    launch: () => ({ command: '/fake/acp', args: ['--acp'] }),
    instructions: 'prompt', config: {},
    classifyTool: (tool, cwd) => ({ kind: tool.kind ?? 'other', cwd }),
    itemPrefix: 'fixture', resume: 'session/resume',
    defaultEffort: option => option.currentValue,
  }
  options = {
    spawn: () => {
      const server = new ScriptedAcp(handlers)
      servers.push(server)
      return server
    },
    workDir: id => join(dir, 'sessions', id), probeDir: join(dir, 'probes'),
    issueToken: () => ({ token: 'fixture-token', tokenHash: `hash-${++sequence}` }),
    socketPath: '/fake/vis.sock', visMcp: { command: '/fake/vis', args: ['mcp'] },
    env: { HOME: dir, PATH: '/usr/bin' }, admissionMs: 10, interruptGraceMs: 30, startTimeoutMs: 200,
  }
  runtime = createAcpRuntime({ db, report: event => events.push(event), requestApproval: approval }, options, profile)
  sessions = createSessionService({ db, runtime })
})

afterEach(async () => {
  await runtime.dispose()
  sessions.dispose()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function input(): DispatchInput {
  const sessionId = sessions.create({ requestId: `create-${++sequence}`, title: 'ACP test', agentKind: 'test-acp' }).sessionId
  return { sessionId, sessionTitle: 'ACP test', titleSource: 'user', turnId: `turn-${++sequence}`, text: 'Inspect the canvas', inputSnapshotId: 'snapshot', refs: [], resumeId: null }
}

function permissionOptions(currentValue: string) {
  return [{ id: 'permissionMode', type: 'select', currentValue, options: [{ value: 'ask', name: 'Ask' }, { value: 'default', name: 'Default' }, { value: 'auto', name: 'Auto' }] }]
}

it('appends configured media after the user PATH in ACP Agent processes', async () => {
  options.cliBinDir = '/app/cli'
  options.fallbackDirs = ['/app/ffmpeg']
  let env: Record<string, string | undefined> | undefined
  const spawn = options.spawn!
  options.spawn = (command, args, settings) => { env = settings.env; return spawn(command, args, settings) }
  runtime = createAcpRuntime({ db, report: event => events.push(event) }, options, profile)
  await runtime.dispatchTurn(input())
  expect(env!.PATH).toBe(['/app/cli', '/usr/bin', '/app/ffmpeg'].join(delimiter))
})

it('accepts the first update and replays the pre-acceptance backlog in order with profile item IDs', async () => {
  handlers['session/prompt'] = () => {
    setImmediate(() => {
      servers[0]!.update({ sessionUpdate: 'agent_message_chunk', messageId: 'reply', content: { type: 'text', text: 'First' } })
      servers[0]!.update({ sessionUpdate: 'agent_message_chunk', messageId: 'reply', content: { type: 'text', text: ' second' } })
    })
    return HANG
  }
  const turn = input()
  await runtime.dispatchTurn(turn)
  expect(events.filter(event => event.type === 'item')).toEqual([
    { type: 'item', sessionId: turn.sessionId, turnId: turn.turnId, itemId: 'fixture:native-session:reply', revision: 1, kind: 'assistant_text', payload: { text: 'First' } },
    { type: 'item', sessionId: turn.sessionId, turnId: turn.turnId, itemId: 'fixture:native-session:reply', revision: 2, kind: 'assistant_text', payload: { text: 'First second' } },
  ])
  expect(events.some(event => event.type === 'turn_ended')).toBe(false)
})

it.each(['rejection', 'exit'] as const)('classifies early %s as rejected or unknown without resending', async mode => {
  handlers['session/prompt'] = () => {
    if (mode === 'rejection') return { error: { code: -32602, message: 'Invalid prompt' } }
    setImmediate(() => servers[0]!.exit())
    return HANG
  }
  await expect(runtime.dispatchTurn(input())).rejects.toMatchObject({ kind: mode === 'rejection' ? 'rejected' : 'unknown' })
  expect(servers).toHaveLength(1)
  expect(servers[0]!.requests('session/prompt')).toHaveLength(1)
})

it.each(['session/resume', 'session/load'] as const)('uses the configured %s method and falls back to new only on an RPC error', async method => {
  profile.resume = method
  handlers[method] = () => ({ error: { code: -32602, message: 'Missing session' } })
  await runtime.dispatchTurn({ ...input(), resumeId: 'missing-session' })
  expect(servers[0]!.requests(method)[0]!.params.sessionId).toBe('missing-session')
  expect(servers[0]!.requests(method === 'session/resume' ? 'session/load' : 'session/resume')).toEqual([])
  expect(servers[0]!.requests('session/new')).toHaveLength(1)
  expect(events).toContainEqual(expect.objectContaining({ type: 'resume_id', resumeId: 'native-session' }))
})

it('does not create a new session when the resume connection exits', async () => {
  handlers['session/resume'] = () => {
    setImmediate(() => servers[0]!.exit())
    return HANG
  }
  await expect(runtime.dispatchTurn({ ...input(), resumeId: 'old-session' })).rejects.toMatchObject({ kind: 'rejected' })
  expect(servers[0]!.requests('session/new')).toEqual([])
})

const modelOptions = (currentValue: string) => [{ id: 'model', type: 'select', currentValue, options: [] }]

it.each(['session/load', 'session/resume'] as const)('probes defaults before %s and completes even when another session lifecycle after resume would drop all prompt output', async method => {
  profile.resume = method
  profile.config.model = 'model'
  handlers['session/new'] = () => ({ sessionId: 'default-probe', configOptions: modelOptions('opaque:default') })
  handlers[method] = () => ({ configOptions: modelOptions('opaque:selected') })
  handlers['session/set_config_option'] = ({ value }) => ({ configOptions: modelOptions(value) })
  handlers['session/prompt'] = () => {
    const server = servers.at(-1)!
    const resumed = server.received.findIndex(request => request.method === method)
    // Reproduce Agents whose active session switches away from the resumed session and loses its prompt stream.
    if (server.received.slice(resumed + 1, -1).some(request => ['session/new', 'session/close'].includes(request.method))) return HANG
    setImmediate(() => {
      server.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Resumed reply' } })
      server.settlePrompt()
    })
    return HANG
  }
  const turn = { ...input(), resumeId: 'native-session' }
  await runtime.dispatchTurn(turn)
  await expect.poll(() => events.filter(event => event.type === 'turn_ended')).toEqual([
    { type: 'turn_ended', sessionId: turn.sessionId, turnId: turn.turnId, status: 'completed' },
  ])
  expect(events).toContainEqual(expect.objectContaining({ type: 'item', kind: 'assistant_text', payload: { text: 'Resumed reply' } }))
  expect(servers[0]!.received.map(request => request.method)).toEqual([
    'initialize', 'session/new', 'session/close', method, 'session/set_config_option', 'session/prompt', 'session/close',
  ])
  expect(servers[0]!.requests('session/new')[0]!.params.mcpServers).toEqual([])
  expect(servers[0]!.requests('session/close')[0]!.params.sessionId).toBe('default-probe')
  await runtime.dispatchTurn({ ...turn, turnId: 'next-turn' })
  await expect.poll(() => events.filter(event => event.type === 'turn_ended').length).toBe(2)
  expect(servers[1]!.received.map(request => request.method)).toEqual([
    'initialize', method, 'session/set_config_option', 'session/prompt', 'session/close',
  ])
  for (const server of servers) {
    expect(server.requests('session/set_config_option').map(request => request.params)).toEqual([
      { sessionId: 'native-session', configId: 'model', value: 'opaque:default' },
    ])
  }
})

it('uses the fresh session default after a failed resume without probing again', async () => {
  profile.config.model = 'model'
  handlers['session/new'] = ({ mcpServers }) => ({ sessionId: mcpServers.length ? 'native-session' : 'default-probe', configOptions: modelOptions(mcpServers.length ? 'opaque:fresh' : 'opaque:probe') })
  handlers['session/resume'] = () => ({ error: { code: -32602, message: 'Missing session' } })
  await runtime.dispatchTurn({ ...input(), resumeId: 'missing-session' })
  expect(servers[0]!.received.map(request => request.method)).toEqual([
    'initialize', 'session/new', 'session/close', 'session/resume', 'session/new', 'session/prompt',
  ])
  expect(servers[0]!.requests('session/set_config_option')).toEqual([])
})

it.each(['session/load', 'session/resume'] as const)('resumes with %s when a model-capable profile exposes no model option or default', async method => {
  profile.resume = method
  profile.config.model = 'model'
  await runtime.dispatchTurn({ ...input(), resumeId: 'native-session' })
  expect(servers[0]!.received.map(request => request.method)).toEqual([
    'initialize', 'session/new', 'session/close', method, 'session/prompt',
  ])
  expect(servers[0]!.requests('session/set_config_option')).toEqual([])
  servers[0]!.settlePrompt()
  await expect.poll(() => events.filter(event => event.type === 'turn_ended')).toEqual([expect.objectContaining({ status: 'completed' })])
})

it('rejects before prompting only when the resumed session needs a default the probe did not return', async () => {
  profile.config.model = 'model'
  handlers['session/resume'] = () => ({ configOptions: modelOptions('opaque:selected') })
  await expect(runtime.dispatchTurn({ ...input(), resumeId: 'native-session' })).rejects.toMatchObject({ kind: 'rejected', message: expect.stringContaining('did not return a default model') })
  expect(servers[0]!.requests('session/resume')).toHaveLength(1)
  expect(servers[0]!.requests('session/prompt')).toEqual([])
  expect(servers[0]!.requests('session/set_config_option')).toEqual([])
})

it.each([false, true])('skips the default probe with an explicit model when resumed is %s', async resumed => {
  profile.config.model = 'model'
  handlers['session/new'] = () => ({ sessionId: 'native-session', configOptions: modelOptions('opaque:default') })
  handlers['session/resume'] = () => ({ configOptions: modelOptions('opaque:default') })
  await runtime.dispatchTurn({ ...input(), resumeId: resumed ? 'native-session' : null, agentConfig: { model: 'opaque:default', effort: null, serviceTier: null } })
  expect(servers[0]!.requests('session/new')).toHaveLength(resumed ? 0 : 1)
  expect(servers[0]!.requests('session/close')).toEqual([])
})

it.each(['ask', 'default'])('confirms the permission option is %s before every prompt, including resumed turns', async ask => {
  profile.config.permission = { id: 'permissionMode', ask }
  handlers['session/new'] = () => ({ sessionId: 'native-session', configOptions: permissionOptions('auto') })
  handlers['session/resume'] = () => ({ configOptions: permissionOptions('auto') })
  handlers['session/set_config_option'] = () => ({ configOptions: permissionOptions(ask) })
  const turn = input()
  await runtime.dispatchTurn(turn)
  servers[0]!.settlePrompt()
  await expect.poll(() => events.filter(event => event.type === 'turn_ended').length).toBe(1)
  await runtime.dispatchTurn({ ...turn, turnId: 'next-turn', resumeId: 'native-session' })
  for (const server of servers) {
    expect(server.requests('session/set_config_option').map(request => request.params)).toEqual([{ sessionId: 'native-session', configId: 'permissionMode', value: ask }])
    expect(server.requests('session/prompt')).toHaveLength(1)
    const methods = server.received.map(request => request.method)
    expect(methods.indexOf('session/set_config_option')).toBeLessThan(methods.indexOf('session/prompt'))
  }
})

it('rejects startup without prompting when the asking permission setting fails', async () => {
  profile.config.permission = { id: 'permissionMode', ask: 'ask' }
  handlers['session/new'] = () => ({ sessionId: 'native-session', configOptions: permissionOptions('auto') })
  handlers['session/set_config_option'] = () => ({ error: { code: -32602, message: 'Asking mode unavailable' } })
  await expect(runtime.dispatchTurn(input())).rejects.toMatchObject({ kind: 'rejected' })
  expect(servers[0]!.requests('session/set_config_option')).toHaveLength(1)
  expect(servers[0]!.requests('session/prompt')).toEqual([])
})

it.each(['session/new', 'session/resume', 'session/load'] as const)('rejects startup without prompting when %s omits the permission option', async method => {
  profile.config.permission = { id: 'permissionMode', ask: 'ask' }
  if (method !== 'session/new') profile.resume = method
  const turn = { ...input(), resumeId: method === 'session/new' ? null : 'native-session' }
  await expect(runtime.dispatchTurn(turn)).rejects.toMatchObject({ kind: 'rejected', message: expect.stringContaining('did not provide permission configuration') })
  expect(servers[0]!.requests('session/set_config_option')).toEqual([])
  expect(servers[0]!.requests('session/prompt')).toEqual([])
  expect(db.select().from(s.agentInstances).all()).toEqual([expect.objectContaining({ sessionId: turn.sessionId, status: 'exited', exitReason: 'start_failed' })])
})

it.each(['auto', undefined])('rejects startup without prompting when the permission response reports %s', async currentValue => {
  profile.config.permission = { id: 'permissionMode', ask: 'ask' }
  handlers['session/new'] = () => ({ sessionId: 'native-session', configOptions: permissionOptions('auto') })
  handlers['session/set_config_option'] = () => ({ configOptions: currentValue === undefined ? [] : permissionOptions(currentValue) })
  const turn = input()
  await expect(runtime.dispatchTurn(turn)).rejects.toMatchObject({ kind: 'rejected', message: expect.stringContaining('did not confirm the asking permission mode') })
  expect(servers[0]!.requests('session/set_config_option').map(request => request.params)).toEqual([{ sessionId: 'native-session', configId: 'permissionMode', value: 'ask' }])
  expect(servers[0]!.requests('session/prompt')).toEqual([])
  expect(db.select().from(s.agentInstances).all()).toEqual([expect.objectContaining({ sessionId: turn.sessionId, status: 'exited', exitReason: 'start_failed' })])
})

it.each(['session/new', 'session/resume', 'session/load'] as const)('skips setting an already-asking permission option from %s', async method => {
  profile.config.permission = { id: 'permissionMode', ask: 'ask' }
  if (method !== 'session/new') profile.resume = method
  handlers[method] = () => ({ sessionId: 'native-session', configOptions: permissionOptions('ask') })
  await runtime.dispatchTurn({ ...input(), resumeId: method === 'session/new' ? null : 'native-session' })
  expect(servers[0]!.requests('session/set_config_option')).toEqual([])
  expect(servers[0]!.requests('session/prompt')).toHaveLength(1)
})

it('prepends shared instructions on every prompt and refreshes work context after resume', async () => {
  const turn = { ...input(), workContext: { workItemId: 'child', parentId: 'parent', hasChildren: false } }
  await runtime.dispatchTurn(turn)
  servers[0]!.settlePrompt()
  await expect.poll(() => events.filter(event => event.type === 'turn_ended').length).toBe(1)
  const next = { ...turn, turnId: 'next-turn', resumeId: 'native-session', workContext: { ...turn.workContext, hasChildren: true } }
  await runtime.dispatchTurn(next)
  for (const [i, dispatch] of [turn, next].entries()) {
    expect(servers[i]!.requests('session/prompt')[0]!.params.prompt).toEqual([
      { type: 'text', text: agentInstructions({ environment: { access: 'readOnly', isolation: 'none' }, work: dispatch.workContext }) },
      { type: 'text', text: turnPrompt(dispatch) },
    ])
  }
  expect(servers[0]!.requests('session/close')).toHaveLength(1)
  expect(servers[0]!.signals).toEqual(['SIGKILL'])
})

it('leaves launch-channel instructions out of the prompt', async () => {
  profile.instructions = 'launch'
  const turn = input()
  await runtime.dispatchTurn(turn)
  expect(servers[0]!.requests('session/prompt')[0]!.params.prompt).toEqual([{ type: 'text', text: turnPrompt(turn) }])
})

it.each(['execute', 'edit', 'delete', 'move'])('denies mutating %s permissions in prompt-channel read-only fallback before requesting approval', async kind => {
  await runtime.dispatchTurn(input())
  const server = servers[0]!
  for (const title of ['native-tool', 'mcp__vis__work_dispatch']) {
    const id = server.permission({ kind, title })
    await expect.poll(() => server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
  }
  expect(approval).not.toHaveBeenCalled()
})

it.each(['other', 'fetch'])('denies unproven %s permissions in read-only fallback before requesting approval', async kind => {
  await runtime.dispatchTurn(input())
  const server = servers[0]!
  const id = server.permission({ kind, title: 'native-tool' })
  await expect.poll(() => server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
  expect(approval).not.toHaveBeenCalled()
})

it('still asks for approval for proven read permissions in read-only fallback', async () => {
  await runtime.dispatchTurn(input())
  const server = servers[0]!
  const id = server.permission({ kind: 'read', title: 'native-tool' })
  await expect.poll(() => server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
  expect(approval).toHaveBeenCalledWith(expect.objectContaining({ kind: 'other' }))
})

it('preserves other-tool approval when the Agent enforces read-only itself', async () => {
  profile.readOnlyEnforcedByAgent = true
  await runtime.dispatchTurn(input())
  const server = servers[0]!
  const id = server.permission({ kind: 'other', title: 'native-tool' })
  await expect.poll(() => server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
  expect(approval).toHaveBeenCalledWith(expect.objectContaining({ kind: 'other' }))
})

it('auto-accepts vis MCP confirmations and denies wrong-session requests without calling approval', async () => {
  profile.classifyTool = () => ({ kind: 'other', visTool: true })
  await runtime.dispatchTurn(input())
  const server = servers[0]!
  const allowed = server.permission({ kind: 'other', title: 'mcp__vis__canvas_read' })
  const denied = server.permission({ kind: 'other', title: 'mcp__vis__canvas_read' }, 'different-session')
  await expect.poll(() => server.answers.get(allowed)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
  await expect.poll(() => server.answers.get(denied)).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
  expect(approval).not.toHaveBeenCalled()
})

it('asks for approval for other tools in expanded mode even when their title looks like vis', async () => {
  vi.mocked(sandbox.prepareSandbox).mockImplementation(options => realPrepare({ ...options, platform: 'win32' }))
  await runtime.dispatchTurn(input())
  const server = servers[0]!
  const id = server.permission({ kind: 'other', title: 'mcp__vis__canvas_read' })
  await expect.poll(() => server.answers.has(id)).toBe(true)
  expect(approval).toHaveBeenCalledWith(expect.objectContaining({ kind: 'other' }))
})

it('marks native fetch tools as web reads so auto mode can pass them, and nothing else (RFC 0048)', async () => {
  vi.mocked(sandbox.prepareSandbox).mockImplementation(options => realPrepare({ ...options, platform: 'win32' }))
  await runtime.dispatchTurn(input())
  const server = servers[0]!
  const fetch = server.permission({ kind: 'fetch', title: 'web_fetch' })
  await expect.poll(() => server.answers.has(fetch)).toBe(true)
  expect(approval).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'network', webRead: true }))
  const other = server.permission({ kind: 'other', title: 'native-tool' })
  await expect.poll(() => server.answers.has(other)).toBe(true)
  expect(approval).toHaveBeenLastCalledWith(expect.not.objectContaining({ webRead: true }))
})

it.each(['execute', 'edit', 'delete', 'move'] as const)('routes profile-identified vis tools with mutating %s kind through approval', async kind => {
  vi.mocked(sandbox.prepareSandbox).mockImplementation(options => realPrepare({ ...options, platform: 'win32' }))
  profile.classifyTool = () => ({ kind, cwd: dir, visTool: true })
  await runtime.dispatchTurn(input())
  const server = servers[0]!
  const id = server.permission({ kind, title: 'mcp__vis__canvas_read' })
  await expect.poll(() => server.answers.has(id)).toBe(true)
  expect(approval).toHaveBeenCalledWith(expect.objectContaining({ kind: kind === 'execute' ? 'command' : 'file_write' }))
})

it('sends cancel first and kills an unresponsive turn only after the grace period', async () => {
  const turn = input()
  await runtime.dispatchTurn(turn)
  const server = servers[0]!
  server.ignoreStdinEnd = true
  await runtime.interruptTurn(turn)
  expect(server.requests('session/cancel').map(request => request.params)).toEqual([{ sessionId: 'native-session' }])
  expect(server.signals).toEqual([])
  await expect.poll(() => server.signals).toEqual(['SIGKILL'])
  expect(events).toContainEqual({ type: 'turn_ended', sessionId: turn.sessionId, turnId: turn.turnId, status: 'interrupted' })
})

async function admitWithTimers(turn = input()) {
  const dispatched = runtime.dispatchTurn(turn)
  await vi.advanceTimersByTimeAsync(10)
  await dispatched
  return turn
}

it('fails an admitted silent turn after ten minutes and hard-stops its process without another session request', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const turn = await admitWithTimers()
  await vi.advanceTimersByTimeAsync(599_999)
  expect(events.some(event => event.type === 'turn_ended')).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(events).toContainEqual(expect.objectContaining({ type: 'item', kind: 'notice', payload: { code: 'agent_inactive', message: expect.stringContaining('process was stopped') } }))
  expect(events.filter(event => event.type === 'turn_ended')).toEqual([
    { type: 'turn_ended', sessionId: turn.sessionId, turnId: turn.turnId, status: 'failed' },
  ])
  expect(servers[0]!.signals).toEqual(['SIGKILL'])
  expect(servers[0]!.requests('session/close')).toEqual([])
  expect(db.select().from(s.agentInstances).all()).toEqual([expect.objectContaining({ status: 'exited', exitReason: 'failed' })])
  await admitWithTimers({ ...turn, turnId: 'next-turn' })
})

it('pauses inactivity for overlapping pending permissions and restarts the full interval after the last decision', async () => {
  options.inactivityTimeoutMs = 100
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const decisions: (() => void)[] = []
  approval.mockImplementation(() => new Promise(resolve => decisions.push(() => resolve('allow_once'))))
  await admitWithTimers()
  const server = servers[0]!
  server.permission({ kind: 'read', title: 'Read first file' })
  server.permission({ kind: 'read', title: 'Read second file' })
  await vi.advanceTimersByTimeAsync(500)
  expect(approval).toHaveBeenCalledTimes(2)
  expect(server.signals).toEqual([])
  decisions[0]!()
  await vi.advanceTimersByTimeAsync(500)
  expect(server.signals).toEqual([])
  decisions[1]!()
  await vi.advanceTimersByTimeAsync(99)
  expect(server.signals).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect(server.signals).toEqual(['SIGKILL'])
})

it.each(['update', 'request'] as const)('resets inactivity on each Agent %s', async activity => {
  options.inactivityTimeoutMs = 100
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await admitWithTimers()
  const server = servers[0]!
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(90)
    if (activity === 'update') server.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Working' } })
    else server.send({ id: 1000 + i, method: 'unsupported/request', params: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(server.signals).toEqual([])
  }
  await vi.advanceTimersByTimeAsync(99)
  expect(server.signals).toEqual([])
  server.settlePrompt()
  await vi.advanceTimersByTimeAsync(500)
  expect(events.filter(event => event.type === 'turn_ended')).toEqual([expect.objectContaining({ status: 'completed' })])
  expect(events.some(event => event.type === 'item' && event.kind === 'notice')).toBe(false)
})

it('preserves interruption during the grace period when the inactivity deadline was about to expire', async () => {
  options.inactivityTimeoutMs = 100
  options.interruptGraceMs = 150
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const turn = await admitWithTimers()
  await vi.advanceTimersByTimeAsync(90)
  await runtime.interruptTurn(turn)
  servers[0]!.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Stopping' } })
  await vi.advanceTimersByTimeAsync(100)
  expect(servers[0]!.signals).toEqual([])
  expect(events.some(event => event.type === 'turn_ended')).toBe(false)
  await vi.advanceTimersByTimeAsync(50)
  expect(servers[0]!.signals).toEqual(['SIGKILL'])
  await vi.advanceTimersByTimeAsync(500)
  expect(events.filter(event => event.type === 'turn_ended')).toEqual([
    { type: 'turn_ended', sessionId: turn.sessionId, turnId: turn.turnId, status: 'interrupted' },
  ])
  expect(events.some(event => event.type === 'item' && event.kind === 'notice')).toBe(false)
})

it('probes configured model and effort IDs without prompts, then removes launch files and the probe directory', async () => {
  profile.config = { model: 'modelChoice', effort: 'thinkingEffort' }
  const config = (model = 'fast', effort = 'low') => [
    { id: 'modelChoice', type: 'select', currentValue: model, options: [{ value: 'fast', name: 'Fast' }, { value: 'careful', name: 'Careful' }] },
    { id: 'thinkingEffort', type: 'select', currentValue: effort, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ]
  let probeCwd = ''
  let launchFile = ''
  profile.sessionFiles = prepared => {
    probeCwd = prepared.cwd
    launchFile = join(dir, `${prepared.sessionId}.config`)
    return [{ path: launchFile, content: 'scripted configuration' }]
  }
  handlers['session/new'] = () => ({ sessionId: 'probe', configOptions: config() })
  handlers['session/set_config_option'] = ({ configId, value }) => {
    expect(configId).toBe('modelChoice')
    return { configOptions: config(value, value === 'careful' ? 'high' : 'low') }
  }
  const models = await runtime.agentOptions('test-acp')
  expect(models.map(model => ({ id: model.id, isDefault: model.isDefault, defaultEffort: model.defaultEffort, efforts: model.efforts.map(effort => effort.id) }))).toEqual([
    { id: 'fast', isDefault: true, defaultEffort: 'low', efforts: ['low', 'high'] },
    { id: 'careful', isDefault: false, defaultEffort: 'high', efforts: ['low', 'high'] },
  ])
  expect(servers[0]!.requests('session/prompt')).toEqual([])
  expect(servers[0]!.requests('session/close')[0]!.params).toEqual({ sessionId: 'probe' })
  expect(existsSync(probeCwd)).toBe(false)
  expect(existsSync(launchFile)).toBe(false)
})

it('leaves out model choices the Agent refuses and fails only when it refuses all of them', async () => {
  profile.config = { model: 'modelChoice' }
  const config = (model = 'fast') => [{ id: 'modelChoice', type: 'select', currentValue: model, options: [{ value: 'fast', name: 'Fast' }, { value: 'broken', name: 'Broken' }] }]
  handlers['session/new'] = () => ({ sessionId: 'probe', configOptions: config() })
  handlers['session/set_config_option'] = ({ value }) => value === 'broken' ? { error: { code: -32603, message: 'Internal error' } } : { configOptions: config(value) }
  await expect(runtime.agentOptions('test-acp')).resolves.toMatchObject([{ id: 'fast', isDefault: true }])
  handlers['session/set_config_option'] = () => ({ error: { code: -32603, message: 'Internal error' } })
  await expect(runtime.agentOptions('test-acp')).rejects.toThrow('refused every advertised model')
})

it('returns no model options without launching when the profile has no model configuration', async () => {
  await expect(runtime.agentOptions('test-acp')).resolves.toEqual([])
  expect(servers).toEqual([])
})

it.each([-32601, -32603])('stops a probe that ignores stdin EOF when optional session/close returns %s', async code => {
  profile.config.model = 'model'
  const configOptions = [{ id: 'model', type: 'select', currentValue: 'model', options: [{ value: 'model', name: 'Model' }] }]
  handlers['session/new'] = () => {
    servers[0]!.ignoreStdinEnd = true
    return { sessionId: 'probe', configOptions }
  }
  handlers['session/set_config_option'] = () => ({ configOptions })
  handlers['session/close'] = () => ({ error: { code, message: 'Session close unavailable' } })
  await expect(runtime.agentOptions('test-acp')).resolves.toHaveLength(1)
  expect(servers[0]!.requests('session/close')[0]!.params).toEqual({ sessionId: 'probe' })
  expect(servers[0]!.stdin.writableEnded).toBe(true)
  expect(servers[0]!.signals).toEqual(['SIGTERM'])
  expect(servers[0]!.exited).toBe(true)
  expect(servers[0]!.requests('session/prompt')).toEqual([])
})

it('uses the profile default-effort rule before prompting', async () => {
  profile.config.effort = 'thinkingEffort'
  profile.defaultEffort = () => 'balanced'
  const option = (currentValue: string) => [{ id: 'thinkingEffort', type: 'select', currentValue, options: [] }]
  handlers['session/new'] = () => ({ sessionId: 'native-session', configOptions: option('low') })
  handlers['session/set_config_option'] = () => ({ configOptions: option('balanced') })
  await runtime.dispatchTurn(input())
  expect(servers[0]!.requests('session/set_config_option')[0]!.params).toEqual({ sessionId: 'native-session', configId: 'thinkingEffort', value: 'balanced' })
})
