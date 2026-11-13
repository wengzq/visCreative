import { extensionPosition } from '@vis/canvas-ui'
import type { MethodResult, NodeView, SceneProposal } from '@vis/protocol'
import type { SceneEditorHost } from '@vis/scene-ui'
import { formatter, messagesFor, useLocale, useMessages, type Locale } from '@vis/ui-kit'
import { lazy, Suspense, useMemo } from 'react'
import { actionMessages } from './messages'
import { registerSceneDraft, resolveSceneProposal } from './scene-proposals'
import { RpcError } from './rpc'
import { sceneHostMessages } from './scene-messages'
import type { SpaceConnection } from './space'

export type ScenePanelTarget = { nodeId: string; panelId: string }
type Options = {
  conn: SpaceConnection
  node: NodeView
  nodes: readonly NodeView[]
  locale: Locale
  proposals?: readonly SceneProposal[] | undefined
  initialProposalId?: string | undefined
  updateProposals?: ((proposals: SceneProposal[]) => void) | undefined
  initialViewId?: string | undefined
  initialTarget?: ScenePanelTarget | undefined
  close(): void
}

const SceneEditor = lazy(async () => {
  const editor = await import('@vis/scene-ui')
  await import('@vis/scene-ui/scene.css')
  return { default: editor.SceneEditor }
})
const pendingRenders = new WeakMap<SpaceConnection, Map<string, string>>()

