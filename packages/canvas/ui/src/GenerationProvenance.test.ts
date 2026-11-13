import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LocaleProvider, type Locale } from '@vis/ui-kit'
import { expect, it } from 'vitest'
import type { NodeView } from '@vis/protocol'
import { GenerationProvenance } from './GenerationProvenance'
import type { useGenerationChoice } from './ModelPicker'
import type { CanvasActions } from './CanvasView'
import { restoreGenerationOps, sourceDefaults, type GenerationSource } from './generation-provenance'

const schema = { properties: { scale: { type: 'integer', default: 2, enum: [2, 4], 'x-vis-label': { zh: '放大倍率', en: 'Scale' }, 'x-vis-options': { 4: { zh: '4 倍', en: '4×' } } } } }
const source: GenerationSource = { jobId: 'job', operation: 'image.upscale', provider: 'mock', model: 'model', prompt: '', params: { scale: 4 }, inputNodeIds: ['subject'] }
const view: NodeView = { nodeId: 'result', kind: 'image', x: 0, y: 0, w: 320, h: 180, z: 1, layoutRevision: 1, slots: [] }
const model = { id: 'model', label: 'Model', paramsSchema: { properties: { width: { type: 'integer', default: 512 } } }, operationSpecs: {
  'image.upscale': { paramsSchema: schema, prompt: 'none' },
  'image.outpaint': { paramsSchema: schema, prompt: 'optional' },
} }
const settings = { catalog: { providers: [{ id: 'mock', label: 'Mock', models: [model] }] } } as unknown as ReturnType<typeof useGenerationChoice>
const render = (locale: Locale, version = source, generation = settings) => renderToStaticMarkup(createElement(LocaleProvider, {
  locale, setLocale() {}, children: createElement(GenerationProvenance, {
    source: version, view, nodes: [{ ...view, nodeId: 'subject' }], text: 'An unrelated next draft', generation,
    actions: {} as CanvasActions, emptyDraft: false, expectedRevision: 0,
    assetUrl: id => id, posterUrl: id => id, onRestored() {}, onBusy() {},
  }),
}))

it('shows operation provenance with its own schema copy and fixed subject, without Restore or a draft comparison', () => {
  const en = render('en')
  expect(en).toContain('Operation that made this version')
  expect(en).toContain('Upscale')
  expect(en).toContain('Mock · Model')
  expect(en).toContain('Scale 4×')
  expect(en).toContain('aria-label="Image"')
  expect(en).not.toContain('Restore this version')
  expect(en).not.toContain('different settings')
  expect(en).not.toContain('role="textbox"')
  expect(en).not.toContain('Copy prompt')
  expect(en).not.toContain('Width')
  const zh = render('zh-CN')
  expect(zh).toContain('高清')
  expect(zh).toContain('放大倍率 4 倍')
  expect(restoreGenerationOps(view, source, [], 0)).toEqual([])
  expect(sourceDefaults(settings.catalog, source)).toEqual({ scale: 2 })
})

it('shows and copies an operation prompt when its spec permits one, with no Restore even on a nonempty draft', () => {
  const html = render('en', { ...source, operation: 'image.outpaint', prompt: 'Extend the sky', usedPrompt: 'Extend the sky around Image 1', usedPromptKind: 'sent' })
  expect(html).toContain('Outpaint')
  expect(html).toContain('aria-readonly="true"')
  expect(html).toContain('Extend the sky around Image 1')
  expect(html).toContain('Copy prompt')
  expect(html).not.toContain('Restore this version')
  expect(html).not.toContain('different settings')
})

it('keeps recorded prompts and parameters visible if the operation model has left the catalog', () => {
  const generation = { catalog: { providers: [] } } as unknown as ReturnType<typeof useGenerationChoice>
  const html = render('en', { ...source, operation: 'image.outpaint', prompt: 'Keep this authored operation prompt', usedPrompt: 'Keep the sent operation prompt', usedPromptKind: 'sent' }, generation)
  expect(html).toContain('Keep the sent operation prompt')
  expect(html).toContain('scale 4')
  expect(html).toContain('Copy prompt')
  expect(html).not.toContain('Restore this version')
  expect(html).not.toContain('different settings')
})
