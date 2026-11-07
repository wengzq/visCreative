import type { NodeKind } from '@vis/protocol'

// New node placement (0002 "Generation Jobs and Delivery"): beside the reference node, or in the result area if the reference is missing.
// The final result area awaits canvas interaction design; the MVP uses "right of existing content".
export type Rect = { x: number; y: number; w: number; h: number }
export type Size = { w: number; h: number }

export const NODE_GAP = 40
const MEDIA_BOX = 320
// Match the minimum height in fitNodeToAsset
const MEDIA_MIN = 80
const TEXT_SIZE: Size = { w: 320, h: 200 }

/** Scale images into a 320x320 box; videos keep a fixed width and aspect ratio; audio uses playback control dimensions */
export function defaultNodeSize(kind: NodeKind, media?: { width?: number | null; height?: number | null }): Size {
  if (kind === 'text') return TEXT_SIZE
  if (kind === 'script') return { w: 480, h: 320 }
  if (kind === 'previz') return { w: 360, h: 280 }
  if (kind === 'scene') return { w: 360, h: 280 }
  if (kind === 'timeline') return { w: 360, h: 300 }
  if (kind === 'audio') return { w: 360, h: 140 }
  const w = media?.width ?? 0
  const h = media?.height ?? 0
  if (kind === 'video') return { w: MEDIA_BOX, h: w > 0 && h > 0 ? Math.max(MEDIA_MIN, Math.min(4 * MEDIA_BOX, Math.round(MEDIA_BOX * h / w))) : 180 }
  if (w <= 0 || h <= 0) return { w: MEDIA_BOX, h: MEDIA_BOX }
  const scale = MEDIA_BOX / Math.max(w, h)
  // Extremely narrow or flat assets would shrink to a few unclickable pixels; keep the short side at least MEDIA_MIN and crop with cover
  return { w: Math.max(MEDIA_MIN, Math.round(w * scale)), h: Math.max(MEDIA_MIN, Math.round(h * scale)) }
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w + NODE_GAP && b.x < a.x + a.w + NODE_GAP && a.y < b.y + b.h + NODE_GAP && b.y < a.y + a.h + NODE_GAP
}

/** Search downward from the starting point for the first position that does not overlap existing nodes */
export function firstFreeBelow(start: { x: number; y: number }, size: Size, existing: Rect[]): { x: number; y: number } {
  let candidate: Rect = { ...start, ...size }
  for (;;) {
    const hit = existing.find(r => overlaps(candidate, r))
    if (!hit) return { x: candidate.x, y: candidate.y }
    candidate = { ...candidate, y: hit.y + hit.h + NODE_GAP }
  }
}

export function placeNewNode(size: Size, existing: Rect[], near?: Rect): { x: number; y: number } {
  if (near) {
    // The first ring prefers adjacent edges; expand by rectangular margins, breaking equal-distance ties right, down, left, then up.
    // Fall back to the right of existing content after a bounded search to avoid searching forever on dense canvases.
    for (let ring = 1; ring <= 100; ring++) {
      const gap = NODE_GAP * ring
      const candidates = [
        { x: near.x + near.w + gap, y: near.y },
        { x: near.x, y: near.y + near.h + gap },
        { x: near.x - size.w - gap, y: near.y },
        { x: near.x, y: near.y - size.h - gap },
      ]
      const free = candidates.find(p => !existing.some(r => overlaps({ ...p, ...size }, r)))
      if (free) return free
    }
  }
  if (existing.length === 0) return { x: 0, y: 0 }
  const right = Math.max(...existing.map(r => r.x + r.w))
  const top = Math.min(...existing.map(r => r.y))
  return firstFreeBelow({ x: right + NODE_GAP * 2, y: top }, size, existing)
}
