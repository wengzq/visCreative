import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFfmpegMedia } from '@vis/assets'
import { builtinProviderTypes, createMockProvider, type ProviderType } from '@vis/generation'
import { ProviderConfigSchema, providers } from '@vis/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { createProviderManager } from './providers'
import { createMemorySecretStore } from './secret-store'
import { exampleService } from '../../../packages/generation/src/providers/testing/example'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup(storedType = 'example') {
  const dataDir = mkdtempSync(join(tmpdir(), 'vis-registry-'))
  directories.push(dataDir)
  const config = ProviderConfigSchema.parse({
    providers: [{ id: 'custom', type: storedType, label: 'Custom', baseUrl: 'https://example.invalid/old', imageModels: [{ id: 'image', label: 'Image' }], videoModels: [], settings: { label: 'first' } }],
    defaults: { image: { provider: 'custom', model: 'image' } },
  })
  writeFileSync(join(dataDir, 'providers.json'), JSON.stringify(config))
  const create = vi.fn((entry: typeof config.providers[number]) => ({ ...createMockProvider(), id: entry.id, type: 'example' }))
  const type: ProviderType = {
    ...builtinProviderTypes[0]!, type: 'example', verified: false, create,
    settingsSchema: ProviderConfigSchema.shape.providers.element.in.pick({ label: true }).extend({
      label: ProviderConfigSchema.shape.providers.element.in.shape.label.default('default label').transform(value => value.trim()),
    }),
  }
  const opts = { dataDir, providerTypes: [type], builtins: [createMockProvider()], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } }, secrets: createMemorySecretStore(), media: createFfmpegMedia(), onChange: vi.fn() }
  return { opts, config, create, manager: createProviderManager(opts) }
}

it('lists descriptors and validates settings and unknown types before saving', async () => {
  const { manager, config, opts } = setup()
  const catalog = providers.list.result.parse(await manager.list())
  expect(catalog.providerTypes[0]).toMatchObject({ type: 'example', verified: false, needsKey: true, settingsSchema: { properties: { label: { type: 'string' } } } })
  expect(catalog.providers[1]).toMatchObject({ available: true, needsKey: true, hasKey: false, settings: { label: 'first' } })
  const before = readFileSync(join(opts.dataDir, 'providers.json'), 'utf8')
  await expect(manager.update({ ...config, providers: [{ ...config.providers[0]!, type: 'missing' }] })).rejects.toMatchObject({ message: 'Generation service type missing is not registered' })
  await expect(manager.update({ ...config, providers: [{ ...config.providers[0]!, settings: { label: 3 } }] })).rejects.toMatchObject({ message: 'Generation service settings are invalid' })
  expect(readFileSync(join(opts.dataDir, 'providers.json'), 'utf8')).toBe(before)
  expect((await manager.list()).providerTypes).toBe((await manager.list()).providerTypes)
})

it('keeps unavailable entries and their defaults while allowing unrelated edits or removal', async () => {
  const { manager, config, opts, create } = setup('removed-community-type')
  const catalog = providers.list.result.parse(await manager.list())
  expect(catalog.providers[1]).toMatchObject({ type: 'removed-community-type', available: false, models: [{ id: 'image', kind: 'image' }] })
  expect(create).not.toHaveBeenCalled()
  expect(manager.defaults().image).toEqual({ provider: 'mock' })
  expect(catalog.unavailableDefaults).toEqual(['image'])
  expect(manager.resolve('custom', config.providers[0])).toBeUndefined()
  await manager.update({ ...config, limits: { ...config.limits, dailyImage: 42 } })
  expect(JSON.parse(readFileSync(join(opts.dataDir, 'providers.json'), 'utf8')).providers).toEqual(config.providers)
  await manager.update({ ...config, providers: [], defaults: {} })
  expect((await manager.list()).providers).toHaveLength(1)
})

it('passes parsed settings defaults and transforms to adapters without rewriting the stored entry', () => {
  const { config, opts, create } = setup()
  delete config.providers[0]!.settings
  writeFileSync(join(opts.dataDir, 'providers.json'), JSON.stringify(config))
  const manager = createProviderManager(opts)
  manager.adapters()
  expect(create.mock.calls.at(-1)?.[0].settings).toEqual({ label: 'default label' })
  manager.resolve('custom', { ...config.providers[0], settings: { label: ' trimmed ' } })
  expect(create.mock.calls.at(-1)?.[0].settings).toEqual({ label: 'trimmed' })
  expect(JSON.parse(readFileSync(join(opts.dataDir, 'providers.json'), 'utf8')).providers[0]).not.toHaveProperty('settings')
})

it('applies the Example descriptor project default before constructing the adapter', async () => {
  const example = await exampleService()
  try {
    const { config, opts } = setup()
    const entry = { ...config.providers[0]!, baseUrl: example.type.regions[0]!.baseUrl, settings: {} }
    writeFileSync(join(opts.dataDir, 'providers.json'), JSON.stringify({ ...config, providers: [entry] }))
    const create = vi.fn(example.type.create)
    const manager = createProviderManager({ ...opts, providerTypes: [{ ...example.type, create }] })
    manager.adapters()
    expect(create.mock.calls[0]?.[0].settings).toEqual({ project: 'demo' })
    expect(example.creates()).toBe(0)
  } finally { await example.close() }
})

