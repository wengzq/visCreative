import type { PrevizDoc, PrevizPanel } from '@vis/protocol'

export const pictureKeys = ['underlay', 'sketch', 'image', 'blockout'] as const
export function mapPictures(doc: PrevizDoc, resolve: (id: string) => string): PrevizDoc {
  return { ...doc, panels: doc.panels.map(panel => ({ ...panel, ...Object.fromEntries(pictureKeys.map(key => [key, panel[key] ? resolve(panel[key]) : null])) })) }
}

/** Blobs and undo snapshots stay local; only immutable version IDs reach the wire. */
export function createDraftAssets(upload: (blob: Blob, name: string) => Promise<string>, assetUrl: (id: string) => string) {
  const entries = new Map<string, { blob: Blob; url: string; name: string; uploaded?: Promise<string> }>()
  const resolved = new Map<string, string>()
  return {
    add(blob: Blob, name: string): string {
      const id = `local-${crypto.randomUUID()}`
      entries.set(id, { blob, name, url: URL.createObjectURL(blob) })
      return id
    },
    url(id: string): string { return entries.get(id)?.url ?? assetUrl(id) },
    /** A local picture and its uploaded version are the same image. */
    same(a: string, b: string): boolean { return a === b || resolved.get(a) === b },
    async prepare(doc: PrevizDoc): Promise<PrevizDoc> {
      const ids = new Set(doc.panels.flatMap(panel => pictureKeys.flatMap(key => panel[key] ? [panel[key]!] : [])))
      for (const id of ids) {
        const entry = entries.get(id)
        if (!entry) continue
        entry.uploaded ??= upload(entry.blob, entry.name).catch(error => { delete entry.uploaded; throw error })
        resolved.set(id, await entry.uploaded)
      }
      return mapPictures(doc, id => resolved.get(id) ?? id)
    },
    dispose() { entries.forEach(entry => URL.revokeObjectURL(entry.url)); entries.clear() },
  }
}

export async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.src = url
  await image.decode()
  return image
}
export function panelSize(ratio: string) {
  const [w, h] = ratio.split(':').map(Number) as [number, number]
  return { width: Math.round(1280 * Math.min(1, w / h)), height: Math.round(1280 * Math.min(1, h / w)) }
}
export function fitImage(context: CanvasRenderingContext2D, image: CanvasImageSource & { width: number; height: number }, width: number, height: number) {
  const scale = Math.min(width / image.width, height / image.height)
  context.drawImage(image, (width - image.width * scale) / 2, (height - image.height * scale) / 2, image.width * scale, image.height * scale)
}
export const png = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode the panel')), 'image/png'))
/** The picture drawn under the sketch. An imported or canvas underlay is the author's own choice, so it wins over a blockout frame. */
export const backdrop = (panel: Pick<PrevizPanel, 'underlay' | 'blockout'>) => panel.underlay ?? panel.blockout
export async function flatten(underlay: string | null, sketch: string | null, ratio: string, url: (id: string) => string): Promise<Blob> {
  const { width, height } = panelSize(ratio)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  for (const id of [underlay, sketch]) if (id) fitImage(ctx, await loadImage(url(id)), width, height)
  return png(canvas)
}
