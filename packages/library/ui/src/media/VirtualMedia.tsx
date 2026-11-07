import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LibraryAsset } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import type { LibraryHost } from '../types'
import { LIBRARY_ASSET_MIME } from './host'
import { mediaMessages } from './messages'

export function virtualWindow(count: number, columns: number, rowHeight: number, scrollTop: number, height: number) {
  const rows = Math.ceil(count / columns)
  const total = rows * rowHeight
  // Responsive column changes can shrink the scroll range before the browser delivers its clamped scroll event.
  const top = Math.max(0, Math.min(scrollTop, total - height))
  const start = Math.max(0, Math.floor(top / rowHeight) - 1)
  const end = Math.min(rows, Math.ceil((top + height) / rowHeight) + 1)
  return { start: start * columns, end: Math.min(count, end * columns), offset: start * rowHeight, total }
}

export function mediaDuration(ms: number, number: (value: number) => string): string {
  const seconds = Math.floor(ms / 1000)
  return `${number(Math.floor(seconds / 60)).padStart(2, number(0))}:${number(seconds % 60).padStart(2, number(0))}`
}

export function VirtualMedia({ assets, host, selected, entities, onSelect, onOpen }: {
  assets: LibraryAsset[]; host: LibraryHost; selected: ReadonlySet<string>; entities: ReadonlyMap<string, string>
  onSelect(asset: LibraryAsset): void; onOpen(asset: LibraryAsset): void
}) {
  const m = useMessages(mediaMessages)
  const format = useFormat()
  const viewport = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 430, height: 330, top: 0 })
  const [playing, setPlaying] = useState<string>()
  const audio = useRef<HTMLAudioElement>(null)
  const pendingFocus = useRef<number | undefined>(undefined)
  const audioOnly = assets[0]?.kind === 'audio'
  const videoOnly = assets[0]?.kind === 'video'
  const columns = audioOnly ? 1 : videoOnly ? 2 : Math.max(2, Math.floor(size.width / 100))
  const cardWidth = (size.width - (columns - 1) * 8) / columns - 6
  const thumbnailHeight = Math.round(cardWidth * (videoOnly ? 9 / 16 : 1))
  const rowHeight = audioOnly ? 36 : thumbnailHeight + 38
  const range = virtualWindow(assets.length, columns, rowHeight, size.top, size.height)
  const playingAsset = assets.find(asset => asset.assetId === playing)
  useLayoutEffect(() => {
    if (pendingFocus.current === undefined) return
    const target = viewport.current?.querySelector<HTMLButtonElement>(`[data-library-index="${pendingFocus.current}"]`)
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = undefined }
  })
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const resize = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect) setSize(previous => ({ ...previous, width: rect.width, height: rect.height }))
    })
    resize.observe(element)
    return () => resize.disconnect()
  }, [])
  useEffect(() => {
    const element = audio.current
    if (!element || !playing) return
    void element.play().catch(() => setPlaying(undefined))
  }, [playing])
  const name = (asset: LibraryAsset) => asset.displayName ?? asset.latest.displayName ?? m[asset.kind]
  const moveFocus = (index: number, key: string) => {
    const offset = key === 'ArrowDown' ? columns : key === 'ArrowUp' ? -columns : key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0
    const target = key === 'Home' ? 0 : key === 'End' ? assets.length - 1 : Math.max(0, Math.min(assets.length - 1, index + offset))
    const top = Math.floor(target / columns) * rowHeight
    if (viewport.current) {
      pendingFocus.current = target
      if (top < viewport.current.scrollTop) viewport.current.scrollTop = top
      else if (top + rowHeight > viewport.current.scrollTop + size.height) viewport.current.scrollTop = top + rowHeight - size.height
      setSize(previous => ({ ...previous, top: viewport.current!.scrollTop }))
    }
  }
  return <>
    <div ref={viewport} className={`library-virtual-media${audioOnly ? ' is-audio' : ''}${selected.size ? ' is-selecting' : ''}`} style={{ height: Math.min(audioOnly ? 240 : 330, Math.ceil(assets.length / columns) * rowHeight) }} onScroll={event => {
      const top = event.currentTarget.scrollTop
      setSize(previous => ({ ...previous, top }))
    }}>
      <div style={{ height: range.total, position: 'relative' }} role="list">
        <div className="library-media-grid" style={{ position: 'absolute', top: range.offset, left: 0, right: 0, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: rowHeight }}>
          {assets.slice(range.start, range.end).map((asset, offset) => {
            const index = range.start + offset
            const title = name(asset)
            return <article key={asset.assetId} role="listitem" className={`library-media-card${selected.has(asset.assetId) ? ' is-selected' : ''}`} aria-label={title}>
              <input type="checkbox" aria-label={m.selection(title)} title={selected.size >= 50 ? m.selectLimit : m.selection(title)} disabled={selected.size >= 50 && !selected.has(asset.assetId)} checked={selected.has(asset.assetId)} onChange={() => onSelect(asset)} />
              <button className="library-media-open" aria-label={title} data-library-index={index} draggable onDragStart={event => {
                event.dataTransfer.setData(LIBRARY_ASSET_MIME, JSON.stringify({ assetVersionId: asset.latest.assetVersionId, kind: asset.kind, title, width: asset.latest.width, height: asset.latest.height }))
                event.dataTransfer.effectAllowed = 'copy'
              }} onClick={() => {
                if (audioOnly) setPlaying(current => current === asset.assetId ? undefined : asset.assetId)
                onOpen(asset)
              }} onKeyDown={event => {
                if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                moveFocus(index, event.key)
              }}>
                {audioOnly ? <span className="library-audio-icon" aria-hidden="true">{playing === asset.assetId ? 'Ⅱ' : '♫'}</span> : <span className="library-media-thumbnail" style={{ height: thumbnailHeight }}>
                  <img loading="lazy" draggable={false} src={asset.kind === 'video' ? host.posterUrl(asset.latest.assetVersionId) : host.assetUrl(asset.latest.assetVersionId)} alt="" />
                  {asset.kind === 'video' ? <span className="library-video-play" aria-hidden="true">▶</span> : null}
                  {asset.latest.durationMs !== undefined ? <span className="library-duration">{mediaDuration(asset.latest.durationMs, format.number)}</span> : null}
                </span>}
                <span className="library-media-name" title={title}>{title}</span>
                {audioOnly && asset.latest.durationMs !== undefined ? <span className="library-muted">{mediaDuration(asset.latest.durationMs, format.number)}</span> : null}
                {asset.labeledBy === 'agent' ? <span className="library-review-marker" title={m.review} aria-label={m.review}>●</span> : null}
              </button>
              <div className="library-media-chips">{asset.tags.slice(0, 2).map(tag => <span key={tag}>{tag}</span>)}{asset.entityIds.map(id => entities.get(id)).filter(Boolean).slice(0, 1).map(entity => <span className="library-entity-chip" key={entity}>{entity}</span>)}</div>
            </article>
          })}
        </div>
      </div>
    </div>
    {playingAsset ? <audio ref={audio} src={host.assetUrl(playingAsset.latest.assetVersionId)} onPause={() => setPlaying(undefined)} onEnded={() => setPlaying(undefined)} /> : null}
  </>
}
