import { useFormat, useMessages } from './i18n'
import { batchMessages } from './batch-messages'

// Structural props keep this shared presentation independent of the protocol package.
export type BatchDetails = {
  media?: 'frames' | 'video'
  estimate: {
    shots: number; jobs: number; billedJobs: number; provider: string; model: string; quotaRemaining: number | null
    compositionRefsUsed?: number | undefined
    compositionRefsDropped?: readonly { shotId: string; panelId: string; panelNumber: number; previzNodeId: string; reason: 'unsupported' | 'limit' }[] | undefined
    panelFramesUsed?: number | undefined
    frameMode?: 'first' | 'first_last' | null | undefined
    staleShots: number; shotsMissingAssetImages: number; shotsMissingFirstFrame: number; shotsWithoutPrompt: number
  }
  shots: readonly { shotId: string; steps: readonly { role: 'first' | 'last' | 'video'; source?: 'generate' | 'extract' | 'panel' | undefined; status?: string | undefined }[] }[]
  changedShotIds?: readonly string[] | undefined
}

export function BatchEstimateDetails({ batch, shotLabels }: { batch: BatchDetails; shotLabels?: ReadonlyMap<string, string> }) {
  const m = useMessages(batchMessages)
  const f = useFormat()
  const e = batch.estimate
  const warnings = (['staleShots', 'shotsMissingAssetImages', 'shotsMissingFirstFrame', 'shotsWithoutPrompt'] as const)
    .filter(key => e[key] > 0)
  return <div className="vis-batch-details">
    <p><strong>{m.estimate(f.number(e.shots), f.number(e.jobs))}</strong></p>
    <p>{m.model}: {e.provider} / {e.model}</p>
    <p>{e.billedJobs ? m.billed(f.number(e.billedJobs)) : m.free}</p>
    <p>{m.quota(e.quotaRemaining === null ? m.unlimited : f.number(e.quotaRemaining))}</p>
    {batch.media === 'video' ? <>
      <p>{m.frameMode(e.frameMode ? m[e.frameMode] : m.promptOnly)}</p>
      {e.frameMode !== 'first_last' ? <p>{e.frameMode === 'first' ? m.firstFallback : m.promptFallback}</p> : null}
    </> : null}
    {e.compositionRefsUsed ? <p>{m.compositionRefsUsed(f.number(e.compositionRefsUsed))}</p> : null}
    {e.panelFramesUsed ? <p>{m.panelFramesUsed(f.number(e.panelFramesUsed))}</p> : null}
    {e.compositionRefsDropped?.length ? <aside aria-label={m.droppedComposition}><strong>{m.droppedComposition}</strong><ul>{e.compositionRefsDropped.map((ref, index) => <li key={`${ref.previzNodeId}:${ref.panelId}:${index}`}>{shotLabels?.get(ref.shotId) ?? ref.shotId} · {m.panelNumber(f.number(ref.panelNumber))}: {m[ref.reason]}</li>)}</ul></aside> : null}
    {warnings.length ? <aside aria-label={m.warnings}><strong>{m.warnings}</strong><ul>{warnings.map(key => <li key={key}>{m[key](f.number(e[key]))}</li>)}</ul></aside> : null}
    {batch.shots.some(shot => shot.steps.some(step => step.source === 'extract')) ? <p>{m.sequential}</p> : null}
    <ul>{batch.shots.map((shot, index) => <li key={shot.shotId} className={batch.changedShotIds?.includes(shot.shotId) ? 'is-changed' : undefined}>
      {shotLabels?.get(shot.shotId) ?? `${m.shot(f.number(index + 1))} (${shot.shotId})`}: {shot.steps.map(step => `${m[step.role]}${step.source === 'extract' ? ` (${m.extract})` : step.source === 'panel' ? ` (${m.panelFrame})` : ''}${step.status === 'skipped' && step.source !== 'panel' ? ` (${m.skipped})` : ''}`).join(' / ')}
      {batch.changedShotIds?.includes(shot.shotId) ? <strong> · {m.changed}</strong> : null}
    </li>)}</ul>
  </div>
}
