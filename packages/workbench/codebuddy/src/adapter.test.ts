import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openSpaceDb, type SpaceDb } from '@vis/storage'
import { agentInstructions, createSessionService, turnPrompt, type AgentEvent, type ApprovalRequest, type DispatchInput, type SessionService } from '@vis/workbench-core'
import { canAutoApprove } from '../../core/src/auto-approval'
import * as sandbox from '../../core/src/sandbox'
import * as resolver from './resolve'
import { createCodebuddyRuntime } from './adapter'

const fixture = readFileSync(new URL('./fixtures/acp-handshake.ndjson', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const response = (id: number) => structuredClone(fixture.find(row => row.dir === 'in' && row.msg.id === id)!.msg)
const nativeSession = response(2).result.sessionId as string
const recordedConfig = () => response(2).result.configOptions as any[]
const HANG = Symbol('pending response')
type Handler = (params: any, id: number) => any

/** Scripted CodeBuddy wire responses only; no executable is started. */
class ScriptedCodebuddy extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly received: { method: string; params: any; id?: number }[] = []
  readonly answers = new Map<number, any>()
  readonly signals: NodeJS.Signals[] = []
  exited = false
  ignoreStdinEnd = true
  ignoreTerm = false
  private nextId = 1000

  constructor(readonly command: string, readonly args: string[], readonly options: { cwd: string; env: Record<string, string | undefined> }, readonly handlers: Record<string, Handler>) {
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
        if (result !== HANG) this.send({ id: message.id, ...(result && typeof result === 'object' && 'error' in result ? result : { result }) })
      }
    })
    this.stdin.on('end', () => { if (!this.ignoreStdinEnd) this.exit() })
  }

  requests(method: string) { return this.received.filter(message => message.method === method) }
  send(message: object) { if (!this.exited) this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
  update(update: object) { this.send({ method: 'session/update', params: { sessionId: nativeSession, update } }) }
  settlePrompt() { this.send({ id: this.requests('session/prompt').at(-1)!.id, result: { stopReason: 'end_turn' } }) }
  request(method: string, params: object) {
    const id = ++this.nextId
    this.send({ id, method, params })
    return id
  }
  permission(toolCall: object, sessionId = nativeSession) {
    return this.request('session/request_permission', { sessionId, toolCall, options: [
      { optionId: 'always', kind: 'allow_always' }, { optionId: 'once', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' },
    ] })
  }
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

let dir: string
let db: SpaceDb
let sessions: SessionService
let runtime: ReturnType<typeof createCodebuddyRuntime>
let servers: ScriptedCodebuddy[]
let events: AgentEvent[]
let handlers: Record<string, Handler>
let sequence = 0
const approval = vi.fn(async (_request: ApprovalRequest) => 'allow_once' as const)
const realPrepare = sandbox.prepareSandbox

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-codebuddy-acp-'))
  db = openSpaceDb(':memory:')
  servers = []
  events = []
  handlers = {
    initialize: () => response(1).result,
    'session/new': () => response(2).result,
    'session/resume': () => response(3).result,
    'session/close': () => ({ error: response(4).error }),
    'session/prompt': () => HANG,
    // The no-prompt recording contains no set_config_option exchange; preserve its complete option shape.
    'session/set_config_option': ({ configId, value }) => ({ configOptions: recordedConfig().map(option => option.id === configId ? { ...option, currentValue: value } : option) }),
  }
  approval.mockClear()
  vi.spyOn(resolver, 'resolveCodebuddy').mockReturnValue('/fake/codebuddy')
  vi.spyOn(sandbox, 'prepareSandbox').mockImplementation(options => realPrepare({ ...options, platform: 'win32' }))
  runtime = createCodebuddyRuntime({ db, report: event => events.push(event), requestApproval: approval }, {
    spawn: (command, args, options) => {
      const server = new ScriptedCodebuddy(command, args, options, handlers)
      servers.push(server)
      return server
    },
    workDir: id => join(dir, 'sessions', id), probeDir: join(dir, 'probes'),
    issueToken: () => ({ token: 'test-runtime-token', tokenHash: `hash-${++sequence}` }),
    socketPath: '/fake/vis.sock', visMcp: { command: '/fake/vis', args: ['mcp'] },
    env: { HOME: dir, PATH: '/fake/bin' }, admissionMs: 10, interruptGraceMs: 25, startTimeoutMs: 200,
  })
  sessions = createSessionService({ db, runtime })
})

