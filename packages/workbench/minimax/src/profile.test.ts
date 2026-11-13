import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openSpaceDb, type SpaceDb } from '@vis/storage'
import { agentInstructions, createSessionService, turnPrompt, type AgentEvent, type DispatchInput, type RequestApproval, type SessionService } from '@vis/workbench-core'
import * as sandbox from '../../core/src/sandbox'
import { canAutoApprove } from '../../core/src/auto-approval'
import { classifyMinimaxTool, createMinimaxRuntime, minimaxProfile } from './profile'
import { HANG, NATIVE_SESSION, recorded, recordedHandlers, ScriptedMcode, type Handler } from './fixtures/scripted'

let dir: string
let db: SpaceDb
let sessions: SessionService
let runtime: ReturnType<typeof createMinimaxRuntime>
let servers: ScriptedMcode[]
let events: AgentEvent[]
let handlers: Record<string, Handler>
let mcodePath: string
let sequence = 0
const approval = vi.fn<RequestApproval>(async () => 'allow_once')
const spawn = vi.fn()
const realPrepare = sandbox.prepareSandbox

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-minimax-'))
  mcodePath = join(dir, 'fake-mcode')
  writeFileSync(mcodePath, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  db = openSpaceDb(':memory:')
  servers = []
  events = []
  handlers = recordedHandlers()
  approval.mockClear()
  spawn.mockReset().mockImplementation(() => {
    const server = new ScriptedMcode(handlers)
    servers.push(server)
    return server
  })
  // A fake Windows environment exercises expanded approvals without invoking Seatbelt or a real Agent.
  vi.spyOn(sandbox, 'prepareSandbox').mockImplementation(options => realPrepare({ ...options, platform: 'win32' }))
  runtime = createMinimaxRuntime({ db, report: event => events.push(event), requestApproval: approval }, {
    spawn, mcodePath, workDir: id => join(dir, 'sessions', id), probeDir: join(dir, 'probes'),
    issueToken: () => ({ token: 'test-token', tokenHash: `hash-${++sequence}` }),
    socketPath: '/fake/vis.sock', visMcp: { command: '/fake/vis', args: ['mcp'] },
    env: { HOME: dir, PATH: '', MCODE_PROVIDER_API_KEY: 'fake-provider-key', ARK_API_KEY: 'filtered', NODE_OPTIONS: '--require=fake' },
    admissionMs: 10, interruptGraceMs: 30, startTimeoutMs: 500,
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
  const sessionId = sessions.create({ requestId: `create-${++sequence}`, title: 'MiniMax test', agentKind: 'minimax-code' }).sessionId
  return { sessionId, sessionTitle: 'MiniMax test', titleSource: 'user', turnId: `turn-${++sequence}`, text: 'Inspect the canvas', inputSnapshotId: 'snapshot', refs: [], resumeId: null }
}

function configResponse(permission: string | undefined) {
  const result = recorded('session/new')
  result.configOptions = result.configOptions.filter((option: any) => option.id !== 'permissionMode' || permission !== undefined)
    .map((option: any) => option.id === 'permissionMode' ? { ...option, currentValue: permission } : option)
  return result
}

it('launches only mcode acp with filtered environment and the vis MCP server', async () => {
  const turn = input()
  await runtime.dispatchTurn(turn)
  expect(spawn).toHaveBeenCalledWith(mcodePath, ['acp'], expect.objectContaining({
    cwd: join(dir, 'sessions', turn.sessionId),
    env: { HOME: dir, PATH: '', MCODE_PROVIDER_API_KEY: 'fake-provider-key' },
  }))
  expect(servers[0]!.requests('initialize')[0]!.params).toEqual({
    protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'vis-creative', version: '0.0.0' },
  })
  expect(servers[0]!.requests('session/new')[0]!.params).toEqual({
    cwd: join(dir, 'sessions', turn.sessionId), mcpServers: [{ name: 'vis', command: '/fake/vis', args: ['mcp'], env: [
      { name: 'VIS_SOCKET', value: '/fake/vis.sock' }, { name: 'VIS_AGENT_TOKEN', value: 'test-token' },
    ] }],
  })
  expect(minimaxProfile().config).toEqual({ model: 'model', effort: 'thinkingEffort', permission: { id: 'permissionMode', ask: 'default' } })
})

it('replaces the recorded initial permission mode with confirmed Ask before prompting', async () => {
  await runtime.dispatchTurn(input())
  const server = servers[0]!
  expect(server.requests('session/set_config_option').map(message => message.params)).toEqual([
    { sessionId: NATIVE_SESSION, configId: 'permissionMode', value: 'default' },
  ])
  expect(server.received.map(message => message.method)).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/prompt'])
})

it.each(['missing', 'ignored', 'unconfirmed', 'rejected'])('fails closed when the asking permission option is %s', async scenario => {
  handlers['session/new'] = () => configResponse(scenario === 'missing' ? undefined : 'auto')
  handlers['session/set_config_option'] = () => scenario === 'rejected'
    ? { error: { code: -32602, message: 'Permission option unavailable' } }
    : { configOptions: configResponse(scenario === 'unconfirmed' ? undefined : 'auto').configOptions }
  await expect(runtime.dispatchTurn(input())).rejects.toMatchObject({ kind: 'rejected' })
  expect(servers[0]!.requests('session/prompt')).toEqual([])
  expect(servers[0]!.requests('session/set_config_option').every(message => message.params.value === 'default')).toBe(true)
})

it('skips the update when the permission mode already reports Ask', async () => {
  handlers['session/new'] = () => configResponse('default')
  await runtime.dispatchTurn(input())
  expect(servers[0]!.requests('session/set_config_option')).toEqual([])
})

it('prepends shared instructions to every prompt, including resume with fresh work context', async () => {
  const turn = { ...input(), workContext: { workItemId: 'child', parentId: 'parent', hasChildren: false } }
  await runtime.dispatchTurn(turn)
  servers[0]!.settlePrompt()
  await expect.poll(() => events.filter(event => event.type === 'turn_ended').length).toBe(1)
  const next = { ...turn, turnId: 'next-turn', resumeId: NATIVE_SESSION, workContext: { ...turn.workContext, hasChildren: true } }
  await runtime.dispatchTurn(next)
  for (const [i, dispatch] of [turn, next].entries()) {
    expect(servers[i]!.requests('session/prompt')[0]!.params.prompt).toEqual([
      { type: 'text', text: agentInstructions({ environment: { access: 'expanded', isolation: 'none' }, work: dispatch.workContext }) },
      { type: 'text', text: turnPrompt(dispatch) },
    ])
  }
  expect(servers[1]!.requests('session/resume')[0]!.params).toEqual({
    sessionId: NATIVE_SESSION, ...servers[0]!.requests('session/new')[0]!.params,
  })
  expect(servers[1]!.requests('session/new')).toEqual([])
  expect(servers[0]!.requests('session/close').map(message => message.params)).toEqual([{ sessionId: NATIVE_SESSION }])
})

it('falls back to a new session after a resume RPC error', async () => {
  handlers['session/resume'] = () => ({ error: { code: -32602, message: 'Session missing' } })
  await runtime.dispatchTurn({ ...input(), resumeId: 'missing-session' })
  expect(servers[0]!.requests('session/resume')[0]!.params.sessionId).toBe('missing-session')
  expect(servers[0]!.requests('session/new').map(request => request.params.mcpServers.length)).toEqual([0, 1])
  expect(events).toContainEqual(expect.objectContaining({ type: 'resume_id', resumeId: NATIVE_SESSION }))
})

it('returns recorded opaque model IDs and efforts without inferring them from ID syntax', async () => {
  const models = await runtime.agentOptions('minimax-code')
  const options = recorded('session/new').configOptions
  const choices = options.find((option: any) => option.id === 'model').options
  expect(models.map(model => ({ id: model.id, label: model.label }))).toEqual(choices.map((choice: any) => ({ id: choice.value, label: choice.name })))
  expect(models.every(model => model.defaultEffort === 'default' && model.efforts.map(effort => effort.id).join(',') === 'default,low,medium,high,xhigh,max')).toBe(true)
  expect(models.find(model => model.isDefault)?.id).toBe('m:minimax:MiniMax-M3.1-Flash:v:thinking')
  expect(servers[0]!.requests('session/set_config_option').map(message => message.params.value)).toEqual(choices.map((choice: any) => choice.value))
  expect(servers[0]!.requests('session/prompt')).toEqual([])
  expect(servers[0]!.exited).toBe(true)
})

it('passes opaque selected model and effort IDs unchanged and defaults effort to default when offered', async () => {
  const turn = input()
  await runtime.dispatchTurn({ ...turn, agentConfig: { model: 'opaque:model/with:tokens', effort: 'max', serviceTier: null } })
  expect(servers[0]!.requests('session/set_config_option').map(message => [message.params.configId, message.params.value])).toEqual([
    ['model', 'opaque:model/with:tokens'], ['thinkingEffort', 'max'], ['permissionMode', 'default'],
  ])
  const profile = minimaxProfile()
  expect(profile.defaultEffort({ id: 'thinkingEffort', currentValue: 'max', options: [{ value: 'default', name: 'Default' }] })).toBe('default')
  expect(profile.defaultEffort({ id: 'thinkingEffort', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] })).toBe('low')
})

