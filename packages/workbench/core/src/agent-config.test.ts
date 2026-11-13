import { describe, expect, it } from 'vitest'
import { VisError } from '@vis/domain'
import { readAgentOptions, validateAgentConfig } from './agent-config'

describe('Agent catalog validation', () => {
  it.each(['session.agent_unconfigured', 'session.agent_models_unsupported'])('preserves the existing %s error', async reason => {
    const error = VisError.of('unavailable', reason, { kind: 'fixture' }, 'Catalog is unavailable')
    await expect(readAgentOptions({ agentOptions: async () => { throw error } }, 'fixture')).rejects.toBe(error)
  })

  it('wraps unknown catalog failures', async () => {
    await expect(readAgentOptions({ agentOptions: async () => { throw new Error('Offline') } }, 'fixture')).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'session.models_unavailable' }, message: 'Cannot read the model list: Offline' })
  })

  it.each([
    { model: null, effort: 'high', serviceTier: null, field: 'effort' },
    { model: null, effort: null, serviceTier: 'fast', field: 'serviceTier' },
  ])('requires an explicit model for $field when the Agent declares no default', async ({ field, ...config }) => {
    const runtime = { agentOptions: async () => [{ id: 'opaque:choice', label: 'Choice', isDefault: false, efforts: [{ id: 'high', label: 'High' }], defaultEffort: 'high', serviceTiers: [{ id: 'fast', label: 'Fast' }] }] }
    await expect(validateAgentConfig(runtime, 'fixture', config)).rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining(`Invalid ${field}`) })
    await expect(validateAgentConfig(runtime, 'fixture', config)).rejects.toThrow('Agent has no default model; pass a model explicitly. Valid model ids: opaque:choice')
    await expect(validateAgentConfig(runtime, 'fixture', { ...config, model: 'opaque:choice' })).resolves.toBeUndefined()
  })
})
