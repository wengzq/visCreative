import type { ReactElement, ReactNode } from 'react'
import type { EntityProposalView, EntityView, LibraryAsset, SpaceEvent } from '@vis/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsTab } from './SettingsTab'
import { SettingCard } from './SettingCard'
import { SettingEditor } from './SettingEditor'
import { PendingProposals } from './Proposals'
import { GroupIntoSettingDialog } from './GroupIntoSettingDialog'
import { SettingPicker } from './SettingPicker'
import { useSettingMedia } from './data'
import { AudioIcon } from './AudioIcon'
import type { SettingsLibraryHost } from './host'

const hooks = vi.hoisted(() => ({
  scopes: new Map<string, any[]>(), values: [] as any[], index: 0, effects: [] as (() => void)[],
}))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState(initial: unknown) {
    const index = hooks.index++
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial
    const values = hooks.values
    return [values[index], (value: any) => { values[index] = typeof value === 'function' ? value(values[index]) : value }]
  },
  useRef(current: unknown) { return hooks.values[hooks.index++] ??= { current } },
  useMemo: (fn: () => unknown) => fn(),
  useCallback(fn: unknown, deps: unknown[]) {
    const index = hooks.index++
    const previous = hooks.values[index]
    if (!previous || !deps.every((value, index) => Object.is(value, previous.deps[index]))) hooks.values[index] = { deps, fn }
    return hooks.values[index].fn
  },
  useSyncExternalStore(subscribe: (listener: () => void) => () => void, snapshot: () => unknown) {
    const index = hooks.index++
    const previous = hooks.values[index]
    if (!previous || previous.subscribe !== subscribe) {
      previous?.cleanup?.()
      hooks.values[index] = { subscribe, cleanup: subscribe(() => {}) }
    }
    return snapshot()
  },
  useEffect(fn: () => (() => void) | void, deps: unknown[]) {
    const index = hooks.index++
    const previous = hooks.values[index]
    if (previous && deps.every((value, index) => Object.is(value, previous.deps[index]))) return
    previous?.cleanup?.()
    const record = { deps, cleanup: undefined as (() => void) | void }
    hooks.values[index] = record
    hooks.effects.push(() => { record.cleanup = fn() })
  },
}))
vi.mock('@vis/ui-kit', async importOriginal => ({
  ...await importOriginal<typeof import('@vis/ui-kit')>(),
  useMessages: (dictionary: { en: unknown }) => dictionary.en,
  useFormat: () => ({ number: String }),
  useLocale: () => ({ locale: 'en' }),
}))

beforeEach(() => { hooks.scopes.clear(); hooks.effects = []; vi.useFakeTimers() })
afterEach(() => {
  for (const values of hooks.scopes.values()) for (const value of values) value?.cleanup?.()
  vi.useRealTimers()
})
function render<T>(scope: string, fn: () => T): T {
  hooks.values = hooks.scopes.get(scope) ?? []
  hooks.scopes.set(scope, hooks.values)
  hooks.index = 0
  const result = fn()
  hooks.effects.splice(0).forEach(effect => effect())
  return result
}
function elements(value: ReactNode): ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const element = value as ReactElement<any>
  return [element, ...elements(element.props.children), ...elements(element.props.footer)]
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const button = (tree: ReactNode, text: string) => elements(tree).find(item => item.type === 'button' && item.props.children === text)!
const field = (tree: ReactNode, label: string) => elements(tree).find(item => item.props['aria-label'] === label)!
const setting = (id: string, overrides: Partial<EntityView> = {}): EntityView => ({
  id, kind: 'character', name: id, description: 'Original description', refs: [], members: [],
  revision: 1, createdAt: 1, updatedAt: 1, usage: { scriptNodeIds: [], shotCount: 0 }, ...overrides,
})
const media = (assetId: string, version = `${assetId}-latest`): LibraryAsset =>
  ({ assetId, kind: 'image', displayName: assetId, latest: { assetVersionId: version } }) as LibraryAsset
