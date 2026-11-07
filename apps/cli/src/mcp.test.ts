import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasOp, GuideTopic, listCapabilities, METHODS, PROTOCOL_VERSION, type RpcRequest } from '@vis/protocol'
import { createMcpServer, serveMcp } from './mcp'
import { NODE_CREATE_EXAMPLE } from './param-errors'
import { createCanvasService } from '../../../packages/canvas/core/src/service'
import { openSpaceDb } from '../../../packages/storage/src/index'

const cleanup: (() => void)[] = []
afterEach(() => { for (const c of cleanup.splice(0)) c() })

/** Fake studiod: passes requests to handler after the handshake */
async function studiod(handler: (r: RpcRequest) => object) {
  const dir = mkdtempSync(join(tmpdir(), 'vis-mcp-'))
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\vis-test-${randomUUID()}` : join(dir, 's.sock')
  const requests: RpcRequest[] = []
  const server: Server = createServer(socket => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const req = JSON.parse(buffer.slice(0, nl)) as RpcRequest
        buffer = buffer.slice(nl + 1)
        requests.push(req)
        const res = req.method === 'runtime.hello'
          ? { result: { protocolVersion: PROTOCOL_VERSION, studiodVersion: 't', runtimeEpoch: 'e' } }
          : handler(req)
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, ...res })}\n`)
      }
    })
  })
  await new Promise<void>(r => server.listen(socketPath, r))
  cleanup.push(() => { server.close(); rmSync(dir, { recursive: true, force: true }) })
  return { requests, env: { VIS_SOCKET: socketPath, VIS_AGENT_TOKEN: 'tok' } }
}

