import type { ScriptAsset } from '@vis/protocol'
import { useLayoutEffect, useRef, useState } from 'react'
import { AssetText, ScriptAssetInput } from './ScriptAssetInput'
import { conflictRows } from './script-table'

export function ScriptCell({ value, rev, assets, label, disabled, onSave }: {
  value: string
  rev: number
  assets: readonly ScriptAsset[]
  label: string
  disabled: boolean
  onSave(value: string, rev: number): Promise<void>
}) {
  const [draft, setDraft] = useState<{ text: string; rev: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const finishing = useRef(false)
  const focusRequest = useRef<number | null>(null)
  const focus = (direction = 0) => { focusRequest.current = direction }
  useLayoutEffect(() => {
    if (draft || disabled || !root.current || focusRequest.current === null) return
    const direction = focusRequest.current
    const cells = [...(root.current.closest('[role=tabpanel]')?.querySelectorAll<HTMLElement>('[data-script-cell]') ?? [])]
      .filter(cell => cell === root.current || cell.querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled)'))
    const target = direction ? cells[cells.indexOf(root.current) + direction] : root.current
    target?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')?.focus()
    focusRequest.current = null
  }, [draft, disabled])
  const commit = (direction?: number) => {
    if (!draft || finishing.current) return
    finishing.current = true
    setSaving(true)
    // Keep the revision from edit start, even if an Agent delivered a new row while the user was typing.
    const finish = () => {
      setDraft(null)
      if (direction !== undefined || root.current?.contains(document.activeElement)) focus(direction)
    }
    void onSave(draft.text, draft.rev).then(finish, error => {
      // Conflicts show the current row; the host notice keeps a copy of the rejected text.
      if (conflictRows(error)) finish()
      else setDraft({ ...draft })
    }).finally(() => { finishing.current = false; setSaving(false) })
  }
  return <div ref={root} data-script-cell className={`vis-script-cell${draft ? ' is-editing' : ''}`}>
    {draft ? <ScriptAssetInput value={draft.text} assets={assets} label={label} disabled={disabled || saving}
      onChange={text => setDraft(current => current ? { ...current, text } : null)} onCommit={commit}
      onCancel={() => { finishing.current = true; setDraft(null); focus(); requestAnimationFrame(() => { finishing.current = false }) }} />
      : <button className="vis-script-cell-value" aria-label={label} disabled={disabled} onClick={() => { finishing.current = false; setDraft({ text: value, rev }) }}><span><AssetText text={value} assets={assets} /></span></button>}
  </div>
}
