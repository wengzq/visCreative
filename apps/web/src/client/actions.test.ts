import { EMPTY_SCENE, ScriptDocInput, type JobView, type NodeView, type SceneDoc } from '@vis/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canvasActions } from './actions'
import { RpcError } from './rpc'
import type { SpaceConnection } from './space'

function setup(nodes: unknown[][]) {
  const call = vi.fn(async (method: string, _params?: unknown) => {
    if (method === 'canvas.get') return { nodes: nodes.shift() }
    if (method === 'canvas.apply') return { idMap: { n: 'new-node', 'copy-0': 'new-0', 'copy-1': 'new-1' }, eventSeq: 1 }
    return { jobId: 'job' }
  })
  const notify = vi.fn()
  const actions = canvasActions({ rpc: { call }, getView: () => ({ space: { spaceId: 'project' }, ready: true, state: { seq: 1 } }) } as unknown as SpaceConnection, notify)
  return { actions, call, notify }
}

describe('Canvas reference input actions', () => {
  it('duplicates the entire scene document into the new main slot', async () => {
    const doc: SceneDoc = {
      ...EMPTY_SCENE, rev: 3,
      objects: [{
        id: 'bench', name: 'Bench', source: { type: 'prop', propId: 'bench' }, createdBy: 'user', userTouched: true, hidden: false,
        transform: { position: [2, 0, 1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      }],
      views: [{
        id: 'wide', name: 'Wide', still: 'still', aspectRatio: '16:9',
        camera: { position: [4, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 },
      }],
    }
    const source = {
      nodeId: 'scene', kind: 'scene', title: 'Stage', x: 10, y: 20, w: 360, h: 280,
      slots: [{ slotKey: 'main', content: { type: 'scene', doc } }],
    } as NodeView
    const { actions, call } = setup([])
    expect(await actions.onClone!([source], { x: 500, y: 50 })).toEqual(['new-0'])
    expect(call).toHaveBeenCalledExactlyOnceWith('canvas.apply', expect.objectContaining({ ops: [
      expect.objectContaining({ op: 'node.create', tempId: 'copy-0', kind: 'scene', x: 500, y: 50 }),
      { op: 'scene.set', slotId: 'copy-0:main', expectedRevision: 1, doc },
    ] }))
  })

  it.each(['drop', 'reference'])('creates only the image node in an image and GLB %s batch', async mode => {
    const fetch = vi.fn(async (_url, options: RequestInit) => ({
      ok: true,
      json: async () => (options.body as File).name.endsWith('.glb')
        ? { kind: 'model', assetVersionId: 'model' }
        : { kind: 'image', assetVersionId: 'image', width: 640, height: 480 },
    }))
    vi.stubGlobal('fetch', fetch)
    const { actions, call, notify } = setup([[{ nodeId: 'target', x: 100, y: 200, inputs: ['previous'] }]])
    const files = [new File(['image'], 'reference.png'), new File(['glb'], 'prop.glb')]
    if (mode === 'drop') actions.onDropFiles(files, { x: 0, y: 0 })
    else await actions.onUploadReference!('target', files)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(call.mock.calls.filter(([method]) => method === 'canvas.apply')).toHaveLength(1))
    const ops = (call.mock.calls.find(([method]) => method === 'canvas.apply')![1] as { ops: any[] }).ops
    expect(ops.filter(op => op.op === 'node.create')).toEqual([
      expect.objectContaining({ kind: 'image', content: { assetVersionId: 'image' } }),
    ])
    if (mode === 'reference') expect(ops.at(-1)).toEqual({ op: 'node.setInputs', nodeId: 'target', inputNodeIds: ['previous', 'reference-0'] })
    expect(notify).toHaveBeenCalledExactlyOnceWith({ kind: 'info', text: expect.stringContaining('prop.glb') })
  })

  it('creates a standalone scene at the requested canvas position', async () => {
    const { actions, call } = setup([])
    expect(await actions.onCreateScene!({ x: 120, y: -40 })).toBe('new-node')
    expect(call).toHaveBeenCalledWith('canvas.apply', expect.objectContaining({ ops: [{ op: 'node.create', tempId: 'n', kind: 'scene', x: 120, y: -40 }] }))
  })
  it('generation reads the latest backend prompt and ordered reference main slots, pinning their revisions', async () => {
    const { actions, call } = setup([
      [{ nodeId: 'gen', kind: 'image', inputs: ['text', 'image'], slots: [
        { slotKey: 'main', slotId: 'output', revision: 0, content: { type: 'empty' } },
        { slotKey: 'prompt', slotId: 'prompt', revision: 4, content: { type: 'text', body: '已保存的提示词' } },
      ] }],
      [{ nodeId: 'image', slots: [{ slotKey: 'main', slotId: 'image-main', revision: 3, content: { type: 'asset', assetVersionId: 'a', mime: 'image/png' } }] },
        { nodeId: 'text', slots: [{ slotKey: 'main', slotId: 'text-main', revision: 2, content: { type: 'text', body: '参考文字' } }] }],
    ])
    await actions.onGenerate('gen', { provider: 'ark', model: 'ep-image', params: { size: '4K' } })
    expect(call.mock.calls).toMatchObject([
      ['canvas.get', { nodeIds: ['gen'] }],
      ['canvas.get', { nodeIds: ['text', 'image'] }],
      ['generation.submit', { provider: 'ark', model: 'ep-image', params: { size: '4K' }, prompt: '已保存的提示词', inputs: [
        { slotId: 'prompt', revision: 4 }, { slotId: 'text-main', revision: 2 }, { slotId: 'image-main', revision: 3 },
      ], targets: [{ outputIndex: 0, kind: 'slot', slotId: 'output' }] }],
    ])
  })

  it('generation skips references without content', async () => {
    const { actions, call } = setup([
      [{ nodeId: 'gen', kind: 'image', inputs: ['pending', 'blank', 'text'], slots: [
        { slotKey: 'main', slotId: 'output', revision: 0, content: { type: 'empty' } },
        { slotKey: 'prompt', slotId: 'prompt', revision: 1, content: { type: 'text', body: '提示词' } },
      ] }],
      [{ nodeId: 'pending', slots: [{ slotKey: 'main', slotId: 'pending-main', revision: 0, content: { type: 'empty' } }] },
        { nodeId: 'blank', slots: [{ slotKey: 'main', slotId: 'blank-main', revision: 1, content: { type: 'text', body: '  ' } }] },
        { nodeId: 'text', slots: [{ slotKey: 'main', slotId: 'text-main', revision: 2, content: { type: 'text', body: '参考文字' } }] }],
    ])
    await actions.onGenerate('gen')
    expect(call.mock.calls[2]).toEqual(['generation.submit', expect.objectContaining({
      inputs: [{ slotId: 'prompt', revision: 1 }, { slotId: 'text-main', revision: 2 }],
    })])
  })

  it('extending left creates text in the same batch and preserves the latest existing references', async () => {
    const { actions, call } = setup([[{ nodeId: 'gen', inputs: ['existing'] }]])
    expect(await actions.onExtend('gen', 'text', { x: -400, y: 20 })).toBe('new-node')
    expect(call.mock.calls[1]).toMatchObject(['canvas.apply', { ops: [
      { op: 'node.create', tempId: 'n', kind: 'text', x: -400, y: 20, content: { text: '' } },
      { op: 'node.setInputs', nodeId: 'gen', inputNodeIds: ['existing', 'n'] },
    ] }])
  })

  it('extending right binds the source when creating the generation node', async () => {
    const { actions, call } = setup([[{ nodeId: 'source' }]])
    expect(await actions.onExtend('source', 'video', { x: 400, y: 20 })).toBe('new-node')
    expect(call.mock.calls[1]).toMatchObject(['canvas.apply', { ops: [
      { op: 'node.create', tempId: 'n', kind: 'video', w: 320, h: 180, prompt: '', inputNodeIds: ['source'] },
    ] }])
  })

  it('multiple references create a generation node in the same batch and preserve all inputs', async () => {
    const { actions, call } = setup([])
    expect(await actions.onExtendReferences(['first', 'second'], 'image', { x: 800, y: 40 })).toBe('new-node')
    expect(call.mock.calls).toMatchObject([['canvas.apply', { ops: [
      { op: 'node.create', tempId: 'n', kind: 'image', x: 800, y: 40, prompt: '', inputNodeIds: ['first', 'second'] },
    ] }]])
  })

  it('a deleted source prevents orphan node creation and shows an error', async () => {
    const { actions, call, notify } = setup([[]])
    await expect(actions.onExtend('missing', 'image', { x: 0, y: 0 })).rejects.toThrow('节点已删除')
    expect(call).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: '延伸节点失败：节点已删除' })
  })
})