const proposal: EntityProposalView = {
  proposalId: 'proposal', kind: 'character', name: 'Hero', reason: 'Same costume', sessionId: 'session', status: 'pending',
  needsRecheck: false, createdAt: 1, refs: ['a-old'], members: [{ assetId: 'a', role: 'image' }, { assetId: 'b', role: 'image' }],
}
function fixture(settings = [setting('first'), setting('second')], proposals: EntityProposalView[] = []) {
  const listeners = new Set<(event: SpaceEvent) => void>()
  const call = vi.fn(async (method: string, params: any): Promise<any> => {
    if (method === 'entity.list') return { items: settings }
    if (method === 'series.entityList') return { series: null, items: [] }
    if (method === 'entity.get') return settings.find(item => item.id === params.entityId)
    if (method === 'entity.proposalList') return { items: proposals }
    if (method === 'asset.list') return { items: [media('a'), media('b')] }
    if (method === 'asset.get') return { assetId: params.assetVersionId.split('-')[0], assetVersionId: params.assetVersionId }
    if (method === 'entity.proposalResolve') return { proposal: { ...proposal, status: 'accepted' } }
    throw new Error(`Unexpected method ${method}`)
  })
  const host = { call, onEvent: (listener: (event: SpaceEvent) => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  } } as SettingsLibraryHost
  const emit = (type: SpaceEvent['type'], entityId: string) => {
    for (const listener of listeners) listener({ seq: 1, type, entityId, entityType: 'asset', payload: { assetId: entityId } })
  }
  return { host, call, emit, settings }
}

it('keeps the first card first after an event, accepted proposal or editor save', async () => {
  const { host, emit, settings } = fixture(undefined, [proposal])
  const tree = () => render('tab', () => SettingsTab({ host }))
  tree(); await flush()
  settings[0] = { ...settings[0]!, name: 'Edited first', revision: 2 }
  emit('entity.updated', 'first')
  await vi.advanceTimersByTimeAsync(80)
  const ids = () => elements(tree()).filter(item => item.type === SettingCard).map(item => item.props.entity.id)
  expect(ids()).toEqual(['first', 'second'])
  elements(tree()).find(item => item.type === PendingProposals)!.props.onEntity(settings[0])
  expect(ids()).toEqual(['first', 'second'])
  elements(tree()).find(item => item.type === SettingCard)!.props.onClick()
  elements(tree()).find(item => item.type === SettingEditor)!.props.onSaved(settings[0])
  expect(ids()).toEqual(['first', 'second'])
})

it('does not refetch proposals for unrelated media or refresh the library when the editor closes', async () => {
  const { host, call, emit } = fixture(undefined, [proposal])
  const tree = () => render('tab', () => SettingsTab({ host }))
  tree(); await flush()
  call.mockClear()
  emit('asset.updated', 'unrelated')
  await vi.advanceTimersByTimeAsync(80)
  expect(call).not.toHaveBeenCalled()
  emit('asset.updated', 'a')
  await vi.advanceTimersByTimeAsync(80)
  expect(call).toHaveBeenCalledWith('entity.proposalList', { status: 'pending' })
  call.mockClear()
  elements(tree()).find(item => item.type === SettingCard)!.props.onClick()
  elements(tree()).find(item => item.type === SettingEditor)!.props.onClose()
  await flush()
  expect(call).not.toHaveBeenCalled()
})

function proposalView(host: SettingsLibraryHost, value = proposal) {
  const parent = () => render('proposals', () => PendingProposals({ host, proposals: [value], settings: [], onResolved() {}, onEntity() {} }))
  const card = () => {
    const node = elements(parent()).find(item => typeof item.type === 'function')!
    return render('proposal-card', () => (node.type as (props: any) => ReactNode)(node.props))
  }
  return { parent, card }
}

