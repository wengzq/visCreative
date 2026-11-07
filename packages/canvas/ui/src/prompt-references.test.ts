import { promptRef, type NodeView } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { hasBrokenReferences, numberedReferences, PromptHistory, promptParts, promptText } from './prompt-references'
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
    const number = (inputs: string[]) => promptParts(body, numberedReferences(inputs, nodes)).map(part => part.type === 'reference' ? part.reference?.number : null)
    expect(number(['a', 'b', 'c'])).toEqual([2])
    expect(number(['c', 'b', 'a'])).toEqual([2])
    expect(number(['b', 'c'])).toEqual([1])
    expect(promptText(promptParts(body, numberedReferences(['c', 'b'], nodes)))).toBe(body)
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
      ['text', undefined], ['empty', undefined], ['b', 1], ['a', 2],
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