describe('Batch canvas edits and code rendering', () => {
  const code = { nodeId: 'code', kind: 'text', format: 'code', generation: { provider: 'render', model: 'html', params: { width: 64, height: 64, fps: 1, durationMs: 1000 } }, slots: [
    { slotKey: 'main', slotId: 'code-main', revision: 5, content: { type: 'text', body: '<html>最新代码</html>' } },
  ] }
  const video = { nodeId: 'result', kind: 'video', slots: [
    { slotKey: 'main', slotId: 'result-main', revision: 8, content: { type: 'asset', assetVersionId: 'old', mime: 'video/mp4' }, source: { jobId: 'old-job', inputNodeIds: ['code'] } },
  ] }

  it('batch edits preserve operations and undo descriptions; failures notify and propagate', async () => {
    const { actions, call, notify } = setup([])
    const ops = [{ op: 'node.setMeta' as const, nodeId: 'node', category: '人物' }]
    await actions.onApply!(ops, '设置类别')
    expect(call).toHaveBeenCalledWith('canvas.apply', { requestId: expect.any(String), ops, description: '设置类别' })
    call.mockRejectedValueOnce(new Error('Offline'))
    await expect(actions.onApply!(ops)).rejects.toThrow('Offline')
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: '更新画布失败：Offline' })
  })

  it('the code main slot comes first; valid reference revisions are pinned in order and a linked video is created', async () => {
    const { actions, call } = setup([[
      { ...code, inputs: ['asset', 'missing', 'empty', 'blank', 'text', 'asset', 'code'] },
      { nodeId: 'text', slots: [{ slotKey: 'main', slotId: 'text-main', revision: 2, content: { type: 'text', body: '参考文案' } }] },
      { nodeId: 'asset', slots: [{ slotKey: 'main', slotId: 'asset-main', revision: 3, content: { type: 'asset', assetVersionId: 'asset', mime: 'image/png' } }] },
      { nodeId: 'empty', slots: [{ slotKey: 'main', slotId: 'empty-main', revision: 0, content: { type: 'empty' } }] },
      { nodeId: 'blank', slots: [{ slotKey: 'main', slotId: 'blank-main', revision: 1, content: { type: 'text', body: ' ' } }] },
    ]])
    expect(await actions.onRenderCode!('code', 'stable-request')).toEqual({ jobId: 'job', revision: 5 })
    expect(call.mock.calls).toEqual([
      ['canvas.get', {}],
      ['generation.submit', {
        requestId: 'stable-request', provider: 'render', model: 'html', kind: 'video', prompt: '渲染代码节点 code',
        inputs: [{ slotId: 'code-main', revision: 5 }, { slotId: 'asset-main', revision: 3 }, { slotId: 'text-main', revision: 2 }],
        params: code.generation.params,
        targets: [{ outputIndex: 0, kind: 'new_node', nearNodeId: 'code' }],
      }],
    ])
  })

  it('reuses only the source-linked video main slot and includes the freshly read target revision', async () => {
    const { actions, call } = setup([[
      code,
      { ...video, nodeId: 'other', slots: [{ ...video.slots[0], source: { jobId: 'other-job', inputNodeIds: ['other-code'] } }] },
      { ...video, nodeId: 'image', kind: 'image' },
      { ...video, nodeId: 'reference', inputs: ['code'], slots: [{ ...video.slots[0], source: undefined }] },
      video,
    ]])
    await actions.onRenderCode!('code', 'render')
    expect(call).toHaveBeenLastCalledWith('generation.submit', expect.objectContaining({
      targets: [{ outputIndex: 0, kind: 'slot', slotId: 'result-main', expectedRevision: 8 }],
    }))
  })

  it('after submission failure, the same request reuses the first snapshot; new requests reread code and targets', async () => {
    const updated = { ...code, slots: [{ ...code.slots[0], revision: 6 }] }
    const { actions, call, notify } = setup([[code], [updated, video]])
    const original = call.getMockImplementation()!
    let submitted = false
    call.mockImplementation(async (method, params) => {
      if (method === 'generation.submit' && !submitted) { submitted = true; throw new Error('Acknowledgment lost') }
      return original(method, params)
    })
    await expect(actions.onRenderCode!('code', 'retry')).rejects.toThrow('Acknowledgment lost')
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: '渲染失败：Acknowledgment lost' })
    expect(await actions.onRenderCode!('code', 'retry')).toEqual({ jobId: 'job', revision: 5 })
    expect(await actions.onRenderCode!('code', 'next')).toEqual({ jobId: 'job', revision: 6 })
    const submits = call.mock.calls.filter(([method]) => method === 'generation.submit')
    expect(submits[1]).toEqual(submits[0])
    expect(submits[2]).toEqual(['generation.submit', expect.objectContaining({ requestId: 'next',
      inputs: [{ slotId: 'code-main', revision: 6 }],
      targets: [{ outputIndex: 0, kind: 'slot', slotId: 'result-main', expectedRevision: 8 }],
    })])
    expect(call.mock.calls.filter(([method]) => method === 'canvas.get')).toHaveLength(2)
  })

  it('retries after rebuilding the actions object still reuse the original request snapshot, but other projects do not', async () => {
    let nodes: unknown[] = [code]
    let projectId = 'project'
    let submitted = false
    const call = vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'canvas.get') return { nodes }
      if (!submitted) { submitted = true; throw new Error('Acknowledgment lost') }
      return { jobId: 'job' }
    })
    const notify = vi.fn()
    const conn = { rpc: { call }, getView: () => ({ space: { spaceId: projectId }, ready: true }) } as unknown as SpaceConnection
    await expect(canvasActions(conn, notify).onRenderCode!('code', 'retry')).rejects.toThrow('Acknowledgment lost')
    nodes = [{ ...code, slots: [{ ...code.slots[0], revision: 6 }] }, video]
    expect(await canvasActions(conn, notify).onRenderCode!('code', 'retry')).toEqual({ jobId: 'job', revision: 5 })
    let submits = call.mock.calls.filter(([method]) => method === 'generation.submit')
    expect(submits[1]).toEqual(submits[0])
    expect(call.mock.calls.filter(([method]) => method === 'canvas.get')).toHaveLength(1)
    projectId = 'other'
    expect(await canvasActions(conn, notify).onRenderCode!('code', 'retry')).toEqual({ jobId: 'job', revision: 6 })
    submits = call.mock.calls.filter(([method]) => method === 'generation.submit')
    expect(submits[2]).toEqual(['generation.submit', expect.objectContaining({
      inputs: [{ slotId: 'code-main', revision: 6 }],
      targets: [{ outputIndex: 0, kind: 'slot', slotId: 'result-main', expectedRevision: 8 }],
    })])
    expect(call.mock.calls.filter(([method]) => method === 'canvas.get')).toHaveLength(2)
  })

  it.each([
    [[], '节点已删除'],
    [[{ ...code, format: 'plain' }], '只能渲染代码节点'],
    [[{ ...code, kind: 'video' }], '只能渲染代码节点'],
    [[{ ...code, slots: [] }], '代码内容为空'],
    [[{ ...code, slots: [{ ...code.slots[0], content: { type: 'text', body: ' ' } }] }], '代码内容为空'],
  ])('invalid code nodes do not submit generation jobs: %s', async (nodes, message) => {
    const { actions, call, notify } = setup([nodes as unknown[]])
    await expect(actions.onRenderCode!('code', 'render')).rejects.toThrow(message as string)
    expect(call).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: `渲染失败：${message}` })
  })

  it('reads full state for successful or failed render jobs; query errors notify and propagate', async () => {
    const { actions, call, notify } = setup([])
    const job: JobView = { jobId: 'render', status: 'failed', outputs: [], targets: [], error: { code: 'render_failed', message: 'Missing window.vis' } }
    call.mockResolvedValueOnce(job)
    expect(await actions.onGetRenderJob!('render')).toBe(job)
    expect(call).toHaveBeenCalledWith('generation.get', { jobId: 'render' })
    call.mockRejectedValueOnce(new Error('Offline'))
    await expect(actions.onGetRenderJob!('render')).rejects.toThrow('Offline')
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: '查询渲染任务失败：Offline' })
  })

  it.each(['render', 'get', 'apply'])('switching projects while %s waits rejects the acknowledgment and stops further writes', async kind => {
    let resolve!: (value: unknown) => void
    let projectId = 'original'
    const call = vi.fn(() => new Promise(resolvePending => { resolve = resolvePending }))
    const notify = vi.fn()
    const actions = canvasActions({ rpc: { call }, getView: () => ({ space: { spaceId: projectId }, ready: true }) } as unknown as SpaceConnection, notify)
    const pending = kind === 'render' ? actions.onRenderCode!('code', 'render') : kind === 'get' ? actions.onGetRenderJob!('render') : actions.onApply!([{ op: 'node.setMeta', nodeId: 'code', purpose: 'working' }])
    projectId = 'other'
    resolve({ nodes: [code], jobId: 'render' })
    await expect(pending).rejects.toThrow('项目已切换')
    expect(call).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('项目已切换') }))
  })
})


