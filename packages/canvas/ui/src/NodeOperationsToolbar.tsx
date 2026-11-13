import { FloatingNodeToolbar } from './FloatingNodeToolbar'
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Position, useViewport } from '@xyflow/react'
import { LocalOperation, type GenerationOperation, type MediaKind, type NodeView } from '@vis/protocol'
import { useMessages } from '@vis/ui-kit'
import { toolbarEntries, toolbarFocusIndex, toolbarOffset, type ToolbarEntry } from './toolbar'
import { toolbarMessages } from './toolbar-messages'
import { Icon } from './Icon'
import './node-toolbar.css'
import { timelineMessages } from './timeline-messages'

function OperationIcon({ entry, kind }: { entry: ToolbarEntry; kind: MediaKind }) {
  if (!LocalOperation.safeParse(entry.operation).success) return <Icon kind="generate" size={16} />
  if (entry.operation === 'image.gridSplit') return <Icon kind="organize" size={16} />
  if (entry.operation === 'video.extractAudio') return <Icon kind="audio" size={16} />
  const paths = entry.operation === 'image.crop'
    ? <path d="M7 3v14h14M3 7h14v14" />
    : entry.operation.endsWith('trim') || entry.operation.endsWith('split')
      ? <><circle cx="5" cy="5" r="3" /><circle cx="5" cy="19" r="3" /><path d="m8 7 13 14M8 17 21 3" /></>
      : entry.operation === 'audio.speed'
        ? <><path d="M4 19a9 9 0 1 1 16 0M12 13l5-6" /><circle cx="12" cy="13" r="1" /></>
        : null
  return paths ? <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{paths}</svg> : <Icon kind={kind} size={16} />
}

export function NodeOperationsToolbar({ nodeId, nodes, kind, generation, disabled, regenerateDisabled = disabled, sourceJobId, running, onRegenerate, onOperation, onDownload, onExportMov, onFullscreen, onCreateTimeline }: {
  nodeId: string
  nodes: readonly NodeView[]
  kind: MediaKind
  generation?: readonly GenerationOperation[] | undefined
  disabled: boolean
  regenerateDisabled?: boolean | undefined
  sourceJobId?: string | undefined
  running?: boolean | undefined
  onRegenerate?: ((jobId: string) => Promise<void>) | undefined
  onOperation(entry: ToolbarEntry): void
  onDownload(): void
  onExportMov?: (() => void) | undefined
  onFullscreen(): void
  onCreateTimeline?(): void
}) {
  const m = useMessages(toolbarMessages)
  const tl = useMessages(timelineMessages)
  const [downloadMenu, setDownloadMenu] = useState(false)
  const [more, setMore] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const regeneratePending = useRef(false)
  const root = useRef<HTMLDivElement>(null)
  const { zoom } = useViewport()
  const [size, setSize] = useState({ w: 480, h: 44 })
  useLayoutEffect(() => {
    if (!root.current) return
    const observer = new ResizeObserver(() => {
      const rect = root.current?.getBoundingClientRect()
      if (rect) setSize({ w: rect.width, h: rect.height })
    })
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  const entries = toolbarEntries(kind, generation)
  const regenerate = () => {
    if (!sourceJobId || !onRegenerate || regeneratePending.current) return
    regeneratePending.current = true
    setRegenerating(true)
    void onRegenerate(sourceJobId).catch(() => {}).finally(() => {
      regeneratePending.current = false
      setRegenerating(false)
    })
  }
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      setMore(false)
      setDownloadMenu(false)
      event.currentTarget.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus()
      return
    }
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const next = toolbarFocusIndex(event.key, buttons.indexOf(event.target as HTMLButtonElement), buttons.length)
    if (next !== undefined) { event.preventDefault(); buttons[next]?.focus() }
  }
  const button = (entry: ToolbarEntry, menu = false) => {
    const paid = !LocalOperation.safeParse(entry.operation).success
    const label = entry.variant === 'smart' ? m.smartSplit : m[entry.operation]
    return <button key={`${entry.operation}:${entry.variant ?? ''}`} type="button" role={menu ? 'menuitem' : undefined}
      aria-label={label} title={paid ? m.providerHint : label} disabled={disabled}
      onClick={() => { setMore(false); onOperation(entry) }}>
      <OperationIcon entry={entry} kind={kind} />
      <span>{label}</span>{paid ? <span className="vis-operation-paid" aria-label={m.providerHint} /> : null}
    </button>
  }
  return <FloatingNodeToolbar nodeId={nodeId} isVisible position={Position.Top} offset={toolbarOffset(nodeId, nodes, zoom, size)}>
    <div ref={root} className="vis-operations-toolbar nodrag nopan" role="toolbar" aria-label={m.toolbar}
      onPointerDown={event => event.stopPropagation()} onKeyDown={keyboard}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setMore(false)
          setDownloadMenu(false)
        }
      }}>
      {sourceJobId && !running && onRegenerate ? <button type="button" aria-label={m.regenerateHint} title={m.regenerateHint} disabled={regenerateDisabled || regenerating} onClick={regenerate}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" /></svg>
        <span>{m.regenerate}</span>
      </button> : null}
      {entries.common.map(entry => button(entry))}
      {onCreateTimeline ? <button type="button" aria-label={tl.create} disabled={disabled} onClick={onCreateTimeline}><Icon kind="timeline" size={16} /><span>{tl.create}</span></button> : null}
      <span className="vis-operation-divider" />
      <div className="vis-operation-more">
        <button type="button" aria-label={m.more} aria-haspopup="menu" aria-expanded={more} disabled={disabled} onClick={() => setMore(!more)}>{m.more}</button>
        {more ? <div className="vis-operation-menu" role="menu" aria-label={m.more}>
          {entries.more.map(entry => button(entry, true))}
          <span title={m.comingSoon}><button type="button" role="menuitem" aria-label={m.customize} title={m.comingSoon} disabled>{m.customize}</button></span>
        </div> : null}
      </div>
      <span className="vis-operation-divider" />
      <div className="vis-operation-more">
        <button type="button" aria-label={m.download} title={m.download} disabled={disabled} aria-haspopup={onExportMov ? 'menu' : undefined} aria-expanded={onExportMov ? downloadMenu : undefined} onClick={() => {
          if (onExportMov) {
            setMore(false)
            setDownloadMenu(!downloadMenu)
          } else onDownload()
        }}>
          <Icon kind="download" size={16} />
        </button>
        {downloadMenu && onExportMov ? <div className="vis-operation-menu" role="menu" aria-label={m.download}>
          <button type="button" role="menuitem" onClick={() => { setDownloadMenu(false)
            onDownload() }}>{m.downloadOriginal}</button>
          <button type="button" role="menuitem" onClick={() => { setDownloadMenu(false)
            onExportMov() }}>{m['video.exportMov']}</button>
        </div> : null}
      </div>
      {kind !== 'audio' ? <button type="button" aria-label={m.fullscreen} title={m.fullscreen} disabled={disabled} onClick={onFullscreen}><Icon kind="fullscreen" size={16} /></button> : null}
    </div>
  </FloatingNodeToolbar>
}
