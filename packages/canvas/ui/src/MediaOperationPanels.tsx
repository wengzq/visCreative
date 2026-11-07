import { LOCAL_OPERATION_PARAMS } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PeaksTimeline, useAudioPeaks } from './PeaksTimeline'
import { Icon } from './Icon'
import { mediaPanelMessages } from './media-messages'
import { mediaPositionMs, pauseMedia } from './mediaPlayback'
import { addSplitPoint, clampRange, clampTime, durationMs, MAX_SPLIT_POINTS, moveSplitPoint, normalizeSplitPoints, pixelToTime, removeSplitPoint, timelineTime, timeToPercent } from './mediaTimeline'
import type { OperationPanelProps } from './operations-ui'
import './media-panels.css'

function Panel({ title, onSubmit, onCancel, valid = true, pending = false, children }: {
  title: string
  onSubmit(): Promise<void>
  onCancel(): void
  valid?: boolean
  pending?: boolean
  children: ReactNode
}) {
  const m = useMessages(mediaPanelMessages)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => { form.current?.focus() }, [])
  const submit = async () => {
    if (!valid || pending || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try { await onSubmit() } catch (error) { setError(error instanceof Error ? error.message : m.submitError) }
    finally { submitting.current = false; setBusy(false) }
  }
  return <form ref={form} className="vis-media-panel nodrag nopan" tabIndex={-1} aria-label={title} aria-busy={pending || busy}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onSubmit={event => { event.preventDefault(); void submit() }}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) onCancel() }
      if (event.key === 'Enter' && !(event.target instanceof HTMLElement && event.target.closest('button'))) { event.preventDefault(); void submit() }
    }}>
    <header>{title}</header>
    <fieldset disabled={busy || pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'contents' }}>{children}</fieldset>
    {error ? <div role="alert">{error}</div> : null}
    <footer>
      <button type="button" disabled={busy} aria-label={m.cancel} onClick={onCancel}>{m.cancel}</button>
      <button type="submit" className="is-primary" disabled={!valid || busy || pending} aria-label={m.confirm}>{m.confirm}</button>
    </footer>
  </form>
}

function usePanelMedia(src: string) {
  const m = useMessages(mediaPanelMessages)
  const element = useRef<HTMLMediaElement | null>(null)
  const [initial] = useState(() => mediaPositionMs(src))
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(initial)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    pauseMedia(src)
    const media = element.current
    return () => media?.pause()
  }, [src])
  const seek = (ms: number) => {
    const next = clampTime(ms, duration)
    if (element.current) element.current.currentTime = next / 1000
    setTime(next)
  }
  const play = async (startMs: number) => {
    const media = element.current
    if (!media) return
    if (!media.paused) { media.pause(); return }
    seek(startMs)
    try { await media.play() } catch { setError(m.mediaError) }
  }
  const props = {
    src, preload: 'metadata',
    ref: (media: HTMLMediaElement | null) => { element.current = media },
    onLoadedMetadata: (event: { currentTarget: HTMLMediaElement }) => {
      const ms = durationMs(event.currentTarget.duration)
      setDuration(ms)
      event.currentTarget.currentTime = Math.min(initial, Math.max(0, ms - 1)) / 1000
      setTime(durationMs(event.currentTarget.currentTime))
    },
    onTimeUpdate: (event: { currentTarget: HTMLMediaElement }) => setTime(durationMs(event.currentTarget.currentTime)),
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onError: () => setError(m.mediaError),
  }
  return { element, initial, duration, time, playing, error, seek, play, props }
}

function TimeHandle({ label, value, min, max, duration, onChange, onRemove, split = false, disabled = false }: {
  label: string; value: number; min: number; max: number; duration: number
  onChange(value: number): void
  onRemove?(): void
  split?: boolean
  disabled?: boolean
}) {
  const change = (value: number) => onChange(Math.max(min, Math.min(max, value)))
  return <div role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={timelineTime(value)}
    className={`vis-media-handle${split ? ' vis-media-split-point' : ''}`} style={{ left: `${timeToPercent(value, duration)}%` }}
    onPointerDown={event => { event.stopPropagation(); if (disabled || event.currentTarget.closest('fieldset')?.disabled) return; event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId) }}
    onPointerMove={event => {
      if (disabled || event.currentTarget.closest('fieldset')?.disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return
      const rect = event.currentTarget.parentElement!.getBoundingClientRect()
      change(pixelToTime(event.clientX, rect.left, rect.width, duration))
    }}
    onKeyDown={event => {
      if (disabled || event.currentTarget.closest('fieldset')?.disabled) return
      const step = event.shiftKey ? 1000 : 100
      switch (event.key) {
        case 'ArrowLeft': case 'ArrowDown': change(value - step); break
        case 'ArrowRight': case 'ArrowUp': change(value + step); break
        case 'Home': change(min); break
        case 'End': change(max); break
        case 'Delete': case 'Backspace': if (!onRemove) return; onRemove(); break
        default: return
      }
      event.preventDefault()
      event.stopPropagation()
    }} />
}