describe('Copying nodes', () => {
  it('copies script documents with fresh row ids, remapped references, and server-assigned prompt state', async () => {
    const source: NodeView = {
      nodeId: 'script', kind: 'script', x: 0, y: 0, w: 480, h: 320, z: 1, layoutRevision: 1, title: 'Storyboard',
      slots: [{ slotId: 'script-main', slotKey: 'main', contentType: 'script', revision: 4, content: { type: 'script', doc: {
        version: 1, rev: 3, style: 'Ink', sessionId: 'writer',
        shots: [{ id: 'shot_one', rev: 8, description: '{{asset:hero}} enters', transition: 'cut', sceneId: 'room', characterIds: ['hero'], propIds: ['key'], framePrompt: '{{asset:hero}} {{ref:image}}', promptState: 'stale' }],
        assets: [
          { id: 'hero', rev: 2, kind: 'character', name: 'Hero', description: '{{asset:room}}', imageNodeId: 'image' },
          { id: 'room', rev: 1, kind: 'scene', name: 'Room', description: 'Hall', imageNodeId: 'external' },
          { id: 'key', rev: 1, kind: 'prop', name: 'Key', description: 'Brass' },
        ],
      } } }],
    }
    const image: NodeView = { nodeId: 'image', kind: 'image', x: 600, y: 0, w: 320, h: 320, z: 2, layoutRevision: 1, slots: [] }
    const original = structuredClone(source)
    const { actions, call } = setup([])
    await actions.onClone!([source, image], { x: 0, y: 500 })
    const ops = (call.mock.calls[0]![1] as any).ops
    const replacement = ops.find((op: any) => op.op === 'script.replace')
    expect(replacement).toBeDefined()
    expect(replacement).toMatchObject({ slotId: 'copy-0:main', expectedRevision: 1 })
    const doc = ScriptDocInput.parse(replacement.doc)
    expect(doc).toMatchObject({ style: 'Ink', sessionId: 'writer' })
    const [hero, room, key] = doc.assets
    expect(hero).toMatchObject({ description: `{{asset:${room!.tempId}}}`, imageNodeId: 'copy-1' })
    expect(room!.imageNodeId).toBe('external')
    expect(doc.shots[0]).toMatchObject({
      description: `{{asset:${hero!.tempId}}} enters`, sceneId: room!.tempId, characterIds: [hero!.tempId], propIds: [key!.tempId],
      framePrompt: `{{asset:${hero!.tempId}}} {{ref:copy-1}}`,
    })
    // Replacement assigns prompt ownership on the server; copied stale/edited state is not writable input.
    expect(doc.shots[0]).not.toHaveProperty('promptState')
    expect(source).toEqual(original)
    expect(ops.slice(0, 2).every((op: any) => op.op === 'node.create')).toBe(true)
  })
  it('a single batch creates all nodes before binding internal and external references, preserving content, size, and relative position', async () => {
    const { actions, call } = setup([])
    const nodes = [
      { nodeId: 'gen', kind: 'image', x: 500, y: 80, w: 300, h: 280, inputs: ['text', 'external'], generation: { provider: 'ark', model: 'image', params: { size: '4K' } }, slots: [
        { slotKey: 'main', content: { type: 'asset', assetVersionId: 'asset', mime: 'image/png' } },
        { slotKey: 'prompt', content: { type: 'text', body: '提示词' } },
      ] },
      { nodeId: 'text', kind: 'text', x: 100, y: 40, w: 320, h: 200, slots: [{ slotKey: 'main', content: { type: 'text', body: '参考' } }] },
    ] as unknown as NodeView[]
    expect(await actions.onClone(nodes, { x: 900, y: 300 })).toEqual(['new-0', 'new-1'])
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]).toMatchObject(['canvas.apply', { ops: [
      { op: 'node.create', tempId: 'copy-0', kind: 'image', x: 1300, y: 340, w: 300, h: 280, content: { assetVersionId: 'asset' }, prompt: '提示词', generation: { provider: 'ark', model: 'image', params: { size: '4K' } } },
      { op: 'node.create', tempId: 'copy-1', kind: 'text', x: 900, y: 300, w: 320, h: 200, content: { text: '参考' } },
      { op: 'node.setInputs', nodeId: 'copy-0', inputNodeIds: ['copy-1', 'external'] },
    ] }])
  })

  it('generation nodes with cleared prompts retain the prompt slot', async () => {
    const { actions, call } = setup([])
    await actions.onClone([{ nodeId: 'empty', kind: 'video', x: 0, y: 0, w: 320, h: 280, slots: [
      { slotKey: 'main', content: { type: 'empty' } }, { slotKey: 'prompt', content: { type: 'empty' } },
    ] }] as NodeView[], { x: 40, y: 40 })
    expect(call.mock.calls[0]).toMatchObject(['canvas.apply', { ops: [
      { op: 'node.create', kind: 'video', prompt: '', x: 40, y: 40 },
    ] }])
  })

  it('empty clipboards send no request; batch failures notify the user and remain failed', async () => {
    const { actions, call, notify } = setup([])
    expect(await actions.onClone([], { x: 0, y: 0 })).toEqual([])
    expect(call).not.toHaveBeenCalled()
    call.mockRejectedValueOnce(new Error('Node deleted'))
    await expect(actions.onClone([{ nodeId: 'empty', kind: 'image', x: 0, y: 0, w: 320, h: 320, slots: [] }] as unknown as NodeView[], { x: 0, y: 0 })).rejects.toThrow('Node deleted')
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: '复制节点失败：Node deleted' })
  })
})

