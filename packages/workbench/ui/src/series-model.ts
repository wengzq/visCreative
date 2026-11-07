import type { EntityView, SeriesTarget, SeriesView, SpaceSeries, spaceSeries } from '@vis/protocol'
import { SERIES_LIMITS } from '@vis/protocol'

export type ProjectSeriesInput = { series?: SeriesTarget; episode?: number }
export type SeriesProjectHost = {
  list(): Promise<SeriesView[]>
  settings(spaceId: string): Promise<EntityView[]>
  setSeries(params: ReturnType<typeof spaceSeries.setSeries.params.parse>): Promise<ReturnType<typeof spaceSeries.setSeries.result.parse>>
  deleteSeries(seriesId: string): Promise<void>
}

export function nextEpisode(series?: SeriesView): number {
  const used = new Set(series?.episodes.map(item => item.episode))
  const next = Math.max(0, ...used) + 1
  if (next <= SERIES_LIMITS.episode) return next
  let episode = 1
  while (episode < SERIES_LIMITS.episode && used.has(episode)) episode++
  return episode
}

export const joinChecklist = (entities: readonly EntityView[], settingCount: number) =>
  settingCount === 0 ? entities.map(item => item.id) : []

export function groupProjects<T extends { spaceId: string; series?: SpaceSeries | undefined }>(projects: readonly T[]) {
  const grouped = new Map<string, { seriesId: string; name: string; projects: T[] }>()
  for (const item of projects) {
    if (!item.series) continue
    let group = grouped.get(item.series.seriesId)
    if (!group) {
      group = { seriesId: item.series.seriesId, name: item.series.name, projects: [] }
      grouped.set(item.series.seriesId, group)
    }
    group.projects.push(item)
  }
  for (const group of grouped.values()) group.projects.sort((a, b) => a.series!.episode - b.series!.episode)
  return { series: [...grouped.values()], standalone: projects.filter(item => !item.series) }
}