it.each([
  { settings: { label: 4 } },
  { region: 'missing' },
  { region: 'beijing', baseUrl: 'https://example.invalid/wrong' },
  { videoModels: [{ id: 'unsupported', label: 'Unsupported' }] },
  { baseUrl: 'https://unlisted.invalid' },
])('rejects invalid typed entries on update and pin resolution and quarantines them on load: %j', async invalid => {
  const { config, opts, create } = setup()
  opts.providerTypes[0] = { ...opts.providerTypes[0]!, kinds: ['image'], allowCustomBaseUrl: false, regions: [{ id: 'beijing', label: { zh: 'Test', en: 'Test' }, baseUrl: config.providers[0]!.baseUrl }] }
  const manager = createProviderManager(opts)
  const entry = { ...config.providers[0]!, ...invalid }
  await expect(manager.update({ ...config, providers: [entry] })).rejects.toBeInstanceOf(Error)
  expect(() => manager.resolve('custom', entry)).toThrow()
  const bytes = JSON.stringify({ ...config, providers: [entry] })
  writeFileSync(join(opts.dataDir, 'providers.json'), bytes)
  const restarted = createProviderManager(opts)
  const catalog = await restarted.list()
  expect(catalog.providers.find(provider => provider.id === 'custom')).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/^provider\./) })
  expect(restarted.adapters().map(adapter => adapter.id)).toEqual(['mock'])
  expect(restarted.defaults().image).toEqual({ provider: 'mock' })
  expect(create).not.toHaveBeenCalled()
  expect(readFileSync(join(opts.dataDir, 'providers.json'), 'utf8')).toBe(bytes)
})

it('accepts a matching region and custom URLs only without a region identifier', async () => {
  const { config, opts } = setup()
  const type = opts.providerTypes[0]!
  type.regions = [{ id: 'east', label: { zh: 'East', en: 'East' }, baseUrl: config.providers[0]!.baseUrl }]
  const manager = createProviderManager(opts)
  await manager.update({ ...config, providers: [{ ...config.providers[0]!, region: 'east' }] })
  await expect(manager.update({ ...config, providers: [{ ...config.providers[0]!, region: 'custom' }] })).rejects.toThrow()
  await manager.update({ ...config, providers: [{ ...config.providers[0]!, baseUrl: 'https://custom.invalid' }] })
})

it('rebuilds and caches pinned old configurations after restart, but removal returns provider missing', async () => {
  const { manager, config, opts, create } = setup()
  const pinned = config.providers[0]!
  await manager.update({ ...config, providers: [{ ...pinned, baseUrl: 'https://example.invalid/new', settings: { label: 'second' } }] })
  const restarted = createProviderManager(opts)
  const restored = restarted.resolve('custom', pinned)
  expect(restored?.configuration).toEqual(pinned)
  expect(restarted.resolve('custom', pinned)).toBe(restored)
  expect(create.mock.calls.at(-1)?.[0]).toEqual(pinned)
  await restarted.update({ ...config, providers: [], defaults: {} })
  expect(restarted.resolve('custom', pinned)).toBeUndefined()
})

it('accepts declared endpoint overrides only with a custom URL and keeps them in the catalog', async () => {
  const { config, opts } = setup()
  const type = opts.providerTypes[0]!
  const official = 'https://official.invalid/v1'
  type.regions = [{ id: 'east', label: { zh: 'East', en: 'East' }, baseUrl: official }]
  type.endpoints = [{ id: 'task', label: { zh: 'Task', en: 'Task' }, path: '/tasks/{id}', requiredFor: ['image'] }]
  const manager = createProviderManager(opts)
  const entry = { ...config.providers[0]!, baseUrl: 'https://gateway.invalid/api' }
  await manager.update({ ...config, providers: [{ ...entry, endpoints: { task: '/jobs/{id}' } }] })
  expect((await manager.list()).providers.find(provider => provider.id === 'custom')?.endpoints).toEqual({ task: '/jobs/{id}' })
  expect((await createProviderManager(opts).list()).providers.find(provider => provider.id === 'custom')?.endpoints).toEqual({ task: '/jobs/{id}' })
  for (const invalid of [
    { ...entry, endpoints: { task: '/jobs' } },
    { ...entry, endpoints: { unknown: '/jobs/{id}' } },
    { ...entry, baseUrl: official, endpoints: { task: '/jobs/{id}' } },
    { ...entry, baseUrl: official, region: 'east', endpoints: { task: '/jobs/{id}' } },
  ]) await expect(manager.update({ ...config, providers: [invalid] })).rejects.toMatchObject({ details: { reason: 'provider.endpoint_invalid' } })
  await expect(manager.update({ ...config, providers: [{ ...entry, endpoints: {} }] })).rejects.toMatchObject({ details: { reason: 'provider.endpoint_required' } })
  await manager.update({ ...config, providers: [entry] })
})