describe('Version history actions', () => {
  const source: NodeView = {
    nodeId: 'source', kind: 'image', x: 0, y: 0, w: 460, h: 260, z: 1, layoutRevision: 1, inputs: ['reference'], generation: { provider: 'ark', model: 'image', params: { size: '4K' } },
    slots: [
      { slotId: 'main', slotKey: 'main', revision: 4, contentType: 'image', content: { type: 'asset', assetVersionId: 'current', mime: 'image/png' } },
      { slotId: 'prompt', slotKey: 'prompt', revision: 2, contentType: 'text', content: { type: 'text', body: '当前提示词' } },
    ],
  }

  it('restoration uses historical assets and current revision conditions, preserving other node state', async () => {
    const { actions, call } = setup([])
    expect(await actions.onRestoreVersion!('main', 'historical', 4, 2)).toBe('ok')
    expect(call.mock.calls).toEqual([['canvas.apply', {
      requestId: expect.any(String), description: '恢复版本 v2',
      ops: [{ op: 'slot.setAsset', slotId: 'main', assetVersionId: 'historical', expectedRevision: 4 }],
    }]])
  })

  it('restore conflicts notify and refresh history without automatically retrying writes', async () => {
    const call = vi.fn().mockRejectedValue(new RpcError('revision_conflict', 'changed'))
    const loadHistory = vi.fn().mockResolvedValue(undefined)
    const notify = vi.fn()
    const actions = canvasActions({ rpc: { call }, loadHistory, getView: () => ({ space: { spaceId: 'project' }, ready: true }) } as unknown as SpaceConnection, notify)
    expect(await actions.onRestoreVersion!('main', 'historical', 4, 2)).toBe('conflict')
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: '节点内容刚更新，请重新选择' })
    expect(loadHistory).toHaveBeenCalledWith('main', true)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('read failures after conflicts preserve the conflict result; ordinary restore errors propagate', async () => {
    const call = vi.fn().mockRejectedValueOnce(new RpcError('revision_conflict', 'changed')).mockRejectedValueOnce(new Error('Offline'))
    const loadHistory = vi.fn().mockRejectedValue(new Error('Offline'))
    const notify = vi.fn()
    const actions = canvasActions({ rpc: { call }, loadHistory, getView: () => ({ space: { spaceId: 'project' }, ready: true }) } as unknown as SpaceConnection, notify)
    expect(await actions.onRestoreVersion!('main', 'historical', 4, 2)).toBe('conflict')
    expect(notify).toHaveBeenLastCalledWith({ kind: 'error', text: '读取版本历史失败：Offline' })
    await expect(actions.onRestoreVersion!('main', 'historical', 4, 2)).rejects.toThrow('Offline')
    expect(notify).toHaveBeenLastCalledWith({ kind: 'error', text: '恢复版本失败：Offline' })
  })

  it.each(['image', 'video'] as const)('saving %s separately preserves type, size, the specified asset, and generation settings without copying prompts or inputs', async kind => {
    const { actions, call } = setup([])
    expect(await actions.onSaveVersion!({ ...source, kind }, 'historical', 2, { x: 560, y: 20 })).toBe('new-node')
    expect(call.mock.calls).toEqual([['canvas.apply', {
      requestId: expect.any(String), description: '另存版本 v2',
      ops: [{ op: 'node.create', tempId: 'n', kind, x: 560, y: 20, w: 460, h: 260, content: { assetVersionId: 'historical' }, generation: source.generation }],
    }]])
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('Node generation settings', () => {
  const recent = { provider: 'ark', model: 'recent', params: { size: '1K' } }
  const saved = { provider: 'mock', model: 'old', params: { n: 2 } }

  it('full replacement or reset saves through canvas.apply; errors notify the user', async () => {
    const { actions, call, notify } = setup([])
    await actions.onSetGeneration!('node', saved)
    await actions.onSetGeneration!('node', undefined)
    expect(call.mock.calls).toMatchObject([
      ['canvas.apply', { ops: [{ op: 'node.setGeneration', nodeId: 'node', generation: saved }] }],
      ['canvas.apply', { ops: [{ op: 'node.setGeneration', nodeId: 'node' }] }],
    ])
    call.mockRejectedValueOnce(new Error('offline'))
    await expect(actions.onSetGeneration!('node', saved)).rejects.toThrow('offline')
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: '保存生成设置失败：offline' })
  })

  it('when acknowledgments arrive first, settings saves wait until node events are applied', async () => {
    let seq = 1
    let changed!: () => void
    const stop = vi.fn()
    const call = vi.fn().mockResolvedValue({ idMap: {}, eventSeq: 2 })
    const actions = canvasActions({ rpc: { call }, getView: () => ({ space: { spaceId: 'project' }, ready: true, state: { seq } }), subscribe: (listener: () => void) => { changed = listener; return stop } } as unknown as SpaceConnection, vi.fn())
    const done = vi.fn()
    const saving = actions.onSetGeneration!('node', saved).then(done)
    await vi.waitFor(() => expect(changed).toBeDefined())
    changed()
    expect(done).not.toHaveBeenCalled()
    seq = 2
    changed()
    await saving
    expect(done).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
  })

  it.each(['switch', 'disconnect'])('%s ends settings-event waits and cleans up subscriptions', async reason => {
    let project = 'project'
    let status = 'open'
    let changed!: () => void
    const stop = vi.fn()
    const actions = canvasActions({ rpc: { call: vi.fn().mockResolvedValue({ idMap: {}, eventSeq: 2 }) }, getView: () => ({ space: { spaceId: project }, ready: true, state: { seq: 1 }, status }), subscribe: (listener: () => void) => { changed = listener; return stop } } as unknown as SpaceConnection, vi.fn())
    const saving = actions.onSetGeneration!('node', saved)
    await vi.waitFor(() => expect(changed).toBeDefined())
    if (reason === 'switch') project = 'other'
    else status = 'closed'
    const rejected = expect(saving).rejects.toThrow(reason === 'switch' ? '项目已切换' : '连接已断开')
    changed()
    await rejected
    expect(stop).toHaveBeenCalledOnce()
  })

  it('creation and cross-type or multiple-reference extensions use recent selections for the corresponding type; same-type extensions preserve source settings or defaults', async () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'vis.gen.last.image' ? JSON.stringify(recent) : null })
    const { actions, call } = setup([[{ nodeId: 'a', kind: 'image', generation: saved }], [{ nodeId: 'a', kind: 'image' }], [{ nodeId: 'video', kind: 'video', generation: saved }]])
    actions.onCreateGenNode('image', { x: 0, y: 0 })
    await actions.onExtend('a', 'image', { x: 10, y: 0 })
    await actions.onExtend('a', 'image', { x: 20, y: 0 })
    await actions.onExtend('video', 'image', { x: 30, y: 0 })
    await actions.onExtendReferences(['a', 'video'], 'image', { x: 40, y: 0 })
    const created = call.mock.calls.filter(([method]) => method === 'canvas.apply').map(([, params]) => (params as any).ops[0])
    expect(created.map(op => op.generation)).toEqual([recent, saved, undefined, recent, recent])
  })
})

