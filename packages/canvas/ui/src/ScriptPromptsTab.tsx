import { useFormat, useMessages } from '@vis/ui-kit'
import type { ScriptPartProps } from './script-ui'
import { ScriptAgentBar } from './scriptParts'
import { ScriptCell } from './ScriptCell'
import { updateShot } from './script-table'
import { scriptMessages } from './script-messages'

export function ScriptPromptsTab({ parts, disabled, selected, onSelection }: {
  parts: ScriptPartProps
  disabled: boolean
  selected: ReadonlySet<string>
  onSelection(ids: Set<string>): void
}) {
  const m = useMessages(scriptMessages)
  const format = useFormat()
  return <div className="vis-script-prompts">
    <div className="vis-script-prompts-toolbar">
      <label><input type="checkbox" aria-label={m.selectAll} checked={parts.doc.shots.length > 0 && parts.doc.shots.every(shot => selected.has(shot.id))}
        onChange={event => onSelection(event.target.checked ? new Set(parts.doc.shots.map(shot => shot.id)) : new Set())} />{m.selected(format.number(selected.size))}</label>
      <ScriptAgentBar {...parts} tasks={['prompts']} showOwner={false} {...(selected.size ? { shotIds: [...selected] } : {})} />
    </div>
    <div className="vis-script-prompts-list nowheel">
      {parts.doc.shots.map((shot, index) => <section className="vis-script-prompt-row" key={shot.id} aria-label={m.shot(format.number(index + 1))}>
        <header><label><input type="checkbox" aria-label={m.selectShot(format.number(index + 1))} checked={selected.has(shot.id)} onChange={() => {
          const next = new Set(selected)
          if (next.has(shot.id)) next.delete(shot.id)
          else next.add(shot.id)
          onSelection(next)
        }} />{m.shot(format.number(index + 1))}</label><span role="status" aria-label={m.promptState} className={`vis-script-prompt-state${shot.promptState ? ` is-${shot.promptState}` : ''}`}>{shot.promptState ? m[shot.promptState] : m.noPromptState}</span></header>
        <div className="vis-script-prompt-fields">
          {(['framePrompt', ...(shot.endState ? ['endFramePrompt' as const] : []), 'videoPrompt'] as const).map(field => <div key={field}>
            <span className="vis-script-field-label">{m[field]}</span>
            <ScriptCell value={shot[field] ?? ''} rev={shot.rev} assets={parts.doc.assets} label={m.cell(format.number(index + 1), m[field])} disabled={disabled}
              onSave={(value, rev) => parts.onPatch(updateShot({ ...shot, rev }, { [field]: value || null }))} />
          </div>)}
        </div>
      </section>)}
      {!parts.doc.shots.length ? <p className="vis-script-empty">{m.empty}</p> : null}
    </div>
  </div>
}
