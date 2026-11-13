import { promptRef, type NodeView } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { canvasReferences, filterReferenceChoices, hasBrokenReferences, numberedReferences, pickPromptReference, promptMention, PromptHistory, promptParts, promptText } from './prompt-references'
import { parameterSummary } from './params'

const node = (nodeId: string, kind: NodeView['kind'] = 'image'): NodeView => ({
  nodeId, kind, x: 0, y: 0, w: 100, h: 100, z: 0, layoutRevision: 0,
  slots: kind === 'text' || kind === 'frame' ? [] : [{ slotId: nodeId, slotKey: 'main', revision: 1, contentType: kind, content: { type: 'asset', assetVersionId: nodeId, mime: `${kind}/test` } }],
})
const nodes = [node('a'), node('b', 'video'), node('c', 'audio')]

describe('Prompt references', () => {
  it('round-trips whitespace, Unicode, repeated markers and incomplete marker text exactly', () => {
    const body = `  A\n${promptRef('b')} + ${promptRef('b')}\n${promptRef('c')} {{ref:}}\n  \u7b2c\u4e00\u955c\t`
    const parts = promptParts(body, numberedReferences(['b', 'c'], nodes))
    expect(parts.filter(part => part.type === 'reference').map(part => part.nodeId)).toEqual(['b', 'b', 'c'])
    expect(promptText(parts)).toBe(body)
    expect(promptText(promptParts('', []))).toBe('')
    expect(promptText(promptParts('{{ref:unfinished', []))).toBe('{{ref:unfinished')
  })

  it('computes chip numbers from input order after reorder and unrelated removal without rewriting markers', () => {
    const body = promptRef('b')
    const mixedNodes = [...nodes, node('d', 'video')]
    const number = (inputs: string[]) => promptParts(body, numberedReferences(inputs, mixedNodes)).map(part => part.type === 'reference' ? part.reference?.number : null)
    expect(number(['a', 'd', 'b', 'c'])).toEqual([2])
    expect(number(['c', 'b', 'd', 'a'])).toEqual([1])
    expect(number(['d', 'b', 'c'])).toEqual([2])
    expect(promptText(promptParts(body, numberedReferences(['c', 'b'], mixedNodes)))).toBe(body)
  })

  it('detects removed references and missing nodes without numbering them', () => {
    expect(hasBrokenReferences(promptRef('b'), numberedReferences(['a', 'b'], nodes))).toBe(false)
    expect(hasBrokenReferences(promptRef('b'), numberedReferences(['a'], nodes))).toBe(true)
    const references = numberedReferences(['missing', 'b'], nodes)
    expect(references[1]?.number).toBe(1)
    expect(hasBrokenReferences(promptRef('missing'), references)).toBe(true)
    expect(hasBrokenReferences('No references', [])).toBe(false)
  })

  it('numbers only unique media inputs with assets and treats text and empty markers as broken', () => {
    const references = numberedReferences(['text', 'empty', 'b', 'b', 'a'], [
      ...nodes, node('text', 'text'), { ...node('empty'), slots: [] },
    ])
    expect(references.map(reference => [reference.nodeId, reference.number])).toEqual([
      ['text', undefined], ['empty', undefined], ['b', 1], ['a', 1],
    ])
    expect(hasBrokenReferences(promptRef('text'), references)).toBe(true)
    expect(hasBrokenReferences(promptRef('empty'), references)).toBe(true)
  })

  it('keeps cursor positions and marker insertion in undo and redo, clearing redo after a new edit', () => {
    const history = new PromptHistory({ text: 'abc', start: 3, end: 3 })
    history.select({ start: 1, end: 2 })
    history.record({ text: `a${promptRef('b')}c`, start: 10, end: 10 })
    expect(history.undo()).toEqual({ text: 'abc', start: 1, end: 2 })
    expect(history.redo()?.text).toBe(`a${promptRef('b')}c`)
    history.undo()
    history.record({ text: 'ac', start: 1, end: 1 })
    expect(history.redo()).toBeUndefined()
    expect(history.undo()?.text).toBe('abc')
    expect(history.undo()).toBeUndefined()
  })
})

