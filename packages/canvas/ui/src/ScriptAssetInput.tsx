import { assetRef, SCRIPT_LIMITS, type ScriptAsset } from '@vis/protocol'
import { useMessages } from '@vis/ui-kit'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { PromptHistory, type PromptSelection } from './prompt-references'
import { assetParts } from './script-table'
import { scriptMessages } from './script-messages'

export function readAssetDom(root: Node): string {
  if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? ''
  if (root instanceof HTMLElement && root.dataset.assetTail) return ''
  if (root instanceof HTMLElement && root.dataset.scriptAsset) return assetRef(root.dataset.scriptAsset)
  if (root.nodeName === 'BR') return root.parentNode?.childNodes.length === 1 ? '' : '\n'
  return Array.from(root.childNodes).map(readAssetDom).join('')
}

function selectionIn(root: HTMLElement): PromptSelection | null {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const before = range.cloneRange()
  before.selectNodeContents(root)
  before.setEnd(range.startContainer, range.startOffset)
  const through = before.cloneRange()
  through.setEnd(range.endContainer, range.endOffset)
  return { start: readAssetDom(before.cloneContents()).length, end: readAssetDom(through.cloneContents()).length }
}

function restoreSelection(root: HTMLElement, selection: PromptSelection) {
  const point = (target: number): [Node, number] => {
    let offset = 0
    for (const node of root.childNodes) {
      const length = readAssetDom(node).length
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

export function AssetText({ text, assets }: { text: string; assets: readonly ScriptAsset[] }) {
  const m = useMessages(scriptMessages)
  return <>{assetParts(text, assets).map((part, index) => part.type === 'text' ? part.text : <span key={index} className={`vis-script-asset-chip${part.asset ? '' : ' is-broken'}`} title={part.asset?.name ?? m.deletedAsset}>{part.asset?.name ?? m.deletedAsset}</span>)}</>
}

/** Atomic chips use the same marker-based cursor and local history model as PromptRefInput. */
export function ScriptAssetInput({ value, assets, label, disabled, onChange, onCommit, onCancel }: {
  value: string
  assets: readonly ScriptAsset[]
  label: string
  disabled: boolean
  onChange(value: string): void
  onCommit(direction?: number): void
  onCancel(): void
}) {
  const m = useMessages(scriptMessages)
  const root = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const cursor = useRef<PromptSelection>({ start: value.length, end: value.length })
  const history = useRef(new PromptHistory({ text: value, ...cursor.current }))
  const [choices, setChoices] = useState(false)
  const [choiceIndex, setChoiceIndex] = useState(0)
  const choicesId = useId()
  const hintId = useId()
  const remember = () => {
    const selection = root.current && selectionIn(root.current)
    if (selection) { cursor.current = selection; history.current.select(selection) }
  }
  const draw = (text: string, selection?: PromptSelection) => {
    const editor = root.current
    if (!editor || composing.current) return
    const fragment = document.createDocumentFragment()
    for (const part of assetParts(text, assets)) {
      if (part.type === 'text') fragment.append(document.createTextNode(part.text))
      else {
        const chip = document.createElement('span')
        chip.dataset.scriptAsset = part.id
        chip.contentEditable = 'false'
        chip.className = `vis-script-asset-chip${part.asset ? '' : ' is-broken'}`
        chip.textContent = part.asset?.name ?? m.deletedAsset
        fragment.append(chip)
      }
    }
    fragment.append(document.createTextNode(''))
    if (text.endsWith('\n')) {
      const tail = document.createElement('br')
      tail.dataset.assetTail = 'true'
      fragment.append(tail)
    }
    editor.replaceChildren(fragment)
    if (selection) restoreSelection(editor, selection)
  }
  useLayoutEffect(() => {
    root.current?.focus()
    draw(value, cursor.current)
  }, [])
  useLayoutEffect(() => {
    if (!composing.current) draw(value, root.current === document.activeElement ? selectionIn(root.current!) ?? cursor.current : undefined)
  }, [value, assets, m])
  const apply = (text: string, selection: PromptSelection) => {
    if (text.length > SCRIPT_LIMITS.cell) return
    history.current.record({ text, ...selection })
    cursor.current = selection
    draw(text, selection)
    onChange(text)
  }
  const insert = (text: string, replaceAt = false) => {
    if (!root.current || disabled || composing.current) return
    const current = readAssetDom(root.current)
    const selection = selectionIn(root.current) ?? cursor.current
    history.current.select(selection)
    const start = replaceAt && current[selection.start - 1] === '@' ? selection.start - 1 : selection.start
    const next = current.slice(0, start) + text + current.slice(selection.end)
    root.current.focus()
    apply(next, { start: start + text.length, end: start + text.length })
    setChoices(false)
  }
  const input = () => {
    if (!root.current || composing.current) return
    const text = readAssetDom(root.current)
    const selection = selectionIn(root.current) ?? { start: text.length, end: text.length }
    if (text.length > SCRIPT_LIMITS.cell) { draw(value, cursor.current); return }
    apply(text, selection)
    setChoices(text[selection.start - 1] === '@' && assets.length > 0)
    setChoiceIndex(0)
  }
  return <div className="vis-script-asset-field">
    <div ref={root} role="textbox" aria-label={label} aria-multiline="true" aria-readonly={disabled} aria-describedby={hintId}
      aria-haspopup="listbox" aria-autocomplete="list" aria-expanded={choices} aria-controls={choices ? choicesId : undefined}
      aria-activedescendant={choices && assets.length ? `${choicesId}-${choiceIndex % assets.length}` : undefined}
      contentEditable={!disabled} suppressContentEditableWarning className="vis-script-cell-input"
      onInput={input} onKeyUp={remember} onPointerUp={remember}
      onBlur={() => { remember(); setChoices(false); if (!composing.current) onCommit() }}
      onCompositionStart={() => { remember(); composing.current = true; setChoices(false) }}
      onCompositionEnd={() => { composing.current = false; input() }}
      onBeforeInput={event => {
        if (composing.current) return
        remember()
        const type = (event.nativeEvent as InputEvent).inputType
        if (type === 'insertParagraph' || type === 'insertLineBreak') { event.preventDefault(); insert('\n') }
      }}
      onCopy={event => {
        const selection = root.current && selectionIn(root.current)
        if (!selection || selection.start === selection.end) return
        event.preventDefault()
        event.clipboardData.setData('text/plain', readAssetDom(root.current!).slice(selection.start, selection.end))
      }}
      onCut={event => {
        const selection = root.current && selectionIn(root.current)
        if (!selection || selection.start === selection.end || disabled || composing.current) return
        event.preventDefault()
        event.clipboardData.setData('text/plain', readAssetDom(root.current!).slice(selection.start, selection.end))
        insert('')
      }}
      onPaste={event => { event.preventDefault(); insert(event.clipboardData.getData('text/plain')) }}
      onDrop={event => event.preventDefault()}
      onKeyDown={event => {
        event.stopPropagation()
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
        if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
          event.preventDefault()
          const redo = event.key.toLowerCase() === 'y' || event.shiftKey
          const snapshot = redo ? history.current.redo() : history.current.undo()
          if (snapshot) { cursor.current = snapshot; draw(snapshot.text, snapshot); onChange(snapshot.text) }
          return
        }
        if (choices && assets.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
          event.preventDefault()
          if (event.key === 'Escape') setChoices(false)
          else if (event.key === 'Enter') insert(assetRef(assets[choiceIndex % assets.length]!.id), true)
          else setChoiceIndex(index => (index + (event.key === 'ArrowDown' ? 1 : assets.length - 1)) % assets.length)
          return
        }
        if (event.key === 'Enter') { event.preventDefault(); if (event.shiftKey) insert('\n'); else onCommit() }
        if (event.key === 'Escape') { event.preventDefault(); onCancel() }
        if (event.key === 'Tab') { event.preventDefault(); onCommit(event.shiftKey ? -1 : 1) }
      }} />
    <span id={hintId} className="vis-script-cell-hint">{m.textHint}</span>
    {choices && assets.length ? <div id={choicesId} className="vis-script-asset-choices" role="listbox" aria-label={m.assetChoices}>
      {assets.map((asset, index) => <button key={asset.id} id={`${choicesId}-${index}`} role="option" aria-selected={index === choiceIndex % assets.length}
        onMouseDown={event => event.preventDefault()} onClick={() => insert(assetRef(asset.id), true)}>{asset.name}</button>)}
    </div> : null}
  </div>
}
