// End-to-end: real studiod + built vis command. The fake Agent invokes vis through Bash during a turn, like Claude.
// Build the CLI first: pnpm --filter @vis/cli build; skipped if not built.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { newId } from '@vis/domain'
import { createMockProvider } from '@vis/generation'
import { PROTOCOL_VERSION } from '@vis/protocol'
import { eq, spaceSchema as s } from '@vis/storage'
import { issueAgentToken } from './auth'
import type { AgentRuntimeFactory } from './space-host'
import { startStudiod, type Studiod } from './studiod'

const VIS = fileURLToPath(new URL('../../../apps/cli/dist/vis.mjs', import.meta.url))

let dir: string
let studiod: Studiod
let agentLog: { args: string[]; code: number; out: any }[]

function vis(env: Record<string, string>, ...args: string[]) {
  return new Promise<{ code: number; out: any }>(resolve => {
    execFile(process.execPath, [VIS, ...args], { env: { ...env, PATH: process.env.PATH } }, (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      const out = JSON.parse(stdout.trim().split('\n').at(-1)!)
      agentLog.push({ args, code, out })
      resolve({ code, out })
    })
  })
}

/** Fake Agent: read snapshot -> submit generation -> wait -> end turn */
const scriptedAgent: AgentRuntimeFactory = ({ spaceId, db, report }) => ({
  async ensureReady() {},
  async dispatchTurn(input) {
    const { token, tokenHash } = issueAgentToken(spaceId)
    const instanceId = newId('agentInstance')
    db.insert(s.agentInstances).values({ id: instanceId, sessionId: input.sessionId, status: 'ready', tokenHash, startedAt: Date.now() }).run()
    db.update(s.turns).set({ instanceId }).where(eq(s.turns.id, input.turnId)).run()
    const env = { VIS_SOCKET: studiod.socketPath, VIS_AGENT_TOKEN: token }
    void (async () => {
      const snapshot = await vis({ VIS_DATA_DIR: dir, VIS_AGENT_TOKEN: token }, 'canvas', 'get', '--snapshot', 'turn')
      const slotId = snapshot.out.nodes[0].slots[0].slotId
      const submit = await vis(env, 'gen', 'submit', '--kind', 'image', '--prompt', '黄昏的屋顶花园', '--inputs', JSON.stringify([{ slotId }]))
      await vis(env, 'gen', 'wait', submit.out.jobId)
      await vis(env, 'canvas', 'apply', '--params', JSON.stringify({ requestId: 'r1', ops: [{ op: 'node.create', tempId: 'draft', kind: 'text', content: { text: 'Agent draft' } }, { op: 'slot.setText', slotId: 'draft:main', body: 'Change', expectedRevision: 0 }] }))
      await vis(env, 'session', 'list')
      db.update(s.agentInstances).set({ status: 'exited', exitedAt: Date.now() }).where(eq(s.agentInstances.id, instanceId)).run()
      report({ type: 'turn_ended', sessionId: input.sessionId, turnId: input.turnId, status: 'completed' })
    })()
  },
  async terminateTurn() {}, async interruptTurn() {},
})

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vis-e2e-'))
  vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
  agentLog = []
  studiod = await startStudiod({
    dataDir: dir,
    studiodVersion: 'e2e',
    runtimes: { codex: scriptedAgent },
    providers: [createMockProvider({ latencyMs: 100 })],
    defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
  })
})
afterEach(async () => {
  await studiod.stop('user_quit')
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

/** Minimal UI-side client */
async function uiCall() {
  const socket = connect(studiod.socketPath)
  await new Promise(r => socket.once('connect', r))
  socket.setEncoding('utf8')
  let buffer = ''
  let id = 0
  const waiting = new Map<number, (v: any) => void>()
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const msg = JSON.parse(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      if ('id' in msg) waiting.get(msg.id)?.(msg)
    }
  })
  const call = (method: string, params: unknown) => new Promise<any>(resolve => {
    waiting.set(++id, m => resolve(m.result ?? m.error))
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  await call('runtime.hello', { protocolVersion: PROTOCOL_VERSION, credential: { kind: 'ui', token: readFileSync(studiod.tokenPath, 'utf8') } })
  return { call, close: () => socket.destroy() }
}

it.skipIf(!existsSync(VIS))('user sends a message -> Agent reads a snapshot, generates and waits via vis -> results populate the canvas', async () => {
  const spaceId = studiod.spaces.create('e2e').spaceId
  const ui = await uiCall()
  await ui.call('events.subscribe', { spaceId })
  const { idMap } = await ui.call('canvas.apply', { requestId: 'n1', ops: [{ op: 'node.create', tempId: 'n', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: '屋顶花园，黄昏，暖色' } }] })
  const { sessionId } = await ui.call('session.create', { requestId: 's1', title: '海报' })
  await ui.call('session.sendMessage', { requestId: 'm1', sessionId, text: '按设定生成一张图', refs: [{ nodeId: idMap.n, versionPolicy: 'latest-at-execution' }] })

  for (let i = 0; i < 300 && agentLog.length < 5; i++) await new Promise(r => setTimeout(r, 20))
  const [snapshot, submit, wait, conflict, forbidden] = agentLog
  expect(snapshot!.out.nodes[0].slots[0].content).toEqual({ type: 'text', body: '屋顶花园，黄昏，暖色' })
  expect(submit).toMatchObject({ code: 0, out: { status: 'queued', requestId: expect.any(String) } })
  expect(wait).toMatchObject({ code: 0, out: { status: 'succeeded', outputs: [{ delivery: { status: 'delivered' } }] } })
  expect(conflict).toMatchObject({ code: 1, out: { error: { code: 'revision_conflict', conflicts: [{ expectedRevision: 0, currentRevision: 1 }] } } })
  // Session listing is absent from Agent capabilities, so the CLI rejects it locally.
  expect(forbidden!.code).toBe(2)

  const newNodeId = wait!.out.outputs[0].delivery.nodeId
  const canvas = await ui.call('canvas.get', {})
  expect(canvas.nodes.find((n: any) => n.nodeId === newNodeId).slots[0].content).toMatchObject({ type: 'asset' })
  expect(canvas.nodes).toHaveLength(2)
  expect(canvas.nodes.find((n: any) => n.nodeId === idMap.n).slots[0].content).toEqual({ type: 'text', body: '屋顶花园，黄昏，暖色' })
  ui.close()
}, 15_000)
