import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolveMcode } from './resolve'

let dir: string
const executable = (path: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
  return path
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vis-mcode-resolve-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

it('prefers the explicit path, then VIS_MCODE_PATH, then PATH, then the official install directory', () => {
  const explicit = executable(join(dir, 'explicit'))
  const override = executable(join(dir, 'override'))
  const onPath = executable(join(dir, 'tools', 'mcode'))
  const installed = executable(join(dir, '.minimax-code', 'bin', 'mcode'))
  const env = { HOME: dir, PATH: dirname(onPath), VIS_MCODE_PATH: override }
  expect(resolveMcode({ mcodePath: explicit, env })).toBe(explicit)
  expect(resolveMcode({ env })).toBe(override)
  expect(resolveMcode({ env: { HOME: dir, PATH: dirname(onPath) } })).toBe(onPath)
  expect(resolveMcode({ env: { HOME: dir, PATH: join(dir, 'missing') } })).toBe(installed)
})

it.each(['', 'missing'])('does not fall back from an invalid override %j', override => {
  executable(join(dir, '.minimax-code', 'bin', 'mcode'))
  expect(resolveMcode({ env: { HOME: dir, PATH: '', VIS_MCODE_PATH: override ? join(dir, override) : override } })).toBeUndefined()
})

it('uses PATH order and skips directories and nonexecutable files', () => {
  const first = join(dir, 'first', 'mcode')
  mkdirSync(first, { recursive: true })
  const second = executable(join(dir, 'second', 'mcode'))
  const third = executable(join(dir, 'third', 'mcode'))
  if (process.platform !== 'win32') chmodSync(second, 0o644)
  expect(resolveMcode({ env: { HOME: dir, PATH: [dirname(first), dirname(second), dirname(third)].join(delimiter) } })).toBe(process.platform === 'win32' ? second : third)
})

it('uses the supplied fake home and returns unavailable without an executable', () => {
  const path = executable(join(dir, '.minimax-code', 'bin', 'mcode'))
  expect(resolveMcode({ homeDir: dir, env: { HOME: join(dir, 'unused') } })).toBe(path)
  expect(resolveMcode({ homeDir: join(dir, 'missing'), env: {} })).toBeUndefined()
})
