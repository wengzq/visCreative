import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as minimax from '@vis/agent-minimax'
import { buildSandboxPolicy, prepareSandbox } from '@vis/workbench-core'
import { eq, spaceSchema } from '@vis/storage'
import { NATIVE_SESSION, recordedHandlers, ScriptedMcode } from '../../../packages/workbench/minimax/src/fixtures/scripted'
import { listAgents, registerAgents } from './agents'
import { minimaxRuntime } from './minimax'
import { openSpaceHost, type AgentRuntimeFactory } from './space-host'

afterEach(() => { vi.restoreAllMocks() })

it('registers MiniMax metadata and probes only executable availability in fake directories', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vis-minimax-registry-')))
  const path = join(dir, 'mcode')
  const runtime = minimaxRuntime({ socketPath: join(dir, 'run', 'vis.sock'), visMcp: { command: '/fake/vis', args: ['mcp'] } })
  const agents = registerAgents([{
    descriptor: minimax.minimaxDescriptor, runtime,
    availability: () => minimax.resolveMcode({ env: { HOME: dir, PATH: dir } }) ? { available: true } : { available: false, reason: 'executable_missing' },
  }])
  try {
    expect(listAgents(agents)).toEqual([{ ...minimax.minimaxDescriptor, available: false, reason: 'executable_missing' }])
    writeFileSync(path, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
    expect(listAgents(agents)).toEqual([{ ...minimax.minimaxDescriptor, available: true }])
    expect(listAgents({ 'minimax-code': runtime })[0]?.capabilities.models).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('passes space tokens, probe location and registered credential boundaries through the studiod factory', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vis-minimax-factory-')))
  const runtime = { ensureReady: async () => {}, dispatchTurn: async () => {}, terminateTurn: async () => {}, interruptTurn: async () => {}, agentOptions: async () => [], dispose: async () => {} }
  const create = vi.spyOn(minimax, 'createMinimaxRuntime').mockReturnValue(runtime)
  const agents = registerAgents([{ descriptor: minimax.minimaxDescriptor, runtime: minimaxRuntime({
    socketPath: join(dir, 'run', 'vis.sock'), dataDir: dir, env: { HOME: join(dir, 'home'), PATH: '' },
    mcodePath: '/fake/mcode', visMcp: { command: '/fake/vis', args: ['mcp'] },
  }) }])
  const host = openSpaceHost('minimax-factory', dir, { runtimes: agents, providers: [], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } } })
  try {
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ db: host.db, requestApproval: expect.any(Function) }), expect.objectContaining({
      dataDir: dir, probeDir: join(dir, 'agents', 'minimax-probes'), mcodePath: '/fake/mcode',
      forbiddenPaths: minimax.minimaxDescriptor.forbiddenPaths, issueToken: expect.any(Function),
    }))
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('discovers and dispatches a scripted MiniMax turn through a registered space runtime', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vis-minimax-host-')))
  const mcodePath = join(dir, 'fake-mcode')
  writeFileSync(mcodePath, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  const servers: ScriptedMcode[] = []
  const factory: AgentRuntimeFactory = ({ db, workDir, report, requestApproval, forbiddenPaths }) => minimax.createMinimaxRuntime({ db, report, requestApproval }, {
    mcodePath, workDir, probeDir: join(dir, 'probes'), socketPath: '/fake/vis.sock', visMcp: { command: '/fake/vis', args: ['mcp'] },
    issueToken: () => ({ token: 'test-token', tokenHash: 'test-hash' }), env: { HOME: join(dir, 'home'), PATH: '' },
    ...(forbiddenPaths ? { forbiddenPaths } : {}),
    admissionMs: 10, interruptGraceMs: 30, startTimeoutMs: 500,
    spawn: () => {
      const server = new ScriptedMcode(recordedHandlers())
      servers.push(server)
      return server
    },
  })
  const host = openSpaceHost('minimax-turn', dir, { runtimes: registerAgents([{ descriptor: minimax.minimaxDescriptor, runtime: factory }]), providers: [], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } } })
  try {
    const { sessionId } = host.sessions.create({ requestId: 'create-minimax', agentKind: 'minimax-code' })
    host.sessions.sendMessage({ requestId: 'send-minimax', sessionId, text: 'Inspect the canvas', refs: [] })
    await expect.poll(() => servers[0]?.requests('session/prompt').length).toBe(1)
    servers[0]!.update({ sessionUpdate: 'agent_message_chunk', messageId: 'reply', content: { type: 'text', text: 'Canvas inspected' } })
    servers[0]!.settlePrompt()
    await expect.poll(() => host.sessions.list({}).sessions.find(session => session.sessionId === sessionId)?.activeTurnId).toBeNull()
    expect(host.db.select().from(spaceSchema.sessions).where(eq(spaceSchema.sessions.id, sessionId)).get()?.agentResumeId).toBe(NATIVE_SESSION)
    expect(host.sessions.getTranscript({ sessionId }).items).toContainEqual(expect.objectContaining({ kind: 'assistant_text', payload: { text: 'Canvas inspected' } }))
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps cross-Agent credentials private while allowing the MiniMax install and own runtime in a fake home', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vis-minimax-policy-')))
  const home = join(dir, 'home')
  mkdirSync(home)
  try {
    const agent = { ...minimax.minimaxSandbox, forbiddenPaths: [...minimax.minimaxDescriptor.forbiddenPaths, '~/.other-agent'] }
    const policy = buildSandboxPolicy(join(dir, 'work'), join(dir, 'data'), home, join(home, '.minimax'), agent)
    const deny = policy.split('\n').find(line => line.startsWith('(deny file-read*'))!
    expect(deny).toContain(`(subpath ${JSON.stringify(join(home, '.mavis'))})`)
    expect(deny).toContain('/[.]mavis-[^/]*$')
    expect(deny).toContain(`(subpath ${JSON.stringify(join(home, '.other-agent'))})`)
    expect(deny).not.toContain(`(subpath ${JSON.stringify(join(home, '.minimax'))})`)
    const env = prepareSandbox({ cwd: dir, platform: 'win32', agent, env: { HOME: home, PATH: '', MCODE_PROVIDER_API_KEY: 'test-key', CODEBUDDY_API_KEY: 'filtered' } }).env
    expect(env).toEqual({ HOME: home, PATH: '', MCODE_PROVIDER_API_KEY: 'test-key' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
