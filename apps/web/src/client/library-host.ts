import { LIBRARY_ASSET_MIME, type LibraryCoreHost, type MediaHost } from '@vis/library-ui'
import { isMediaKind, type AssetVersionView, type CanvasOp, type MethodResult, type SpaceEvent } from '@vis/protocol'
import type { SpaceConnection } from './space'
import { RpcError } from './rpc'
import { libraryTaskText } from './library-prompt'

export function libraryHost(options: {
  conn: SpaceConnection
  close(): void
  focus(nodeId: string): void
  openSession(sessionId: string): void
  showMedia(entityId?: string): void
  entityId?: string | undefined
}): LibraryCoreHost & MediaHost {
  const { conn } = options
  const spaceId = conn.getView().space!.spaceId
  const assertProject = () => {
    if (!conn.getView().ready || conn.getView().space?.spaceId !== spaceId) throw new Error('The library project is no longer open')
  }
  const prefix = (id: string) => `${encodeURIComponent(spaceId)}/${encodeURIComponent(id)}`
  const token = encodeURIComponent(conn.token)
  return {
    async call(method, params) {
      assertProject()
      const result = await conn.rpc.call(method, params)
      assertProject()
      return result
    },
    onEvent(listener) {
      const deliver = (event: SpaceEvent) => { if (conn.getView().space?.spaceId === spaceId) listener(event) }
      return conn.onEvent?.(deliver) ?? (() => {})
    },
    onClose: options.close,
    async sessions() {
      assertProject()
      const { sessions } = await conn.rpc.call<MethodResult<'session.list'>>('session.list', { includeArchived: false })
      assertProject()
      const { deletedIds, items } = conn.getView().work
      // Mirrors requireAgentWriteSession: the work item must exist, be unarchived and in progress.
      const usable = (id: string) => { const item = items.get(id); return !deletedIds.has(id) && !!item && !item.archivedAt && item.status === 'in_progress' }
      return sessions.filter(session => session.workItemId && usable(session.workItemId)).map(session => ({ sessionId: session.sessionId, title: session.title, running: !!session.activeTurnId || (session.queuedMessageCount ?? 0) > 0 }))
    },
    async sendLibraryTask(task) {
      assertProject()
      await conn.rpc.call('session.sendMessage', { requestId: `library-message-${task.runId}`, sessionId: task.sessionId, text: libraryTaskText(task), refs: [] })
      assertProject()
    },
    openSession: options.openSession,
    assetUrl: id => `/assets/${prefix(id)}?t=${token}`,
    posterUrl: id => `/previews/${prefix(id)}/poster?t=${token}`,
    async importFiles(files) {
      for (const file of files) {
        assertProject()
        const response = await fetch(`/upload?t=${token}&space=${encodeURIComponent(spaceId)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
        const json = await response.json()
        if (!response.ok) throw new RpcError(json.error?.code ?? 'unavailable', json.error?.message ?? `HTTP ${response.status}`, json.error?.data ?? json.error)
        assertProject()
      }
    },
    focusNode: options.focus,
    nodeTitle: id => conn.getView().state.nodes.get(id)?.title ?? undefined,
    async versions(asset): Promise<AssetVersionView[]> {
      assertProject()
      return (await conn.rpc.call<MethodResult<'asset.versions'>>('asset.versions', { assetId: asset.assetId })).versions
    },
    entityId: options.entityId,
    showMedia: options.showMedia,
  }
}

export function libraryCanvasDrop(conn: SpaceConnection, data: DataTransfer, at: { x: number; y: number }, apply: (ops: CanvasOp[]) => Promise<void>, onError: (error: unknown) => void): boolean {
  if (!data.types.includes(LIBRARY_ASSET_MIME)) return false
  try {
    const value = JSON.parse(data.getData(LIBRARY_ASSET_MIME))
    if (!['image', 'video', 'audio'].includes(value.kind) || typeof value.assetVersionId !== 'string') return true
    const projectId = conn.getView().space?.spaceId
    void conn.rpc.call<MethodResult<'asset.get'>>('asset.get', { assetVersionId: value.assetVersionId }).then(asset => {
      if (!conn.getView().ready || conn.getView().space?.spaceId !== projectId) return
      const kind = asset.kind
      if (!isMediaKind(kind)) return
      const w = kind === 'audio' ? 320 : 280
      const h = kind === 'audio' ? 100 : asset.width && asset.height ? Math.max(100, Math.min(420, w * asset.height / asset.width)) : 180
      return apply([{ op: 'node.create', tempId: 'library-media', kind, title: value.title, ...at, w, h, content: { assetVersionId: asset.assetVersionId } }])
    }).catch(onError)
  } catch (error) { onError(error) }
  return true
}
