import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@vis/protocol'
import { loadProviderConfig, saveProviderConfig } from './provider-config'

let dir: string
const limits = { maxConcurrent: 3, dailyImage: 50, dailyVideo: 10, dailyAudio: 20 }
const config: ProviderConfig = {
  limits,
  providers: [{
    id: 'ark', type: 'volcengine-ark', label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    imageModels: [{ id: 'image-model', label: '图片' }], videoModels: [{ id: 'video-model', label: '视频' }], audioModels: [],
  }],
  defaults: { image: { provider: 'ark', model: 'image-model' }, video: { provider: 'ark', model: 'video-model' } },
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vis-provider-config-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('Provider configuration file', () => {
  it('round trips the current file shape byte for byte without adding registry fields', () => {
    const before = JSON.stringify(config)
    writeFileSync(join(dir, 'providers.json'), before)
    saveProviderConfig(dir, loadProviderConfig(dir))
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).toBe(before)
  })
  it('returns empty providers and default models when configuration is missing', () => {
    expect(loadProviderConfig(join(dir, 'new'))).toEqual({ providers: [], defaults: {}, limits })
  })

  it('creates directories and atomically replaces configuration without leaving temporary files', () => {
    const target = join(dir, 'nested')
    saveProviderConfig(target, config)
    expect(loadProviderConfig(target)).toEqual(config)
    saveProviderConfig(target, { providers: [], defaults: {}, limits })
    expect(loadProviderConfig(target)).toEqual({ providers: [], defaults: {}, limits })
    expect(readdirSync(target)).toEqual(['providers.json'])
  })

  it.runIf(process.platform !== 'win32')('POSIX: configuration file mode bits restrict access to the current user', () => {
    saveProviderConfig(dir, config)
    expect(statSync(join(dir, 'providers.json')).mode & 0o777).toBe(0o600)
  })

  it('validates before writing and preserves the original configuration on failure', () => {
    saveProviderConfig(dir, config)
    const before = readFileSync(join(dir, 'providers.json'), 'utf8')
    expect(() => saveProviderConfig(dir, { providers: [{}], defaults: {} } as ProviderConfig)).toThrow()
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).toBe(before)
    expect(readdirSync(dir)).toEqual(['providers.json'])
  })

  it('cleans temporary files on replacement failure and preserves existing content', () => {
    const destination = join(dir, 'providers.json')
    mkdirSync(destination)
    writeFileSync(join(destination, 'existing'), 'preserve')
    expect(() => saveProviderConfig(dir, config)).toThrow()
    expect(readdirSync(dir)).toEqual(['providers.json'])
    expect(readFileSync(join(destination, 'existing'), 'utf8')).toBe('preserve')
  })

  it('does not serialize API keys into configuration files', () => {
    saveProviderConfig(dir, config)
    for (const withSecret of [
      { ...config, apiKey: 'must-not-be-written' },
      { ...config, providers: config.providers.map(provider => ({ ...provider, apiKey: 'must-not-be-written' })) },
    ]) expect(() => saveProviderConfig(dir, withSecret)).toThrow()
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).not.toContain('must-not-be-written')
    expect(loadProviderConfig(dir)).toEqual(config)
  })

  it('fills in the default Ark endpoint when reading configuration', () => {
    const bytes = JSON.stringify({
      ...config, providers: config.providers.map(({ baseUrl, ...provider }) => provider),
    }, null, 4)
    writeFileSync(join(dir, 'providers.json'), bytes)
    expect(loadProviderConfig(dir)).toEqual(config)
    saveProviderConfig(dir, loadProviderConfig(dir))
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).toBe(bytes)
  })

  it('reports corrupt or schema-invalid configuration without silently overwriting it', () => {
    const path = join(dir, 'providers.json')
    for (const contents of ['{', '{"providers":[{}],"defaults":{}}']) {
      writeFileSync(path, contents)
      expect(() => loadProviderConfig(dir)).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(contents)
    }
  })
})
