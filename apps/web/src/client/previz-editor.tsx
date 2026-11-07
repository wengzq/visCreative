import { PrevizEditor, type PrevizEditorHost } from '@vis/previz-ui'
import type { MethodResult, NodeView } from '@vis/protocol'
import { messagesFor, useLocale, type Locale } from '@vis/ui-kit'
import { useMemo } from 'react'
import { actionMessages } from './messages'
import { RpcError } from './rpc'
import type { SpaceConnection } from './space'

export function previzEditorHost(options: { conn: SpaceConnection; node: NodeView; nodes: readonly NodeView[]; locale: Locale; close(): void }): PrevizEditorHost {
  const { conn, node, nodes, locale } = options
  const spaceId = conn.getView().space!.spaceId
  const token = encodeURIComponent(conn.token)
  const assertProject = () => {
    if (!conn.getView().ready || conn.getView().space?.spaceId !== spaceId) throw new Error(messagesFor(actionMessages, locale).projectChanged)
  }
  return {
    node, nodes,
    assetUrl: id => `/assets/${encodeURIComponent(spaceId)}/${encodeURIComponent(id)}?t=${token}`,
    async upload(blob, name) {
      assertProject()
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('')
      // The content hash makes retries independent of staging paths while keeping readable library names.
      const response = await fetch(`/upload?t=${token}&space=${encodeURIComponent(spaceId)}&name=${encodeURIComponent(name)}&requestId=previz-${hash}&contentHash=${hash}`, { method: 'POST', body: blob })
      const data = await response.json()
      if (!response.ok) throw new RpcError(data.error?.code ?? 'unavailable', data.error?.message ?? `HTTP ${response.status}`, data.error?.data)
      assertProject()
      const asset = data as MethodResult<'asset.import'>
      if (asset.kind !== 'image') throw new Error('Previz pictures require an image')
      return asset.assetVersionId
    },
    async commit(doc, expectedRevision) {
      assertProject()
      const slot = conn.getView().state.nodes.get(node.nodeId)?.slots.find(slot => slot.slotKey === 'main')
      if (!slot) throw new Error(messagesFor(actionMessages, locale).nodeDeleted)
      try {
        await conn.rpc.call('canvas.apply', { requestId: `previz-set-${crypto.randomUUID()}`, ops: [{ op: 'previz.set', slotId: slot.slotId, expectedRevision, doc }] })
        return 'ok'
      } catch (error) {
        if (error instanceof RpcError && error.code === 'revision_conflict') { await conn.refreshNodes([node.nodeId]); return 'conflict' }
        throw error
      }
    },
    lastWriter() {
      const writer = conn.getView().state.nodes.get(node.nodeId)?.slots.find(slot => slot.slotKey === 'main')?.writer
      return writer?.actor === 'agent' && writer.sessionId ? conn.getView().state.sessions.get(writer.sessionId)?.title : undefined
    },
    onClose: options.close,
  }
}

export function PrevizEditorMount({ conn, node, nodes, close, render, initialPanelId, openScene }: { render(): void; initialPanelId?: string | undefined; conn: SpaceConnection; node: NodeView; nodes: readonly NodeView[]; close(): void; openScene(sceneNodeId: string, viewId: string, panelId: string): void }) {
  const { locale } = useLocale()
  const host = useMemo(() => previzEditorHost({ conn, node, nodes, locale, close }), [conn, node, nodes, locale, close])
  return <PrevizEditor host={{ ...host, initialPanelId, onRender: render, onOpenScene: openScene }} />
}
