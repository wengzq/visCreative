import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codebuddyAvailability, resolveCodebuddy } from './resolve'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'vis-codebuddy-resolve-'))
  dirs.push(dir)
  const first = join(dir, 'first')
  const second = join(dir, 'second')
  mkdirSync(first)
  mkdirSync(second)
  const executable = (folder: string, name: string) => {
    const path = join(folder, process.platform === 'win32' ? `${name}.exe` : name)
    writeFileSync(path, 'Fake executable; never run')
    chmodSync(path, 0o755)
    return path
  }
  return { dir, first, second, executable, env: { PATH: [first, second].join(delimiter), HOME: dir } }
}

it('prefers explicit path, environment override, codebuddy on PATH, then cbc on PATH', () => {
  const { first, second, executable, env } = setup()
  const cbc = executable(first, 'cbc')
  expect(resolveCodebuddy({ env })).toBe(cbc)
  const codebuddy = executable(second, 'codebuddy')
  expect(resolveCodebuddy({ env })).toBe(codebuddy)
  const earlier = executable(first, 'codebuddy')
  expect(resolveCodebuddy({ env })).toBe(earlier)
  const override = executable(second, 'override')
  expect(resolveCodebuddy({ env: { ...env, VIS_CODEBUDDY_PATH: override } })).toBe(override)
  expect(resolveCodebuddy({ codebuddyPath: cbc, env: { ...env, VIS_CODEBUDDY_PATH: override } })).toBe(cbc)
})

it('never falls through an invalid or empty explicit override', () => {
  const { dir, first, executable, env } = setup()
  executable(first, 'codebuddy')
  for (const path of ['', join(dir, 'missing'), first]) {
    expect(resolveCodebuddy({ codebuddyPath: path, env })).toBeUndefined()
    expect(codebuddyAvailability({ env: { ...env, VIS_CODEBUDDY_PATH: path } })).toEqual({ available: false, reason: 'executable_missing' })
  }
})

it('probes executable presence without inspecting authentication or running a process', () => {
  const { first, executable, env } = setup()
  expect(codebuddyAvailability({ env })).toEqual({ available: false, reason: 'executable_missing' })
  const path = executable(first, 'codebuddy')
  expect(codebuddyAvailability({ env })).toEqual({ available: true })
  if (process.platform !== 'win32') {
    chmodSync(path, 0o644)
    expect(codebuddyAvailability({ env })).toEqual({ available: false, reason: 'executable_missing' })
  }
})
