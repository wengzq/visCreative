import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocaleProvider, type Locale } from '@vis/ui-kit'
import { describe, expect, it } from 'vitest'
import type { NodeView } from '@vis/protocol'
import { GenerationSettingsContext } from './ModelPicker'
import { PromptPanel } from './PromptPanel'
import { operationChoiceKey, operationModels, operationSpec, operationSubmitDisabled, resolveOperationChoice } from './operation-panel'
import type { CanvasActions } from './CanvasView'
import type { ProviderCatalog } from './params'

const schema = { properties: { ratio: { type: 'string', enum: ['1:1', '16:9'], default: '1:1', 'x-vis-label': { zh: '扩图比例', en: 'Outpaint aspect ratio' } } } }
const model = { id: 'first', label: 'First', kind: 'image' as const, operations: ['image.outpaint' as const], paramsSchema: { properties: { width: { type: 'integer', default: 256 } } }, operationSpecs: { 'image.outpaint': { paramsSchema: schema, prompt: 'optional' as const } } }
const provider = { id: 'mock', type: 'mock', label: 'Mock', available: true, needsKey: false, hasKey: false, models: [
  { ...model, id: 'generate-only', operations: ['generate' as const] },
  model,
  { ...model, id: 'second', label: 'Second' },
  { ...model, id: 'video', kind: 'video' as const },
] }
const catalog: ProviderCatalog = { videoReferences: 'hosting_required', providerTypes: [], providers: [provider, { ...provider, id: 'unconfigured', needsKey: true }, { ...provider, id: 'unavailable', available: false }], defaults: {}, limits: { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 } }
const view: NodeView = { nodeId: 'subject', kind: 'image', x: 0, y: 0, w: 320, h: 180, z: 0, layoutRevision: 1, slots: [
  { slotId: 'main', slotKey: 'main', contentType: 'image', revision: 4, content: { type: 'asset', assetVersionId: 'asset', mime: 'image/png' } },
] }

describe('Operation choices', () => {
  it('lists declaring models of the subject kind in catalog order, retaining providers without keys', () => {
    expect(operationModels(catalog, 'image', 'image.outpaint').map(({ provider, model }) => `${provider.id}/${model.id}`)).toEqual([
      'mock/first', 'mock/second', 'unconfigured/first', 'unconfigured/second',
    ])
    expect(operationModels(catalog, 'video', 'image.outpaint')).toEqual([])
    expect(operationModels(null, 'image', 'image.outpaint')).toEqual([])
  })
  it('prefers the saved project operation choice, then a capable node model, then catalog order', () => {
    const nodeChoice = { provider: 'mock', model: 'second', params: { width: 1024, ratio: '16:9' } }
    const saved = { provider: 'unconfigured', model: 'first', params: { ratio: '16:9', width: 512 } }
    expect(resolveOperationChoice(catalog, 'image', 'image.outpaint', saved, nodeChoice)).toEqual({ ...saved, params: { ratio: '16:9' } })
    expect(resolveOperationChoice(catalog, 'image', 'image.outpaint', null, nodeChoice)).toEqual({ provider: 'mock', model: 'second', params: { ratio: '1:1' } })
    expect(resolveOperationChoice(catalog, 'image', 'image.outpaint', { ...saved, model: 'removed' }, { ...nodeChoice, model: 'generate-only' })).toEqual({ provider: 'mock', model: 'first', params: { ratio: '1:1' } })
    expect(resolveOperationChoice(catalog, 'image', 'image.upscale', null)).toBeNull()
    expect(nodeChoice.params).toEqual({ width: 1024, ratio: '16:9' })
  })
  it('separates stored choices by project and operation and defaults missing specs to no settings or prompt', () => {
    expect(operationChoiceKey('one', 'image.outpaint')).not.toBe(operationChoiceKey('two', 'image.outpaint'))
    expect(operationChoiceKey('one', 'image.outpaint')).not.toBe(operationChoiceKey('one', 'image.upscale'))
    expect(operationSpec(model, 'image.upscale')).toEqual({ paramsSchema: {}, prompt: 'none' })
  })
  it.each(['none', 'optional', 'required'] as const)('checks prompt and pending rules for %s prompts', rule => {
    const state = { blocked: false, sending: false, composing: false, broken: false, hasSubject: true }
    expect(operationSubmitDisabled(rule, '', state)).toBe(rule === 'required')
    expect(operationSubmitDisabled(rule, ' \n ', state)).toBe(rule === 'required')
    expect(operationSubmitDisabled(rule, 'A new view', state)).toBe(false)
    for (const reason of ['blocked', 'sending', 'composing'] as const) expect(operationSubmitDisabled(rule, 'A new view', { ...state, [reason]: true })).toBe(true)
    expect(operationSubmitDisabled(rule, 'A new view', { ...state, hasSubject: false })).toBe(true)
    expect(operationSubmitDisabled(rule, '{{ref:gone}}', { ...state, broken: true })).toBe(rule !== 'none')
  })
})

it('uses the same prompt panel for a paid operation with schema copy, a fixed subject and no draft writes in either locale', () => {
  const actions = { onSubmitOperation: async () => {} } as unknown as CanvasActions
  const operationView: NodeView = {
    ...view,
    get inputs(): string[] { throw new Error('Generate inputs read') },
    generation: { provider: 'mock', model: 'first', get params(): Record<string, unknown> { throw new Error('Generate settings read') } },
    slots: [...view.slots, { slotId: 'prompt', slotKey: 'prompt', contentType: 'text', revision: 3, content: { type: 'text', get body(): string { throw new Error('Generate prompt read') } } }],
  }
  const render = (locale: Locale) => renderToStaticMarkup(createElement(LocaleProvider, { locale, setLocale() {},
    children: createElement(GenerationSettingsContext.Provider, { value: { catalog, spaceId: 'project', onManage() {} },
      children: createElement(PromptPanel, {
        view: operationView, nodes: [operationView], text: 'Author draft must stay private', saving: false, generation: {} as any, actions,
        assetUrl: id => id, posterUrl: id => id, picking: false, onPick() {}, onChange() { throw new Error('Draft changed') },
        onCommit: async () => { throw new Error('Draft committed') }, onReset() {},
        operation: { operation: 'image.outpaint', onClose() {} },
      }),
    }),
  }))
  const en = render('en')
  expect(en).toContain('aria-label="Outpaint"')
  expect(en).toContain('aria-label="Outpaint aspect ratio"')
  expect(en).toContain('aria-label="Operation subject (reference 1)"')
  expect(en).toContain('aria-label="Return to generation draft"')
  expect(en).toContain('Calls a provider and may incur a charge')
  expect(en).toContain('Mock · First')
  expect(en).toContain('aria-label="Prompt"')
  expect(en).not.toContain('Author draft must stay private')
  expect(en).not.toContain('vis-reference-remove')
  expect(en).not.toContain('Upload references')
  expect(en).not.toMatch(/\p{Script=Han}/u)
  const zh = render('zh-CN')
  expect(zh).toContain('aria-label="扩图"')
  expect(zh).toContain('aria-label="扩图比例"')
})
