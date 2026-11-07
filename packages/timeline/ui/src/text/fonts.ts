import type { FontRef } from '@vis/protocol'
import type { TimelineEditorHost } from '../types'

const loading = new Map<string, Promise<string>>()

export function captionFamily(font: FontRef): string {
  return 'builtin' in font ? `vis-caption-builtin-${font.builtin}` : `vis-caption-asset-${Array.from(new TextEncoder().encode(font.assetVersionId), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

export function loadCaptionFont(host: TimelineEditorHost, font: FontRef): Promise<string> {
  const family = captionFamily(font)
  const url = host.fontUrl?.(font)
  if (!url) return Promise.resolve(family)
  let promise = loading.get(url)
  if (!promise) {
    promise = new FontFace(family, `url(${JSON.stringify(url)})`).load().then(face => {
      document.fonts.add(face)
      return family
    }).catch(error => { loading.delete(url); throw error })
    loading.set(url, promise)
  }
  return promise
}
