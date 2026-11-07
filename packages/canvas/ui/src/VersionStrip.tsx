import { FloatingNodeToolbar } from './FloatingNodeToolbar'
import { PlayIcon, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { nodeWheel } from './wheel'
import { Position } from '@xyflow/react'
import type { NodeKind, NodeView, SlotVersionView, SlotView } from '@vis/protocol'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CanvasActions } from './CanvasView'
import { freePosition, NODE_GAP } from './graph'
import { assetVersions, versionDescription, versionIndex } from './versions'
import './versions.css'
import { Icon } from './Icon'
import { VideoPlayer } from './VideoPlayer'
import { VideoPoster } from './VideoPoster'
import { mediaMessages } from './messages'

export type VersionStripProps = {
  versions: readonly SlotVersionView[]
  currentRevision: number
  selectedRevision?: number | undefined
  onHover(version: SlotVersionView | null): void
  onSelect(version: SlotVersionView): void
  size: 'sm' | 'lg'
  assetUrl(id: string): string
  posterUrl(id: string): string
  running?: boolean
}

/** Shared filmstrip for canvas and large previews; pass an asset-deduplicated list from oldest to newest */
export function VersionStrip({ versions, currentRevision, selectedRevision, onHover, onSelect, size, assetUrl, posterUrl, running }: VersionStripProps) {
  const m = useMessages(mediaMessages)
  const { locale } = useLocale()
  const strip = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ version: SlotVersionView; index: number; x: number; y: number } | null>(null)
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTip = () => {
    if (tipTimer.current) clearTimeout(tipTimer.current)
    setTip(null)
  }
  useEffect(() => () => { if (tipTimer.current) clearTimeout(tipTimer.current) }, [])
  useEffect(() => {
    strip.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [currentRevision])
  return <><div ref={strip} className={`vis-version-strip is-${size} nodrag nopan`} role="group" aria-label={m.historicalVersions} onPointerDown={e => e.stopPropagation()} onWheelCapture={e => nodeWheel(e, true, true)}>
    {versions.map((version, index) => version.content.type === 'asset' ? <button
      key={version.revision}
      className={`vis-version-thumb${selectedRevision === version.revision ? ' is-viewing' : ''}`}
      aria-label={m.viewVersion(String(index + 1))}
      aria-current={version.revision === currentRevision}
      aria-pressed={version.revision === selectedRevision}
      onMouseEnter={e => {
        onHover(version)
        hideTip()
        const rect = e.currentTarget.getBoundingClientRect()
        tipTimer.current = setTimeout(() => setTip({ version, index, x: Math.max(0, Math.min(rect.left - (strip.current?.getBoundingClientRect().left ?? 0), (strip.current?.clientWidth ?? 280) - 280)), y: (strip.current?.clientHeight ?? 64) + 8 }), 300)
      }} onMouseLeave={() => { onHover(null); hideTip() }}
      onFocus={() => onHover(version)} onBlur={() => onHover(null)}
      onClick={() => onSelect(version)}
    >
      {version.content.mime.startsWith('audio/') ? <Icon kind="audio" /> : version.content.mime.startsWith('video/')
        ? <><VideoPoster src={assetUrl(version.content.assetVersionId)} posterSrc={posterUrl(version.content.assetVersionId)} /><span className="vis-version-play"><PlayIcon /></span></>
        : <img src={assetUrl(version.content.assetVersionId)} alt="" draggable={false} />}
      {version.revision === currentRevision ? <span className="vis-version-current">{m.current}</span> : null}
    </button> : null)}
    {running ? <div className="vis-version-pending" aria-label={m.newVersionGenerating}><span className="vis-node-badge is-running">{m.generating}</span></div> : null}
  </div>{tip ? <div className="vis-version-tooltip" role="tooltip" style={{ left: tip.x, top: tip.y }}>{versionDescription(tip.version, tip.index, Date.now(), locale)}</div> : null}</>
}

const seen = new Map<string, number>()
const EMPTY: SlotVersionView[] = []

