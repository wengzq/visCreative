import { TimelineDoc, TIMELINE_LIMITS, clipDurationMs, clipEndMs, imageMaxMs, isAudioTrack, isMainVideoTrack, isOverlayTrack, sourceTimeAt, type OverlayPlacement, type TimelineClip, type TimelineTrack, type TimelineTransition } from '@vis/protocol'

export type EditReason = 'overlap' | 'limit' | 'missing' | 'invalid' | 'kind' | 'duration' | 'captions'
export type EditResult = { ok: true; doc: TimelineDoc; value?: number; boundHit?: boolean } | { ok: false; reason: EditReason }
export type SourceBounds = { kind: 'video' | 'audio' | 'image'; durationMs?: number | undefined }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const copy = (doc: TimelineDoc): TimelineDoc => structuredClone(doc)
export const DEFAULT_OVERLAY: OverlayPlacement = { x: 0.5, y: 0.5, width: 0.25, opacity: 1 }

function sameClip(a: TimelineClip, b: TimelineClip) {
  return a.id === b.id && a.source.nodeId === b.source.nodeId && a.source.assetVersionId === b.source.assetVersionId &&
    a.startMs === b.startMs && a.inMs === b.inMs && a.outMs === b.outMs && a.volume === b.volume && a.fadeInMs === b.fadeInMs && a.fadeOutMs === b.fadeOutMs &&
    (a.speed ?? 1) === (b.speed ?? 1) && a.transitionIn?.kind === b.transitionIn?.kind && a.transitionIn?.durationMs === b.transitionIn?.durationMs &&
    sameValue(a.overlay, b.overlay)
}

