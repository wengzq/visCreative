import { GenerationOperation, LocalOperation, operationKind, type MediaKind, type NodeView } from '@vis/protocol'

export type ToolbarEntry = { operation: LocalOperation | GenerationOperation; variant?: 'custom' | 'smart' }

export const LOCAL_TOOLBAR_ENTRIES = {
  image: [{ operation: 'image.crop' }, { operation: 'image.gridSplit' }],
  video: [{ operation: 'video.trim' }, { operation: 'video.frame' }, { operation: 'video.extractAudio' }],
  audio: [{ operation: 'audio.trim' }, { operation: 'audio.split', variant: 'custom' }, { operation: 'audio.split', variant: 'smart' }, { operation: 'audio.speed' }],
} as const satisfies Record<MediaKind, readonly ToolbarEntry[]>

export const COMMON_OPERATIONS = {
  image: ['image.crop', 'image.gridSplit', 'image.upscale'],
  video: ['video.trim', 'video.frame', 'video.upscale'],
  audio: ['audio.trim', 'audio.split'],
} as const

export function toolbarEntries(kind: MediaKind, generation: readonly GenerationOperation[] = []) {
  const entries: ToolbarEntry[] = [
    ...LOCAL_TOOLBAR_ENTRIES[kind].filter(entry => LocalOperation.safeParse(entry.operation).success),
    ...[...new Set(generation)].filter(operation => GenerationOperation.safeParse(operation).success && operationKind(operation) === kind).map(operation => ({ operation })),
  ]
  const common = new Set<string>(COMMON_OPERATIONS[kind])
  return { common: entries.filter(entry => common.has(entry.operation)), more: entries.filter(entry => !common.has(entry.operation)) }
}

export function toolbarFocusIndex(key: string, index: number, count: number): number | undefined {
  if (!count) return
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count
}

/** Keep the floating toolbar from covering another node's title or body. Offsets are screen pixels. */
export function toolbarOffset(nodeId: string, nodes: readonly NodeView[], zoom: number, size: { w: number; h: number }) {
  const view = nodes.find(node => node.nodeId === nodeId)
  let offset = Math.max(42, 27 * zoom + 8)
  if (!view) return offset
  const center = (view.x + view.w / 2) * zoom
  const left = center - size.w / 2
  const right = center + size.w / 2
  const top = view.y * zoom
  const neighbors = nodes.filter(node => node.nodeId !== nodeId && node.kind !== 'frame' && node.x * zoom < right && (node.x + node.w) * zoom > left)
  for (let pass = 0; pass <= neighbors.length; pass++) {
    const bottom = top - offset
    const overlapping = neighbors.filter(node => (node.y - 27) * zoom < bottom && (node.y + node.h) * zoom > bottom - size.h)
    if (!overlapping.length) break
    offset = Math.max(offset, ...overlapping.map(node => top - (node.y - 27) * zoom + 8))
  }
  return offset
}