export function useNodeVersions({ view, history, actions, selected, nodes, selectNode, assetUrl, posterUrl, running, preview: inPreview = false }: {
  view: NodeView
  history: SlotVersionView[] | undefined
  actions: CanvasActions
  selected: boolean
  nodes: NodeView[]
  selectNode(id: string): void
  assetUrl(id: string): string
  posterUrl(id: string): string
  running: boolean
  preview?: boolean
}) {
  const m = useMessages(mediaMessages)
  const format = useFormat()
  const slot = view.slots.find(s => s.slotKey === 'main')!
  // Retain the old list and viewed version while refreshing history so new deliveries do not interrupt previews
  const previous = useRef<SlotVersionView[]>(EMPTY)
  if (history) previous.current = history
  const versions = useMemo(() => assetVersions(history ?? previous.current), [history])
  const current = versionIndex(versions, slot.content)
  const [chosen, setChosen] = useState<SlotVersionView | null>(null)
  const [hovered, setHovered] = useState<SlotVersionView | null>(null)
  const [busy, setBusy] = useState(false)
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const [, refreshSeen] = useState(0)
  const chosenIndex = chosen ? versions.findIndex(v => v.revision === chosen.revision) : -1
  const reviewing = selected && chosen !== null
  const preview = selected ? hovered ?? chosen : null
  const content = preview?.content ?? slot.content
  const unread = !selected && versions.length > (seen.get(slot.slotId) ?? versions.length)

  useEffect(() => {
    const target = ref.current
    if (!target) return
    const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)), { root: target.closest('.vis-canvas-wrap') })
    observer.observe(target)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if ((visible || selected) && !history) void actions.onLoadHistory?.(slot.slotId).catch(() => {})
  }, [visible, selected, slot.slotId, slot.revision, history, actions.onLoadHistory])
  useEffect(() => {
    if (history && (!seen.has(slot.slotId) || selected)) {
      seen.set(slot.slotId, versions.length)
    }
  }, [history, selected, slot.slotId, versions.length])
  useEffect(() => {
    if (!selected) { setChosen(null); setHovered(null) }
  }, [selected])

  const choose = (v: SlotVersionView) => {
    setHovered(null)
    setChosen(versionIndex([v], slot.content) === 0 ? null : v)
  }
  const restore = async () => {
    if (!chosen || chosen.content.type !== 'asset' || busy || !actions.onRestoreVersion) return
    setBusy(true)
    try {
      const result = await actions.onRestoreVersion(slot.slotId, chosen.content.assetVersionId, slot.revision, chosenIndex + 1)
      if (result === 'ok' || result === 'conflict') { setChosen(null); setHovered(null) }
    } catch {} finally { setBusy(false) }
  }
  useEffect(() => {
    if (!selected || versions.length < 2) return
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (inPreview && e.key === 'Escape') return
      if (e.key === 'Escape') { setChosen(null); setHovered(null); return }
      if (e.key === 'Enter' && chosen) {
        if ((e.target as HTMLElement).closest('button, a')) return
        e.preventDefault(); void restore(); return
      }
      if (e.key !== '[' && e.key !== ']') return
      e.preventDefault()
      const index = chosen ? chosenIndex : current
      const next = versions[Math.max(0, Math.min(versions.length - 1, index + (e.key === '[' ? -1 : 1)))]
      if (next) choose(next)
    }
    window.addEventListener('keydown', key, inPreview)
    return () => window.removeEventListener('keydown', key, inPreview)
  })

  const badge = versions.length > 1 ? <button className="vis-version-count nodrag nopan" aria-label={m.versionHistory} onClick={() => {
    seen.set(slot.slotId, versions.length)
    refreshSeen(n => n + 1)
    selectNode(view.nodeId)
  }}>{current + 1}/{format.number(versions.length)}{unread ? <span className="vis-version-unread" /> : null}</button> : null
  const strip = selected && versions.length > 1 ? <VersionStrip versions={versions} currentRevision={versions[current]?.revision ?? -1} selectedRevision={chosen?.revision} onHover={setHovered} onSelect={choose} size={inPreview ? 'lg' : 'sm'} assetUrl={assetUrl} posterUrl={posterUrl} running={running} /> : null
  const toolbar = strip && (inPreview ? strip : <FloatingNodeToolbar nodeId={view.nodeId} isVisible position={Position.Bottom} offset={10}><div className="vis-node-version-strip">{strip}</div></FloatingNodeToolbar>)
  const bar = reviewing ? <div className="vis-version-actions nodrag nopan" onPointerDown={e => e.stopPropagation()}>
    <span>v{chosenIndex + 1} / {format.number(versions.length)}</span>
    <button className="is-primary" disabled={busy} onClick={() => void restore()}>{m.setCurrent}</button>
    {!inPreview ? <button disabled={busy} onClick={() => {
      if (chosen.content.type !== 'asset' || !actions.onSaveVersion) return
      setBusy(true)
      const at = freePosition({ x: view.x + view.w + NODE_GAP, y: view.y }, view, nodes, 'y')
      void actions.onSaveVersion(view, chosen.content.assetVersionId, chosenIndex + 1, at)
        .then(selectNode).catch(() => {}).finally(() => setBusy(false))
    }}>{m.saveAsNode}</button> : null}
  </div> : null
  return { ref, badge, toolbar, bar, reviewing, content, source: preview ? preview.source : slot.source, previewing: preview !== null }
}

/** Fade in only after the new result loads; keep the old asset underneath until the animation ends */
export function VersionMedia({ assetId, kind, assetUrl, posterUrl, selected, previewing, source, hasAlpha }: { assetId: string; kind: NodeKind; assetUrl(id: string): string; posterUrl(id: string): string; selected: boolean; previewing: boolean; hasAlpha?: boolean | undefined; source?: SlotView['source'] }) {
  const last = useRef(assetId)
  const wasPreviewing = useRef(previewing)
  const [old, setOld] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  useLayoutEffect(() => {
    setOld(previewing || wasPreviewing.current ? null : last.current !== assetId ? last.current : null)
    setLoaded(false)
    wasPreviewing.current = previewing
  }, [assetId, previewing])
  useEffect(() => {
    if (!old || !loaded) return
    const timer = setTimeout(() => setOld(null), 400)
    return () => clearTimeout(timer)
  }, [old, loaded])
  const media = (id: string, previous = false) => kind === 'image'
    ? <img key={id} className={`vis-node-media${previous ? ' is-previous' : ''}`} src={assetUrl(id)} alt="" draggable={false} onLoad={() => { if (!previous) { last.current = id; setLoaded(true) } }} />
    : <div key={id} className={previous ? 'is-previous' : undefined} style={{ width: '100%', height: '100%' }}><VideoPlayer hasAlpha={hasAlpha} src={assetUrl(id)} posterSrc={posterUrl(id)} selected={!previous && selected} source={previous ? undefined : source} compact onLoadedData={() => { if (!previous) { last.current = id; setLoaded(true) } }} /></div>
  return <div className={`vis-version-media${old ? ' is-changing' : ''}${loaded ? ' is-loaded' : ''}`}>
    {old ? media(old, true) : null}{media(assetId)}
  </div>
}
