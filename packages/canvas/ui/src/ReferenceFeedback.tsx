import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { promptMessages } from './prompt-messages'
import type { videoReferenceState } from './reference-validation'

export function ReferenceFeedback({ state, loading, failed, onManage, onRetry }: {
  state: ReturnType<typeof videoReferenceState>
  loading: boolean
  failed: boolean
  onManage(): void
  onRetry(): void
}) {
  const p = useMessages(promptMessages)
  const f = useFormat()
  const { locale } = useLocale()
  if (!state.count) return null
  const { limits, problem } = state
  const problemText = !problem ? undefined : problem.reason === 'unsupported' ? p.videoReferenceUnsupported
    : problem.reason === 'total' ? p.referenceTotalLimit(f.number(problem.params.max!))
    : problem.reason === 'images' ? p.referenceImageLimit(f.number(problem.params.max!))
    : describeError({ data: problem }, locale)
  return <div className="vis-reference-feedback">
    {limits ? <div role="status">{p.videoReferenceUsage(f.number(state.count), f.number(limits.max), state.knownCount === state.count ? f.number(state.totalMs / 1000) : p.unknownReferenceDuration, f.number(limits.totalMs / 1000))}</div> : null}
    {problemText ? <div className="vis-prompt-broken" role="status">{problemText}</div> : null}
    {state.durationUnchecked ? <div role="status">{loading ? p.videoReferenceLoading : p.videoReferenceUnavailable}{failed && !loading ? <> <button type="button" onClick={onRetry}>{p.retryReferenceMetadata}</button></> : null}</div> : null}
    {state.hostingRequired ? <div role="status">{describeError({ data: { reason: 'generation.video_reference_hosting_required' } }, locale)}{' '}<button type="button" className="vis-reference-settings-link" onClick={onManage}>{p.mediaHostingSettings}</button></div> : null}
    <div className="vis-reference-cost">{p.videoReferenceBilling}</div>
  </div>
}
