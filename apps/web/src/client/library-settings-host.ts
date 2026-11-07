import type { SettingsLibraryHost, SettingsHost } from '@vis/library-ui'
import type { EntityRef } from '@vis/protocol'
import type { SpaceConnection } from './space'

export function createSettingsHost(options: { conn: SpaceConnection; assetUrl(id: string): string; showMembers?(entityId: string): void }): SettingsHost {
  const { conn } = options
  return {
    settingsAssetUrl: options.assetUrl,
    seriesRefUrl: (seriesId, refId) => `/series-media/${encodeURIComponent(seriesId)}/${encodeURIComponent(refId)}?t=${encodeURIComponent(conn.token)}`,
    onSeriesChanged: listener => conn.onSeriesChanged?.(listener) ?? (() => {}),
    settingsCanvasImages: () => [...conn.getView().state.nodes.values()].flatMap(node => {
      const content = node.slots.find(slot => slot.slotKey === 'main')?.content
      return node.kind === 'image' && content?.type === 'asset'
        ? [{ label: node.title ?? node.nodeId, ref: { assetVersionId: content.assetVersionId, sourceNodeId: node.nodeId } satisfies EntityRef }]
        : []
    }),
    ...(options.showMembers ? { showSettingMembers: options.showMembers } : {}),
  }
}

/** The script picker needs no session or canvas ownership; its writes remain in the script editor. */
export function createScriptSettingsHost(conn: SpaceConnection, assetUrl: (id: string) => string): SettingsLibraryHost {
  return {
    ...createSettingsHost({ conn, assetUrl }),
    call: (method, params) => conn.rpc.call(method, params),
    onEvent: listener => conn.onEvent?.(listener) ?? (() => {}),
  }
}
