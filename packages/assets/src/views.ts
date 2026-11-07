import { pathToFileURL } from 'node:url'
import type { AssetVersionView } from '@vis/protocol'
import type { spaceSchema as s } from '@vis/storage'
import type { AssetVersionRecord } from './assets'

export function assetVersionView(
  version: AssetVersionRecord,
  asset: Pick<typeof s.assets.$inferSelect, 'displayName'>,
  blobPath: (hash: string) => string,
): AssetVersionView {
  const path = blobPath(version.blobHash)
  return {
    assetVersionId: version.id, assetId: version.assetId, version: version.version, kind: version.kind, mime: version.mime,
    ...(asset.displayName !== null ? { displayName: asset.displayName } : {}),
    ...(version.width !== null ? { width: version.width } : {}),
    ...(version.height !== null ? { height: version.height } : {}),
    ...(version.durationMs !== null ? { durationMs: version.durationMs } : {}),
    ...(version.fps !== null ? { fps: version.fps } : {}),
    ...(version.hasAlpha != null ? { hasAlpha: version.hasAlpha } : {}),
    ...(version.fontFamily !== null ? { fontFamily: version.fontFamily } : {}),
    url: pathToFileURL(path).href, path,
  }
}
