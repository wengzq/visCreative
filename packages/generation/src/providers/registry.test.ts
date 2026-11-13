import { describe, expect, it } from 'vitest'
import { builtinProviderTypes, createProviderTypeRegistry, modelDocsFor } from './registry'

describe('model doc links (RFC 0045)', () => {
  it('gives every built-in known model at least one official page', () => {
    for (const type of builtinProviderTypes) {
      for (const model of type.knownModels) {
        expect(model.docs?.length, `${type.type} ${model.id}`).toBeGreaterThan(0)
        expect(new Set(model.docs!.map(doc => doc.url)).size, `${type.type} ${model.id} duplicate links`).toBe(model.docs!.length)
      }
    }
    // Descriptors parse through the protocol schema, which rejects non-HTTPS and malformed links.
    expect(() => createProviderTypeRegistry()).not.toThrow()
  })

  it('prefers a known model\'s pages and falls back to the type pages for its media kind', () => {
    const base = builtinProviderTypes[0]!
    const own = [{ kind: 'prompt_guide' as const, url: 'https://docs.example.com/a' }]
    const family = [{ kind: 'api_reference' as const, url: 'https://docs.example.com/family' }]
    const type = { ...base, knownModels: [{ id: 'a', kind: 'video' as const, label: 'A', docs: own }, { id: 'b', kind: 'video' as const, label: 'B' }], modelDocs: { video: family } }
    expect(modelDocsFor(type, 'video', 'a')).toEqual(own)
    expect(modelDocsFor(type, 'video', 'b')).toEqual(family)
    expect(modelDocsFor(type, 'video', 'ep-123')).toEqual(family)
    expect(modelDocsFor(type, 'image', 'a')).toBeUndefined()
    expect(modelDocsFor(undefined, 'video', 'a')).toBeUndefined()
  })
})
