import { VisError } from '@vis/domain'
import { writingChapters, type MethodParams, type MethodResult } from '@vis/protocol'
import { appSchema as a, eq, fingerprint, type AppDb } from '@vis/storage'
import type { SpaceHost, SpaceRegistry } from './space-host'

type Plan = {
  seriesId: string | null
  body: string
  format: 'plain' | 'markdown'
  results: MethodResult<'writing.split'>['chapters']
}

/** A durable snapshot bridges separate project transactions; completed chapters are never written twice. */
export function splitWriting(db: AppDb, spaces: SpaceRegistry, host: SpaceHost, params: MethodParams<'writing.split'>): MethodResult<'writing.split'> {
  const fp = fingerprint('writing.split', { spaceId: host.spaceId, ...params })
  const known = db.select().from(a.idempotencyKeys).where(eq(a.idempotencyKeys.requestId, params.requestId)).get()
  if (known && known.fingerprint !== fp) throw VisError.of('idempotency_conflict', 'request.id_conflict', {}, 'requestId has already been used for a different request')
  const save = (plan: Plan) => db.insert(a.idempotencyKeys).values({ requestId: params.requestId, fingerprint: fp, result: plan })
    .onConflictDoUpdate({ target: a.idempotencyKeys.requestId, set: { result: plan } }).run()
  let plan = known?.result as Plan | undefined
  if (!plan) {
    const node = host.canvas.get({ nodeIds: [params.nodeId] }).nodes[0]
    const slot = node?.slots.find(slot => slot.slotKey === 'main')
    if (node?.kind !== 'text' || node.format === 'code' || slot?.content.type !== 'text') throw VisError.of('invalid_params', 'writing.manuscript_not_found', {}, 'A non-code manuscript is required')
    if (slot.revision !== params.expectedRevision) throw VisError.of('revision_conflict', 'writing.split_changed', {}, 'The manuscript changed; reread before splitting')
    const body = slot.content.body
    const chapters = writingChapters(body)
    if (params.chapters.some(chapter => !chapters.some(heading => heading.from === chapter.from && heading.to === chapter.to))) throw VisError.of('invalid_params', 'writing.split_chapter', {}, 'Each selected range must be a current outline chapter')
    const membership = spaces.series.membership(host.spaceId)
    if (membership && params.series && (!('seriesId' in params.series) || params.series.seriesId !== membership.seriesId)) throw VisError.of('invalid_params', 'writing.split_series', {}, 'Use the manuscript project series')
    if (!membership && !params.series) throw VisError.of('invalid_params', 'writing.split_series', {}, 'Choose a series before splitting')
    plan = { seriesId: membership?.seriesId ?? null, body, format: node.format === 'markdown' ? 'markdown' : 'plain', results: [] }
    save(plan)
  }
  // Derived request IDs fit the protocol limit even when the caller used all 128 characters.
  const key = (suffix: string) => `writing-split-${fp}-${suffix}`
  if (!plan.seriesId) {
    const joined = spaces.series.setSeries({ requestId: key('join'), spaceId: host.spaceId, series: params.series! })
    plan.seriesId = joined.series!.seriesId
    save(plan)
  }
  const results: Plan['results'] = []
  for (const [index, chapter] of params.chapters.entries()) {
    const previous = plan.results.find(result => result.from === chapter.from && result.status === 'succeeded')
    if (previous) { results.push({ ...previous, skipped: true }); continue }
    let spaceId: string | undefined
    try {
      const project = spaces.create({ requestId: key(`project-${index}`), name: chapter.name, series: { seriesId: plan.seriesId }, episode: chapter.episode })
      spaceId = project.spaceId
      const target = spaces.get(spaceId)
      if (!target) throw new Error('The new episode project is unavailable')
      const created = target.canvas.apply({ kind: 'user' }, { requestId: key(`text-${index}`), ops: [{ op: 'node.create', tempId: 'chapter', kind: 'text', title: chapter.name.slice(0, 60), format: plan.format, content: { text: plan.body.slice(chapter.from, chapter.to) } }] })
      results.push({ from: chapter.from, name: chapter.name, episode: chapter.episode, status: 'succeeded', skipped: false, spaceId, nodeId: created.idMap.chapter! })
    } catch (error) {
      results.push({ from: chapter.from, name: chapter.name, episode: chapter.episode, status: 'failed', skipped: false, ...(spaceId ? { spaceId } : {}), error: { code: error instanceof VisError ? error.code : 'internal', ...(error instanceof VisError && typeof error.details?.reason === 'string' ? { reason: error.details.reason } : {}) } })
    }
    plan.results = [...plan.results.filter(result => result.from !== chapter.from), results.at(-1)!]
    save(plan)
  }
  return { chapters: results }
}