const call = (name: string, args: unknown, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
const textOf = (res: any) => JSON.parse(res.result.content[0].text)

describe('vis mcp', () => {
  it('initialize negotiates the version; tools/list comes from the capability table, omits the capability catalog, and makes requestId optional', async () => {
    const server = createMcpServer({})
    expect(await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }))
      .toMatchObject({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'vis' } } })
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined()

    const { result } = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as any
    const names = result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['canvas_get', 'canvas_apply', 'gen_submit', 'gen_get', 'asset_get', 'slot_history', 'session_set_title']))
    expect(names).not.toContain('session_rename')
    expect(names).not.toContain('session_reset_title')
    expect(names).toContain('asset_import_file')
    expect(names).toEqual(expect.arrayContaining(['asset_list', 'asset_label', 'library_state']))
    expect(names).not.toContain('asset_update')
    expect(names).not.toContain('library_runRevert')
    expect(names).not.toContain('space_create')
    expect(names.some((name: string) => name.startsWith('fs_'))).toBe(false)
    const setTitle = result.tools.find((t: { name: string }) => t.name === 'session_set_title')
    expect(setTitle.inputSchema.required).toEqual(['title'])
    expect(setTitle.inputSchema.properties).not.toHaveProperty('sessionId')
    expect(names.some((n: string) => n.startsWith('capabilities'))).toBe(false)
    expect(names.every((n: string) => /^[a-zA-Z0-9_]+$/.test(n))).toBe(true)
    const apply = result.tools.find((t: { name: string }) => t.name === 'canvas_apply')
    expect(apply.inputSchema.properties).toHaveProperty('ops')
    expect(apply.inputSchema.required).not.toContain('requestId')
    expect(apply.description).toContain('expectedRevision')
    const submit = result.tools.find((t: { name: string }) => t.name === 'gen_submit')
    expect(submit.inputSchema.properties.kind.enum).toEqual(['image', 'video', 'audio'])
    expect(submit.inputSchema.properties).not.toHaveProperty('overrideQuota')
  })

  it('tools/call forwards to studiod, generating and returning requestId automatically', async () => {
    const fake = await studiod(r => ({ result: { jobId: 'job_1', status: 'queued', bindings: [], echo: r.params } }))
    const server = createMcpServer(fake.env)
    const out = textOf(await server.handle(call('gen_submit', { kind: 'image', prompt: '屋顶花园' })))
    expect(fake.requests.map(r => r.method)).toEqual(['runtime.hello', 'generation.submit'])
    expect(out).toMatchObject({ jobId: 'job_1', requestId: expect.any(String) })
    expect(out.echo.requestId).toBe(out.requestId)
    server.close()
  })

  it('guide is listed and forwards the index and each topic without an idempotency ID', async () => {
    const topics = GuideTopic.options.map(topic => ({ topic, title: `${topic} guide`, when: `Read before ${topic} work.` }))
    const fake = await studiod(request => {
      if (request.method === 'capabilities.list') return { result: { capabilities: listCapabilities('agent') } }
      const { topic } = request.params as { topic?: string }
      return { result: { topics, ...(topic ? { guide: { topic, title: `${topic} guide`, body: `# ${topic}` } } : {}) } }
    })
    const server = createMcpServer(fake.env)
    cleanup.push(() => server.close())
    const listed = await server.handle({ id: 1, method: 'tools/list' }) as any
    const guide = listed.result.tools.find((tool: { name: string }) => tool.name === 'guide')
    expect(guide).toMatchObject({ name: 'guide', inputSchema: { properties: { topic: { enum: GuideTopic.options } } } })
    expect(guide.inputSchema.required ?? []).not.toContain('topic')
    expect(textOf(await server.handle(call('guide', {})))).toEqual({ topics })
    for (const topic of GuideTopic.options) {
      expect(textOf(await server.handle(call('guide', { topic })))).toEqual({ topics, guide: { topic, title: `${topic} guide`, body: `# ${topic}` } })
    }
    expect(fake.requests.slice(2).map(request => ({ method: request.method, params: request.params }))).toEqual([
      { method: 'guide.get', params: {} },
      ...GuideTopic.options.map(topic => ({ method: 'guide.get', params: { topic } })),
    ])
    const requestsBeforeInvalid = fake.requests.length
    const invalid = await server.handle(call('guide', { topic: 'unknown' })) as any
    expect(invalid.result.isError).toBe(true)
    expect(textOf(invalid)).toMatchObject({ error: { code: 'invalid_params' } })
    expect(fake.requests).toHaveLength(requestsBeforeInvalid)
  })

  it('work tools are available to all agents; the gateway checks workspace hierarchy and UI capabilities are not exposed', async () => {
    const fake = await studiod(() => ({ result: { capabilities: listCapabilities('agent') } }))
    const server = createMcpServer(fake.env)
    const result = await server.handle({ id: 1, method: 'tools/list' }) as any
    const names = result.result.tools.map((tool: { name: string }) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['work_list', 'work_get', 'work_report', 'work_dispatch', 'work_review', 'work_reply', 'work_recall', 'work_activate']))
    for (const tool of ['work_delete', 'work_deletePlan', 'work_create', 'work_update', 'work_move', 'work_reopen', 'work_submitReview', 'work_inbox']) expect(names).not.toContain(tool)
    server.close()
  })

  it('work_report forwards output references and returns an idempotency ID; gateway rejection preserves forbidden', async () => {
    const fake = await studiod(request => request.method === 'work.report'
      ? { result: { messageId: 'wmsg_done' } }
      : { error: { code: -32000, message: 'Only root workspaces can dispatch', data: { code: 'forbidden' } } })
    const server = createMcpServer(fake.env)
    const refs = { nodeIds: ['node_1'], assetVersionIds: ['asset_1'] }
    const result = textOf(await server.handle(call('work_report', { kind: 'done', body: '已完成并验证', refs })))
    expect(result).toEqual({ messageId: 'wmsg_done', requestId: expect.any(String) })
    expect(fake.requests[1]).toMatchObject({ method: 'work.report', params: { requestId: result.requestId, kind: 'done', body: '已完成并验证', refs } })
    const rejected = await server.handle(call('work_dispatch', { title: '分镜', brief: '完成三张分镜', agentKind: 'codex' })) as any
    expect(rejected.result.isError).toBe(true)
    expect(textOf(rejected)).toMatchObject({ error: { code: 'forbidden' }, requestId: expect.any(String) })
    server.close()
  })

  it('slot_history forwards a read-only call, preserving the cursor and providing a default page size', async () => {
    const fake = await studiod(() => ({ result: { versions: [], hasMore: false } }))
    const server = createMcpServer(fake.env)
    expect(textOf(await server.handle(call('slot_history', { slotId: 's', beforeRevision: 3 })))).toEqual({ versions: [], hasMore: false })
    expect(fake.requests[1]).toMatchObject({ method: 'slot.history', params: { slotId: 's', limit: 50, beforeRevision: 3 } })
    expect(fake.requests[1]!.params).not.toHaveProperty('requestId')
    server.close()
  })

  it('asset_import_file preserves local paths and automatically provides an idempotency request ID', async () => {
    const fake = await studiod(() => ({ result: { assetVersionId: 'version_1' } }))
    const server = createMcpServer(fake.env)
    const result = textOf(await server.handle(call('asset_import_file', { path: '/project/workspaces/shot/成片.mp4' })))
    expect(result).toEqual({ assetVersionId: 'version_1', requestId: expect.any(String) })
    expect(fake.requests[1]).toMatchObject({ method: 'asset.importFile', params: { path: '/project/workspaces/shot/成片.mp4', requestId: result.requestId } })
    server.close()
  })

  it('audio generation accepts reference slots; import and reads preserve duration, MIME, and generation source', async () => {
    const asset = { assetVersionId: 'audio_1', assetId: 'asset_1', version: 1, kind: 'audio', mime: 'audio/wav', durationMs: 2000, url: 'file:///audio.wav' }
    const source = { jobId: 'job_1', prompt: '雨滴音效', provider: 'mock', model: 'mock-sfx-1', params: { duration: 2 }, inputNodeIds: [] }
    const history = { versions: [{ revision: 1, content: { type: 'asset', assetVersionId: 'audio_1', mime: 'audio/wav' }, createdAt: 1, actor: 'agent', isCurrent: true, source }], hasMore: false }
    const fake = await studiod(request => ({ result: request.method === 'generation.submit'
      ? { jobId: 'job_1', status: 'queued', bindings: [] }
      : request.method === 'slot.history' ? history : asset }))
    const server = createMcpServer(fake.env)
    const inputs = [{ slotId: 'audio_slot', revision: 1 }]
    expect(textOf(await server.handle(call('gen_submit', { kind: 'audio', prompt: '雨滴音效', inputs, params: { duration: 2 } })))).toMatchObject({ jobId: 'job_1' })
    expect(fake.requests[1]).toMatchObject({ method: 'generation.submit', params: { kind: 'audio', inputs, params: { duration: 2 } } })
    expect(textOf(await server.handle(call('asset_import_file', { path: '/project/audio.wav' })))).toMatchObject(asset)
    expect(textOf(await server.handle(call('asset_get', { assetVersionId: 'audio_1' })))).toEqual(asset)
    expect(textOf(await server.handle(call('slot_history', { slotId: 'audio_slot' })))).toEqual(history)
    server.close()
  })

  it('local validation failures send no request; business errors return isError and preserve conflicts', async () => {
    const conflicts = [{ slotId: 'slot_1', expectedRevision: 0, currentRevision: 2 }]
    const fake = await studiod(() => ({ error: { code: -32000, message: 'Revision conflict', data: { code: 'revision_conflict', conflicts } } }))
    const server = createMcpServer(fake.env)
    const bad = await server.handle(call('canvas_apply', { ops: [] })) as any
    expect(bad.result.isError).toBe(true)
    expect(textOf(bad).error.code).toBe('invalid_params')
    expect(fake.requests).toHaveLength(0)

    const res = await server.handle(call('canvas_apply', { requestId: 'r1', ops: [{ op: 'slot.clear', slotId: 'slot_1', expectedRevision: 0 }] })) as any
    expect(res.result.isError).toBe(true)
    expect(textOf(res)).toEqual({ error: { code: 'revision_conflict', message: 'Revision conflict', conflicts }, requestId: 'r1' })
    server.close()
  })

  it('returns unavailable when studiod is unavailable; unknown methods return -32601', async () => {
    const server = createMcpServer({ VIS_SOCKET: '/nonexistent/vis.sock', VIS_AGENT_TOKEN: 't' })
    expect(textOf(await server.handle(call('canvas_get', {}))).error.code).toBe('unavailable')
    expect(await server.handle({ jsonrpc: '2.0', id: 9, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } })
  })

  it('stdio: reads line by line and returns -32700 on parse failure', async () => {
    const lines: string[] = []
    async function* input() {
      yield '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{oops\n'
      yield '{"jsonrpc":"2.0","id":2,"meth'
      yield 'od":"ping"}'
    }
    await serveMcp({}, input(), l => lines.push(l))
    const msgs = lines.map(l => JSON.parse(l))
    expect(msgs).toEqual(expect.arrayContaining([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} },
      expect.objectContaining({ id: null, error: expect.objectContaining({ code: -32700 }) }),
    ]))
  })
})

