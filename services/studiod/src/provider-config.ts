import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ProviderConfigSchema, type ProviderConfig } from '@vis/protocol'

export function loadProviderConfig(dataDir: string): ProviderConfig {
  let contents: string
  try {
    contents = readFileSync(join(dataDir, 'providers.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ProviderConfigSchema.parse({ providers: [], defaults: {} })
    throw error
  }
  return ProviderConfigSchema.parse(JSON.parse(contents))
}

export function saveProviderConfig(dataDir: string, config: ProviderConfig): void {
  const parsed = ProviderConfigSchema.parse(config)
  try {
    const existing = readFileSync(join(dataDir, 'providers.json'), 'utf8')
    if (JSON.stringify(ProviderConfigSchema.parse(JSON.parse(existing))) === JSON.stringify(parsed)) return
  } catch { /* A missing or invalid file is replaced only by an explicitly validated save. */ }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const temporary = join(dataDir, `providers.json.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, join(dataDir, 'providers.json'))
  } finally {
    rmSync(temporary, { force: true })
  }
}
