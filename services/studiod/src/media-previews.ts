import { createPreviewCache, type AssetStore, type MediaTools } from '@vis/assets'
import { VisError } from '@vis/domain'
import type { MethodParams, MethodResult } from '@vis/protocol'
import type { SpaceDb } from '@vis/storage'
import { createMediaLimiter, MediaScheduler } from './media-tasks'

const scheduler = new MediaScheduler(1)
const interrupted = () => VisError.of('unavailable', 'media.interrupted', {}, 'Media preview generation was interrupted')

export function createMediaPreviewService(deps: { db: SpaceDb; assets: AssetStore; dir: string; paths?: MediaTools['paths'] }) {
  const owner = {}
  let closed = false
  const limiter = createMediaLimiter(scheduler, owner, () => closed, interrupted)
  const cache = createPreviewCache({ dir: deps.dir, ...deps.paths, limit: limiter.limit })
  return {
    async get(p: MethodParams<'media.preview'>): Promise<MethodResult<'media.preview'>> {
      if (closed) throw VisError.of('unavailable', 'media.interrupted', {}, 'Media previews are stopping')
      const version = deps.assets.getVersion(deps.db, p.assetVersionId)
      if (!version) throw VisError.of('not_found', 'asset.version_not_found', { assetVersionId: p.assetVersionId }, `Asset version ${p.assetVersionId} does not exist`)
      const path = deps.assets.blobPath(version.blobHash)
      if (p.kind === 'peaks' && (version.kind === 'audio' || version.kind === 'video')) {
        return { kind: 'peaks', ...await cache.peaks(version.id, path) }
      }
      if (p.kind === 'filmstrip' && version.kind === 'video') {
        return { kind: 'filmstrip', ...await cache.filmstrip(version.id, path) }
      }
      if (p.kind === 'poster' && version.kind === 'video') {
        return { kind: 'poster', ...await cache.poster(version.id, path) }
      }
      if (p.kind === 'thumbnail' && version.kind === 'image') {
        return { kind: 'thumbnail', ...await cache.poster(version.id, path, true) }
      }
      throw VisError.of('invalid_params', 'media.kind_mismatch', {}, 'The source media kind does not support this preview')
    },
    clear: () => cache.clear(),
    async close() {
      closed = true
      const drained = limiter.drain()
      await cache.close()
      await drained
    },
  }
}

export type MediaPreviewService = ReturnType<typeof createMediaPreviewService>
