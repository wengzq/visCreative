import { describe, expect, it } from 'vitest'
import type { LibraryAsset, SpaceEvent } from '@vis/protocol'
import { emptyFilters, libraryMediaFiles, listParams, mergePage, readLibraryPreference, refreshesMedia, updateAsset, writeLibraryPreference } from './state'
import { mediaDuration, virtualWindow } from './VirtualMedia'
import type { LibraryCoreHost } from '../host'

describe('media library state', () => {
  it('imports only images, video and audio', () => {
    const files = ['image/png', 'video/mp4', 'audio/mpeg', 'font/ttf', ''].map(type => ({ type }))
    expect(libraryMediaFiles(files).map(file => file.type)).toEqual(['image/png', 'video/mp4', 'audio/mpeg'])
  })
  it('maps global filters and uncategorized selection to protocol parameters without blank queries', () => {
    expect(listParams(emptyFilters, 'image')).toEqual({ kind: 'image', limit: 100, usage: 'all', archived: false })
    expect(listParams({ query: '  hero  ', unused: true, unlabeled: true, archived: true, entityId: 'hero', tag: 'closeup' }, 'video', null))
      .toEqual({ kind: 'video', limit: 100, query: 'hero', usage: 'unused', labeled: false, archived: true, entityId: 'hero', tag: 'closeup', category: null })
    expect(listParams({ ...emptyFilters, query: '   ' }, 'audio')).not.toHaveProperty('query')
  })

  it('merges overlapping cursor pages by asset id, preserves facets and removes the exhausted cursor', () => {
    const a = { assetId: 'a', revision: 1 } as LibraryAsset
    const b = { assetId: 'b', revision: 1 } as LibraryAsset
    const facets = { categories: [{ name: null, count: 3 }], tags: [] }
    const page = mergePage({ items: [a, b], facets, nextCursor: 'second' }, { items: [{ ...b, revision: 2 }, { assetId: 'c' } as LibraryAsset] })
    expect(page.items.map(asset => [asset.assetId, asset.revision])).toEqual([['a', 1], ['b', 2], ['c', undefined]])
    expect(page.facets).toBe(facets)
    expect(page).not.toHaveProperty('nextCursor')
  })

  it('refreshes metadata, usage and setting changes while ignoring transcript churn', () => {
    const event = (type: SpaceEvent['type']) => ({ type } as SpaceEvent)
    for (const type of ['asset.updated', 'asset.versionAdded', 'library.changed', 'entity.updated', 'slot.revised', 'node.deleted'] as const) expect(refreshesMedia(event(type))).toBe(true)
    expect(refreshesMedia(event('transcript.itemUpserted'))).toBe(false)
    expect(refreshesMedia(event('message.stateChanged'))).toBe(false)
  })

  it('persists open state and selected tab separately for each project and recovers from invalid storage', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    writeLibraryPreference('a', { open: true, tab: 'settings' }, storage)
    expect(readLibraryPreference('a', storage)).toEqual({ open: true, tab: 'settings' })
    expect(readLibraryPreference('b', storage)).toEqual({ open: false, tab: 'media' })
    values.set('vis.library.a', '{')
    expect(readLibraryPreference('a', storage)).toEqual({ open: false, tab: 'media' })
    const unavailable = { getItem() { throw new Error('Unavailable storage') }, setItem() { throw new Error('Unavailable storage') } }
    expect(readLibraryPreference('a', unavailable)).toEqual({ open: false, tab: 'media' })
    expect(() => writeLibraryPreference('a', { open: true, tab: 'media' }, unavailable)).not.toThrow()
  })

  it('rereads the revision and retries an edit only once after a conflict', async () => {
    const calls: [string, unknown][] = []
    const asset = { assetId: 'a', kind: 'image', archived: false, revision: 1 } as LibraryAsset
    const host = { async call(method: string, params: unknown) {
      calls.push([method, params])
      if (calls.length === 1) throw { code: 'revision_conflict' }
      if (method === 'asset.list') return { items: [{ ...asset, revision: 3 }] }
      return { ...asset, revision: 4 }
    } } as unknown as LibraryCoreHost
    expect((await updateAsset(host, asset, { displayName: 'My hero' })).revision).toBe(4)
    expect(calls.map(([method]) => method)).toEqual(['asset.update', 'asset.list', 'asset.update'])
    expect(calls[2]?.[1]).toMatchObject({ expectedRevision: 3, displayName: 'My hero' })
  })

  it('finds a conflicting asset that another client archived meanwhile', async () => {
    const calls: [string, { archived?: boolean }][] = []
    const asset = { assetId: 'a', kind: 'image', archived: false, revision: 1 } as LibraryAsset
    const host = { async call(method: string, params: { archived?: boolean }) {
      calls.push([method, params])
      if (calls.length === 1) throw { code: 'revision_conflict' }
      if (method === 'asset.list') return { items: params.archived ? [{ ...asset, archived: true, revision: 2 }] : [] }
      return { ...asset, archived: true, revision: 3 }
    } } as unknown as LibraryCoreHost
    expect((await updateAsset(host, asset, { displayName: 'My hero' })).revision).toBe(3)
    expect(calls.filter(([method]) => method === 'asset.list').map(([, params]) => params.archived)).toEqual([false, true])
    expect(calls.at(-1)?.[1]).toMatchObject({ expectedRevision: 2 })
  })

  it('keeps the rendered window bounded for one thousand assets and includes the final row', () => {
    const first = virtualWindow(1000, 3, 178, 0, 330)
    const middle = virtualWindow(1000, 3, 178, 20_000, 330)
    const last = virtualWindow(1000, 3, 178, 59_200, 330)
    expect(first.end - first.start).toBeLessThanOrEqual(15)
    expect(middle.end - middle.start).toBeLessThanOrEqual(15)
    expect(last.end).toBe(1000)
    expect(last.total).toBe(334 * 178)
    const resized = virtualWindow(1000, 5, 144, 59_200, 330)
    expect(resized.end).toBe(1000)
    expect(resized.start).toBeLessThan(1000)
  })

  it('formats short audio and video durations consistently as minutes and seconds', () => {
    expect(mediaDuration(2000, String)).toBe('00:02')
    expect(mediaDuration(65000, String)).toBe('01:05')
  })
})
