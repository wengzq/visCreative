import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { GuideTopic, PROTOCOL_VERSION } from '@vis/protocol'
import type { RpcRequest } from '@vis/protocol'
import { run } from './main'
import { connect } from './client'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function server(handler: (request: RpcRequest, socket: Socket) => unknown, token = 'secret') {
  const dir = mkdtempSync(join(tmpdir(), 'vis-'))
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\vis-test-${randomUUID()}` : join(dir, 'rpc.sock')
  const requests: RpcRequest[] = []
  const sockets = new Set<Socket>()
  const service = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)) as RpcRequest
        buffer = buffer.slice(end + 1)
        requests.push(request)
        let response: unknown
        if (request.method === 'runtime.hello') {
          const params = request.params as { credential: { token: string } }
          response = params.credential.token === token
            ? { result: { protocolVersion: PROTOCOL_VERSION, studiodVersion: 'test', runtimeEpoch: 'epoch' } }
            : { error: { code: -32000, message: 'Invalid token', data: { code: 'forbidden' } } }
        } else response = handler(request, socket)
        if (response !== undefined) socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response as object })}\n`)
      }
    })
  })
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => service.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })
  await new Promise<void>((resolve, reject) => { service.once('error', reject); service.listen(socketPath, resolve) })
  return { requests, env: { VIS_SOCKET: socketPath, VIS_AGENT_TOKEN: 'secret' } }
}

async function invoke(args: string[], env: Record<string, string | undefined> = {}, stdin = '') {
  let stdout = ''
  const code = await run(args, env, { stdin: async () => stdin, stdout: s => { stdout += s }, stderr: () => {} })
  return { code, stdout, value: args.includes('--help') ? undefined : JSON.parse(stdout) }
}

it('derives asset list, asset label and library state commands from the agent capability table', async () => {
  for (const [command, method, params] of [
    [['asset', 'list'], 'asset.list', { labeled: false }],
    [['asset', 'label'], 'asset.label', { items: [{ assetId: 'asset', category: 'Portrait' }] }],
    [['library', 'state'], 'library.state', {}],
  ] as const) {
    const help = await invoke([...command, '--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain(`vis ${command.join(' ')}`)
    const fake = await server(request => {
      expect(request.method).toBe(method)
      expect(request.params).toMatchObject(params)
      return { result: { ok: true } }
    })
    const result = await invoke([...command, '--params', JSON.stringify(params)], fake.env)
    expect(result.code).toBe(0)
    expect(result.value).toMatchObject({ ok: true })
  }
})

it('media wait polls to a terminal task and returns the last task with exit code 3 on a deadline', async () => {
  let calls = 0
  const task = { taskId: 'media-task', operation: 'image.crop', nodeId: 'node', slotId: 'slot', createdAt: 1 }
  const fake = await server(request => {
    expect(request).toMatchObject({ method: 'media.get', params: { taskId: 'media-task', waitMs: 30000 } })
    return { result: { ...task, status: ++calls === 1 ? 'running' : 'succeeded' } }
  })
  expect(await invoke(['media', 'wait', 'media-task', '--timeout-ms', '500'], fake.env)).toMatchObject({ code: 0, value: { taskId: task.taskId, status: 'succeeded' } })
  expect(calls).toBe(2)
  const blocked = await server((request, socket) => {
    setTimeout(() => { if (!socket.destroyed) socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ...task, status: 'running' } })}\n`) }, 5)
  })
  expect((await invoke(['media', 'wait', task.taskId, '--timeout-ms', '40'], blocked.env))).toMatchObject({ code: 3, value: { status: 'running' } })
  expect(await invoke(['media', 'wait', task.taskId, '--timeout-ms', '-1'], fake.env)).toMatchObject({ code: 2 })
})

it('handshakes before reading the canvas; token errors preserve forbidden', async () => {
  const fake = await server(() => ({ result: { nodes: [] } }))
  const result = await invoke(['canvas', 'get'], fake.env)
  expect(result).toMatchObject({ code: 0, value: { nodes: [] } })
  expect(fake.requests[0]).toMatchObject({ method: 'runtime.hello', params: { protocolVersion: PROTOCOL_VERSION, credential: { kind: 'agent', token: 'secret' } } })
  expect(fake.requests[1]).toMatchObject({ method: 'canvas.get', params: {} })
  expect(await invoke(['canvas', 'get'], { ...fake.env, VIS_AGENT_TOKEN: 'bad' })).toMatchObject({ code: 1, value: { error: { code: 'forbidden' } } })
  expect(fake.requests).toHaveLength(3)
})

it('slot history gets its command from the capability table and parses pagination parameters', async () => {
  const fake = await server(() => ({ result: { versions: [], hasMore: false } }))
  expect(await invoke(['slot', 'history', '--slot-id', 's', '--limit', '2', '--before-revision', '5'], fake.env)).toMatchObject({ code: 0, value: { versions: [], hasMore: false } })
  expect(fake.requests[1]).toMatchObject({ method: 'slot.history', params: { slotId: 's', limit: 2, beforeRevision: 5 } })
})

it('guide lists topics and accepts each positional topic alongside generic flags', async () => {
  const topics = GuideTopic.options.map(topic => ({ topic, title: `${topic} guide`, when: `Read before ${topic} work.` }))
  const fake = await server(request => {
    const { topic } = request.params as { topic?: string }
    return { result: { topics, ...(topic ? { guide: { topic, title: `${topic} guide`, body: `# ${topic}` } } : {}) } }
  })
  expect(await invoke(['guide'], fake.env)).toMatchObject({ code: 0, value: { topics } })
  expect(fake.requests[1]).toMatchObject({ method: 'guide.get', params: {} })
  for (const topic of GuideTopic.options) {
    expect(await invoke(['guide', topic], fake.env)).toMatchObject({ code: 0, value: { topics, guide: { topic, body: `# ${topic}` } } })
    expect(fake.requests.at(-1)).toMatchObject({ method: 'guide.get', params: { topic } })
  }
  expect(await invoke(['guide', '--topic', 'timeline'], fake.env)).toMatchObject({ code: 0, value: { guide: { topic: 'timeline' } } })
  expect(await invoke(['guide', '--params', '{"topic":"script"}'], fake.env)).toMatchObject({ code: 0, value: { guide: { topic: 'script' } } })
  expect((await invoke(['guide', '--help'])).stdout).toContain('vis guide [topic]')
})

