import { SCENE_LIMITS } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { useRef } from 'react'
import { NameField } from './fields'
import { sceneMessages } from './messages'
import type { SceneDraft, SceneEditorHost, SceneViewportController } from './types'
import { useSceneViewportState } from './viewport-state'

export function ViewsPanel({ draft, controller, host, disabled, addView }: {
  draft: SceneDraft
  controller: SceneViewportController
  host: SceneEditorHost
  disabled: boolean
  addView(): void
}) {
  const m = useMessages(sceneMessages)
  const f = useFormat()
  const root = useRef<HTMLElement>(null)
  const state = useSceneViewportState(controller)
  const selected = draft.doc.views.find(view => view.id === state.viewId)
  const full = draft.doc.views.length >= SCENE_LIMITS.views
  const index = draft.doc.views.findIndex(view => view.id === state.viewId)
  const reorder = (offset: number) => {
    const latest = draft.getSnapshot()
    const views = [...latest.doc.views]
    const from = views.findIndex(view => view.id === controller.getSnapshot().viewId)
    if (from < 0 || from + offset < 0 || from + offset >= views.length) return
    const [view] = views.splice(from, 1)
    views.splice(from + offset, 0, view!)
    latest.edit({ ...latest.doc, views }, true)
  }
  return <aside ref={root} className="vis-sc-views" aria-label={m.views} tabIndex={-1}>
    <div className="vis-sc-panel-heading"><h2>{m.views}</h2><button aria-label={m.addView} disabled={disabled || full || state.status !== 'ready'} onClick={addView}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </button></div>
    {!draft.doc.views.length ? <p className="vis-sc-muted">{m.noView}</p> : null}
    <ul className="vis-sc-view-list" aria-label={m.views}>
      {draft.doc.views.map(view => <li key={view.id}>
        <button className="vis-sc-view" aria-label={m.selectView(view.name)} aria-pressed={view.id === state.viewId} disabled={disabled} onClick={() => controller.setView(view.id)}>
          {view.still ? <img src={host.assetUrl(view.still)} alt={m.viewStill(view.name)} /> : <span className="vis-sc-view-placeholder" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M3 7h12v11H3zM15 10l6-3v11l-6-3zM6 7l2-3h4l2 3" /></svg></span>}
          <span>{view.name}</span>
        </button>
      </li>)}
    </ul>
    {full ? <p className="vis-sc-limit" role="status">{m.viewLimit(f.number(SCENE_LIMITS.views))}</p> : null}
    {selected ? <div className="vis-sc-view-details">
      <NameField label={m.viewName} value={selected.name} disabled={disabled} onChange={name => {
        const latest = draft.getSnapshot()
        latest.edit({ ...latest.doc, views: latest.doc.views.map(view => view.id === selected.id ? { ...view, name } : view) })
      }} />
      <div className="vis-sc-button-row">
        <button disabled={disabled || full} onClick={() => {
          const latest = draft.getSnapshot()
          if (latest.conflict || latest.doc.views.length >= SCENE_LIMITS.views) return
          const id = crypto.randomUUID()
          latest.edit({ ...latest.doc, views: [...latest.doc.views, { ...selected, id, name: m.copyName(selected.name).slice(0, SCENE_LIMITS.name) }] }, true)
          controller.setView(id)
          root.current?.focus()
        }}>{m.duplicateView}</button>
        <button disabled={disabled} onClick={() => {
          const latest = draft.getSnapshot()
          latest.edit({ ...latest.doc, views: latest.doc.views.filter(view => view.id !== selected.id) }, true)
          root.current?.focus()
        }}>{m.deleteView}</button>
        <button disabled={disabled || index <= 0} onClick={() => reorder(-1)}>{m.viewEarlier}</button>
        <button disabled={disabled || index === draft.doc.views.length - 1} onClick={() => reorder(1)}>{m.viewLater}</button>
      </div>
    </div> : null}
  </aside>
}
