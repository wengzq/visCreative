import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCodexRuntime } from '@vis/agent-codex'
import { createDeepseekRuntime } from '@vis/agent-deepseek'
import { createClaudeRuntime, type QueryFn } from '@vis/agent-claude'
import { openSpaceDb, spaceSchema as s } from '@vis/storage'
import { createSessionService, spawnAgentProcess, type AgentRuntimePort, type ChildLike, type SessionService } from '@vis/workbench-core'
import { createMockProvider } from '@vis/generation'
import { createMemorySecretStore } from './secret-store'
import { startStudiod } from './studiod'
import type { AgentRuntimeFactory } from './space-host'

// Both levels ignore interruption and stdin EOF. Handshake acceptance proves the descendant is ready.
const fakeProcess = `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send(process.pid)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
const ready = new Promise(resolve => child.once('message', pid => { writeFileSync('pids.json', JSON.stringify([process.pid, pid])); resolve() }))
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let end; (end = buffer.indexOf('\\n')) >= 0;) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
    if (message.id == null || ['session/prompt', 'turn/interrupt'].includes(message.method)) continue
    void ready.then(() => {
      const result = message.method === 'thread/start' ? { thread: { id: 'thread' } }
        : message.method === 'turn/start' ? { turn: { id: 'turn' } }
        : message.method === 'session/new' ? { sessionId: 'session' }
        : message.method === 'model/list' ? { data: [] } : {}
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
    })
  }
})
`
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

describe('Turn process trees', () => {
  it('studiod shutdown leaves no live Agent or descendant, including a turn still running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vis-turn-shutdown-'))
    const script = join(dir, 'fake.mjs')
    writeFileSync(script, fakeProcess)
    const runtime: AgentRuntimeFactory = ctx => createCodexRuntime(ctx, {
      workDir: () => dir, socketPath: join(dir, 'unused.sock'), issueToken: () => ({ token: 'fake', tokenHash: crypto.randomUUID() }),
      visMcp: { command: process.execPath, args: [] }, env: { PATH: process.env.PATH },
      spawn: () => spawnAgentProcess(process.execPath, [script], { cwd: dir, env: {} }),
    })
    const daemon = await startStudiod({ dataDir: join(dir, 'data'), studiodVersion: 'test', runtimes: { codex: runtime },
      secretStore: createMemorySecretStore(), providers: [createMockProvider()], defaults: { image: { provider: 'mock' } },
    })
    try {
      const project = daemon.spaces.create({ requestId: crypto.randomUUID(), name: 'Shutdown', rootPath: join(dir, 'project') })
      const host = daemon.spaces.get(project.spaceId)!
      const session = host.sessions.create({ requestId: crypto.randomUUID() })
      host.sessions.sendMessage({ requestId: crypto.randomUUID(), sessionId: session.sessionId, text: 'Hold', refs: [] })
      await host.sessions.idle()
      const pids = JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8')) as number[]
      expect(pids.every(alive)).toBe(true)
      await daemon.stop('user_quit')
      await expect.poll(() => pids.some(alive)).toBe(false)
    } finally { await daemon.stop('user_quit'); rmSync(dir, { recursive: true, force: true }) }
  })

  it.each(['codex', 'deepseek', 'claude'] as const)('%s hard termination and disposal kill an interruption-resistant process and its descendant', async kind => {
    for (const action of ['force', 'dispose'] as const) {
      const dir = mkdtempSync(join(tmpdir(), `vis-turn-process-${kind}-`))
      const script = join(dir, 'fake.mjs')
      writeFileSync(script, fakeProcess)
      const db = openSpaceDb(':memory:')
      let sessions!: SessionService
      let runtime!: AgentRuntimePort & { dispose(): Promise<void> }
      let child: ChildLike | undefined
      const spawn = (_command: string, _args: string[], options: { env: Record<string, string | undefined> }) => {
        child = spawnAgentProcess(process.execPath, [script], { cwd: dir, env: options.env })
        return child
      }
      const common = { workDir: () => dir, issueToken: () => ({ token: 'fake', tokenHash: crypto.randomUUID() }), socketPath: join(dir, 'unused.sock'), interruptGraceMs: 10_000, env: { PATH: process.env.PATH } }
      const ctx = { db, report: (event: Parameters<SessionService['handleAgentEvent']>[0]) => sessions.handleAgentEvent(event) }
      if (kind === 'codex') runtime = createCodexRuntime(ctx, { ...common, spawn, visMcp: { command: process.execPath, args: [] } })
      else if (kind === 'deepseek') runtime = createDeepseekRuntime(ctx, { ...common, spawn, dshPath: process.execPath, overlayPath: join(dir, 'overlay.yml'), admissionMs: 10, visMcp: { command: process.execPath, args: [] } })
      else {
        const query: QueryFn = ({ options }) => {
          const spawned = options!.spawnClaudeCodeProcess!({ command: process.execPath, args: [script], cwd: dir, env: {}, signal: new AbortController().signal })
          child = spawned as ChildLike
          const exited = new Promise<void>(resolve => spawned.once('exit', () => resolve()))
          const iterator = (async function* () {
            await expect.poll(() => { try { return JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8')).length } catch { return 0 } }).toBe(2)
            yield { type: 'system', subtype: 'init', session_id: 'fake', uuid: 'fake' }
            await exited
          })()
          return Object.assign(iterator, { interrupt: () => new Promise<void>(() => {}) }) as unknown as ReturnType<QueryFn>
        }
        runtime = createClaudeRuntime(ctx, { ...common, query, cliBinDir: dir })
      }
      sessions = createSessionService({ db, runtime })
      cleanups.push(async () => { sessions.dispose(); await runtime.dispose(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })
      const session = sessions.create({ requestId: crypto.randomUUID(), title: 'Fake process' })
      sessions.sendMessage({ requestId: crypto.randomUUID(), sessionId: session.sessionId, text: 'Hold', refs: [] })
      await sessions.idle()
      const turnId = sessions.list({}).sessions[0]!.activeTurnId!
      const pids = JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8')) as number[]
      expect(pids.every(alive)).toBe(true)
      void runtime.interruptTurn({ sessionId: session.sessionId, turnId })
      expect(pids.every(alive)).toBe(true)
      // The request can remain pending in Claude; the force action must remain independent of it.
      if (action === 'force') await runtime.terminateTurn({ sessionId: session.sessionId, turnId })
      else { sessions.dispose(); await runtime.dispose() }
      await expect.poll(() => pids.some(alive)).toBe(false)
      expect(db.select().from(s.agentInstances).get()?.status).toBe('exited')
      expect(child).toBeDefined()
      await cleanups.pop()!()
    }
  }, 30_000)
})