it('looks up changed refs for the same proposal and removes older versions when their member is unticked', async () => {
  const { host, call } = fixture()
  let value = proposal
  const tree = () => proposalView(host, value).card()
  tree(); await flush(); tree()
  value = { ...proposal, refs: ['b-old'] }
  tree(); await flush()
  expect(call).toHaveBeenCalledWith('asset.get', { assetVersionId: 'b-old' })
  field(tree(), 'Select member a').props.onChange()
  button(tree(), 'Accept').props.onClick()
  await flush()
  expect(call).toHaveBeenCalledWith('entity.proposalResolve', expect.objectContaining({
    edits: expect.objectContaining({ members: [{ assetId: 'b', role: 'image' }], refs: [] }),
  }))
})

it('shows a failed reference lookup inline and disables individual and bulk acceptance', async () => {
  const { host, call } = fixture()
  const original = call.getMockImplementation()!
  call.mockImplementation(async (method, params) => {
    if (method === 'asset.get') throw new Error('Reference lookup failed')
    return original(method, params)
  })
  const view = proposalView(host)
  view.card(); await flush()
  expect(button(view.card(), 'Accept').props.disabled).toBe(true)
  expect(button(view.parent(), 'Accept all').props.disabled).toBe(true)
  expect(JSON.stringify(elements(view.card()).filter(item => item.props.role === 'alert'))).toContain('Reference lookup failed')
})

it('shares media paging across consumers and coalesces updates once per affected page', async () => {
  const { host, call, emit } = fixture()
  const original = call.getMockImplementation()!
  let changed = false
  call.mockImplementation(async (method, params) => {
    if (method !== 'asset.list') return original(method, params)
    if (params.cursor === 'third') return { items: [media('d')] }
    if (params.cursor === 'second') return { items: [media('c')], nextCursor: 'third' }
    return { items: [media('a', changed ? 'changed' : 'a-latest'), media('b')], nextCursor: 'second' }
  })
  const read = (id: string) => render(id, () => useSettingMedia(host))
  read('one'); read('two'); read('three')
  await flush()
  expect(call.mock.calls.filter(([method]) => method === 'asset.list')).toHaveLength(3)
  call.mockClear(); changed = true
  emit('asset.updated', 'a'); emit('asset.updated', 'b'); emit('asset.updated', 'c')
  await vi.advanceTimersByTimeAsync(299)
  expect(call).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(call.mock.calls.filter(([method]) => method === 'asset.list')).toHaveLength(2)
  expect(call).toHaveBeenCalledWith('asset.list', expect.objectContaining({ cursor: 'second' }))
  expect(call).not.toHaveBeenCalledWith('asset.list', expect.objectContaining({ cursor: 'third' }))
  for (const id of ['one', 'two', 'three']) expect(read(id).media[0]!.latest.assetVersionId).toBe('changed')
})

it('coalesces unknown asset events into one full cache refresh', async () => {
  const { host, call, emit } = fixture()
  render('media', () => useSettingMedia(host)); await flush()
  call.mockClear()
  emit('asset.updated', 'unknown-one'); emit('asset.updated', 'unknown-two')
  await vi.advanceTimersByTimeAsync(300)
  expect(call.mock.calls.filter(([method]) => method === 'asset.list')).toHaveLength(1)
})

it('falls back to a debounced full cache refresh when a retained cursor is rejected', async () => {
  const { host, call, emit } = fixture()
  const original = call.getMockImplementation()!
  let rejectCursor = false
  call.mockImplementation(async (method, params) => {
    if (method !== 'asset.list') return original(method, params)
    if (params.cursor) {
      if (rejectCursor) throw { code: 'invalid_params', details: { reason: 'library.invalid_cursor' } }
      return { items: [media('c')] }
    }
    rejectCursor = false
    return { items: [media('a')], nextCursor: 'second' }
  })
  render('media', () => useSettingMedia(host)); await flush()
  call.mockClear(); rejectCursor = true
  emit('asset.updated', 'c')
  await vi.advanceTimersByTimeAsync(300)
  expect(call).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(300)
  expect(call.mock.calls.filter(([method]) => method === 'asset.list')).toHaveLength(3)
  expect(render('media', () => useSettingMedia(host)).error).toBeNull()
})

