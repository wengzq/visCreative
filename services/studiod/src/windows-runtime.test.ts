import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '@vis/generation'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { prepareAgentCli } from './agent-cli'
import { pickDirectory, reveal } from './filesystem'
import { createMemorySecretStore, createWindowsCredentialStore } from './secret-store'
import { startStudiod, StudiodRunningError } from './studiod'
import type { WindowsCommandRunner } from './windows-process'

const dirs: string[] = []
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-windows-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Local endpoint', () => {
  it.runIf(process.platform === 'win32')('Windows: busy named pipes report an existing studiod and release the single-instance lock after failure', async () => {
    const dataDir = temporary()
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(studiodEndpoint(dataDir), resolve)
    })
    const options = { dataDir, studiodVersion: 'test', runtimes: {}, providers: [createMockProvider()], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } }, secretStore: createMemorySecretStore() }
    try {
      await expect(startStudiod(options)).rejects.toBeInstanceOf(StudiodRunningError)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
    const studiod = await startStudiod(options)
    await studiod.stop('user_quit')
  })

  it('uses different addresses for different data directories and a stable address for the same directory', () => {
    const dir = temporary()
    expect(studiodEndpoint(dir)).toBe(studiodEndpoint(dir))
    expect(studiodEndpoint(dir)).not.toBe(studiodEndpoint(join(dir, 'other')))
    if (process.platform === 'win32') expect(studiodEndpoint(dir)).toMatch(/^\\\\\.\\pipe\\vis-studiod-[a-f0-9]{16}$/)
    else expect(studiodEndpoint(dir)).toBe(join(dir, 'run', 'studiod.sock'))
  })

  it.runIf(process.platform === 'win32')('Windows: case variants, directory junctions and nonexistent child directories use the same canonical address', () => {
    const dir = temporary()
    const target = join(dir, 'target')
    mkdirSync(target)
    const alias = join(dir, 'alias')
    symlinkSync(target, alias, 'junction')
    const expected = studiodEndpoint(join(target, 'new'))
    expect(studiodEndpoint(join(alias, 'new'))).toBe(expected)
    expect(studiodEndpoint(join(target.toUpperCase(), 'NEW'))).toBe(expected)
    mkdirSync(join(target, 'new'))
    expect(studiodEndpoint(join(alias, 'new'))).toBe(expected)
  })

  it.runIf(process.platform === 'win32')('Windows: vis.cmd uses absolute Node / JS paths; PATH has one canonical key with the entry point first', () => {
    const dir = temporary()
    const cli = join(dir, 'cli with spaces & %literal%')
    const result = prepareAgentCli(dir, cli, { Path: 'first;second', KEEP: 'value' })
    expect(result.env).toEqual({ KEEP: 'value', PATH: [result.cliBinDir, 'first;second'].join(delimiter) })
    const script = readFileSync(join(result.cliBinDir, 'vis.cmd'), 'utf8')
    expect(script).toContain(`"${process.execPath}"`)
    expect(script).toContain(`"${join(cli, 'vis.mjs').replace(/%/g, '%%')}" %*`)
    expect(script).toContain('DisableDelayedExpansion')
  })

  it.runIf(process.platform === 'win32')('Windows: inside the desktop app vis.cmd runs Electron as Node, scoped by setlocal (RFC 0046)', () => {
    const dir = temporary()
    const plain = readFileSync(join(prepareAgentCli(dir, join(dir, 'cli'), {}, false).cliBinDir, 'vis.cmd'), 'utf8')
    expect(plain).not.toContain('ELECTRON_RUN_AS_NODE')
    const script = readFileSync(join(prepareAgentCli(dir, join(dir, 'cli'), {}, true).cliBinDir, 'vis.cmd'), 'utf8')
    const lines = script.split('\r\n')
    expect(lines.indexOf('set "ELECTRON_RUN_AS_NODE=1"')).toBeGreaterThan(lines.findIndex(line => line.startsWith('setlocal')))
    expect(lines.indexOf('set "ELECTRON_RUN_AS_NODE=1"')).toBeLessThan(lines.findIndex(line => line.includes('vis.mjs')))
  })
})

