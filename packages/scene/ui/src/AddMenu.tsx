import { ScenePrimitiveShape, type SceneObjectSource } from '@vis/protocol'
import { BUILTIN_PROPS, HUMAN_BODY } from '@vis/scene-core'
import { describeError, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useRef, useState } from 'react'
import { sceneMessages } from './messages'
import type { SceneEditorHost } from './types'

export function AddMenu({ host, disabled, add, importing, dismiss }: {
  host: SceneEditorHost
  disabled: boolean
  add(source: SceneObjectSource, name: string): void
  importing(file: File): Promise<void>
  dismiss(restoreFocus?: boolean): void
}) {
  const m = useMessages(sceneMessages)
  const { locale } = useLocale()
  const [models, setModels] = useState<Awaited<ReturnType<SceneEditorHost['listModels']>>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const hostRef = useRef(host)
  hostRef.current = host
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    void hostRef.current.listModels().then(models => { if (live) setModels(models) }).catch(error => { if (live) setError(error) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [reload])
  useEffect(() => { root.current?.querySelector('button')?.focus() }, [])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.vis-sc-add')) dismiss(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [dismiss])
  const insert = (source: SceneObjectSource, name: string) => { add(source, name); dismiss() }
  const props = ['bench', 'chair', 'table', 'wall', 'door', 'car'] as const
  return <div ref={root} className="vis-sc-add-menu" role="group" aria-label={m.addObjects} tabIndex={-1}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() } }}>
    <button disabled={disabled} onClick={() => insert({ type: 'figure', bodyId: HUMAN_BODY.id, heightM: HUMAN_BODY.heightM, pose: {} }, m.figure)}>{m.addFigure}</button>
    <h3>{m.primitives}</h3>
    <div className="vis-sc-add-grid">{ScenePrimitiveShape.options.map(shape => <button key={shape} disabled={disabled} onClick={() => insert({ type: 'primitive', shape, size: shape === 'plane' ? [2, 1, 2] : [1, 1, 1] }, m[shape])}>{m[shape]}</button>)}</div>
    <h3>{m.props}</h3>
    <div className="vis-sc-add-grid">{props.filter(id => BUILTIN_PROPS.some(prop => prop.id === id)).map(propId => <button key={propId} disabled={disabled} onClick={() => insert({ type: 'prop', propId }, m[propId])}>{m[propId]}</button>)}</div>
    <h3>{m.projectModels}</h3>
    {loading ? <p className="vis-sc-muted" role="status">{m.loadingModels}</p> : null}
    {!loading && !error && !models.length ? <p className="vis-sc-muted">{m.noModels}</p> : null}
    {error ? <div role="alert"><p>{describeError(error, locale)}</p><button disabled={disabled} onClick={() => setReload(value => value + 1)}>{m.retryModels}</button></div> : null}
    <ul className="vis-sc-model-list" aria-label={m.projectModels}>{models.map(model => <li key={model.assetVersionId}><button aria-label={m.addModel(model.name)} disabled={disabled} onClick={() => insert({ type: 'model', assetVersionId: model.assetVersionId }, model.name)}>{model.name}</button></li>)}</ul>
    <input ref={input} type="file" accept=".glb,model/gltf-binary" aria-label={m.importModel} hidden onChange={event => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (file) void importing(file).finally(() => root.current?.focus())
    }} />
    <div className="vis-sc-button-row"><button disabled={disabled} onClick={() => input.current?.click()}>{m.importModel}</button><button onClick={() => dismiss()}>{m.cancel}</button></div>
  </div>
}
