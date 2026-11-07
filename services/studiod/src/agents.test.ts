import { describe, expect, it } from 'vitest'
import { codexDescriptor, codexSandbox } from '../../../packages/workbench/codex/src/descriptor'
import { deepseekDescriptor, deepseekSandbox } from '../../../packages/workbench/deepseek/src/descriptor'
import { claudeDescriptor } from '../../../packages/workbench/claude/src/descriptor'
import { buildSandboxPolicy, prepareSandbox } from '@vis/workbench-core'
import { listAgents, registerAgents } from './agents'
import { openSpaceHost, type AgentRuntimeFactory } from './space-host'
import { codexRuntime } from './codex'
import { deepseekRuntime } from './deepseek'
import { join } from 'node:path'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

const runtime: AgentRuntimeFactory = () => ({
  async ensureReady() {},
  async dispatchTurn() {},
  async terminateTurn() {}, async interruptTurn() {},
})

describe('Agent registration', () => {
  it('keeps descriptor capabilities for legacy bundled factory callers', () => {
    const options = { socketPath: 'unused', visMcp: { command: 'unused', args: [] } }
    const agents = listAgents({ codex: codexRuntime(options), deepseek: deepseekRuntime(options) })
    expect(agents.map(agent => agent.capabilities.models)).toEqual([true, true])
    expect(agents.map(agent => agent.capabilities.effort)).toEqual([true, true])
  })

  it('passes every registered credential boundary to runtimes without hard-coded adapter lists', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vis-agent-boundaries-')))
    const received = new Map<string, readonly string[]>()
    const descriptors = [codexDescriptor, deepseekDescriptor, claudeDescriptor, { ...codexDescriptor, kind: 'example', forbiddenPaths: ['~/.example'] }]
    const runtimes = registerAgents(descriptors.map(descriptor => ({
      descriptor,
      runtime: ctx => {
        received.set(descriptor.kind, ctx.forbiddenPaths ?? [])
        return { ...runtime(ctx), agentOptions: async () => [] }
      },
    })))
    const host = openSpaceHost('boundaries', dir, { runtimes, providers: [], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } } })
    try {
      const home = join(dir, 'home')
      for (const [kind, sandbox] of [['codex', codexSandbox], ['deepseek', deepseekSandbox]] as const) {
        const policy = buildSandboxPolicy(join(dir, 'work'), join(dir, 'data'), home, join(home, sandbox.runtimeDirectory), { ...sandbox, forbiddenPaths: received.get(kind)! })
        const deny = policy.split('\n').find(line => line.startsWith('(deny file-read*'))!
        expect(deny).toContain(`(subpath ${JSON.stringify(join(home, '.example'))})`)
        expect(deny).not.toContain(`(subpath ${JSON.stringify(join(home, sandbox.runtimeDirectory))})`)
      }
      expect(received.get('example')).toContain('~/.codex')
    } finally {
      await host.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pairs serializable metadata and runtime by descriptor kind, including community adapters', () => {
    const example = { ...codexDescriptor, kind: 'example', label: 'Example' }
    const agents = registerAgents([
      { descriptor: example, runtime },
      { descriptor: deepseekDescriptor, runtime, availability: () => ({ available: false, reason: 'executable_missing' }) },
    ])
    expect(Object.keys(agents)).toEqual(['example', 'deepseek'])
    expect(listAgents(agents)).toEqual([
      { ...example, available: true },
      { ...deepseekDescriptor, available: false, reason: 'executable_missing' },
    ])
    expect(JSON.stringify(listAgents(agents))).not.toContain('runtime')
    expect(() => registerAgents([{ descriptor: example, runtime }, { descriptor: example, runtime }])).toThrow('Duplicate Agent')
    expect(() => registerAgents([{ descriptor: { ...example, kind: '../bad' }, runtime }])).toThrow()
  })

  it('pins existing capabilities and credential boundaries without starting any Agent', () => {
    expect([codexDescriptor, deepseekDescriptor].map(agent => agent.capabilities)).toEqual([
      { resume: true, interrupt: true, models: true, effort: true, approvals: true },
      { resume: true, interrupt: true, models: true, effort: true, approvals: true },
    ])
    expect(claudeDescriptor.capabilities).toEqual({ resume: true, interrupt: true, models: false, effort: false, approvals: false })
    expect(codexDescriptor.forbiddenPaths).toContain('~/.codex')
    expect(deepseekDescriptor.forbiddenPaths).toContain('~/.dsh')
    expect(claudeDescriptor.forbiddenPaths).toEqual(['~/.claude', '~/.claude.json', '~/.claude.json.*'])
  })

  it('pins Windows sandbox environments to the pre-registry allowlists', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'vis-agent-env-')))
    try {
      const env = { HOME: home, PATH: '/tools', DEEPSEEK_API_KEY: 'fake-dsh-key', ARK_API_KEY: 'fake-provider-key', VIS_AGENT_TOKEN: 'fake-token', NODE_OPTIONS: '--require=fake' }
      const base = { cwd: home, platform: 'win32' as const, env }
      expect(prepareSandbox({ ...base, agent: codexSandbox })).toEqual({
        env: { HOME: home, PATH: '/tools', CODEX_HOME: join(home, '.codex') },
        policy: undefined, notice: undefined, isolation: 'none',
      })
      expect(prepareSandbox({ ...base, agent: deepseekSandbox })).toEqual({
        env: { HOME: home, PATH: '/tools', DEEPSEEK_API_KEY: 'fake-dsh-key' },
        policy: undefined, notice: undefined, isolation: 'none',
      })
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})