function editorView(host: SettingsLibraryHost, entity: EntityView, onSaved = vi.fn()) {
  const tree = () => render('editor', () => SettingEditor({ host, entity, onSaved, onClose() {}, onOpenExisting() {} }))
  const unmerge = () => {
    button(tree(), 'Unmerge').props.onClick()
    return elements(tree()).findLast(item => typeof item.type === 'function')!
  }
  return { tree, unmerge, onSaved }
}

it('unmerges the loaded revision and resets every editor field from the result', async () => {
  const { host, call } = fixture()
  const entity = setting('first', { members: [{ assetId: 'a', role: 'image' }], refs: [{ assetVersionId: 'a-old' }] })
  const result = { ...entity, name: 'Server name', description: 'Server description', refs: [], members: [], revision: 2 }
  const original = call.getMockImplementation()!
  call.mockImplementation(async (method, params) => method === 'entity.unmerge' ? result : original(method, params))
  const view = editorView(host, entity)
  const confirmation = view.unmerge()
  button(confirmation, 'Unmerge').props.onClick()
  await flush()
  expect(call).toHaveBeenCalledWith('entity.unmerge', expect.objectContaining({ expectedRevision: 1 }))
  expect(call.mock.calls.some(([method]) => method === 'entity.get')).toBe(false)
  expect(field(view.tree(), 'Setting name').props.value).toBe('Server name')
  expect(field(view.tree(), 'Description').props.value).toBe('Server description')
  expect(button(view.tree(), 'Save').props.disabled).toBe(true)
  expect(view.onSaved).toHaveBeenCalledWith(result)
})

it('preserves a stale unmerge conflict and offers explicit reload', async () => {
  const { host, call } = fixture()
  const original = call.getMockImplementation()!
  call.mockImplementation(async (method, params) => method === 'entity.unmerge'
    ? Promise.reject({ code: 'revision_conflict' }) : original(method, params))
  const view = editorView(host, setting('first'))
  button(view.unmerge(), 'Unmerge').props.onClick()
  await flush()
  expect(call.mock.calls.some(([method]) => method === 'entity.get')).toBe(false)
  expect(JSON.stringify(view.tree())).toContain('This setting changed')
  button(view.tree(), 'Reload').props.onClick()
  await flush()
  expect(call).toHaveBeenCalledWith('entity.get', { entityId: 'first' })
})

it('asks to save or discard unsaved changes before unmerging', async () => {
  const { host, call } = fixture()
  const view = editorView(host, setting('first'))
  field(view.tree(), 'Setting name').props.onChange({ target: { value: 'Unsaved' } })
  const confirmation = view.unmerge()
  expect(button(confirmation, 'Save changes')).toBeDefined()
  expect(button(confirmation, 'Discard changes')).toBeDefined()
  expect(call.mock.calls.some(([method]) => method === 'entity.unmerge')).toBe(false)
})

it('saves unsaved edits before confirming an unmerge with the saved revision', async () => {
  const { host, call } = fixture()
  const entity = setting('first')
  const saved = { ...entity, name: 'Saved name', revision: 2 }
  const original = call.getMockImplementation()!
  call.mockImplementation(async (method, params) => {
    if (method === 'entity.update') return saved
    if (method === 'entity.unmerge') return { ...saved, revision: 3 }
    return original(method, params)
  })
  const view = editorView(host, entity)
  field(view.tree(), 'Setting name').props.onChange({ target: { value: 'Saved name' } })
  button(view.unmerge(), 'Save changes').props.onClick()
  await flush()
  expect(call).toHaveBeenCalledWith('entity.update', { entityId: 'first', expectedRevision: 1, name: 'Saved name' })
  expect(call.mock.calls.some(([method]) => method === 'entity.unmerge')).toBe(false)
  const confirmation = elements(view.tree()).findLast(item => typeof item.type === 'function')!
  button(confirmation, 'Unmerge').props.onClick()
  await flush()
  expect(call).toHaveBeenCalledWith('entity.unmerge', expect.objectContaining({ expectedRevision: 2 }))
})

