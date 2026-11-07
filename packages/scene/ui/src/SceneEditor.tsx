import { SCENE_LIMITS, SceneAspectRatio, type SceneObjectSource } from '@vis/protocol'
import { BUILTIN_BODIES, clampJointRotation, HUMAN_BODY, resetJointPose } from '@vis/scene-core'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AddMenu } from './AddMenu'
import { useSceneDraft } from './draft'
import { sceneMessages } from './messages'
import { captureSceneStill } from './output'
import { SceneInspector } from './SceneInspector'
import { SceneViewport } from './SceneViewport'
import { SendDialog } from './SendDialog'
import type { SceneEditorHost, SceneTool } from './types'
import { createSceneViewportController, useSceneViewportState } from './viewport-state'
import { ViewsPanel } from './ViewsPanel'

export function SceneEditor({ host }: { host: SceneEditorHost }) {
  const m = useMessages(sceneMessages)
  const f = useFormat()
  const { locale } = useLocale()
  const draft = useSceneDraft(host)
  const controller = useMemo(() => createSceneViewportController(host), [host.node.nodeId])
  const viewport = useSceneViewportState(controller)
  const current = useRef(draft)
  current.current = draft
  const root = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<unknown>(null)
  const [closing, setClosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState('')
  const addButton = useRef<HTMLButtonElement>(null)
  const sendButton = useRef<HTMLButtonElement>(null)
  const disabled = !!draft.conflict || busy || viewport.dragging
  const busyRef = useRef(false)
  busyRef.current = busy || viewport.dragging
  const view = draft.doc.views.find(view => view.id === viewport.viewId)
  const writer = host.lastWriter?.()
  useEffect(() => {
    if (draft.conflict) { setAdding(false); setSending(false); root.current?.focus({ preventScroll: true }) }
  }, [draft.conflict])
  useEffect(() => {
    const state = controller.getSnapshot()
    if (!draft.doc.objects.some(object => object.id === state.selectedId)) controller.select(null)
    const selected = draft.doc.objects.find(object => object.id === state.selectedId)?.source
    if (state.selectedJointId && (selected?.type !== 'figure' || !BUILTIN_BODIES.find(body => body.id === selected.bodyId)?.joints.some(joint => joint.id === state.selectedJointId))) controller.selectJoint(null)
    if (!draft.doc.views.some(view => view.id === state.viewId)) controller.setView(draft.doc.views[0]?.id ?? null)
    if (!draft.doc.views.length) controller.setMode('orbit')
  }, [controller, draft.doc])
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root.current?.focus()
    const warn = (event: BeforeUnloadEvent) => { if (busyRef.current || current.current.saveState !== 'saved') event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => { window.removeEventListener('beforeunload', warn); previous?.focus({ preventScroll: true }) }
  }, [])
  const close = async () => {
    if (busyRef.current) return
    setBusy(true)
    busyRef.current = true
    try {
      if (await current.current.flush()) host.onClose()
      else setClosing(true)
    } catch (error) { setError(error); setClosing(true) }
    finally {
      setBusy(false)
      busyRef.current = false
      requestAnimationFrame(() => { if (!root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true }) })
    }
  }
  const remove = (id?: string) => {
    const latest = current.current.getSnapshot()
    const state = controller.getSnapshot()
    const objectId = id ?? state.selectedId
    if (!objectId || latest.conflict || busyRef.current) return
    if (!id && state.selectedJointId) {
      const jointId = state.selectedJointId
      latest.edit({ ...latest.doc, objects: latest.doc.objects.map(object => {
        if (object.id !== objectId || object.source.type !== 'figure') return object
        const source = object.source
        const body = BUILTIN_BODIES.find(body => body.id === source.bodyId)
        return body ? { ...object, source: { ...source, pose: resetJointPose(body, source.pose, jointId) } } : object
      }) }, true)
    } else {
      latest.edit({ ...latest.doc, objects: latest.doc.objects.filter(object => object.id !== objectId) }, true)
      if (objectId === state.selectedId) controller.select(null)
    }
    root.current?.focus({ preventScroll: true })
  }
  const add = (source: SceneObjectSource, name: string) => {
    const latest = current.current.getSnapshot()
    if (latest.conflict || latest.doc.objects.length >= SCENE_LIMITS.objects) return
    const id = crypto.randomUUID()
    latest.edit({
      ...latest.doc,
      objects: [...latest.doc.objects, {
        id, name: name.slice(0, SCENE_LIMITS.name), transform: { position: [0, source.type === 'primitive' && source.shape !== 'plane' ? 0.5 : 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        hidden: false, createdBy: 'user', userTouched: true,
        source,
      }],
    }, true)
    controller.select(id)
    root.current?.focus({ preventScroll: true })
  }
  const addFigure = () => add({ type: 'figure', bodyId: HUMAN_BODY.id, heightM: HUMAN_BODY.heightM, pose: {} }, m.figure)
  const addView = () => {
    const latest = current.current.getSnapshot()
    const camera = controller.readCamera()
    if (!camera || latest.conflict || latest.doc.views.length >= SCENE_LIMITS.views) return
    const id = crypto.randomUUID()
    latest.edit({ ...latest.doc, views: [...latest.doc.views, { id, name: m.viewNumber(f.number(latest.doc.views.length + 1)), camera, aspectRatio: view?.aspectRatio ?? '16:9', still: null }] }, true)
    controller.setView(id)
    root.current?.focus({ preventScroll: true })
  }
  const dismissAdd = (restoreFocus = true) => {
    setAdding(false)
    if (restoreFocus) { root.current?.focus({ preventScroll: true }); requestAnimationFrame(() => addButton.current?.focus()) }
  }
  const dismissSend = () => {
    setSending(false)
    root.current?.focus({ preventScroll: true })
    requestAnimationFrame(() => sendButton.current?.focus())
  }
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current || current.current.getSnapshot().conflict) return
    busyRef.current = true
    setBusy(true)
    setNotice('')
    setError(null)
    try { await action() }
    catch (error) { setError(error) }
    finally {
      busyRef.current = false
      setBusy(false)
      requestAnimationFrame(() => { if (!root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true }) })
    }
  }
  const output = (target?: { nodeId: string; panelId: string }) => run(async () => {
    const viewId = controller.getSnapshot().viewId
    if (!viewId) return
    const frame = await captureSceneStill(current.current, controller, host, viewId)
    if (!frame) return
    if (target) {
      await host.sendToPanel(target, frame)
      setNotice(m.frameSent)
      dismissSend()
    } else {
      await host.saveImage(frame.assetVersionId, frame.name)
      setNotice(m.imageSaved)
    }
  })
  return <div ref={root} className="vis-sc-editor" role="dialog" aria-modal="true" aria-label={host.node.title ?? m.scene} tabIndex={-1}
    onPointerDownCapture={event => {
      if (event.target instanceof Element && event.target.closest('.vis-sc-viewport')) root.current?.focus({ preventScroll: true })
    }} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Tab') {
        const controls = [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length)
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { event.preventDefault(); first?.focus() }
      }
      if (event.defaultPrevented) return
      if (event.key === 'Escape' && adding) { event.preventDefault(); dismissAdd(); return }
      if (event.target instanceof HTMLElement && (event.target.matches('input, textarea, select') || event.target.isContentEditable)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (sending) { if (!busyRef.current) dismissSend(); return }
        if (controller.getSnapshot().selectedJointId) {
          controller.selectJoint(null)
          requestAnimationFrame(() => root.current?.focus({ preventScroll: true }))
        } else if (!viewport.dragging) void close()
        return
      }
      if (adding || sending) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) { event.preventDefault(); if (!busyRef.current) current.current.undo(); return }
      if (event.ctrlKey || event.metaKey || event.altKey || busyRef.current) return
      const tools: Record<string, SceneTool> = { w: 'translate', e: 'rotate', r: 'scale' }
      const tool = tools[event.key.toLowerCase()]
      if (tool) { event.preventDefault(); controller.setTool(tool) }
      if (event.key.toLowerCase() === 'f') { event.preventDefault(); controller.frameSelection() }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove() }
    }}>
    <header className="vis-sc-header">
      <button aria-label={m.close} disabled={busy || viewport.dragging} onClick={() => void close()}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m14 5-7 7 7 7M7 12h14" /></svg></button>
      <strong>{host.node.title ?? m.scene}</strong>
      {writer ? <span className="vis-sc-writer">{m.lastWriter(writer)}</span> : null}
      <span role="status" className={`vis-sc-save is-${draft.saveState}`}>{m[draft.saveState]}</span>
      <button disabled={disabled || busy || viewport.dragging || !draft.canUndo} onClick={draft.undo}>{m.undo}</button>
      <button disabled={disabled || busy || viewport.dragging} onClick={() => void draft.flush().catch(setError)}>{m.save}</button>
    </header>
    {draft.conflict ? <div className="vis-sc-banner" role="alert"><span>{writer ? m.conflictBanner(writer) : m.conflictUnknown}</span><button disabled={busy} onClick={() => { draft.loadTheirs(); setClosing(false); setError(null); root.current?.focus({ preventScroll: true }) }}>{m.loadTheirs}</button>{closing ? <button onClick={host.onClose}>{m.discard}</button> : null}</div> : null}
    {error || draft.saveError ? <div className="vis-sc-banner is-error" role="alert"><span>{describeError(error ?? draft.saveError, locale)}</span>
      {draft.saveError ? <button onClick={() => { setError(null); root.current?.focus({ preventScroll: true }); void draft.flush().catch(setError) }}>{m.retry}</button> : <button onClick={() => { setError(null); root.current?.focus({ preventScroll: true }) }}>{m.dismissError}</button>}
      {closing ? <button onClick={host.onClose}>{m.discard}</button> : null}
    </div> : null}
    <div className="vis-sc-workspace">
      <ViewsPanel draft={draft} controller={controller} host={host} disabled={disabled} addView={addView} />
      <main className="vis-sc-main">
        <div className="vis-sc-tools" role="toolbar" aria-label={m.tools}>
          <button aria-pressed={viewport.mode === 'orbit'} disabled={busy || viewport.dragging} onClick={() => controller.setMode('orbit')}>{m.orbit}</button>
          <button aria-pressed={viewport.mode === 'camera'} disabled={busy || viewport.dragging || !view} onClick={() => controller.setMode('camera')}>{m.camera}</button>
          <label>{m.aspectRatio}<select aria-label={m.aspectRatio} value={view?.aspectRatio ?? '16:9'} disabled={disabled || !view} onChange={event => {
            const aspectRatio = SceneAspectRatio.parse(event.target.value)
            const latest = current.current.getSnapshot()
            latest.edit({ ...latest.doc, views: latest.doc.views.map(item => item.id === view?.id ? { ...item, aspectRatio } : item) })
          }}>{SceneAspectRatio.options.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}</select></label>
        </div>
        <SceneViewport controller={controller} doc={draft.doc} assetUrl={id => host.assetUrl(id)} disabled={!!draft.conflict || busy}
          onBeginEdit={() => current.current.beginEdit()}
          onTransform={(id, transform) => {
            const latest = current.current.getSnapshot()
            latest.edit({ ...latest.doc, objects: latest.doc.objects.map(object => object.id === id ? { ...object, transform } : object) }, true)
          }}
          onJointRotation={(id, jointId, rotation) => {
            const latest = current.current.getSnapshot()
            latest.edit({ ...latest.doc, objects: latest.doc.objects.map(object => {
              if (object.id !== id || object.source.type !== 'figure') return object
              const source = object.source
              const joint = BUILTIN_BODIES.find(body => body.id === source.bodyId)?.joints.find(joint => joint.id === jointId)
              return joint ? { ...object, source: { ...source, pose: { ...source.pose, [jointId]: clampJointRotation(joint, rotation) } } } : object
            }) }, true)
          }}
          onCameraChange={(viewId, camera) => {
            const latest = current.current.getSnapshot()
            latest.edit({ ...latest.doc, views: latest.doc.views.map(view => view.id === viewId ? { ...view, camera } : view) }, true)
          }} />
        {!draft.doc.objects.length && viewport.status === 'ready' ? <div className="vis-sc-empty"><button disabled={disabled} onClick={addFigure}>{m.addFigure}</button></div> : null}
        <div className="vis-sc-tools vis-sc-bottom-tools" role="toolbar" aria-label={m.transform}>
          <div className="vis-sc-add">
            <button ref={addButton} aria-expanded={adding} disabled={disabled || draft.doc.objects.length >= SCENE_LIMITS.objects} onClick={() => setAdding(value => !value)}>{m.add}</button>
            {adding ? <AddMenu host={host} disabled={disabled || draft.doc.objects.length >= SCENE_LIMITS.objects} add={add} dismiss={dismissAdd} importing={file => run(async () => {
              const assetVersionId = await host.importModel(file)
              add({ type: 'model', assetVersionId }, file.name.replace(/\.glb$/i, '') || file.name)
              dismissAdd()
            })} /> : null}
          </div>
          <span className="vis-sc-tool-divider" />
          {(['translate', 'rotate', 'scale'] as const).map(tool => <button key={tool} aria-pressed={viewport.tool === tool} disabled={disabled} onClick={() => controller.setTool(tool)}>{m[tool]}</button>)}
          <button disabled={!viewport.selectedId || busy || viewport.dragging} onClick={() => controller.frameSelection()}>{m.frame}</button>
          <span className="vis-sc-tool-spacer" />
          <button disabled={disabled || !view || viewport.status !== 'ready'} onClick={() => void output()}>{m.saveImage}</button>
          <button ref={sendButton} disabled={disabled || !view || viewport.status !== 'ready'} onClick={() => setSending(true)}>{m.sendTo}</button>
        </div>
        {notice ? <p className="vis-sc-output-notice" role="status">{notice}</p> : null}
      </main>
      <SceneInspector draft={draft} controller={controller} disabled={disabled} remove={remove} />
    </div>
    {sending ? <SendDialog host={host} busy={busy} send={target => output(target)} dismiss={dismissSend} /> : null}
  </div>
}
