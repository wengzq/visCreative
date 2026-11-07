import { describe, expect, it } from 'vitest'
import { METHODS, SERIES_METHODS } from './methods'
import { NOTIFICATIONS } from './events'
import { space } from './runtime'
import { series, seriesEntity, spaceSeries } from './series'

describe('0027 series contract', () => {
  it('registers the series group with its handlers', () => {
    for (const name of Object.keys(SERIES_METHODS)) expect(Object.hasOwn(METHODS, name), name).toBe(true)
  })

  it('lets agents only list and link series settings', () => {
    const agentMethods = Object.entries(SERIES_METHODS).filter(([, spec]) => (spec.callers as readonly string[]).includes('agent')).map(([name]) => name)
    expect(agentMethods.sort()).toEqual(['entity.link', 'series.entityList'])
  })

  it('targets a series by id or by a new name and creates episodes from space.create', () => {
    expect(space.create.params.safeParse({ requestId: 'r', name: 'Ep 3', series: { seriesId: 's1' }, episode: 3 }).success).toBe(true)
    expect(space.create.params.safeParse({ requestId: 'r', name: 'Ep 1', series: { name: '  山海少年 ' } }).success).toBe(true)
    expect(space.create.params.safeParse({ requestId: 'r', name: 'Ep 0', series: { seriesId: 's1' }, episode: 0 }).success).toBe(false)
    expect(series.create.params.safeParse({ requestId: 'r', name: '' }).success).toBe(false)
    expect(spaceSeries.setSeries.params.parse({ requestId: 'r', spaceId: 'p', series: null }).series).toBeNull()
  })

  it('publishes with an explicit conflict resolution and notifies series changes', () => {
    expect(seriesEntity.publish.params.safeParse({ requestId: 'r', entityId: 'e', expectedRevision: 2, resolve: 'merge' }).success).toBe(false)
    expect(seriesEntity.publish.params.safeParse({ requestId: 'r', entityId: 'e', expectedRevision: 2, resolve: 'takeSeries' }).success).toBe(true)
    expect(NOTIFICATIONS['events.seriesChanged'].parse({ seriesId: 's1' })).toEqual({ seriesId: 's1' })
  })
})
