import { EMPTY_SCENE, emptyPrevizPanel, type NodeView, type PrevizDoc, type SceneDoc } from '@vis/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyState } from './store'
import { RpcError } from './rpc'
import { sceneEditorHost } from './scene-editor'
import type { SpaceConnection } from './space'

const sceneDoc: SceneDoc = { ...EMPTY_SCENE, rev: 5, views: [{
  id: 'wide', name: 'Wide', still: 'frame', aspectRatio: '16:9', createdBy: 'user', userTouched: false,
  camera: { position: [0, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 },
}] }
const scene: NodeView = { nodeId: 'scene', kind: 'scene', x: 0, y: 0, w: 360, h: 280, z: 1, layoutRevision: 1, slots: [
  { slotId: 'scene-main', slotKey: 'main', contentType: 'scene', revision: 8, content: { type: 'scene', doc: sceneDoc } },
] }
const previzDoc: PrevizDoc = {
  version: 1, rev: 3, aspectRatio: '16:9',
  panels: [{ ...emptyPrevizPanel('panel'), rev: 2, underlay: 'drawing-base', sketch: 'ink', image: 'drawing', blockout: 'old-frame', note: 'Keep the drawing', durationSec: 2 }],
}
function previz(doc = previzDoc, revision = 7): NodeView {
  return { nodeId: 'previz', kind: 'previz', x: 500, y: 0, w: 360, h: 280, z: 2, layoutRevision: 1, slots: [
    { slotId: 'previz-main', slotKey: 'main', contentType: 'previz', revision, content: { type: 'previz', doc } },
  ] }
}
function fixture() {
  const state = emptyState()
  state.nodes.set(scene.nodeId, scene)
  state.nodes.set('previz', previz())
  const view = { ready: true, space: { spaceId: 'project' }, state }
  const call = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === 'canvas.get') return { nodes: [view.state.nodes.get('previz')] }
    if (method === 'model.list') return { models: [{ assetVersionId: 'model-one', displayName: 'Chair' }, { assetVersionId: 'model-two' }] }
    return { idMap: { image: 'image' }, eventSeq: 1 }
  })
  const refreshNodes = vi.fn(async () => {})
  const conn = { getView: () => view, token: 'token /1', rpc: { call }, refreshNodes } as unknown as SpaceConnection
  const host = sceneEditorHost({ conn, node: scene, nodes: [scene, previz()], locale: 'en', close: vi.fn(), initialViewId: 'wide', initialTarget: { nodeId: 'previz', panelId: 'panel' } })
  return { host, call, view, refreshNodes }
}
const target = { nodeId: 'previz', panelId: 'panel' }
const source = { viewId: 'wide', assetVersionId: 'new-frame', sceneRev: 8 }
afterEach(() => vi.unstubAllGlobals())

