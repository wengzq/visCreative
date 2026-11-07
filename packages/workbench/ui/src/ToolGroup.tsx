import type { JobView, TranscriptItem } from '@vis/protocol'
import { useFormat, useLocale, useMessages, type Locale } from '@vis/ui-kit'
import { sessionMessages } from './messages'
import { localizedToolLabel } from './activity'
import { SessionIcon } from './SessionIcon'
import { generationJob, type ToolCall, type ToolTranscriptGroup } from './toolGroups'

type ToolPayload = { name?: string; input?: unknown; text?: unknown; isError?: boolean }
const payload = (item: TranscriptItem | undefined) => (item?.payload ?? {}) as ToolPayload
const name = ({ call, result }: ToolCall, locale: Locale) => {
  const raw = payload(call).name || payload(result).name
  if (!raw) return undefined
  return localizedToolLabel(raw, locale) ?? raw
}
const status = (pair: ToolCall, jobs?: ReadonlyMap<string, JobView>) => generationJob(pair, jobs)?.status === 'cancelled' ? 'cancelled' : payload(pair.result).isError ? 'error' : pair.call && !pair.result ? 'pending' : 'success'

function StatusIcon({ state }: { state: ReturnType<typeof status> }) {
  return (
    <svg className={`vis-tool-status is-${state}`} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {state === 'error' || state === 'cancelled' ? <path d="m4 4 8 8M12 4l-8 8" />
        : state === 'pending' ? <circle cx="8" cy="8" r="5.5" strokeDasharray="24 11" />
          : <path d="m3 8 3 3 7-7" />}
    </svg>
  )
}

function Chevron() {
  return <span className="vis-tool-chevron"><SessionIcon kind="chevron" /></span>
}

export function ToolGroup({ group, jobs, onToggle }: { group: ToolTranscriptGroup; jobs?: ReadonlyMap<string, JobView> | undefined; onToggle?: () => void }) {
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  const format = useFormat()
  const toolName = (pair: ToolCall) => name(pair, locale) ?? m.toolResult
  const pending = group.calls.filter(call => status(call, jobs) === 'pending')
  const failed = group.calls.filter(call => status(call, jobs) === 'error').length
  const cancelled = group.calls.filter(call => status(call, jobs) === 'cancelled').length
  const names = [...new Set(group.calls.map(toolName))]
  const state = pending.length ? 'pending' : failed ? 'error' : cancelled ? 'cancelled' : 'success'
  const summary = pending.length ? <>{m.callingPrefix}<span className="vis-tool-name">{toolName(pending.at(-1)!)}</span>{m.callingSuffix}</>
    : group.calls.length === 1 ? <>{m.calledPrefix}<span className="vis-tool-name">{names[0]}</span></>
      : <>{m.calledTools(format.number(group.calls.length))}<span className="vis-tool-name"> · {names.slice(0, 3).join(m.toolSeparator)}{names.length > 3 ? m.moreTools : ''}</span></>
  return (
    <details className="vis-item is-tool vis-tool-group" data-state={state} data-history-items={JSON.stringify(group.calls.flatMap(pair => [pair.call?.itemId, pair.result?.itemId].filter(Boolean)))} onToggle={onToggle}>
      <summary className="vis-tool-group-summary">
        <StatusIcon state={state} />
        <span>{summary}{failed ? <span className="vis-tool-failures"> · {m.failedTools(format.number(failed))}</span> : null}{cancelled ? <span className="vis-tool-cancelled"> · {m.cancelledTools(format.number(cancelled))}</span> : null}</span>
        <Chevron />
      </summary>
      <div className="vis-tool-calls">
        {group.calls.map(pair => {
          const input = payload(pair.call).input
          const preview = JSON.stringify(input) ?? ''
          const result = payload(pair.result).text
          const pairState = status(pair, jobs)
          const job = generationJob(pair, jobs)
          return (
            <details key={pair.call?.itemId ?? pair.result?.itemId} className={`vis-tool-call is-${pairState}`} onToggle={onToggle}>
              <summary>
                <StatusIcon state={pairState} />
                <span className="vis-tool-name">{toolName(pair)}</span>
                {pairState === 'cancelled' ? <span className="vis-tool-cancelled">{m.cancelled}</span> : null}
                {preview ? <span className="vis-tool-preview">{preview.slice(0, 60)}{preview.length > 60 ? '…' : ''}</span> : null}
                <Chevron />
              </summary>
              {pair.call ? <pre>{JSON.stringify(input, null, 2)}</pre> : null}
              {pair.result ? <pre className="vis-tool-result">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre> : null}
              {pairState === 'cancelled' && job?.providerCancelled === false ? <p className="vis-tool-cancelled">{m.cancelledProvider}</p> : null}
            </details>
          )
        })}
      </div>
    </details>
  )
}
