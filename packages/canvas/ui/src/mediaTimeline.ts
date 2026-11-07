export const MAX_SPLIT_POINTS = 20

// Technical timecodes retain millisecond precision without locale digit grouping.
export function timelineTime(ms: number): string {
  const value = Math.max(0, Number.isFinite(ms) ? Math.round(ms) : 0)
  return `${Math.floor(value / 60_000)}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')}.${String(value % 1000).padStart(3, '0')}`
}

export function durationMs(seconds: number): number {
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 0
}

export function clampTime(value: number, duration: number): number {
  return Math.round(Math.max(0, Math.min(Math.max(0, duration), Number.isFinite(value) ? value : 0)))
}

export function pixelToTime(x: number, left: number, width: number, duration: number): number {
  return width > 0 ? clampTime((x - left) / width * duration, duration) : 0
}

export function timeToPercent(time: number, duration: number): number {
  return duration > 0 ? Math.max(0, Math.min(100, time / duration * 100)) : 0
}

export function clampRange(startMs: number, endMs: number, duration: number): { startMs: number; endMs: number } {
  const end = Math.max(0, Math.floor(duration))
  if (!end) return { startMs: 0, endMs: 0 }
  const start = Math.min(end - 1, clampTime(startMs, end))
  return { startMs: start, endMs: Math.max(start + 1, clampTime(endMs, end)) }
}

export function normalizeSplitPoints(points: readonly number[], duration: number): number[] {
  return [...new Set(points.filter(Number.isFinite).map(Math.round).filter(point => point > 0 && point < duration))]
    .sort((a, b) => a - b).slice(0, MAX_SPLIT_POINTS)
}

export function addSplitPoint(points: readonly number[], time: number, duration: number): number[] {
  if (points.length >= MAX_SPLIT_POINTS) return [...points]
  return normalizeSplitPoints([...points, time], duration)
}

/** Keep handles in their original order so dragging cannot swap the focused point. */
export function moveSplitPoint(points: readonly number[], index: number, time: number, duration: number): number[] {
  if (index < 0 || index >= points.length) return [...points]
  const next = [...points]
  next[index] = Math.max((points[index - 1] ?? 0) + 1, Math.min((points[index + 1] ?? Math.floor(duration)) - 1, clampTime(time, duration)))
  return next
}

export function removeSplitPoint(points: readonly number[], index: number): number[] {
  return points.filter((_, i) => i !== index)
}
