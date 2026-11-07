import { memo, useEffect, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { clipDurationMs, clipEndMs, isAudioTrack, isMainVideoTrack, isOverlayTrack, sourceTimeAt, TIMELINE_LIMITS, timelineDurationMs, type TimelineClip, type TimelineDoc, type TimelineTrack } from '@vis/protocol'
import { PeaksWaveform, useFormat, useMessages } from '@vis/ui-kit'
import type { EditorPartProps } from './types'
import { TextLanes } from './text/TextLanes'
import { addText, deleteText, locateText, TEXT_LANE_HEIGHT } from './model/text'
import { timelineEditorMessages } from './messages'
import { addAudioTrack, addOverlayTrack, canPlace, deleteClips, diffClips, duplicateClip, insertVideo, locateClip, moveAudio, moveOverlay, moveVideo, newId, placeAudio, placeOverlay, removeAudioTrack, removeOverlayTrack, reorderAudioTrack, reorderOverlayTrack, setTransition, splitClip, trimClip, trimImageClip, updateClip, updateTrack, useNewVersion, type EditResult, type SourceBounds } from './model/edit'
import { HEADER_WIDTH, pxToTime, snapCandidates, snapTime, timecode, timeToPx, visibleWindow } from './model/geometry'
import { acceptsMedia, mediaClip, nodeAsset, trackSourceKind, MEDIA_DRAG_TYPE, TRACK_DRAG_TYPE } from './model/media'
import { useMediaResources } from './model/resources'
import { effectiveFps } from './model/output'
import { VolumeControl } from './Inspector'
import { subscribePlaybackFrames } from './player'
import './timeline-area.css'

type DragMode = 'move' | 'in' | 'out' | 'fadeIn' | 'fadeOut'
type Drag = {
  id: string; mode: DragMode; originX: number; trackId: string; startMs: number; inMs: number; outMs: number
  value: number; guide: number | null; index: number; invalid: boolean; boundHit: boolean; moved: boolean
}
type Marquee = { x: number; y: number; endX: number; endY: number; keep: readonly string[] }
const colors = ['var(--vis-frame-teal)', 'var(--vis-frame-amber)', 'var(--vis-frame-violet)', 'var(--vis-frame-blue)']
const MIN_ZOOM = 0.2
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const laneTracks = (doc: TimelineDoc) => [...doc.tracks.filter(isOverlayTrack).reverse(), ...doc.tracks.filter(isMainVideoTrack), ...doc.tracks.filter(isAudioTrack)]
const trackHeight = (track: TimelineTrack) => isMainVideoTrack(track) ? 64 : 48

type ClipViewProps = {
  clip: TimelineClip; track: TimelineTrack; host: EditorPartProps['host']; color: string; selected: boolean; zoom: number; fps: number
  viewport: { fromMs: number; toMs: number }; startDrag(event: ReactPointerEvent, mode: DragMode): void
  selectClip(event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): void; context(event: React.MouseEvent): void; boundHit: boolean
  selectionKey: string
  changeFade(mode: 'fadeIn' | 'fadeOut', deltaMs: number): void
}
const ClipView = memo(function ClipView({ clip, track, host, color, selected, zoom, fps, viewport, startDrag, selectClip, context, boundHit, changeFade }: ClipViewProps) {
  const m = useMessages(timelineEditorMessages)
  const f = useFormat()
  const source = host.nodes.find(node => node.nodeId === clip.source.nodeId)
  const cache = useMediaResources(host)
  const image = (cache.info.get(clip.source.assetVersionId)?.kind ?? source?.kind ?? trackSourceKind(track.kind)) === 'image'
  const kind = isAudioTrack(track) ? 'peaks' : 'filmstrip'
  useEffect(() => { if (!image) void cache.preview(clip.source.assetVersionId, kind) }, [cache, clip.source.assetVersionId, kind, image])
  const preview = cache.previews.get(`${kind}:${clip.source.assetVersionId}`)
  const unavailable = cache.errors.has(`info:${clip.source.assetVersionId}`)
  const currentAsset = source ? nodeAsset(source) : null
  const newer = currentAsset && currentAsset.assetVersionId !== clip.source.assetVersionId
  const title = source?.title ?? (image ? m.image : isAudioTrack(track) ? m.audioKind : m.video)
  const duration = clipDurationMs(clip)
  const width = timeToPx(duration, zoom)
  const url = image ? host.assetUrl(clip.source.assetVersionId) : preview?.kind === 'filmstrip' ? host.filmstripUrl(clip.source.assetVersionId) : undefined
  const from = Math.max(clip.startMs, viewport.fromMs)
  const to = Math.min(clipEndMs(clip), viewport.toMs)
  const style: CSSProperties = {
    left: timeToPx(clip.startMs, zoom), width: Math.max(2, width - 1),
    '--vis-tl-track-color': color,
    ...(url ? { backgroundImage: `url(${JSON.stringify(url)})`, backgroundSize: image ? 'auto 100%' : preview?.kind === 'filmstrip' ? `${timeToPx(preview.intervalMs / (clip.speed ?? 1), zoom) * preview.frames}px 100%` : undefined, backgroundPositionX: -timeToPx(clip.inMs / (clip.speed ?? 1), zoom) } : {}),
  } as CSSProperties
  return <div role="button" tabIndex={0} aria-selected={selected} aria-label={m.clipLabel(title, timecode(clip.startMs, fps, f.number), timecode(clipEndMs(clip), fps, f.number))}
    title={`${title} · ${timecode(duration, fps, f.number)}`} data-clip-id={clip.id}
    className={`vis-tl-clip is-${track.kind}${selected ? ' is-selected' : ''}${boundHit ? ' is-bound' : ''}${unavailable ? ' is-unavailable' : ''}`} style={style}
    onPointerDown={event => { if (event.button !== 0) return; event.stopPropagation(); selectClip(event); startDrag(event, 'move') }}
    onContextMenu={context} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); selectClip(event) } }}
    onFocus={event => { if (event.target === event.currentTarget && !selected) event.currentTarget.setAttribute('data-focused', 'true') }}>
    {preview?.kind === 'peaks' && <div className="vis-tl-clip-wave" style={{ left: timeToPx(from - clip.startMs, zoom), width: timeToPx(to - from, zoom) }}>
      <PeaksWaveform peaks={preview.peaks} binsPerSecond={preview.binsPerSecond} fromMs={sourceTimeAt(clip, from)} toMs={sourceTimeAt(clip, to)} height={38} color={track.muted ? 'var(--vis-text-faint)' : color} />
    </div>}
    {(['fadeIn', 'fadeOut'] as const).map(mode => {
      const fade = mode === 'fadeIn' ? clip.fadeInMs : clip.fadeOutMs
      return <span key={mode} className={`vis-tl-fade is-${mode}`} style={{ width: Math.max(8, timeToPx(fade, zoom)) }}>
        <span className="vis-tl-fade-ramp" /><span className="vis-tl-fade-handle" role="slider" tabIndex={selected ? 0 : -1} aria-label={mode === 'fadeIn' ? m.fadeIn : m.fadeOut} aria-valuemin={0} aria-valuemax={Math.min(10_000, duration)} aria-valuenow={fade}
          onPointerDown={event => { event.stopPropagation(); startDrag(event, mode) }}
          onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); changeFade(mode, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1000 : Math.round(1000 / fps))) } }} />
      </span>
    })}
    {width >= 48 && <span className="vis-tl-clip-label">{image ? <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="2" /><path d="m2 11 4-4 3 3 2-2 3 3" /></svg> : null}{unavailable ? m.unavailable : title}{!isAudioTrack(track) && source?.kind === 'video' && <span className="vis-tl-clip-audio" title={m.clipAudio}><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={clip.volume === 0 ? 'M2 6h3l3-3v10l-3-3H2zM11 6l3 4m0-4-3 4' : 'M2 6h3l3-3v10l-3-3H2zM11 5c3 2 3 4 0 6'} /></svg>{clip.volume !== 1 && m.percent(f.number(Math.round(clip.volume * 100)))}</span>}</span>}
    <span className="vis-tl-badges">{(clip.speed ?? 1) !== 1 && <span className="vis-tl-speed-badge">{m.speedValue(f.number(clip.speed!))}</span>}{newer && <span title={m.newVersion} aria-label={m.newVersion} className="vis-tl-new-version">!</span>}{!source && <span title={m.sourceDeleted} aria-label={m.sourceDeleted}><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 4 1-1c4-4 8 0 4 4l-1 1m-4 4-1 1c-4 4-8 0-4-4l1-1M5 6l5 4M2 2l12 12" /></svg></span>}</span>
    {(['in', 'out'] as const).map(edge => <span key={edge} className={`vis-tl-trim is-${edge}`} title={edge === 'in' ? m.in : m.out} onPointerDown={event => { event.stopPropagation(); startDrag(event, edge) }} />)}
  </div>
}, (a, b) => {
  // Pointer moves only redraw the ghost; callbacks stay current when their document or selection changes.
  return a.clip === b.clip && a.track === b.track && a.host === b.host && a.color === b.color && a.selected === b.selected &&
    a.zoom === b.zoom && a.fps === b.fps && a.viewport.fromMs === b.viewport.fromMs && a.viewport.toMs === b.viewport.toMs && a.boundHit === b.boundHit && a.selectionKey === b.selectionKey
})

