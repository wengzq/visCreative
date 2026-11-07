import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { isOverlayTrack, overlayOpacityAt, overlayRect, type OverlayPlacement, type TimelineClip, type TimelineOutput, type TimelineTrack } from '@vis/protocol'
import { useMessages } from '@vis/ui-kit'
import type { EditorPartProps } from '../types'
import { timelineEditorMessages } from '../messages'
import { createOverlayMediaPlayer, type OverlayPreviewState } from './media'
import { useMediaResources } from '../model/resources'
import { updateClip } from '../model/edit'
import { movePlacement, resizePlacement, type Corner } from './placement'
import './overlay.css'

type Output = Pick<TimelineOutput, 'width' | 'height'>
type Gesture = { id: string; placement: OverlayPlacement; next: OverlayPlacement; x: number; y: number; corner?: Corner; pointerId: number }

function OverlayTrack({ track, output, onState, ...parts }: EditorPartProps & { track: TimelineTrack; output: Output; onState(id: string, state?: OverlayPreviewState): void }) {
  const m = useMessages(timelineEditorMessages)
  const cache = useMediaResources(parts.host, track.clips.map(clip => clip.source.assetVersionId))
  const elements = useRef<(HTMLDivElement | null)[]>([])
  const assigned = useRef<(TimelineClip | undefined)[]>([])
  const player = useRef<ReturnType<typeof createOverlayMediaPlayer> | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const latest = useRef({ track, output, parts, m })
  latest.current = { track, output, parts, m }
  const sourceAspect = (clip: TimelineClip, element?: HTMLDivElement | null) => {
    const info = cache.info.get(clip.source.assetVersionId)
    const image = element?.querySelector('img')
    const video = element?.querySelector('video')
    return info?.width && info.height ? info.width / info.height : image?.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 1
  }
  const layout = (element: HTMLDivElement, clip: TimelineClip, placement = clip.overlay!) => {
    const rect = overlayRect(placement, sourceAspect(clip, element), latest.current.output)
    const frame = latest.current.output
    Object.assign(element.style, {
      left: `${rect.x / frame.width * 100}%`, top: `${rect.y / frame.height * 100}%`,
      width: `${rect.width / frame.width * 100}%`, height: `${rect.height / frame.height * 100}%`,
    })
  }
  const paint = () => player.current?.update()
  const resourceVersion = cache.version()
  useEffect(() => {
    const current = createOverlayMediaPlayer(elements.current as HTMLDivElement[], () => ({ ...latest.current.parts, track: latest.current.track }),
      clip => (cache.info.get(clip.source.assetVersionId)?.kind ?? latest.current.parts.host.nodes.find(node => node.nodeId === clip.source.nodeId)?.kind) === 'video',
      (element, clip, visible, media) => {
        const { parts, m } = latest.current
        const index = elements.current.indexOf(element)
        assigned.current[index] = clip
        element.style.visibility = visible ? 'visible' : 'hidden'
        const button = element.querySelector('button')!
        button.tabIndex = visible ? 0 : -1
        if (!clip || !visible) return
        button.setAttribute('aria-label', m.overlayBox(parts.host.nodes.find(node => node.nodeId === clip.source.nodeId)?.title ?? m.image))
        button.setAttribute('aria-selected', String(parts.selection.includes(clip.id)))
        button.disabled = !!parts.draft.conflict
        layout(element, clip, gesture.current?.id === clip.id ? gesture.current.next : clip.overlay!)
        media.style.opacity = String(overlayOpacityAt(clip, parts.clock.now()))
      }, state => onState(track.id, state))
    player.current = current
    return () => { player.current = null; current.dispose(); onState(track.id) }
  }, [parts.clock, cache, onState, track.id])
  useEffect(paint, [track, parts.host, parts.selection, parts.draft.conflict, output, resourceVersion])
  const start = (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    if (event.button !== 0 || parts.draft.conflict) return
    const clip = assigned.current[index]
    if (!clip?.overlay) return
    event.preventDefault()
    event.stopPropagation()
    parts.clock.pause()
    parts.select([clip.id])
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    const corner = event.target instanceof HTMLElement ? event.target.dataset.corner as Corner | undefined : undefined
    gesture.current = { id: clip.id, placement: clip.overlay, next: clip.overlay, x: event.clientX, y: event.clientY, pointerId: event.pointerId, ...(corner ? { corner } : {}) }
  }
  const finish = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (commit && !latest.current.parts.draft.conflict) {
      const result = updateClip(latest.current.parts.draft.doc, current.id, { overlay: current.next })
      if (result.ok) latest.current.parts.draft.edit(result.doc, { immediate: true })
    }
    paint()
  }
  return <div className="vis-tl-overlay-track">{[0, 1].map(index => <div key={index} ref={element => { elements.current[index] = element }} className="vis-tl-overlay-slot" style={{ visibility: 'hidden' }}>
    <button type="button" className="vis-tl-overlay-hit" onPointerDown={event => start(event, index)}
      onPointerMove={event => {
        const current = gesture.current
        if (!current || current.pointerId !== event.pointerId) return
        const element = elements.current[index]!
        const frame = element.parentElement!.getBoundingClientRect()
        if (!frame.width || !frame.height) return
        const clip = assigned.current[index]
        if (!clip) return
        const dx = (event.clientX - current.x) / frame.width
        const dy = (event.clientY - current.y) / frame.height
        const tolerance = event.altKey ? undefined : { x: 8 / frame.width, y: 8 / frame.height }
        current.next = current.corner
          ? resizePlacement(current.placement, current.corner, dx, dy, sourceAspect(clip, element), latest.current.output, tolerance)
          : movePlacement(current.placement, dx, dy, sourceAspect(clip, element), latest.current.output, tolerance)
        layout(element, clip, current.next)
      }} onPointerUp={event => finish(event, true)} onPointerCancel={event => finish(event, false)}
      onLostPointerCapture={event => { if (gesture.current?.pointerId === event.pointerId) finish(event, false) }}
      onKeyDown={event => {
        const clip = assigned.current[index]
        if (!clip?.overlay || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        if (parts.draft.conflict) return
        const step = event.shiftKey ? 0.05 : 0.005
        const placement = movePlacement(clip.overlay, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
          event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0, sourceAspect(clip, elements.current[index]), output)
        const result = updateClip(parts.draft.doc, clip.id, { overlay: placement })
        if (result.ok) parts.draft.edit(result.doc, { immediate: true })
      }}>
      {(['nw', 'ne', 'sw', 'se'] as const).map(corner => <span key={corner} data-corner={corner} className={`vis-tl-overlay-handle is-${corner}`} aria-hidden="true" />)}
    </button>
  </div>)}</div>
}

export function OverlayLayer({ onStateChange, ...props }: EditorPartProps & { output: Output; onStateChange(state: OverlayPreviewState): void }) {
  const m = useMessages(timelineEditorMessages)
  const [states, setStates] = useState<Record<string, OverlayPreviewState>>({})
  const onState = useCallback((id: string, state?: OverlayPreviewState) => setStates(previous => {
    const next = { ...previous }
    if (state) next[id] = state
    else delete next[id]
    return next
  }), [])
  const loading = Object.values(states).some(state => state.loading)
  const unavailable = Object.values(states).some(state => state.unavailable)
  const limited = Object.values(states).some(state => state.limited)
  useEffect(() => onStateChange({ loading, unavailable, limited }), [onStateChange, loading, unavailable, limited])
  return <><div className="vis-tl-overlays">{props.draft.doc.tracks.filter(isOverlayTrack).map(track => <OverlayTrack key={track.id} {...props} track={track} onState={onState} />)}</div>
    {limited ? <span className="vis-tl-preview-limited" role="status">{m.previewLimited}</span> : null}
  </>
}
