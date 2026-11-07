import { FloatingNodeToolbar } from './FloatingNodeToolbar'
import { useEffect, useState } from 'react'
import { Position, useViewport } from '@xyflow/react'
import { clipEndMs, timelineDurationMs, type NodeView, type SlotVersionView, type SlotView, type TimelineDoc } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import type { CanvasActions } from './CanvasView'
import { AudioPlayer } from './AudioPlayer'
import { VideoPlayer } from './VideoPlayer'
import { VideoPoster } from './VideoPoster'
import { Icon } from './Icon'
import { toolbarOffset } from './toolbar'
import { nodeTitleNumber } from './node-title'
import { toolbarMessages } from './toolbar-messages'
import { latestTimelineExport, miniTimelineTracks, timelineClipCount, timelineExportRequest, timelineOutOfDate, timelineSummary, timelineTimecode } from './timeline-card'
import { timelineMessages } from './timeline-messages'
import './node-toolbar.css'
import './timeline-node.css'

export function TimelineNodeContent({ view, slot, doc, nodes, layoutNodes, actions, assetUrl, posterUrl, selected, playerSelected, processing, history }: {
  view: NodeView
  slot: SlotView
  doc: TimelineDoc
  nodes: NodeView[]
  layoutNodes: NodeView[]
  actions: CanvasActions
  assetUrl(id: string): string
  posterUrl(id: string): string
  selected: boolean
  playerSelected: boolean
  processing: boolean
  history: SlotVersionView[] | undefined
}) {
  const m = useMessages(timelineMessages)
  const tm = useMessages(toolbarMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const { zoom } = useViewport()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [chosen, setChosen] = useState<SlotVersionView | null>(null)
  const versions = history?.filter(version => version.content.type === 'timeline').sort((a, b) => a.revision - b.revision) ?? []
  useEffect(() => {
    if (selected) void actions.onLoadHistory?.(slot.slotId).catch(setError)
  }, [selected, slot.slotId, slot.revision, actions.onLoadHistory])
  useEffect(() => { setChosen(null) }, [selected, slot.revision])
  const currentDoc = chosen?.content.type === 'timeline' ? chosen.content.doc : doc
  const exported = latestTimelineExport(view.nodeId, nodes)
  const exportContent = exported?.slots.find(item => item.slotKey === 'main')?.content
  const first = currentDoc.tracks.find(track => track.kind === 'video')?.clips[0]
  const source = nodes.find(node => node.nodeId === first?.source.nodeId)
  const title = view.title ?? tm.fallback(m.timeline, format.number(nodeTitleNumber(view, nodes)))
  const time = (ms: number) => timelineTimecode(ms, value => format.number(value))
  const duration = time(timelineDurationMs(currentDoc))
  const tracks = miniTimelineTracks(currentDoc)
  const count = timelineClipCount(currentDoc)
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try { await work() }
    catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }
  return <>
    {selected ? <FloatingNodeToolbar nodeId={view.nodeId} isVisible position={Position.Top} offset={toolbarOffset(view.nodeId, layoutNodes, zoom, { w: actions.onOpenTimeline ? 400 : 290, h: 44 })}>
      <div className="vis-operations-toolbar nodrag nopan" role="toolbar" aria-label={m.timeline} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        {actions.onOpenTimeline ? <button aria-label={m.open} onClick={() => actions.onOpenTimeline!(view.nodeId)}><Icon kind="timeline" size={16} />{m.open}</button> : null}
        <button aria-label={m.export} disabled={!timelineClipCount(doc) || !actions.onMediaProcess || busy || processing || !!chosen}
          onClick={() => void run(() => actions.onMediaProcess!(timelineExportRequest(view.nodeId, slot)))}><Icon kind="video" size={16} />{m.export}</button>
        <span className="vis-operation-divider" />
        <button aria-label={m.download} disabled={!exported} onClick={() => { if (exported) actions.onDownload([exported]) }}><Icon kind="download" size={16} />{m.download}</button>
      </div>
    </FloatingNodeToolbar> : null}
    <section className="vis-timeline-card" aria-label={m.label(title, format.number(count), duration)} onDoubleClickCapture={event => { event.stopPropagation(); actions.onOpenTimeline?.(view.nodeId) }}>
      {/* The preview is most of the card, so it stays draggable; the players mark their own controls nodrag. */}
      <div className="vis-timeline-preview" role="group" aria-label={!chosen && exportContent?.type === 'asset' ? m.latestExport : m.firstClip}>
        {!chosen && exportContent?.type === 'asset' ? exported?.kind === 'audio'
          ? <AudioPlayer key={exportContent.assetVersionId} assetId={exportContent.assetVersionId} src={assetUrl(exportContent.assetVersionId)} selected={selected} onPreview={actions.onPreview} />
          : <VideoPlayer key={exportContent.assetVersionId} src={assetUrl(exportContent.assetVersionId)} posterSrc={posterUrl(exportContent.assetVersionId)} selected={playerSelected} compact />
          : first ? <TimelineStill assetId={first.source.assetVersionId} image={source?.kind === 'image'} inMs={first.inMs} assetUrl={assetUrl} posterUrl={posterUrl} />
            : <div className="vis-timeline-empty"><Icon kind="timeline" size={30} /><p>{count ? timelineSummary(currentDoc, locale) : m.empty}</p></div>}
        {!chosen && timelineOutOfDate(slot.revision, exported) ? <span className="vis-timeline-outdated">{m.outOfDate}</span> : null}
      </div>
      <div className="vis-timeline-mini">
        {tracks.map((track, index) => {
          const original = currentDoc.tracks[index]!
          const kindIndex = currentDoc.tracks.slice(0, index).filter(item => item.kind === track.kind).length
          const label = original.name ?? (track.kind === 'video' ? m.video
            : track.kind === 'overlay' ? m.overlay(format.number(kindIndex + 1))
            : [m.music, m.soundEffects, m.voice][kindIndex] ?? m.audio(format.number(kindIndex + 1)))
          return <div key={track.id} className="vis-timeline-lane" role="group" aria-label={label} style={{ opacity: track.opacity }}>
            <Icon kind={track.kind === 'overlay' ? 'image' : track.kind} size={12} />
            <div className="vis-timeline-blocks">{track.clips.map((clip, clipIndex) => {
              const content = original.clips[clipIndex]!
              const clipTitle = nodes.find(node => node.nodeId === clip.nodeId)?.title ?? label
              return <span key={clip.id} role="img" aria-label={m.clip(clipTitle, time(content.startMs), time(clipEndMs(content)))}
                className="vis-timeline-clip" style={{ left: `${clip.left}%`, width: `${clip.width}%`, background: track.color }} />
            })}</div>
          </div>
        })}
        <footer><Icon kind="timeline" size={13} /><span>{m.summary(format.number(count), duration)}</span></footer>
      </div>
      {chosen ? <div className="vis-timeline-history-actions nodrag nopan"><span>{m.version(format.number(chosen.revision), timelineSummary(currentDoc, locale))}</span>
        <button disabled={busy || !actions.onApply} onClick={() => void run(async () => {
          await actions.onApply!([{ op: 'timeline.set', slotId: slot.slotId, expectedRevision: slot.revision, doc: currentDoc }], m.restore)
          setChosen(null)
        })}>{m.restore}</button></div> : null}
      {error ? <p className="vis-timeline-error nodrag nopan" role="alert">{describeError(error, locale)}</p> : null}
    </section>
    {selected && versions.length > 1 ? <FloatingNodeToolbar nodeId={view.nodeId} isVisible position={Position.Bottom} offset={10}>
      <div className="vis-timeline-history nodrag nopan" role="group" aria-label={m.history} onPointerDown={event => event.stopPropagation()}>
        {versions.map(version => <button key={version.revision} aria-current={version.revision === slot.revision} aria-pressed={chosen?.revision === version.revision}
          onClick={() => setChosen(version.revision === slot.revision ? null : version)}>{m.version(format.number(version.revision), version.content.type === 'timeline' ? timelineSummary(version.content.doc, locale) : '')}{version.revision === slot.revision ? <small>{m.current}</small> : null}</button>)}
      </div>
    </FloatingNodeToolbar> : null}
  </>
}

function TimelineStill({ assetId, image, inMs, assetUrl, posterUrl }: { assetId: string; image: boolean; inMs: number; assetUrl(id: string): string; posterUrl(id: string): string }) {
  const [asImage, setAsImage] = useState(image)
  useEffect(() => setAsImage(image), [assetId, image])
  return asImage ? <img src={assetUrl(assetId)} alt="" draggable={false} />
    : <VideoPoster key={assetId} src={assetUrl(assetId)} posterSrc={posterUrl(assetId)} onError={() => setAsImage(true)}
      onLoadedMetadata={event => { event.currentTarget.currentTime = inMs / 1000 }} />
}
