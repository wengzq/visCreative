import { Decoration } from '@codemirror/view'
import { textEditAnchor } from '@vis/protocol'

export type PassageShot = { scriptNodeId: string; shotId: string; quote: string; label: string }

export function sourceDecorations(body: string, shots: readonly PassageShot[], quote: string | undefined) {
  const ranges = []
  const passage = quote ? textEditAnchor(body, { find: quote }) : null
  if (passage) ranges.push(Decoration.mark({ class: 'vis-writing-source-highlight' }).range(passage.from, passage.to))
  for (const shot of shots) {
    const range = textEditAnchor(body, { find: shot.quote })
    if (!range) continue
    ranges.push(Decoration.mark({ class: 'vis-writing-shot-passage' }).range(range.from, range.to))
  }
  return Decoration.set(ranges, true)
}
