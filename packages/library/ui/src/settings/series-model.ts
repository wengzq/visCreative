import type { EntityView, SeriesEntityView } from '@vis/protocol'

export function seriesBadges(entity: EntityView) {
  return {
    revision: entity.series?.revision,
    newer: !!entity.series && entity.series.latestRevision > entity.series.revision,
    modified: entity.series?.modifiedLocally ?? false,
  }
}

export const seriesUpdateCount = (items: readonly EntityView[]) => items.filter(item => !item.deletedAt && seriesBadges(item).newer).length

export function unusedSeriesSettings(items: readonly SeriesEntityView[], query = '') {
  const needle = query.trim().toLocaleLowerCase()
  return items.filter(item => !item.linkedEntityId && (!needle ||
    `${item.latest.name}\n${item.latest.description}`.toLocaleLowerCase().includes(needle)))
}

export function seriesMoved(error: unknown): boolean {
  const value = error as { code?: string; details?: { reason?: string }; data?: { reason?: string; details?: { reason?: string } } } | null
  return value?.code === 'revision_conflict' &&
    (value.details?.reason ?? value.data?.details?.reason ?? value.data?.reason) === 'entity.series_moved'
}
