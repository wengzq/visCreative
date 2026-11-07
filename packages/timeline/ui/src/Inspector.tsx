import { useEffect, useState } from 'react'
import { clipDurationMs, isMainVideoTrack, isOverlayTrack, sourceTimeAt, type TimelineOutput, type TimelineTrackKind } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import type { EditorPartProps } from './types'
import { TextInspector } from './text/TextInspector'
import { timelineEditorMessages } from './messages'
import { deleteClips, locateClip, setSpeed, trimClip, updateClip, updateTrack, useNewVersion, type EditResult } from './model/edit'
import { latestExport, nodeAsset, trackSourceKind } from './model/media'
import { parseTimecode, timecode } from './model/geometry'
import { useMediaResources } from './model/resources'
import { effectiveFps, outputFrame, outputFrameRates, outputWithFps, presetFps } from './model/output'
import { boundedPlacement, presetPlacement, type PlacementPreset } from './overlay/placement'
import './timeline-area.css'

function CommitField({ label, value, disabled, commit, type = 'text', min, max, step, unit }: {
  label: string; value: string; disabled?: boolean; commit(value: string): void; type?: string; min?: number; max?: number; step?: number; unit?: string
}) {
  const [text, setText] = useState(value)
  useEffect(() => { setText(value) }, [value])
  return <label className="vis-tl-field"><span>{label}{unit ? ` (${unit})` : ''}</span><input aria-label={label} value={text} type={type} min={min} max={max} step={step ?? (type === 'number' ? 'any' : undefined)} disabled={disabled}
    onChange={event => setText(event.target.value)} onBlur={() => { if (text !== value) commit(text) }}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setText(value); event.stopPropagation() } }} /></label>
}

export function VolumeControl({ label, value, disabled, commit }: { label: string; value: number; disabled?: boolean; commit(value: number): void }) {
  const m = useMessages(timelineEditorMessages)
  const f = useFormat()
  const [local, setLocal] = useState(value)
  useEffect(() => { setLocal(value) }, [value])
  const apply = () => { if (local !== value) commit(local) }
  return <label className="vis-tl-volume"><span>{label}</span><input type="range" aria-label={label} min={0} max={2} step={0.01} value={local} disabled={disabled}
    onChange={event => { const n = Number(event.target.value); setLocal(Math.abs(n - 1) < 0.035 ? 1 : n) }}
    onPointerUp={apply} onKeyUp={apply} onBlur={apply} /><span className="vis-tl-volume-number"><input className="vis-tl-volume-value" type="number" aria-label={m.volumeValue(label)} min={0} max={200} step={1} disabled={disabled} value={Math.round(local * 100)} title={m.percent(f.number(Math.round(local * 100)))}
      onChange={event => { const n = Number(event.target.value) / 100; if (Number.isFinite(n)) setLocal(Math.min(2, Math.max(0, n))) }} onBlur={apply} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></span></label>
}

