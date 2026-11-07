import { clipDurationMs, clipEndMs, type TimelineClip, type TimelineDoc, type TimelineTrack, type TimelineTransition } from '@vis/protocol'

export function activeClips(track: TimelineTrack | undefined, ms: number): TimelineClip[] {
  return track?.clips.filter(clip => clip.startMs <= ms && clipEndMs(clip) > ms) ?? []
}

export function activeClip(track: TimelineTrack | undefined, ms: number): TimelineClip | undefined {
  return activeClips(track, ms).at(-1)
}

export function transitionOpacity(kind: TimelineTransition['kind'], progress: number) {
  const p = Math.max(0, Math.min(1, progress))
  return kind === 'crossfade' ? { outgoing: 1 - p, incoming: p } : { outgoing: Math.max(0, 1 - p * 2), incoming: Math.max(0, p * 2 - 1) }
}

export function visualClips(track: TimelineTrack | undefined, ms: number) {
  const clips = activeClips(track, ms)
  const incoming = clips.at(-1)
  const transition = incoming?.transitionIn
  if (clips.length < 2 || !transition) return clips.map(clip => ({ clip, opacity: 1, blend: false }))
  const opacity = transitionOpacity(transition.kind, (ms - incoming.startMs) / transition.durationMs)
  return clips.map((clip, index) => ({ clip, opacity: index ? opacity.incoming : opacity.outgoing, blend: transition.kind === 'crossfade' }))
}

export function upcomingClips(doc: TimelineDoc, ms: number, lookaheadMs = 500) {
  return doc.tracks.flatMap(track => track.clips
    .filter(clip => clipEndMs(clip) > ms && clip.startMs <= ms + lookaheadMs)
    .map(clip => ({ track, clip })))
}

export function nextVideoClip(track: TimelineTrack | undefined, ms: number) {
  return track?.clips.find(clip => clip.startMs > ms)
}

type Fades = Pick<TimelineClip, 'fadeInMs' | 'fadeOutMs'>

export function clipGain(clip: TimelineClip, ms: number, fades: Fades = clip): number {
  const local = ms - clip.startMs
  const duration = clipDurationMs(clip)
  if (local < 0 || local >= duration) return 0
  const fadeIn = fades.fadeInMs ? Math.min(1, local / fades.fadeInMs) : 1
  const fadeOut = fades.fadeOutMs ? Math.min(1, (duration - local) / fades.fadeOutMs) : 1
  return clip.volume * fadeIn * fadeOut
}

export function gainRamp(clip: TimelineClip, ms: number, fades: Fades = clip) {
  const end = clipEndMs(clip)
  if (fades.fadeInMs + fades.fadeOutMs > clipDurationMs(clip)) {
    // Effective fades can intersect; their product is curved, unlike each individual linear fade.
    const start = Math.max(ms, clip.startMs)
    const points = [start, clip.startMs + fades.fadeInMs, end - fades.fadeOutMs, end]
    for (let at = Math.max(start, end - fades.fadeOutMs); at < Math.min(end, clip.startMs + fades.fadeInMs); at += 10) points.push(at)
    return [...new Set(points.filter(at => at >= start && at <= end))].sort((a, b) => a - b).map(at => ({ ms: at, gain: clipGain(clip, at, fades) }))
  }
  return [
    { ms: Math.max(ms, clip.startMs), gain: clipGain(clip, Math.max(ms, clip.startMs), fades) },
    ...(fades.fadeInMs && clip.startMs + fades.fadeInMs > ms ? [{ ms: clip.startMs + fades.fadeInMs, gain: clip.volume }] : []),
    ...(fades.fadeOutMs && end - fades.fadeOutMs > ms ? [{ ms: end - fades.fadeOutMs, gain: clip.volume }] : []),
    { ms: end, gain: 0 },
  ]
}

export function shouldRealign(actualSeconds: number, expectedMs: number): boolean {
  return Math.abs(actualSeconds * 1000 - expectedMs) > 80
}
