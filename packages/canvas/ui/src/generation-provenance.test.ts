import { expect, it } from 'vitest'
import type { NodeView } from '@vis/protocol'
import { restoreGenerationOps, sameGenerationDraft, type GenerationSource } from './generation-provenance'

const source: GenerationSource = { jobId: 'job', prompt: 'Use {{ref:reference}}', usedPrompt: 'Use Image 1', usedPromptKind: 'resolved', provider: 'mock', model: 'mock-image-1', params: { height: 128, width: 256 }, inputNodeIds: ['reference', 'deleted'] }
const view: NodeView = { nodeId: 'target', kind: 'image', x: 0, y: 0, w: 320, h: 180, z: 1, layoutRevision: 1, slots: [] }

it('compares authored text, ordered inputs and all model settings without depending on parameter key order', () => {
  const choice = { provider: source.provider, model: source.model, params: { width: 256, height: 128 } }
  const nodes = [view, { ...view, nodeId: 'reference' }, { ...view, nodeId: 'other' }]
  const withInputs = (inputs: string[]) => ({ ...view, inputs })
  const same = (text: string, generation: NodeView['generation'], inputs = ['reference'], defaults = {}) => sameGenerationDraft(withInputs(inputs), source, nodes, text, generation, defaults)
  expect(same(source.prompt!, choice)).toBe(true)
  expect(same(source.usedPrompt!, choice)).toBe(false)
  expect(same(source.prompt!, { ...choice, model: 'other' })).toBe(false)
  expect(same(source.prompt!, { ...choice, provider: 'other' })).toBe(false)
  expect(same(source.prompt!, { ...choice, params: { ...choice.params, width: 512 } })).toBe(false)
  expect(same(source.prompt!, choice, ['reference', 'other'])).toBe(false)
})

it('treats a deleted reference as restored once the draft holds the remaining inputs', () => {
  const nodes = [view, { ...view, nodeId: 'reference' }]
  expect(sameGenerationDraft({ ...view, inputs: ['reference'] }, source, nodes, source.prompt!, { provider: source.provider, model: source.model, params: source.params })).toBe(true)
  expect(sameGenerationDraft({ ...view, inputs: [] }, source, nodes, source.prompt!, { provider: source.provider, model: source.model, params: source.params })).toBe(false)
})

it('fills model defaults on both sides so a sparse saved choice matches its fully parsed job params', () => {
  const nodes = [view, { ...view, nodeId: 'reference' }]
  const sparse = { provider: source.provider, model: source.model, params: { width: 256 } }
  expect(sameGenerationDraft({ ...view, inputs: ['reference'] }, source, nodes, source.prompt!, sparse)).toBe(false)
  expect(sameGenerationDraft({ ...view, inputs: ['reference'] }, source, nodes, source.prompt!, sparse, { height: 128 })).toBe(true)
  expect(sameGenerationDraft({ ...view, inputs: ['reference'] }, source, nodes, source.prompt!, sparse, { height: 64 })).toBe(false)
})

it('restores authored markers and the pinned choice in one author batch, dropping deleted and self references', () => {
  expect(restoreGenerationOps(view, { ...source, inputNodeIds: [...source.inputNodeIds, view.nodeId] }, [view, { ...view, nodeId: 'reference' }], 4)).toEqual([
    { op: 'node.setPrompt', nodeId: 'target', body: source.prompt, expectedRevision: 4 },
    { op: 'node.setGeneration', nodeId: 'target', generation: { provider: source.provider, model: source.model, params: source.params } },
    { op: 'node.setInputs', nodeId: 'target', inputNodeIds: ['reference'] },
  ])
})
