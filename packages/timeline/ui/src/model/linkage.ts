import { TIMELINE_LIMITS, clipEndMs, isMainVideoTrack, textClipEndMs, type TimelineDoc } from '@vis/protocol'

/**
 * Caption linkage (RFC 0024 d.4): text that starts inside a video clip moves with that clip and is
 * deleted with it. Applied by the draft to every editor edit while the toggle is on, never to undo,
 * redo or documents from the server. Refuses the whole edit when moved text would overlap other
 * text on its track or exceed the length limit.
 */
export function linkCaptions(before: TimelineDoc, after: TimelineDoc): { ok: true; doc: TimelineDoc } | { ok: false; reason: 'captions' } {
  const videos = before.tracks.filter(isMainVideoTrack).flatMap(track => track.clips)
  const remaining = new Map(after.tracks.filter(isMainVideoTrack).flatMap(track => track.clips).map(clip => [clip.id, clip]))
  if (!videos.some(clip => !remaining.has(clip.id) || remaining.get(clip.id)!.startMs !== clip.startMs)) return { ok: true, doc: after }
  const previousText = new Map((before.textTracks ?? []).flatMap(track => track.clips).map(clip => [clip.id, clip]))
  const textTracks = (after.textTracks ?? []).map(track => ({
    ...track,
    clips: track.clips.flatMap(clip => {
      const previous = previousText.get(clip.id)
      if (!previous) return [clip]
      // Reverse order makes the incoming shot own captions in a transition overlap.
      const owner = videos.findLast(video => previous.startMs >= video.startMs && previous.startMs < clipEndMs(video))
      if (!owner) return [clip]
      const next = remaining.get(owner.id)
      if (!next) return []
      const delta = next.startMs - owner.startMs
      return [delta ? { ...clip, startMs: clip.startMs + delta } : clip]
    }).sort((a, b) => a.startMs - b.startMs),
  }))
  for (const track of textTracks) for (let i = 0; i < track.clips.length; i++) {
    const clip = track.clips[i]!
    if (clip.startMs < 0 || textClipEndMs(clip) > TIMELINE_LIMITS.maxDurationMs || (i > 0 && clip.startMs < textClipEndMs(track.clips[i - 1]!))) return { ok: false, reason: 'captions' }
  }
  return { ok: true, doc: { ...after, ...(after.textTracks ? { textTracks } : {}) } }
}
