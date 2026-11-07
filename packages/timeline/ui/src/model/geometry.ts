import { clipEndMs, textClipEndMs, timelineDurationMs, type TimelineDoc } from '@vis/protocol'

export const HEADER_WIDTH = 168
export const timeToPx = (ms: number, pixelsPerSecond: number) => ms * pixelsPerSecond / 1000
export const pxToTime = (px: number, pixelsPerSecond: number) => Math.round(px * 1000 / pixelsPerSecond)
export function visibleWindow(scrollLeft: number, width: number, pixelsPerSecond: number) {
  return { fromMs: Math.max(0, pxToTime(scrollLeft - width, pixelsPerSecond)), toMs: pxToTime(scrollLeft + width * 2, pixelsPerSecond) }
}

export function snapTime(time: number, candidates: readonly number[], pixelsPerSecond: number, tolerancePx = 8): { time: number; guide: number | null } {
  const toleranceMs = pxToTime(tolerancePx, pixelsPerSecond)
  let closest: number | null = null
  let distance = toleranceMs + 1
  for (const candidate of candidates) {
    const delta = Math.abs(candidate - time)
    if (delta <= toleranceMs && delta < distance) { closest = candidate; distance = delta }
  }
  return { time: Math.max(0, Math.round(closest ?? time)), guide: closest }
}

export function snapCandidates(doc: TimelineDoc, playhead: number, exclude: readonly string[] = []): number[] {
  return [0, playhead, timelineDurationMs(doc), ...doc.tracks.flatMap(track => track.clips.filter(clip => !exclude.includes(clip.id)).flatMap(clip => [clip.startMs, clipEndMs(clip)])),
    ...(doc.textTracks ?? []).flatMap(track => track.clips.filter(clip => !exclude.includes(clip.id)).flatMap(clip => [clip.startMs, textClipEndMs(clip)]))]
}

export function parseTimecode(value: string, fps = 30): number | null {
  const input = value.trim()
  if (/^\d+(\.\d+)?$/.test(input)) return Math.round(Number(input) * 1000)
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(input)
  if (!match || Number(match[3]) >= 60 || (match[1] !== undefined && Number(match[2]) >= 60) || Number(match[4] ?? 0) >= fps) return null
  return Math.round(((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4] ?? 0) * 1000 / fps)
}

export function timecode(ms: number, fps: number, number: (value: number) => string = String): string {
  const positive = Math.max(0, ms)
  const seconds = Math.floor(positive / 1000)
  const frame = Math.min(Math.ceil(fps) - 1, Math.floor((positive - seconds * 1000) * fps / 1000 + 0.0001))
  const pad = (n: number) => number(n).padStart(2, number(0))
  return `${seconds >= 3600 ? `${pad(Math.floor(seconds / 3600))}:` : ''}${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}.${pad(frame)}`
}