describe('Windows Credential Manager (fake commands)', () => {
  it('scripts and fields go only through stdin, keys and Unicode stay intact, and has does not retrieve passwords', async () => {
    const key = ' 密钥 " \\\\ $() ` & | % space '
    const run = vi.fn<WindowsCommandRunner>().mockResolvedValue({ stdout: Buffer.from(key).toString('base64'), exitCode: 0 })
    const store = createWindowsCredentialStore({ platform: 'win32', run })
    await store.set('provider', key)
    expect(await store.get('provider')).toBe(key)
    expect(await store.has('provider')).toBe(true)
    await store.delete('provider')
    for (const [args, input] of run.mock.calls) {
      expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-'])
      expect(input).toContain(Buffer.from('vis-creative.provider').toString('base64'))
      expect(input).toContain('PasswordVault')
    }
    expect(run.mock.calls[0]![1]).toContain(Buffer.from(key).toString('base64'))
    expect(run.mock.calls[2]![1]).not.toContain('RetrievePassword')
  })

  it('only treats nonexistent entries as absent; failures expose no output or exception contents', async () => {
    const run = vi.fn<WindowsCommandRunner>().mockResolvedValue({ stdout: '', exitCode: 44 })
    const store = createWindowsCredentialStore({ platform: 'win32', run })
    expect(await store.get('id')).toBeUndefined()
    expect(await store.has('id')).toBe(false)
    await store.delete('id')
    await expect(store.set('id', 'fake-secret')).rejects.toThrow('Windows')
    run.mockResolvedValue({ stdout: 'fake-secret', exitCode: 1 })
    for (const operation of [() => store.get('id'), () => store.has('id'), () => store.set('id', 'fake-secret'), () => store.delete('id')]) {
      await expect(operation()).rejects.toThrow('Windows Credential Manager operation failed')
    }
    run.mockRejectedValue(new Error('fake-secret'))
    await expect(store.set('id', 'fake-secret')).rejects.toThrow('Windows Credential Manager operation failed')
    run.mockResolvedValue({ stdout: 'fake-secret', exitCode: 0 })
    await expect(store.get('id')).rejects.toThrow('returned an invalid result')
  })

  it('rejects invalid fields and non-Windows calls without executing commands', async () => {
    const run = vi.fn<WindowsCommandRunner>()
    const store = createWindowsCredentialStore({ platform: 'win32', run })
    for (const value of ['\n', '\r', '\0']) {
      await expect(store.set('id', value)).rejects.toThrow()
      await expect(store.get(value)).rejects.toThrow()
      await expect(store.has(value)).rejects.toThrow()
      await expect(store.delete(value)).rejects.toThrow()
    }
    await expect(createWindowsCredentialStore({ platform: 'linux', run }).get('id')).rejects.toThrow('not supported')
    expect(run).not.toHaveBeenCalled()
  })
})

it.runIf(process.platform === 'win32')('Windows: reads, writes, overwrites and deletes the test-only PasswordVault entry, with cleanup in finally', async () => {
  const store = createWindowsCredentialStore({ resource: 'vis-creative.provider.test' })
  const id = `w2-${randomUUID()}`
  try {
    expect(await store.get(id)).toBeUndefined()
    expect(await store.has(id)).toBe(false)
    await store.set(id, ' fake " \\\\ 中文 $() ` & | % ')
    expect(await store.has(id)).toBe(true)
    expect(await store.get(id)).toBe(' fake " \\\\ 中文 $() ` & | % ')
    await store.set(id, 'replacement')
    expect(await store.get(id)).toBe('replacement')
    await store.delete(id)
    await store.delete(id)
    expect(await store.get(id)).toBeUndefined()
    expect(await store.has(id)).toBe(false)
  } finally { await store.delete(id) }
}, 30_000)

describe('Windows file interaction (fake commands)', () => {
  it('STA dialogs receive paths via stdin and distinguish selection, cancellation and failure', async () => {
    const path = 'C:\\工作区\\a & b'
    const run = vi.fn<WindowsCommandRunner>().mockResolvedValue({ stdout: Buffer.from(path).toString('base64'), exitCode: 0 })
    expect(await pickDirectory({}, { platform: 'win32', runWindows: run })).toEqual({ path, cancelled: false, unsupported: false })
    expect(run.mock.calls[0]![0]).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-Command', '-'])
    expect(run.mock.calls[0]![1]).toContain('FolderBrowserDialog')
    run.mockResolvedValue({ stdout: '', exitCode: 0 })
    expect(await pickDirectory({}, { platform: 'win32', runWindows: run })).toEqual({ cancelled: true, unsupported: false })
    run.mockResolvedValue({ stdout: '', exitCode: 1 })
    expect(await pickDirectory({}, { platform: 'win32', runWindows: run })).toEqual({ cancelled: false, unsupported: true })
  })

  it('Explorer uses one select argument without a shell; macOS retains open behavior', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const path = 'C:\\a & b\\file.txt'
    expect(await reveal(path, { platform: 'win32', run })).toEqual({ ok: true, path, revealed: true })
    expect(run).toHaveBeenLastCalledWith('explorer.exe', [`/select,${path}`])
    await reveal('/tmp/file', { platform: 'darwin', run })
    expect(run).toHaveBeenLastCalledWith('open', ['/tmp/file'])
  })
})
