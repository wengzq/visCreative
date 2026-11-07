import { useEffect, useState } from 'react'
import type { NodeView } from '@vis/protocol'
import { PeaksWaveform, useFormat, useMessages } from '@vis/ui-kit'
import type { EditorPartProps } from './types'
import { timelineEditorMessages } from './messages'
import { appendMedia, mediaNodes, nodeAsset, MEDIA_DRAG_TYPE, type MediaFilter } from './model/media'
import { useMediaResources } from './model/resources'
import { timecode } from './model/geometry'
import './timeline-area.css'

function MediaThumbnail({ node, host }: { node: NodeView; host: EditorPartProps['host'] }) {
  const asset = nodeAsset(node)!
  const cache = useMediaResources(host)
  const kind = node.kind === 'audio' ? 'peaks' : 'filmstrip'
  useEffect(() => { if (node.kind !== 'image') void cache.preview(asset.assetVersionId, kind) }, [cache, asset.assetVersionId, kind, node.kind])
  const preview = cache.previews.get(`${kind}:${asset.assetVersionId}`)
  if (preview?.kind === 'peaks') return <PeaksWaveform peaks={preview.peaks} binsPerSecond={preview.binsPerSecond} fromMs={0} toMs={preview.durationMs} height={56} color="var(--vis-text-dim)" />
  const url = node.kind === 'image' ? host.assetUrl(asset.assetVersionId) : preview?.kind === 'filmstrip' ? host.filmstripUrl(asset.assetVersionId) : null
  return <div className="vis-tl-media-thumb" style={url ? { backgroundImage: `url(${JSON.stringify(url)})`, backgroundSize: preview?.kind === 'filmstrip' ? `${preview.frames * 100}% 100%` : 'cover' } : undefined}>
    {!url && <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="12" height="10" rx="2" /><path d={node.kind === 'audio' ? 'M5 9h1l1-3 2 5 1-3h1' : 'm6 5 5 3-5 3Z'} /></svg>}
  </div>
}

export function MediaBin({ host, draft, clock }: EditorPartProps) {
  const m = useMessages(timelineEditorMessages)
  const f = useFormat()
  const [filter, setFilter] = useState<MediaFilter>('all')
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1280)
  const [notice, setNotice] = useState('')
  const allMedia = mediaNodes(host.nodes, 'all', '')
  const nodes = mediaNodes(host.nodes, filter, search)
  const cache = useMediaResources(host, allMedia.map(node => nodeAsset(node)!.assetVersionId))
  const used = new Set(draft.doc.tracks.flatMap(track => track.clips.map(clip => clip.source.nodeId)))
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1279px)')
    const change = () => setCollapsed(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  return <aside className={`vis-tl-media-bin${collapsed ? ' is-collapsed' : ''}`} aria-label={m.mediaBin}>
    <div className="vis-tl-bin-heading"><button aria-label={collapsed ? m.expand : m.collapse} title={collapsed ? m.expand : m.collapse} onClick={() => setCollapsed(!collapsed)}>
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="2" /><path d={collapsed ? 'M6 2v12m3-8 2 2-2 2' : 'M6 2v12m5-8-2 2 2 2'} /></svg>
    </button>{!collapsed && <span>{m.mediaBin}</span>}</div>
    {!collapsed && <>
      <div className="vis-tl-media-filters" role="group" aria-label={m.mediaBin}>{(['video', 'image', 'audio', 'all'] as const).map(kind => <button key={kind} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{kind === 'audio' ? m.audioKind : m[kind]}</button>)}</div>
      <input className="vis-tl-media-search" type="search" aria-label={m.search} placeholder={m.search} value={search} onChange={event => setSearch(event.target.value)} />
      {notice && <p className="vis-tl-notice" role="status">{notice}</p>}
      <div className="vis-tl-media-grid">
        {nodes.map(node => {
          const asset = nodeAsset(node)!
          const info = cache.info.get(asset.assetVersionId)
          const ready = node.kind === 'image' || !!info?.durationMs
          return <button className="vis-tl-media-card" key={node.nodeId} draggable={!draft.conflict && ready} disabled={!!draft.conflict}
            aria-label={node.title ?? (node.kind === 'audio' ? m.music : m[node.kind as 'video' | 'image'])}
            title={ready ? node.title ?? '' : cache.errors.has(`info:${asset.assetVersionId}`) ? m.unavailable : m.loadingMetadata}
            onDragStart={event => {
              event.dataTransfer.setData(MEDIA_DRAG_TYPE, node.nodeId)
              event.dataTransfer.setData(`${MEDIA_DRAG_TYPE}-${node.kind}`, node.nodeId)
              event.dataTransfer.effectAllowed = 'copy'
            }}
            onDoubleClick={() => {
              if (!ready) { setNotice(m.loadingMetadata); return }
              const result = appendMedia(draft.doc, node, info?.durationMs, clock.now())
              if (result.ok) { const refused = draft.edit(result.doc, { immediate: true }); setNotice(refused ? m[refused] : '') }
              else setNotice(m[result.reason])
            }}>
            <div className="vis-tl-media-picture"><MediaThumbnail node={node} host={host} />
              {info?.durationMs !== undefined && <span className="vis-tl-duration-chip">{timecode(info.durationMs, draft.doc.output?.fps ?? 30, f.number)}</span>}
              {used.has(node.nodeId) && <span className="vis-tl-used" title={m.used} aria-label={m.used}>&#10003;</span>}
            </div>
            <span className="vis-tl-media-title">{node.title ?? (node.kind === 'audio' ? m.music : m[node.kind as 'video' | 'image'])}</span>
          </button>
        })}
      </div>
      {!nodes.length && <div className="vis-tl-empty-media"><p>{allMedia.length ? m.noMatches : m.emptyMedia}</p>{!allMedia.length && host.upload && <button onClick={() => host.upload?.()}>{m.upload}</button>}</div>}
    </>}
  </aside>
}
