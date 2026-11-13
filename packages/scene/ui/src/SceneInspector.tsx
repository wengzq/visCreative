import { SCENE_LIMITS, type SceneObject, type SceneTransform, type Vec3 } from '@vis/protocol'
import { BUILTIN_BODIES, sampleScene } from '@vis/scene-core'
import { useFormat, useMessages } from '@vis/ui-kit'
import { useRef, type ReactNode } from 'react'
import { Euler, MathUtils, Quaternion } from 'three'
import { NameField, NumberField } from './fields'
import { sceneMessages } from './messages'
import { editMotionObject, editMotionValue } from './motion-edit'
import { PoseInspector } from './PoseInspector'
import type { SceneDraft, SceneViewportController } from './types'
import { useSceneViewportState } from './viewport-state'

export function SceneInspector({ draft, controller, disabled, remove, timeS, proposals }: {
  proposals?: ReactNode
  draft: SceneDraft
  controller: SceneViewportController
  disabled: boolean
  timeS: number
  remove(id: string): void
}) {
  const m = useMessages(sceneMessages)
  const f = useFormat()
  const root = useRef<HTMLElement>(null)
  const state = useSceneViewportState(controller)
  const sampled = sampleScene(draft.doc, timeS)
  const selected = sampled.objects.find(object => object.id === state.selectedId)
  const source = selected?.source
  const body = source?.type === 'figure' ? BUILTIN_BODIES.find(body => body.id === source.bodyId) : undefined
  const view = sampled.views.find(view => view.id === state.viewId)
  const full = draft.doc.objects.length >= SCENE_LIMITS.objects
  const patch = (id: string, change: (object: SceneObject) => SceneObject) => {
    const latest = draft.getSnapshot()
    latest.edit(editMotionObject(latest.doc, id, timeS, change))
  }
  const lens = (focalLengthMm: number) => {
    const latest = draft.getSnapshot()
    if (view) latest.edit(editMotionValue(latest.doc, { type: 'camera', id: view.id }, timeS, { ...view.camera, focalLengthMm }))
  }
  return <aside ref={root} className="vis-sc-inspector" aria-label={m.inspector} tabIndex={-1}>
    <div className="vis-sc-panel-heading"><h2>{m.inspector}</h2></div>
    {proposals}
    <section className="vis-sc-inspector-section" aria-label={m.outline}>
      <h3>{m.outline}</h3>
      {!draft.doc.objects.length ? <p className="vis-sc-muted">{m.noObjects}</p> : null}
      <ul className="vis-sc-outline" aria-label={m.outline}>
        {sampled.objects.map(object => <li key={object.id} className={object.hidden ? 'is-hidden' : ''}>
          <button className="vis-sc-object-select" aria-label={m.selectObject(object.name)} aria-pressed={object.id === state.selectedId} disabled={disabled} onClick={() => controller.select(object.id)}>{object.name}</button>
          <button aria-label={object.hidden ? m.showObject(object.name) : m.hideObject(object.name)} disabled={disabled} onClick={() => patch(object.id, item => ({ ...item, hidden: !item.hidden }))}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{object.hidden ? <path d="m3 3 18 18" /> : null}</svg>
          </button>
          <button aria-label={m.deleteObject(object.name)} disabled={disabled} onClick={() => remove(object.id)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7M14 10v7" /></svg>
          </button>
        </li>)}
      </ul>
      {full ? <p className="vis-sc-limit" role="status">{m.objectLimit(f.number(SCENE_LIMITS.objects))}</p> : null}
    </section>
    {selected?.source.type === 'figure' && body ? <PoseInspector key={`${selected.id}-${body.id}`} body={body} pose={selected.source.pose}
      controller={controller} disabled={disabled} change={update => patch(selected.id, object => object.source.type === 'figure'
        ? { ...object, source: { ...object.source, pose: update(object.source.pose) } } : object)} /> : null}
    {selected ? <section className="vis-sc-inspector-section" aria-label={m.transform}>
      <NameField label={m.objectName} value={selected.name} disabled={disabled} onChange={name => patch(selected.id, object => ({ ...object, name }))} />
      <TransformFields transform={selected.transform} disabled={disabled} onChange={transform => patch(selected.id, object => ({ ...object, transform }))} />
      {selected.source.type === 'figure' ? <NumberField label={m.figureHeight} value={selected.source.heightM} disabled={disabled} min={SCENE_LIMITS.heightM.min} max={SCENE_LIMITS.heightM.max}
        onChange={heightM => patch(selected.id, object => object.source.type === 'figure' ? { ...object, source: { ...object.source, heightM } } : object)} /> : null}
      <button disabled={disabled || full} onClick={() => {
        const latest = draft.getSnapshot()
        if (latest.conflict || latest.doc.objects.length >= SCENE_LIMITS.objects) return
        const id = crypto.randomUUID()
        const original = latest.doc.objects.find(object => object.id === selected.id)!
        latest.edit({ ...latest.doc, objects: [...latest.doc.objects, { ...structuredClone(original), id, name: m.copyName(selected.name).slice(0, SCENE_LIMITS.name), createdBy: 'user', userTouched: true }] }, true)
        controller.select(id)
        root.current?.focus()
      }}>{m.duplicateObject}</button>
    </section> : null}
    {view ? <section className="vis-sc-inspector-section" aria-label={m.lens}>
      <h3>{m.lens}</h3>
      <div className="vis-sc-lens-presets">{[24, 35, 50, 85].map(value => <button key={value} disabled={disabled} aria-pressed={Math.abs(view.camera.focalLengthMm - value) < 0.001} onClick={() => lens(value)}>{m.lensPreset(f.number(value))}</button>)}</div>
      <NumberField label={m.focalLength} value={view.camera.focalLengthMm} disabled={disabled} min={SCENE_LIMITS.focalLengthMm.min} max={SCENE_LIMITS.focalLengthMm.max} onChange={lens} />
      {(['position', 'target'] as const).map(field => <fieldset className="vis-sc-transform" key={field} disabled={disabled}>
        <legend>{m[field === 'position' ? 'cameraPosition' : 'cameraTarget']}</legend>
        <div>{(['x', 'y', 'z'] as const).map((axis, index) => <NumberField key={axis}
          label={m.transformField(m[field === 'position' ? 'cameraPosition' : 'cameraTarget'], m[axis])} caption={m[axis]} value={view.camera[field][index]!} disabled={disabled} onChange={value => {
            const latest = draft.getSnapshot()
            const camera = sampleScene(latest.doc, timeS).views.find(item => item.id === view.id)!.camera
            const vector = [...camera[field]] as Vec3
            vector[index] = value
            latest.edit(editMotionValue(latest.doc, { type: 'camera', id: view.id }, timeS, { ...camera, [field]: vector }))
          }} />)}</div>
      </fieldset>)}
      <NumberField label={m.cameraRoll} value={MathUtils.radToDeg(view.camera.roll)} disabled={disabled} onChange={value => {
        const latest = draft.getSnapshot()
        latest.edit(editMotionValue(latest.doc, { type: 'camera', id: view.id }, timeS, { ...view.camera, roll: MathUtils.degToRad(value) }))
      }} />
    </section> : null}
  </aside>
}

function TransformFields({ transform, disabled, onChange }: { transform: SceneTransform; disabled: boolean; onChange(transform: SceneTransform): void }) {
  const m = useMessages(sceneMessages)
  const rotation = new Euler().setFromQuaternion(new Quaternion(...transform.rotation), 'XYZ')
  const degrees: Vec3 = [rotation.x, rotation.y, rotation.z].map(MathUtils.radToDeg) as Vec3
  return <>{(['position', 'rotation', 'scale'] as const).map(field => <fieldset className="vis-sc-transform" key={field} disabled={disabled}>
    <legend>{m[field]}</legend>
    <div>{(['x', 'y', 'z'] as const).map((axis, index) => <NumberField key={axis} label={m.transformField(m[field], m[axis])} caption={m[axis]} value={(field === 'rotation' ? degrees : transform[field])[index]!} disabled={disabled} onChange={value => {
      const next = [...(field === 'rotation' ? degrees : transform[field])] as Vec3
      next[index] = value
      onChange({ ...transform, [field]: field === 'rotation' ? new Quaternion().setFromEuler(new Euler(...next.map(MathUtils.degToRad) as Vec3, 'XYZ')).toArray() : next })
    }} />)}</div>
  </fieldset>)}</>
}