export function TimelineArea({ host, draft, clock, selection, select }: EditorPartProps) {
  const m = useMessages(timelineEditorMessages)
  const f = useFormat()
  const scroller = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const playhead = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLButtonElement>(null)
  const [zoom, setZoom] = useState(60)
  const [snap, setSnap] = useState(true)
  const [viewport, setViewport] = useState({ left: 0, width: 800 })
  const [drag, renderDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const marqueeRef = useRef<Marquee | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; at: number } | null>(null)
  const [cut, setCut] = useState<{ id: string; x: number; y: number } | null>(null)
  const [cutDuration, setCutDuration] = useState('500')
  const cutButton = useRef<HTMLButtonElement | null>(null)
  const closeCut = () => { setCut(null); cutButton.current?.focus() }
  const [showDiff, setShowDiff] = useState(false)
  const [notice, setNotice] = useState('')
  const [flashed, setFlashed] = useState<string | null>(null)
  const [dropState, setDropState] = useState<{ id: string; invalid: boolean } | null>(null)
  const [overlayDragging, setOverlayDragging] = useState(false)
  const [trackMenu, setTrackMenu] = useState(false)
  const trackMenuButton = useRef<HTMLButtonElement>(null)
  const trackMenuPanel = useRef<HTMLDivElement>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const emptyTracks = useRef<TimelineTrack[]>([
    { id: newId({ version: 1, tracks: [] }), kind: 'video', muted: false, volume: 1, clips: [] },
    { id: newId({ version: 1, tracks: [] }), kind: 'audio', muted: false, volume: 1, clips: [] },
  ])
  const doc: TimelineDoc = {
    ...draft.doc,
    tracks: draft.doc.tracks.length ? draft.doc.tracks : emptyTracks.current,
  }
  const ids = doc.tracks.flatMap(track => track.clips.map(clip => clip.source.assetVersionId))
  const cache = useMediaResources(host, ids)
  const first = doc.tracks.find(isMainVideoTrack)?.clips[0]
  const fps = effectiveFps(doc.output, first ? cache.info.get(first.source.assetVersionId) : undefined)
  const duration = timelineDurationMs(doc)
  const textHeight = (doc.textTracks?.length ?? 0) * TEXT_LANE_HEIGHT
  const overlays = doc.tracks.filter(isOverlayTrack)
  const displayTracks = laneTracks(doc)
  const showNewOverlay = overlayDragging && !draft.conflict && overlays.length < TIMELINE_LIMITS.overlayTracks
  const newOverlayHeight = showNewOverlay ? 52 : 0
  const laneTop = (id: string) => 24 + textHeight + newOverlayHeight + displayTracks.slice(0, displayTracks.findIndex(track => track.id === id)).reduce((sum, track) => sum + trackHeight(track) + 4, 0)
  const contentWidth = Math.max(viewport.width - HEADER_WIDTH, timeToPx(Math.max(duration + 5000, 10_000), zoom))
  const windowMs = visibleWindow(Math.max(0, viewport.left - HEADER_WIDTH), viewport.width, zoom)
  const trackName = (track: TimelineTrack) => track.name ?? (isMainVideoTrack(track) ? m.video : isOverlayTrack(track) ? m.overlay(f.number(overlays.indexOf(track) + 1)) : [m.music, m.soundEffects, m.voice][doc.tracks.filter(isAudioTrack).indexOf(track)] ?? m.audio(f.number(doc.tracks.filter(isAudioTrack).indexOf(track) + 1)))
  const bounds = (clip: TimelineClip): SourceBounds => ({
    kind: (cache.info.get(clip.source.assetVersionId)?.kind ?? host.nodes.find(node => node.nodeId === clip.source.nodeId)?.kind) === 'image' ? 'image' : trackSourceKind(locateClip(doc, clip.id)?.track.kind ?? 'video'),
    durationMs: cache.info.get(clip.source.assetVersionId)?.durationMs,
  })
  const apply = (result: EditResult) => {
    if (draft.conflict) return
    if (result.ok) { const refused = draft.edit(result.doc, { immediate: true }); setNotice(refused ? m[refused] : result.boundHit ? m.bound : '') }
    else setNotice(m[result.reason])
  }
  const removeSelection = () => {
    const next = deleteText(doc, selection)
    const media = selection.filter(id => !locateText(doc, id))
    apply(media.length ? deleteClips(next, media) : { ok: true, doc: next })
    select([])
  }
  const transformSelection = (fn: (current: TimelineDoc, id: string) => EditResult) => {
    let next = doc
    for (const id of selection) {
      const result = fn(next, id)
      if (!result.ok) { setNotice(m[result.reason]); return }
      next = result.doc
    }
    apply({ ok: true, doc: next })
  }
  const split = (at = clock.now(), only?: readonly string[]) => {
    let next = doc
    const targets = only ?? (selection.length ? selection : doc.tracks.flatMap(track => track.clips.filter(clip => clip.startMs < at && clipEndMs(clip) > at).map(clip => clip.id)))
    for (const id of targets) {
      const clip = locateClip(next, id)?.clip
      if (!clip || at <= clip.startMs || at >= clipEndMs(clip)) continue
      const result = splitClip(next, id, at, bounds(clip))
      if (result.ok) next = result.doc
      else setNotice(m[result.reason])
    }
    if (next !== doc) apply({ ok: true, doc: next })
  }
  const fit = () => {
    setZoom(clamp((viewport.width - HEADER_WIDTH - 32) * 1000 / Math.max(1000, duration), MIN_ZOOM, 600))
    if (scroller.current) scroller.current.scrollLeft = 0
  }
  const zoomAt = (next: number, pointer?: number) => {
    const el = scroller.current
    const x = pointer ?? viewport.width / 2
    const time = pxToTime((el?.scrollLeft ?? 0) + x - HEADER_WIDTH, zoom)
    const z = clamp(next, MIN_ZOOM, 600)
    setZoom(z)
    if (el) requestAnimationFrame(() => { el.scrollLeft = timeToPx(time, z) - x + HEADER_WIDTH })
  }
  const pointerTime = (clientX: number) => pxToTime(clientX - (scroller.current?.getBoundingClientRect().left ?? 0) + (scroller.current?.scrollLeft ?? 0) - HEADER_WIDTH, zoom)
  const setDrag = (next: Drag | null) => { dragRef.current = next; renderDrag(next) }
  function dropMedia(event: ReactDragEvent, track?: TimelineTrack) {
    event.preventDefault(); setDropState(null); setOverlayDragging(false)
    const node = host.nodes.find(node => node.nodeId === event.dataTransfer.getData(MEDIA_DRAG_TYPE))
    if (!node || !acceptsMedia(track?.kind ?? 'overlay', node.kind) || draft.conflict) { setNotice(m.invalidDrop); return }
    let next = doc
    let target = track
    if (!target) {
      const result = addOverlayTrack(next)
      if (!result.ok) { apply(result); return }
      next = result.doc
      target = next.tracks.find(candidate => isOverlayTrack(candidate) && !doc.tracks.some(existing => existing.id === candidate.id))
      if (!target) return
    }
    const asset = nodeAsset(node)
    const clip = mediaClip(next, node, asset ? cache.info.get(asset.assetVersionId)?.durationMs : undefined, target.kind)
    if (!clip) { setNotice(m.loadingMetadata); return }
    const at = Math.max(0, pointerTime(event.clientX))
    if (isMainVideoTrack(target)) {
      const index = target.clips.findIndex(candidate => at < candidate.startMs + clipDurationMs(candidate) / 2)
      apply(insertVideo(next, [clip], index < 0 ? target.clips.length : index))
    } else {
      const snapped = snap && !event.altKey ? snapTime(at, snapCandidates(next, clock.now()), zoom).time : at
      apply(isOverlayTrack(target) ? placeOverlay(next, target.id, clip, snapped, { kind: node.kind as 'image' | 'video', durationMs: asset ? cache.info.get(asset.assetVersionId)?.durationMs : undefined }) : placeAudio(next, target.id, clip, snapped))
    }
  }
  function startDrag(event: ReactPointerEvent, id: string, mode: DragMode) {
    if (draft.conflict || event.button !== 0) return
    const entry = locateClip(doc, id)
    if (!entry) return
    event.currentTarget.setPointerCapture(event.pointerId)
    if (mode !== 'move') select(selection.includes(id) ? selection : [id])
    const clip = entry.clip
    setDrag({ id, mode, originX: pointerTime(event.clientX), trackId: entry.track.id, startMs: clip.startMs, inMs: clip.inMs, outMs: clip.outMs, value: 0, guide: null, index: entry.track.clips.indexOf(clip), invalid: false, boundHit: false, moved: false })
  }
  function moveDrag(event: ReactPointerEvent) {
    const active = dragRef.current
    if (!active || draft.conflict) return
    const entry = locateClip(doc, active.id)
    if (!entry) return
    const delta = pointerTime(event.clientX) - active.originX
    const next = { ...active, moved: active.moved || Math.abs(delta) > pxToTime(2, zoom) }
    const sourceBounds = bounds(entry.clip)
    const targetId = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-track-id]')?.dataset.trackId
    const snapValue = (value: number) => snap && !event.altKey ? snapTime(value, snapCandidates(doc, clock.now(), [active.id]), zoom) : { time: Math.max(0, Math.round(value)), guide: null }
    if (active.mode === 'move') {
      const candidate = entry.clip.startMs + delta
      const snapped = snapValue(candidate)
      const endSnap = snapValue(candidate + clipDurationMs(entry.clip))
      if (!isMainVideoTrack(entry.track) && endSnap.guide !== null && (snapped.guide === null || Math.abs(endSnap.time - candidate - clipDurationMs(entry.clip)) < Math.abs(snapped.time - candidate))) {
        snapped.time = Math.max(0, endSnap.time - clipDurationMs(entry.clip))
        snapped.guide = endSnap.guide
      }
      next.startMs = snapped.time
      next.guide = snapped.guide
      if (isMainVideoTrack(entry.track)) {
        const rest = entry.track.clips.filter(clip => clip.id !== active.id)
        let cursor = 0
        let index = 0
        for (const clip of rest) {
          const start = cursor - (index ? clip.transitionIn?.durationMs ?? 0 : 0)
          if (snapped.time < start + clipDurationMs(clip) / 2) break
          cursor = start + clipDurationMs(clip); index++
        }
        next.index = index
        next.guide = cursor
        next.startMs = cursor
      } else {
        const target = doc.tracks.find(track => track.id === (targetId ?? active.trackId))
        next.trackId = target?.id ?? active.trackId
        next.moved ||= next.trackId !== entry.track.id
        next.invalid = !target || target.kind !== entry.track.kind || !canPlace(target, next.startMs, clipDurationMs(entry.clip), active.id)
      }
    } else if (active.mode === 'in' || active.mode === 'out') {
      const edge = active.mode
      const candidate = (edge === 'in' ? entry.clip.startMs : clipEndMs(entry.clip)) + delta
      const snapped = candidate < 0 && isMainVideoTrack(entry.track) && edge === 'in' ? { time: candidate, guide: null } : snapValue(candidate)
      const shift = snapped.time - (edge === 'in' ? entry.clip.startMs : clipEndMs(entry.clip))
      const image = sourceBounds.kind === 'image'
      if (image) {
        const result = trimImageClip(doc, active.id, edge, snapped.time)
        if (result.ok) {
          const trimmed = locateClip(result.doc, active.id)!.clip
          next.startMs = trimmed.startMs
          next.inMs = trimmed.inMs
          next.outMs = trimmed.outMs
          next.boundHit = !!result.boundHit
          next.value = snapped.time
        }
      } else {
        const anchor = { ...entry.clip, inMs: edge === 'in' ? entry.clip.inMs : entry.clip.outMs }
        const raw = Math.round(sourceTimeAt(anchor, entry.clip.startMs + shift))
        const result = trimClip(doc, active.id, edge, raw, sourceBounds)
        if (result.ok) {
          const trimmed = locateClip(result.doc, active.id)!.clip
          next.inMs = trimmed.inMs
          next.outMs = trimmed.outMs
          next.startMs = trimmed.startMs
          next.boundHit = !!result.boundHit
          next.value = result.value!
        }
      }
      next.guide = snapped.guide
    } else {
      const raw = active.mode === 'fadeIn' ? entry.clip.fadeInMs + delta : entry.clip.fadeOutMs - delta
      next.value = Math.round(clamp(raw, 0, Math.min(10_000, clipDurationMs(entry.clip) - (active.mode === 'fadeIn' ? entry.clip.fadeOutMs : entry.clip.fadeInMs))))
    }
    setDrag(next)
  }
  function endDrag(cancel = false) {
    const active = dragRef.current
    setDrag(null)
    if (!active || cancel || !active.moved || draft.conflict) return
    const entry = locateClip(doc, active.id)
    if (!entry) return
    if (active.invalid) { setNotice(m.overlap); return }
    if (active.mode === 'move') apply(isMainVideoTrack(entry.track) ? moveVideo(doc, active.id, active.index) : isOverlayTrack(entry.track) ? moveOverlay(doc, active.id, active.trackId, active.startMs) : moveAudio(doc, active.id, active.trackId, active.startMs))
    else if (active.mode === 'in' || active.mode === 'out') apply(bounds(entry.clip).kind === 'image' ? trimImageClip(doc, active.id, active.mode, active.value) : trimClip(doc, active.id, active.mode, active.value, bounds(entry.clip)))
    else apply(updateClip(doc, active.id, active.mode === 'fadeIn' ? { fadeInMs: active.value } : { fadeOutMs: active.value }))
    if (active.boundHit) {
      setFlashed(active.id); clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setFlashed(null), 300)
    }
  }
  function marqueeStart(event: ReactPointerEvent) {
    if (draft.conflict || event.button !== 0 || event.target !== event.currentTarget) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const rect = sheet.current!.getBoundingClientRect()
    const next = { x: event.clientX - rect.left, y: event.clientY - rect.top, endX: event.clientX - rect.left, endY: event.clientY - rect.top, keep: event.shiftKey || event.ctrlKey || event.metaKey ? selection : [] }
    marqueeRef.current = next
    setMarquee(next)
    if (!next.keep.length) select([])
  }
  function updateMarquee(event: ReactPointerEvent) {
    const active = marqueeRef.current
    if (!active || !sheet.current) return
    const rect = sheet.current.getBoundingClientRect()
    const next = { ...active, endX: event.clientX - rect.left, endY: event.clientY - rect.top }
    marqueeRef.current = next
    setMarquee(next)
    const left = Math.min(next.x, next.endX) - HEADER_WIDTH
    const right = Math.max(next.x, next.endX) - HEADER_WIDTH
    const top = Math.min(next.y, next.endY)
    const bottom = Math.max(next.y, next.endY)
    let y = 24 + textHeight + newOverlayHeight
    const selected = [...next.keep]
    for (const track of displayTracks) {
      const height = trackHeight(track)
      if (y < bottom && y + height > top) selected.push(...track.clips.filter(clip => timeToPx(clip.startMs, zoom) < right && timeToPx(clipEndMs(clip), zoom) > left).map(clip => clip.id))
      y += height + 4
    }
    select([...new Set(selected)])
  }
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const read = () => setViewport({ left: el.scrollLeft, width: el.clientWidth })
    read()
    const observer = new ResizeObserver(read)
    observer.observe(el)
    el.addEventListener('scroll', read, { passive: true })
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        if (event.shiftKey && event.deltaY) { event.preventDefault(); el.scrollLeft += event.deltaY }
        return
      }
      event.preventDefault()
      zoomAt(zoom * Math.exp(-event.deltaY * 0.01), event.clientX - el.getBoundingClientRect().left)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => { observer.disconnect(); el.removeEventListener('scroll', read); el.removeEventListener('wheel', wheel) }
  }, [zoom])
  useEffect(() => subscribePlaybackFrames(clock, () => {
    const x = timeToPx(clock.now(), zoom)
    if (playhead.current) playhead.current.style.transform = `translateX(${x}px)`
    if (head.current) head.current.style.transform = `translateX(${x}px)`
    const el = scroller.current
    if (clock.playing() && el && (x + HEADER_WIDTH > el.scrollLeft + el.clientWidth - 24 || x < el.scrollLeft)) {
      el.scrollLeft = Math.max(0, x - 24)
    }
  }), [clock, zoom, draft.doc])
  useEffect(() => () => clearTimeout(flashTimer.current), [])
  useEffect(() => {
    const over = (event: DragEvent) => setOverlayDragging(['image', 'video'].some(kind => event.dataTransfer?.types.includes(`${MEDIA_DRAG_TYPE}-${kind}`)))
    const end = () => { setOverlayDragging(false); setDropState(null) }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', end)
    window.addEventListener('dragend', end)
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', end); window.removeEventListener('dragend', end) }
  }, [])
  useEffect(() => {
    if (draft.conflict) { setDrag(null); setMenu(null); setCut(null); setTrackMenu(false); marqueeRef.current = null; setMarquee(null) }
  }, [draft.conflict])
  useEffect(() => { if (trackMenu) trackMenuPanel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [trackMenu])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && cut) { event.preventDefault(); event.stopImmediatePropagation(); closeCut(); return }
      if (event.key === 'Escape' && trackMenu) { event.preventDefault(); event.stopImmediatePropagation(); setTrackMenu(false); trackMenuButton.current?.focus(); return }
      if (trackMenu) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input:not([type="range"]):not([type="checkbox"]):not([type="button"]), textarea, select, [contenteditable="true"]')) return
      const modifier = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      let handled = true
      if (key === 'escape' && (menu || showDiff)) { setMenu(null); setShowDiff(false) }
      else if (key === 'escape' && selection.length) select([])
      else if (modifier && (key === '=' || key === '+')) zoomAt(zoom * 1.25)
      else if (modifier && key === '-') zoomAt(zoom / 1.25)
      else if (modifier && key === '0') fit()
      else if (draft.conflict) handled = false
      else if (modifier && key === 'z') event.shiftKey ? draft.redo() : draft.undo()
      else if (!modifier && key === 's') split()
      else if ((key === 'delete' || key === 'backspace') && selection.length) removeSelection()
      else if (modifier && key === 'd' && selection.length) transformSelection(duplicateClip)
      else if (event.altKey && (key === 'arrowleft' || key === 'arrowright')) {
        const delta = (key === 'arrowleft' ? -1 : 1) * Math.round(1000 / fps)
        transformSelection((current, id) => {
          const entry = locateClip(current, id)
          if (!entry || isMainVideoTrack(entry.track)) return { ok: true, doc: current }
          return isOverlayTrack(entry.track) ? moveOverlay(current, id, entry.track.id, entry.clip.startMs + delta) : moveAudio(current, id, entry.track.id, entry.clip.startMs + delta)
        })
      } else if (key === 'tab' && target?.matches('[data-clip-id]')) {
        const entry = locateClip(doc, target.dataset.clipId!)
        handled = false
        if (entry) {
          const index = entry.track.clips.indexOf(entry.clip)
          const next = entry.track.clips[index + (event.shiftKey ? -1 : 1)]
          if (next) {
            handled = true
            select([next.id])
            scroller.current?.scrollTo({ left: Math.max(0, timeToPx(next.startMs, zoom) - 24) })
            // Move focus now when the clip is rendered: the next Tab starts from the focused clip, so a deferred focus
            // makes quick repeated presses select the same clip again. Off-screen clips render after the scroll.
            const focusNext = () => sheet.current?.querySelector<HTMLElement>(`[data-clip-id="${next.id}"]`)?.focus({ preventScroll: true })
            if (sheet.current?.querySelector(`[data-clip-id="${next.id}"]`)) focusNext()
            else requestAnimationFrame(focusNext)
          }
        }
      } else handled = false
      if (handled) { event.preventDefault(); event.stopImmediatePropagation() }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })
  const audioCount = doc.tracks.filter(isAudioTrack).length
  const tickMs = zoom > 400 ? 1000 / fps : zoom > 250 ? 200 : zoom > 90 ? 1000 : zoom > 25 ? 5000 : zoom > 5 ? 30_000 : zoom > 1 ? 60_000 : 300_000
  const ticks: number[] = []
  for (let t = Math.floor(windowMs.fromMs / tickMs) * tickMs; t <= Math.min(pxToTime(contentWidth, zoom), windowMs.toMs); t += tickMs) ticks.push(t)
  const activeEntry = drag ? locateClip(doc, drag.id) : null
  const contextEntry = menu ? locateClip(doc, menu.id) : null
  const cutEntry = cut ? locateClip(doc, cut.id) : null
  const contextSource = contextEntry ? host.nodes.find(node => node.nodeId === contextEntry.clip.source.nodeId) : undefined
  const contextAsset = contextSource ? nodeAsset(contextSource) : null
  const differences = draft.conflict ? diffClips(draft.doc, draft.conflict.theirs) : []
  return <section className="vis-tl-area" role="application" aria-label={m.timeline}>
    {draft.conflict && <div className="vis-tl-conflict" role="alert"><span>{host.lastWriter?.() ? m.conflictBanner(host.lastWriter()!) : m.conflictBannerUnknown}</span><button onClick={() => { draft.loadTheirs(); select([]); setShowDiff(false) }}>{m.loadTheirs}</button><button aria-expanded={showDiff} onClick={() => setShowDiff(!showDiff)}>{m.showDiff}</button></div>}
    {showDiff && draft.conflict && <div className="vis-tl-differences" role="dialog" aria-label={m.showDiff}>
      <button aria-label={m.close} onClick={() => setShowDiff(false)}>&#215;</button>
        {differences.length ? differences.map(diff => <button key={diff.clipId} onClick={() => {
          const tracks = laneTracks(draft.conflict!.theirs)
          const index = tracks.findIndex(track => track.id === diff.trackId)
          const top = (draft.conflict!.theirs.textTracks?.length ?? 0) * TEXT_LANE_HEIGHT + tracks.slice(0, Math.max(0, index)).reduce((sum, track) => sum + trackHeight(track) + 4, 0)
          scroller.current?.scrollTo({ left: Math.max(0, timeToPx(diff.startMs, zoom) - 24), top }); clock.seek(diff.startMs); setShowDiff(false)
        }}>
        {m[diff.type]} · {diff.trackName ?? doc.tracks.find(track => track.id === diff.trackId)?.name ?? m.timeline} · {timecode(diff.startMs, fps, f.number)}
      </button>) : <p>{m.noDifferences}</p>}
    </div>}
    <div className="vis-tl-toolbar">
      <button disabled={!!draft.conflict} onClick={() => split()}>{m.split}</button>
      <button disabled={!!draft.conflict || !selection.length} onClick={removeSelection}>{m.delete}</button>
      <span className="vis-tl-toolbar-divider" />
      <button aria-pressed={snap} onClick={() => setSnap(!snap)}>{m.snap}</button>
      <div className="vis-tl-add-track">
        <button ref={trackMenuButton} aria-haspopup="menu" aria-expanded={trackMenu} disabled={!!draft.conflict} onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation(); if (event.key === 'ArrowDown') { event.preventDefault(); setTrackMenu(true) } }} onClick={() => setTrackMenu(!trackMenu)}><span aria-hidden="true">+ </span>{m.addTrack}</button>
        {trackMenu && <><div className="vis-tl-menu-backdrop" onPointerDown={() => setTrackMenu(false)} /><div ref={trackMenuPanel} className="vis-tl-add-track-menu" role="menu" aria-label={m.addTrack} onKeyDown={event => {
          if (event.key === 'Tab') return
          event.stopPropagation()
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          buttons[index]?.focus()
        }}>
          <button role="menuitem" aria-label={m.addAudio} disabled={audioCount >= TIMELINE_LIMITS.audioTracks} onClick={() => { apply(addAudioTrack(doc)); setTrackMenu(false); trackMenuButton.current?.focus() }}>{m.audioKind}</button>
          <button role="menuitem" aria-label={m.addOverlay} disabled={overlays.length >= TIMELINE_LIMITS.overlayTracks} onClick={() => { apply(addOverlayTrack(doc)); setTrackMenu(false); trackMenuButton.current?.focus() }}>{m.overlayKind}</button>
        </div></>}
      </div>
      <button disabled={!!draft.conflict} onClick={() => {
        const result = addText(doc, clock.now(), m.defaultText)
        apply(result)
        if (result.ok) {
          const added = result.doc.textTracks?.[0]?.clips.find(clip => !locateText(doc, clip.id))
          if (added) { select([added.id]); clock.seek(added.startMs) }
        }
      }}>{m.addText}</button>
      <button aria-pressed={draft.captionLinkage} onClick={() => draft.setCaptionLinkage(!draft.captionLinkage)}>{m.linkCaptions}</button>
      <label className="vis-tl-zoom"><span>{m.zoom}</span><input aria-label={m.zoom} type="range" min={MIN_ZOOM} max={600} step={0.1} value={zoom} onChange={event => zoomAt(Number(event.target.value))} /></label>
      <button onClick={fit}>{m.fit}</button>
    </div>
    {notice && <div className="vis-tl-area-notice" role="status" onClick={() => setNotice('')}>{notice}</div>}
    <div className={`vis-tl-scroll${draft.conflict ? ' is-conflict' : ''}`} ref={scroller}>
      <div className="vis-tl-sheet" ref={sheet} style={{ width: HEADER_WIDTH + contentWidth }} onPointerMove={event => { moveDrag(event); updateMarquee(event) }} onPointerUp={() => { endDrag(); marqueeRef.current = null; setMarquee(null) }} onPointerCancel={() => { endDrag(true); marqueeRef.current = null; setMarquee(null) }}>
        <div className="vis-tl-ruler" onPointerDown={event => {
          if (event.button !== 0 || event.clientX - event.currentTarget.getBoundingClientRect().left < HEADER_WIDTH) return
          clock.seek(clamp(pointerTime(event.clientX), 0, duration))
          event.currentTarget.setPointerCapture(event.pointerId)
        }} onPointerMove={event => { if (event.buttons === 1 && event.currentTarget.hasPointerCapture(event.pointerId)) clock.seek(clamp(pointerTime(event.clientX), 0, duration)) }}>
          <div className="vis-tl-ruler-header" />
          {ticks.map(t => <span key={t} className="vis-tl-tick" style={{ left: HEADER_WIDTH + timeToPx(t, zoom) }}>{timecode(t, fps, f.number)}</span>)}
          <button ref={head} className="vis-tl-playhead-head" aria-label={m.playhead} onPointerDown={event => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId) }}
            onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) clock.seek(clamp(pointerTime(event.clientX), 0, duration)) }} />
        </div>
        <TextLanes host={host} draft={draft} clock={clock} selection={selection} select={select} zoom={zoom} contentWidth={contentWidth} viewport={windowMs} fps={fps} setNotice={setNotice} snap={snap} />
        {showNewOverlay && <div className="vis-tl-track is-new-overlay">
          <div className="vis-tl-track-header"><span>{m.newOverlayTrack}</span></div>
          <div role="group" className={`vis-tl-lane is-empty${dropState?.id === 'new-overlay' ? ' is-drop-target' : ''}`} style={{ width: contentWidth }} aria-label={m.newOverlayTrack}
            onDragOver={event => { if (['image', 'video'].some(kind => event.dataTransfer.types.includes(`${MEDIA_DRAG_TYPE}-${kind}`))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropState({ id: 'new-overlay', invalid: false }) } }}
            onDragLeave={() => setDropState(null)} onDrop={event => dropMedia(event)}><span className="vis-tl-drop-hint">{m.dropOverlay}</span></div>
        </div>}
        {displayTracks.map(track => {
          const audioIndex = doc.tracks.filter(isAudioTrack).indexOf(track)
          const overlayIndex = overlays.indexOf(track)
          const overlay = isOverlayTrack(track)
          const reorder = (id: string, index: number) => apply(overlay ? reorderOverlayTrack(doc, id, index) : reorderAudioTrack(doc, id, index))
          const color = colors[overlay ? 2 + overlayIndex : Math.max(0, audioIndex)]!
          return <div className={`vis-tl-track is-${track.kind}${track.muted && !overlay ? ' is-muted' : ''}${overlay && track.hidden ? ' is-hidden' : ''}`} key={track.id} role="group" aria-label={trackName(track)}>
            <div className="vis-tl-track-header" onDragOver={event => { if (event.dataTransfer.types.includes(TRACK_DRAG_TYPE) && !isMainVideoTrack(track) && !draft.conflict) event.preventDefault() }}
              onDrop={event => { const id = event.dataTransfer.getData(TRACK_DRAG_TYPE); if (!isMainVideoTrack(track) && doc.tracks.some(candidate => candidate.id === id && candidate.kind === track.kind)) { event.preventDefault(); reorder(id, overlay ? overlayIndex : audioIndex) } }}>
              {!isMainVideoTrack(track) && <span className="vis-tl-track-handle" role="button" tabIndex={0} aria-label={overlay ? m.reorderOverlayTrack : m.reorderTrack} draggable={!draft.conflict} onDragStart={event => { event.dataTransfer.setData(TRACK_DRAG_TYPE, track.id); event.dataTransfer.setData(`${TRACK_DRAG_TYPE}-${track.kind}`, track.id); event.dataTransfer.effectAllowed = 'move' }}
                onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); reorder(track.id, (overlay ? overlayIndex : audioIndex) + (event.key === 'ArrowUp' ? -1 : 1) * (overlay ? -1 : 1)) } }}>&#8942;</span>}
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={isMainVideoTrack(track) ? 'M2 3h9v10H2zM11 6l3-2v8l-3-2' : overlay ? 'm1 5 7-3 7 3-7 3-7-3Zm0 3 7 3 7-3M1 11l7 3 7-3' : 'M6 12V3l7-1v9M6 5l7-1M6 12c0 2-4 2-4 0s4-2 4 0m7-1c0 2-4 2-4 0s4-2 4 0'} /></svg>
              <input className="vis-tl-track-name" aria-label={m.trackName} defaultValue={trackName(track)} key={`${track.id}:${track.name ?? ''}`} maxLength={100} disabled={!!draft.conflict} onBlur={event => { if (event.target.value !== trackName(track)) apply(updateTrack(doc, track.id, { name: event.target.value })) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
              {overlay ? <button className="vis-tl-track-mute" aria-label={track.hidden ? m.showTrack : m.hideTrack} aria-pressed={!!track.hidden} disabled={!!draft.conflict} onClick={() => apply(updateTrack(doc, track.id, { hidden: !track.hidden }))}>
                <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5Z" /><circle cx="8" cy="8" r="2" />{track.hidden && <path d="m2 2 12 12" />}</svg>
              </button> : null}
              <button className="vis-tl-track-mute" aria-label={track.muted ? m.unmute : m.mute} aria-pressed={track.muted} disabled={!!draft.conflict} onClick={() => apply(updateTrack(doc, track.id, { muted: !track.muted }))}>
                <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={track.muted ? 'M2 6h3l3-3v10l-3-3H2zM11 6l3 4m0-4-3 4' : 'M2 6h3l3-3v10l-3-3H2zM11 5c3 2 3 4 0 6'} /></svg>
              </button>
              <div className="vis-tl-track-gain"><VolumeControl label={m.trackVolume} value={track.volume} disabled={!!draft.conflict} commit={volume => apply(updateTrack(doc, track.id, { volume }))} />{!isMainVideoTrack(track) && <button className="vis-tl-remove-track" aria-label={overlay ? m.removeOverlayTrack : m.removeTrack} onClick={() => { apply(overlay ? removeOverlayTrack(doc, track.id) : removeAudioTrack(doc, track.id)); select(selection.filter(id => !track.clips.some(clip => clip.id === id))) }} disabled={!!draft.conflict}>&#215;</button>}</div>
            </div>
            <div role="group" aria-label={m.trackLane(trackName(track))} data-track-id={track.id} className={`vis-tl-lane${!track.clips.length ? ' is-empty' : ''}${dropState?.id === track.id ? dropState.invalid ? ' is-invalid-drop' : ' is-drop-target' : ''}`} style={{ width: contentWidth, '--vis-tl-track-color': color } as CSSProperties}
              onPointerDown={marqueeStart} onDragLeave={() => setDropState(null)}
              onDragOver={event => {
                if (!event.dataTransfer.types.includes(MEDIA_DRAG_TYPE) || draft.conflict) return
                const kind = (['video', 'image', 'audio'] as const).find(kind => event.dataTransfer.types.includes(`${MEDIA_DRAG_TYPE}-${kind}`))
                const invalid = !kind || !acceptsMedia(track.kind, kind)
                setDropState({ id: track.id, invalid })
                if (!invalid) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }
                else event.dataTransfer.dropEffect = 'none'
              }}
              onDrop={event => dropMedia(event, track)}>
              {!track.clips.length && <span className="vis-tl-drop-hint">{dropState?.id === track.id && dropState.invalid ? m.invalidDrop : isMainVideoTrack(track) ? m.dropVideo : overlay ? m.dropOverlay : m.dropAudio}</span>}
              {track.clips.filter(clip => clipEndMs(clip) >= windowMs.fromMs && clip.startMs <= windowMs.toMs).map(clip => <ClipView key={clip.id} clip={clip} track={track} host={host} color={color} selected={selection.includes(clip.id)} zoom={zoom} fps={fps} viewport={windowMs} boundHit={flashed === clip.id} selectionKey={selection.join('\n')}
                changeFade={(mode, delta) => apply(updateClip(doc, clip.id, mode === 'fadeIn' ? { fadeInMs: clip.fadeInMs + delta } : { fadeOutMs: clip.fadeOutMs + delta }))}
                selectClip={event => {
                  if (draft.conflict) return
                  if (event.shiftKey || event.ctrlKey || event.metaKey) select(selection.includes(clip.id) ? selection.filter(id => id !== clip.id) : [...selection, clip.id])
                  else if (!selection.includes(clip.id)) select([clip.id])
                }}
                startDrag={(event, mode) => startDrag(event, clip.id, mode)} context={event => {
                  event.preventDefault(); if (draft.conflict) return
                  select([clip.id]); setMenu({ id: clip.id, x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 260), at: clamp(pointerTime(event.clientX), clip.startMs + 1, clipEndMs(clip) - 1) })
                }} />)}
              {isMainVideoTrack(track) && track.clips.slice(1).map((clip, index) => {
                const overlap = clip.transitionIn?.durationMs ?? 0
                const center = clip.startMs + overlap / 2
                if (center < windowMs.fromMs || center > windowMs.toMs) return null
                return <span key={`cut:${clip.id}`}>
                  {overlap > 0 && <span className="vis-tl-transition-hatch" role="img" aria-label={m.transitionOverlap} style={{ left: timeToPx(clip.startMs, zoom), width: timeToPx(overlap, zoom) }} />}
                  <button className={`vis-tl-cut${overlap ? ' has-transition' : ''}`} aria-label={m.transitionAt(f.number(index + 1), f.number(index + 2))} aria-haspopup="dialog" aria-expanded={cut?.id === clip.id} disabled={!!draft.conflict} style={{ left: timeToPx(center, zoom) }}
                    onPointerDown={event => event.stopPropagation()} onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation() }}
                    onClick={event => {
                      cutButton.current = event.currentTarget
                      const rect = event.currentTarget.getBoundingClientRect()
                      setCut({ id: clip.id, x: Math.min(rect.left, window.innerWidth - 260), y: Math.max(8, rect.top - 185) })
                      setCutDuration(String(clip.transitionIn?.durationMs ?? 500))
                    }}><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h4l4 8h4M2 12h4l4-8h4" /></svg></button>
                </span>
              })}
            </div>
          </div>
        })}
        <div className="vis-tl-end-marker" style={{ left: HEADER_WIDTH + timeToPx(duration, zoom) }} />
        <div className="vis-tl-playhead" ref={playhead} />
        {drag?.guide !== null && drag?.guide !== undefined && <div className="vis-tl-snap-guide" style={{ left: HEADER_WIDTH + timeToPx(drag.guide, zoom) }} />}
        {drag && activeEntry && drag.moved && <div className={`vis-tl-ghost${drag.invalid ? ' is-invalid' : ''}`} style={{ left: HEADER_WIDTH + timeToPx(drag.startMs, zoom), width: Math.max(8, timeToPx(clipDurationMs({ ...activeEntry.clip, inMs: drag.inMs, outMs: drag.outMs }), zoom)), top: laneTop(drag.trackId), height: trackHeight(activeEntry.track) }}>
          {drag.mode === 'fadeIn' || drag.mode === 'fadeOut' ? timecode(drag.value, fps, f.number) : `${timecode(drag.inMs, fps, f.number)} \u2013 ${timecode(drag.outMs, fps, f.number)}`}{drag.boundHit ? ` · ${m.bound}` : ''}{drag.invalid ? ` · ${m.overlap}` : ''}
        </div>}
        {marquee && <div className="vis-tl-marquee" style={{ left: Math.min(marquee.x, marquee.endX), top: Math.min(marquee.y, marquee.endY), width: Math.abs(marquee.x - marquee.endX), height: Math.abs(marquee.y - marquee.endY) }} />}
      </div>
      {!duration && <p className="vis-tl-empty-hint">{m.emptyTimeline}</p>}
    </div>
    {cut && cutEntry && <><div className="vis-tl-menu-backdrop" onPointerDown={closeCut} /><div className="vis-tl-transition-popover" role="dialog" aria-label={m.transition} style={{ left: cut.x, top: cut.y }} onKeyDown={event => event.stopPropagation()}>
      <button autoFocus aria-pressed={!cutEntry.clip.transitionIn} onClick={() => { apply(setTransition(doc, cut.id, null)); closeCut() }}>{m.transitionNone}</button>
      {(['crossfade', 'dip'] as const).map(kind => <button key={kind} aria-pressed={cutEntry.clip.transitionIn?.kind === kind} onClick={() => {
        const result = setTransition(doc, cut.id, { kind, durationMs: Number(cutDuration) })
        apply(result)
        if (result.ok) setCutDuration(String(locateClip(result.doc, cut.id)!.clip.transitionIn!.durationMs))
      }}>{kind === 'crossfade' ? m.crossfade : m.dip}</button>)}
      <label>{m.transitionDuration}<input type="number" aria-label={m.transitionDuration} min={200} max={2000} step={1} value={cutDuration} onChange={event => setCutDuration(event.target.value)} onBlur={() => {
        if (!cutEntry.clip.transitionIn) return
        const result = setTransition(doc, cut.id, { kind: cutEntry.clip.transitionIn.kind, durationMs: Number(cutDuration) })
        apply(result)
        if (result.ok) setCutDuration(String(locateClip(result.doc, cut.id)!.clip.transitionIn!.durationMs))
      }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
    </div></>}
    {menu && contextEntry && <><div className="vis-tl-menu-backdrop" onPointerDown={() => setMenu(null)} /><div className="vis-tl-context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onClick={() => setMenu(null)}>
      <button role="menuitem" onClick={() => split(menu.at, [menu.id])}>{m.splitHere}</button>
      <button role="menuitem" onClick={() => apply(duplicateClip(doc, menu.id))}>{m.duplicate}</button>
      <button role="menuitem" onClick={() => { apply(deleteClips(doc, [menu.id])); select([]) }}>{m.delete}</button>
      {contextAsset && contextAsset.assetVersionId !== contextEntry.clip.source.assetVersionId && <button role="menuitem" disabled={!cache.info.has(contextAsset.assetVersionId)} onClick={() => apply(useNewVersion(doc, menu.id, contextAsset.assetVersionId, { kind: contextSource!.kind as 'video' | 'audio' | 'image', durationMs: cache.info.get(contextAsset.assetVersionId)?.durationMs }))}>{m.useNewVersion}</button>}
      <button role="menuitem" disabled={!contextSource} onClick={() => host.showOnCanvas(contextEntry.clip.source.nodeId)}>{m.showSource}</button>
      {!isOverlayTrack(contextEntry.track) && <button role="menuitem" onClick={() => apply(updateClip(doc, menu.id, { volume: 0 }))}>{m.muteClip}</button>}
    </div></>}
  </section>
}
