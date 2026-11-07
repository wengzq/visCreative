import { Decoration, WidgetType, type DecorationSet } from '@codemirror/view'
import { textEditAnchor, type TextEditRef, type TextProposal } from '@vis/protocol'

export type ReviewEdit = TextEditRef & { edit: TextProposal['edits'][number]; summary: string; number: number }
export const reviewEdits = (proposals: readonly TextProposal[]): ReviewEdit[] => proposals.flatMap(proposal => proposal.edits
  .filter(edit => edit.status === 'pending' || edit.status === 'stale')
  .map(edit => ({ proposalId: proposal.proposalId, editId: edit.editId, edit, summary: proposal.summary })))
  .map((edit, index) => ({ ...edit, number: index + 1 }))

type ReviewLabels = { accept: string; reject: string; stale: string; label(number: number, summary: string): string; acceptEdit(number: number): string; rejectEdit(number: number): string }
class ReviewWidget extends WidgetType {
  constructor(readonly item: ReviewEdit, readonly stale: boolean, readonly missing: boolean, readonly disabled: boolean, readonly labels: ReviewLabels, readonly resolve: (action: 'accept' | 'reject', edits: ReviewEdit[]) => void) { super() }
  toDOM() {
    const box = document.createElement('span')
    box.className = `vis-writing-edit${this.stale ? ' is-stale' : ''}`
    box.setAttribute('role', 'group')
    box.setAttribute('aria-label', this.labels.label(this.item.number, this.item.summary))
    if (this.missing) {
      const old = document.createElement('del'); old.textContent = this.item.edit.find; box.append(old)
    }
    const text = document.createElement('ins'); text.textContent = this.item.edit.replace; box.append(text)
    box.title = this.item.summary
    if (this.stale) {
      const note = document.createElement('span'); note.className = 'vis-writing-edit-note'; note.textContent = this.labels.stale; box.append(note)
    }
    for (const action of ['accept', 'reject'] as const) {
      const button = document.createElement('button')
      button.type = 'button'; button.textContent = this.labels[action]
      button.setAttribute('aria-label', action === 'accept' ? this.labels.acceptEdit(this.item.number) : this.labels.rejectEdit(this.item.number))
      button.disabled = this.disabled || (action === 'accept' && this.stale)
      button.addEventListener('click', () => this.resolve(action, [this.item]))
      box.append(button)
    }
    return box
  }
  ignoreEvent() { return true }
}

export function reviewDecorations(body: string, edits: ReviewEdit[], disabled: boolean, labels: ReviewLabels, resolve: (action: 'accept' | 'reject', edits: ReviewEdit[]) => void): DecorationSet {
  const ranges = []
  for (const item of edits) {
    const range = textEditAnchor(body, item.edit)
    const stale = item.edit.status === 'stale' || !range
    if (range) ranges.push(Decoration.mark({ class: stale ? 'vis-writing-old is-stale' : 'vis-writing-old' }).range(range.from, range.to))
    ranges.push(Decoration.widget({ widget: new ReviewWidget(item, stale, !range, disabled, labels, resolve), side: 1 }).range(range?.to ?? body.length))
  }
  return Decoration.set(ranges, true)
}
