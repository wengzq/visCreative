import type { AppDb, SpaceDb } from '@vis/storage'

const probes = new WeakMap<AppDb['$client'], () => string>()

export function databaseVersion(db: AppDb | SpaceDb): string | undefined {
  // data_version covers other connections, total_changes covers this one but does not roll back.
  // Never cache an unchanged result for undefined: a transaction may expose writes that later roll back.
  if (db.$client.inTransaction) return undefined
  let probe = probes.get(db.$client)
  if (!probe) {
    const statement = db.$client.prepare('SELECT total_changes() AS changes, data_version AS version FROM pragma_data_version')
    probe = () => {
      const row = statement.get() as { changes: number; version: number }
      return `${row.changes}:${row.version}`
    }
    probes.set(db.$client, probe)
  }
  return probe()
}
