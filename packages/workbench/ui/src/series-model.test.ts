import { expect, it } from 'vitest'
import type { EntityView, SeriesView } from '@vis/protocol'
import { groupProjects, joinChecklist, nextEpisode } from './series-model'

const series: SeriesView = { seriesId: 'series', name: 'Series', settingCount: 0, createdAt: 1,
  episodes: [{ spaceId: 'one', name: 'One', episode: 1 }, { spaceId: 'three', name: 'Three', episode: 3 }] }

it('defaults new series to episode one and existing series to the next free episode', () => {
  expect(nextEpisode()).toBe(1)
  expect(nextEpisode(series)).toBe(4)
})

it('fills a gap only when the latest episode reaches the episode limit', () => {
  expect(nextEpisode({ ...series, episodes: [...series.episodes, { spaceId: 'last', name: 'Last', episode: 9999 }] })).toBe(2)
})

it('ticks all settings for an empty series and none for a populated series', () => {
  const entities = [{ id: 'hero' }, { id: 'station' }] as EntityView[]
  expect(joinChecklist(entities, 0)).toEqual(['hero', 'station'])
  expect(joinChecklist(entities, 1)).toEqual([])
  expect(joinChecklist([], 0)).toEqual([])
})

it('groups series projects by episode and keeps standalone projects after them', () => {
  const project = (spaceId: string, episode: number) => ({ spaceId, series: { seriesId: 'series', name: 'Series', episode } })
  const standalone = { spaceId: 'standalone' }
  const result = groupProjects([project('three', 3), standalone, project('one', 1)])
  expect(result.series).toEqual([{ seriesId: 'series', name: 'Series', projects: [project('one', 1), project('three', 3)] }])
  expect(result.standalone).toEqual([standalone])
})
