import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assertStagedTarget, packageManagerInvocation, visLauncher } from '../apps/desktop/packaging-helpers.mjs'

const dirs: string[] = []
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-packaging-unit-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it.skipIf(process.platform === 'win32')('runs vis through absolute and relative symlinks without losing the app directory or arguments', () => {
  const dir = temporary()
  const contents = join(dir, 'Moved App.app', 'Contents')
  const cli = join(contents, 'Resources', 'cli')
  const bin = join(dir, 'bin')
  mkdirSync(cli, { recursive: true })
  mkdirSync(join(contents, 'MacOS'))
  mkdirSync(bin)
  const executable = join(contents, 'MacOS', 'visCreative')
  writeFileSync(executable, '#!/bin/sh\nprintf \'%s\\n\' "$ELECTRON_RUN_AS_NODE" "$@"\n')
  chmodSync(executable, 0o755)
  writeFileSync(join(cli, 'vis'), visLauncher, { mode: 0o755 })
  writeFileSync(join(cli, 'vis.mjs'), '')
  symlinkSync(join(cli, 'vis'), join(bin, 'absolute'))
  symlinkSync('absolute', join(bin, 'vis'))
  expect(execFileSync(join(bin, 'vis'), ['mcp', 'argument with spaces'], { encoding: 'utf8' }).trim().split('\n')).toEqual(['1', realpathSync(join(cli, 'vis.mjs')), 'mcp', 'argument with spaces'])
})

it('runs JavaScript package-manager entries through Node', () => {
  const dir = temporary()
  const script = join(dir, 'pnpm.cjs')
  writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))')
  const invocation = packageManagerInvocation(script, ['--dir', 'a project', 'build'])
  expect(JSON.parse(execFileSync(invocation.command, invocation.args, { encoding: 'utf8' }))).toEqual(['--dir', 'a project', 'build'])
})

it('executes native standalone package-manager entries directly', () => {
  const invocation = packageManagerInvocation(process.execPath, ['-e', 'process.stdout.write("native entry")'])
  expect(invocation.command).toBe(process.execPath)
  expect(execFileSync(invocation.command, invocation.args, { encoding: 'utf8' })).toBe('native entry')
})

it('rejects a target whose architecture or platform differs from the staged native files', () => {
  const staged = { platform: 'darwin', arch: 'arm64', electronVersion: '45.3.0' }
  expect(assertStagedTarget(staged, { platform: 'darwin', arch: 'arm64' })).toBe(staged)
  expect(() => assertStagedTarget(staged, { platform: 'darwin', arch: 'x64' })).toThrow('requested darwin-x64')
  expect(() => assertStagedTarget(staged, { platform: 'win32', arch: 'arm64' })).toThrow('requested win32-arm64')
  expect(() => assertStagedTarget({ ...staged, arch: 'universal' })).toThrow('supported desktop target')
})
