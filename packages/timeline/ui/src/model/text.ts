import { TimelineDoc, TIMELINE_LIMITS, textClipEndMs, type TextClip, type TextTrack } from '@vis/protocol'
import { newId, type EditResult } from './edit'

export const TEXT_LANE_HEIGHT = 52

export function locateText(doc: TimelineDoc, id: string) {
  for (const track of doc.textTracks ?? []) {
    const clip = track.clips.find(clip => clip.id === id)
    if (clip) return { track, clip }
  }
  return undefined
}

function finish(doc: TimelineDoc): EditResult {
  for (const track of doc.textTracks ?? []) {
    track.clips.sort((a, b) => a.startMs - b.startMs)
    if (track.clips.some((clip, i) => i > 0 && clip.startMs < textClipEndMs(track.clips[i - 1]!))) return { ok: false, reason: 'overlap' }
  }
  return TimelineDoc.safeParse(doc).success ? { ok: true, doc } : { ok: false, reason: 'limit' }
}

export function addText(doc: TimelineDoc, at: number, text: string): EditResult {
  const next = structuredClone(doc)
  next.textTracks ??= []
  if (!next.textTracks.length) next.textTracks.push({ id: newId(next), hidden: false, clips: [] })
  const track = next.textTracks[0]!
  let startMs = Math.max(0, Math.round(at))
  for (const clip of track.clips) {
    if (startMs + 2000 <= clip.startMs) break
    if (startMs < textClipEndMs(clip)) startMs = textClipEndMs(clip)
  }
  track.clips.push({ id: newId(next), startMs, durationMs: 2000, text, style: { preset: 'subtitle' }, fadeInMs: 0, fadeOutMs: 0 })
  return finish(next)
}

export function updateText(doc: TimelineDoc, id: string, patch: Partial<Omit<TextClip, 'id'>>): EditResult {
  const next = structuredClone(doc)
  const entry = locateText(next, id)
  if (!entry) return { ok: false, reason: 'missing' }
  Object.assign(entry.clip, patch)
  entry.clip.fadeInMs = Math.min(entry.clip.fadeInMs, entry.clip.durationMs, TIMELINE_LIMITS.maxFadeMs)
  entry.clip.fadeOutMs = Math.min(entry.clip.fadeOutMs, entry.clip.durationMs - entry.clip.fadeInMs, TIMELINE_LIMITS.maxFadeMs)
  return finish(next)
}

export function deleteText(doc: TimelineDoc, ids: readonly string[]): TimelineDoc {
  if (!doc.textTracks) return doc
  return { ...doc, textTracks: doc.textTracks.map(track => ({ ...track, clips: track.clips.filter(clip => !ids.includes(clip.id)) })) }
}

export function updateTextTrack(doc: TimelineDoc, id: string, patch: Partial<Pick<TextTrack, 'name' | 'hidden'>>): EditResult {
  return finish({ ...doc, textTracks: (doc.textTracks ?? []).map(track => track.id === id ? { ...track, ...patch, clips: [...track.clips] } : { ...track, clips: [...track.clips] }) })
}

export function removeTextTrack(doc: TimelineDoc, id: string): EditResult {
  return { ok: true, doc: { ...doc, textTracks: (doc.textTracks ?? []).filter(track => track.id !== id) } }
}
