import { expect, it } from 'vitest'
import type { EntityView, SeriesEntityView } from '@vis/protocol'
import { seriesBadges, seriesMoved, seriesUpdateCount, unusedSeriesSettings } from './series-model'

const local: EntityView = {
  id: 'hero', kind: 'character', name: 'Hero', description: '', refs: [], members: [],
  revision: 2, createdAt: 1, updatedAt: 2, usage: { scriptNodeIds: [], shotCount: 2 },
}
const linked = { ...local, series: { seriesEntityId: 'shared-hero', revision: 3, latestRevision: 4, modifiedLocally: true } }
const shared = (id: string, name: string, description = ''): SeriesEntityView => ({
  seriesEntityId: id, kind: 'character', latest: { name, description, revision: 1, refs: [], hasVoice: false, publishedAt: 1 },
})

it('shows pinned, newer and modified badges independently', () => {
  expect(seriesBadges(local)).toEqual({ revision: undefined, newer: false, modified: false })
  expect(seriesBadges(linked)).toEqual({ revision: 3, newer: true, modified: true })
  expect(seriesBadges({ ...linked, series: { ...linked.series, latestRevision: 3, modifiedLocally: false } }))
    .toEqual({ revision: 3, newer: false, modified: false })
})

it('counts settings with newer versions without counting local-only edits or deleted settings', () => {
  expect(seriesUpdateCount([local, linked, { ...linked, id: 'deleted', deletedAt: 3 },
    { ...linked, id: 'modified', series: { ...linked.series, latestRevision: 3 } }])).toBe(1)
})

it('filters the collapsed section by both name and description and excludes linked settings', () => {
  const items = [shared('one', 'Hero', 'Blue coat'), { ...shared('two', 'Hero twin'), linkedEntityId: 'local' }, shared('three', 'Station')]
  expect(unusedSeriesSettings(items).map(item => item.seriesEntityId)).toEqual(['one', 'three'])
  expect(unusedSeriesSettings(items, ' COAT ').map(item => item.seriesEntityId)).toEqual(['one'])
  expect(unusedSeriesSettings(items, 'station').map(item => item.seriesEntityId)).toEqual(['three'])
})

it('enters the publish choice state only for a moved series revision', () => {
  expect(seriesMoved({ code: 'revision_conflict', details: { reason: 'entity.series_moved' } })).toBe(true)
  expect(seriesMoved({ code: 'revision_conflict', data: { reason: 'entity.series_moved' } })).toBe(true)
  expect(seriesMoved({ code: 'revision_conflict', data: { details: { reason: 'entity.series_moved' } } })).toBe(true)
  expect(seriesMoved({ code: 'revision_conflict' })).toBe(false)
  expect(seriesMoved({ code: 'invalid_params', details: { reason: 'entity.series_moved' } })).toBe(false)
  expect(seriesMoved(null)).toBe(false)
})
