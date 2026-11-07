import type { SeriesProjectHost } from '@vis/workbench-ui'
import type { SpaceConnection } from './space'

export function createSeriesProjectHost(conn: SpaceConnection): SeriesProjectHost {
  return {
    list: async () => (await conn.rpc.call('series.list', {})).items,
    settings: async spaceId => (await conn.rpc.call('entity.list', { spaceId, includeDeleted: false })).items,
    async setSeries(params) {
      const result = await conn.rpc.call('space.setSeries', params)
      await conn.refreshProjects()
      return result
    },
    async deleteSeries(seriesId) {
      await conn.rpc.call('series.delete', { requestId: crypto.randomUUID(), seriesId })
      await conn.refreshProjects()
    },
  }
}
