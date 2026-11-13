import { emptyPrevizPanel, PREVIZ_LIMITS, PrevizAspectRatio, type PrevizPanel } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useMemo, useRef, useState } from 'react'
import { backdrop, createDraftAssets, flatten, loadImage } from './assets'
import { usePrevizDraft } from './draft'
import { DrawingSurface } from './DrawingSurface'
import { PanelList } from './PanelList'
import { PanelMenu } from './PanelMenu'
import { previzMessages } from './messages'
import { SceneViewControl } from './SceneViewControl'
import type { PrevizEditorHost } from './types'

export function PrevizEditor({ host }: { host: PrevizEditorHost }) {
  const m = useMessages(previzMessages)
  const f = useFormat()
  const { locale } = useLocale()
  const assets = useMemo(() => createDraftAssets(host.upload, host.assetUrl), [host.node.nodeId])
  const draftHost = useMemo(() => ({ ...host, prepare: assets.prepare }), [host, assets])
  const draft = usePrevizDraft(draftHost)
  const latest = useRef(draft)
  latest.current = draft
  const [selected, setSelected] = useState<string | null>(host.initialPanelId ?? draft.doc.panels[0]?.id ?? null)
  const panel = draft.doc.panels.find(panel => panel.id === selected) ?? draft.doc.panels[0]
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen')
  const [colour, setColour] = useState('#202020')
  const [size, setSize] = useState(8)
  const [working, setBusy] = useState(false)
  // Saving strokes blocks other actions, but never the next stroke.
  const [drawing, setDrawing] = useState(false)
  const busy = working || drawing
  const busyRef = useRef(busy)
  busyRef.current = busy
  const [error, setError] = useState<unknown>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [closing, setClosing] = useState(false)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const disabled = !!draft.conflict
  const url = assets.url
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root.current?.focus()
    return () => { previous?.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => () => assets.dispose(), [assets])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (busyRef.current || latest.current.saveState !== 'saved') event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  const update = (id: string, fields: Partial<PrevizPanel>, immediate = false) => {
    const current = latest.current
    current.edit({ ...current.doc, panels: current.doc.panels.map(panel => panel.id === id ? { ...panel, ...fields, rev: panel.rev + 1 } : panel) }, immediate)
  }
  const insert = (panel: PrevizPanel, index = draft.doc.panels.length) => {
    if (draft.doc.panels.length >= PREVIZ_LIMITS.panels) { setError(new Error(m.limit)); return }
    draft.edit({ ...draft.doc, panels: draft.doc.panels.toSpliced(index, 0, panel) }, true)
    setSelected(panel.id)
  }
  const add = (index?: number) => insert(emptyPrevizPanel(crypto.randomUUID()), index)
  const remove = (id: string) => draft.edit({ ...draft.doc, panels: draft.doc.panels.filter(panel => panel.id !== id) }, true)
  const openMenu = (id: string, x: number, y: number) => { setSelected(id); setMenu({ id, x, y }) }
  const move = (id: string, index: number) => {
    const panels = [...draft.doc.panels]
    const from = panels.findIndex(panel => panel.id === id)
    if (from < 0 || index < 0 || index >= panels.length) return
    panels.splice(index, 0, ...panels.splice(from, 1))
    draft.edit({ ...draft.doc, panels }, true)
  }
  const importFiles = async (files: File[], target?: string) => {
    if (disabled || busy) return
    const images = files.filter(file => file.type.startsWith('image/')).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    if (!images.length) { setError(new Error(m.imageOnly)); return }
    const replace = images.length === 1 && target && draft.doc.panels.some(panel => panel.id === target)
    if (draft.doc.panels.length + images.length - (replace ? 1 : 0) > PREVIZ_LIMITS.panels) { setError(new Error(m.limit)); return }
    draft.beginEdit()
    setBusy(true); setError(null)
    try {
      const ratio = draft.doc.aspectRatio
      const incoming: PrevizPanel[] = []
      for (const file of images) {
        const underlay = assets.add(file, file.name)
        await loadImage(url(underlay))
        const existing = replace ? latest.current.doc.panels.find(panel => panel.id === target) : undefined
        const sketch = existing?.sketch ?? null
        const image = assets.add(await flatten(underlay, sketch, ratio, url), 'panel.png')
        incoming.push({ ...(existing ?? emptyPrevizPanel(crypto.randomUUID())), underlay, sketch, image, use: sketch ? 'composition' : 'frame', frameRole: sketch ? null : 'first' })
      }
      const current = latest.current
      const panels = replace ? current.doc.panels.map(panel => panel.id === target ? { ...panel, ...incoming[0], rev: panel.rev + 1 } : panel) : [...current.doc.panels, ...incoming]
      current.edit({ ...current.doc, panels }, true)
      setSelected(incoming[0]!.id)
    } catch (error) { setError(error) } finally { setBusy(false) }
  }
  const fromCanvas = async (nodeId: string) => {
    const node = host.nodes.find(node => node.nodeId === nodeId)
    const content = node?.slots.find(slot => slot.slotKey === 'main')?.content
    if (!panel || content?.type !== 'asset' || node?.kind !== 'image') return
    draft.beginEdit()
    setBusy(true); setError(null)
    try {
      const image = assets.add(await flatten(content.assetVersionId, panel.sketch, draft.doc.aspectRatio, url), 'panel.png')
      update(panel.id, { underlay: content.assetVersionId, image, use: panel.sketch ? 'composition' : 'frame', frameRole: panel.sketch ? null : 'first' }, true)
    } catch (error) { setError(error) } finally { setBusy(false) }
  }
  const changeRatio = async (aspectRatio: PrevizAspectRatio) => {
    if (busy || disabled) return
    draft.beginEdit()
    setBusy(true); setError(null)
    try {
      const panels = await Promise.all(draft.doc.panels.map(async panel => panel.image ? { ...panel, rev: panel.rev + 1, image: assets.add(await flatten(backdrop(panel), panel.sketch, aspectRatio, url), 'panel.png') } : panel))
      latest.current.edit({ ...latest.current.doc, aspectRatio, panels }, true)
    } catch (error) { setError(error) } finally { setBusy(false) }
  }
  const close = async () => {
    if (busy) return
    try {
      await draft.flush()
      if (!latest.current.conflict) host.onClose()
      else setClosing(true)
    } catch (error) { setClosing(true); setError(error) }
  }
  const render = async () => {
    if (busy || disabled) return
    setBusy(true); setError(null)
    try {
      if (await draft.flush()) host.onRender?.()
    } catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  const openScene = async (sceneNodeId: string, viewId: string, panelId: string) => {
    if (busy || disabled || !host.onOpenScene) return
    setBusy(true); setError(null)
    try {
      if (await draft.flush()) host.onOpenScene(sceneNodeId, viewId, panelId)
    } catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  const menuIndex = menu ? draft.doc.panels.findIndex(panel => panel.id === menu.id) : -1
  return <div ref={root} tabIndex={-1} className="vis-pv-editor" role="dialog" aria-modal="true" aria-label={host.node.title ?? m.previz}
    onKeyDown={event => {
      if (event.key === 'Tab') {
        const controls = [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length)
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); void close() }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === 'z' && !(event.target instanceof HTMLElement && event.target.matches('input, textarea'))) { event.preventDefault(); if (!busy) draft.undo() }
    }} onPaste={event => {
      if (event.target instanceof HTMLElement && event.target.matches('input, textarea')) return
      const files = [...event.clipboardData.files]
      if (files.length) { event.preventDefault(); void importFiles(files, panel?.id) }
    }}>
    <header className="vis-pv-header"><button aria-label={m.close} disabled={busy} onClick={() => void close()}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m14 5-7 7 7 7M7 12h14" /></svg></button>
      <strong>{host.node.title ?? m.previz}</strong><label>{m.aspect}<select aria-label={m.aspect} disabled={disabled || busy} value={draft.doc.aspectRatio} onChange={event => void changeRatio(event.target.value as PrevizAspectRatio)}>{PrevizAspectRatio.options.map(ratio => <option key={ratio}>{ratio}</option>)}</select></label>
      <span role="status" className={`vis-pv-save is-${draft.saveState}`}>{m[busy ? 'saving' : draft.saveState]}</span>
      <button disabled={disabled || busy} onClick={() => void draft.flush().catch(setError)}>{m.save}</button>
      <button disabled={disabled || busy || !host.onRender} onClick={() => void render()}>{m.render}</button>
    </header>
    {draft.conflict ? <div className="vis-pv-conflict" role="alert"><span>{host.lastWriter?.() ? m.conflictBanner(host.lastWriter()!) : m.conflictUnknown}</span><button onClick={() => { draft.loadTheirs(); setShowDiff(false); setClosing(false) }}>{m.loadTheirs}</button><button aria-expanded={showDiff} onClick={() => setShowDiff(!showDiff)}>{m.showDiff}</button></div> : null}
    {showDiff && draft.conflict ? <div className="vis-pv-diff" role="region" aria-label={m.showDiff}>{[{ label: m.yours, doc: draft.doc }, { label: m.theirs, doc: draft.conflict.theirs }].map(side => <section key={side.label}><strong>{side.label} · {side.doc.aspectRatio}</strong>{side.doc.panels.map((panel, index) => <div key={panel.id}><span>{m.panel(f.number(index + 1))}</span>{panel.image ? <img src={url(panel.image)} alt="" /> : null}<p>{panel.note}</p><span>{panel.durationSec === null ? '' : f.number(panel.durationSec)}</span></div>)}</section>)}</div> : null}
    {error || draft.saveError ? <div className="vis-pv-error" role="alert"><span>{describeError(error ?? draft.saveError, locale)}</span><button onClick={() => { setError(null); void draft.flush().catch(setError) }}>{m.retry}</button>{closing ? <button onClick={host.onClose}>{m.discard}</button> : null}</div> : null}
    {closing && draft.conflict ? <div className="vis-pv-error"><button onClick={host.onClose}>{m.discard}</button></div> : null}
    <div className="vis-pv-workspace"><PanelList panels={draft.doc.panels} selected={panel?.id ?? null} disabled={disabled} busy={busy} url={url} select={setSelected} add={() => add()} remove={remove} move={move} openMenu={openMenu} importFiles={(files, target) => void importFiles(files, target)} />
      <main className="vis-pv-main" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void importFiles([...event.dataTransfer.files], panel?.id) } }}>
        <div className="vis-pv-tools" role="toolbar" aria-label={m.surface}><button aria-pressed={tool === 'pen'} disabled={disabled || busy} onClick={() => setTool('pen')}>{m.pen}</button><button aria-pressed={tool === 'eraser'} disabled={disabled || busy} onClick={() => setTool('eraser')}>{m.eraser}</button>
          <label>{m.colour}<input type="color" aria-label={m.colour} value={colour} disabled={disabled || busy} onChange={event => setColour(event.target.value)} /></label><label>{m.size}<input type="range" aria-label={m.size} min={1} max={80} value={size} disabled={disabled || busy} onChange={event => setSize(Number(event.target.value))} /></label>
          <button disabled={!draft.canUndo || disabled || busy} onClick={draft.undo}>{m.undo}</button><button disabled={disabled || busy} onClick={() => picker.current?.click()}>{m.import}</button>
        </div>
        <div className="vis-pv-stage" onContextMenu={event => { if (panel) { event.preventDefault(); openMenu(panel.id, event.clientX, event.clientY) } }}>{panel ? <DrawingSurface key={panel.id} panel={panel} ratio={draft.doc.aspectRatio} url={url} tool={tool} colour={colour} size={size} disabled={disabled || working} sameSketch={assets.same} onBusy={value => { if (value) draft.beginEdit(); setDrawing(value) }} onError={setError} onDraw={async (sketch, adopt) => {
          const id = assets.add(sketch, 'sketch.png')
          try {
            const image = assets.add(await flatten(backdrop(panel), id, draft.doc.aspectRatio, url), 'panel.png')
            adopt(id)
            update(panel.id, { sketch: id, image, use: 'composition', frameRole: null }, true)
          } catch (error) { setError(error) }
        }} /> : <p>{m.empty}</p>}</div>
      </main>
      <aside className="vis-pv-inspector"><fieldset disabled={!panel || disabled || busy}><label>{m.note}<textarea aria-label={m.note} value={panel?.note ?? ''} maxLength={PREVIZ_LIMITS.note} onChange={event => panel && update(panel.id, { note: event.target.value })} /></label>
        <label>{m.duration}<input type="number" aria-label={m.duration} min={0.01} max={PREVIZ_LIMITS.durationSec} step="any" value={panel?.durationSec ?? ''} onChange={event => panel && update(panel.id, { durationSec: event.target.value ? Number(event.target.value) : null })} /></label>
        <label>{m.fromCanvas}<select aria-label={m.chooseImage} value="" onChange={event => void fromCanvas(event.target.value)}><option value="">{m.chooseImage}</option>{host.nodes.filter(node => node.kind === 'image' && node.slots.some(slot => slot.slotKey === 'main' && slot.content.type === 'asset')).map((node, index) => <option key={node.nodeId} value={node.nodeId}>{node.title ?? f.number(index + 1)}</option>)}</select></label>
        {panel && host.onOpenScene ? <SceneViewControl key={panel.id} panel={panel} nodes={host.nodes} url={url} disabled={disabled || busy} open={openScene} /> : null}
      </fieldset></aside>
    </div>
    {menu && menuIndex >= 0 ? <PanelMenu x={menu.x} y={menu.y} first={!menuIndex} last={menuIndex === draft.doc.panels.length - 1} disabled={disabled || busy} full={draft.doc.panels.length >= PREVIZ_LIMITS.panels} onClose={() => setMenu(null)} actions={{
      insertBefore: () => add(menuIndex),
      insertAfter: () => add(menuIndex + 1),
      // Pictures are asset versions, so a copy can share them; only the identity is new.
      duplicate: () => insert({ ...draft.doc.panels[menuIndex]!, id: crypto.randomUUID(), rev: 1 }, menuIndex + 1),
      importImage: () => picker.current?.click(),
      moveEarlier: () => move(menu.id, menuIndex - 1),
      moveLater: () => move(menu.id, menuIndex + 1),
      remove: () => remove(menu.id),
    }} /> : null}
    <input ref={picker} type="file" accept="image/*" multiple hidden onChange={event => { void importFiles([...event.target.files ?? []], panel?.id); event.target.value = '' }} />
  </div>
}
