import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProviderConfigSchema, type HostingConfig } from '@vis/protocol'
import { loadHostingConfig, saveHostingConfig } from './hosting-config'
import { loadProviderConfig, saveProviderConfig } from './provider-config'

let dir: string
const config: HostingConfig = { type: 'tos', region: 'cn-beijing', bucket: 'reference-clips', accessKeyId: 'example-access-key', prefix: 'vis-creative/refs/' }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vis-hosting-config-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('Hosting configuration file', () => {
  it('returns null for missing configuration without creating a file', () => {
    expect(loadHostingConfig(join(dir, 'missing'))).toBeNull()
    expect(readdirSync(dir)).toEqual([])
  })

  it('round trips valid configuration without rewriting unchanged author formatting', () => {
    const { prefix: _prefix, ...withoutPrefix } = config
    const before = JSON.stringify(withoutPrefix, null, 4)
    writeFileSync(join(dir, 'hosting.json'), before)
    expect(loadHostingConfig(dir)).toEqual(config)
    saveHostingConfig(dir, config)
    expect(readFileSync(join(dir, 'hosting.json'), 'utf8')).toBe(before)
  })

  it('creates directories and atomically replaces hosting without temporary files', () => {
    const target = join(dir, 'nested')
    saveHostingConfig(target, config)
    expect(loadHostingConfig(target)).toEqual(config)
    const replacement = { ...config, bucket: 'other-clips' }
    saveHostingConfig(target, replacement)
    expect(loadHostingConfig(target)).toEqual(replacement)
    expect(readdirSync(target)).toEqual(['hosting.json'])
  })

  it.runIf(process.platform !== 'win32')('POSIX: hosting files are private on creation and replacement', () => {
    saveHostingConfig(dir, config)
    expect(statSync(join(dir, 'hosting.json')).mode & 0o777).toBe(0o600)
    writeFileSync(join(dir, 'hosting.json'), '{}')
    chmodSync(join(dir, 'hosting.json'), 0o644)
    saveHostingConfig(dir, config)
    expect(statSync(join(dir, 'hosting.json')).mode & 0o777).toBe(0o600)
  })

  it('leaves malformed hosting untouched and keeps provider loading and saving independent', () => {
    const providers = ProviderConfigSchema.parse({ providers: [], defaults: {} })
    saveProviderConfig(dir, providers)
    for (const contents of ['{', '{}', 'null', JSON.stringify({ ...config, prefix: 'bad path/' })]) {
      writeFileSync(join(dir, 'hosting.json'), contents)
      expect(loadHostingConfig(dir)).toBeNull()
      expect(loadProviderConfig(dir)).toEqual(providers)
      saveProviderConfig(dir, providers)
      expect(readFileSync(join(dir, 'hosting.json'), 'utf8')).toBe(contents)
    }
    saveHostingConfig(dir, config)
    saveProviderConfig(dir, { ...providers, limits: { ...providers.limits, dailyVideo: 1 } })
    expect(loadHostingConfig(dir)).toEqual(config)
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).not.toContain('hosting')
  })

  it('rejects invalid settings and secret fields before changing any file', () => {
    saveHostingConfig(dir, config)
    const before = readFileSync(join(dir, 'hosting.json'), 'utf8')
    for (const invalid of [{ ...config, prefix: '/refs/' }, { ...config, secret: 'must-not-be-written' }]) {
      expect(() => saveHostingConfig(dir, invalid)).toThrow()
      expect(readFileSync(join(dir, 'hosting.json'), 'utf8')).toBe(before)
    }
    expect(readdirSync(dir)).toEqual(['hosting.json'])
  })

  it('cleans temporary files on replacement failure without changing existing content', () => {
    mkdirSync(join(dir, 'hosting.json'))
    writeFileSync(join(dir, 'hosting.json', 'existing'), 'preserve')
    expect(() => saveHostingConfig(dir, config)).toThrow()
    expect(readdirSync(dir)).toEqual(['hosting.json'])
    expect(readFileSync(join(dir, 'hosting.json', 'existing'), 'utf8')).toBe('preserve')
  })

  it('clears only hosting configuration and treats repeated removal as a no-op', () => {
    saveProviderConfig(dir, ProviderConfigSchema.parse({ providers: [], defaults: {} }))
    saveHostingConfig(dir, config)
    saveHostingConfig(dir, null)
    saveHostingConfig(dir, null)
    expect(loadHostingConfig(dir)).toBeNull()
    expect(readdirSync(dir)).toEqual(['providers.json'])
  })
})