it('guide rejects unknown topics and extra positionals before connecting', async () => {
  const fake = await server(() => ({ result: {} }))
  for (const args of [['guide', 'unknown'], ['guide', 'script', 'timeline']]) {
    expect(await invoke(args, fake.env)).toMatchObject({ code: 2, value: { error: { code: 'invalid_params' } } })
  }
  expect(fake.requests).toEqual([])
})

it('work commands come from the capability table; dispatch and completion reports preserve brief, references, and idempotency IDs', async () => {
  const fake = await server(() => ({ result: {} }))
  const dispatched = await invoke(['work', 'dispatch', '--title', '分镜', '--brief', '在自己框内绘制三张分镜并检查', '--agent-kind', 'deepseek', '--activate', 'true'], fake.env)
  expect(dispatched.code).toBe(0)
  expect(fake.requests[1]).toMatchObject({ method: 'work.dispatch', params: { title: '分镜', brief: '在自己框内绘制三张分镜并检查', agentKind: 'deepseek', activate: true, requestId: dispatched.value.requestId } })
  const refs = { nodeIds: ['node_1'], assetVersionIds: ['asset_1'] }
  const reported = await invoke(['work', 'report', '--kind', 'done', '--body', '已完成并验证', '--refs', JSON.stringify(refs)], fake.env)
  expect(reported.code).toBe(0)
  expect(fake.requests[3]).toMatchObject({ method: 'work.report', params: { kind: 'done', body: '已完成并验证', refs, requestId: reported.value.requestId } })
  expect((await invoke(['work', '--help'])).stdout).toContain('vis work dispatch')
  expect((await invoke(['work', '--help'])).stdout).not.toContain('vis work create')
})

it('merges JSON, stdin, and shorthand arguments with shorthand taking precedence; generates and returns requestId', async () => {
  const fake = await server(() => ({ result: { jobId: 'j', status: 'queued', bindings: [] } }))
  const result = await invoke(['gen', 'submit', '--prompt', '黄昏的屋顶花园', '--params', '-', '--inputs', '[{"slotId":"s","revision":2}]'], fake.env, '{"kind":"image","prompt":"old","params":{"count":2}}')
  expect(result.code).toBe(0)
  expect(result.value.requestId).toMatch(/^[0-9a-f-]{36}$/)
  expect(fake.requests[1]?.params).toEqual({ kind: 'image', prompt: '黄昏的屋顶花园', params: { count: 2 }, inputs: [{ slotId: 's', revision: 2 }], requestId: result.value.requestId })
  const retry = await invoke(['gen', 'submit', '--params', '{"kind":"image","prompt":"p"}', '--request-id', 'retry-id'], fake.env)
  expect(retry.value.requestId).toBe('retry-id')
  expect(fake.requests[3]?.params).toMatchObject({ requestId: 'retry-id' })
  await invoke(['gen', 'get', '--job-id', 'j', '--wait-ms', '42'], fake.env)
  expect(fake.requests[5]?.params).toEqual({ jobId: 'j', waitMs: 42 })
})