describe('Canvas actions during project switching', () => {
  it.each(['extend', 'generate', 'upload'])('%s does not write to the new project after switching while waiting', async kind => {
    let resolve!: (value: any) => void
    const pending = new Promise(resolvePending => { resolve = resolvePending })
    let projectId = 'original'
    const call = vi.fn().mockReturnValue(pending)
    const notify = vi.fn()
    const actions = canvasActions({ rpc: { call }, token: 'token', getView: () => ({ space: { spaceId: projectId }, ready: true }) } as unknown as SpaceConnection, notify)
    if (kind === 'upload') {
      const fetch = vi.fn().mockReturnValue(pending)
      vi.stubGlobal('fetch', fetch)
      actions.onDropFiles([new File(['image'], 'image.png')], { x: 0, y: 0 })
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('space=original'), expect.anything())
      projectId = 'other'
      resolve({ ok: true, json: async () => ({ kind: 'image', assetVersionId: 'old-project-asset' }) })
      await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('项目已切换') })))
      expect(call).not.toHaveBeenCalled()
    } else {
      const result = kind === 'extend' ? actions.onExtend('node', 'image', { x: 0, y: 0 }) : actions.onGenerate('node')
      projectId = 'other'
      resolve({ nodes: [{ nodeId: 'node', kind: 'image', slots: [{ slotKey: 'main', slotId: 'main' }, { slotKey: 'prompt', slotId: 'prompt', revision: 1, content: { type: 'text', body: 'generate' } }] }] })
      await expect(result).rejects.toThrow('项目已切换')
      expect(call).toHaveBeenCalledTimes(1)
    }
  })
})

