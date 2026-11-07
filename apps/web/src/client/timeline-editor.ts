import type { CanvasActions } from '@vis/canvas-ui'
import type { MediaPreview, MethodResult, NodeView } from '@vis/protocol'
import type { TimelineEditorHost } from '@vis/timeline-ui'
import { messagesFor, type Locale } from '@vis/ui-kit'
import { useMemo, useRef } from 'react'
import type { SpaceConnection } from './space'
import { actionMessages } from './messages'
import { RpcError } from './rpc'

type AssetInfo = Awaited<ReturnType<TimelineEditorHost['assetInfo']>>
const metadata = new WeakMap<SpaceConnection, Map<string, Promise<AssetInfo>>>()

/** Retain the host's node selection when a canvas event only changes an unrelated node. */
export function useTimelineEditorNodes(node: NodeView | undefined, nodes: readonly NodeView[]): readonly NodeView[] {
  const previous = useRef<readonly NodeView[]>([])
  const sources = useRef({ nodeId: node?.nodeId, ids: new Set<string>() })
  return useMemo(() => {
    if (sources.current.nodeId !== node?.nodeId) sources.current = { nodeId: node?.nodeId, ids: new Set() }
    const content = node?.slots.find(slot => slot.slotKey === 'main')?.content
    // A retained local draft or its undo history can still reference sources removed by a remote edit.
    if (content?.type === 'timeline') for (const track of content.doc.tracks) for (const clip of track.clips) sources.current.ids.add(clip.source.nodeId)
    const selected = node ? nodes.filter(candidate => candidate.nodeId === node.nodeId || sources.current.ids.has(candidate.nodeId) ||
      ['video', 'audio', 'image'].includes(candidate.kind) || candidate.exportOf?.timelineNodeId === node.nodeId) : []
    if (selected.length === previous.current.length && selected.every((candidate, index) => candidate === previous.current[index])) return previous.current
    previous.current = selected
    return selected
  }, [node, nodes])
}

export function timelineEditorHost(options: {
  conn: SpaceConnection
  node: NodeView
  nodes: readonly NodeView[]
  actions: CanvasActions
  locale: Locale
  close(): void
  focus(nodeId: string): void
  upload(): void
}): TimelineEditorHost {
  const { conn, node, nodes, actions, locale } = options
  const spaceId = conn.getView().space!.spaceId
  const prefix = (assetVersionId: string) => `${encodeURIComponent(spaceId)}/${encodeURIComponent(assetVersionId)}`
  const token = encodeURIComponent(conn.token)
  const info = metadata.get(conn) ?? new Map<string, Promise<AssetInfo>>()
  metadata.set(conn, info)
  const assertProject = () => {
    if (!conn.getView().ready || conn.getView().space?.spaceId !== spaceId) throw new Error(messagesFor(actionMessages, locale).projectChanged)
  }
  const task = [...conn.getView().state.mediaTasks.values()].filter(task => task.nodeId === node.nodeId && task.operation === 'timeline.export').sort((a, b) => b.createdAt - a.createdAt)[0]
  return {
    node, nodes, exportTask: task,
    assetUrl: id => `/assets/${prefix(id)}?t=${token}`,
    filmstripUrl: id => `/previews/${prefix(id)}/filmstrip?t=${token}`,
    listFonts: async () => {
      assertProject()
      return (await conn.rpc.call<MethodResult<'font.list'>>('font.list', {})).fonts
    },
    fontUrl: font => 'builtin' in font ? `/fonts/${encodeURIComponent(font.builtin)}?t=${token}` : `/assets/${prefix(font.assetVersionId)}?t=${token}`,
    uploadFont: () => new Promise((resolve, reject) => {
      const picker = document.createElement('input')
      picker.type = 'file'
      picker.accept = '.ttf,.otf'
      picker.hidden = true
      document.body.append(picker)
      const clean = () => picker.remove()
      picker.addEventListener('cancel', () => { clean(); resolve(undefined) }, { once: true })
      picker.addEventListener('change', () => {
        const file = picker.files?.[0]
        clean()
        if (!file) { resolve(undefined); return }
        void (async () => {
          assertProject()
          const response = await fetch(`/upload?t=${token}&space=${encodeURIComponent(spaceId)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
          const data = await response.json()
          if (!response.ok) throw new RpcError(data.error?.code ?? 'unavailable', data.error?.message ?? `HTTP ${response.status}`, data.error?.data ?? data.error)
          assertProject()
          const asset = data as MethodResult<'asset.import'>
          if (asset.kind !== 'font' || !asset.fontFamily) throw new Error('The uploaded file is not a font')
          resolve({ font: { assetVersionId: asset.assetVersionId }, family: asset.fontFamily, label: asset.displayName ?? file.name })
        })().catch(reject)
      }, { once: true })
      picker.click()
    }),
    preview: async (assetVersionId, kind) => {
      assertProject()
      return conn.rpc.call<MediaPreview>('media.preview', { assetVersionId, kind })
    },
    assetInfo(assetVersionId) {
      assertProject()
      const key = `${spaceId}:${assetVersionId}`
      let pending = info.get(key)
      if (!pending) {
        pending = conn.rpc.call<MethodResult<'asset.get'>>('asset.get', { assetVersionId }).then(asset => ({
          kind: asset.kind, version: asset.version,
          ...(asset.durationMs !== undefined ? { durationMs: asset.durationMs } : {}),
          ...(asset.width !== undefined ? { width: asset.width } : {}),
          ...(asset.height !== undefined ? { height: asset.height } : {}),
          ...(asset.fps !== undefined ? { fps: asset.fps } : {}),
        })).catch(error => { info.delete(key); throw error })
        info.set(key, pending)
      }
      return pending
    },
    async commit(doc, expectedRevision) {
      assertProject()
      const slot = conn.getView().state.nodes.get(node.nodeId)?.slots.find(slot => slot.slotKey === 'main')
      if (!slot) throw new Error(messagesFor(actionMessages, locale).nodeDeleted)
      try {
        await actions.onApply!([{ op: 'timeline.set', slotId: slot.slotId, expectedRevision, doc }], messagesFor(actionMessages, locale).editTimeline)
        return 'ok'
      } catch (error) {
        if (error instanceof RpcError && error.code === 'revision_conflict') {
          await conn.refreshNodes([node.nodeId])
          return 'conflict'
        }
        throw error
      }
    },
    async export(expectedRevision) {
      assertProject()
      const slot = conn.getView().state.nodes.get(node.nodeId)?.slots.find(slot => slot.slotKey === 'main')
      if (!slot) throw new Error(messagesFor(actionMessages, locale).nodeDeleted)
      await actions.onMediaProcess!({ operation: 'timeline.export', nodeId: node.nodeId, slotId: slot.slotId, expectedRevision, params: {} })
    },
    async rename(title) {
      assertProject()
      await actions.onApply!([{ op: 'node.setMeta', nodeId: node.nodeId, title }], messagesFor(actionMessages, locale).renameTimeline)
    },
    download: node => actions.onDownload([node]),
    lastWriter() {
      const view = conn.getView()
      if (view.space?.spaceId !== spaceId) return undefined
      const writer = view.state.nodes.get(node.nodeId)?.slots.find(slot => slot.slotKey === 'main')?.writer
      return writer?.actor === 'agent' && writer.sessionId ? view.state.sessions.get(writer.sessionId)?.title : undefined
    },
    showOnCanvas(nodeId) { options.close(); options.focus(nodeId) },
    upload: options.upload,
    onClose: options.close,
  }
}