it('audio generation, references, import, and metadata reads share the same capability interface', async () => {
  const asset = { assetVersionId: 'audio_1', assetId: 'asset_1', version: 1, kind: 'audio', mime: 'audio/wav', durationMs: 2000, url: 'file:///audio.wav', path: '/project/audio.wav' }
  const source = { jobId: 'job_1', prompt: '雨滴音效', provider: 'mock', model: 'mock-sfx-1', params: { duration: 2 }, inputNodeIds: [] }
  const history = { versions: [{ revision: 1, content: { type: 'asset', assetVersionId: 'audio_1', mime: 'audio/wav' }, createdAt: 1, actor: 'agent', isCurrent: true, source }], hasMore: false }
  const fake = await server(request => ({ result: request.method === 'generation.submit'
    ? { jobId: 'job_1', status: 'queued', bindings: [] }
    : request.method === 'slot.history' ? history : asset }))
  const generated = await invoke(['gen', 'submit', '--kind', 'audio', '--prompt', '雨滴音效', '--inputs', '[{"slotId":"audio_slot","revision":1}]', '--params', '{"params":{"duration":2}}'], fake.env)
  expect(generated.code).toBe(0)
  expect(fake.requests[1]).toMatchObject({ method: 'generation.submit', params: { kind: 'audio', inputs: [{ slotId: 'audio_slot', revision: 1 }], params: { duration: 2 } } })
  expect(await invoke(['asset', 'import', 'file', '--path', '/project/audio.wav'], fake.env)).toMatchObject({ code: 0, value: asset })
  expect(await invoke(['asset', 'get', '--asset-version-id', 'audio_1'], fake.env)).toMatchObject({ code: 0, value: asset })
  expect(await invoke(['slot', 'history', '--slot-id', 'audio_slot'], fake.env)).toMatchObject({ code: 0, value: history })
})

it('local validation failures and unknown arguments do not open a connection', async () => {
  const fake = await server(() => ({ result: {} }))
  for (const args of [
    ['canvas', 'apply', '--ops', '[{"op":"slot.clear","slotId":"s"}]'],
    ['gen', 'get', '--wait-ms', 'no'],
    ['gen', 'submit', '--params', '{'],
    ['gen', 'submit', '--kind', 'audio', '--prompt', '音效', '--override-quota', 'true'],
    ['canvas', 'get', '--bogus', 'x'],
  ]) expect(await invoke(args, fake.env)).toMatchObject({ code: 2, value: { error: { code: 'invalid_params' } } })
  const malformed = await invoke(['canvas', 'apply', '--ops', '[{"op":"node.create","kind":"text","content":{"body":"x"}}]'], fake.env) as any
  expect(malformed.value.error.message).toContain('ops[0].tempId: ')
  expect(malformed.value.error.message).toContain('Example: ')
  expect(fake.requests).toEqual([])
})

it('invalid script and timeline operations point to their guides before connecting', async () => {
  const fake = await server(() => ({ result: {} }))
  for (const [op, topic] of [['script.replace', 'script'], ['script.patch', 'script'], ['timeline.set', 'timeline']]) {
    const result = await invoke(['canvas', 'apply', '--ops', JSON.stringify([{ op, slotId: 'slot' }])], fake.env)
    expect(result).toMatchObject({ code: 2, value: { error: { code: 'invalid_params' } } })
    expect(result.value.error.message.endsWith(`See guide "${topic}".`)).toBe(true)
  }
  const result = await invoke(['canvas', 'apply', '--params', JSON.stringify({ requestId: 42, ops: [
    { op: 'script.replace', slotId: 'slot', expectedRevision: 1, doc: { shots: [], assets: [] } },
  ] })], fake.env)
  expect(result.value.error.message).not.toContain('See guide')
  expect(fake.requests).toEqual([])
})

it('business errors preserve revision conflict details and request IDs', async () => {
  const conflicts = [{ slotId: 's', expectedRevision: 1, currentRevision: 2 }]
  const details = { reason: 'script.revision_conflict', params: { currentRows: JSON.stringify([{ kind: 'shot', id: 'one', current: { id: 'one', rev: 2 } }]) } }
  const fake = await server(() => ({ error: { code: -32000, message: 'Conflict', data: { code: 'revision_conflict', conflicts, ...details } } }))
  expect(await invoke(['canvas', 'apply', '--request-id', 'r', '--ops', '[{"op":"slot.clear","slotId":"s","expectedRevision":1}]'], fake.env))
    .toMatchObject({ code: 1, value: { requestId: 'r', error: { code: 'revision_conflict', message: 'Conflict', conflicts, ...details } } })
})