describe('Canvas prompt reference choices', () => {
  const title = (node: NodeView) => node.title ?? node.nodeId
  const limits = { image: 1, video: { max: 1, minMs: 1, maxMs: 30000, totalMs: 30000 } }
  it('excludes the edited node, attached and missing inputs, non-media and empty media while retaining hidden working sources', () => {
    const all = [node('target'), ...nodes, node('text', 'text'), node('frame', 'frame'), { ...node('empty'), slots: [] }, { ...node('hidden', 'video'), purpose: 'working' as const }]
    const attached = numberedReferences(['a', 'deleted'], all)
    const choices = canvasReferences('target', all, attached, title, limits)
    expect(choices.map(choice => choice.reference.nodeId)).toEqual(['b', 'hidden'])
    expect(choices.map(choice => choice.reference.number)).toEqual([undefined, undefined])
    expect(filterReferenceChoices(attached, choices, '', title).attached.map(reference => reference.nodeId)).toEqual(['a'])
  })

  it('uses declared accepted kinds, leaves no canvas group for no-reference models, and retains legacy kinds without limits', () => {
    expect(canvasReferences('target', nodes, [], title, { image: 0 })).toEqual([])
    expect(canvasReferences('target', nodes, [], title, { image: 2 }).map(choice => choice.reference.nodeId)).toEqual(['a'])
    expect(canvasReferences('target', nodes, [], title).map(choice => choice.reference.nodeId)).toEqual(['a', 'c'])
    expect(canvasReferences('target', nodes, [], title, undefined, true).map(choice => choice.reference.nodeId)).toEqual(['a', 'b', 'c'])
  })

  it('orders topmost first, breaks ties by title, filters both groups by title and caps only matching canvas choices', () => {
    const all = Array.from({ length: 55 }, (_, index) => ({ ...node(`source-${index}`), z: index, title: index === 0 ? 'Rare MATCH' : `Source ${index}` }))
    const attached = numberedReferences(['a', 'b'], [{ ...node('a'), title: 'Match attached' }, { ...node('b'), title: 'Other' }])
    const candidates = canvasReferences('target', all, attached, title)
    const shown = filterReferenceChoices(attached, candidates, '', title)
    expect(shown.canvas).toHaveLength(50)
    expect(shown.canvas[0]?.reference.nodeId).toBe('source-54')
    expect(shown.hasMore).toBe(true)
    const filtered = filterReferenceChoices(attached, candidates, 'mAtCh', title)
    expect(filtered.attached.map(reference => reference.nodeId)).toEqual(['a'])
    expect(filtered.canvas.map(choice => choice.reference.nodeId)).toEqual(['source-0'])
    expect(filtered.hasMore).toBe(false)
    expect(filterReferenceChoices(attached, candidates, 'nothing', title).canvas).toEqual([])
    expect(canvasReferences('target', [{ ...node('z'), title: 'Beta' }, { ...node('y'), title: 'Alpha' }], [], title).map(choice => choice.title)).toEqual(['Alpha', 'Beta'])
  })

  it('disables additional candidates at per-kind and combined catalog count limits without counting empty or duplicate inputs', () => {
    const all = [...nodes, node('image2'), node('video2', 'video'), node('audio2', 'audio'), { ...node('empty'), slots: [] }]
    const refs = numberedReferences(['a', 'a', 'b', 'c', 'empty'], all)
    const choices = canvasReferences('target', all, refs, title, { ...limits, audio: limits.video })
    expect(choices.map(choice => choice.limit)).toEqual([{ kind: 'audio', max: 1 }, { kind: 'image', max: 1 }, { kind: 'video', max: 1 }])
    expect(canvasReferences('target', all, refs, title, { image: 9, total: 3 }).map(choice => choice.limit)).toEqual([{ kind: 'total', max: 3 }])
  })

  it('attaches successfully before inserting and leaves prompt text untouched when attachment fails', async () => {
    const calls: string[] = []
    let finish!: () => void
    const attach = async () => { calls.push('attach'); await new Promise<void>(resolve => { finish = resolve }) }
    const picking = pickPromptReference('a', false, attach, () => calls.push('insert'))
    expect(calls).toEqual(['attach'])
    finish()
    await picking
    expect(calls).toEqual(['attach', 'insert'])
    const failure = new Error('Attachment failed')
    await expect(pickPromptReference('b', false, async () => { throw failure }, () => calls.push('bad insert'))).rejects.toBe(failure)
    expect(calls).toEqual(['attach', 'insert'])
    await pickPromptReference('a', true, attach, () => calls.push('existing insert'))
    expect(calls).toEqual(['attach', 'insert', 'existing insert'])
  })

  it('replaces the complete search phrase and keeps selections and marker text out of title search', () => {
    expect(promptMention('Use @Blue sky', { start: 13, end: 13 })).toEqual({ start: 4, end: 13, query: 'Blue sky' })
    expect(promptMention('Use @Blue\nnext', { start: 14, end: 14 })).toBeNull()
    expect(promptMention(promptRef('a'), { start: promptRef('a').length, end: promptRef('a').length })).toBeNull()
    expect(promptMention('@Blue', { start: 2, end: 4 })).toBeNull()
  })
})

describe('Schema-driven parameter summary', () => {
  const format = {
    number: (value: number) => new Intl.NumberFormat('en').format(value),
    boolean: (value: boolean) => value ? 'On' : 'Off',
    label: (name: string, field: { title?: string }) => field.title ?? name,
    value: (label: string, value: string) => `${label} ${value}`,
  }
  it('uses schema order, defaults and arbitrary field names while ignoring stale values and unsupported shapes', () => {
    const schema = { properties: {
      aspect: { type: 'string', default: '16:9' },
      quality: { type: 'string', default: '720P' },
      length: { type: 'integer', title: 'Seconds', default: 5 },
      copies: { type: 'integer', title: 'Count', default: 1 },
      nested: { type: 'object' },
    } }
    expect(parameterSummary(schema, { copies: 2, stale: 'obsolete' }, format)).toBe('16:9 · 720P · Seconds 5 · Count 2')
    expect(parameterSummary(schema, { quality: '1080P' }, format)).toContain('1080P')
    expect(parameterSummary({}, { stale: 1 }, format)).toBe('')
  })
  it('retains false and zero and formats numbers through the supplied locale formatter', () => {
    const schema = { properties: { enabled: { type: 'boolean', default: true }, seed: { type: 'integer' }, pixels: { type: 'integer' } } }
    expect(parameterSummary(schema, { enabled: false, seed: 0, pixels: 2048 }, format)).toBe('enabled Off · seed 0 · pixels 2,048')
  })
})
