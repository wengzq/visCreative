import type { EditorPartProps } from '../types'
import { useRef, useState, type PointerEvent } from 'react'
import { textClipEndMs, type TextClip } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { timelineEditorMessages } from '../messages'
import { pxToTime, snapCandidates, snapTime, timecode, timeToPx } from '../model/geometry'
import { removeTextTrack, updateText, updateTextTrack } from '../model/text'
import type { EditResult } from '../model/edit'
import './text.css'

export type TextLanesProps = EditorPartProps & {
  zoom: number
  contentWidth: number
  /** Visible time range; clips outside it are not rendered */
  viewport: { fromMs: number; toMs: number }
  fps: number
  setNotice(text: string): void
  snap: boolean
}

export function TextLanes({ draft, clock, selection, select, zoom, contentWidth, viewport, fps, setNotice, snap }: TextLanesProps) {
  const m = useMessages(timelineEditorMessages)
  const f = useFormat()
  const active = useRef<{ clip: TextClip; x: number; edge: 'move' | 'in' | 'out'; result: EditResult; moved: boolean } | null>(null)
  const [ghost, setGhost] = useState<{ id: string; startMs: number; durationMs: number; invalid: boolean; guide: number | null } | null>(null)
  const apply = (result: EditResult) => {
    if (draft.conflict) return
    if (!result.ok) { setNotice(result.reason === 'overlap' ? m.textOverlap : m[result.reason]); return }
    const refused = draft.edit(result.doc, { immediate: true })
    setNotice(refused ? m[refused] : '')
  }
  const start = (event: PointerEvent, clip: TextClip, edge: 'move' | 'in' | 'out') => {
    if (event.button !== 0 || draft.conflict) return
    event.stopPropagation()
    if (edge === 'move' && (event.shiftKey || event.ctrlKey || event.metaKey)) select(selection.includes(clip.id) ? selection.filter(id => id !== clip.id) : [...selection, clip.id])
    else if (!selection.includes(clip.id)) select([clip.id])
    event.currentTarget.setPointerCapture(event.pointerId)
    active.current = { clip, x: event.clientX, edge, result: { ok: true, doc: draft.doc }, moved: false }
  }
  const move = (event: PointerEvent) => {
    const drag = active.current
    if (!drag) return
    const delta = pxToTime(event.clientX - drag.x, zoom)
    if (Math.abs(event.clientX - drag.x) > 2) drag.moved = true
    const candidates = snapCandidates(draft.doc, clock.now(), [drag.clip.id])
    const at = (drag.edge === 'out' ? textClipEndMs(drag.clip) : drag.clip.startMs) + delta
    const snapped = snap && !event.altKey ? snapTime(at, candidates, zoom) : { time: Math.max(0, at), guide: null }
    if (drag.edge === 'move' && snap && !event.altKey) {
      const endSnap = snapTime(at + drag.clip.durationMs, candidates, zoom)
      if (endSnap.guide !== null && (snapped.guide === null || Math.abs(endSnap.time - at - drag.clip.durationMs) < Math.abs(snapped.time - at))) {
        snapped.time = Math.max(0, endSnap.time - drag.clip.durationMs)
        snapped.guide = endSnap.guide
      }
    }
    const end = textClipEndMs(drag.clip)
    const startMs = drag.edge === 'out' ? drag.clip.startMs : drag.edge === 'in' ? Math.min(end - 200, snapped.time) : snapped.time
    const durationMs = drag.edge === 'move' ? drag.clip.durationMs : drag.edge === 'in' ? end - startMs : Math.max(200, snapped.time - startMs)
    drag.result = updateText(draft.doc, drag.clip.id, { startMs, durationMs })
    setGhost({ id: drag.clip.id, startMs, durationMs, invalid: !drag.result.ok, guide: snapped.guide })
  }
  const end = (cancel = false) => {
    if (active.current?.moved && !cancel) apply(active.current.result)
    active.current = null
    setGhost(null)
  }
  return <>{(draft.doc.textTracks ?? []).map((track, index) => <div key={track.id} role="group" aria-label={track.name ?? m.textTrack(f.number(index + 1))} className={`vis-tl-track is-text${track.hidden ? ' is-muted' : ''}`}>
    <div className="vis-tl-track-header">
      <input className="vis-tl-track-name" aria-label={m.textTrackName} maxLength={100} defaultValue={track.name ?? m.textTrack(f.number(index + 1))} key={`${track.id}:${track.name}`} disabled={!!draft.conflict}
        onBlur={event => { if (event.target.value !== (track.name ?? m.textTrack(f.number(index + 1)))) apply(updateTextTrack(draft.doc, track.id, { name: event.target.value })) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
      <button aria-label={track.hidden ? m.showTextTrack : m.hideTextTrack} aria-pressed={track.hidden} disabled={!!draft.conflict} onClick={() => apply(updateTextTrack(draft.doc, track.id, { hidden: !track.hidden }))}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5Z" /><circle cx="8" cy="8" r="2" />{track.hidden && <path d="m2 2 12 12" />}</svg>
      </button>
      <button aria-label={m.removeTextTrack} disabled={!!draft.conflict} onClick={() => { apply(removeTextTrack(draft.doc, track.id)); select(selection.filter(id => !track.clips.some(clip => clip.id === id))) }}>&#215;</button>
    </div>
    <div className="vis-tl-lane" style={{ width: contentWidth }}>
      {track.clips.filter(clip => textClipEndMs(clip) >= viewport.fromMs && clip.startMs <= viewport.toMs).map(clip => <div key={clip.id} role="button" tabIndex={0} aria-selected={selection.includes(clip.id)} data-clip-id={clip.id}
        aria-label={m.clipLabel(clip.text.split('\n')[0]!, timecode(clip.startMs, fps, f.number), timecode(textClipEndMs(clip), fps, f.number))}
        className={`vis-tl-clip is-text${selection.includes(clip.id) ? ' is-selected' : ''}`} style={{ left: timeToPx(clip.startMs, zoom), width: Math.max(2, timeToPx(clip.durationMs, zoom) - 1) }}
        onPointerDown={event => start(event, clip, 'move')} onPointerMove={move} onPointerUp={() => end()} onPointerCancel={() => end(true)}
        onKeyDown={event => { if (event.key === 'Enter') select([clip.id]) }}>
        <span className="vis-tl-clip-label">{clip.text.split('\n')[0]}</span>
        {(['in', 'out'] as const).map(edge => <span key={edge} role="slider" tabIndex={selection.includes(clip.id) ? 0 : -1}
          aria-label={edge === 'in' ? m.textTrimStart : m.textTrimEnd} aria-valuemin={0} aria-valuemax={1_800_000} aria-valuenow={edge === 'in' ? clip.startMs : textClipEndMs(clip)}
          className={`vis-tl-trim is-${edge}`} title={edge === 'in' ? m.in : m.out}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault(); event.stopPropagation()
            const delta = (event.key === 'ArrowLeft' ? -1 : 1) * Math.round(event.shiftKey ? 1000 : 1000 / fps)
            const startMs = edge === 'in' ? Math.max(0, Math.min(textClipEndMs(clip) - 200, clip.startMs + delta)) : clip.startMs
            const durationMs = edge === 'in' ? textClipEndMs(clip) - startMs : Math.max(200, clip.durationMs + delta)
            apply(updateText(draft.doc, clip.id, { startMs, durationMs }))
          }}
          onPointerDown={event => start(event, clip, edge)} onPointerMove={move} onPointerUp={event => { event.stopPropagation(); end() }} onPointerCancel={() => end(true)} />)}
      </div>)}
      {ghost && track.clips.some(clip => clip.id === ghost.id) && <><div className={`vis-tl-ghost${ghost.invalid ? ' is-invalid' : ''}`} style={{ top: 0, height: 48, left: timeToPx(ghost.startMs, zoom), width: timeToPx(ghost.durationMs, zoom) }}>{timecode(ghost.startMs, fps, f.number)}</div>
        {ghost.guide !== null && <div className="vis-tl-snap-guide" style={{ left: timeToPx(ghost.guide, zoom), height: 48 }} />}</>}
    </div>
  </div>)}</>
}
