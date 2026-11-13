import { promptRef, type NodeView, type ReferenceInputs } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { messages } from './messages'
import { promptMessages } from './prompt-messages'
import { canvasReferences, filterReferenceChoices, pickPromptReference, promptMention, PromptHistory, promptParts, type PromptReference, type PromptSelection, type PromptSnapshot } from './prompt-references'
import { ReferencePreview } from './ReferenceStrip'
import { nodeTitleNumbers } from './node-title'

export type PromptRefInputHandle = { insert(nodeId: string): void }

export function readPromptDom(root: Node): string {
  if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? ''
  if (root instanceof HTMLElement && root.dataset.promptTail) return ''
  if (root instanceof HTMLElement && root.dataset.promptRef) return promptRef(root.dataset.promptRef)
  // Clearing an editable surface leaves a placeholder BR; intentional newlines are stored in text nodes.
  if (root.nodeName === 'BR') return root.parentNode?.childNodes.length === 1 ? '' : '\n'
  return Array.from(root.childNodes).map(readPromptDom).join('')
}

function selectionIn(root: HTMLElement): PromptSelection | null {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const before = range.cloneRange()
  before.selectNodeContents(root)
  before.setEnd(range.startContainer, range.startOffset)
  const through = range.cloneRange()
  through.selectNodeContents(root)
  through.setEnd(range.endContainer, range.endOffset)
  return { start: readPromptDom(before.cloneContents()).length, end: readPromptDom(through.cloneContents()).length }
}

function restoreSelection(root: HTMLElement, selection: PromptSelection) {
  const point = (target: number): [Node, number] => {
    let offset = 0
    for (const node of root.childNodes) {
      const length = readPromptDom(node).length
      if (target <= offset + length) {
        if (node.nodeType === Node.TEXT_NODE) return [node, Math.max(0, target - offset)]
        const index = Array.prototype.indexOf.call(root.childNodes, node) as number
        return [root, index + (target > offset ? 1 : 0)]
      }
      offset += length
    }
    return [root, root.childNodes.length]
  }
  const range = document.createRange()
  range.setStart(...point(selection.start))
  range.setEnd(...point(selection.end))
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
}

