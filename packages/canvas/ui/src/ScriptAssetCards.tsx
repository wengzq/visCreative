import { useEffect, useRef, useState } from 'react'
import { SCRIPT_LIMITS, type ScriptAsset, type ScriptAssetKind } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useCanvasSelector } from './CanvasView'
import type { ScriptPartProps } from './script-ui'
import { assetUseCount } from './script-agent-model'
import { scriptAgentMessages } from './script-agent-messages'
import { scriptMessages } from './script-messages'
import { useScriptAgent } from './ScriptAgentControls'
import './script-assets.css'

export function ScriptAssetCards(props: ScriptPartProps) {
  const missing = useCanvasSelector(state => props.doc.assets.filter(asset =>
    !asset.imageNodeId || !state.nodes.some(node => node.nodeId === asset.imageNodeId && node.kind === 'image')).length, [props.doc.assets])
  const m = useMessages(scriptAgentMessages)
  const sm = useMessages(scriptMessages)
  const actions = useCanvasSelector(state => state.actions, [])
  const format = useFormat()
  const { locale } = useLocale()
  const [adding, setAdding] = useState<ScriptAssetKind | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [pickingSetting, setPickingSetting] = useState(false)
  const add = async () => {
    if (!adding || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await props.onPatch([{ kind: 'asset.insert', tempId: crypto.randomUUID(), asset: { kind: adding, name: name.trim(), description: '' } }])
      setAdding(null)
      setName('')
    } catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  return <div className="vis-script-assets">
    {actions.renderScriptSettingPicker ? <div className="vis-script-library-tools"><button disabled={busy} onClick={() => setPickingSetting(true)}>{sm.addFromLibrary}</button></div> : null}
    {pickingSetting ? actions.renderScriptSettingPicker?.({
      castIds: props.doc.castIds ?? props.doc.assets.map(asset => asset.id),
      ...(props.doc.styleId ? { styleId: props.doc.styleId } : {}),
      castLimitReached: props.doc.assets.length >= SCRIPT_LIMITS.assets,
      onClose: () => setPickingSetting(false),
      onPick: async setting => {
        await props.onPatch([{ kind: 'doc.set', rev: props.doc.rev, fields: setting.kind === 'style'
          ? { styleId: setting.id }
          : { castIds: [...new Set([...(props.doc.castIds ?? props.doc.assets.map(asset => asset.id)), setting.id])] } }])
      },
    }) : null}
    {(['character', 'scene', 'prop'] as const).map(kind => <section key={kind} aria-label={m[kind]}>
      <header><h3>{m[kind]}</h3><button disabled={busy || props.doc.assets.length >= SCRIPT_LIMITS.assets} onClick={() => { setAdding(kind); setName(''); setError(null) }}>{m.addAsset}</button></header>
      {adding === kind ? <form onSubmit={event => { event.preventDefault(); void add() }}>
        <label>{m.assetName}<input autoFocus aria-label={m.assetName} maxLength={60} value={name} onChange={event => setName(event.target.value)} /></label>
        <button disabled={busy || !name.trim()} type="submit">{m.save}</button><button type="button" disabled={busy} onClick={() => setAdding(null)}>{m.cancel}</button>
      </form> : null}
      <div className="vis-script-asset-grid">{props.doc.assets.filter(asset => asset.kind === kind).map(asset => <AssetCard key={asset.id} {...props} asset={asset} />)}</div>
    </section>)}
    {error ? <p role="alert">{describeError(error, locale)}</p> : null}
    <footer role="status">{m.missingImages(format.number(missing))}</footer>
  </div>
}

function AssetCard(props: ScriptPartProps & { asset: ScriptAsset }) {
  const { asset } = props
  const { actions, image, assetUrl, pickImage } = useCanvasSelector(state => ({
    actions: state.actions, image: state.nodes.find(node => node.nodeId === asset.imageNodeId && node.kind === 'image'),
    assetUrl: state.assetUrl, pickImage: state.pickImage,
  }), [asset.imageNodeId])
  const m = useMessages(scriptAgentMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const agent = useScriptAgent(props)
  const [name, setName] = useState(asset.name)
  const [description, setDescription] = useState(asset.description)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const upload = useRef<HTMLInputElement>(null)
  useEffect(() => { setName(asset.name); setDescription(asset.description) }, [asset.id, asset.rev, asset.name, asset.description])
  const work = async (callback: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try { await callback() }
    catch (error) { setError(error) }
    finally { setBusy(false) }
  }
  const updateImage = (imageNodeId: string | null) => props.onPatch([{ kind: 'asset.update', assetId: asset.id, rev: asset.rev, fields: { imageNodeId } }])
  const makeImage = async (file?: File) => {
    if (!actions.onScriptAssetImage) return
    const imageNodeId = await actions.onScriptAssetImage(props.view.nodeId, asset.id, file)
    await updateImage(imageNodeId)
    if (!file) await agent.run({ task: 'custom', text: m.referenceRequest(asset.name, imageNodeId) })
  }
  const content = image?.slots.find(slot => slot.slotKey === 'main')?.content
  return <article className="vis-script-asset-card" aria-label={asset.name}>
    {content?.type === 'asset' ? <img src={assetUrl(content.assetVersionId)} alt={m.reference(asset.name)} /> : <div className="vis-script-asset-empty" aria-label={m.reference(asset.name)} />}
    <label>{m.assetName}<input aria-label={m.assetName} maxLength={60} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
    <label>{m.description}<textarea aria-label={m.description} maxLength={SCRIPT_LIMITS.cell} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} /></label>
    <button disabled={busy || !name.trim() || name === asset.name && description === asset.description} onClick={() => void work(() => props.onPatch([{ kind: 'asset.update', assetId: asset.id, rev: asset.rev, fields: { name: name.trim(), description } }]))}>{m.save}</button>
    <div className="vis-script-asset-actions">
      <button disabled={busy} onClick={() => pickImage(props.view.nodeId, nodeId => { void work(() => updateImage(nodeId)) })}>{m.pick}</button>
      <button disabled={busy || !actions.onScriptAssetImage} onClick={() => upload.current?.click()}>{m.upload}</button>
      <button disabled={busy || agent.busy || !actions.onScriptAssetImage || !actions.onScriptAgent} onClick={() => void work(() => makeImage())}>{m.generate}</button>
      {asset.imageNodeId ? <button disabled={busy} onClick={() => void work(() => updateImage(null))}>{m.removeImage}</button> : null}
    </div>
    <input ref={upload} className="vis-upload-input" type="file" accept="image/*" aria-label={m.upload} onChange={event => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (file) void work(() => makeImage(file))
    }} />
    <p className="vis-script-asset-usage">{m.uses(format.number(assetUseCount(props.doc, asset.id)))}</p>
    <button className="is-danger" disabled={busy} onClick={() => void work(() => props.onPatch([{ kind: 'asset.delete', assetId: asset.id, rev: asset.rev }]))}>{m.delete}</button>
    {error ? <p role="alert">{describeError(error, locale)}</p> : null}
    {agent.feedback}
  </article>
}
