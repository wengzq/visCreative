import { expect, it } from 'vitest'
import { assertShellAsarContents, assertStagedTarget, desktopVersion } from '../packaging-helpers.mjs'

it('accepts Windows x64 natives and refuses Windows arm64 or a conflicting builder target', () => {
  const target = { platform: 'win32', arch: 'x64', electronVersion: '45.3.0' }
  expect(assertStagedTarget(target)).toBe(target)
  expect(() => assertStagedTarget({ ...target, arch: 'arm64' })).toThrow('supported desktop target')
  expect(() => assertStagedTarget(target, { platform: 'darwin', arch: 'x64' })).toThrow('requested darwin-x64')
})

it('validates independent preview versions without accepting malformed semver identifiers', () => {
  for (const version of ['0.1.0-preview-win.0', '0.1.0-preview.2', '1.2.3', '1.2.3-rc.1+build.01']) expect(desktopVersion(version)).toBe(version)
  for (const version of [undefined, '', 'v0.1.0', '01.2.3', '1.2.3-01', '1.2.3-', '1.2.3\n', '1.2.3 rc']) expect(() => desktopVersion(version)).toThrow('semantic version')
})

it('rejects runtime modules in shell asars with Windows or POSIX separators', () => {
  expect(() => assertShellAsarContents(['/dist/main.mjs', '\\package.json'])).not.toThrow()
  for (const entry of ['/node_modules/better-sqlite3/package.json', '\\node_modules\\better-sqlite3\\package.json']) {
    expect(() => assertShellAsarContents([entry])).toThrow('stage them as extraResources')
  }
})
