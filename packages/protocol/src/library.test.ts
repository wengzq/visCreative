import { describe, expect, it } from 'vitest'
import { assetLibrary, LIBRARY_LIMITS } from './asset'
import { entity, EntityKind } from './entity'
import { ENTITY_METHODS, LIBRARY_METHODS, METHODS } from './methods'
import { GenerationInput, generation } from './generation'
import { ScriptDocInput, ScriptOp } from './script'

describe('0027 library contract', () => {
  it('registers the media library and settings method groups', () => {
    for (const name of [...Object.keys(LIBRARY_METHODS), ...Object.keys(ENTITY_METHODS)]) {
      expect(Object.hasOwn(METHODS, name), name).toBe(true)
    }
  })

  it('reserves labeling for agents and user edits for the UI', () => {
    expect(LIBRARY_METHODS['asset.label'].callers).toEqual(['agent'])
    expect(LIBRARY_METHODS['asset.update'].callers).toEqual(['ui'])
    expect(ENTITY_METHODS['entity.propose'].callers).toEqual(['agent'])
    expect(ENTITY_METHODS['entity.proposalResolve'].callers).toEqual(['ui'])
  })

  it('limits label batches, tags and label length', () => {
    const item = { assetId: 'asset_1', tags: ['二狗'] }
    expect(assetLibrary.label.params.safeParse({ requestId: 'r', items: Array(LIBRARY_LIMITS.labelBatch).fill(item) }).success).toBe(true)
    expect(assetLibrary.label.params.safeParse({ requestId: 'r', items: Array(LIBRARY_LIMITS.labelBatch + 1).fill(item) }).success).toBe(false)
    expect(assetLibrary.label.params.safeParse({ requestId: 'r', items: [{ assetId: 'a', tags: Array(11).fill('x') }] }).success).toBe(false)
    expect(assetLibrary.update.params.safeParse({ assetId: 'a', expectedRevision: 1, category: 'x'.repeat(21) }).success).toBe(false)
    expect(assetLibrary.update.params.parse({ assetId: 'a', expectedRevision: 1, category: '  角色 ' }).category).toBe('角色')
  })

  it('has a style kind and requires a reason on proposals', () => {
    expect(EntityKind.options).toContain('style')
    const proposal = { kind: 'character', name: '二狗', members: [{ assetId: 'a', role: 'voice' }], reason: '同一只哈士奇' }
    expect(entity.propose.params.safeParse({ requestId: 'r', proposals: [proposal] }).success).toBe(true)
    expect(entity.propose.params.safeParse({ requestId: 'r', proposals: [{ ...proposal, reason: '' }] }).success).toBe(false)
    expect(entity.propose.params.safeParse({ requestId: 'r', proposals: [{ ...proposal, members: [] }] }).success).toBe(false)
  })

  it('accepts exactly one generation input shape and preserves setting-based script aliases', () => {
    expect(generation.submit.params.parse({ requestId: 'r', kind: 'image', prompt: 'Draw', inputs: [{ slotId: 'slot', revision: 2 }, { assetVersionId: 'version' }] }).inputs)
      .toEqual([{ slotId: 'slot', revision: 2 }, { assetVersionId: 'version' }])
    for (const value of [{}, { slotId: 'slot', assetVersionId: 'version' }, { assetVersionId: 'version', revision: 1 }]) expect(GenerationInput.safeParse(value).success).toBe(false)
    expect(ScriptDocInput.parse({ castIds: ['hero'], styleId: 'style', shots: [] })).toMatchObject({ castIds: ['hero'], styleId: 'style', assets: [] })
    expect(ScriptOp.parse({ kind: 'doc.set', rev: 1, fields: { castIds: ['hero'], styleId: null } }).kind).toBe('doc.set')
  })
})