export function OutputSettings({ host, draft, onDone }: EditorPartProps & { onDone?(): void }) {
  const m = useMessages(timelineEditorMessages)
  const f = useFormat()
  const output = draft.doc.output
  const first = draft.doc.tracks.find(isMainVideoTrack)?.clips[0]
  const resources = useMediaResources(host, first ? [first.source.assetVersionId] : [])
  const firstInfo = first ? resources.info.get(first.source.assetVersionId) : undefined
  const fps = presetFps(output, firstInfo)
  const frameRates = outputFrameRates(output, firstInfo)
  const selectedFps = effectiveFps(output, firstInfo)
  const matching = !frameRates.includes(selectedFps)
  const presets: { key: string; label: string; output?: TimelineOutput }[] = [
    { key: 'match', label: m.matchFirst },
    { key: '1080', label: m.preset1080, output: { width: 1920, height: 1080, fps } },
    { key: '720', label: m.preset720, output: { width: 1280, height: 720, fps } },
    { key: '4k', label: m.preset4k, output: { width: 3840, height: 2160, fps } },
    { key: 'vertical', label: m.presetVertical, output: { width: 1080, height: 1920, fps } },
    { key: 'square', label: m.presetSquare, output: { width: 1080, height: 1080, fps } },
  ]
  const current = output ? presets.find(p => p.output?.width === output.width && p.output?.height === output.height)?.key ?? '1080' : 'match'
  return <fieldset className="vis-tl-output" disabled={!!draft.conflict}><legend>{m.output}</legend>
    <select aria-label={m.output} value={current} onChange={event => {
      const preset = presets.find(p => p.key === event.target.value)!
      const { output: _output, ...rest } = draft.doc
      draft.edit(preset.output ? { ...rest, output: preset.output } : rest, { immediate: true })
      onDone?.()
    }}>{presets.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
    <label className="vis-tl-field"><span>{m.fps}</span><select aria-label={m.fps} value={matching ? 'match' : selectedFps} disabled={!outputWithFps(output, firstInfo, fps)} onChange={event => {
      const next = outputWithFps(output, firstInfo, Number(event.target.value))
      if (next) draft.edit({ ...draft.doc, output: next }, { immediate: true })
    }}>{matching && <option value="match" disabled>{m.matchFirst}</option>}{frameRates.map(rate => <option key={rate} value={rate}>{f.number(rate)}</option>)}</select></label>
  </fieldset>
}

export function Inspector(props: EditorPartProps) {
  const { host, draft, selection, select } = props
  const m = useMessages(timelineEditorMessages)
  const f = useFormat()
  const [error, setError] = useState('')
  const entry = selection[0] ? locateClip(draft.doc, selection[0]) : null
  const source = entry ? host.nodes.find(node => node.nodeId === entry.clip.source.nodeId) : undefined
  const asset = source ? nodeAsset(source) : null
  const exported = latestExport(host.nodes, host.node.nodeId)
  const exportAsset = exported ? nodeAsset(exported) : null
  const first = draft.doc.tracks.find(isMainVideoTrack)?.clips[0]
  const ids = [first?.source.assetVersionId, entry?.clip.source.assetVersionId, asset?.assetVersionId, exportAsset?.assetVersionId].filter((id): id is string => !!id)
  const resources = useMediaResources(host, ids)
  const sourceKind = entry ? resources.info.get(entry.clip.source.assetVersionId)?.kind ?? source?.kind : undefined
  const apply = (result: EditResult) => {
    if (result.ok) { const refused = draft.edit(result.doc, { immediate: true }); setError(refused ? m[refused] : result.boundHit ? m.bound : '') }
    else setError(m[result.reason])
  }
  const disabled = !!draft.conflict
  const fps = effectiveFps(draft.doc.output, first ? resources.info.get(first.source.assetVersionId) : undefined)
  const tc = (ms: number) => timecode(ms, fps, f.number)
  const timeInput = (value: string, callback: (ms: number) => void) => {
    const ms = parseTimecode(value, fps)
    if (ms === null) setError(m.invalid)
    else callback(ms)
  }
  const newer = entry && asset && asset.assetVersionId !== entry.clip.source.assetVersionId
  const overlay = entry && isOverlayTrack(entry.track) ? entry.clip.overlay : undefined
  const firstInfo = first ? resources.info.get(first.source.assetVersionId) : undefined
  const sourceInfo = entry ? resources.info.get(entry.clip.source.assetVersionId) : undefined
  const output = outputFrame(draft.doc.output, firstInfo)
  const aspect = sourceInfo?.width && sourceInfo.height ? sourceInfo.width / sourceInfo.height : 1
  const trackName = (kind: TimelineTrackKind, index: number, name?: string) => name ?? (kind === 'video' ? m.video : kind === 'overlay' ? m.overlay(f.number(index + 1)) : [m.music, m.soundEffects, m.voice][index] ?? m.audio(f.number(index + 1)))
  const textClip = !entry && selection.length === 1 && draft.doc.textTracks?.some(track => track.clips.some(clip => clip.id === selection[0]))
  if (textClip) return <TextInspector {...props} clipId={selection[0]!} />
  return <aside className={`vis-tl-inspector${entry ? ' has-selection' : ''}`} aria-label={entry ? m.clip : m.output}>
    {error && <p role="status" className="vis-tl-notice">{error}</p>}
    {entry ? <>
      <h3>{m.clip}</h3>
      <div className="vis-tl-source"><span>{m.source}</span><button type="button" disabled={!source} onClick={() => host.showOnCanvas(entry.clip.source.nodeId)}>
        {source?.title ?? (source ? source.kind === 'audio' ? m.audioKind : source.kind === 'image' ? m.image : m.video : m.sourceDeleted)} <span aria-hidden="true">&#8599;</span>
      </button></div>
      {resources.info.get(entry.clip.source.assetVersionId)?.version !== undefined && <small className="vis-tl-pinned">{m.pinnedVersion(`v${f.number(resources.info.get(entry.clip.source.assetVersionId)!.version!)}`)}</small>}
      {!source && <p className="vis-tl-notice">{m.sourceDeleted}</p>}
      {newer && <div className="vis-tl-notice">{m.newVersion}<button disabled={disabled || !resources.info.has(asset.assetVersionId)} onClick={() => apply(useNewVersion(draft.doc, entry.clip.id, asset.assetVersionId, { kind: source!.kind as 'video' | 'image' | 'audio', durationMs: resources.info.get(asset.assetVersionId)?.durationMs }))}>{m.useNewVersion}</button></div>}
      <fieldset disabled={disabled}>
        {overlay && <>
          {(['x', 'y', 'width', 'opacity'] as const).map(key => <CommitField key={key} label={key === 'x' ? m.overlayX : key === 'y' ? m.overlayY : key === 'width' ? m.overlaySize : m.opacity} unit={m.percent('')} type="number" min={key === 'width' ? 2 : 0} max={100} step={key === 'opacity' ? 1 : 0.1} value={String(Math.round(overlay[key] * 1000) / 10)} commit={value => {
            const n = Number(value)
            if (!Number.isFinite(n)) { setError(m.invalid); return }
            apply(updateClip(draft.doc, entry.clip.id, { overlay: boundedPlacement({ ...overlay, [key]: n / 100 }) }))
          }} />)}
          <select className="vis-tl-overlay-presets" aria-label={m.overlayPlacement} value="" disabled={!sourceInfo?.width || !sourceInfo.height} onChange={event => {
            apply(updateClip(draft.doc, entry.clip.id, { overlay: presetPlacement(overlay, event.target.value as PlacementPreset, aspect, output) }))
          }}>
            <option value="" disabled>{m.overlayPlacement}</option>
            {(['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'centre', 'fullWidth'] as const).map(preset => <option key={preset} value={preset}>{m[preset]}</option>)}
          </select>
        </>}
        <CommitField label={m.in} value={tc(entry.clip.inMs)} disabled={sourceKind === 'image'} commit={value => timeInput(value, ms => apply(trimClip(draft.doc, entry.clip.id, 'in', ms, { kind: sourceKind === 'image' ? 'image' : trackSourceKind(entry.track.kind), durationMs: resources.info.get(entry.clip.source.assetVersionId)?.durationMs })))} />
        <CommitField label={m.out} value={tc(entry.clip.outMs)} commit={value => timeInput(value, ms => apply(trimClip(draft.doc, entry.clip.id, 'out', ms, { kind: sourceKind === 'image' ? 'image' : trackSourceKind(entry.track.kind), durationMs: resources.info.get(entry.clip.source.assetVersionId)?.durationMs })))} />
        <CommitField label={m.length} value={tc(clipDurationMs(entry.clip))} commit={value => timeInput(value, ms => apply(trimClip(draft.doc, entry.clip.id, 'out', Math.round(sourceTimeAt(entry.clip, entry.clip.startMs + ms)), { kind: sourceKind === 'image' ? 'image' : trackSourceKind(entry.track.kind), durationMs: resources.info.get(entry.clip.source.assetVersionId)?.durationMs })))} />
        {(sourceKind === 'video' || sourceKind === 'audio') && <div className="vis-tl-speed">
          <CommitField label={m.speed} type="number" min={0.25} max={4} step={0.01} value={String(entry.clip.speed ?? 1)} commit={value => apply(setSpeed(draft.doc, entry.clip.id, Number(value), { kind: sourceKind }))} />
          <div className="vis-tl-speed-presets">{[0.5, 0.75, 1, 1.25, 1.5, 2].map(speed => <button key={speed} aria-pressed={(entry.clip.speed ?? 1) === speed} onClick={() => apply(setSpeed(draft.doc, entry.clip.id, speed, { kind: sourceKind }))}>{m.speedValue(f.number(speed))}</button>)}</div>
        </div>}
        {(!overlay || sourceKind === 'video') && <VolumeControl label={isMainVideoTrack(entry.track) ? m.clipAudio : m.clipVolume} value={entry.clip.volume} commit={volume => apply(updateClip(draft.doc, entry.clip.id, { volume }))} />}
        {overlay && <small className="vis-tl-dim">{m.pictureSoundFades}</small>}
        <CommitField label={`${m.fadeIn} (${m.seconds})`} type="number" min={0} max={10} value={String(entry.clip.fadeInMs / 1000)} commit={value => apply(updateClip(draft.doc, entry.clip.id, { fadeInMs: Number(value) * 1000 }))} />
        <CommitField label={`${m.fadeOut} (${m.seconds})`} type="number" min={0} max={10} value={String(entry.clip.fadeOutMs / 1000)} commit={value => apply(updateClip(draft.doc, entry.clip.id, { fadeOutMs: Number(value) * 1000 }))} />
        <button className="vis-tl-danger" onClick={() => { apply(deleteClips(draft.doc, selection)); select([]) }}>{m.deleteClip}</button>
      </fieldset>
    </> : <>
      <OutputSettings {...props} />
      <h3>{m.tracks}</h3>
      {draft.doc.tracks.map((track, index) => <div className="vis-tl-track-summary" key={track.id}>
        <span>{trackName(track.kind, draft.doc.tracks.slice(0, index).filter(t => t.kind === track.kind).length, track.name)}</span>
        {isOverlayTrack(track) ? <button aria-label={track.hidden ? m.showTrack : m.hideTrack} aria-pressed={!!track.hidden} disabled={disabled} onClick={() => apply(updateTrack(draft.doc, track.id, { hidden: !track.hidden }))}>{track.hidden ? m.showTrack : m.hideTrack}</button> : null}
        <button aria-label={track.muted ? m.unmute : m.mute} aria-pressed={track.muted} disabled={disabled} onClick={() => apply(updateTrack(draft.doc, track.id, { muted: !track.muted }))}>{track.muted ? m.unmute : m.mute}</button>
        <VolumeControl label={m.trackVolume} value={track.volume} disabled={disabled} commit={volume => apply(updateTrack(draft.doc, track.id, { volume }))} />
      </div>)}
      <h3>{m.latestExport}</h3>
      {exported && exportAsset ? <button className="vis-tl-export-card" onClick={() => host.showOnCanvas(exported.nodeId)}>
        {exported.kind === 'video' && <video src={host.assetUrl(exportAsset.assetVersionId)} preload="metadata" muted />}
        <span>{exported.title ?? m.latestExport}</span>
        <small>{m.exportedRevision(f.number(exported.exportOf!.timelineRevision))}</small>
        {exported.exportOf!.timelineRevision !== draft.baseRevision || draft.saveState !== 'saved' ? <span className="vis-tl-notice">{m.outOfDate}</span> : null}
      </button> : <p className="vis-tl-dim">{m.noExport}</p>}
    </>}
  </aside>
}
