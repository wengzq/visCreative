import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveDsh } from './resolve-dsh'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'vis-resolve-dsh-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

function executable(path: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(home, 'executed'))}, '')\n`, { mode: 0o755 })
  return path
}

function cached(entry: string, version: string) {
  const modules = join(home, '.npm', '_npx', entry, 'node_modules')
  const pkg = join(modules, '@deepseek-ai', 'dsh')
  const bin = executable(join(pkg, 'bin', 'dsh.js'))
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  mkdirSync(join(modules, '.bin'))
  const path = join(modules, '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  if (process.platform === 'win32') {
    writeFileSync(path, `@echo off\r\n"${process.execPath}" "%~dp0..\\@deepseek-ai\\dsh\\bin\\dsh.js" %*\r\n`)
  } else {
    symlinkSync(bin, path)
  }
  return { path, version }
}

const options = () => ({ env: { HOME: home } })

describe('resolveDsh', () => {
  it.runIf(process.platform === 'win32')('Windows: resolves PATH .cmd shims and the LOCALAPPDATA npm cache without executing them', () => {
    const installed = cached('windows', '2.0.0')
    executable(join(dirname(installed.path), 'dsh'))
    expect(resolveDsh({ env: { HOME: home, Path: dirname(installed.path), PATHEXT: '.EXE;.CMD' } })).toEqual(installed)
    const local = join(home, 'local')
    mkdirSync(local)
    renameSync(join(home, '.npm'), join(local, 'npm-cache'))
    const path = join(local, 'npm-cache', '_npx', 'windows', 'node_modules', '.bin', 'dsh.cmd')
    expect(resolveDsh({ env: { USERPROFILE: home, LOCALAPPDATA: local } })).toEqual({ path, version: '2.0.0' })
    expect(existsSync(join(home, 'executed'))).toBe(false)
  })
  it('returns undefined when no installation or cache exists', () => {
    expect(resolveDsh(options())).toBeUndefined()
  })

  it('accepts a home directory override for the npm cache', () => {
    const expected = cached('cache', '1.0.0')
    expect(resolveDsh({ homeDir: home, env: { HOME: join(home, 'other') } })).toEqual(expected)
  })

  it('uses the explicit path before VIS_DSH_PATH, PATH and the npm cache', () => {
    const explicit = executable(join(home, 'explicit', 'dsh'))
    const envPath = executable(join(home, 'env', 'dsh'))
    const path = executable(join(home, 'path', 'dsh'))
    cached('newest', '99.0.0')
    expect(resolveDsh({ dshPath: explicit, env: { HOME: home, VIS_DSH_PATH: envPath, PATH: dirname(path) } }))
      .toEqual({ path: explicit, version: 'unknown' })
    expect(existsSync(join(home, 'executed'))).toBe(false)
  })

  it('uses VIS_DSH_PATH before PATH and cache, reading the installed package version', () => {
    const installation = cached('explicit', '0.9.0')
    cached('newest', '1.0.0')
    const path = executable(join(home, 'path', 'dsh'))
    expect(resolveDsh({ env: { HOME: home, VIS_DSH_PATH: installation.path, PATH: dirname(path) } })).toEqual(installation)
  })

  it.each(['option', 'env'] as const)('does not silently fall back from a missing %s override', source => {
    const missing = join(home, 'missing')
    const path = executable(join(home, 'path', 'dsh'))
    cached('cache', '1.0.0')
    const env = { HOME: home, PATH: dirname(path), ...(source === 'env' ? { VIS_DSH_PATH: missing } : {}) }
    expect(resolveDsh({ env, ...(source === 'option' ? { dshPath: missing } : {}) })).toBeUndefined()
  })

  it('uses the first executable in PATH before a newer cache entry', () => {
    const first = executable(join(home, 'first', 'dsh'))
    const second = executable(join(home, 'second', 'dsh'))
    cached('cache', '99.0.0')
    expect(resolveDsh({ env: { HOME: home, PATH: [dirname(first), dirname(second)].join(delimiter) } }))
      .toEqual({ path: first, version: 'unknown' })
  })

  it.runIf(process.platform !== 'win32')('POSIX: ignores PATH entries without executable mode bits', () => {
    const invalid = executable(join(home, 'invalid', 'dsh'))
    chmodSync(invalid, 0o644)
    const first = executable(join(home, 'first', 'dsh'))
    const second = executable(join(home, 'second', 'dsh'))
    cached('cache', '99.0.0')
    expect(resolveDsh({ env: { HOME: home, PATH: [dirname(invalid), dirname(first), dirname(second)].join(delimiter) } }))
      .toEqual({ path: first, version: 'unknown' })
  })

  it('selects the highest numeric semantic version rather than the cache directory name', () => {
    cached('z-new-directory', '0.9.99')
    const expected = cached('a-old-directory', '0.10.0')
    cached('m-directory', '0.10.0-rc.20')
    expect(resolveDsh(options())).toEqual(expected)
    expect(existsSync(join(home, 'executed'))).toBe(false)
  })

  it.each([
    ['1.0.0-rc.2', '1.0.0-rc.10'],
    ['1.0.0-1', '1.0.0-alpha'],
    ['1.0.0-alpha', '1.0.0-alpha.1'],
    ['1.0.0-alpha.10', '1.0.0-beta.1'],
    ['1.0.0-rc.10', '1.0.0+build.1'],
    ['9.99.99', '10.0.0'],
    ['1.9.99', '1.10.0'],
    ['1.0.9', '1.0.10'],
  ])('orders %s before %s', (lower, higher) => {
    cached('z', lower)
    const expected = cached('a', higher)
    expect(resolveDsh(options())).toEqual(expected)
  })

  it('ignores missing or invalid package metadata and broken bins', () => {
    const valid = cached('valid', '1.0.0')
    for (const [entry, contents] of [
      ['malformed', '{'],
      ['wrong-name', JSON.stringify({ name: 'other', version: '9.0.0' })],
      ['wrong-type', JSON.stringify({ name: '@deepseek-ai/dsh', version: 9 })],
      ['invalid-version', JSON.stringify({ name: '@deepseek-ai/dsh', version: '01.0.0' })],
      ['invalid-prerelease', JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.0.0-rc.01' })],
      ['trailing-newline', JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.0.0\n' })],
    ]) {
      const installation = cached(entry!, '9.0.0')
      writeFileSync(join(dirname(installation.path), '..', '@deepseek-ai', 'dsh', 'package.json'), contents!)
    }
    const missing = cached('missing-package', '9.0.0')
    rmSync(join(dirname(missing.path), '..', '@deepseek-ai', 'dsh', 'package.json'))
    const broken = cached('broken-bin', '9.0.0')
    rmSync(join(dirname(broken.path), '..', '@deepseek-ai', 'dsh', 'bin', 'dsh.js'))
    const directory = cached('directory-bin', '9.0.0')
    rmSync(directory.path)
    mkdirSync(directory.path)
    expect(resolveDsh(options())).toEqual(valid)
  })

  it.runIf(process.platform !== 'win32')('POSIX: ignores cached bins without executable mode bits', () => {
    const valid = cached('valid', '1.0.0')
    const nonExecutable = cached('non-executable', '9.0.0')
    chmodSync(nonExecutable.path, 0o644)
    expect(resolveDsh(options())).toEqual(valid)
  })
})