export function TrimPanel(props: OperationPanelProps) {
  const m = useMessages(mediaPanelMessages)
  const video = props.view.kind === 'video'
  const media = usePanelMedia(props.src)
  const peaks = useAudioPeaks(props.assetVersionId, props.onPreview, !video)
  const [range, setRange] = useState({ startMs: 0, endMs: 0 })
  useEffect(() => { setRange(clampRange(0, media.duration, media.duration)) }, [media.duration])
  const change = (part: 'startMs' | 'endMs', value: number) => {
    media.element.current?.pause()
    setRange(previous => clampRange(part === 'startMs' ? Math.min(value, previous.endMs - 1) : previous.startMs, part === 'endMs' ? value : previous.endMs, media.duration))
    media.seek(value)
  }
  const playbackProps = { ...media.props, onTimeUpdate: (event: { currentTarget: HTMLMediaElement }) => {
    if (event.currentTarget.currentTime * 1000 >= range.endMs) {
      event.currentTarget.pause()
      event.currentTarget.currentTime = range.endMs / 1000
    }
    media.props.onTimeUpdate(event)
  } }
  const handles = <>
    <span className="vis-media-selection" style={{ left: `${timeToPercent(range.startMs, media.duration)}%`, width: `${timeToPercent(range.endMs - range.startMs, media.duration)}%` }} />
    <TimeHandle label={m.start} value={range.startMs} min={0} max={Math.max(0, range.endMs - 1)} duration={media.duration} disabled={!media.duration} onChange={value => change('startMs', value)} />
    <TimeHandle label={m.end} value={range.endMs} min={Math.min(range.startMs + 1, range.endMs)} max={media.duration} duration={media.duration} disabled={!media.duration} onChange={value => change('endMs', value)} />
  </>
  return <Panel title={video ? m.trimVideo : m.trimAudio} onCancel={props.onCancel} valid={media.duration > 0 && range.endMs > range.startMs && !media.error} onSubmit={() => props.onSubmit(range)}>
    {video ? <video {...playbackProps} playsInline /> : <audio {...playbackProps} />}
    <div className="vis-media-range">
      <PeaksTimeline peaks={peaks} timeMs={media.time} durationMs={media.duration} onSeek={value => media.seek(Math.max(range.startMs, Math.min(range.endMs, value)))} label={video ? m.timeline : m.waveform}>{handles}</PeaksTimeline>
    </div>
    <div className="vis-media-times"><span>{timelineTime(range.startMs)}</span>
      <button type="button" disabled={!media.duration} aria-label={media.playing ? m.pausePreview : m.preview} onClick={() => void media.play(range.startMs)}><Icon kind={media.playing ? 'pause' : 'play'} /></button>
      <span>{timelineTime(range.endMs)}</span></div>
    {!media.duration && !media.error ? <p role="status">{m.loading}</p> : null}
    {media.error ? <div role="alert">{media.error}</div> : null}
  </Panel>
}

export function FramePanel(props: OperationPanelProps) {
  const m = useMessages(mediaPanelMessages)
  const media = usePanelMedia(props.src)
  return <Panel title={m.frame} onCancel={props.onCancel} valid={media.duration > 0 && !media.error} onSubmit={() => props.onSubmit({ atMs: Math.min(media.time, media.duration - 1) })}>
    <video {...media.props} playsInline />
    <label>{m.frameTime}<input type="range" aria-label={m.frameTime} aria-valuetext={timelineTime(media.time)} min={0} max={Math.max(0, media.duration - 1)} step={1} value={Math.min(media.time, Math.max(0, media.duration - 1))} disabled={!media.duration} onChange={event => media.seek(Number(event.target.value))} /></label>
    <span className="vis-media-times">{timelineTime(media.time)}</span>
    {media.error ? <div role="alert">{media.error}</div> : null}
  </Panel>
}

