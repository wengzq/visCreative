import type { NodeView, PrevizDoc, PrevizPanel } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useReactFlow, useStore, useViewport } from '@xyflow/react'
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { CanvasActions } from './CanvasView'
import { Icon } from './Icon'
import { useGenerationChoice } from './ModelPicker'
import { PromptPanel } from './PromptPanel'
import type { GenerationChoice } from './params'
import { PrevizLinkDialog, PrevizBatchDialog } from './PrevizDialogs'
import { newestBlockout, panelShot, previzScripts } from './previz'
import { previzMessages } from './previz-messages'
import { VideoPlayer } from './VideoPlayer'
import './previz-node.css'

export function PrevizNodeContent({ node, doc, actions, thumbnailUrl, assetUrl, posterUrl, nodes, references, selected, panelId, onSelect }: {
  node: NodeView; doc: PrevizDoc; actions: CanvasActions; thumbnailUrl(id: string): string
  assetUrl(id: string): string; posterUrl(id: string): string
  nodes: NodeView[]
  /** Every node, including hidden working documents: hiding a script or blockout must not break its links. */
  references: NodeView[]
  selected: boolean; panelId: string | null; onSelect(id: string | null): void
}) {
  const m = useMessages(previzMessages)
  const f = useFormat()
  const { locale } = useLocale()
  const card = useRef<HTMLElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const [dialog, setDialog] = useState<'link' | 'batch' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [extracted, setExtracted] = useState(false)
  const blockout = newestBlockout(references, node.nodeId)
  const blockoutContent = blockout?.slots.find(slot => slot.slotKey === 'main')?.content
  const scripts = previzScripts(references)
  const extract = (assetVersionId: string, fillDurations = false) => {
    setExtracting(true); setError(null); setExtracted(false)
    void actions.onPrevizExtract?.(node.nodeId, assetVersionId, fillDurations).then(() => setExtracted(true)).catch(cause => extractionError(cause, assetVersionId)).finally(() => setExtracting(false))
  }
  const extractionError = (cause: unknown, assetVersionId: string) => {
    const data = (cause as { data?: { reason?: string; params?: { panelIds?: string } } })?.data
    if (data?.reason === 'previz.duration_required' && doc.panels.every(panel => panel.durationSec === null) && window.confirm(m.splitEvenly(f.number(doc.panels.length)))) {
      extract(assetVersionId, true)
      return
    }
    if (data?.reason === 'previz.duration_required') {
      const ids = data.params?.panelIds?.split(', ') ?? []
      const names = doc.panels.flatMap((panel, index) => ids.includes(panel.id) ? [m.panel(f.number(index + 1)) + (panel.note ? ` · ${panel.note}` : '')] : [])
      setError(new Error(m.missingDuration(names.join(', '))))
    } else setError(cause)
  }
  const panel = selected ? doc.panels.find(panel => panel.id === panelId) : undefined
  useEffect(() => {
    const element = strip.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      const horizontal = !event.ctrlKey && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))
      element.classList.toggle('nowheel', horizontal)
      if (horizontal) { event.preventDefault(); element.scrollLeft += event.deltaX || event.deltaY }
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])
  useEffect(() => {
    if (!panel) return
    const clear = (event: PointerEvent) => {
      if (!card.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) onSelect(null)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) onSelect(null) }
    document.addEventListener('pointerdown', clear)
    document.addEventListener('keydown', escape)
    const tile = strip.current?.querySelector<HTMLElement>('[aria-pressed=true]')
    if (tile && strip.current) {
      const left = tile.offsetLeft
      const track = strip.current
      if (left < track.scrollLeft || left + tile.offsetWidth > track.scrollLeft + track.clientWidth) track.scrollTo({ left: left - (track.clientWidth - tile.offsetWidth) / 2, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    }
    return () => { document.removeEventListener('pointerdown', clear); document.removeEventListener('keydown', escape) }
  }, [panel?.id])
  const commit = async (next: PrevizDoc) => {
    if (!actions.onApply || saving) return
    setSaving(true); setError(null)
    try {
      const slot = node.slots.find(slot => slot.slotKey === 'main')!
      await actions.onApply([{ op: 'previz.set', slotId: slot.slotId, expectedRevision: slot.revision, doc: { ...next, rev: doc.rev + 1 } }], m.create)
    } catch (cause) { setError(cause); throw cause }
    finally { setSaving(false) }
  }
  return <>
    <section ref={card} className="vis-previz-card" role="region" aria-label={m.label(node.title ?? m.create, f.number(doc.panels.length))}
      onDoubleClick={event => { event.stopPropagation(); actions.onOpenPreviz?.(node.nodeId, panel?.id) }}>
      <div className="vis-previz-track">
        {doc.panels.length ? <button className="vis-previz-arrow nodrag nopan" aria-label={m.previous} onClick={() => strip.current?.scrollBy({ left: -240 })}><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true"><path d="m10 3-5 5 5 5" /></svg></button> : null}
        <div ref={strip} className="vis-previz-thumbnails" role="group" aria-label={m.strip} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
          event.preventDefault(); event.stopPropagation()
          const index = doc.panels.findIndex(panel => panel.id === panelId)
          const next = doc.panels[Math.max(0, Math.min(doc.panels.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))]
          if (next) { onSelect(next.id); strip.current?.querySelectorAll<HTMLButtonElement>('button')[doc.panels.indexOf(next)]?.focus({ preventScroll: true }) }
        }}>
          {doc.panels.map((item, index) => {
            const linked = panelShot(item, scripts)
            const label = m.panel(f.number(index + 1))
            const shot = linked ? m.shotNumber(f.number(linked.index + 1)) : item.shot ? m.stale : ''
            return <button key={item.id} className="vis-previz-tile" aria-label={shot ? m.linkedPanel(label, shot) : label} aria-pressed={panel?.id === item.id}
              onClick={event => { event.stopPropagation(); onSelect(item.id) }} onDoubleClick={event => { event.stopPropagation(); actions.onOpenPreviz?.(node.nodeId, item.id) }}>
              <span className="vis-previz-picture">{item.image ?? item.blockout ? <img src={thumbnailUrl((item.image ?? item.blockout)!)} alt={label} loading="lazy" draggable={false} /> : <Icon kind="previz" />}<span className="vis-previz-number">{f.number(index + 1)}</span>
                {shot ? <span className={`vis-previz-shot${linked ? '' : ' is-stale'}`} title={linked ? linked.shot.description : m.stale}>{!linked ? <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" aria-hidden="true"><path d="M8 2 1 14h14L8 2Z M8 6v4m0 1v1" /></svg> : null}{shot}</span> : null}
                {item.blockout ? <span className="vis-previz-blockout-marker" title={m.blockoutFrame} aria-label={m.blockoutFrame}><Icon kind="previz" size={12} /></span> : null}
                {panel?.id === item.id ? <span className="vis-previz-check" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"><path d="m3 8 3 3 7-7" /></svg></span> : null}
              </span>{item.note ? <span className="vis-previz-note" title={item.note}>{item.note}</span> : null}
            </button>
          })}
          {!doc.panels.length ? <p><Icon kind="previz" size={30} />{m.empty}</p> : null}
        </div>
        {doc.panels.length ? <button className="vis-previz-arrow nodrag nopan" aria-label={m.next} onClick={() => strip.current?.scrollBy({ left: 240 })}><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg></button> : null}
      </div>
      {blockoutContent?.type === 'asset' ? <div className="vis-previz-blockout" role="region" aria-label={m.blockout} onDoubleClick={event => event.stopPropagation()}>
        <div className="vis-previz-blockout-player nodrag nopan"><VideoPlayer key={blockoutContent.assetVersionId} src={assetUrl(blockoutContent.assetVersionId)} posterSrc={posterUrl(blockoutContent.assetVersionId)} compact previewWithinPlayer /></div>
        <div><span>{m.blockout}</span><button disabled={extracting || saving || !actions.onPrevizExtract} onClick={() => extract(blockoutContent.assetVersionId)}>{extracting ? m.extracting : m.extract}</button></div>
      </div> : null}
      <footer><span>{m.summary(f.number(doc.panels.length))} · {doc.aspectRatio}</span><div>
        {doc.panels.length ? <><button className="nodrag nopan" disabled={!scripts.length || saving} onClick={() => setDialog('link')}>{m.linkOrder}</button><button className="nodrag nopan" disabled={!doc.panels.some(panel => panelShot(panel, scripts))} onClick={() => setDialog('batch')}>{m.batch}</button></> : null}
        <button className="nodrag nopan" onClick={() => actions.onPrevizDraft?.(node.nodeId, m.renderDraft)}>{m.render}</button>
        <button className="nodrag nopan" aria-label={m.open} onClick={() => actions.onOpenPreviz?.(node.nodeId, panel?.id)}>{m.open}</button>
      </div></footer>
      {extracted || error ? <div className="vis-previz-message">{extracted ? <p role="status">{m.extracted(f.number(doc.panels.length))}</p> : null}{error ? <p role="alert">{describeError(error, locale)}</p> : null}</div> : null}
    </section>
    {panel ? <PanelPopover node={node} panelRef={popover} label={m.controls}>
      <PrevizPanelPrompt key={panel.id} node={node} panel={panel} index={doc.panels.indexOf(panel)} nodes={nodes} scripts={scripts} actions={actions} thumbnailUrl={thumbnailUrl} saving={saving} onClose={() => onSelect(null)}
        update={fields => commit({ ...doc, panels: doc.panels.map(item => item.id === panel.id ? { ...item, ...fields, rev: item.rev + 1 } : item) })} />
    </PanelPopover> : null}
    {dialog === 'link' ? <PrevizLinkDialog doc={doc} scripts={scripts} commit={commit} onClose={() => setDialog(null)} /> : null}
    {dialog === 'batch' ? <PrevizBatchDialog doc={doc} scripts={scripts} actions={actions} onClose={() => setDialog(null)} /> : null}
  </>
}

function PanelPopover({ node, panelRef, label, children }: { node: NodeView; panelRef: RefObject<HTMLDivElement | null>; label: string; children: ReactNode }) {
  const { x, y, zoom } = useViewport()
  const flow = useReactFlow()
  const root = useStore(state => state.domNode)
  const internal = flow.getInternalNode(node.nodeId)
  const position = internal?.internals.positionAbsolute ?? node
  const width = Math.min(Math.max(420, node.w), window.innerWidth - 32)
  const top = y + (position.y + node.h) * zoom + 16
  const availableHeight = Math.max(180, window.innerHeight - (root?.getBoundingClientRect().top ?? 0) - top - 8)
  // NodeToolbar lives inside the renderer's stacking context, below minimap controls. Keep the same anchor in the root overlay.
  return root ? createPortal(<div ref={panelRef} className="vis-previz-panel" role="region" aria-label={label} style={{ position: 'absolute', zIndex: 1000,
    left: x + (position.x + node.w / 2) * zoom - width / 2, top, maxHeight: availableHeight, overflowY: 'auto' }}>
    {children}
  </div>, root) : null
}

function PrevizPanelPrompt({ node, panel, index, nodes, scripts, actions, thumbnailUrl, saving, update, onClose }: {
  node: NodeView; panel: PrevizPanel; index: number; nodes: NodeView[]; scripts: ReturnType<typeof previzScripts>; actions: CanvasActions
  thumbnailUrl(id: string): string; saving: boolean; onClose(): void; update(fields: Partial<PrevizPanel>): Promise<void>
}) {
  const m = useMessages(previzMessages)
  const f = useFormat()
  const { locale } = useLocale()
  const linked = panelShot(panel, scripts)
  const kind = panel.use === 'frame' && panel.frameRole !== 'last' ? 'video' : 'image'
  const [choices, setChoices] = useState<Partial<Record<'image' | 'video', GenerationChoice>>>({})
  const view: NodeView = { ...node, kind, generation: choices[kind] ?? node.generation, inputs: [] }
  const generation = useGenerationChoice(view, async (_id, choice) => { if (choice?.provider && choice.model) setChoices(previous => ({ ...previous, [kind]: { provider: choice.provider!, model: choice.model!, params: choice.params ?? {} } })) })
  const [text, setText] = useState(panel.note || (kind === 'video' ? linked?.shot.videoPrompt : linked?.shot.framePrompt) || linked?.shot.description || '')
  const [error, setError] = useState<unknown>(null)
  const [settingFrame, setSettingFrame] = useState(false)
  const request = useRef(`previz-panel-${crypto.randomUUID()}`)
  const action = panel.use === 'composition' ? m.generateFrame : m.generateVideo
  // A composition reference can come from the blockout alone; a frame must be the panel's own picture.
  const reference = panel.image ?? (panel.use === 'composition' ? panel.blockout : null)
  const hint = panel.use === 'frame' && panel.frameRole === 'last' ? m.lastGenerationHint : !reference ? m.drawFirst : undefined
  const frameHint = !panel.image ? m.drawFirst : !linked ? m.linkFirst : undefined
  const last = panel.use === 'frame' && panel.frameRole === 'last'
  const header = <div className="vis-previz-panel-header">
    <h3>{m.panel(f.number(index + 1))}</h3>
    {panel.image ?? panel.blockout ? <img className="vis-previz-selected-picture" src={thumbnailUrl((panel.image ?? panel.blockout)!)} alt={m.panel(f.number(index + 1))} /> : null}
    <section className="vis-previz-preparation" aria-label={m.previz}><div className="vis-previz-stage-heading"><h4>{m.previz}</h4><span>{m.free}</span></div>
    {panel.blockout && panel.use === 'composition' ? <p className="vis-previz-blockout-hint">{m.blockoutFrame}</p> : null}
    <fieldset disabled={saving || settingFrame}><label>{m.shot}<select aria-label={m.shot} value={panel.shot ? JSON.stringify(panel.shot) : ''} onChange={event => {
      if (event.target.value === 'ask') { actions.onPrevizDraft?.(node.nodeId, m.askDraft); return }
      void update({ shot: event.target.value ? JSON.parse(event.target.value) : null }).catch(setError)
    }}><option value="">{m.none}</option>{panel.shot && !linked ? <option value={JSON.stringify(panel.shot)}>{m.stale}</option> : null}
      {scripts.map(script => <optgroup key={script.node.nodeId} label={script.node.title ?? m.script}>{script.doc.shots.map((shot, shotIndex) => <option key={shot.id} value={JSON.stringify({ scriptNodeId: script.node.nodeId, shotId: shot.id })}>{f.number(shotIndex + 1)} · {shot.description}</option>)}</optgroup>)}
      {!scripts.length ? <option value="ask">{m.ask}</option> : null}
    </select></label>
    <div className="vis-previz-uses" role="radiogroup" aria-label={m.use}>{(['composition', 'first', 'last'] as const).map(use => <label key={use}><input type="radio" name={`previz-use-${panel.id}`} aria-label={m[use]} checked={use === 'composition' ? panel.use === 'composition' : panel.use === 'frame' && (panel.frameRole ?? 'first') === use} onChange={() => void update({ use: use === 'composition' ? 'composition' : 'frame', frameRole: use === 'composition' ? null : use }).catch(setError)} />{m[use]}</label>)}</div></fieldset>
    {panel.use === 'frame' ? <div className="vis-previz-frame-action"><button disabled={saving || settingFrame || Boolean(frameHint)} title={frameHint} aria-label={last ? m.setLast : m.setFirst} onClick={() => {
      setSettingFrame(true); setError(null)
      void actions.onPrevizPanel?.({ nodeId: node.nodeId, panelId: panel.id, action: 'set_frame', prompt: '', requestId: `previz-frame-${crypto.randomUUID()}` }).catch(setError).finally(() => setSettingFrame(false))
    }}>{settingFrame ? m.settingFrame : last ? m.setLast : m.setFirst}</button>{frameHint ? <span role="status">{frameHint}</span> : null}</div> : null}
    </section>
    {error ? <p role="alert">{describeError(error, locale)}</p> : null}
  </div>
  return <PromptPanel view={view} nodes={nodes} text={text} saving={saving} generation={generation} assetUrl={thumbnailUrl} posterUrl={thumbnailUrl}
    panel={{ header, generationLabel: m.generation, paidLabel: generation.provider?.needsKey ? m.paid : undefined, action, hint, hideAction: last }} picking={false} onPick={() => {}} onChange={value => { setText(value); request.current = `previz-panel-${crypto.randomUUID()}` }} onCommit={async () => true} onReset={onClose}
    actions={{ ...actions, onGenerate: async () => {
      setError(null)
      try { await actions.onPrevizPanel?.({ nodeId: node.nodeId, panelId: panel.id, action: 'generate', prompt: text, requestId: request.current, ...(generation.choice ? { choice: generation.choice } : {}) }); request.current = `previz-panel-${crypto.randomUUID()}` }
      catch (cause) { setError(cause); throw cause }
    } }} />
}