it('node tools expose metadata, omitted coordinates, and inputs shorthand; validation follows mapping', async () => {
  const fake = await studiod(r => ({ result: { echo: r.params } }))
  const server = createMcpServer(fake.env)
  const ops = [{ op: 'node.create', tempId: 'n', kind: 'text', category: ' 文案 ', purpose: 'working', format: 'code', inputs: ['source'] }, { op: 'node.setMeta', nodeId: 'n', category: null }]
  const out = textOf(await server.handle(call('canvas_apply', { ops })))
  expect(out.echo.ops).toEqual([{ op: 'node.create', tempId: 'n', kind: 'text', category: '文案', purpose: 'working', format: 'code', inputNodeIds: ['source'] }, ops[1]])
  expect(textOf(await server.handle(call('canvas_apply', { ops: [{ ...ops[0], inputs: 'bad' }] }))).error.code).toBe('invalid_params')
  expect(textOf(await server.handle(call('canvas_apply', { ops: [{ ...ops[0], inputNodeIds: [] }] }))).error.code).toBe('invalid_params')
  const listed = await createMcpServer({}).handle({ id: 1, method: 'tools/list' }) as any
  const variants = listed.result.tools.find((t: any) => t.name === 'canvas_apply').inputSchema.properties.ops.items.oneOf
  const create = variants.find((v: any) => v.properties.op.const === 'node.create')
  expect(create.required).not.toContain('x')
  for (const key of ['inputs', 'inputNodeIds', 'category', 'purpose', 'format']) expect(create.properties).toHaveProperty(key)
  expect(variants.some((v: any) => v.properties.op.const === 'node.setMeta')).toBe(true)
  server.close()
})

