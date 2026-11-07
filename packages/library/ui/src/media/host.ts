import type { AssetVersionView, LibraryAsset } from '@vis/protocol'

export const LIBRARY_ASSET_MIME = 'application/x-vis-library-asset'

export type MediaHost = {
  assetUrl(assetVersionId: string): string
  posterUrl(assetVersionId: string): string
  importFiles(files: File[]): Promise<void>
  focusNode(nodeId: string): void
  nodeTitle(nodeId: string): string | undefined
  versions(asset: LibraryAsset): Promise<AssetVersionView[]>
  entityId?: string | undefined
  showMedia(entityId?: string): void
}
