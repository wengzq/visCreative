import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isMainVideoTrack, timelineDurationMs } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useTimelineDraft } from './draft'
import { usePlaybackClock } from './player'
import { TimelineArea } from './TimelineArea'
import { Inspector, OutputSettings } from './Inspector'
import { MediaBin } from './MediaBin'
import { Preview } from './Preview'
import type { TimelineEditorHost } from './types'
import { timelineShellMessages } from './shell-messages'
import { PlayerIcon } from './player/PlayerIcon'
import { timecode } from './model/geometry'
import { useMediaResources } from './model/resources'
import { latestExport } from './model/media'
import { effectiveFps, outputDescription } from './model/output'
import './timeline.css'

export const TimelineEditor = memo(function TimelineEditor({ host }: { host: TimelineEditorHost }) {
  const draft = useTimelineDraft(host)
  const clock = usePlaybackClock(draft.doc)
  const [selection, select] = useState<readonly string[]>([])
  const m = useMessages(timelineShellMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const root = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [title, setTitle] = useState(host.node.title ?? m.timeline)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [outputOpen, setOutputOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [split, setSplit] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('vis.timeline.split'))
      return saved >= 200 ? Math.min(saved, window.innerHeight * 0.7) : window.innerHeight * 0.34
    } catch { return window.innerHeight * 0.34 }
  })
  const [error, setError] = useState<unknown>(null)
  const [pendingExit, setPendingExit] = useState<{ nodeId?: string } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [toast, setToast] = useState<'done' | 'failed' | null>(null)
  const first = draft.doc.tracks.find(isMainVideoTrack)?.clips[0]
  const resources = useMediaResources(host, first ? [first.source.assetVersionId] : [])
  const firstInfo = first ? resources.info.get(first.source.assetVersionId) : undefined
  const latest = useRef({ host, draft, clock })
  latest.current = { host, draft, clock }
  const previousTask = useRef(host.exportTask?.status)
  useEffect(() => {
    const status = host.exportTask?.status
    if (previousTask.current !== status && status === 'succeeded') setToast('done')
    if (previousTask.current !== status && status === 'failed') {
      setError(host.exportTask?.error)
      setToast('failed')
    }
    previousTask.current = status
  }, [host.exportTask])
  useEffect(() => setTitle(host.node.title ?? m.timeline), [host.node.title, m.timeline])
  useEffect(() => { if (selection.length) setInspectorOpen(true) }, [selection])
  useEffect(() => {
    closeButton.current?.focus()
  }, [])
  useEffect(() => {
    const clamp = () => setSplit(height => Math.max(200, Math.min(height, window.innerHeight * 0.7)))
    window.addEventListener('resize', clamp)
    return () => { window.removeEventListener('resize', clamp) }
  }, [])
  const afterFlush = useCallback(async (retry = false) => {
    if (latest.current.draft.saveError && !retry) throw latest.current.draft.saveError
    await latest.current.draft.flush()
    // The draft's committed revision reaches React before the export reads it.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    return !latest.current.draft.conflict
  }, [])
  const finishExit = useCallback((nodeId?: string) => {
    latest.current.clock.pause()
    if (nodeId) latest.current.host.showOnCanvas(nodeId)
    else latest.current.host.onClose()
  }, [])
  const leave = useCallback(async (nodeId?: string, retry = false) => {
    setError(null)
    try {
      if (!await afterFlush(retry)) return
      finishExit(nodeId)
    } catch (cause) { setError(cause); setPendingExit(nodeId ? { nodeId } : {}) }
  }, [afterFlush, finishExit])
  const close = () => leave()
  const navigate = (nodeId: string) => leave(nodeId)
  const wrappedHost = useMemo(() => ({ ...host, showOnCanvas: (nodeId: string) => { void leave(nodeId) } }), [host, leave])
  const parts = { host: wrappedHost, draft, clock, selection, select }
  const runExport = async () => {
    if (exporting || busy) return
    setError(null)
    setToast(null)
    setExporting(true)
    try {
      if (!await afterFlush()) return
      await latest.current.host.export(latest.current.draft.baseRevision)
      setToast('done')
    } catch (cause) { setError(cause); setToast('failed') }
    finally { setExporting(false) }
  }
  const busy = exporting || host.exportTask?.status === 'queued' || host.exportTask?.status === 'running'
  useEffect(() => {
    if (!root.current?.contains(document.activeElement)) closeButton.current?.focus()
  }, [busy, draft.conflict, menuOpen, outputOpen])
  const exported = latestExport(host.nodes, host.node.nodeId)
  const rename = async () => {
    const next = title.trim()
    if (host.rename && next !== (host.node.title ?? m.timeline)) {
      try { await host.rename(next) } catch (cause) { setError(cause) }
    }
  }
  const fps = effectiveFps(draft.doc.output, firstInfo)
  const resize = (value: number) => {
    const height = Math.max(200, Math.min(window.innerHeight * 0.7, value))
    setSplit(height)
    try { localStorage.setItem('vis.timeline.split', String(height)) } catch {}
  }
  return <div ref={root} tabIndex={-1} className="vis-tl-editor" role="dialog" aria-modal="true" aria-label={host.node.title ?? m.timeline}
    onPointerDownCapture={event => {
      if (!(event.target instanceof Element)) return
      const focusable = event.target.closest('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex], [contenteditable="true"]')
      if (!focusable || focusable === root.current) root.current?.focus({ preventScroll: true })
    }} onKeyDown={event => {
    if (event.key === 'Tab') {
      const focusable = [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length)
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      return
    }
    if (event.defaultPrevented || event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && document.fullscreenElement) {
      event.preventDefault()
      void document.exitFullscreen()
      return
    }
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.matches('input, textarea, select'))) return
    if (event.altKey || event.metaKey || event.ctrlKey) return
    const fps = effectiveFps(latest.current.draft.doc.output, firstInfo)
    if (event.code === 'Space') { event.preventDefault(); clock.playing() ? clock.pause() : clock.play() }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      clock.pause()
      clock.seek(clock.now() + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1000 : 1000 / fps))
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      clock.seek(event.key === 'Home' ? 0 : timelineDurationMs(draft.doc))
    } else if (event.key === 'Escape' && !selection.length) {
      event.preventDefault()
      void close()
    }
  }}>
    <header className="vis-tl-header">
      <button ref={closeButton} className="vis-icon-button" aria-label={m.closeEditor} onClick={() => void close()}><PlayerIcon kind="back" /></button>
      <input className="vis-tl-title" aria-label={m.title} value={title} readOnly={!host.rename} onChange={event => setTitle(event.target.value)} onBlur={() => void rename()} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
      <div className="vis-tl-output-anchor">
        <button className="vis-tl-metadata" aria-label={m.output} aria-expanded={outputOpen} onClick={() => setOutputOpen(!outputOpen)}>
          {timecode(timelineDurationMs(draft.doc), fps, format.number)} · {outputDescription(draft.doc.output, firstInfo, format.number, m)}
        </button>
        {outputOpen ? <div className="vis-popover vis-tl-output-popover"><OutputSettings {...parts} onDone={() => setOutputOpen(false)} /></div> : null}
      </div>
      <span className={`vis-tl-save is-${draft.saveState}`} role="status"><i />{m[draft.saveState]}</span>
      <div className="vis-tl-more">
        <button className="vis-icon-button" aria-label={m.more} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><PlayerIcon kind="more" /></button>
        {menuOpen ? <div className="vis-popover" role="menu">
          <button role="menuitem" disabled={!exported} onClick={() => { if (exported) host.download(exported); setMenuOpen(false) }}>{m.download}</button>
          <button role="menuitem" disabled={!exported} onClick={() => { if (exported) void navigate(exported.nodeId) }}>{m.showOnCanvas}</button>
        </div> : null}
      </div>
      {busy ? <span className="vis-tl-export-progress" role="status"><progress max={1} value={host.exportTask?.progress ?? 0} />{m.exporting(format.number(Math.round((host.exportTask?.progress ?? 0) * 100)))}</span> :
        <button className="is-primary" disabled={![...draft.doc.tracks, ...(draft.doc.textTracks ?? [])].some(track => track.clips.length) || !!draft.conflict} onClick={() => void runExport()}>{m.export}</button>}
    </header>
    {(draft.saveError || (error && !toast)) ? <div className="vis-tl-error" role="alert">
      <span>{describeError(draft.saveError || error, locale)}</span>
      {pendingExit ? <>
        <button disabled={draft.saveState === 'saving'} onClick={() => void leave(pendingExit.nodeId, true)}>{m.retry}</button>
        <button disabled={draft.saveState === 'saving'} onClick={() => finishExit(pendingExit.nodeId)}>{m.closeWithoutSaving}</button>
      </> : null}
    </div> : null}
    <div className="vis-tl-workspace">
      <div className={`vis-tl-upper${inspectorOpen ? ' inspector-open' : ''}`}>
        <MediaBin {...parts} />
        <Preview {...parts} />
        <aside className="vis-tl-inspector-panel">
          <button className="vis-icon-button vis-tl-panel-toggle" aria-label={m.inspector} aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)}><PlayerIcon kind="panel" /></button>
          <Inspector {...parts} />
        </aside>
      </div>
      <div className="vis-tl-splitter" role="separator" tabIndex={0} aria-label={m.resize} aria-orientation="horizontal" aria-valuemin={200} aria-valuemax={Math.round(window.innerHeight * 0.7)} aria-valuenow={Math.round(split)}
        onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); resize(split + (event.key === 'ArrowUp' ? 20 : -20)) } }}
        onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId)
        }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(window.innerHeight - event.clientY) }}
        onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} />
      <div className="vis-tl-bottom" style={{ height: split }}><TimelineArea {...parts} /></div>
    </div>
    {toast ? <div className="vis-tl-toast" role={toast === 'failed' ? 'alert' : 'status'}>
      <span>{toast === 'done' ? m.exported : describeError(error, locale)}</span>
      {toast === 'done' ? <button disabled={!exported} onClick={() => { if (exported) void navigate(exported.nodeId) }}>{m.showOnCanvas}</button> : <button onClick={() => void runExport()}>{m.retry}</button>}
      <button aria-label={m.dismiss} onClick={() => setToast(null)}>×</button>
    </div> : null}
  </div>
})
