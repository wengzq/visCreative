import { NodeToolbar, Position } from '@xyflow/react'
import type { BatchMedia, NodeView, ScriptDoc, ScriptOp, Shot, SlotView } from '@vis/protocol'
import { CloseIcon, IconButton, batchMessages, describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { createPortal } from 'react-dom'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CanvasActions, NodeDecoration } from './CanvasView'
import type { ScriptPartProps } from './script-ui'
import { ScriptAgentBar, ScriptAssetsTab } from './scriptParts'
import { ScriptShotsTab } from './ScriptShotsTab'
import { ScriptPromptsTab } from './ScriptPromptsTab'
import { AssetText } from './ScriptAssetInput'
import { shotBlockouts } from './previz'
import { assembleScriptTimeline, conflictRows, EXPORT_FIELDS, scriptCsv, scriptMarkdown, shotOutputs } from './script-table'
import { NodeTitle } from './NodeTitle'
import { scriptMessages } from './script-messages'
import { Icon } from './Icon'
import './script-node.css'
import { ScriptBatchDialog } from './ScriptBatchDialog'
import { ScriptBatchSummary } from './ScriptBatchProgress'
import { batchShotIds } from './script-batch'

export function downloadScript(doc: ScriptDoc, kind: 'csv' | 'md', headers: readonly string[], missing: string) {
  const body = kind === 'csv' ? scriptCsv(doc, headers, missing) : scriptMarkdown(doc, headers, missing)
  const url = URL.createObjectURL(new Blob([kind === 'csv' ? '\uFEFF' : '', body], { type: kind === 'csv' ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `storyboard.${kind}`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ScriptNodeContent({ view, slot, doc, deco, nodes, actions, selected, suspended, assetUrl, posterUrl, onFocus, onPanelFocus, children }: {
  view: NodeView
  slot: SlotView
  doc: ScriptDoc
  deco: NodeDecoration | undefined
  nodes: NodeView[]
  actions: CanvasActions
  selected: boolean
  suspended: boolean
  assetUrl(id: string): string
  posterUrl(id: string): string
  onFocus(id: string): void
  onPanelFocus?(nodeId: string, panelId: string): void
  children?(parts: ScriptPartProps, expanded: boolean): ReactNode
}) {
  const m = useMessages(scriptMessages)
  const bm = useMessages(batchMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const [expanded, setExpanded] = useState(false)
  useEffect(() => { if (deco?.scriptShot) setExpanded(true) }, [deco?.scriptShot?.seq])
  const [batchMedia, setBatchMedia] = useState<BatchMedia | null>(null)
  const [busy, setBusy] = useState(false)
  const [assembling, setAssembling] = useState(false)
  const assemblyPending = useRef(false)
  const pending = useRef<Promise<void>>(Promise.resolve())
  const [error, setError] = useState<unknown>(null)
  const [conflicted, setConflicted] = useState(false)
  const [currentRows, setCurrentRows] = useState<{ revision: number; rows: Shot[] } | null>(null)
  const expand = useRef<HTMLButtonElement>(null)
  const currentDoc = useMemo(() => ({ ...doc, shots: doc.shots.map(shot => currentRows?.revision === slot.revision
    ? currentRows.rows.find(row => row.id === shot.id && row.rev > shot.rev) ?? shot : shot) }), [doc, currentRows, slot.revision])
  const outputs = useMemo(() => shotOutputs(nodes, view.nodeId), [nodes, view.nodeId])
  const blockouts = useMemo(() => shotBlockouts(nodes, view.nodeId), [nodes, view.nodeId])
  const usableShots = useMemo(() => assembleScriptTimeline(view.nodeId, currentDoc, nodes).items.length > 0, [view.nodeId, currentDoc, nodes])
  const assemble = async () => {
    if (!actions.onAssembleScriptTimeline || assemblyPending.current) return
    assemblyPending.current = true
    setAssembling(true)
    try { onFocus(await actions.onAssembleScriptTimeline(view.nodeId)) }
    catch (cause) { setError(cause) }
    finally { assemblyPending.current = false; setAssembling(false) }
  }
  const onPatch = async (ops: ScriptOp[]) => {
    const apply = actions.onApply
    if (!ops.length || !apply) return
    setBusy(true)
    const write = pending.current.catch(() => {}).then(async () => {
      setError(null)
      setConflicted(false)
      try { await apply([{ op: 'script.patch', slotId: slot.slotId, ops }], m.edit) }
      catch (cause) {
        const rows = conflictRows(cause)
        if (rows) { setCurrentRows({ revision: slot.revision, rows }); setConflicted(true) }
        else setError(cause)
        throw cause
      }
    })
    pending.current = write
    try { await write }
    finally { if (pending.current === write) setBusy(false) }
  }
  const parts: ScriptPartProps = { view, slot, doc: currentDoc, outputs, blockouts, onPatch, batches: deco?.scriptBatches ?? [], batchJobs: deco?.scriptBatchJobs ?? [] }
  const agent = deco?.scriptAgent
  const working = agent?.task === 'breakdown' ? m.workingBreakdown : agent?.task === 'prompts' ? m.workingPrompts : m.workingCustom
  const notice = <>{conflicted ? <p className="vis-script-notice" role="status">{m.conflict}</p> : null}{error ? <p className="vis-script-error" role="alert">{describeError(error, locale)}</p> : null}</>
  const close = () => { setExpanded(false); requestAnimationFrame(() => expand.current?.focus()) }
  const exportDoc = (kind: 'csv' | 'md') => downloadScript(currentDoc, kind, EXPORT_FIELDS.map(field => m[field]), m.deletedAsset)
  return <>
    {selected && !expanded ? <NodeToolbar nodeId={view.nodeId} isVisible position={Position.Top} offset={40}>
      <div className="vis-script-node-toolbar nodrag nopan" role="toolbar" aria-label={m.script}>
        <button aria-label={m.openEditor} onClick={() => setExpanded(true)}><Icon kind="script" size={16} />{m.openEditor}</button>
        <span title={usableShots ? m.assembleTimeline : m.noTimelineShots}><button aria-label={m.assembleTimeline} title={usableShots ? m.assembleTimeline : m.noTimelineShots} disabled={!usableShots || assembling || busy || !actions.onAssembleScriptTimeline} onClick={() => void assemble()}><Icon kind="timeline" size={16} />{m.assembleTimeline}</button></span>
        {(['frames', 'video'] as const).map(media => <button key={media} disabled={!currentDoc.shots.length || !actions.onPlanScriptBatch || !actions.onStartScriptBatch} onClick={() => setBatchMedia(media)}>{bm[media]}</button>)}
        <button aria-label={m.exportCsv} onClick={() => exportDoc('csv')}>{m.csv}</button>
        <button aria-label={m.exportMarkdown} onClick={() => exportDoc('md')}>{m.markdown}</button>
      </div>
    </NodeToolbar> : null}
    <div className="vis-script-card" onDoubleClick={event => { event.stopPropagation(); setExpanded(true) }}>
      <div className="vis-script-card-summary"><Icon kind="script" size={22} /><strong>{m.summary(format.number(currentDoc.shots.length), format.number(currentDoc.shots.reduce((total, shot) => total + (shot.durationSec ?? 0), 0)), currentDoc.shots.length)}</strong></div>
      {currentDoc.shots.length ? <ol>{currentDoc.shots.slice(0, 3).map((shot, index) => <li key={shot.id}><span>{format.number(index + 1)}</span><p><AssetText text={shot.description} assets={currentDoc.assets} /></p></li>)}</ol> : <p className="vis-script-card-empty">{m.empty}</p>}
      <footer><span>{m.assetCount(format.number(currentDoc.assets.length), currentDoc.assets.length)}</span><button ref={expand} aria-label={m.openEditor} onClick={() => setExpanded(true)}>{m.openEditor}</button></footer>
      {agent?.running ? <button className="vis-script-agent-badge" onClick={() => actions.onOpenSession?.(agent.sessionId)}>{working(agent.title)}</button> : null}
      {!expanded ? <ScriptBatchSummary batches={parts.batches ?? []} actions={actions} jobs={parts.batchJobs ?? []} /> : null}
      {!expanded ? notice : null}
    </div>
    {children?.(parts, expanded)}
    {batchMedia ? <ScriptBatchDialog parts={parts} media={batchMedia} actions={actions} onClose={() => setBatchMedia(null)} /> : null}
    {expanded ? <ScriptEditor shotFocus={deco?.scriptShot} parts={parts} nodes={nodes} disabled={busy || !actions.onApply} suspended={suspended} actions={actions} assetUrl={assetUrl} posterUrl={posterUrl}
      onPanelFocus={(nodeId, panelId) => { setExpanded(false); onFocus(nodeId); onPanelFocus?.(nodeId, panelId) }} onFocus={id => { setExpanded(false); onFocus(id) }} onClose={close} onError={setError} notice={notice} onExport={exportDoc} /> : null}
  </>
}

function ScriptEditor({ shotFocus, parts, nodes, disabled, suspended, actions, assetUrl, posterUrl, onFocus, onPanelFocus, onClose, onError, notice, onExport }: {
  shotFocus?: { shotId: string; seq: number } | undefined
  parts: ScriptPartProps
  nodes: NodeView[]
  disabled: boolean
  suspended: boolean
  actions: CanvasActions
  assetUrl(id: string): string
  posterUrl(id: string): string
  onFocus(id: string): void
  onPanelFocus(nodeId: string, panelId: string): void
  onClose(): void
  onError(error: unknown): void
  notice: ReactNode
  onExport(kind: 'csv' | 'md'): void
}) {
  const m = useMessages(scriptMessages)
  const bm = useMessages(batchMessages)
  const format = useFormat()
  const [tab, setTab] = useState<'shots' | 'assets' | 'prompts'>('shots')
  const [selected, setSelected] = useState(new Set<string>())
  const [batchMedia, setBatchMedia] = useState<BatchMedia | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const suspendedFocus = useRef<HTMLElement | null>(null)
  const tabsId = useId()
  useEffect(() => { if (shotFocus) { setTab('shots'); setSelected(new Set([shotFocus.shotId])) } }, [shotFocus?.seq])
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (suspended) {
      suspendedFocus.current = element.contains(document.activeElement) ? document.activeElement as HTMLElement : null
      element.close()
    } else {
      element.showModal()
    }
  }, [suspended])
  useEffect(() => {
    if (suspended || disabled || !suspendedFocus.current) return
    suspendedFocus.current.focus()
    suspendedFocus.current = null
  }, [suspended, disabled])
  useEffect(() => () => { dialog.current?.close() }, [])
  useEffect(() => {
    setSelected(current => new Set([...current].filter(id => parts.doc.shots.some(shot => shot.id === id))))
  }, [parts.doc.shots])
  return createPortal(<dialog ref={dialog} className="vis-script-editor nodrag nopan" aria-label={m.editor} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose() }}
    onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
      if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) return
      event.stopPropagation()
    }}>
    <header className="vis-script-editor-header">
      <div><NodeTitle view={parts.view} nodes={nodes} onApply={actions.onApply} /><ScriptAgentBar {...parts} tasks={[]} /></div>
      <div className="vis-script-editor-header-actions">
        {(['frames', 'video'] as const).map(media => <button key={media} disabled={disabled || !parts.doc.shots.length || !actions.onPlanScriptBatch || !actions.onStartScriptBatch} onClick={() => setBatchMedia(media)}>{bm[media]}</button>)}
        <button onClick={() => onExport('csv')}>{m.exportCsv}</button><button onClick={() => onExport('md')}>{m.exportMarkdown}</button><IconButton label={m.closeEditor} onClick={onClose}><CloseIcon /></IconButton>
      </div>
    </header>
    <ScriptBatchSummary batches={parts.batches ?? []} actions={actions} jobs={parts.batchJobs ?? []} />
    <div className="vis-script-tabs" role="tablist" aria-label={m.editor}>
      {(['shots', 'assets', 'prompts'] as const).map((name, index) => <button key={name} id={`${tabsId}-${name}`} role="tab" aria-label={m[name]} aria-controls={`${tabsId}-${name}-panel`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1}
        onClick={() => setTab(name)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 'shots' : event.key === 'End' ? 'prompts' : (['shots', 'assets', 'prompts'] as const)[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3]!
          setTab(next)
          document.getElementById(`${tabsId}-${next}`)?.focus()
        }}><span aria-hidden="true">{format.number(index + 1)}</span>{m[name]}</button>)}
    </div>
    <div className="vis-script-editor-notices" aria-live="polite">{notice}</div>
    <div id={`${tabsId}-shots-panel`} role="tabpanel" aria-labelledby={`${tabsId}-shots`} hidden={tab !== 'shots'} className="vis-script-tab-panel">
      <ScriptShotsTab shotFocus={shotFocus} nodes={nodes} onPanelFocus={onPanelFocus} parts={parts} disabled={disabled} actions={actions} selected={selected} onSelection={setSelected} assetUrl={assetUrl} posterUrl={posterUrl} onFocus={onFocus} onError={onError} />
    </div>
    <div id={`${tabsId}-assets-panel`} role="tabpanel" aria-labelledby={`${tabsId}-assets`} hidden={tab !== 'assets'} className="vis-script-tab-panel vis-script-assets-panel"><ScriptAssetsTab {...parts} /></div>
    <div id={`${tabsId}-prompts-panel`} role="tabpanel" aria-labelledby={`${tabsId}-prompts`} hidden={tab !== 'prompts'} className="vis-script-tab-panel"><ScriptPromptsTab parts={parts} disabled={disabled} selected={selected} onSelection={setSelected} /></div>
    {batchMedia ? <ScriptBatchDialog parts={parts} media={batchMedia} shotIds={batchShotIds(parts.doc.shots, selected)} actions={actions} onClose={() => setBatchMedia(null)} /> : null}
  </dialog>, document.body)
}