describe('Scene editor host', () => {
  it('preselects a view and target without writing and uses authenticated asset URLs', () => {
    const { host, call } = fixture()
    expect(host.initialViewId).toBe('wide')
    expect(host.initialTarget).toEqual(target)
    expect(call).not.toHaveBeenCalled()
    expect(host.assetUrl('frame /1')).toBe('/assets/project/frame%20%2F1?t=token%20%2F1')
  })

  it('pins scene commits to the passed revision and refreshes a conflict', async () => {
    const { host, call, refreshNodes } = fixture()
    expect(await host.commit(sceneDoc, 8)).toBe('ok')
    expect(call).toHaveBeenCalledWith('canvas.apply', expect.objectContaining({ ops: [{ op: 'scene.set', slotId: 'scene-main', expectedRevision: 8, doc: sceneDoc }] }))
    call.mockRejectedValueOnce(new RpcError('revision_conflict', 'Stale revision'))
    expect(await host.commit(sceneDoc, 8)).toBe('conflict')
    expect(refreshNodes).toHaveBeenCalledWith(['scene'])
    call.mockRejectedValueOnce(new RpcError('unavailable', 'Disconnected'))
    await expect(host.commit(sceneDoc, 8)).rejects.toThrow('Disconnected')
  })

  it('saves a frame as an image with the scene as its input', async () => {
    const { host, call } = fixture()
    await host.saveImage('new-frame', 'Wide')
    expect(call).toHaveBeenCalledWith('canvas.apply', expect.objectContaining({ ops: [expect.objectContaining({
      op: 'node.create', kind: 'image', title: 'Wide', content: { assetVersionId: 'new-frame' }, inputNodeIds: ['scene'],
    })] }))
  })

  it('writes only the selected panel blockout and scene reference, preserving the drawing and metadata', async () => {
    const { host, call } = fixture()
    await host.sendToPanel(target, source)
    expect(call.mock.calls).toMatchObject([
      ['canvas.get', { nodeIds: ['previz'] }],
      ['canvas.apply', { ops: [{ op: 'previz.set', slotId: 'previz-main', expectedRevision: 7, doc: {
        ...previzDoc, rev: 4, panels: [{
          ...previzDoc.panels[0], rev: 3, blockout: 'new-frame',
          sceneRef: { sceneNodeId: 'scene', viewId: 'wide', sceneRev: 8 },
        }],
      } }] }],
    ])
  })

  it('renders the committed scene slot and selected camera to a new adjacent video node', async () => {
    const { host, call } = fixture()
    await host.renderVideo({ viewId: 'wide', revision: 8, width: 1920, height: 1080, fps: 24, prompt: 'Scene "Stage" · view "Wide"' })
    expect(call).toHaveBeenCalledExactlyOnceWith('generation.submit', {
      requestId: expect.any(String), provider: 'render', model: 'scene', kind: 'video', prompt: 'Scene "Stage" · view "Wide"',
      inputs: [{ slotId: 'scene-main', revision: 8 }],
      params: { viewId: 'wide', width: 1920, height: 1080, fps: 24 },
      targets: [{ outputIndex: 0, kind: 'new_node', nearNodeId: 'scene' }],
    })
  })

  it('retries an unacknowledged render idempotently and starts a fresh job on the next deliberate render', async () => {
    const { host, call } = fixture()
    const options = { viewId: 'wide', revision: 8, width: 1920, height: 1080, fps: 24 as const, prompt: 'Scene "Stage" · view "Wide"' }
    call.mockRejectedValueOnce(new RpcError('unavailable', 'Acknowledgment lost'))
    await expect(host.renderVideo(options)).rejects.toThrow('Acknowledgment lost')
    await host.renderVideo(options)
    await host.renderVideo(options)
    const ids = call.mock.calls.map(([, params]) => (params as { requestId: string }).requestId)
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
  })

  it('rereads once on a conflict and preserves newer panel edits and additional panels', async () => {
    const { host, call, view } = fixture()
    const newer: PrevizDoc = { ...previzDoc, rev: 4, panels: [{ ...previzDoc.panels[0]!, rev: 3, note: 'Changed elsewhere', underlay: 'new-underlay' }, emptyPrevizPanel('other-panel')] }
    call.mockImplementation(async (method: string) => {
      if (method === 'canvas.get') return { nodes: [view.state.nodes.get('previz')] }
      if (method === 'canvas.apply' && call.mock.calls.filter(([method]) => method === 'canvas.apply').length === 1) {
        view.state.nodes.set('previz', previz(newer, 8))
        throw new RpcError('revision_conflict', 'Stale revision')
      }
      return {}
    })
    await host.sendToPanel(target, source)
    expect(call.mock.calls.filter(([method]) => method === 'canvas.get')).toHaveLength(2)
    const writes = call.mock.calls.filter(([method]) => method === 'canvas.apply')
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject(['canvas.apply', { ops: [{
      expectedRevision: 8, doc: { ...newer, rev: 5, panels: [{
        ...newer.panels[0], rev: 4, blockout: 'new-frame', sceneRef: { sceneNodeId: 'scene', viewId: 'wide', sceneRev: 8 },
      }, newer.panels[1]] },
    }] }])
  })

  it('stops after a second conflict and does not retry other errors', async () => {
    const { host, call } = fixture()
    call.mockImplementation(async method => {
      if (method === 'canvas.get') return { nodes: [previz()] }
      throw new RpcError('revision_conflict', 'Still stale')
    })
    await expect(host.sendToPanel(target, source)).rejects.toThrow('Still stale')
    expect(call.mock.calls.filter(([method]) => method === 'canvas.apply')).toHaveLength(2)
    call.mockClear()
    call.mockRejectedValue(new RpcError('unavailable', 'Disconnected'))
    await expect(host.sendToPanel(target, source)).rejects.toThrow('Disconnected')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('does not write when the target panel is deleted', async () => {
    const { host, call, view } = fixture()
    view.state.nodes.set('previz', previz({ ...previzDoc, panels: [] }))
    await expect(host.sendToPanel(target, source)).rejects.toThrow('panel')
    expect(call.mock.calls.filter(([method]) => method === 'canvas.apply')).toHaveLength(0)
  })

  it('lists every model using the UI model listing method and localized fallback names', async () => {
    const { host, call } = fixture()
    expect(await host.listModels()).toEqual([{ assetVersionId: 'model-one', name: 'Chair' }, { assetVersionId: 'model-two', name: 'Model 2' }])
    expect(call).toHaveBeenCalledWith('model.list', {})
  })

  it('uses content-addressed image and model uploads and validates their returned kinds', async () => {
    const { host } = fixture()
    const upload = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => ({ kind: 'image', assetVersionId: 'frame' }) }))
    vi.stubGlobal('fetch', upload)
    expect(await host.upload(new Blob(['pixels'], { type: 'image/png' }), 'Wide.png')).toBe('frame')
    const url = new URL(String(upload.mock.calls[0]![0]), 'http://localhost')
    expect(url.searchParams.get('requestId')).toMatch(/^scene-image-[a-f0-9]{64}$/)
    expect(url.searchParams.get('contentHash')).toMatch(/^[a-f0-9]{64}$/)
    expect(url.searchParams.get('space')).toBe('project')
    upload.mockImplementation(async () => ({ ok: true, json: async () => ({ kind: 'model', assetVersionId: 'model' }) }))
    expect(await host.importModel(new File(['glTF'], 'Chair.glb'))).toBe('model')
    await expect(host.upload(new Blob(['pixels']), 'Wrong.png')).rejects.toThrow('image')
    await expect(host.importModel(new File(['{}'], 'Chair.gltf'))).rejects.toThrow('GLB')
  })

  it('rejects mutations and listing after the project changes', async () => {
    const { host, call, view } = fixture()
    view.space.spaceId = 'other'
    await expect(host.commit(sceneDoc, 8)).rejects.toThrow('project')
    await expect(host.saveImage('frame', 'Wide')).rejects.toThrow('project')
    await expect(host.sendToPanel(target, source)).rejects.toThrow('project')
    await expect(host.listModels()).rejects.toThrow('project')
    expect(call).not.toHaveBeenCalled()
  })
})
