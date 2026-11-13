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

type ToolbarRect = { left: number; top: number; right: number; bottom: number }

/** Clamping a wide bar below a fixed header must not put it over its own card or version controls. */
export function placeFloatingToolbar(bounds: ToolbarRect, area: ToolbarRect, obstacles: readonly ToolbarRect[]) {
  const width = bounds.right - bounds.left
  const height = bounds.bottom - bounds.top
  const clampX = (left: number) => Math.max(area.left + 8, Math.min(left, area.right - width - 8))
  const clampY = (top: number) => Math.max(area.top + 8, Math.min(top, area.bottom - height - 8))
  const overlap = (left: number, top: number) => obstacles.reduce((sum, rect) => sum
    + Math.max(0, Math.min(left + width, rect.right + 8) - Math.max(left, rect.left - 8))
    * Math.max(0, Math.min(top + height, rect.bottom + 8) - Math.max(top, rect.top - 8)), 0)
  let best = { left: clampX(bounds.left), top: clampY(bounds.top) }
  let covered = overlap(best.left, best.top)
  if (covered === 0) return { x: best.left - bounds.left, y: best.top - bounds.top }
  let distance = Math.hypot(best.left - bounds.left, best.top - bounds.top)
  const lefts = new Set([best.left, clampX(area.left), clampX(area.right), ...obstacles.flatMap(rect => [clampX(rect.left - width - 8), clampX(rect.right + 8)])])
  const tops = new Set([best.top, clampY(area.top), clampY(area.bottom), ...obstacles.flatMap(rect => [clampY(rect.top - height - 8), clampY(rect.bottom + 8)])])
  for (const left of lefts) for (const top of tops) {
    const nextCovered = overlap(left, top)
    const nextDistance = Math.hypot(left - bounds.left, top - bounds.top)
    if (nextCovered < covered || (nextCovered === covered && nextDistance < distance)) {
      best = { left, top }
      covered = nextCovered
      distance = nextDistance
    }
  }
  return { x: best.left - bounds.left, y: best.top - bounds.top }
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
