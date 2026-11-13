import { describe, expect, it } from 'vitest'
import { METHODS, capabilities, commandOf, describeCapability, listCapabilities, model } from './index'

describe('capabilities', () => {
  it('keeps all hosting methods UI-only and refuses agent capability descriptions', () => {
    const ui = listCapabilities('ui').map(capability => capability.method)
    const agent = listCapabilities('agent').map(capability => capability.method)
    for (const method of ['hosting.get', 'hosting.update', 'hosting.setSecret', 'hosting.clearSecret', 'hosting.test'] as const) {
      expect(METHODS[method].callers).toEqual(['ui'])
      expect(ui).toContain(method)
      expect(agent).not.toContain(method)
      expect(describeCapability(method, 'agent')).toBeUndefined()
      expect(describeCapability(method, 'ui')).toBeDefined()
    }
    expect(describeCapability('hosting.setSecret', 'ui')?.result).toMatchObject({
      properties: { hasSecret: { type: 'boolean' } },
      additionalProperties: false,
    })
    expect(describeCapability('hosting.setSecret', 'ui')?.result).not.toHaveProperty('properties.secret')
    expect(METHODS['generation.submit'].description).toContain('referenceInputs.video')
    expect(METHODS['generation.submit'].description).toContain('videoReferences must be ready')
    expect(METHODS['generation.submit'].description).toContain('only for models whose referenceInputs.video.requiresHosting is true')
  })

  it('keeps regeneration UI-only even when targeting one node', () => {
    expect(METHODS['generation.regenerate'].callers).toEqual(['ui'])
    expect(listCapabilities('agent').map(capability => capability.method)).not.toContain('generation.regenerate')
    expect(describeCapability('generation.regenerate', 'agent')).toBeUndefined()
    expect(describeCapability('generation.regenerate', 'ui')?.params).toMatchObject({
      required: ['requestId', 'jobId'],
      properties: { targetNodeId: { type: 'string', minLength: 1, maxLength: 64 } },
    })
  })

  it('keeps the prompt-slot creation operation out of agent capability schemas', () => {
    expect(JSON.stringify(describeCapability('canvas.apply', 'agent')?.params)).not.toContain('node.setPrompt')
    expect(JSON.stringify(describeCapability('canvas.apply', 'ui')?.params)).toContain('node.setPrompt')
    const op = { op: 'node.setPrompt', nodeId: 'image', body: '{{ref:source}}', expectedRevision: 0 }
    expect(METHODS['canvas.apply'].params.parse({ requestId: 'restore', ops: [op] }).ops).toEqual([op])
    expect(METHODS['canvas.apply'].params.safeParse({ requestId: 'restore', ops: [{ ...op, expectedRevision: undefined }] }).success).toBe(false)
  })
  it('lists project models only for the UI and exposes model versions through the public contract', () => {
    expect(METHODS['model.list'].callers).toEqual(['ui'])
    expect(model.list.params.parse({})).toEqual({})
    expect(model.list.result.parse({ models: [] })).toEqual({ models: [] })
    expect(listCapabilities('ui').map(capability => capability.method)).toContain('model.list')
    expect(listCapabilities('agent').map(capability => capability.method)).not.toContain('model.list')
    expect(describeCapability('model.list', 'agent')).toBeUndefined()
    expect(describeCapability('model.list', 'ui')?.result).toHaveProperty('properties.models')
  })

  it('keeps Agent registry metadata out of agent-callable capabilities', () => {
    expect(METHODS['agents.list'].callers).toEqual(['ui'])
    expect(describeCapability('agents.list', 'agent')).toBeUndefined()
    expect(describeCapability('agents.list', 'ui')?.result).toHaveProperty('properties.agents')
  })

  it('commands derive from method names, with gen as the generation alias', () => {
    expect(commandOf('canvas.apply')).toEqual(['canvas', 'apply'])
    expect(commandOf('generation.submit')).toEqual(['gen', 'submit'])
    expect(commandOf('generation.get')).toEqual(['gen', 'get'])
    expect(commandOf('capabilities.describe')).toEqual(['capabilities', 'describe'])
    expect(commandOf('slot.history')).toEqual(['slot', 'history'])
    expect(commandOf('session.setTitle')).toEqual(['session', 'set', 'title'])
  })

  it('lists capabilities by caller; Agents cannot see UI or runtime methods', () => {
    const agent = listCapabilities('agent')
    expect(agent.map(capability => capability.method)).toEqual([
      'asset.list', 'asset.label', 'library.state',
      'text.requestDelete', 'scene.propose', 'scene.proposal.list', 'text.propose', 'text.proposal.list', 'series.textList', 'series.textRead',
      'session.setTitle',
      'generation.submit', 'generation.cancel', 'generation.recheck', 'generation.get', 'providers.list', 'canvas.apply', 'canvas.get', 'asset.get', 'asset.importFile', 'asset.extractFrames', 'media.process', 'media.get', 'script.batch.plan', 'script.batch.start', 'script.batch.get', 'script.batch.list', 'script.batch.cancel', 'media.analyze', 'font.list',
      // The gateway additionally checks work item API permissions by workspace relationships.
      'work.list', 'work.get', 'work.dispatch', 'work.activate', 'work.recall', 'work.requestDelete', 'work.report', 'work.reply', 'work.review',
      'skill.proposeDraft', 'capabilities.list', 'capabilities.describe', 'guide.get', 'slot.history',
      'entity.list', 'entity.get', 'entity.create', 'entity.update', 'entity.propose', 'entity.proposalList',
      'series.entityList', 'entity.link',
    ])
    expect(agent.find(capability => capability.method === 'generation.submit')?.command).toBe('gen submit')
    expect(capabilities.list.result.safeParse({ capabilities: agent }).success).toBe(true)
    for (const capability of agent) {
      expect(capability.summary).not.toBe('')
    }

    const ui = listCapabilities('ui').map(capability => capability.method)
    expect(ui).toContain('session.create')
    expect(ui).toContain('session.rename')
    expect(ui).toContain('session.resetTitle')
    expect(ui).toContain('session.agentOptions')
    expect(ui).toContain('session.setAgentConfig')
    expect(ui).not.toContain('session.setTitle')
    expect(ui).toContain('runtime.shutdown')
    expect(ui).toContain('generation.get')
    expect(ui).toContain('generation.submit')
    expect(ui).toContain('asset.import')
    expect(ui).toContain('slot.history')
    expect(ui).not.toContain('capabilities.describe')
    expect(ui).not.toContain('runtime.hello')
  })

  it('agent summaries, descriptions and nested parameter schema descriptions are English', () => {
    const expectEnglishDescriptions = (value: unknown, path: string) => {
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`
        if (key === 'description' && typeof child === 'string') {
          expect(child, childPath).not.toMatch(/\p{Script=Han}/u)
        }
        expectEnglishDescriptions(child, childPath)
      }
    }
    for (const capability of listCapabilities('agent')) {
      const described = describeCapability(capability.method, 'agent')!
      expect(described.summary, capability.method).not.toMatch(/\p{Script=Han}/u)
      expect(described.description, capability.method).not.toMatch(/\p{Script=Han}/u)
      expectEnglishDescriptions(described.params, `${capability.method}.params`)
    }
  })

  it('UI-only methods retain Chinese summaries and remain absent from the agent catalog', () => {
    for (const [method, spec] of Object.entries(METHODS)) {
      if (!(spec.callers as readonly string[]).includes('agent')) {
        expect(describeCapability(method, 'ui')?.summary, method).toMatch(/\p{Script=Han}/u)
        expect(describeCapability(method, 'agent'), method).toBeUndefined()
      }
    }
    expect(describeCapability('session.create', 'ui')?.summary).toBe('创建会话')
    expect(describeCapability('asset.import', 'ui')?.params).toMatchObject({
      properties: { path: { description: '本机文件的绝对路径' } },
    })
  })

  it('unknown, prototype-property and unauthorized methods return no description', () => {
    expect(describeCapability('missing.method', 'agent')).toBeUndefined()
    expect(describeCapability('toString', 'agent')).toBeUndefined()
    expect(describeCapability('__proto__', 'agent')).toBeUndefined()
    expect(describeCapability('session.create', 'agent')).toBeUndefined()
    expect(describeCapability('session.rename', 'agent')).toBeUndefined()
    expect(describeCapability('session.resetTitle', 'agent')).toBeUndefined()
    expect(describeCapability('session.agentOptions', 'agent')).toBeUndefined()
    expect(describeCapability('session.setAgentConfig', 'agent')).toBeUndefined()
    expect(describeCapability('session.setTitle', 'ui')).toBeUndefined()
    expect(describeCapability('runtime.shutdown', 'agent')).toBeUndefined()
    expect(describeCapability('capabilities.describe', 'ui')).toBeUndefined()
  })

  it('project deletion and recently deleted projects are UI-only and absent from Agent capabilities and MCP descriptions', () => {
    const ui = listCapabilities('ui').map(capability => capability.method)
    const agent = listCapabilities('agent').map(capability => capability.method)
    for (const method of ['space.deletePlan', 'space.delete', 'space.listDeleted', 'space.diskUsage', 'space.restore', 'space.purge'] as const) {
      expect(METHODS[method].callers).toEqual(['ui'])
      expect(ui).toContain(method)
      expect(agent).not.toContain(method)
      expect(describeCapability(method, 'agent')).toBeUndefined()
      expect(describeCapability(method, 'ui')).toBeDefined()
    }
  })

  it('all Agents share capabilities; workspace relationships determine permissions', () => {
    const methods = listCapabilities('agent').map(capability => capability.method)
    for (const method of ['work.dispatch', 'work.activate', 'work.recall', 'work.report', 'work.reply', 'work.review'] as const) {
      expect(methods).toContain(method)
      expect(describeCapability(method, 'agent')).toBeDefined()
      expect(METHODS[method]).not.toHaveProperty('agentRoles')
    }
    for (const method of ['work.deletePlan', 'work.delete'] as const) {
      expect(listCapabilities('ui').map(capability => capability.method)).toContain(method)
      expect(methods).not.toContain(method)
      expect(describeCapability(method, 'agent')).toBeUndefined()
    }
    const result = describeCapability('work.dispatch', 'agent')!.result
    expect(result).not.toHaveProperty('properties.role')
    expect(result).not.toHaveProperty('properties.notice')
  })

  it('capability descriptions use registered descriptions directly and expose parameter and result JSON Schemas', () => {
    for (const caller of ['ui', 'agent'] as const) {
      for (const summary of listCapabilities(caller)) {
        const description = describeCapability(summary.method, caller)
        expect(description).toMatchObject(summary)
        expect(description?.description).not.toBe('')
        const shapes = (description?.params as { oneOf?: unknown[] }).oneOf ?? [description?.params]
        for (const shape of shapes) expect(shape).toMatchObject({ type: 'object', properties: expect.any(Object) })
        expect(description?.result).toHaveProperty('$schema', 'https://json-schema.org/draft/2020-12/schema')
        expect(capabilities.describe.result.safeParse(description).success).toBe(true)
        expect(() => JSON.stringify(description)).not.toThrow()
      }
    }

    const description = describeCapability('generation.submit', 'agent')!
    expect(description.description).toBe(METHODS['generation.submit'].description)
    expect(description.description).toContain('operationSpecs in providers.list')
    // 0021: prompt defaults to an empty string; generate still requires it (a refine, not in the JSON Schema); other operations may omit it
    expect(description.params).toMatchObject({
      required: ['requestId', 'kind'],
      properties: {
        kind: { enum: ['image', 'video', 'audio'] },
        operation: { enum: expect.arrayContaining(['generate', 'image.upscale']) },
        prompt: { type: 'string' },
        params: { type: 'object', additionalProperties: {} },
      },
    })
    expect(describeCapability('media.process', 'agent')?.params).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['requestId', 'operation', 'nodeId', 'slotId', 'expectedRevision', 'params']),
      properties: { operation: { enum: expect.arrayContaining(['image.crop', 'audio.split']) } },
    })
    // Parameter schemas accept then strip unknown fields; result schemas describe only actual output fields.
    expect(description.params).not.toHaveProperty('additionalProperties')
    expect(description.params).not.toHaveProperty('properties.overrideQuota')
    expect(describeCapability('generation.regenerate', 'ui')?.params).not.toHaveProperty('properties.overrideQuota')
    expect(description.result).toHaveProperty('additionalProperties', false)
    expect(describeCapability('session.create', 'ui')?.description).toBe(METHODS['session.create'].summary)
    expect(describeCapability('canvas.apply', 'agent')?.description).toContain('revision_conflict')
    expect(describeCapability('session.setTitle', 'agent')?.params).toMatchObject({
      required: ['requestId', 'title'],
      additionalProperties: false,
      properties: { title: { type: 'string', minLength: 1, maxLength: 24 } },
    })
    expect(describeCapability('session.setTitle', 'agent')?.description).toContain('user_named')
    expect(describeCapability('canvas.apply', 'agent')?.params).toMatchObject({
      type: 'object',
      required: ['requestId', 'ops'],
      properties: {
        requestId: { type: 'string', minLength: 1, maxLength: 128 },
        ops: { type: 'array', minItems: 1, maxItems: 200 },
      },
    })
    expect(describeCapability('generation.get', 'agent')?.params).toMatchObject({
      properties: { waitMs: { type: 'integer', minimum: 0, maximum: 30_000 } },
    })
  })
})


it('exposes scene proposals to Agents but reserves all resolutions for the author', () => {
  expect(METHODS['scene.propose'].callers).toEqual(['agent'])
  expect(METHODS['scene.proposal.list'].callers).toEqual(['ui', 'agent'])
  expect(METHODS['scene.proposal.resolve'].callers).toEqual(['ui'])
  expect(describeCapability('scene.proposal.resolve', 'agent')).toBeUndefined()
  expect(describeCapability('scene.propose', 'agent')?.params).toMatchObject({ required: ['requestId', 'slotId', 'baseRevision', 'summary', 'changes'] })
})