afterEach(async () => {
  await runtime.dispose()
  sessions.dispose()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function input(): DispatchInput {
  const sessionId = sessions.create({ requestId: `create-${++sequence}`, title: 'CodeBuddy test', agentKind: 'codebuddy' }).sessionId
  return { sessionId, sessionTitle: 'CodeBuddy test', titleSource: 'user', turnId: `turn-${++sequence}`, text: 'Inspect the canvas', inputSnapshotId: 'snapshot', refs: [], resumeId: null }
}

function withMode(mode: string | undefined) {
  return recordedConfig().flatMap(option => option.id !== 'mode' ? [option] : mode === undefined ? [] : [{ ...option, currentValue: mode }])
}

it('launches only ACP with default permissions under the prepared sandbox and isolates the MCP token', async () => {
  vi.spyOn(sandbox, 'prepareSandbox').mockReturnValue({ env: { HOME: dir }, policy: 'test-policy', notice: undefined, isolation: 'sandbox' })
  const turn = input()
  await runtime.dispatchTurn(turn)
  const server = servers[0]!
  expect(server.command).toBe('/usr/bin/sandbox-exec')
  expect(server.args).toEqual(['-p', 'test-policy', '/fake/codebuddy', '--acp', '--permission-mode', 'default'])
  expect(server.options.env).not.toHaveProperty('VIS_AGENT_TOKEN')
  expect(server.requests('initialize')[0]!.params).toEqual(fixture.find(row => row.dir === 'out' && row.msg.method === 'initialize')!.msg.params)
  expect(server.requests('session/new')[0]!.params).toEqual({ cwd: server.options.cwd, mcpServers: [{ name: 'vis', command: '/fake/vis', args: ['mcp'], env: [{ name: 'VIS_SOCKET', value: '/fake/vis.sock' }, { name: 'VIS_AGENT_TOKEN', value: 'test-runtime-token' }] }] })
  expect(server.requests('session/set_config_option')).toEqual([])
})

it('prepends current shared instructions on every prompt, including resume with updated work context', async () => {
  const turn = { ...input(), workContext: { workItemId: 'child', parentId: 'root', hasChildren: false } }
  await runtime.dispatchTurn(turn)
  servers[0]!.settlePrompt()
  await expect.poll(() => events.filter(event => event.type === 'turn_ended').length).toBe(1)
  const next = { ...turn, turnId: 'next-turn', resumeId: nativeSession, workContext: { workItemId: 'root', parentId: null, hasChildren: true } }
  await runtime.dispatchTurn(next)
  for (const [index, value] of [turn, next].entries()) {
    expect(servers[index]!.requests('session/prompt')[0]!.params.prompt).toEqual([
      { type: 'text', text: agentInstructions({ environment: { access: 'expanded', isolation: 'none' }, work: value.workContext }) },
      { type: 'text', text: turnPrompt(value) },
    ])
  }
  expect(servers[1]!.requests('session/resume')[0]!.params).toMatchObject({ sessionId: nativeSession, cwd: servers[1]!.options.cwd })
  expect(servers[1]!.requests('session/new')).toEqual([])
})

it.each(['session/new', 'session/resume'])('fails closed if %s omits permission configuration', async method => {
  handlers[method] = () => ({ sessionId: nativeSession, configOptions: withMode(undefined) })
  await expect(runtime.dispatchTurn({ ...input(), resumeId: method === 'session/resume' ? nativeSession : null })).rejects.toMatchObject({ kind: 'rejected', message: expect.stringContaining('did not provide permission configuration') })
  expect(servers[0]!.requests('session/prompt')).toEqual([])
})

it.each(['accepted', 'ignored', 'missing', 'rejected'])('requires the asking-mode update to be confirmed when it is %s', async outcome => {
  handlers['session/new'] = () => ({ sessionId: nativeSession, configOptions: withMode('auto') })
  handlers['session/set_config_option'] = ({ configId, value }) => {
    expect({ configId, value }).toEqual({ configId: 'mode', value: 'default' })
    return outcome === 'rejected' ? { error: { code: -32602, message: 'Mode update rejected' } } : { configOptions: withMode(outcome === 'accepted' ? 'default' : outcome === 'ignored' ? 'auto' : undefined) }
  }
  const result = runtime.dispatchTurn(input())
  if (outcome === 'accepted') await result
  else await expect(result).rejects.toMatchObject({ kind: 'rejected' })
  expect(servers[0]!.requests('session/set_config_option').map(request => request.params)).toEqual([{ sessionId: nativeSession, configId: 'mode', value: 'default' }])
  expect(servers[0]!.requests('session/prompt')).toHaveLength(outcome === 'accepted' ? 1 : 0)
})

it('rechecks permission mode after model and effort changes and never sets the native sandbox option', async () => {
  handlers['session/set_config_option'] = ({ configId, value }) => ({ configOptions: recordedConfig().map(option => option.id === configId ? { ...option, currentValue: value } : option.id === 'mode' ? { ...option, currentValue: 'auto' } : option) })
  await runtime.dispatchTurn({ ...input(), agentConfig: { model: 'opaque:model/with:punctuation', effort: 'max', serviceTier: null } })
  expect(servers[0]!.requests('session/set_config_option').map(request => ({ configId: request.params.configId, value: request.params.value }))).toEqual([
    { configId: 'model', value: 'opaque:model/with:punctuation' }, { configId: 'thought_level', value: 'max' }, { configId: 'mode', value: 'default' },
  ])
})

it.each(['enabled', 'disabled', 'minimal', 'max'])('keeps the Agent current effort %s when the author has not selected one', async currentValue => {
  handlers['session/new'] = () => ({ sessionId: nativeSession, configOptions: recordedConfig().map(option => option.id === 'thought_level' ? { ...option, currentValue } : option) })
  await runtime.dispatchTurn(input())
  expect(servers[0]!.requests('session/set_config_option')).toEqual([])
})

it('passes every recorded model and effort label and credit description through in Agent order', async () => {
  const options = recordedConfig()
  const choices = options.find(option => option.id === 'model').options
  const efforts = options.find(option => option.id === 'thought_level')
  const models = await runtime.agentOptions('codebuddy')
  expect(models).toEqual(choices.map((choice: any) => ({ id: choice.value, label: choice.name, ...(choice.description === undefined ? {} : { description: choice.description }), isDefault: choice.value === 'default-model', defaultEffort: efforts.currentValue, efforts: efforts.options.map((effort: any) => ({ id: effort.value, label: effort.name, description: effort.description })), serviceTiers: [] })))
  expect(models).toHaveLength(26)
  const server = servers[0]!
  expect(server.requests('session/set_config_option').map(request => request.params)).toEqual(choices.map((choice: any) => ({ sessionId: nativeSession, configId: 'model', value: choice.value })))
  expect(server.requests('session/prompt')).toEqual([])
  expect(server.stdin.writableEnded).toBe(true)
  expect(server.signals).toEqual(['SIGTERM'])
  expect(server.exited).toBe(true)
  expect(existsSync(server.options.cwd)).toBe(false)
})

it('treats model ids as opaque values in the probe', async () => {
  const ids = ['opaque:model/with:punctuation', 'no-prefix-or-provider']
  const configOptions = recordedConfig().map(option => option.id === 'model' ? { ...option, currentValue: ids[0], options: ids.map(value => ({ value, name: value })) } : option)
  handlers['session/new'] = () => ({ sessionId: nativeSession, configOptions })
  handlers['session/set_config_option'] = ({ value }) => ({ configOptions: configOptions.map(option => option.id === 'model' ? { ...option, currentValue: value } : option) })
  expect((await runtime.agentOptions('codebuddy')).map(model => model.id)).toEqual(ids)
  expect(servers[0]!.requests('session/set_config_option').map(request => request.params.value)).toEqual(ids)
})

it('kills an EOF-ignoring probe after unsupported close, including a process that ignores SIGTERM', async () => {
  handlers['session/new'] = () => {
    servers[0]!.ignoreTerm = true
    return { ...response(2).result, configOptions: recordedConfig().map(option => option.id === 'model' ? { ...option, options: [option.options[0]] } : option) }
  }
  await runtime.agentOptions('codebuddy')
  const server = servers[0]!
  expect(server.requests('session/close')).toHaveLength(1)
  expect(server.stdin.writableEnded).toBe(true)
  expect(server.signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(server.exited).toBe(true)
  expect(existsSync(server.options.cwd)).toBe(false)
})

it('falls back to a new session only after an explicit resume RPC error', async () => {
  handlers['session/resume'] = () => ({ error: { code: -32602, message: 'Session not found' } })
  await runtime.dispatchTurn({ ...input(), resumeId: 'missing-session' })
  expect(servers[0]!.requests('session/resume')[0]!.params.sessionId).toBe('missing-session')
  expect(servers[0]!.requests('session/new').map(request => request.params.mcpServers.length)).toEqual([0, 1])
  expect(events).toContainEqual(expect.objectContaining({ type: 'resume_id', resumeId: nativeSession }))
})

it('does not start a replacement session when the resume connection exits', async () => {
  handlers['session/resume'] = () => { setImmediate(() => servers[0]!.exit()); return HANG }
  await expect(runtime.dispatchTurn({ ...input(), resumeId: 'missing-session' })).rejects.toMatchObject({ kind: 'rejected' })
  expect(servers[0]!.requests('session/new').map(request => request.params.mcpServers.length)).toEqual([0])
})

it('maps native command, edit and fetch approvals, auto-approves web reads and refuses unclear tools', async () => {
  const turn = input()
  await runtime.dispatchTurn(turn)
  const server = servers[0]!
  const tools = [
    { title: '`pwd`', kind: 'read', rawInput: { command: 'pwd' }, _meta: { 'codebuddy.ai/toolName': 'Bash' } },
    ...['Write', 'Edit', 'MultiEdit'].map(name => ({ title: 'Edit `story.md`', kind: 'search', rawInput: { file_path: join(dir, 'story.md') }, _meta: { 'codebuddy.ai/toolName': name } })),
    { title: 'Fetch https://example.invalid', kind: 'read', rawInput: { url: 'https://example.invalid' }, _meta: { 'codebuddy.ai/toolName': 'WebFetch' } },
    { title: 'MysteryTool', kind: 'other', rawInput: { file_path: join(dir, 'story.md') }, locations: [{ path: join(dir, 'story.md') }] },
  ]
  for (const [index, tool] of tools.entries()) {
    const toolCallId = `tool-${index}`
    server.update({ sessionUpdate: 'tool_call', toolCallId, ...tool })
    const id = server.permission({ toolCallId, rawInput: tool.rawInput })
    await expect.poll(() => server.answers.has(id)).toBe(true)
    expect(server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  }
  expect(approval.mock.calls.map(([request]) => request.kind)).toEqual(['command', 'file_write', 'file_write', 'file_write', 'network', 'other'])
  for (const [index, [request]] of approval.mock.calls.entries()) {
    expect(request).toMatchObject({ sessionId: turn.sessionId, turnId: turn.turnId })
    if (index >= 1 && index <= 3) {
      expect(request.paths).toEqual([join(dir, 'story.md')])
      expect(canAutoApprove(request, { workDir: dir })).toBe(true)
    }
    else if (request.kind === 'network') {
      // Native WebFetch / WebSearch are read-only web reads, auto-approved like in-workspace commands (RFC 0048).
      expect(request).toMatchObject({ webRead: true })
      expect(request).not.toHaveProperty('paths')
      expect(canAutoApprove(request, { workDir: dir })).toBe(true)
    }
    else {
      expect(request).not.toHaveProperty('paths')
      expect(canAutoApprove(request, { workDir: dir })).toBe(false)
    }
    expect(request).not.toHaveProperty('cwd')
  }
  expect(events).toContainEqual(expect.objectContaining({ type: 'item', itemId: `cb:${nativeSession}:tool-0:call`, kind: 'tool_call' }))
})

it('auto-accepts vis MCP confirmations without asking the author', async () => {
  await runtime.dispatchTurn(input())
  const id = servers[0]!.permission({ toolCallId: 'vis', title: 'Create a canvas node', kind: 'other', rawInput: {}, _meta: { 'codebuddy.ai/toolName': 'mcp__vis__canvas_create' } })
  await expect.poll(() => servers[0]!.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  expect(approval).not.toHaveBeenCalled()
})


it('requires author approval for a spoofed vis display title from a different native tool', async () => {
  await runtime.dispatchTurn(input())
  const id = servers[0]!.permission({ title: 'mcp__vis__canvas_create', kind: 'other', rawInput: { file_path: join(dir, 'story.md') }, _meta: { 'codebuddy.ai/toolName': 'CustomWrite' } })
  await expect.poll(() => servers[0]!.answers.has(id)).toBe(true)
  expect(approval).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'other', summary: 'mcp__vis__canvas_create' }))
  expect(approval.mock.calls[0]![0]).not.toHaveProperty('paths')
  expect(canAutoApprove(approval.mock.calls[0]![0], { workDir: dir })).toBe(false)
})

it('denies unproven and mutating tools in read-only fallback while preserving native reads and vis tools', async () => {
  vi.spyOn(sandbox, 'prepareSandbox').mockImplementation(options => realPrepare({ ...options, platform: 'linux' }))
  await runtime.dispatchTurn(input())
  const server = servers[0]!
  for (const tool of [
    ...['Bash', 'Write', 'Edit', 'MultiEdit'].map(name => ({ title: 'Native operation', kind: 'read', rawInput: { file_path: '/work/story.md' }, _meta: { 'codebuddy.ai/toolName': name } })),
    { title: 'WebFetch', kind: 'fetch' }, { title: 'UnknownTool', kind: 'other' }, { title: 'Read', kind: 'other' },
  ]) {
    const id = server.permission(tool)
    await expect.poll(() => server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
  }
  expect(approval).not.toHaveBeenCalled()
  for (const name of ['Read', 'Glob', 'Grep', 'NotebookRead']) {
    const id = server.permission({ title: 'Native read operation', kind: 'other', _meta: { 'codebuddy.ai/toolName': name } })
    await expect.poll(() => server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  }
  expect(approval).toHaveBeenCalledTimes(4)
  const id = server.permission({ title: 'mcp__vis__canvas_create', kind: 'other', _meta: { 'codebuddy.ai/toolName': 'mcp__vis__canvas_create' } })
  await expect.poll(() => server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
  expect(server.requests('session/prompt')[0]!.params.prompt[0].text).toBe(agentInstructions({ environment: { access: 'readOnly', isolation: 'none' } }))
})

it('ignores vendor notifications and rejects vendor requests with method-not-found', async () => {
  await runtime.dispatchTurn(input())
  const server = servers[0]!
  for (const method of ['_codebuddy.ai/command', '_codebuddy.ai/modResidentInvalidate']) {
    server.send({ method, params: { sessionId: nativeSession } })
    const id = server.request(method, { sessionId: nativeSession })
    await expect.poll(() => server.answers.get(id)).toMatchObject({ code: -32601 })
  }
  expect(approval).not.toHaveBeenCalled()
})

it('interrupts with session/cancel and kills the process when the Agent does not cooperate', async () => {
  const turn = input()
  await runtime.dispatchTurn(turn)
  await runtime.interruptTurn(turn)
  expect(servers[0]!.requests('session/cancel').map(request => request.params)).toEqual([{ sessionId: nativeSession }])
  await expect.poll(() => events).toContainEqual({ type: 'turn_ended', sessionId: turn.sessionId, turnId: turn.turnId, status: 'interrupted' })
  expect(servers[0]!.signals).toContain('SIGKILL')
})

it('completes a turn despite unsupported session/close and a process that ignores EOF', async () => {
  const turn = input()
  await runtime.dispatchTurn(turn)
  servers[0]!.settlePrompt()
  await expect.poll(() => events).toContainEqual({ type: 'turn_ended', sessionId: turn.sessionId, turnId: turn.turnId, status: 'completed' })
  expect(servers[0]!.requests('session/close')[0]!.params).toEqual({ sessionId: nativeSession })
  expect(servers[0]!.signals).toEqual(['SIGKILL'])
  expect(servers[0]!.exited).toBe(true)
})

it.each(['rejection', 'exit'])('classifies prompt %s without resending the turn', async mode => {
  handlers['session/prompt'] = () => {
    if (mode === 'rejection') return { error: { code: -32602, message: 'Invalid prompt' } }
    setImmediate(() => servers[0]!.exit())
    return HANG
  }
  await expect(runtime.dispatchTurn(input())).rejects.toMatchObject({ kind: mode === 'rejection' ? 'rejected' : 'unknown' })
  expect(servers).toHaveLength(1)
  expect(servers[0]!.requests('session/prompt')).toHaveLength(1)
})

it('fails with an actionable error when the executable cannot be resolved', async () => {
  vi.spyOn(resolver, 'resolveCodebuddy').mockReturnValue(undefined)
  await expect(runtime.dispatchTurn(input())).rejects.toMatchObject({ kind: 'rejected', message: expect.stringContaining('VIS_CODEBUDDY_PATH') })
  expect(servers).toEqual([])
})