it('a malformed node.create gets a readable error with the accepted shapes and an example', async () => {
  const fake = await studiod(r => ({ result: { echo: r.params } }))
  const server = createMcpServer(fake.env)
  // The shape a Codex session sent: no tempId and a text body under the slot.setText field name
  const error = textOf(await server.handle(call('canvas_apply', { ops: [{ op: 'node.create', kind: 'text', format: 'code', content: { body: '<html></html>' } }] }))).error
  expect(error.code).toBe('invalid_params')
  expect(error.message).not.toContain('invalid_type')
  expect(error.message).toContain('ops[0].tempId: ')
  expect(error.message).toMatch(/ops\[0\]\.content: must match one of: \(text: .+\) or \(assetVersionId: .+\)/)
  expect(error.message).toContain('"content":{"text":')
  expect(fake.requests).toHaveLength(0)
  server.close()
})

it('an unknown op names the accepted ops; unrelated node.create mistakes get no example', async () => {
  const fake = await studiod(r => ({ result: { echo: r.params } }))
  const server = createMcpServer(fake.env)
  const unknown = textOf(await server.handle(call('canvas_apply', { ops: [{ op: 'node.add', kind: 'text' }] }))).error.message
  // The list follows CanvasOp, so new ops appear without touching this test
  expect(unknown.split('\n')[0]).toBe(`ops[0].op: must be one of ${CanvasOp.options.map(o => o.shape.op.value).join(', ')}`)
  expect(unknown).toContain('node.create, ')
  expect(unknown).toContain('Example: ')
  const title = textOf(await server.handle(call('canvas_apply', { ops: [{ op: 'node.create', tempId: 'n', kind: 'text', title: 'x'.repeat(61) }] }))).error.message
  expect(title.startsWith('ops[0].title: ')).toBe(true)
  expect(title).not.toContain('Example: ')
  expect(fake.requests).toHaveLength(0)
  server.close()
})