describe('Generation job controls', () => {
  const generationNode = { nodeId: 'node', kind: 'image', slots: [
    { slotKey: 'main', slotId: 'main', revision: 0, content: { type: 'empty' } },
    { slotKey: 'prompt', slotId: 'prompt', revision: 1, content: { type: 'text', body: '已保存提示词' } },
  ] }
  function generationSetup(status: JobView['status'] = 'failed') {
    const call = vi.fn(async (method: string): Promise<any> => method === 'canvas.get' ? { nodes: [generationNode] }
      : method === 'generation.get' ? { jobId: 'old', status, outputs: [], targets: [] }
        : { jobId: 'new', status: 'queued', bindings: [] })
    const dismissJobs = vi.fn()
    const notify = vi.fn()
    const view = { space: { spaceId: 'project' }, ready: true }
    const actions = canvasActions({ rpc: { call }, dismissJobs, getView: () => view } as unknown as SpaceConnection, notify)
    return { call, dismissJobs, notify, actions }
  }

  it('successive UI generations submit directly without quota confirmation or override parameters', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('window', { confirm })
    const { actions, call, notify } = generationSetup()
    await actions.onGenerate('node')
    await actions.onGenerate('node')
    const requests = call.mock.calls.filter(([method]) => method === 'generation.submit') as unknown as [string, Record<string, unknown>][]
    expect(requests).toHaveLength(2)
    expect(requests[0]![1]).not.toHaveProperty('overrideQuota')
    expect(requests[1]![1]).not.toHaveProperty('overrideQuota')
    expect(requests[1]![1].requestId).not.toBe(requests[0]![1].requestId)
    expect(confirm).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it.each([
    new RpcError('quota_exceeded', 'quota', { kind: 'image', count: 50, limit: 50 }),
    new RpcError('quota_exceeded', 'invalid quota', { kind: 'video' }),
    new Error('Offline'),
  ])('submission failures preserve error notices and do not retry: %s', async error => {
    const { actions, call, notify } = generationSetup()
    const original = call.getMockImplementation()!
    call.mockImplementation(method => method === 'generation.submit' ? Promise.reject(error) : original(method))
    await expect(actions.onGenerate('node')).rejects.toBe(error)
    expect(call.mock.calls.filter(([method]) => method === 'generation.submit')).toHaveLength(1)
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: `生成失败：${error.message}` })
  })

  it.each(['failed', 'cancelled', 'succeeded'] as const)('%s regeneration shows no unknown-result warning and closes the original notice on completion', async status => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('window', { confirm })
    const { actions, call, dismissJobs } = generationSetup(status)
    await actions.onRegenerate!('old')
    expect(confirm).not.toHaveBeenCalled()
    expect(call).toHaveBeenLastCalledWith('generation.regenerate', { jobId: 'old', requestId: expect.any(String) })
    expect(dismissJobs).toHaveBeenCalledWith(['old'])
  })

  it.each([true, false])('unknown regenerates only after explicit confirmation=%s', async confirmed => {
    const confirm = vi.fn(() => confirmed)
    vi.stubGlobal('window', { confirm })
    const { actions, call, dismissJobs } = generationSetup('unknown')
    await actions.onRegenerate!('old')
    expect(confirm).toHaveBeenCalledWith('上一次可能已在服务端生成并计费，确定重新生成？')
    expect(call.mock.calls.filter(([method]) => method === 'generation.regenerate')).toHaveLength(confirmed ? 1 : 0)
    expect(dismissJobs).toHaveBeenCalledTimes(confirmed ? 1 : 0)
  })

  it('regeneration failures preserve the original notice and report errors without automatic retries', async () => {
    const { actions, call, dismissJobs, notify } = generationSetup()
    const original = call.getMockImplementation()!
    call.mockImplementation(method => method === 'generation.regenerate' ? Promise.reject(new Error('Offline')) : original(method))
    await expect(actions.onRegenerate!('old')).rejects.toThrow('Offline')
    expect(call.mock.calls.filter(([method]) => method === 'generation.regenerate')).toHaveLength(1)
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: '重新生成失败：Offline' })
    expect(dismissJobs).not.toHaveBeenCalled()
  })

  it('repeated cancel clicks share one request; failures report errors and allow retry', async () => {
    let reject!: (error: Error) => void
    const { actions, call, notify } = generationSetup()
    call.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const first = actions.onCancelGeneration!('job')
    const second = actions.onCancelGeneration!('job')
    expect(first).toBe(second)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('generation.cancel', { jobId: 'job', requestId: expect.any(String) })
    reject(new Error('Offline'))
    await expect(first).rejects.toThrow('Offline')
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: '取消生成失败：Offline' })
    await actions.onCancelGeneration!('job')
    expect(call).toHaveBeenCalledTimes(2)
  })
})