it('wait repeats long polling until completion', async () => {
  let count = 0
  const fake = await server(() => ({ result: { jobId: 'j', status: ++count < 3 ? 'running' : 'succeeded', outputs: [], targets: [] } }))
  expect(await invoke(['gen', 'wait', 'j'], fake.env)).toMatchObject({ code: 0, value: { status: 'succeeded' } })
  expect(count).toBe(3)
  expect(fake.requests.slice(1).every(r => r.method === 'generation.get' && (r.params as { waitMs: number }).waitMs === 30000)).toBe(true)
})

it('wait treats cancellation as terminal', async () => {
  const fake = await server(() => ({ result: { jobId: 'j', status: 'cancelled', outputs: [], targets: [], providerCancelled: false } }))
  expect(await invoke(['gen', 'wait', 'j'], fake.env)).toMatchObject({ code: 0, value: { status: 'cancelled', providerCancelled: false } })
  expect(fake.requests).toHaveLength(2)
})

it('the overall wait timeout aborts in-flight requests and outputs the last result', async () => {
  let count = 0
  const fake = await server(() => ++count === 1 ? { result: { jobId: 'j', status: 'running', outputs: [], targets: [] } } : undefined)
  expect(await invoke(['gen', 'wait', 'j', '--timeout-ms', '50'], fake.env)).toMatchObject({ code: 3, value: { status: 'running' } })
})

it('missing environment variables are usage errors; a nonexistent socket returns unavailable', async () => {
  expect(await invoke(['canvas', 'get'])).toMatchObject({ code: 2 })
  expect(await invoke(['canvas', 'get'], { VIS_SOCKET: process.platform === 'win32' ? `\\\\.\\pipe\\vis-missing-${randomUUID()}` : join(tmpdir(), 'vis-does-not-exist', 'socket'), VIS_AGENT_TOKEN: 't' })).toMatchObject({ code: 1, value: { error: { code: 'unavailable' } } })
})

it('help does not require a connection', async () => {
  expect((await invoke(['--help'])).stdout).toContain('vis gen submit')
  expect((await invoke(['canvas', 'get', '--help'])).stdout).toContain('vis canvas get')
})

it('list and describe aliases use the capability table', async () => {
  const fake = await server(() => ({ result: {} }))
  await invoke(['list'], fake.env)
  for (const name of [['canvas.apply'], ['canvas', 'apply'], ['canvas apply']]) await invoke(['describe', ...name], fake.env)
  expect(fake.requests[1]?.method).toBe('capabilities.list')
  expect(fake.requests.filter(r => r.method === 'capabilities.describe').map(r => r.params)).toEqual(Array(3).fill({ method: 'canvas.apply' }))
})

it('the client handles close, timeout, rpc_error, and split responses', async () => {
  const fake = await server((request, socket) => {
    if (request.method === 'close') socket.destroy()
    if (request.method === 'error') return { error: { code: -32601, message: 'missing' } }
    if (request.method === 'split') {
      const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\n'
      socket.write(response.slice(0, 12))
      setTimeout(() => socket.write(response.slice(12)), 5)
    }
    return undefined
  })
  const open = () => connect({ socketPath: fake.env.VIS_SOCKET, credential: { kind: 'agent', token: 'secret' }, timeoutMs: 100 })
  const client = await open()
  await expect(client.call('invalid', { n: 1n })).rejects.toMatchObject({ code: 'invalid_params' })
  await expect(client.call('split', {})).resolves.toEqual({ ok: true })
  await expect(client.call('error', {})).rejects.toMatchObject({ code: 'rpc_error' })
  await expect(client.call('close', {})).rejects.toMatchObject({ code: 'unavailable' })
  const other = await open()
  await expect(other.call('hang', {})).rejects.toMatchObject({ code: 'unavailable' })
  other.close()
})

it('canvas apply accepts nodes without coordinates, metadata, and inputs shorthand', async () => {
  const fake = await server(() => ({ result: { placements: { n: { x: 0, y: 0, w: 320, h: 200 } } } }))
  const ops = [{ op: 'node.create', tempId: 'n', kind: 'text', category: '文案', purpose: 'artifact', format: 'markdown', inputs: ['source'] }, { op: 'node.setMeta', nodeId: 'n', category: null }]
  const result = await invoke(['canvas', 'apply', '--ops', JSON.stringify(ops)], fake.env)
  expect(result.code).toBe(0)
  expect(result.value.placements.n).toMatchObject({ x: 0, y: 0 })
  expect(fake.requests[1]).toMatchObject({ params: { ops: [{ inputNodeIds: ['source'], category: '文案', format: 'markdown' }, ops[1]] } })
})
