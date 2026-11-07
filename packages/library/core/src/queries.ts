import { sql, type SpaceTx } from '@vis/storage'

export const LABEL_WHITESPACE = ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'

export function searchLibraryAssets(tx: SpaceTx, where: ReturnType<typeof sql>, query: string) {
  // SQLite lower() only folds ASCII; keep JavaScript's Unicode matching over lightweight search text.
  const texts = tx.select({ assetId: sql<string>`asset_id`, text: sql<string | null>`text` }).from(sql`(
    with eligible as (select id, display_name from assets where kind in ('image', 'video', 'audio') and ${where})
    select id as asset_id, display_name as text from eligible
    union all select t.asset_id, t.tag from eligible a join asset_tags t on t.asset_id = a.id
    union all select av.asset_id, n.title from eligible a
      join asset_versions av on av.asset_id = a.id
      join slot_revisions sr on sr.asset_version_id = av.id
      join slots sl on sl.id = sr.slot_id and sl.current_revision = sr.revision and sl.deleted_at is null
      join nodes n on n.id = sl.node_id and n.deleted_at is null
  )`).all()
  const ids = [...new Set(texts.filter(row => row.text?.toLowerCase().includes(query)).map(row => row.assetId))]
  return ids.length ? sql`${where} and id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})` : sql`0`
}

// Restrict assets before joining their canvas usage; first-page facets use their own unpaginated candidates.
export function libraryFacts(where = sql`1`) {
  return sql`with eligible as (
    select * from assets where kind in ('image', 'video', 'audio') and ${where}
  ), live_usage as (
    select distinct av.asset_id, n.id, n.title, n.category, n.created_at
    from eligible a
    join asset_versions av on av.asset_id = a.id
    join slot_revisions sr on sr.asset_version_id = av.id
    join slots sl on sl.id = sr.slot_id and sl.current_revision = sr.revision and sl.deleted_at is null
    join nodes n on n.id = sl.node_id and n.deleted_at is null
  ), usage as (
    select asset_id, count(*) as usage_count,
      max(case when title is not null and title != '' then 1 else 0 end) as has_title
    from live_usage group by asset_id
  ), categories as (
    select asset_id, category, row_number() over (partition by asset_id order by created_at desc, id desc) as rank
    from live_usage where category is not null
  ), exports as (
    select distinct av.asset_id from eligible a
    join asset_versions av on av.asset_id = a.id
    join slot_revisions sr on sr.asset_version_id = av.id and sr.revision = 1
    join slots sl on sl.id = sr.slot_id
    join nodes n on n.id = sl.node_id and n.export_of is not null
  ), facts as (
    select a.*, coalesce(u.usage_count, 0) as usage_count, coalesce(u.has_title, 0) as has_title,
      coalesce(a.category, c.category, case when a.kind = 'video' and e.asset_id is not null then '成片' end) as effective_category
    from eligible a
    left join usage u on u.asset_id = a.id
    left join categories c on c.asset_id = a.id and c.rank = 1
    left join exports e on e.asset_id = a.id
    where exists (select 1 from asset_versions av where av.asset_id = a.id)
  )`
}

export function libraryVisibility(usage: 'all' | 'used' | 'unused', query?: string) {
  return sql`${usage === 'all' ? sql`1` : usage === 'used' ? sql`usage_count > 0` : sql`usage_count = 0`}
    and (origin != 'derived' or usage_count > 0 or ${Number(usage === 'unused' || !!query)})`
}