it('invalid script and timeline operations point to their guides through MCP', async () => {
  const fake = await studiod(() => ({ result: {} }))
  const server = createMcpServer(fake.env)
  cleanup.push(() => server.close())
  for (const [op, topic] of [['script.replace', 'script'], ['script.patch', 'script'], ['timeline.set', 'timeline']]) {
    const result = await server.handle(call('canvas_apply', { ops: [{ op, slotId: 'slot' }] })) as any
    expect(result.result.isError).toBe(true)
    expect(textOf(result).error).toMatchObject({ code: 'invalid_params', message: expect.stringContaining(`See guide "${topic}".`) })
  }
  const unrelated = textOf(await server.handle(call('canvas_apply', { requestId: 42, ops: [
    { op: 'script.replace', slotId: 'slot', expectedRevision: 1, doc: { shots: [], assets: [] } },
  ] })))
  expect(unrelated.error.message).not.toContain('See guide')
  expect(fake.requests).toEqual([])
})

it('the node.create example in validation errors is valid against the contract', () => {
  expect(METHODS['canvas.apply'].params.safeParse({ requestId: 'r', ops: [JSON.parse(NODE_CREATE_EXAMPLE)] }).success).toBe(true)
})

it('script tools preserve row edits, shot links, and structured row conflict details', async () => {
  const rows = JSON.stringify([{ kind: 'shot', id: 'shot_1', current: { id: 'shot_1', rev: 2, description: 'Current' } }])
  const fake = await studiod(r => (r.params as { requestId?: string }).requestId === 'conflict'
    ? { error: { code: -32000, message: 'Script rows changed', data: { code: 'revision_conflict', reason: 'script.revision_conflict', params: { currentRows: rows } } } }
    : { result: { echo: r.params } })
  const server = createMcpServer(fake.env)
  const ops = [
    { op: 'node.create', tempId: 'script', kind: 'script', prompt: 'Break this down' },
    { op: 'script.replace', slotId: 'script:main', expectedRevision: 1, doc: { shots: [{ tempId: 'one', description: 'A still' }], assets: [] } },
    { op: 'script.patch', slotId: 'script:main', ops: [{ kind: 'shot.update', shotId: 'one', rev: 1, fields: { framePrompt: 'Still platform' } }] },
    { op: 'node.setMeta', nodeId: 'image', shot: { scriptNodeId: 'script', shotId: 'one', role: 'first' } },
  ]
  expect(textOf(await server.handle(call('canvas_apply', { ops }))).echo.ops).toEqual(ops)
  const result = textOf(await server.handle(call('canvas_apply', { requestId: 'conflict', ops: [ops[2]] })))
  expect(result.error).toMatchObject({ code: 'revision_conflict', reason: 'script.revision_conflict', params: { currentRows: rows } })
  server.close()
})

it('resolves script and shot tempIds in created and updated links through MCP', async () => {
  const db = openSpaceDb(':memory:')
  cleanup.push(() => db.$client.close())
  const canvas = createCanvasService({ db })
  const fake = await studiod(request => ({ result: request.method === 'canvas.apply'
    ? canvas.apply({ kind: 'user' }, request.params as Parameters<typeof canvas.apply>[1])
    : canvas.get(request.params as Parameters<typeof canvas.get>[0]) }))
  const server = createMcpServer(fake.env)
  cleanup.push(() => server.close())
  const result = textOf(await server.handle(call('canvas_apply', { ops: [
    { op: 'node.create', tempId: 'script', kind: 'script' },
    { op: 'script.replace', slotId: 'script:main', expectedRevision: 1, doc: { shots: [{ tempId: 'one', description: 'A still' }], assets: [] } },
    { op: 'node.create', tempId: 'image', kind: 'image', shot: { scriptNodeId: 'script', shotId: 'one', role: 'first' } },
    { op: 'node.create', tempId: 'video', kind: 'video' },
    { op: 'node.setMeta', nodeId: 'video', shot: { scriptNodeId: 'script', shotId: 'one', role: 'video' } },
  ] })))
  const { nodes } = textOf(await server.handle(call('canvas_get', { nodeIds: [result.idMap.image, result.idMap.video] })))
  expect(nodes.map((node: any) => node.shot)).toEqual([
    { scriptNodeId: result.idMap.script, shotId: result.idMap.one, role: 'first' },
    { scriptNodeId: result.idMap.script, shotId: result.idMap.one, role: 'video' },
  ])
})