it('discards draft fields before showing the final unmerge confirmation', () => {
  const { host, call } = fixture()
  const entity = setting('first', { refs: [{ assetVersionId: 'a-old' }], members: [{ assetId: 'a', role: 'image' }] })
  const view = editorView(host, entity)
  field(view.tree(), 'Setting name').props.onChange({ target: { value: 'Unsaved name' } })
  field(view.tree(), 'Description').props.onChange({ target: { value: 'Unsaved description' } })
  field(view.tree(), 'Remove reference image').props.onClick()
  field(view.tree(), 'Remove member').props.onClick()
  button(view.unmerge(), 'Discard changes').props.onClick()
  expect(field(view.tree(), 'Setting name').props.value).toBe(entity.name)
  expect(field(view.tree(), 'Description').props.value).toBe(entity.description)
  expect(field(view.tree(), 'Remove reference image')).toBeDefined()
  expect(field(view.tree(), 'Remove member')).toBeDefined()
  expect(button(view.tree(), 'Save').props.disabled).toBe(true)
  expect(call.mock.calls.some(([method]) => method === 'entity.unmerge')).toBe(false)
})

it('shares the inline SVG audio icon between the editor and proposal tiles', async () => {
  const { host } = fixture()
  const editor = editorView(host, setting('first', { members: [{ assetId: 'voice', role: 'voice' }] }))
  expect(elements(editor.tree()).some(item => item.type === AudioIcon)).toBe(true)
  const view = proposalView(host, { ...proposal, members: [{ assetId: 'voice', role: 'voice' }] })
  view.card(); await flush()
  expect(elements(view.card()).some(item => item.type === AudioIcon)).toBe(true)
})

it('counts deduplicated existing and selected members before allowing manual grouping', async () => {
  const existing = setting('full', { members: Array.from({ length: 200 }, (_, index) => ({ assetId: `member-${index}`, role: 'image' })) })
  const { host, call } = fixture([existing])
  let assetIds = ['member-0', 'new', 'new']
  const tree = () => render('group', () => GroupIntoSettingDialog({ host, assetIds, onClose() {} }))
  tree(); await flush()
  field(tree(), 'Destination setting').props.onChange({ target: { value: 'full' } })
  expect(button(tree(), 'Save').props.disabled).toBe(true)
  expect(JSON.stringify(tree())).toContain('A setting can have up to 200 members')
  expect(call.mock.calls.some(([method]) => method === 'entity.update')).toBe(false)
  assetIds = ['member-0', 'member-0']
  expect(button(tree(), 'Save').props.disabled).toBe(false)
})

it('rechecks the member limit against the loaded destination before writing', async () => {
  const { host, call, settings } = fixture([setting('destination')])
  const tree = () => render('group', () => GroupIntoSettingDialog({ host, assetIds: ['new'], onClose() {} }))
  tree(); await flush()
  field(tree(), 'Destination setting').props.onChange({ target: { value: 'destination' } })
  settings[0] = setting('destination', { members: Array.from({ length: 200 }, (_, index) => ({ assetId: `member-${index}`, role: 'image' })) })
  button(tree(), 'Save').props.onClick()
  await flush()
  expect(call.mock.calls.some(([method]) => method === 'entity.update')).toBe(false)
  expect(JSON.stringify(tree())).toContain('A setting can have up to 200 members')
})

it('marks the current style and offers replacement even when the cast is full', async () => {
  const { host } = fixture([setting('current', { kind: 'style' }), setting('replacement', { kind: 'style' }), setting('cast')])
  const tree = () => render('picker', () => SettingPicker({
    host, castIds: ['cast'], styleId: 'current', castLimitReached: true, onPick: vi.fn(), onClose() {},
  } as Parameters<typeof SettingPicker>[0]))
  tree(); await flush()
  const cards = elements(tree()).filter(item => item.type === SettingCard)
  expect(cards.find(item => item.props.entity.id === 'current')!.props.disabled).toBe(true)
  expect(cards.find(item => item.props.entity.id === 'replacement')!.props.disabled).toBe(false)
  expect(JSON.stringify(tree())).toContain('Current style')
  expect(JSON.stringify(tree())).toContain('Replaces the current style')
})