export function sameDocument(a: TimelineDoc, b: TimelineDoc): boolean {
  return a.output?.width === b.output?.width && a.output?.height === b.output?.height && a.output?.fps === b.output?.fps &&
    a.tracks.length === b.tracks.length && a.tracks.every((track, index) => {
      const other = b.tracks[index]!
      return track.id === other.id && track.kind === other.kind && track.name === other.name && track.muted === other.muted && track.volume === other.volume && track.hidden === other.hidden &&
        track.clips.length === other.clips.length && track.clips.every((clip, i) => sameClip(clip, other.clips[i]!))
    }) &&
    // Text clips are small and nested (style, font), so compare them whole. Key order differs between
    // server copies and local edits, and the draft recognises its own commits by this comparison.
    sameValue(a.textTracks ?? [], b.textTracks ?? [])
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a).filter(key => (a as Record<string, unknown>)[key] !== undefined)
  const other = Object.keys(b).filter(key => (b as Record<string, unknown>)[key] !== undefined)
  return keys.length === other.length && keys.every(key => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

export function newId(doc: TimelineDoc): string {
  const used = new Set([...doc.tracks, ...doc.textTracks ?? []].flatMap(track => [track.id, ...track.clips.map(clip => clip.id)]))
  let id: string
  do { id = `tl_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}` } while (used.has(id))
  return id
}

function finish(doc: TimelineDoc, extra: { value?: number; boundHit?: boolean } = {}): EditResult {
  const parsed = TimelineDoc.safeParse(doc)
  return parsed.success ? { ok: true, doc: parsed.data, ...extra } : { ok: false, reason: 'limit' }
}

function find(doc: TimelineDoc, id: string) {
  for (const track of doc.tracks) {
    const clip = track.clips.find(clip => clip.id === id)
    if (clip) return { track, clip }
  }
  return null
}

export function locateClip(doc: TimelineDoc, id: string) { return find(doc, id) }

function ripple(track: TimelineTrack) {
  delete track.clips[0]?.transitionIn
  for (let index = 1; index < track.clips.length; index++) {
    const clip = track.clips[index]!
    const previous = track.clips[index - 1]!
    if (!clip.transitionIn) continue
    const allowed = Math.min(clipDurationMs(clip), clipDurationMs(previous) - (previous.transitionIn?.durationMs ?? 0), TIMELINE_LIMITS.transitionMaxMs)
    const durationMs = Math.min(clip.transitionIn.durationMs, allowed)
    if (durationMs < TIMELINE_LIMITS.transitionMinMs) delete clip.transitionIn
    else clip.transitionIn.durationMs = durationMs
  }
  let start = 0
  for (const clip of track.clips) {
    clip.startMs = start - (clip.transitionIn?.durationMs ?? 0)
    start = clipEndMs(clip)
  }
}

function fitFades(clip: TimelineClip) {
  clip.fadeInMs = Math.min(clip.fadeInMs, clipDurationMs(clip), TIMELINE_LIMITS.maxFadeMs)
  clip.fadeOutMs = Math.min(clip.fadeOutMs, clipDurationMs(clip) - clip.fadeInMs, TIMELINE_LIMITS.maxFadeMs)
}

export function insertVideo(doc: TimelineDoc, clips: readonly TimelineClip[], index: number): EditResult {
  const next = copy(doc)
  let track = next.tracks.find(isMainVideoTrack)
  if (!track) {
    track = { id: newId(next), kind: 'video', muted: false, volume: 1, clips: [] }
    next.tracks.unshift(track)
  }
  track.clips.splice(clamp(Math.round(index), 0, track.clips.length), 0, ...structuredClone(clips))
  ripple(track)
  return finish(next)
}

export function moveVideo(doc: TimelineDoc, id: string, index: number): EditResult {
  const next = copy(doc)
  const entry = find(next, id)
  if (!entry || !isMainVideoTrack(entry.track)) return { ok: false, reason: 'missing' }
  entry.track.clips.splice(entry.track.clips.indexOf(entry.clip), 1)
  entry.track.clips.splice(clamp(Math.round(index), 0, entry.track.clips.length), 0, entry.clip)
  ripple(entry.track)
  return finish(next)
}

export function deleteClips(doc: TimelineDoc, ids: readonly string[]): EditResult {
  const next = copy(doc)
  for (const track of next.tracks) {
    track.clips = track.clips.filter(clip => !ids.includes(clip.id))
    if (isMainVideoTrack(track)) ripple(track)
  }
  return finish(next)
}

export function canPlace(track: TimelineTrack, startMs: number, durationMs: number, exceptId?: string): boolean {
  return startMs >= 0 && startMs + durationMs <= TIMELINE_LIMITS.maxDurationMs &&
    !track.clips.some(clip => clip.id !== exceptId && startMs < clipEndMs(clip) && startMs + durationMs > clip.startMs)
}

export function placeAudio(doc: TimelineDoc, trackId: string, clip: TimelineClip, startMs: number): EditResult {
  const next = copy(doc)
  const track = next.tracks.find(track => track.id === trackId && isAudioTrack(track))
  if (!track) return { ok: false, reason: 'missing' }
  const start = Math.max(0, Math.round(startMs))
  if (!canPlace(track, start, clipDurationMs(clip))) return { ok: false, reason: 'overlap' }
  track.clips.push({ ...structuredClone(clip), startMs: start })
  track.clips.sort((a, b) => a.startMs - b.startMs)
  return finish(next)
}

export function moveAudio(doc: TimelineDoc, id: string, trackId: string, startMs: number): EditResult {
  const next = copy(doc)
  const source = find(next, id)
  const target = next.tracks.find(track => track.id === trackId && isAudioTrack(track))
  if (!source || !isAudioTrack(source.track) || !target) return { ok: false, reason: 'missing' }
  source.track.clips = source.track.clips.filter(clip => clip.id !== id)
  return placeAudio(next, trackId, source.clip, startMs)
}

/** New overlays fit the free space at the drop point; moves keep their complete source range. */
export function placeOverlay(doc: TimelineDoc, trackId: string, clip: TimelineClip, startMs: number, bounds: SourceBounds = { kind: 'image' }): EditResult {
  if (!Number.isFinite(startMs)) return { ok: false, reason: 'invalid' }
  const next = copy(doc)
  const track = next.tracks.find(track => track.id === trackId && isOverlayTrack(track))
  if (!track) return { ok: false, reason: 'missing' }
  if (track.clips.length >= TIMELINE_LIMITS.overlayClipsPerTrack) return { ok: false, reason: 'limit' }
  if (bounds.kind === 'audio' || clip.inMs !== 0 || clip.speed !== undefined || clip.transitionIn) return { ok: false, reason: 'kind' }
  const start = Math.max(0, Math.round(startMs))
  if (track.clips.some(clip => start >= clip.startMs && start < clipEndMs(clip))) return { ok: false, reason: 'overlap' }
  const end = track.clips.find(clip => clip.startMs >= start)?.startMs ?? TIMELINE_LIMITS.maxDurationMs
  const image = bounds.kind === 'image'
  const duration = Math.min(clipDurationMs(clip), end - start, image ? imageMaxMs(track) : bounds.durationMs ?? clip.outMs)
  if (duration < (image ? TIMELINE_LIMITS.imageMinMs : 1)) return { ok: false, reason: 'duration' }
  const inserted = { ...structuredClone(clip), startMs: start, outMs: duration, overlay: structuredClone(clip.overlay ?? DEFAULT_OVERLAY) }
  fitFades(inserted)
  track.clips.push(inserted)
  track.clips.sort((a, b) => a.startMs - b.startMs)
  return finish(next)
}

export function moveOverlay(doc: TimelineDoc, id: string, trackId: string, startMs: number): EditResult {
  if (!Number.isFinite(startMs)) return { ok: false, reason: 'invalid' }
  const next = copy(doc)
  const source = find(next, id)
  const target = next.tracks.find(track => track.id === trackId && isOverlayTrack(track))
  if (!source || !isOverlayTrack(source.track) || !target) return { ok: false, reason: 'missing' }
  if (target !== source.track && target.clips.length >= TIMELINE_LIMITS.overlayClipsPerTrack) return { ok: false, reason: 'limit' }
  const start = Math.max(0, Math.round(startMs))
  if (!canPlace(target, start, clipDurationMs(source.clip), id)) return { ok: false, reason: 'overlap' }
  source.track.clips = source.track.clips.filter(clip => clip.id !== id)
  target.clips.push({ ...source.clip, startMs: start })
  target.clips.sort((a, b) => a.startMs - b.startMs)
  return finish(next)
}

/** Free-track in-trims keep the source's timeline anchor, while main video trims ripple later cuts. */
export function trimClip(doc: TimelineDoc, id: string, edge: 'in' | 'out', requested: number, bounds: SourceBounds): EditResult {
  if (!Number.isFinite(requested)) return { ok: false, reason: 'invalid' }
  const next = copy(doc)
  const entry = find(next, id)
  if (!entry) return { ok: false, reason: 'missing' }
  const { track, clip } = entry
  const image = bounds.kind === 'image'
  if (isOverlayTrack(track) && bounds.kind === 'audio') return { ok: false, reason: 'kind' }
  const speed = clip.speed ?? 1
  const minimum = image ? TIMELINE_LIMITS.imageMinMs : Math.max(1, Math.ceil(speed / 2))
  const sourceEnd = image ? imageMaxMs(track) : bounds.durationMs ?? clip.outMs
  const oldEnd = clipEndMs(clip)
  let lower = edge === 'in' ? 0 : clip.inMs + minimum
  let upper = edge === 'in' ? clip.outMs - minimum : sourceEnd
  if (image && edge === 'in') lower = upper = 0
  if (!isMainVideoTrack(track)) {
    const index = track.clips.indexOf(clip)
    if (edge === 'in') lower = Math.max(lower, sourceTimeAt(clip, index > 0 ? clipEndMs(track.clips[index - 1]!) : 0))
    else upper = Math.min(upper, sourceTimeAt(clip, track.clips[index + 1]?.startMs ?? TIMELINE_LIMITS.maxDurationMs))
  } else {
    const total = track.clips.length ? clipEndMs(track.clips.at(-1)!) : 0
    if (edge === 'out') upper = Math.min(upper, clip.outMs + (TIMELINE_LIMITS.maxDurationMs - total) * speed)
    else lower = Math.max(lower, clip.inMs - (TIMELINE_LIMITS.maxDurationMs - total) * speed)
  }
  let value = clamp(Math.round(requested), Math.ceil(lower), Math.max(Math.ceil(lower), Math.floor(upper)))
  if (edge === 'in') {
    clip.inMs = value
    if (!isMainVideoTrack(track)) {
      const previous = track.clips[track.clips.indexOf(clip) - 1]
      const boundary = previous ? clipEndMs(previous) : 0
      clip.startMs = oldEnd - clipDurationMs(clip)
      while (clip.startMs < boundary && clip.inMs < clip.outMs - minimum) {
        clip.inMs++
        clip.startMs = oldEnd - clipDurationMs(clip)
      }
      value = clip.inMs
    }
  } else clip.outMs = value
  fitFades(clip)
  if (isMainVideoTrack(track)) ripple(track)
  return finish(next, { value, boundHit: value !== Math.round(requested) })
}

/** Image source time stays at zero, so a left overlay trim changes its absolute start instead. */
export function trimImageClip(doc: TimelineDoc, id: string, edge: 'in' | 'out', atMs: number): EditResult {
  if (!Number.isFinite(atMs)) return { ok: false, reason: 'invalid' }
  const entry = find(doc, id)
  if (!entry) return { ok: false, reason: 'missing' }
  if (isAudioTrack(entry.track)) return { ok: false, reason: 'kind' }
  if (edge === 'out' || isMainVideoTrack(entry.track)) {
    const requested = edge === 'out' ? atMs - entry.clip.startMs : clipEndMs(entry.clip) - atMs
    return trimClip(doc, id, 'out', requested, { kind: 'image' })
  }
  const next = copy(doc)
  const { track, clip } = find(next, id)!
  const previous = track.clips[track.clips.indexOf(clip) - 1]
  const end = clipEndMs(clip)
  const lower = Math.max(previous ? clipEndMs(previous) : 0, end - imageMaxMs(track))
  const start = clamp(Math.round(atMs), lower, end - TIMELINE_LIMITS.imageMinMs)
  clip.startMs = start
  clip.inMs = 0
  clip.outMs = end - start
  fitFades(clip)
  return finish(next, { value: clip.outMs, boundHit: start !== Math.round(atMs) })
}

export function splitClip(doc: TimelineDoc, id: string, atMs: number, bounds?: SourceBounds): EditResult {
  const next = copy(doc)
  const entry = find(next, id)
  if (!entry) return { ok: false, reason: 'missing' }
  const { track, clip } = entry
  const end = clipEndMs(clip)
  const left = Math.round(atMs) - clip.startMs
  const right = clipDurationMs(clip) - left
  const image = bounds?.kind === 'image'
  const min = image ? TIMELINE_LIMITS.imageMinMs : 1
  if (left < min || right < min) return { ok: false, reason: 'duration' }
  const sourceAt = Math.round(sourceTimeAt(clip, Math.round(atMs)))
  if (sourceAt <= clip.inMs || sourceAt >= clip.outMs) return { ok: false, reason: 'duration' }
  const second = { ...structuredClone(clip), id: newId(next), startMs: clip.startMs + left, inMs: sourceAt, fadeInMs: 0 }
  delete second.transitionIn
  clip.outMs = sourceAt
  clip.fadeOutMs = 0
  if (image) { second.inMs = 0; second.outMs = right }
  else if (isOverlayTrack(track)) {
    // Integer source ranges can round to an extra timeline millisecond at fractional speeds.
    // Keep the original outer edges and round inward rather than overlapping an absolute neighbor.
    second.startMs = end - clipDurationMs(second)
    while (clipEndMs(clip) > second.startMs && clip.outMs > clip.inMs) clip.outMs--
    if (clipDurationMs(clip) < 1 || clipDurationMs(second) < 1) return { ok: false, reason: 'duration' }
  }
  fitFades(clip)
  fitFades(second)
  track.clips.splice(track.clips.indexOf(clip) + 1, 0, second)
  if (isMainVideoTrack(track)) ripple(track)
  return finish(next)
}

export function nextFreeTime(track: TimelineTrack, start: number, duration: number): number {
  let time = Math.max(0, Math.round(start))
  for (const clip of track.clips) {
    if (time + duration <= clip.startMs) break
    if (time < clipEndMs(clip)) time = clipEndMs(clip)
  }
  return time
}

export function duplicateClip(doc: TimelineDoc, id: string): EditResult {
  const entry = find(doc, id)
  if (!entry) return { ok: false, reason: 'missing' }
  const clip = { ...structuredClone(entry.clip), id: newId(doc) }
  if (isMainVideoTrack(entry.track)) return insertVideo(doc, [clip], entry.track.clips.indexOf(entry.clip) + 1)
  const start = nextFreeTime(entry.track, clipEndMs(clip), clipDurationMs(clip))
  if (start + clipDurationMs(clip) > TIMELINE_LIMITS.maxDurationMs) return { ok: false, reason: 'limit' }
  if (!isOverlayTrack(entry.track)) return placeAudio(doc, entry.track.id, clip, start)
  const next = copy(doc)
  const track = next.tracks.find(track => track.id === entry.track.id)!
  track.clips.push({ ...clip, startMs: start })
  track.clips.sort((a, b) => a.startMs - b.startMs)
  return finish(next)
}

export function addAudioTrack(doc: TimelineDoc, name?: string): EditResult {
  if (doc.tracks.filter(isAudioTrack).length >= TIMELINE_LIMITS.audioTracks) return { ok: false, reason: 'limit' }
  const next = copy(doc)
  next.tracks.push({ id: newId(next), kind: 'audio', ...(name === undefined ? {} : { name }), muted: false, volume: 1, clips: [] })
  return finish(next)
}

export function removeAudioTrack(doc: TimelineDoc, id: string): EditResult {
  const next = copy(doc)
  next.tracks = next.tracks.filter(track => track.id !== id || !isAudioTrack(track))
  return finish(next)
}

export function addOverlayTrack(doc: TimelineDoc, name?: string): EditResult {
  if (doc.tracks.filter(isOverlayTrack).length >= TIMELINE_LIMITS.overlayTracks) return { ok: false, reason: 'limit' }
  const next = copy(doc)
  const index = next.tracks.findIndex(isAudioTrack)
  next.tracks.splice(index < 0 ? next.tracks.length : index, 0, { id: newId(next), kind: 'overlay', ...(name === undefined ? {} : { name }), hidden: false, muted: false, volume: 1, clips: [] })
  return finish(next)
}

export function removeOverlayTrack(doc: TimelineDoc, id: string): EditResult {
  const next = copy(doc)
  next.tracks = next.tracks.filter(track => track.id !== id || !isOverlayTrack(track))
  return finish(next)
}

export function updateTrack(doc: TimelineDoc, id: string, patch: { name?: string; muted?: boolean; volume?: number; hidden?: boolean }): EditResult {
  const next = copy(doc)
  const track = next.tracks.find(track => track.id === id)
  if (!track) return { ok: false, reason: 'missing' }
  if (patch.hidden !== undefined && !isOverlayTrack(track)) return { ok: false, reason: 'kind' }
  Object.assign(track, patch, patch.volume === undefined ? {} : { volume: clamp(patch.volume, 0, 2) })
  return finish(next)
}

export function reorderAudioTrack(doc: TimelineDoc, id: string, audioIndex: number): EditResult {
  const next = copy(doc)
  const track = next.tracks.find(track => track.id === id && isAudioTrack(track))
  if (!track) return { ok: false, reason: 'missing' }
  next.tracks = next.tracks.filter(t => t.id !== id)
  const offset = next.tracks.filter(t => !isAudioTrack(t)).length
  next.tracks.splice(offset + clamp(Math.round(audioIndex), 0, next.tracks.length - offset), 0, track)
  return finish(next)
}

export function reorderOverlayTrack(doc: TimelineDoc, id: string, overlayIndex: number): EditResult {
  const next = copy(doc)
  const track = next.tracks.find(track => track.id === id && isOverlayTrack(track))
  if (!track) return { ok: false, reason: 'missing' }
  next.tracks = next.tracks.filter(t => t.id !== id)
  const offset = next.tracks.filter(isMainVideoTrack).length
  const count = next.tracks.filter(isOverlayTrack).length
  next.tracks.splice(offset + clamp(Math.round(overlayIndex), 0, count), 0, track)
  return finish(next)
}

export function updateClip(doc: TimelineDoc, id: string, patch: { volume?: number; fadeInMs?: number; fadeOutMs?: number; overlay?: OverlayPlacement }): EditResult {
  const next = copy(doc)
  const entry = find(next, id)
  if (!entry) return { ok: false, reason: 'missing' }
  const clip = entry.clip
  if (patch.overlay !== undefined) {
    if (!isOverlayTrack(entry.track)) return { ok: false, reason: 'kind' }
    clip.overlay = structuredClone(patch.overlay)
  }
  if (patch.volume !== undefined) clip.volume = clamp(patch.volume, 0, 2)
  if (patch.fadeInMs !== undefined) clip.fadeInMs = Math.round(clamp(patch.fadeInMs, 0, Math.min(10_000, clipDurationMs(clip) - clip.fadeOutMs)))
  if (patch.fadeOutMs !== undefined) clip.fadeOutMs = Math.round(clamp(patch.fadeOutMs, 0, Math.min(10_000, clipDurationMs(clip) - clip.fadeInMs)))
  return finish(next)
}

export function useNewVersion(doc: TimelineDoc, id: string, assetVersionId: string, bounds: SourceBounds): EditResult {
  const next = copy(doc)
  const entry = find(next, id)
  if (!entry) return { ok: false, reason: 'missing' }
  if (isAudioTrack(entry.track) ? bounds.kind === 'image' : bounds.kind === 'audio') return { ok: false, reason: 'kind' }
  const clip = entry.clip
  if (bounds.kind !== 'image' && !(bounds.durationMs && bounds.durationMs >= 1)) return { ok: false, reason: 'duration' }
  clip.source.assetVersionId = assetVersionId
  if (bounds.kind === 'image') {
    const duration = clamp(clipDurationMs(clip), TIMELINE_LIMITS.imageMinMs, imageMaxMs(entry.track))
    delete clip.speed
    clip.inMs = 0
    clip.outMs = duration
  } else {
    clip.inMs = Math.min(clip.inMs, bounds.durationMs! - 1)
    clip.outMs = Math.min(clip.outMs, bounds.durationMs!)
  }
  fitFades(clip)
  if (isMainVideoTrack(entry.track)) ripple(entry.track)
  return finish(next)
}

export function setSpeed(doc: TimelineDoc, id: string, speed: number, bounds?: SourceBounds): EditResult {
  if (!Number.isFinite(speed) || speed < TIMELINE_LIMITS.minSpeed || speed > TIMELINE_LIMITS.maxSpeed || Math.abs(speed * 100 - Math.round(speed * 100)) > 1e-9) return { ok: false, reason: 'invalid' }
  const next = copy(doc)
  const entry = find(next, id)
  if (!entry) return { ok: false, reason: 'missing' }
  const { clip, track } = entry
  if (bounds?.kind === 'image') return { ok: false, reason: 'kind' }
  let chosen = speed
  if (!isMainVideoTrack(track)) {
    const available = (track.clips[track.clips.indexOf(clip) + 1]?.startMs ?? TIMELINE_LIMITS.maxDurationMs) - clip.startMs
    // Search the contract's hundredths so rounding to milliseconds cannot cross a neighbor.
    while (chosen <= TIMELINE_LIMITS.maxSpeed && clipDurationMs({ ...clip, speed: chosen }) > available) chosen = (Math.round(chosen * 100) + 1) / 100
    if (chosen > TIMELINE_LIMITS.maxSpeed) return { ok: false, reason: 'overlap' }
  }
  clip.speed = chosen
  fitFades(clip)
  if (isMainVideoTrack(track)) ripple(track)
  return finish(next, { boundHit: chosen !== speed })
}

export function setTransition(doc: TimelineDoc, id: string, transition: TimelineTransition | null): EditResult {
  if (transition && (!['crossfade', 'dip'].includes(transition.kind) || !Number.isFinite(transition.durationMs))) return { ok: false, reason: 'invalid' }
  const next = copy(doc)
  const entry = find(next, id)
  if (!entry) return { ok: false, reason: 'missing' }
  const { clip, track } = entry
  const index = track.clips.indexOf(clip)
  if (!isMainVideoTrack(track) || !index) return { ok: false, reason: 'kind' }
  let boundHit = false
  if (transition) {
    const previous = track.clips[index - 1]!
    const allowed = Math.min(
      clipDurationMs(previous) - (previous.transitionIn?.durationMs ?? 0),
      clipDurationMs(clip) - (track.clips[index + 1]?.transitionIn?.durationMs ?? 0),
      TIMELINE_LIMITS.transitionMaxMs,
    )
    const durationMs = Math.min(Math.max(TIMELINE_LIMITS.transitionMinMs, Math.round(transition.durationMs)), allowed)
    if (durationMs < TIMELINE_LIMITS.transitionMinMs) return { ok: false, reason: 'duration' }
    clip.transitionIn = { kind: transition.kind, durationMs }
    boundHit = durationMs !== transition.durationMs
  } else delete clip.transitionIn
  ripple(track)
  return finish(next, { boundHit })
}

export type ClipDifference = { type: 'added' | 'removed' | 'changed'; clipId: string; trackId: string; trackName?: string | undefined; startMs: number }
export function diffClips(before: TimelineDoc, after: TimelineDoc): ClipDifference[] {
  const flatten = (doc: TimelineDoc) => new Map(doc.tracks.flatMap(track => track.clips.map(clip => [clip.id, { clip, track }] as const)))
  const a = flatten(before)
  const b = flatten(after)
  const differences: ClipDifference[] = []
  for (const [id, entry] of a) {
    const other = b.get(id)
    if (!other || other.track.id !== entry.track.id || !sameClip(other.clip, entry.clip)) {
      const selected = other ?? entry
      differences.push({ type: other ? 'changed' : 'removed', clipId: id, trackId: selected.track.id, trackName: selected.track.name, startMs: selected.clip.startMs })
    }
  }
  for (const [id, entry] of b) if (!a.has(id)) differences.push({ type: 'added', clipId: id, trackId: entry.track.id, trackName: entry.track.name, startMs: entry.clip.startMs })
  return differences.sort((a, b) => a.startMs - b.startMs)
}
