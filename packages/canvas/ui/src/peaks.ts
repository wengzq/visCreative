import type { MediaPreview } from '@vis/protocol'

export type PreviewLoader = (assetVersionId: string, kind: 'peaks' | 'filmstrip') => Promise<MediaPreview>
export type AudioPeaks = Extract<MediaPreview, { kind: 'peaks' }>

export function createPeaksCache() {
  const cache = new Map<string, Promise<AudioPeaks | undefined>>()
  return (assetVersionId: string, preview: PreviewLoader): Promise<AudioPeaks | undefined> => {
    let pending = cache.get(assetVersionId)
    if (!pending) {
      // A failure is not cached: the slot may have been busy or the project reopening, so the next mount asks again.
      pending = preview(assetVersionId, 'peaks').then(result => result.kind === 'peaks' ? result : undefined).catch(() => {
        cache.delete(assetVersionId)
        return undefined
      })
      cache.set(assetVersionId, pending)
    }
    return pending
  }
}

// Versions are immutable and globally identified, including across project switches.
export const loadAudioPeaks = createPeaksCache()
