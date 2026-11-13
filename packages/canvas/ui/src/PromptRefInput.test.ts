import type { NodeView } from '@vis/protocol'
import { promptRef } from '@vis/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PromptRefInput } from './PromptRefInput'

const hooks = vi.hoisted(() => ({ refs: [] as { current: unknown }[], effects: [] as (() => void)[] }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  forwardRef: (render: unknown) => render,
  useRef: (current: unknown) => { const ref = { current }; hooks.refs.push(ref); return ref },
  useState: (initial: unknown) => [initial, vi.fn()],
  useMemo: (factory: () => unknown) => factory(),
  useId: () => 'choices',
  useImperativeHandle() {},
  useLayoutEffect: (effect: () => void) => { hooks.effects.push(effect) },
}))
vi.mock('@vis/ui-kit', async importOriginal => ({
  ...await importOriginal<typeof import('@vis/ui-kit')>(),
  useMessages: (dictionary: { en: unknown }) => dictionary.en,
  useFormat: () => ({ number: String }),
  useLocale: () => ({ locale: 'en' }),
}))

class DomNode {
  childNodes: DomNode[] = []
  parentNode: DomNode | null = null
  dataset: Record<string, string> = {}
  nodeType = 1
  textContent = ''
  src = ''
  alt = ''
  draggable = true
  muted = false
  preload = ''
  onerror: (() => void) | null = null
  constructor(readonly nodeName: string) {}
  append(...nodes: DomNode[]) {
    for (const node of nodes) { node.parentNode = this; this.childNodes.push(node) }
  }
  replaceChildren(fragment: DomNode) {
    this.childNodes = []
    this.append(...fragment.childNodes)
  }
  replaceWith(node: DomNode) {
    if (!this.parentNode) return
    const index = this.parentNode.childNodes.indexOf(this)
    node.parentNode = this.parentNode
    this.parentNode.childNodes[index] = node
    this.parentNode = null
  }
}

beforeEach(() => { hooks.refs = []; hooks.effects = [] })
afterEach(() => vi.unstubAllGlobals())

function draw(kind: 'image' | 'video') {
  const editor = new DomNode('DIV')
  const createElement = vi.fn((name: string) => new DomNode(name.toUpperCase()))
  vi.stubGlobal('Node', { TEXT_NODE: 3 })
  vi.stubGlobal('HTMLElement', DomNode)
  vi.stubGlobal('document', {
    activeElement: null,
    createElement,
    createDocumentFragment: () => new DomNode('#document-fragment'),
    createTextNode: (text: string) => Object.assign(new DomNode('#text'), { nodeType: 3, textContent: text }),
  })
  PromptRefInput({
    value: promptRef('node'),
    references: [{ nodeId: 'node', number: 1, node: { kind, slots: [{ slotKey: 'main', content: { type: 'asset', assetVersionId: 'asset' } }] } as NodeView }],
    assetUrl: id => `/assets/${id}`, posterUrl: id => `/posters/${id}`,
    placeholder: '', readOnly: false, onChange() {}, onCommit() {}, onReset() {}, onComposing() {},
  })
  hooks.refs[0]!.current = editor
  for (const effect of hooks.effects) effect()
  return { chip: editor.childNodes[0]!, createElement }
}

it('creates no video decoder for a prompt chip until its poster fails', () => {
  const { chip, createElement } = draw('video')
  const thumbnail = chip.childNodes[0]!
  expect(thumbnail).toMatchObject({ nodeName: 'IMG', src: '/posters/asset', alt: '', draggable: false })
  expect(createElement).not.toHaveBeenCalledWith('video')
  thumbnail.onerror!()
  expect(chip.childNodes[0]).toMatchObject({ nodeName: 'VIDEO', src: '/assets/asset', muted: true, preload: 'metadata' })
})

it('keeps image prompt chips on their original asset URL without a video fallback', () => {
  const { chip } = draw('image')
  expect(chip.childNodes[0]).toMatchObject({ nodeName: 'IMG', src: '/assets/asset', onerror: null })
})