export function sceneEditorHost(options: Options): SceneEditorHost {
  const { conn, node, nodes, locale } = options
  const spaceId = conn.getView().space!.spaceId
  const token = encodeURIComponent(conn.token)
  const m = messagesFor(actionMessages, locale)
  const sm = messagesFor(sceneHostMessages, locale)
  const f = formatter(locale)
  const assertProject = () => {
    if (!conn.getView().ready || conn.getView().space?.spaceId !== spaceId) throw new Error(m.projectChanged)
  }
  const call = async <T,>(method: string, params: unknown): Promise<T> => {
    assertProject()
    const result = await conn.rpc.call<T>(method, params)
    assertProject()
    return result
  }
  const upload = async (blob: Blob, name: string, kind: 'image' | 'model') => {
    assertProject()
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    assertProject()
    const response = await fetch(`/upload?t=${token}&space=${encodeURIComponent(spaceId)}&name=${encodeURIComponent(name)}&requestId=scene-${kind}-${hash}&contentHash=${hash}`, { method: 'POST', body: blob })
    const data = await response.json()
    assertProject()
    if (!response.ok) throw new RpcError(data.error?.code ?? 'unavailable', data.error?.message ?? `HTTP ${response.status}`, data.error?.data)
    const asset = data as MethodResult<'asset.import'>
    if (asset.kind !== kind) throw new Error(kind === 'image' ? sm.imageOnly : sm.modelOnly)
    return asset.assetVersionId
  }
  return {
    node, nodes,
    proposals: options.proposals ?? [],
    ...(options.initialProposalId ? { initialProposalId: options.initialProposalId } : {}),
    sessionName: id => conn.getView().state.sessions.get(id)?.title,
    registerDraft: handle => registerSceneDraft(conn, node.slots.find(slot => slot.slotKey === 'main')!.slotId, handle),
    async resolveProposal(action, changes) {
      const slotId = node.slots.find(slot => slot.slotKey === 'main')!.slotId
      const proposals = await resolveSceneProposal(conn, spaceId, locale, slotId, action, changes)
      options.updateProposals?.(proposals)
    },
    ...(options.initialViewId ? { initialViewId: options.initialViewId } : {}),
    ...(options.initialTarget ? { initialTarget: options.initialTarget } : {}),
    assetUrl: id => `/assets/${encodeURIComponent(spaceId)}/${encodeURIComponent(id)}?t=${token}`,
    upload: (blob, name) => upload(blob, name, 'image'),
    async importModel(file) {
      assertProject()
      if (!file.name.toLowerCase().endsWith('.glb')) throw new Error(sm.modelOnly)
      return upload(file, file.name, 'model')
    },
    async listModels() {
      const result = await call<MethodResult<'model.list'>>('model.list', {})
      return result.models.map((model, index) => ({ assetVersionId: model.assetVersionId, name: model.displayName ?? sm.model(f.number(index + 1)) }))
    },
    async commit(doc, expectedRevision) {
      assertProject()
      const slot = conn.getView().state.nodes.get(node.nodeId)?.slots.find(slot => slot.slotKey === 'main')
      if (!slot || slot.content.type !== 'scene') throw new Error(m.nodeDeleted)
      try {
        await call('canvas.apply', { requestId: `scene-set-${crypto.randomUUID()}`, ops: [{ op: 'scene.set', slotId: slot.slotId, expectedRevision, doc }] })
        return 'ok'
      } catch (error) {
        if (error instanceof RpcError && error.code === 'revision_conflict') {
          await conn.refreshNodes([node.nodeId])
          assertProject()
          return 'conflict'
        }
        throw error
      }
    },
    async saveImage(assetVersionId, name) {
      assertProject()
      const current = conn.getView().state.nodes.get(node.nodeId)
      if (!current) throw new Error(m.nodeDeleted)
      await call('canvas.apply', { requestId: `scene-image-${crypto.randomUUID()}`, ops: [{
        op: 'node.create', tempId: 'image', kind: 'image', title: (name || sm.scene).slice(0, 60),
        ...extensionPosition(current, 'image', [...conn.getView().state.nodes.values()]),
        inputNodeIds: [node.nodeId], content: { assetVersionId },
      }] })
    },
    async renderVideo({ viewId, revision, width, height, fps, prompt }) {
      assertProject()
      const current = conn.getView().state.nodes.get(node.nodeId)
      const slot = current?.slots.find(slot => slot.slotKey === 'main')
      if (!slot || slot.content.type !== 'scene') throw new Error(m.nodeDeleted)
      let pending = pendingRenders.get(conn)
      if (!pending) { pending = new Map(); pendingRenders.set(conn, pending) }
      const signature = JSON.stringify({ spaceId, nodeId: node.nodeId, revision, viewId, width, height, fps, prompt })
      const requestId = pending.get(signature) ?? `scene-video-${crypto.randomUUID()}`
      // A lost reply retries the same job even if a canvas event recreated the editor host.
      pending.set(signature, requestId)
      await call('generation.submit', {
        requestId,
        provider: 'render', model: 'scene', kind: 'video', prompt,
        inputs: [{ slotId: slot.slotId, revision }],
        params: { viewId, width, height, fps },
        targets: [{ outputIndex: 0, kind: 'new_node', nearNodeId: node.nodeId }],
      })
      pending.delete(signature)
    },
    async sendToPanel(target, source) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await call<MethodResult<'canvas.get'>>('canvas.get', { nodeIds: [target.nodeId] })
        const slot = result.nodes.find(node => node.nodeId === target.nodeId)?.slots.find(slot => slot.slotKey === 'main')
        if (!slot || slot.content.type !== 'previz') throw new Error(m.nodeDeleted)
        const doc = slot.content.doc
        if (!doc.panels.some(panel => panel.id === target.panelId)) throw new Error(sm.panelMissing)
        const next = {
          ...doc, rev: doc.rev + 1,
          panels: doc.panels.map(panel => panel.id === target.panelId ? {
            ...panel, rev: panel.rev + 1, blockout: source.assetVersionId,
            sceneRef: { sceneNodeId: node.nodeId, viewId: source.viewId, sceneRev: source.sceneRev },
          } : panel),
        }
        try {
          await call('canvas.apply', { requestId: `scene-panel-${crypto.randomUUID()}`, ops: [{ op: 'previz.set', slotId: slot.slotId, expectedRevision: slot.revision, doc: next }] })
          return
        } catch (error) {
          if (attempt === 0 && error instanceof RpcError && error.code === 'revision_conflict') continue
          throw error
        }
      }
    },
    lastWriter() {
      if (conn.getView().space?.spaceId !== spaceId) return undefined
      const writer = conn.getView().state.nodes.get(node.nodeId)?.slots.find(slot => slot.slotKey === 'main')?.writer
      return writer?.actor === 'agent' && writer.sessionId ? conn.getView().state.sessions.get(writer.sessionId)?.title : undefined
    },
    onClose: options.close,
  }
}

export function SceneEditorMount(options: Omit<Options, 'locale'>) {
  const { locale } = useLocale()
  const m = useMessages(sceneHostMessages)
  const { conn, node, nodes, initialViewId, initialTarget, initialProposalId, proposals, updateProposals, close } = options
  const host = useMemo(() => sceneEditorHost({ conn, node, nodes, locale, initialViewId, initialTarget, initialProposalId, proposals, updateProposals, close }), [conn, node, nodes, locale, initialViewId, initialTarget, initialProposalId, proposals, updateProposals, close])
  return <Suspense fallback={<div className="app-scene-loading" role="dialog" aria-modal="true" aria-label={m.scene} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') close() }}><p role="status">{m.loading}</p><button autoFocus onClick={close}>{m.close}</button></div>}>
    <SceneEditor host={host} />
  </Suspense>
}