export function SplitPanel(props: OperationPanelProps) {
  const m = useMessages(mediaPanelMessages)
  const format = useFormat()
  const media = usePanelMedia(props.src)
  const peaks = useAudioPeaks(props.assetVersionId, props.onPreview)
  const [points, setPoints] = useState<number[]>([])
  const [analyzing, setAnalyzing] = useState(props.variant === 'smart')
  const [analysisDuration, setAnalysisDuration] = useState(0)
  const [analysisError, setAnalysisError] = useState('')
  const duration = media.duration || analysisDuration
  const analysisRun = useRef(0)
  const mounted = useRef(true)
  const analyze = async () => {
    const run = ++analysisRun.current
    setAnalyzing(true)
    setAnalysisError('')
    try {
      if (!props.onAnalyze) throw new Error(m.analyzeUnavailable)
      const result = await props.onAnalyze()
      if (!mounted.current || run !== analysisRun.current) return
      setAnalysisDuration(result.durationMs)
      setPoints(normalizeSplitPoints(result.pointsMs, result.durationMs))
    } catch (error) {
      if (mounted.current && run === analysisRun.current) setAnalysisError(error instanceof Error ? error.message : m.analyzeUnavailable)
    } finally { if (mounted.current && run === analysisRun.current) setAnalyzing(false) }
  }
  useEffect(() => {
    mounted.current = true
    if (props.variant === 'smart') void analyze()
    return () => { mounted.current = false; analysisRun.current++ }
  }, [props.src, props.variant])
  useEffect(() => { if (duration) setPoints(previous => normalizeSplitPoints(previous, duration)) }, [duration])
  const add = (time: number) => { media.seek(time); setPoints(previous => addSplitPoint(previous, time, duration)) }
  const validPoints = normalizeSplitPoints(points, duration)
  return <Panel title={props.variant === 'smart' ? m.splitSmart : m.splitCustom} onCancel={props.onCancel} pending={analyzing}
    valid={duration > 0 && validPoints.length > 0 && !media.error} onSubmit={() => props.onSubmit({ pointsMs: validPoints })}>
    <audio {...media.props} />
    <PeaksTimeline peaks={peaks} timeMs={media.time} durationMs={duration} onSeek={media.seek} onPick={add} label={m.waveform} disabled={analyzing}>
      {points.map((point, index) => <TimeHandle key={index} split label={m.splitPoint(format.number(index + 1))} value={point}
        min={(points[index - 1] ?? 0) + 1} max={(points[index + 1] ?? duration) - 1} duration={duration} disabled={analyzing}
        onChange={value => setPoints(previous => moveSplitPoint(previous, index, value, duration))}
        onRemove={() => setPoints(previous => removeSplitPoint(previous, index))} />)}
    </PeaksTimeline>
    <p>{m.splitHint}</p>
    <p role="status">{analyzing ? m.analyzing : m.splitCount(format.number(points.length), format.number(points.length + 1))}</p>
    {points.length === MAX_SPLIT_POINTS ? <p>{m.limit}</p> : null}
    {!points.length && !analyzing ? <p>{m.noPoints}</p> : null}
    <div className="vis-media-point-list">{points.map((point, index) => <button key={index} type="button" aria-label={m.removePoint(format.number(index + 1))} onClick={() => setPoints(previous => removeSplitPoint(previous, index))}>{timelineTime(point)}</button>)}</div>
    <div className="vis-media-times">
      <button type="button" aria-label={m.addPoint} disabled={!duration || points.length >= MAX_SPLIT_POINTS} onClick={() => add(media.time)}>{m.addPoint}</button>
      <button type="button" aria-label={media.playing ? m.pausePreview : m.preview} disabled={!media.duration} onClick={() => void media.play(media.time)}><Icon kind={media.playing ? 'pause' : 'play'} /></button>
    </div>
    {props.variant === 'smart' ? <button type="button" disabled={analyzing} aria-label={m.analyze} onClick={() => void analyze()}>{m.analyze}</button> : null}
    {analysisError ? <div role="alert">{analysisError}</div> : null}
    {media.error ? <div role="alert">{media.error}</div> : null}
  </Panel>
}

export function SpeedPanel(props: OperationPanelProps) {
  const m = useMessages(mediaPanelMessages)
  const format = useFormat()
  const rates = Array.from(LOCAL_OPERATION_PARAMS['audio.speed'].shape.rate.values)
  const [rate, setRate] = useState<number>(rates[0]!)
  return <Panel title={m.speed} onCancel={props.onCancel} onSubmit={() => props.onSubmit({ rate })}>
    <div className="vis-media-rates" role="group" aria-label={m.speed}>
      {rates.map(value => <button key={value} type="button" aria-label={m.rate(format.number(value))} aria-pressed={rate === value} onClick={() => setRate(value)}>{m.rate(format.number(value))}</button>)}
    </div>
  </Panel>
}
