import { TIMELINE_LIMITS, overlayRect, type OverlayPlacement, type TimelineOutput } from '@vis/protocol'

type Frame = Pick<TimelineOutput, 'width' | 'height'>
export type PlacementPreset = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | 'centre' | 'fullWidth'
export type Corner = 'nw' | 'ne' | 'sw' | 'se'
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
const round = (n: number) => Math.round(n * 1000) / 1000

export function boundedPlacement(placement: OverlayPlacement): OverlayPlacement {
  return {
    x: round(clamp(placement.x, 0, 1)), y: round(clamp(placement.y, 0, 1)),
    width: round(clamp(placement.width, TIMELINE_LIMITS.overlayMinWidth, 1)),
    opacity: Math.round(clamp(placement.opacity, 0, 1) * 100) / 100,
  }
}

export function presetPlacement(placement: OverlayPlacement, preset: PlacementPreset, aspect: number, output: Frame): OverlayPlacement {
  if (preset === 'fullWidth') return { ...placement, x: 0.5, y: 0.5, width: 1 }
  if (preset === 'centre') return { ...placement, x: 0.5, y: 0.5 }
  const rect = overlayRect(placement, aspect, output)
  const halfWidth = rect.width / output.width / 2
  const halfHeight = rect.height / output.height / 2
  return boundedPlacement({ ...placement,
    x: preset.endsWith('Right') ? 0.96 - halfWidth : 0.04 + halfWidth,
    y: preset.startsWith('bottom') ? 0.96 - halfHeight : 0.04 + halfHeight,
  })
}

function nearest(value: number, candidates: number[], tolerance: number) {
  const closest = candidates.reduce((best, candidate) => Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best, Infinity)
  return Math.abs(closest - value) <= tolerance ? closest : value
}

export function movePlacement(placement: OverlayPlacement, dx: number, dy: number, aspect: number, output: Frame, tolerance?: { x: number; y: number }): OverlayPlacement {
  const rect = overlayRect(placement, aspect, output)
  const halfWidth = rect.width / output.width / 2
  const halfHeight = rect.height / output.height / 2
  let x = placement.x + dx
  let y = placement.y + dy
  if (tolerance) {
    x = nearest(x, [0.5, 0.04 + halfWidth, 0.96 - halfWidth], tolerance.x)
    y = nearest(y, [0.5, 0.04 + halfHeight, 0.96 - halfHeight], tolerance.y)
  }
  return boundedPlacement({ ...placement, x, y })
}

/** Keep the opposite corner fixed while the source aspect determines the other dimension. */
export function resizePlacement(placement: OverlayPlacement, corner: Corner, dx: number, dy: number, aspect: number, output: Frame, tolerance?: { x: number; y: number }): OverlayPlacement {
  const sx = corner.endsWith('e') ? 1 : -1
  const sy = corner.startsWith('s') ? 1 : -1
  const ratio = output.width / output.height / aspect
  const anchorX = placement.x - sx * placement.width / 2
  const anchorY = placement.y - sy * placement.width * ratio / 2
  const delta = Math.abs(dx) >= Math.abs(dy / ratio) ? sx * dx : sy * dy / ratio
  let width = clamp(placement.width + delta, TIMELINE_LIMITS.overlayMinWidth, 1)
  if (tolerance) {
    const candidates = [0.04, 0.5, 0.96]
    width = nearest(width, candidates.map(x => (x - anchorX) * sx), tolerance.x)
    width = nearest(width, candidates.map(y => (y - anchorY) * sy / ratio), tolerance.y / ratio)
  }
  width = clamp(width, TIMELINE_LIMITS.overlayMinWidth, 1)
  return boundedPlacement({ ...placement, width, x: anchorX + sx * width / 2, y: anchorY + sy * width * ratio / 2 })
}
