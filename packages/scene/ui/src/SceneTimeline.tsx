import { SCENE_LIMITS, SceneEase } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { useEffect, useRef, useState } from 'react'
import { NumberField } from './fields'
import { sceneMessages } from './messages'
import { changeMotionDuration, changeMotionKey, deleteMotionKey, keysPastDuration, motionKeys, propertyId, setMotionKey, type MotionProperty } from './motion-edit'
import type { SceneDraft, SceneViewportState } from './types'

export function useSceneMotion(draft: SceneDraft, viewport: SceneViewportState, blocked: boolean) {
  const [timeS, setTimeS] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [chosen, setChosen] = useState<MotionProperty | null>(null)
  const [selectedKey, setSelectedKey] = useState<{ property: MotionProperty; t: number } | null>(null)
  const fallback: MotionProperty | null = viewport.selectedJointId && viewport.selectedId
    ? { type: 'joint', id: viewport.selectedId, jointId: viewport.selectedJointId }
    : viewport.selectedId ? { type: 'transform', id: viewport.selectedId } : viewport.viewId ? { type: 'camera', id: viewport.viewId } : null
  const property = chosen ?? fallback
  const duration = draft.doc.durationS ?? 0
  const latest = useRef({ draft, duration })
  latest.current = { draft, duration }
  useEffect(() => { setChosen(null); setSelectedKey(null) }, [viewport.selectedId, viewport.selectedJointId, viewport.viewId])
  useEffect(() => { setTimeS(time => Math.min(time, duration)) }, [duration])
  useEffect(() => { if (blocked) setPlaying(false) }, [blocked])
  useEffect(() => {
    if (!selectedKey) return
    if (!motionKeys(draft.doc, selectedKey.property).some(key => key.t === selectedKey.t)) setSelectedKey(null)
  }, [draft.doc, selectedKey])
  useEffect(() => {
    if (!playing) return
    const started = performance.now()
    const from = timeS >= duration ? 0 : timeS
    setTimeS(from)
    let frame = 0
    const tick = (now: number) => {
      const end = latest.current.duration
      const time = from + (now - started) / 1000
      setTimeS(Math.min(end, Math.floor(time * 24) / 24))
      if (time >= end) { setTimeS(end); setPlaying(false) }
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // Playback owns the clock until paused. Author-requested playback also runs with reduced motion.
  }, [playing])
  const seek = (time: number) => { setPlaying(false); setTimeS(Math.min(duration, Math.max(0, time))) }
  const choose = (property: MotionProperty) => { setChosen(property); setSelectedKey(null) }
  const setKey = () => {
    if (!property || blocked || !duration) return
    const latest = draft.getSnapshot()
    latest.edit(setMotionKey(latest.doc, property, timeS), true)
  }
  const removeKey = () => {
    if (!selectedKey || blocked) return
    const latest = draft.getSnapshot()
    latest.edit(deleteMotionKey(latest.doc, selectedKey.property, selectedKey.t), true)
    setSelectedKey(null)
  }
  const jump = (direction: -1 | 1) => {
    if (!property) return
    const times = motionKeys(draft.getSnapshot().doc, property).map(key => key.t)
    const next = direction < 0 ? times.findLast(time => time < timeS - 1e-7) : times.find(time => time > timeS + 1e-7)
    if (next !== undefined) seek(next)
  }
  return { timeS, playing, property, selectedKey, seek, choose, setSelectedKey, setKey, removeKey, jump,
    toggle: () => { if (!blocked && duration) setPlaying(value => !value) },
    step: (direction: -1 | 1) => seek(Math.round((timeS + direction / 24) * 24) / 24),
  }
}

export type SceneMotion = ReturnType<typeof useSceneMotion>

export function SceneTimeline({ draft, viewport, motion, disabled }: {
  draft: SceneDraft; viewport: SceneViewportState; motion: SceneMotion; disabled: boolean
}) {
  const m = useMessages(sceneMessages)
  const f = useFormat()
  const [shortening, setShortening] = useState<number | null>(null)
  const [invalidTime, setInvalidTime] = useState(false)
  const [drag, setDrag] = useState<{ property: MotionProperty; t: number; next: number } | null>(null)
  const dragRef = useRef(drag)
  const root = useRef<HTMLElement>(null)
  const focusEditor = () => root.current?.closest<HTMLElement>('.vis-sc-editor')?.focus({ preventScroll: true })
  const duration = draft.doc.durationS
  const selected = draft.doc.objects.find(object => object.id === viewport.selectedId)
  const view = draft.doc.views.find(view => view.id === viewport.viewId)
  const key = motion.selectedKey && motionKeys(draft.doc, motion.selectedKey.property).find(key => key.t === motion.selectedKey!.t)
  const keyTime = (value: number) => f.number(Number(value.toFixed(4)))
  const label = (property: MotionProperty): string => property.type === 'camera' ? m.cameraTrack : property.type === 'hidden' ? m.visibility : property.type === 'joint' ? m.jointName(property.jointId) : m.transform
  const commitDuration = (value: number) => {
    const latest = draft.getSnapshot()
    latest.edit(changeMotionDuration(latest.doc, value), true)
    motion.seek(Math.min(motion.timeS, value))
    setShortening(null)
    focusEditor()
  }
  const changeKey = (change: { t?: number; ease?: SceneEase }) => {
    const selection = motion.selectedKey
    if (!selection) return
    const latest = draft.getSnapshot()
    const next = changeMotionKey(latest.doc, selection.property, selection.t, change)
    setInvalidTime(next === latest.doc)
    if (next === latest.doc) return
    latest.edit(next, true)
    if (change.t !== undefined) { motion.setSelectedKey({ ...selection, t: change.t }); motion.seek(change.t); focusEditor() }
  }
  useEffect(() => {
    if (!disabled) return
    setShortening(null)
    setDrag(null)
    dragRef.current = null
  }, [disabled])
  useEffect(() => setInvalidTime(false), [motion.selectedKey])
  if (duration === undefined) return <section ref={root} className="vis-sc-timeline" aria-label={m.motion}>
    <button disabled={disabled} onClick={() => commitDuration(5)}>{m.addMotion}</button>
  </section>
  const rows: MotionProperty[] = [
    ...(selected ? [{ type: 'transform' as const, id: selected.id }, { type: 'hidden' as const, id: selected.id }] : []),
  ]
  const row = (property: MotionProperty) => <div className="vis-sc-track-row" key={propertyId(property)}>
    <button className="vis-sc-track-name" disabled={disabled} aria-label={m.selectTrack(label(property))} aria-pressed={!!motion.property && propertyId(property) === propertyId(motion.property)} onClick={() => motion.choose(property)}>{label(property)}</button>
    <div className="vis-sc-key-lane" role="group" aria-label={m.trackKeys(label(property))}>
      <span className="vis-sc-playhead" style={{ left: `${motion.timeS / duration * 100}%` }} />
      {motionKeys(draft.doc, property).map(key => <button key={key.t} className="vis-sc-key" disabled={disabled}
        aria-label={m.keyAt(label(property), keyTime(key.t))} aria-pressed={motion.selectedKey?.t === key.t && propertyId(motion.selectedKey.property) === propertyId(property)}
        style={{ left: `${(drag?.t === key.t && propertyId(drag.property) === propertyId(property) ? drag.next : key.t) / duration * 100}%` }}
        onClick={() => { motion.choose(property); motion.setSelectedKey({ property, t: key.t }); motion.seek(key.t) }}
        onKeyDown={event => {
          if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault(); event.stopPropagation()
            const latest = draft.getSnapshot()
            latest.edit(deleteMotionKey(latest.doc, property, key.t), true)
            motion.setSelectedKey(null)
            event.currentTarget.closest<HTMLElement>('.vis-sc-editor')?.focus()
          }
        }}
        onPointerDown={event => {
          if (event.button !== 0) return
          motion.seek(motion.timeS)
          draft.beginEdit()
          event.currentTarget.setPointerCapture(event.pointerId)
          dragRef.current = { property, t: key.t, next: key.t }
          setDrag(dragRef.current)
        }}
        onPointerMove={event => {
          if (!dragRef.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
          const rect = event.currentTarget.parentElement!.getBoundingClientRect()
          const next = Math.max(0, Math.min(duration, Math.round((event.clientX - rect.left) / rect.width * duration * 24) / 24))
          dragRef.current = { ...dragRef.current, next }
          setDrag(dragRef.current)
        }}
        onPointerUp={event => {
          const moving = dragRef.current
          dragRef.current = null
          setDrag(null)
          event.currentTarget.releasePointerCapture(event.pointerId)
          if (!moving || moving.next === moving.t) return
          const latest = draft.getSnapshot()
          const next = changeMotionKey(latest.doc, property, moving.t, { t: moving.next })
          setInvalidTime(next === latest.doc)
          latest.edit(next, true)
          motion.choose(property)
          motion.setSelectedKey({ property, t: next === latest.doc ? moving.t : moving.next })
          focusEditor()
        }}
        onPointerCancel={() => { dragRef.current = null; setDrag(null) }}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m8 1 6 7-6 7-6-7Z" fill="currentColor" /></svg>
      </button>)}
    </div>
  </div>
  return <section ref={root} className="vis-sc-timeline" aria-label={m.motion} onKeyDown={event => {
    if (event.key === 'Escape' && shortening !== null) { event.preventDefault(); setShortening(null) }
  }}>
    <div className="vis-sc-motion-controls">
      <button aria-label={motion.playing ? m.pause : m.play} disabled={disabled} onClick={motion.toggle}>{motion.playing ? m.pause : m.play}</button>
      <button aria-label={m.previousFrame} disabled={disabled} onClick={() => motion.step(-1)}>{m.previousFrame}</button>
      <button aria-label={m.nextFrame} disabled={disabled} onClick={() => motion.step(1)}>{m.nextFrame}</button>
      <NumberField label={m.playheadTime} value={motion.timeS} disabled={disabled} min={0} max={duration} commitOnBlur onChange={motion.seek} />
      <NumberField label={m.duration} value={duration} disabled={disabled} min={SCENE_LIMITS.durationS.min} max={SCENE_LIMITS.durationS.max} commitOnBlur onChange={value => {
        motion.seek(motion.timeS)
        if (keysPastDuration(draft.getSnapshot().doc, value)) setShortening(value)
        else commitDuration(value)
      }} />
      <button disabled={disabled || !motion.property} onClick={motion.setKey}>{m.setKey}</button>
    </div>
    {shortening !== null ? <div className="vis-sc-duration-confirm" role="alert">
      <span>{m.shortenConfirmation(f.number(keysPastDuration(draft.doc, shortening)))}</span>
      <button onClick={() => commitDuration(shortening)}>{m.shorten}</button>
      <button onClick={() => { setShortening(null); focusEditor() }}>{m.cancel}</button>
    </div> : null}
    <label className="vis-sc-scrubber">{m.playhead}<input type="range" aria-label={m.playhead} min={0} max={duration} step="any" value={motion.timeS} disabled={disabled} onChange={event => motion.seek(Number(event.target.value))} /></label>
    <div className="vis-sc-track-list">
      {rows.map(row)}
      {selected?.source.type === 'figure' ? <details className="vis-sc-joint-tracks" open={!!viewport.selectedJointId}>
        <summary>{m.jointTracks}</summary>
        {[...new Set([...Object.keys(selected.tracks?.pose ?? {}), ...(viewport.selectedJointId ? [viewport.selectedJointId] : [])])].map(jointId => row({ type: 'joint', id: selected.id, jointId }))}
      </details> : null}
      {view ? row({ type: 'camera', id: view.id }) : null}
    </div>
    {motion.selectedKey && key ? <div className="vis-sc-key-details" role="group" aria-label={m.selectedKey}>
      <NumberField key={`${propertyId(motion.selectedKey.property)}-${key.t}`} label={m.keyTime} value={key.t} disabled={disabled} min={0} max={duration} commitOnBlur onChange={t => changeKey({ t })} />
      {motion.selectedKey.property.type !== 'hidden' ? <label>{m.ease}<select aria-label={m.ease} value={key.ease} disabled={disabled} onChange={event => changeKey({ ease: SceneEase.parse(event.target.value) })}>
        {SceneEase.options.map(ease => <option key={ease} value={ease}>{m[ease]}</option>)}
      </select></label> : <span className="vis-sc-muted">{m.steppedVisibility}</span>}
      <button disabled={disabled} onClick={() => { motion.removeKey(); focusEditor() }}>{m.deleteKey}</button>
    </div> : null}
    {invalidTime ? <p role="alert" className="vis-sc-limit">{m.invalidKeyTime}</p> : null}
  </section>
}
