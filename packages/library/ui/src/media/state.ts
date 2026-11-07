import type { LibraryAsset, MediaKind, MethodParams, MethodResult, SpaceEvent } from '@vis/protocol'
import type { LibraryCoreHost } from '../host'
import type { LibraryTab } from '../types'

export type MediaFilters = { query: string; tag?: string | undefined; unused: boolean; unlabeled: boolean; archived: boolean; entityId?: string | undefined }
export type AssetPage = MethodResult<'asset.list'>
export const emptyFilters: MediaFilters = { query: '', unused: false, unlabeled: false, archived: false }

export function listParams(filters: MediaFilters, kind: MediaKind, category?: string | null): MethodParams<'asset.list'> {
  return {
    kind, limit: 100, usage: filters.unused ? 'unused' : 'all', archived: filters.archived,
    ...(filters.query.trim() ? { query: filters.query.trim() } : {}),
    ...(filters.tag ? { tag: filters.tag } : {}),
    ...(filters.entityId ? { entityId: filters.entityId } : {}),
    ...(filters.unlabeled ? { labeled: false } : {}),
    ...(category !== undefined ? { category } : {}),
  }
}

// Fonts and other files are accepted by the upload route but never shown in the library, so only media is imported.
export function libraryMediaFiles<T extends { type: string }>(files: T[]): T[] {
  return files.filter(file => /^(image|video|audio)\//.test(file.type))
}

export function mergePage(previous: AssetPage, page: AssetPage): AssetPage {
  const byId = new Map(previous.items.map(asset => [asset.assetId, asset]))
  for (const asset of page.items) byId.set(asset.assetId, asset)
  return { items: [...byId.values()], ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), ...(page.facets ?? previous.facets ? { facets: page.facets ?? previous.facets } : {}) }
}

export function refreshesMedia(event: SpaceEvent): boolean {
  return ['asset.updated', 'asset.versionAdded', 'library.changed', 'node.created', 'node.deleted', 'slot.revised', 'node.updated'].includes(event.type) || event.type.startsWith('entity.')
}

export type LibraryPreference = { open: boolean; tab: LibraryTab }
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>
export function readLibraryPreference(projectId: string, storage?: PreferenceStorage): LibraryPreference {
  try {
    const value = JSON.parse((storage ?? globalThis.localStorage).getItem(`vis.library.${projectId}`) ?? '{}')
    return { open: value.open === true, tab: value.tab === 'settings' ? 'settings' : 'media' }
  } catch { return { open: false, tab: 'media' } }
}
export function writeLibraryPreference(projectId: string, value: LibraryPreference, storage?: PreferenceStorage): void {
  try { (storage ?? globalThis.localStorage).setItem(`vis.library.${projectId}`, JSON.stringify(value)) } catch { /* Preferences are optional in private browser sessions. */ }
}

type AssetEdit = Omit<MethodParams<'asset.update'>, 'assetId' | 'expectedRevision'>
export async function updateAsset(host: LibraryCoreHost, asset: LibraryAsset, fields: AssetEdit): Promise<LibraryAsset> {
  try { return await host.call('asset.update', { assetId: asset.assetId, expectedRevision: asset.revision, ...fields }) }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'revision_conflict') throw error
    // The contract has no get-by-asset-id metadata read; conflicts are rare and require a fresh revision.
    // Another client may have archived or restored it meanwhile, so look in the current state first, then the other.
    for (const archived of [asset.archived, !asset.archived]) {
      let cursor: string | undefined
      do {
        const page = await host.call('asset.list', { kind: asset.kind, archived, usage: 'all', limit: 200, cursor })
        const fresh = page.items.find(item => item.assetId === asset.assetId)
        if (fresh) return host.call('asset.update', { assetId: asset.assetId, expectedRevision: fresh.revision, ...fields })
        cursor = page.nextCursor
      } while (cursor)
    }
    throw error
  }
}
