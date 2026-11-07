import { textEditAnchor, SCRIPT_LIMITS, type NodeView, type ScriptAsset, type ScriptOp, type Shot, type ShotFields } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasActions } from './CanvasView'
import type { ScriptPartProps } from './script-ui'
import { ScriptCell } from './ScriptCell'
import { bulkShots, continuousChains, deleteShot, insertShot, moveShot, updateShot } from './script-table'
import { scriptMessages } from './script-messages'
import { Icon } from './Icon'
import { ShotBatchProgress } from './ScriptBatchProgress'
import { shotBatchSteps } from './script-batch'
import { previzMessages } from './previz-messages'
import { VideoPoster } from './VideoPoster'

const ROW_HEIGHT = 108
const TEXT_FIELDS = ['description', 'endState', 'shotSize', 'camera', 'dialogue', 'sound'] as const
const COLORS = ['red', 'yellow', 'green', 'blue', 'purple'] as const
const COLUMNS = ['number', 'durationSec', 'transition', 'description', 'endState', 'shotSize', 'camera', 'characterIds', 'sceneId', 'propIds', 'dialogue', 'sound', 'color', 'outputs', 'actions'] as const

function AssetSelect({ assets, value, label, disabled, multiple = false, onChange }: {
  assets: readonly ScriptAsset[]
  value: string | readonly string[]
  label: string
  disabled: boolean
  multiple?: boolean
  onChange(ids: string[]): void
}) {
  const m = useMessages(scriptMessages)
  if (multiple) return <div className="vis-script-cast-options" role="group" aria-label={label}>
    {assets.map(asset => <label key={asset.id}><input type="checkbox" disabled={disabled} checked={value.includes(asset.id)}
      onChange={event => onChange(event.target.checked ? [...value, asset.id] : [...value].filter(id => id !== asset.id))} /><span>{asset.name}</span></label>)}
  </div>
  return <select aria-label={label} value={value} disabled={disabled} multiple={multiple}
    onChange={event => onChange(Array.from(event.currentTarget.selectedOptions, option => option.value).filter(Boolean))}>
    {!multiple ? <option value="">{m.none}</option> : null}
    {assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
  </select>
}

function ShotOutputs({ shot, outputs, blockout, actions, scriptNodeId, assetUrl, posterUrl, onFocus, onError, disabled }: {
  shot: Shot
  outputs: readonly NodeView[]
  blockout?: NodeView | undefined
  actions: CanvasActions
  scriptNodeId: string
  assetUrl(id: string): string
  posterUrl(id: string): string
  onFocus(id: string): void
  onError(error: unknown): void
  disabled: boolean
}) {
  const m = useMessages(scriptMessages)
  const [creating, setCreating] = useState(false)
  const create = (role: 'first' | 'video') => {
    if (!actions.onCreateShotNode) return
    setCreating(true)
    void actions.onCreateShotNode(scriptNodeId, shot.id, role).then(onFocus).catch(onError).finally(() => setCreating(false))
  }
  return <div className="vis-script-outputs">
    <div className="vis-script-output-previews">
      {(['previz', 'first', 'last', 'video'] as const).flatMap(role => (role === 'previz' ? [...new Set([...(blockout ? [blockout] : []), ...outputs.filter(node => node.shot?.role === role)])] : outputs.filter(node => node.shot?.role === role)).map(node => {
        const content = node.slots.find(slot => slot.slotKey === 'main')?.content
        const label = node.title ?? node.nodeId
        return <button key={node.nodeId} className={role === 'previz' ? 'vis-script-blockout-output' : undefined} aria-label={m.focusOutput(m[role], label)} title={`${m[role]} · ${label}${content?.type === 'asset' ? '' : ` · ${m.pendingOutput}`}`} onClick={() => onFocus(node.nodeId)}>
          {content?.type === 'asset' ? role === 'previz' ? <img src={posterUrl(content.assetVersionId)} alt="" draggable={false} /> : role === 'video' ? <VideoPoster src={assetUrl(content.assetVersionId)} posterSrc={posterUrl(content.assetVersionId)} /> : <img src={assetUrl(content.assetVersionId)} alt="" draggable={false} /> : <Icon kind={role === 'video' ? 'video' : 'image'} size={16} />}
          <small>{m[role]}</small>
        </button>
      }))}
    </div>
    <div className="vis-script-output-actions">
      <button aria-label={m.createImage} disabled={disabled || creating || !actions.onCreateShotNode} onClick={() => create('first')}><Icon kind="image" size={14} /></button>
      <button aria-label={m.createVideo} disabled={disabled || creating || !actions.onCreateShotNode} onClick={() => create('video')}><Icon kind="video" size={14} /></button>
    </div>
  </div>
}

export function ScriptShotsTab({ shotFocus, nodes = [], onPanelFocus, parts, disabled, actions, selected, onSelection, assetUrl, posterUrl, onFocus, onError }: {
  shotFocus?: { shotId: string; seq: number } | undefined
  nodes?: NodeView[]
  onPanelFocus?(nodeId: string, panelId: string): void
  parts: ScriptPartProps
  disabled: boolean
  actions: CanvasActions
  selected: ReadonlySet<string>
  onSelection(ids: Set<string>): void
  assetUrl(id: string): string
  posterUrl(id: string): string
  onFocus(id: string): void
  onError(error: unknown): void
}) {
  const m = useMessages(scriptMessages)
  const pm = useMessages(previzMessages)
  const format = useFormat()
  const { doc, onPatch } = parts
  const scroll = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const [focusedRow, setFocusedRow] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [duration, setDuration] = useState('')
  const [size, setSize] = useState('')
  const [scene, setScene] = useState('keep')
  const scenes = doc.assets.filter(asset => asset.kind === 'scene')
  const chains = useMemo(() => {
    const byId = new Map<string, string>()
    for (const chain of continuousChains(doc.shots)) chain.forEach((id, index) => byId.set(id, index === 0 ? 'start' : index === chain.length - 1 ? 'end' : 'middle'))
    return byId
  }, [doc.shots])
  useEffect(() => {
    const element = scroll.current
    if (!element) return
    const resize = new ResizeObserver(() => setViewport(current => ({ ...current, height: element.clientHeight })))
    resize.observe(element)
    return () => resize.disconnect()
  }, [])
  useEffect(() => {
    if (!shotFocus || !scroll.current) return
    const index = doc.shots.findIndex(shot => shot.id === shotFocus.shotId)
    if (index < 0) return
    setFocusedRow(shotFocus.shotId)
    scroll.current.scrollTop = index * ROW_HEIGHT
    setViewport({ top: scroll.current.scrollTop, height: scroll.current.clientHeight })
    requestAnimationFrame(() => scroll.current?.querySelector<HTMLElement>(`tr[aria-rowindex="${index + 2}"]`)?.focus())
  }, [shotFocus?.seq])
  const patch = (ops: ScriptOp[]) => { if (ops.length) void onPatch(ops).catch(() => {}) }
  const start = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - 4)
  const end = Math.min(doc.shots.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + 4)
  const pinned = doc.shots.findIndex(shot => shot.id === focusedRow)
  const indices = [...new Set([...Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset), ...(pinned >= 0 ? [pinned] : [])])].sort((a, b) => a - b)
  const allSelected = doc.shots.length > 0 && doc.shots.every(shot => selected.has(shot.id))
  const toggle = (id: string) => { const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id); onSelection(next) }
  const label = (index: number, field: keyof typeof m) => m.cell(format.number(index + 1), String(m[field]))
  const add = (index: number) => patch(insertShot(doc.shots, index, crypto.randomUUID()))
  let previous = -1
  return <div className="vis-script-shots">
    <div className="vis-script-table-tools">
      <button disabled={disabled || doc.shots.length >= SCRIPT_LIMITS.shots} title={doc.shots.length >= SCRIPT_LIMITS.shots ? m.maxShots : undefined} onClick={() => add(doc.shots.length)}><Icon kind="plus" size={14} />{m.addShot}</button>
      <span>{m.selected(format.number(selected.size))}</span>
      {selected.size ? <button onClick={() => onSelection(new Set())}>{m.clearSelection}</button> : null}
    </div>
    {selected.size ? <form className="vis-script-bulk" aria-label={m.bulk} onSubmit={event => {
      event.preventDefault()
      const fields: ShotFields = {
        ...(duration ? { durationSec: Number(duration) } : {}),
        ...(size ? { shotSize: size } : {}),
        ...(scene !== 'keep' ? { sceneId: scene || null } : {}),
      }
      patch(bulkShots(doc.shots, selected, fields))
    }}>
      <label>{m.durationSec}<input aria-label={m.durationSec} type="number" min="0.5" max="60" step="0.5" value={duration} onChange={event => setDuration(event.target.value)} /></label>
      <label>{m.shotSize}<input aria-label={m.shotSize} value={size} maxLength={SCRIPT_LIMITS.cell} onChange={event => setSize(event.target.value)} /></label>
      <label>{m.sceneId}<select aria-label={m.sceneId} value={scene} onChange={event => setScene(event.target.value)}><option value="keep">{m.keep}</option><option value="">{m.none}</option>{scenes.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
      <button disabled={disabled || (!duration && !size && scene === 'keep')}>{m.apply}</button>
    </form> : null}
    <div ref={scroll} className="vis-script-table-scroll nowheel" onScroll={event => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
      <table className="vis-script-table" aria-label={m.shots} aria-rowcount={doc.shots.length + 1}>
        <colgroup>{COLUMNS.map(column => <col key={column} className={`vis-script-col-${column}`} />)}</colgroup>
        <thead><tr>{COLUMNS.map(column => <th key={column} scope="col">{column === 'number' ? <><input type="checkbox" aria-label={m.selectAll} checked={allSelected} onChange={() => onSelection(allSelected ? new Set() : new Set(doc.shots.map(shot => shot.id)))} />{m.number}</> : m[column]}</th>)}</tr></thead>
        <tbody>
          {indices.map(index => {
            const shot = doc.shots[index]!
            const gap = index - previous - 1
            previous = index
            const chain = chains.get(shot.id)
            const batchOutputIds = new Set(shotBatchSteps(parts.batches ?? [], shot.id)
              .filter(({ step }) => step.status === 'succeeded').map(({ step }) => step.nodeId))
            return <Fragment key={shot.id}>
              {gap ? <tr aria-hidden="true" className="vis-script-spacer"><td colSpan={COLUMNS.length} style={{ height: gap * ROW_HEIGHT }} /></tr> : null}
              <tr tabIndex={-1} aria-label={m.shot(format.number(index + 1))} aria-rowindex={index + 2} aria-selected={selected.has(shot.id)} className={`vis-script-shot${shot.color ? ` is-${shot.color}` : ''}${dragging === shot.id ? ' is-dragging' : ''}`}
                style={{ height: ROW_HEIGHT }} onFocusCapture={() => setFocusedRow(shot.id)}
                onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedRow(null) }}
                onDragOver={event => { if (dragging) event.preventDefault() }}
                onDrop={event => {
                  event.preventDefault()
                  if (!dragging || disabled) return
                  const from = doc.shots.findIndex(shot => shot.id === dragging)
                  const rect = event.currentTarget.getBoundingClientRect()
                  const before = index + (event.clientY > rect.top + rect.height / 2 ? 1 : 0)
                  patch(moveShot(doc.shots, dragging, before - (from < before ? 1 : 0)))
                  setDragging(null)
                }}>
                <td className={`vis-script-shot-number${chain ? ` vis-script-chain is-${chain}` : ''}`} title={chain ? m.continuousChain : undefined}>
                  <input type="checkbox" aria-label={m.selectShot(format.number(index + 1))} checked={selected.has(shot.id)} onChange={() => toggle(shot.id)} />
                  <span>{format.number(index + 1)}</span>
                  <button draggable={!disabled} className="vis-script-drag" aria-label={m.cell(format.number(index + 1), m.dragShot)} disabled={disabled}
                    onDragStart={event => { setDragging(shot.id); event.dataTransfer.setData('application/x-vis-shot', shot.id); event.dataTransfer.effectAllowed = 'move' }}
                    onDragEnd={() => setDragging(null)}><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="5" cy="4" r="1" /><circle cx="10" cy="4" r="1" /><circle cx="5" cy="8" r="1" /><circle cx="10" cy="8" r="1" /><circle cx="5" cy="12" r="1" /><circle cx="10" cy="12" r="1" /></svg></button>
                </td>
                <td data-script-cell><DurationCell value={shot.durationSec ?? null} rev={shot.rev} label={label(index, 'durationSec')} disabled={disabled}
                  onSave={(value, rev) => onPatch(updateShot({ ...shot, rev }, { durationSec: value }))} /></td>
                <td data-script-cell><select aria-label={label(index, 'transition')} value={shot.transition} disabled={disabled || index === 0} onChange={event => patch(updateShot(shot, { transition: event.target.value as Shot['transition'] }))}><option value="cut">{m.cut}</option><option value="continuous">{m.continuous}</option></select></td>
                {TEXT_FIELDS.slice(0, 4).map(field => <td key={field}><ScriptCell value={shot[field] ?? ''} rev={shot.rev} assets={doc.assets} label={label(index, field)} disabled={disabled}
                  onSave={(value, rev) => onPatch(updateShot({ ...shot, rev }, { [field]: value || (field === 'description' ? '' : null) }))} />{field === 'description' && shot.source && (() => {
                    const source = shot.source
                    const node = nodes.find(node => node.nodeId === source.nodeId && node.kind === 'text' && node.format !== 'code')
                    const content = node?.slots.find(slot => slot.slotKey === 'main')?.content
                    const valid = content?.type === 'text' && textEditAnchor(content.body, { find: source.quote })
                    return <button className="vis-script-source" disabled={!node || !actions.onOpenWriting} title={!node ? m.sourceMissing : source.quote} onClick={() => actions.onOpenWriting?.(source.nodeId, source.quote)}>{valid ? m.source : node ? m.sourceStale : m.sourceMissing}</button>
                  })()}</td>)}
                <td data-script-cell><AssetSelect label={label(index, 'characterIds')} assets={doc.assets.filter(asset => asset.kind === 'character')} value={shot.characterIds} multiple disabled={disabled} onChange={ids => patch(updateShot(shot, { characterIds: ids }))} /></td>
                <td data-script-cell><AssetSelect label={label(index, 'sceneId')} assets={scenes} value={shot.sceneId ?? ''} disabled={disabled} onChange={ids => patch(updateShot(shot, { sceneId: ids[0] ?? null }))} /></td>
                <td data-script-cell><AssetSelect label={label(index, 'propIds')} assets={doc.assets.filter(asset => asset.kind === 'prop')} value={shot.propIds} multiple disabled={disabled} onChange={ids => patch(updateShot(shot, { propIds: ids }))} /></td>
                {TEXT_FIELDS.slice(4).map(field => <td key={field}><ScriptCell value={shot[field] ?? ''} rev={shot.rev} assets={doc.assets} label={label(index, field)} disabled={disabled}
                  onSave={(value, rev) => onPatch(updateShot({ ...shot, rev }, { [field]: value || null }))} /></td>)}
                <td data-script-cell><select aria-label={label(index, 'color')} value={shot.color ?? ''} disabled={disabled} onChange={event => patch(updateShot(shot, { color: (event.target.value || null) as Shot['color'] }))}><option value="">{m.none}</option>{COLORS.map(color => <option key={color} value={color}>{m[color]}</option>)}</select></td>
                <td data-script-cell><div className="vis-script-output-cell"><div className="vis-script-previz-panels">{nodes.flatMap(node => {
                    const content = node.slots.find(slot => slot.slotKey === 'main')?.content
                    return content?.type === 'previz' ? content.doc.panels.flatMap((panel, panelIndex) => panel.shot?.scriptNodeId === parts.view.nodeId && panel.shot.shotId === shot.id ? [<button key={`${node.nodeId}:${panel.id}`} aria-label={pm.locatePanel(pm.panel(format.number(panelIndex + 1)))} onClick={() => onPanelFocus?.(node.nodeId, panel.id)}>{panel.image ? <img src={assetUrl(panel.image)} alt="" /> : <Icon kind="previz" />}</button>] : []) : []
                  })}</div><ShotBatchProgress batches={parts.batches ?? []} shotId={shot.id} nodes={parts.outputs.get(shot.id) ?? []} assetUrl={assetUrl} posterUrl={posterUrl} onFocus={onFocus} />
                  <ShotOutputs shot={shot} blockout={parts.blockouts?.get(shot.id)} outputs={(parts.outputs.get(shot.id) ?? []).filter(node => !batchOutputIds.has(node.nodeId))} actions={actions} scriptNodeId={parts.view.nodeId} assetUrl={assetUrl} posterUrl={posterUrl} onFocus={onFocus} onError={onError} disabled={disabled} /></div></td>
                <td><details className="vis-script-row-actions"><summary aria-label={m.cell(format.number(index + 1), m.actions)}>···</summary><div>
                  <button disabled={disabled || doc.shots.length >= SCRIPT_LIMITS.shots} onClick={() => add(index)}>{m.insertAbove}</button>
                  <button disabled={disabled || doc.shots.length >= SCRIPT_LIMITS.shots} onClick={() => add(index + 1)}>{m.insertBelow}</button>
                  <button disabled={disabled || index === 0} onClick={() => patch(moveShot(doc.shots, shot.id, index - 1))}>{m.moveUp}</button>
                  <button disabled={disabled || index === doc.shots.length - 1} onClick={() => patch(moveShot(doc.shots, shot.id, index + 1))}>{m.moveDown}</button>
                  <button disabled={disabled} onClick={() => patch(deleteShot(doc.shots, shot.id))}>{m.deleteShot}</button>
                </div></details></td>
              </tr>
            </Fragment>
          })}
          {previous < doc.shots.length - 1 ? <tr aria-hidden="true" className="vis-script-spacer"><td colSpan={COLUMNS.length} style={{ height: (doc.shots.length - previous - 1) * ROW_HEIGHT }} /></tr> : null}
        </tbody>
      </table>
      {!doc.shots.length ? <p className="vis-script-empty">{m.empty}</p> : null}
    </div>
  </div>
}

function DurationCell({ value, rev, label, disabled, onSave }: { value: number | null; rev: number; label: string; disabled: boolean; onSave(value: number | null, rev: number): Promise<void> }) {
  const [draft, setDraft] = useState(value === null ? '' : String(value))
  const input = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  const baseRev = useRef(rev)
  useEffect(() => {
    if (document.activeElement !== input.current) setDraft(value === null ? '' : String(value))
  }, [value, rev])
  const commit = () => {
    if (cancelled.current || !input.current?.checkValidity()) return
    const next = draft ? Number(draft) : null
    if (next !== value) void onSave(next, baseRev.current).catch(() => setDraft(value === null ? '' : String(value)))
  }
  return <input ref={input} aria-label={label} type="number" min="0.5" max="60" step="any" value={draft} disabled={disabled}
    onFocus={() => { cancelled.current = false; baseRev.current = rev }} onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
      if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; setDraft(value === null ? '' : String(value)); event.currentTarget.blur() }
    }} />
}
