import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HostingConfigSchema, type HostingConfig } from '@vis/protocol'

export function loadHostingConfig(dataDir: string): HostingConfig | null {
  try {
    return HostingConfigSchema.parse(JSON.parse(readFileSync(join(dataDir, 'hosting.json'), 'utf8')))
  } catch {
    // Hosting failures must not prevent generation providers from loading or overwrite the author's file.
    return null
  }
}

export function saveHostingConfig(dataDir: string, config: HostingConfig | null): void {
  const destination = join(dataDir, 'hosting.json')
  if (config === null) {
    rmSync(destination, { force: true })
    return
  }
  const parsed = HostingConfigSchema.parse(config)
  if (JSON.stringify(loadHostingConfig(dataDir)) === JSON.stringify(parsed)) return
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const temporary = join(dataDir, `hosting.json.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
}
