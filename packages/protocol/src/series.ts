import { z } from 'zod'
import { Id, RequestId, Revision } from './common'
import { ENTITY_LIMITS, EntityKind, EntityView } from './entity'

// 0027 step c: series share settings across episodes (one project = one episode). Projects link copies pinned to
// a series revision; nothing in a project changes until the user updates it. See docs/rfc/0027 §3.

export const SERIES_LIMITS = { name: 60, episode: 9999 } as const

const SeriesName = z.string().trim().min(1).max(SERIES_LIMITS.name)
export const Episode = z.int().min(1).max(SERIES_LIMITS.episode)

export const SeriesEpisode = z.object({ spaceId: Id, name: z.string(), episode: Episode })
export const SeriesView = z.object({
  seriesId: Id,
  name: z.string(),
  createdAt: z.int(),
  // Live series settings, for the join dialog's checklist defaults
  settingCount: z.int().nonnegative(),
  // Live projects only, ordered by episode
  episodes: z.array(SeriesEpisode),
})
export type SeriesView = z.infer<typeof SeriesView>

// A project's place in a series, carried by SpaceSummary
export const SpaceSeries = z.object({ seriesId: Id, name: z.string(), episode: Episode })
export type SpaceSeries = z.infer<typeof SpaceSeries>

// Join an existing series or create one by name
export const SeriesTarget = z.union([z.object({ seriesId: Id }), z.object({ name: SeriesName })])
export type SeriesTarget = z.infer<typeof SeriesTarget>

// Series refs live in the series blob store; the UI loads them through the studiod series media route
export const SeriesRef = z.object({
  refId: Id,
  mime: z.string(),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
})
export type SeriesRef = z.infer<typeof SeriesRef>

export const SeriesRevisionView = z.object({
  revision: Revision,
  name: z.string(),
  description: z.string(),
  refs: z.array(SeriesRef).max(ENTITY_LIMITS.refs),
  hasVoice: z.boolean(),
  publishedAt: z.int(),
  // Project the revision was published from; may have been deleted since
  publishedFromSpaceId: Id.optional(),
})
export type SeriesRevisionView = z.infer<typeof SeriesRevisionView>

export const SeriesEntityView = z.object({
  seriesEntityId: Id,
  kind: EntityKind,
  latest: SeriesRevisionView,
  // The calling project's setting linked to this series setting, if any
  linkedEntityId: Id.optional(),
  linkedRevision: Revision.optional(),
})
export type SeriesEntityView = z.infer<typeof SeriesEntityView>

// App-level methods (UI connection, no project context)
export const series = {
  list: {
    params: z.object({}),
    result: z.object({ items: z.array(SeriesView) }),
  },
  create: {
    params: z.object({ requestId: RequestId, name: SeriesName }),
    result: SeriesView,
  },
  rename: {
    params: z.object({ seriesId: Id, name: SeriesName }),
    result: SeriesView,
  },
  // Detaches every episode: linked settings become episode-only settings with the same content
  delete: {
    params: z.object({ requestId: RequestId, seriesId: Id }),
    result: z.object({ seriesId: Id, detachedSpaceIds: z.array(Id) }),
  },
  // Project-level: settings of the calling project's series
  entityList: {
    params: z.object({ kind: EntityKind.optional(), query: z.string().max(200).optional() }),
    result: z.object({ series: z.object({ seriesId: Id, name: z.string() }).nullable(), items: z.array(SeriesEntityView) }),
  },
  mediaGet: {
    params: z.object({ seriesId: Id, refId: Id }),
    result: z.object({ path: z.string(), mime: z.string() }),
  },
} as const

// App-level: join, move within or leave a series (series: null leaves; every setting stays as an episode-only setting)
export const spaceSeries = {
  setSeries: {
    params: z.object({
      requestId: RequestId,
      spaceId: Id,
      series: SeriesTarget.nullable(),
      // Defaults to the next free episode number
      episode: Episode.optional(),
      // Settings of this project to publish into the series right after joining (the join dialog checklist)
      publishEntityIds: z.array(Id).max(ENTITY_LIMITS.members).optional(),
    }),
    result: z.object({ spaceId: Id, series: SpaceSeries.nullable(), published: z.array(Id), failed: z.array(z.object({ entityId: Id, code: z.string() })) }),
  },
} as const

// Project-level methods on settings
export const seriesEntity = {
  // Copies the series setting's latest revision into this project. replaceEntityId (UI only) turns an existing
  // same-kind, same-name setting into the linked copy, keeping its id so scripts keep their cast.
  link: {
    params: z.object({ requestId: RequestId, seriesEntityId: Id, replaceEntityId: Id.optional(), expectedRevision: Revision.optional() }),
    result: EntityView,
  },
  diff: {
    params: z.object({ entityId: Id }),
    result: z.object({ entity: EntityView, pinned: SeriesRevisionView, latest: SeriesRevisionView }),
  },
  updateFromSeries: {
    params: z.object({ requestId: RequestId, entityId: Id, expectedRevision: Revision }),
    result: EntityView,
  },
  // Publishes this setting as the next series revision (or a new series setting when not linked).
  // When the series moved on since the pin, omitting resolve returns revision_conflict (entity.series_moved) with
  // params.seriesRevision; overwrite publishes anyway, takeSeries discards local edits and links the latest revision.
  publish: {
    params: z.object({ requestId: RequestId, entityId: Id, expectedRevision: Revision, resolve: z.enum(['overwrite', 'takeSeries']).optional() }),
    result: z.object({ entity: EntityView, seriesEntityId: Id, seriesRevision: Revision }),
  },
  // Replaces local edits with the pinned revision; never pulls a newer one
  resetToSeries: {
    params: z.object({ requestId: RequestId, entityId: Id, expectedRevision: Revision }),
    result: EntityView,
  },
} as const