it.each([
  { name: 'bash', kind: 'execute', title: 'Run build', rawInput: { command: 'pnpm build' }, approvalKind: 'command' },
  { name: 'write', kind: 'edit', title: 'Write draft', rawInput: { path: 'draft.txt', content: 'draft' }, approvalKind: 'file_write' },
  { name: 'edit', kind: 'edit', title: 'Change draft', rawInput: { file_path: '/outside/draft.txt', old_string: 'old', new_string: 'new' }, approvalKind: 'file_write' },
  { name: 'web_fetch', kind: 'fetch', title: 'Fetch page', rawInput: { url: 'https://example.invalid' }, approvalKind: 'network' },
])('maps native $name permissions to $approvalKind', async ({ approvalKind, ...tool }) => {
  const turn = input()
  await runtime.dispatchTurn(turn)
  const server = servers[0]!
  const id = server.permission({ toolCallId: 'native-tool', ...tool })
  await expect.poll(() => server.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  const expected = tool.name === 'bash' ? { cwd: join(dir, 'sessions', turn.sessionId) }
    : tool.name === 'write' ? { paths: [join(dir, 'sessions', turn.sessionId, 'draft.txt')] }
      : tool.name === 'edit' ? { paths: [resolve(join(dir, 'sessions', turn.sessionId), '/outside/draft.txt')] } : {}
  expect(approval).toHaveBeenCalledWith(expect.objectContaining({ sessionId: turn.sessionId, kind: approvalKind, ...expected }))
})

it('recovers native fields and updated input from tool-call updates for an ID-only permission', async () => {
  const turn = input()
  await runtime.dispatchTurn(turn)
  const server = servers[0]!
  server.update({ sessionUpdate: 'tool_call', toolCallId: 'edit-id', name: 'edit', title: 'Edit draft', kind: 'edit', rawInput: {} })
  server.update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit-id', status: 'pending', rawInput: { file_path: '/outside/draft.txt' } })
  const id = server.permission({ toolCallId: 'edit-id' })
  await expect.poll(() => server.answers.has(id)).toBe(true)
  expect(approval).toHaveBeenCalledWith(expect.objectContaining({ kind: 'file_write', paths: [resolve(join(dir, 'sessions', turn.sessionId), '/outside/draft.txt')] }))
  expect(events).toContainEqual(expect.objectContaining({ type: 'item', itemId: `mm:${NATIVE_SESSION}:edit-id:call` }))
})

it('keeps unknown tools as other without automatic approval even when native kind uses a substring match', async () => {
  await runtime.dispatchTurn(input())
  const server = servers[0]!
  const id = server.permission({ name: 'plugin_write_everything', title: 'write', kind: 'edit', rawInput: { path: dir }, locations: [{ path: dir }] })
  await expect.poll(() => server.answers.has(id)).toBe(true)
  expect(approval).toHaveBeenCalledWith(expect.objectContaining({ kind: 'other', autoApprovalBlocked: true }))
  expect(approval.mock.calls[0]![0]).not.toHaveProperty('paths')
})

it('auto-accepts native vis MCP confirmations even when their descriptive title differs', async () => {
  await runtime.dispatchTurn(input())
  const id = servers[0]!.permission({ name: 'mcp__vis__canvas_update', title: 'Update the canvas', kind: 'other' })
  await expect.poll(() => servers[0]!.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  expect(approval).not.toHaveBeenCalled()
})

it('does not auto-accept an unknown tool whose input description spoofs a vis title', async () => {
  await runtime.dispatchTurn(input())
  const id = servers[0]!.permission({ name: 'unknown_tool', title: 'mcp__vis__canvas_update', kind: 'other', rawInput: { description: 'mcp__vis__canvas_update' } })
  await expect.poll(() => servers[0]!.answers.has(id)).toBe(true)
  expect(approval).toHaveBeenCalledWith(expect.objectContaining({ kind: 'other', autoApprovalBlocked: true }))
})

it.each(['bash', 'write', 'edit'])('denies native %s in the read-only fallback before asking for approval', async name => {
  vi.mocked(sandbox.prepareSandbox).mockImplementation(options => realPrepare({ ...options, platform: 'linux' }))
  await runtime.dispatchTurn(input())
  const id = servers[0]!.permission({ name, kind: name === 'bash' ? 'execute' : 'edit', rawInput: { path: '/tmp/fake', file_path: '/tmp/fake' } })
  await expect.poll(() => servers[0]!.answers.get(id)).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
  expect(approval).not.toHaveBeenCalled()
})

it('only proves native single-file write targets and matches native lexical path resolution', () => {
  expect(classifyMinimaxTool({ name: 'write', rawInput: { path: 'link/../draft.txt' }, locations: [{ path: '/misleading' }] }, dir)).toEqual({ kind: 'edit', paths: [join(dir, 'draft.txt')] })
  const outside = classifyMinimaxTool({ name: 'write', rawInput: { path: 'link/../../draft.txt' } }, dir)
  expect(outside.paths).toEqual([resolve(dir, '..', 'draft.txt')])
  expect(canAutoApprove({ sessionId: 's', turnId: 't', summary: '', detail: '', kind: 'file_write', paths: outside.paths! }, { workDir: dir })).toBe(false)
  for (const tool of [{ name: 'write', locations: [{ path: dir }] }, { name: 'edit', rawInput: { filePath: dir } }, { name: 'write', rawInput: { path: '' } }, { name: 'write', rawInput: { path: '~/outside.txt' } }, { name: 'edit', rawInput: { file_path: '~' } }]) {
    expect(classifyMinimaxTool(tool, dir)).toEqual({ kind: 'edit' })
  }
  expect(classifyMinimaxTool({ title: 'write', rawInput: { path: dir } }, dir)).toEqual({ kind: 'other', autoApprovalBlocked: true })
  for (const name of ['read', 'grep', 'glob']) expect(classifyMinimaxTool({ name }, dir)).toEqual({ kind: 'read' })
  expect(canAutoApprove({ sessionId: 's', turnId: 't', summary: '', detail: '', kind: 'other', autoApprovalBlocked: true }, { workDir: dir })).toBe(false)
})

it('ignores vendor notifications and rejects unknown extension requests', async () => {
  await runtime.dispatchTurn(input())
  const server = servers[0]!
  server.send({ method: 'mcode/session/queue_update', params: {} })
  server.send({ id: 4321, method: 'mcode/session/goal/get', params: {} })
  await expect.poll(() => server.answers.get(4321)).toMatchObject({ code: -32601 })
  expect(events.filter(event => event.type === 'item')).toEqual([])
})

it('sends cancel and reports interruption when the native prompt stops', async () => {
  const turn = input()
  await runtime.dispatchTurn(turn)
  await runtime.interruptTurn(turn)
  expect(servers[0]!.requests('session/cancel')[0]!.params).toEqual({ sessionId: NATIVE_SESSION })
  servers[0]!.settlePrompt('cancelled')
  await expect.poll(() => events).toContainEqual({ type: 'turn_ended', sessionId: turn.sessionId, turnId: turn.turnId, status: 'interrupted' })
})

it('kills an unresponsive process after the interrupt grace period', async () => {
  const turn = input()
  await runtime.dispatchTurn(turn)
  await runtime.interruptTurn(turn)
  await expect.poll(() => servers[0]!.signals).toContain('SIGKILL')
  await expect.poll(() => events).toContainEqual({ type: 'turn_ended', sessionId: turn.sessionId, turnId: turn.turnId, status: 'interrupted' })
})

it('distinguishes immediate prompt rejection from uncertain delivery without resending', async () => {
  handlers['session/prompt'] = () => ({ error: { code: -32602, message: 'Prompt invalid' } })
  await expect(runtime.dispatchTurn(input())).rejects.toMatchObject({ kind: 'rejected' })
  handlers['session/prompt'] = () => {
    setImmediate(() => servers.at(-1)!.exit())
    return HANG
  }
  await expect(runtime.dispatchTurn(input())).rejects.toMatchObject({ kind: 'unknown' })
  expect(servers.every(server => server.requests('session/prompt').length === 1)).toBe(true)
})
