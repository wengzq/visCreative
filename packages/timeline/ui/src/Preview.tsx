import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { isMainVideoTrack, overlayTracks, timelineDurationMs, visibleTextTracks } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import type { EditorPartProps } from './types'
import { timelineShellMessages } from './shell-messages'
import { createMediaPlayer } from './player/media'
import { subscribePlaybackFrames } from './player'
import { parseTimecode, timecode } from './model/geometry'
import { PlayerIcon } from './player/PlayerIcon'
import { useMediaResources } from './model/resources'
import { effectiveFps, outputFrame } from './model/output'
import { CaptionOverlay } from './text/CaptionOverlay'
import { OverlayLayer } from './overlay/OverlayLayer'
import type { OverlayPreviewState } from './overlay/media'

export function Preview(parts: EditorPartProps) {
  const { host, draft, clock } = parts
  const m = useMessages(timelineShellMessages)
  const format = useFormat()
  const root = useRef<HTMLDivElement>(null)
  const videoA = useRef<HTMLVideoElement>(null)
  const videoB = useRef<HTMLVideoElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const imageB = useRef<HTMLImageElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const latest = useRef(parts)
  const player = useRef<ReturnType<typeof createMediaPlayer> | null>(null)
  latest.current = parts
  const [state, setState] = useState<{ clipId?: string; audioIds: string[]; loading: boolean; unavailable: boolean }>({ audioIds: [], loading: false, unavailable: false })
  const [overlayState, setOverlayState] = useState<OverlayPreviewState>({ loading: false, unavailable: false, limited: false })
  const [fullscreen, setFullscreen] = useState(false)
  const [controls, setControls] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const playing = useSyncExternalStore(clock.subscribe, clock.playing, () => false)
  const duration = timelineDurationMs(draft.doc)
  const [imageInfo, setImageInfo] = useState<{ assetVersionId: string; width: number; height: number }>()
  const first = draft.doc.tracks.find(isMainVideoTrack)?.clips[0]
  const resources = useMediaResources(host, draft.doc.tracks.filter(isMainVideoTrack).flatMap(track => track.clips.map(clip => clip.source.assetVersionId)))
  const firstInfo = first ? resources.info.get(first.source.assetVersionId) : undefined
  const fps = effectiveFps(draft.doc.output, firstInfo)
  const output = outputFrame(draft.doc.output, firstInfo?.width && firstInfo.height ? firstInfo : imageInfo?.assetVersionId === first?.source.assetVersionId ? imageInfo : undefined)
  const aspect = output.width / output.height
  useEffect(() => {
    const current = createMediaPlayer([videoA.current!, videoB.current!], [image.current!, imageB.current!], () => latest.current, setState, id => resources.info.get(id)?.kind)
    player.current = current
    return () => { player.current = null; current.dispose() }
  }, [clock, resources])
  const resourceVersion = resources.version()
  useEffect(() => player.current?.update(), [draft.doc, host.nodes, resourceVersion])
  useEffect(() => subscribePlaybackFrames(clock, () => {
    if (input.current && document.activeElement !== input.current) input.current.value = timecode(clock.now(), fps, format.number)
  }), [clock, fps, format, duration])
  useEffect(() => {
    const changed = () => { setFullscreen(document.fullscreenElement === root.current); setControls(true) }
    document.addEventListener('fullscreenchange', changed)
    return () => { document.removeEventListener('fullscreenchange', changed); clearTimeout(hideTimer.current) }
  }, [])
  const reveal = () => {
    setControls(true)
    clearTimeout(hideTimer.current)
    if (fullscreen && playing) hideTimer.current = setTimeout(() => setControls(false), 2000)
  }
  useEffect(reveal, [fullscreen, playing])
  const seekInput = () => {
    const ms = parseTimecode(input.current!.value, fps)
    if (ms !== null) { input.current!.setCustomValidity(''); clock.seek(ms) }
    else input.current!.value = timecode(clock.now(), fps, format.number)
  }
  const audioNames = draft.doc.tracks.flatMap(track => track.clips).filter(clip => state.audioIds.includes(clip.id)).map(clip => host.nodes.find(node => node.nodeId === clip.source.nodeId)?.title ?? m.audio)
  return <div ref={root} role="group" aria-label={m.preview} className={`vis-tl-preview${fullscreen ? ' is-fullscreen' : ''}${controls ? '' : ' hide-controls'}`} onPointerMove={reveal} onFocusCapture={reveal}>
    <div className="vis-tl-stage">
      <div className="vis-tl-output-frame" style={{ aspectRatio: aspect, '--vis-tl-aspect': aspect } as CSSProperties}>
        <video ref={videoA} playsInline preload="auto" />
        <video ref={videoB} playsInline preload="auto" />
        <img ref={image} alt="" onLoad={event => { if (!draft.doc.output && first && first.id === state.clipId) setImageInfo({ assetVersionId: first.source.assetVersionId, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }) }} />
        <img ref={imageB} alt="" />
        <OverlayLayer {...parts} output={output} onStateChange={setOverlayState} />
        <CaptionOverlay {...parts} />
        {!state.clipId && !visibleTextTracks(draft.doc).length && !overlayTracks(draft.doc).length ? <div className="vis-tl-preview-empty"><PlayerIcon kind="audio" /><span>{duration ? audioNames.join(' · ') || m.silence : m.empty}</span></div> : null}
        {state.loading || overlayState.loading ? <span className="vis-tl-loading" role="status">{m.loading}</span> : null}
        {state.unavailable || overlayState.unavailable ? <span className="vis-tl-loading" role="alert">{m.unavailable}</span> : null}
      </div>
    </div>
    <div className="vis-tl-transport" onPointerMove={reveal}>
      <button className="vis-icon-button" aria-label={playing ? m.pause : m.play} disabled={!duration} onClick={() => playing ? clock.pause() : clock.play()}><PlayerIcon kind={playing ? 'pause' : 'play'} /></button>
      <button className="vis-icon-button" aria-label={m.previousFrame} onClick={() => { clock.pause(); clock.seek(clock.now() - 1000 / fps) }}><PlayerIcon kind="previous" /></button>
      <button className="vis-icon-button" aria-label={m.nextFrame} onClick={() => { clock.pause(); clock.seek(clock.now() + 1000 / fps) }}><PlayerIcon kind="next" /></button>
      <div className="vis-tl-timecode"><input ref={input} aria-label={m.timecode} defaultValue={timecode(0, fps, format.number)} onBlur={seekInput} onKeyDown={event => {
        if (event.key === 'Enter') { seekInput(); event.currentTarget.blur() }
      }} /><span>/ {timecode(duration, fps, format.number)}</span></div>
      <button className="vis-icon-button vis-tl-fullscreen" aria-label={fullscreen ? m.exitFullscreen : m.fullscreen} onClick={() => {
        if (fullscreen) void document.exitFullscreen()
        else void root.current?.requestFullscreen()
      }}><PlayerIcon kind="fullscreen" /></button>
    </div>
  </div>
}
