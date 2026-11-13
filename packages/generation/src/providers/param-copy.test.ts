import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFfmpegMedia } from '@vis/assets'
import { BUILTIN_MODELS, ParamCopy, type MediaKind } from '@vis/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ARK_MODEL_PARAMS } from './ark/models'
import { createMockProvider } from './mock'
import { builtinProviderTypes } from './registry'
import { createRenderProvider } from './render'
import { operationSpecOf, paramsSchemaOf, type ProviderAdapter } from './types'

const requiredCopy = ParamCopy.extend({ 'x-vis-label': ParamCopy.shape['x-vis-label'].unwrap() })
function verify(schema: z.ZodType<Record<string, unknown>>) {
  const json = schema.toJSONSchema({ io: 'input', unrepresentable: 'any' })
  for (const [name, property] of Object.entries(json.properties ?? {})) {
    if (typeof property === 'boolean') throw new Error(`Parameter ${name} must have an annotated schema`)
    const copy = requiredCopy.parse(property)
    const field = (schema as z.ZodObject).shape[name] as z.ZodType
    for (const key of Object.keys(copy['x-vis-options'] ?? {})) {
      // JSON object keys are strings even for numeric and boolean option values.
      const values: unknown[] = [key, ...(key === 'true' ? [true] : key === 'false' ? [false] : []), ...(key.trim() && Number.isFinite(Number(key)) ? [Number(key)] : [])]
      expect(values.some(value => field.safeParse(value).success), `${name} option ${key} must be accepted`).toBe(true)
    }
    if (property.description) expect(property.description).not.toMatch(/\p{Script=Han}/u)
  }
  return json
}

function verifyOperations(adapter: ProviderAdapter, kind: MediaKind, model: string) {
  for (const operation of adapter.operationsFor?.(kind, model) ?? ['generate']) {
    if (operation !== 'generate') verify(operationSpecOf(adapter, kind, model, operation).paramsSchema)
  }
}

describe('Model-owned parameter copy', () => {
  for (const type of builtinProviderTypes) {
    const models = type.type === 'volcengine-ark'
      ? [...Object.entries(ARK_MODEL_PARAMS).map(([id, { kind }]) => ({ id, kind, label: id })),
        { id: 'ep-image', kind: 'image' as const, label: 'Custom image' },
        { id: 'ep-video', kind: 'video' as const, label: 'Custom video' }]
      : type.knownModels
    const adapter = type.create({
      id: `copy-${type.type}`, type: type.type, label: type.type, baseUrl: type.regions[0]!.baseUrl,
      imageModels: models.filter(model => model.kind === 'image'),
      videoModels: models.filter(model => model.kind === 'video'),
      audioModels: models.filter(model => model.kind === 'audio'),
    }, { dataDir: join(tmpdir(), 'vis-param-copy'), getKey: async () => { throw new Error('Schema discovery must never read a key') }, media: createFfmpegMedia() })
    it.each(models)(`${type.type}: $kind $id includes bilingual copy for every exposed field`, ({ id, kind }) => {
      expect(adapter.models).toContain(id)
      expect(adapter.kinds).toContain(kind)
      verify(paramsSchemaOf(adapter, kind, id))
      verifyOperations(adapter, kind, id)
    })
  }
  for (const adapter of [createMockProvider(), createRenderProvider({ workDir: join(tmpdir(), 'vis-param-copy-render') })]) {
    for (const [kind, models] of Object.entries(BUILTIN_MODELS)) {
      it.each(models.filter(model => model.provider === adapter.id))(`${adapter.id}: ${kind} $model includes bilingual copy`, ({ model }) => {
        verify(paramsSchemaOf(adapter, kind as MediaKind, model))
        verifyOperations(adapter, kind as MediaKind, model)
      })
    }
  }

  it('preserves custom metadata through optional/default wrappers and finite unions', () => {
    const copy = { 'x-vis-label': { zh: '标签', en: 'Label' } }
    const schema = z.object({
      outer: z.string().optional().default('x').meta(copy),
      inner: z.string().meta(copy).optional().default('x'),
      union: z.union([z.literal(-1), z.int().min(2).max(4)]).optional().meta(copy),
    })
    const json = verify(schema)
    for (const field of Object.values(json.properties!)) expect(typeof field === 'object' && field['x-vis-label']).toEqual(copy['x-vis-label'])
    expect(json.properties!.union).toHaveProperty('anyOf')
  })

  it('rejects a removed label and option names for values outside the field schema', () => {
    expect(() => verify(z.object({ unlabeled: z.boolean() }))).toThrow()
    expect(() => verify(z.object({ mode: z.literal('a').meta({
      'x-vis-label': { zh: '模式', en: 'Mode' },
      'x-vis-options': { b: { zh: '选项', en: 'Option' } },
    }) }))).toThrow()
  })

  it('rejects a missing bilingual label in a declared operation schema', () => {
    const adapter: ProviderAdapter = {
      ...createMockProvider(),
      operationSpecFor: () => ({ paramsSchema: z.strictObject({ unlabeled: z.boolean() }), prompt: 'none' }),
    }
    expect(() => verifyOperations(adapter, 'image', 'mock-image-1')).toThrow()
  })
})
