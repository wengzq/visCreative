import { promptRef } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { messages } from './messages'
import { promptMessages } from './prompt-messages'
import { PromptHistory, promptParts, type PromptReference, type PromptSelection, type PromptSnapshot } from './prompt-references'
import { ReferencePreview } from './ReferenceStrip'

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
  assetUrl(id: string): string
  posterUrl(id: string): string
  placeholder: string
  readOnly: boolean
  onChange(value: string): void
  onCommit(): void
  onReset(): void
  onComposing(value: boolean): void
}>(function PromptRefInput({ value, references, assetUrl, posterUrl, placeholder, readOnly, onChange, onCommit, onReset, onComposing }, handle) {
  const m = useMessages(messages)
  const p = useMessages(promptMessages)
  const format = useFormat()
  const root = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const cursor = useRef<PromptSelection>({ start: value.length, end: value.length })
  const history = useRef(new PromptHistory({ text: value, ...cursor.current }))
  const [choices, setChoices] = useState(false)
  const [choiceIndex, setChoiceIndex] = useState(0)
  const choicesId = useId()
  const available = references.filter(reference => reference.node && reference.number !== undefined)
  const label = (reference: PromptReference) => p.referenceLabel(reference.node ? m[reference.node.kind] : p.brokenReference, format.number(reference.number!))
  const remember = () => {
    const selection = root.current && selectionIn(root.current)
    if (selection) { cursor.current = selection; history.current.select(selection) }
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
    if (readOnly || composing.current || !root.current || !available.some(reference => reference.nodeId === nodeId)) return
    const text = readPromptDom(root.current)
    const selection = selectionIn(root.current) ?? cursor.current
    history.current.select(selection)
    const start = choices && text[selection.start - 1] === '@' ? selection.start - 1 : selection.start
    const marker = promptRef(nodeId)
    const next = { text: text.slice(0, start) + marker + text.slice(selection.end), start: start + marker.length, end: start + marker.length }
    history.current.record(next)
    root.current.focus()
    apply(next)
    setChoices(false)
  }
  useImperativeHandle(handle, () => ({ insert }))
  const input = () => {
    if (!root.current || composing.current) return
    const text = readPromptDom(root.current)
    const selection = selectionIn(root.current) ?? { start: text.length, end: text.length }
    history.current.record({ text, ...selection })
    cursor.current = selection
    draw(text, selection)
    onChange(text)
    setChoices(text[selection.start - 1] === '@' && available.length > 0)
    setChoiceIndex(0)
  }
  const insertText = (text: string) => {
    if (!root.current || readOnly || composing.current) return
    const current = readPromptDom(root.current)
    const selection = selectionIn(root.current) ?? cursor.current
    history.current.select(selection)
    const next = { text: current.slice(0, selection.start) + text + current.slice(selection.end), start: selection.start + text.length, end: selection.start + text.length }
    history.current.record(next)
    apply(next)
    setChoices(text.endsWith('@') && available.length > 0)
    setChoiceIndex(0)
  }
  return <div className="vis-prompt-ref-field">
    <div ref={root} role="textbox" aria-label={m.prompt} aria-multiline="true" aria-readonly={readOnly} aria-haspopup="listbox" aria-autocomplete="list" aria-expanded={choices && available.length > 0}
      aria-controls={choices && available.length ? choicesId : undefined} aria-activedescendant={choices && available.length ? `${choicesId}-${choiceIndex % available.length}` : undefined}
      className="vis-prompt-ref-input nodrag nopan nowheel" contentEditable={!readOnly} suppressContentEditableWarning data-placeholder={placeholder}
      onInput={input} onSelect={remember} onKeyUp={remember} onPointerUp={remember}
      onBlur={() => { remember(); setChoices(false); if (!composing.current) onCommit() }}
      onCompositionStart={() => { remember(); composing.current = true; onComposing(true); setChoices(false) }}
      onCompositionEnd={() => { composing.current = false; input(); onComposing(false) }}
      onBeforeInput={event => {
        const type = (event.nativeEvent as InputEvent).inputType
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
        if (readOnly) {
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
        if (choices && available.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
          event.preventDefault()
          if (event.key === 'Escape') setChoices(false)
          else if (event.key === 'Enter') { const reference = available[choiceIndex % available.length]; if (reference) insert(reference.nodeId) }
          else setChoiceIndex(index => (index + (event.key === 'ArrowDown' ? 1 : available.length - 1)) % available.length)
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
    {choices && available.length ? <div id={choicesId} className="vis-prompt-ref-choices" role="listbox" aria-label={p.referenceChoices}>
      {available.map((reference, index) => <button id={`${choicesId}-${index}`} key={reference.nodeId} role="option" aria-selected={index === choiceIndex % available.length} aria-label={label(reference)} onMouseDown={event => event.preventDefault()} onClick={() => insert(reference.nodeId)}>
        <span className="vis-reference-choice-preview"><ReferencePreview reference={reference} assetUrl={assetUrl} posterUrl={posterUrl} /></span>{label(reference)}
      </button>)}
    </div> : null}
  </div>
})