export const PromptRefInput = forwardRef<PromptRefInputHandle, {
  value: string
  references: readonly PromptReference[]
  canvas?: { nodeId: string; nodes: readonly NodeView[]; limits?: ReferenceInputs | undefined; allKinds?: boolean; attach(nodeId: string): Promise<void> } | undefined
  assetUrl(id: string): string
  posterUrl(id: string): string
  placeholder: string
  readOnly: boolean
  onChange(value: string): void
  onCommit(): void
  onReset(): void
  onComposing(value: boolean): void
}>(function PromptRefInput({ value, references, canvas, assetUrl, posterUrl, placeholder, readOnly, onChange, onCommit, onReset, onComposing }, handle) {
  const m = useMessages(messages)
  const p = useMessages(promptMessages)
  const format = useFormat()
  const { locale } = useLocale()
  const root = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const cursor = useRef<PromptSelection>({ start: value.length, end: value.length })
  const history = useRef(new PromptHistory({ text: value, ...cursor.current }))
  const [choices, setChoices] = useState(false)
  const [mention, setMention] = useState<ReturnType<typeof promptMention>>(null)
  const [attaching, setAttaching] = useState(false)
  const picking = useRef(false)
  const [pending, setPending] = useState<{ before: string; next: PromptSnapshot; nodeId: string } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [choiceIndex, setChoiceIndex] = useState(0)
  const choicesId = useId()
  const available = references.filter(reference => reference.node && reference.number !== undefined)
  const titleNumbers = useMemo(() => nodeTitleNumbers(canvas?.nodes ?? []), [canvas?.nodes])
  const title = (node: NodeView) => node.title ?? p.referenceLabel(m[node.kind], format.number(titleNumbers.get(node.nodeId) ?? 1))
  const candidates = useMemo(() => canvas ? canvasReferences(canvas.nodeId, canvas.nodes, references, title, canvas.limits, canvas.allKinds) : [], [canvas?.nodeId, canvas?.nodes, references, canvas?.limits, canvas?.allKinds, titleNumbers, m, p, format])
  const filtered = filterReferenceChoices(references, candidates, mention?.query ?? '', title)
  const options = [...filtered.attached.map(reference => ({ reference, title: title(reference.node!), attached: true, reason: undefined as string | undefined })), ...filtered.canvas.map(candidate => ({
    ...candidate, attached: false, reason: candidate.limit ? candidate.limit.kind === 'total' ? p.referenceTotalLimit(format.number(candidate.limit.max)) : p.referenceKindLimit(m[candidate.limit.kind], format.number(candidate.limit.max)) : undefined,
  }))]
  const activeIndex = options.length ? choiceIndex % options.length : -1
  useLayoutEffect(() => {
    if (choices && activeIndex >= 0) document.getElementById(`${choicesId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }, [choices, choiceIndex, activeIndex, choicesId])
  const label = (reference: PromptReference) => p.referenceLabel(reference.node ? m[reference.node.kind] : p.brokenReference, format.number(reference.number!))
  const remember = () => {
    const selection = root.current && selectionIn(root.current)
    if (selection) {
      cursor.current = selection
      history.current.select(selection)
      if (choices && !picking.current) {
        const next = promptMention(readPromptDom(root.current!), selection)
        if (!next) setChoices(false)
        if (next?.query !== mention?.query) { setMention(next); setChoiceIndex(0) }
      }
    }
  }
  const draw = (text: string, selection?: PromptSelection) => {
    const editor = root.current
    if (!editor || composing.current) return
    const fragment = document.createDocumentFragment()
    for (const part of promptParts(text, references)) {
      if (part.type === 'text') fragment.append(document.createTextNode(part.text))
      else {
        const chip = document.createElement('span')
        const reference = part.reference
        chip.dataset.promptRef = part.nodeId
        chip.contentEditable = 'false'
        chip.className = `vis-prompt-ref${reference?.node ? '' : ' is-broken'}`
        const caption = reference?.node ? label(reference) : p.brokenReference
        chip.title = reference?.node ? caption : p.brokenReferenceHint
        const main = reference?.node?.slots.find(slot => slot.slotKey === 'main')
        if (main?.content.type === 'asset' && ['image', 'video'].includes(reference!.node!.kind)) {
          const assetVersionId = main.content.assetVersionId
          const thumbnail = document.createElement('img')
          thumbnail.alt = ''
          thumbnail.draggable = false
          if (reference!.node!.kind === 'video') {
            thumbnail.src = posterUrl(assetVersionId)
            thumbnail.onerror = () => {
              const video = document.createElement('video')
              video.src = assetUrl(assetVersionId)
              video.muted = true
              video.preload = 'metadata'
              thumbnail.replaceWith(video)
            }
          } else thumbnail.src = assetUrl(assetVersionId)
          chip.append(thumbnail)
        }
        const captionNode = document.createElement('span')
        captionNode.textContent = caption
        chip.append(captionNode)
        fragment.append(chip)
      }
    }
    // A final text node makes the position after an atomic chip reachable without storing a spacer.
    fragment.append(document.createTextNode(''))
    if (text.endsWith('\n')) {
      const tail = document.createElement('br')
      tail.dataset.promptTail = 'true'
      fragment.append(tail)
    }
    editor.replaceChildren(fragment)
    if (selection) restoreSelection(editor, selection)
  }
  useLayoutEffect(() => {
    if (composing.current || !root.current) return
    const focused = document.activeElement === root.current
    const selection = focused ? selectionIn(root.current) ?? cursor.current : undefined
    if (readPromptDom(root.current) !== value) history.current.record({ text: value, ...(selection ?? cursor.current) })
    draw(value, selection)
  }, [value, references, assetUrl, posterUrl, m, p, format])

  const apply = (snapshot: PromptSnapshot) => {
    cursor.current = snapshot
    draw(snapshot.text, snapshot)
    onChange(snapshot.text)
  }
  const insert = (nodeId: string) => {
    if (readOnly || composing.current || picking.current || !root.current || !available.some(reference => reference.nodeId === nodeId)) return
    const text = readPromptDom(root.current)
    const selection = selectionIn(root.current) ?? cursor.current
    history.current.select(selection)
    const start = (choices ? promptMention(text, selection)?.start : undefined) ?? selection.start
    const marker = promptRef(nodeId)
    const next = { text: text.slice(0, start) + marker + text.slice(selection.end), start: start + marker.length, end: start + marker.length }
    history.current.record(next)
    root.current.focus()
    apply(next)
    setChoices(false)
    setMention(null)
  }
  useImperativeHandle(handle, () => ({ insert }))
  useLayoutEffect(() => {
    if (!pending || !available.some(reference => reference.nodeId === pending.nodeId) || !root.current) return
    // The attach receipt can precede its canvas event. Wait for numbering before drawing the chip.
    if (readPromptDom(root.current) === pending.before) {
      history.current.record(pending.next)
      root.current.focus()
      apply(pending.next)
    }
    setPending(null)
    setAttaching(false)
    picking.current = false
    setChoices(false)
    setMention(null)
  }, [pending, references])
  const pick = (index: number) => {
    const option = options[index]
    if (!option || option.reason || readOnly || composing.current || picking.current || !root.current) return
    setError(null)
    if (option.attached) { insert(option.reference.nodeId); return }
    const before = readPromptDom(root.current)
    const selection = selectionIn(root.current) ?? cursor.current
    const start = promptMention(before, selection)?.start ?? selection.start
    const marker = promptRef(option.reference.nodeId)
    const next = { text: before.slice(0, start) + marker + before.slice(selection.end), start: start + marker.length, end: start + marker.length }
    history.current.select(selection)
    picking.current = true
    setAttaching(true)
    void pickPromptReference(option.reference.nodeId, false, id => canvas!.attach(id), () => {
      if (root.current) setPending({ before, next, nodeId: option.reference.nodeId })
    }).catch(error => {
      picking.current = false
      setAttaching(false)
      setError(error)
    })
  }
  const updateChoices = (text: string, selection: PromptSelection) => {
    const next = promptMention(text, selection)
    setMention(next)
    setChoices(Boolean(next) && (available.length > 0 || candidates.length > 0))
    setChoiceIndex(0)
    setError(null)
  }
  const input = () => {
    if (!root.current || composing.current || picking.current) return
    const text = readPromptDom(root.current)
    const selection = selectionIn(root.current) ?? { start: text.length, end: text.length }
    history.current.record({ text, ...selection })
    cursor.current = selection
    draw(text, selection)
    onChange(text)
    updateChoices(text, selection)
  }
  const insertText = (text: string) => {
    if (!root.current || readOnly || composing.current || picking.current) return
    const current = readPromptDom(root.current)
    const selection = selectionIn(root.current) ?? cursor.current
    history.current.select(selection)
    const next = { text: current.slice(0, selection.start) + text + current.slice(selection.end), start: selection.start + text.length, end: selection.start + text.length }
    history.current.record(next)
    apply(next)
    updateChoices(next.text, next)
  }
  return <div className="vis-prompt-ref-field">
    <div ref={root} role="textbox" aria-label={m.prompt} aria-multiline="true" aria-readonly={readOnly || attaching} aria-busy={attaching} aria-haspopup="listbox" aria-autocomplete="list" aria-expanded={choices}
      aria-controls={choices ? choicesId : undefined} aria-activedescendant={choices && activeIndex >= 0 ? `${choicesId}-${activeIndex}` : undefined}
      className="vis-prompt-ref-input nodrag nopan nowheel" contentEditable={!readOnly} suppressContentEditableWarning data-placeholder={placeholder}
      onInput={input} onSelect={remember} onKeyUp={remember} onPointerUp={remember}
      onBlur={() => { remember(); setChoices(false); if (!composing.current && !picking.current) onCommit() }}
      onCompositionStart={() => { if (readOnly || picking.current) return; remember(); composing.current = true; onComposing(true); setChoices(false) }}
      onCompositionEnd={() => { composing.current = false; input(); onComposing(false) }}
      onBeforeInput={event => {
        const type = (event.nativeEvent as InputEvent).inputType
        if (readOnly || picking.current) { event.preventDefault(); return }
        if (composing.current) return
        remember()
        if (type === 'insertParagraph' || type === 'insertLineBreak') { event.preventDefault(); insertText('\n') }
        if (type === 'historyUndo' || type === 'historyRedo') {
          event.preventDefault()
          const snapshot = type === 'historyUndo' ? history.current.undo() : history.current.redo()
          if (snapshot) apply(snapshot)
        }
      }}
      onCopy={event => {
        const selection = root.current && selectionIn(root.current)
        if (!selection || selection.start === selection.end) return
        event.preventDefault()
        event.clipboardData.setData('text/plain', readPromptDom(root.current!).slice(selection.start, selection.end))
      }}
      onCut={event => {
        const selection = root.current && selectionIn(root.current)
        if (!selection || selection.start === selection.end || readOnly || composing.current) return
        event.preventDefault()
        event.clipboardData.setData('text/plain', readPromptDom(root.current!).slice(selection.start, selection.end))
        insertText('')
      }}
      onPaste={event => { event.preventDefault(); if (!readOnly && !composing.current) insertText(event.clipboardData.getData('text/plain')) }}
      onDrop={event => event.preventDefault()}
      onKeyDown={event => {
        event.stopPropagation()
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
        if (readOnly || attaching) {
          if (event.key === 'Enter' || event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase()))) event.preventDefault()
          return
        }
        if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
          event.preventDefault()
          const redo = event.key.toLowerCase() === 'y' || event.shiftKey
          const snapshot = redo ? history.current.redo() : history.current.undo()
          if (snapshot) apply(snapshot)
          setChoices(false)
          return
        }
        if (choices && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
          event.preventDefault()
          if (event.key === 'Escape') setChoices(false)
          else if (event.key === 'Enter') pick(activeIndex)
          else if (options.length) setChoiceIndex(index => (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          if (event.metaKey || event.ctrlKey) onCommit()
          else insertText('\n')
        }
        if (event.key === 'Escape') onReset()
      }}
    />
    {choices ? <div id={choicesId} className="vis-prompt-ref-choices" role="listbox" aria-label={p.referenceChoices} aria-busy={attaching}>
      {filtered.hasMore ? <div className="vis-reference-choice-hint" role="status">{p.typeToNarrow}</div> : null}
      {([true, false] as const).map(attached => {
        const group = options.flatMap((option, index) => option.attached === attached ? [{ option, index }] : [])
        if (!group.length) return null
        const groupId = `${choicesId}-${attached ? 'attached' : 'canvas'}`
        return <div key={groupId} role="group" aria-labelledby={groupId}>
          <div id={groupId} className="vis-reference-choice-heading">{attached ? p.attachedReferences : p.onCanvas}</div>
          {group.map(({ option, index }) => <button type="button" tabIndex={-1} id={`${choicesId}-${index}`} key={option.reference.nodeId} role="option" className={index === activeIndex ? 'is-active' : undefined} aria-selected={index === activeIndex && !option.reason && !attaching} aria-disabled={Boolean(option.reason) || attaching}
            aria-label={attached ? label(option.reference) : option.title} aria-describedby={option.reason ? `${choicesId}-${index}-reason` : undefined}
            onMouseDown={event => event.preventDefault()} onClick={() => pick(index)}>
            <span className="vis-reference-choice-preview"><ReferencePreview reference={option.reference} assetUrl={assetUrl} posterUrl={posterUrl} /></span>
            <span className="vis-reference-choice-caption"><span>{attached ? label(option.reference) : option.title}</span>{attached ? <small>{option.title}</small> : null}
              {option.reason ? <small id={`${choicesId}-${index}-reason`}>{option.reason}</small> : null}</span>
          </button>)}
        </div>
      })}
      {!options.length ? <div role="status">{p.noReferenceMatches}</div> : null}
    </div> : null}
    {error ? <div className="vis-prompt-broken" role="status">{describeError(error, locale)}</div> : null}
  </div>
})