it('new and multiple-reference videos use uniform 16:9 default dimensions', async () => {
  const { actions, call } = setup([])
  actions.onCreateGenNode('video', { x: 0, y: 0 })
  await actions.onExtendReferences(['source'], 'video', { x: 400, y: 0 })
  expect(call.mock.calls.filter(([method]) => method === 'canvas.apply')).toHaveLength(2)
  for (const [, params] of call.mock.calls) expect(params).toMatchObject({ ops: [{ kind: 'video', w: 320, h: 180 }] })
})

describe('English canvas actions', () => {
  it('switching language while an upload waits uses the current language on failure', async () => {
    let locale: 'zh-CN' | 'en' = 'zh-CN'
    let reject!: (error: Error) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((_, fail) => { reject = fail })))
    const call = vi.fn()
    const notify = vi.fn()
    const actions = canvasActions({ rpc: { call }, token: 'token', getView: () => ({ space: { spaceId: 'project' }, ready: true }) } as unknown as SpaceConnection, notify, () => locale)
    actions.onDropFiles([new File(['image'], '设计.png')], { x: 0, y: 0 })
    locale = 'en'
    reject(new Error('Network offline'))
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith({ kind: 'error', text: 'Import 设计.png failed: Network offline' }))
    expect(call).not.toHaveBeenCalled()
  })

  it('switching language while a canvas request waits uses the current language for the failed action name and error', async () => {
    let locale: 'zh-CN' | 'en' = 'zh-CN'
    let reject!: (error: Error) => void
    const call = vi.fn().mockReturnValue(new Promise((_, fail) => { reject = fail }))
    const notify = vi.fn()
    const actions = canvasActions({ rpc: { call }, getView: () => ({ space: { spaceId: 'project' }, ready: true }) } as unknown as SpaceConnection, notify, () => locale)
    const pending = actions.onLayout('node', { x: 0, y: 0, w: 320, h: 200 })
    locale = 'en'
    // english-exempt: Chinese backend diagnostic fixture verifies English locale fallback.
    const error = new RpcError('unavailable', '连接已断开')
    reject(error)
    await expect(pending).rejects.toBe(error)
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: 'Move failed: Temporarily unavailable' })
  })

  it('language switching does not combine old action descriptions with failure notices in the new language', async () => {
    let locale: 'zh-CN' | 'en' = 'zh-CN'
    let reject!: (error: Error) => void
    const call = vi.fn().mockReturnValue(new Promise((_, fail) => { reject = fail }))
    const notify = vi.fn()
    const actions = canvasActions({ rpc: { call }, getView: () => ({ space: { spaceId: 'project' }, ready: true }) } as unknown as SpaceConnection, notify, () => locale)
    const pending = actions.onApply!([], '调整节点大小')
    locale = 'en'
    // english-exempt: Chinese backend diagnostic fixture verifies English locale fallback.
    const error = new RpcError('unavailable', '连接已断开')
    reject(error)
    await expect(pending).rejects.toBe(error)
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: 'Update canvas failed: Temporarily unavailable' })
    expect(call).toHaveBeenCalledWith('canvas.apply', expect.objectContaining({ description: '调整节点大小' }))
  })

  it('structured error codes translate failure notices while preserving the original exception', async () => {
    // english-exempt: Chinese backend diagnostic fixture verifies structured-code localization.
    const error = new RpcError('rpc_error', '已达到今日额度', { code: 'quota_exceeded' })
    const call = vi.fn().mockRejectedValue(error)
    const notify = vi.fn()
    const actions = canvasActions({ rpc: { call }, getView: () => ({ space: { spaceId: 'project' }, ready: true }) } as unknown as SpaceConnection, notify, 'en')
    await expect(actions.onApply!([])).rejects.toBe(error)
    expect(notify).toHaveBeenCalledWith({ kind: 'error', text: "Update canvas failed: Today's quota has been reached" })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it.each([
    // english-exempt: Chinese upload error fixture verifies English structured-code fallback.
    { code: 'quota_exceeded', message: '已达到今日额度' },
    // english-exempt: Nested Chinese upload error fixture verifies English structured-code fallback.
    { code: 'rpc_error', message: '已达到今日额度', data: { code: 'quota_exceeded' } },
  ])('uploads preserve flat or nested error data for English notices: %j', async error => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error }) }))
    const call = vi.fn()
    const notify = vi.fn()
    const actions = canvasActions({ rpc: { call }, token: 'token', getView: () => ({ space: { spaceId: 'project' }, ready: true }) } as unknown as SpaceConnection, notify, 'en')
    actions.onDropFiles([new File(['image'], '设计.png')], { x: 0, y: 0 })
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith({ kind: 'error', text: "Import 设计.png failed: Today's quota has been reached" }))
    expect(call).not.toHaveBeenCalled()
  })
})
