import type { AssetVersionView, JobOutput, JobView } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useRef, useState } from 'react'
import { AttachmentPreview } from './Attachments'
import { resultOutputs, resultState } from './generationResults'
import { resultMessages } from './messages'
import { SessionIcon } from './SessionIcon'
import type { SessionPanelProps } from './SessionPanel'

type ResultActions = Pick<SessionPanelProps, 'resolveAsset' | 'assetUrl' | 'posterUrl' | 'onLocateRef' | 'onAddRef' | 'onAddAssetRef'> & { archived: boolean }

export function GenerationResult({ job, ...actions }: ResultActions & { job: JobView }) {
  const m = useMessages(resultMessages)
  const { locale } = useLocale()
  const format = useFormat()
  const [expanded, setExpanded] = useState(false)
  const states = { queued: m.queued, running: m.running, finalizing: m.finalizing, succeeded: m.succeeded, failed: m.failed, cancelled: m.cancelled, unknown: m.unknown }
  const title = job.kind === 'image' ? m.image : job.kind === 'video' ? m.video : job.kind === 'audio' ? m.audio : m.result
  return <section className={`vis-generation-result is-${resultState(job.status)}`} aria-label={title}>
    <header><strong>{title}</strong><span role="status">{states[job.status]}</span></header>
    {job.status === 'failed' && job.error ? <p className="vis-generation-error">{describeError(job.error, locale)}</p> : null}
    {job.status === 'cancelled' && job.providerCancelled === false ? <p>{m.cancelledProvider}</p> : null}
    {job.outputs.length ? <div className="vis-generation-outputs">{resultOutputs(job, expanded).map(output => <ResultOutput key={output.outputIndex} output={output} {...actions} />)}</div> : null}
    {!expanded && job.outputs.length > 4 ? <button type="button" className="vis-generation-more" aria-expanded={false} onClick={() => setExpanded(true)}>{m.more(format.number(job.outputs.length - 4))}</button> : null}
  </section>
}

function ResultOutput({ output, ...p }: ResultActions & { output: JobOutput }) {
  const m = useMessages(resultMessages)
  const format = useFormat()
  const [asset, setAsset] = useState<AssetVersionView | null>(null)
  const [missing, setMissing] = useState(false)
  const [posterFailed, setPosterFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const resolver = useRef(p.resolveAsset)
  resolver.current = p.resolveAsset
  useEffect(() => {
    let current = true
    setAsset(null)
    setMissing(false)
    setPosterFailed(false)
    setOpen(false)
    void resolver.current(output.assetVersionId).then(asset => { if (current) setAsset(asset) }, () => { if (current) setMissing(true) })
    return () => { current = false }
  }, [output.assetVersionId])
  const name = asset?.displayName ?? m.output(format.number(output.outputIndex + 1))
  const src = p.assetUrl(output.assetVersionId)
  const nodeId = output.delivery.nodeId
  const deliveredNodeId = output.delivery.status === 'delivered' ? nodeId : undefined
  const kind = asset?.kind
  return <div className={`vis-generation-output${kind === 'audio' ? ' is-audio' : ''}`}>
    <button type="button" className={`vis-generation-preview${asset?.hasAlpha ? ' vis-alpha-media' : ''}`} aria-label={m.preview(name)} disabled={!asset || missing} onClick={() => setOpen(true)}>
      {missing ? <span>{m.missing}</span> : !asset ? <span>{m.loading}</span>
        : kind === 'image' ? <img src={src} alt={name} loading="lazy" onError={() => setMissing(true)} />
          : kind === 'video' ? <>{!posterFailed ? <img src={p.posterUrl(output.assetVersionId)} alt={name} loading="lazy" onError={() => setPosterFailed(true)} /> : <SessionIcon kind="video" />}<span className="vis-ref-play"><SessionIcon kind="play" /></span></>
            : <><SessionIcon kind="audio" /><span>{name}</span></>}
    </button>
    {kind === 'audio' && !missing ? <audio src={src} controls preload="none" aria-label={name} onError={() => setMissing(true)} /> : null}
    <div className="vis-generation-actions">
      {nodeId ? <button type="button" aria-label={m.locateOutput(name)} onClick={() => p.onLocateRef(nodeId)}>{m.locate}</button> : null}
      <button type="button" aria-label={m.referenceOutput(name)} disabled={p.archived || !asset || missing} onClick={() => { if (asset) { if (deliveredNodeId) p.onAddRef(deliveredNodeId); else p.onAddAssetRef(asset) } }}>{m.reference}</button>
    </div>
    {open && asset && !missing ? <AttachmentPreview asset={{ ...asset, displayName: name }} src={src} onClose={() => setOpen(false)} /> : null}
  </div>
}
