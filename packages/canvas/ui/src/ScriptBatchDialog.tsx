import { type BatchMedia, type MethodParams, type MethodResult } from '@vis/protocol'
import { BatchEstimateDetails, batchMessages, describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ScriptActions, ScriptPartProps } from './script-ui'
import { GenerationSettingsContext } from './ModelPicker'
import { resolveChoice } from './params'
import { batchAttempt } from './script-batch'

export function ScriptBatchDialog({ parts, media, shotIds, actions, onClose, controls }: {
  controls?(locked: boolean): ReactNode
  parts: ScriptPartProps
  media: BatchMedia
  shotIds?: string[] | undefined
  actions: ScriptActions
  onClose(): void
}) {
  const m = useMessages(batchMessages)
  const f = useFormat()
  const { locale } = useLocale()
  const context = useContext(GenerationSettingsContext)
  const models = context?.catalog?.providers.filter(provider => provider.available).flatMap(provider => provider.models
    .filter(model => model.kind === (media === 'frames' ? 'image' : 'video'))
    .map(model => ({ provider: provider.id, model: model.id, label: `${provider.label} / ${model.label}` }))) ?? []
  const preferred = context?.catalog ? resolveChoice(context.catalog, media === 'frames' ? 'image' : 'video', parts.view.generation) : null
  const [choice, setChoice] = useState(preferred ? `${preferred.provider}/${preferred.model}` : '')
  const [strict, setStrict] = useState<string[]>([])
  const [missing, setMissing] = useState<'generate' | 'skip'>('generate')
  const [refresh, setRefresh] = useState(0)
  const [plan, setPlan] = useState<{ key: string; value: MethodResult<'script.batch.plan'> } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [sending, setSending] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const attempt = useRef<ReturnType<typeof batchAttempt> | null>(null)
  if (!attempt.current && actions.onStartScriptBatch) attempt.current = batchAttempt(actions.onStartScriptBatch, `web-${crypto.randomUUID()}`)
  const chosen = models.find(model => `${model.provider}/${model.model}` === choice)
    ?? models.find(model => model.provider === preferred?.provider && model.model === preferred?.model)
  const params: MethodParams<'script.batch.plan'> = {
    scriptNodeId: parts.view.nodeId, media, ...(shotIds?.length ? { shotIds } : {}),
    ...(chosen ? { provider: chosen.provider, model: chosen.model } : {}),
    ...(media === 'video' ? { strictShotIds: strict, missingFirstFrames: missing } : {}),
  }
  const key = JSON.stringify(attempt.current?.plan ?? params)
  const request = useMemo(() => JSON.parse(key) as MethodParams<'script.batch.plan'>, [key])
  const planner = useRef(actions.onPlanScriptBatch)
  const planCurrent = plan?.key === key ? plan.value : null
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement as HTMLElement | null
    element?.showModal()
    return () => { element?.close(); previous?.focus() }
  }, [])
  useEffect(() => {
    let current = true
    setPlan(null)
    setError(null)
    void planner.current?.(request).then(value => { if (current) setPlan({ key, value }) }, cause => { if (current) setError(cause) })
    return () => { current = false }
  }, [key, request, refresh])
  const shotLabels = new Map(parts.doc.shots.map((shot, index) => [shot.id, `${m.shot(f.number(index + 1))}: ${shot.description}`]))
  const shots = parts.doc.shots.filter(shot => !shotIds?.length || shotIds.includes(shot.id))
  const locked = sending || attempt.current?.submitted
  const submit = () => {
    if (sending || !planCurrent || !attempt.current) return
    setSending(true)
    setError(null)
    void attempt.current.run(request).then(onClose, setError).finally(() => setSending(false))
  }
  return createPortal(<dialog ref={dialog} className="vis-dialog vis-script-batch-dialog nodrag nopan" aria-label={m[media]} aria-busy={sending}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!sending) onClose() }}
    onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <header className="vis-dialog-header"><h2>{m[media]}</h2></header>
    <div className="vis-dialog-body">
      {controls?.(Boolean(locked))}
      <label>{m.model}<select aria-label={m.model} disabled={!!locked} value={chosen ? `${chosen.provider}/${chosen.model}` : ''} onChange={event => setChoice(event.target.value)}>
        {models.map(model => <option key={`${model.provider}/${model.model}`} value={`${model.provider}/${model.model}`}>{model.label}</option>)}
      </select></label>
      {media === 'video' ? <>
        <label>{m.missing}<select aria-label={m.missing} disabled={!!locked} value={missing} onChange={event => setMissing(event.target.value as 'generate' | 'skip')}>
          <option value="generate">{m.generate}</option><option value="skip">{m.skip}</option>
        </select></label>
        <p>{m.sequential}</p>
        {shots.filter(shot => shot.transition === 'continuous').map(shot => <label key={shot.id} className="vis-batch-strict">
          <input type="checkbox" aria-label={`${m.shot(f.number(parts.doc.shots.indexOf(shot) + 1))}: ${m.strict}`} checked={strict.includes(shot.id)} disabled={!!locked}
            onChange={event => setStrict(current => event.target.checked ? [...current, shot.id] : current.filter(id => id !== shot.id))} />
          {m.shot(f.number(parts.doc.shots.indexOf(shot) + 1))}: {m.strict}
        </label>)}
      </> : null}
      {planCurrent ? <BatchEstimateDetails batch={{ ...planCurrent, media }} shotLabels={shotLabels} /> : !error ? <p role="status">{m.loading}</p> : null}
      {error ? <p role="alert">{describeError(error, locale)}</p> : null}
      {error && !planCurrent ? <button onClick={() => setRefresh(value => value + 1)}>{m.retry}</button> : null}
    </div>
    <footer className="vis-dialog-footer">
      <button disabled={sending} onClick={onClose}>{m.close}</button>
      <button disabled={sending || !planCurrent || !attempt.current} onClick={submit}>{attempt.current?.submitted && error ? m.retry : m.confirm}</button>
    </footer>
  </dialog>, document.body)
}
