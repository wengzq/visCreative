import { describe, expect, it, vi } from 'vitest'
import { createKeychainSecretStore, createMemorySecretStore, createWindowsCredentialStore, type SecurityCommandRunner } from './secret-store'

describe('In-memory SecretStore', () => {
  it('read, update, existence, deletion and provider isolation', async () => {
    const store = createMemorySecretStore()
    expect(await store.get('ark')).toBeUndefined()
    expect(await store.has('ark')).toBe(false)
    await store.set('ark', 'first')
    await store.set('other', 'other-key')
    await store.set('ark', 'second')
    expect(await store.get('ark')).toBe('second')
    expect(await store.has('ark')).toBe(true)
    await store.delete('ark')
    await store.delete('ark')
    expect(await store.has('ark')).toBe(false)
    expect(await store.get('other')).toBe('other-key')
  })
})

describe('macOS Keychain SecretStore (fake commands only)', () => {
  it('looks up by service name and provider ID, preserving key whitespace', async () => {
    const run = vi.fn<SecurityCommandRunner>().mockResolvedValue({ stdout: ' key with spaces \n', exitCode: 0 })
    const store = createKeychainSecretStore({ platform: 'darwin', run })
    expect(await store.get('ark')).toBe(' key with spaces ')
    expect(await store.has('ark')).toBe(true)
    expect(run).toHaveBeenNthCalledWith(1, ['find-generic-password', '-s', 'vis-creative.provider', '-a', 'ark', '-w'], undefined)
    expect(run).toHaveBeenNthCalledWith(2, ['find-generic-password', '-s', 'vis-creative.provider', '-a', 'ark'], undefined)
  })

  it('writes keys only through stdin, escaping double quotes and backslashes without a shell', async () => {
    const run = vi.fn<SecurityCommandRunner>().mockResolvedValue({ stdout: '', exitCode: 0 })
    const store = createKeychainSecretStore({ platform: 'darwin', run })
    const key = 'key "quoted" \\ $(touch /tmp/no) `no` ; -w other'
    await store.set('ark"\\id', key)
    expect(run).toHaveBeenCalledExactlyOnceWith(['-i'], 'add-generic-password -U -s "vis-creative.provider" -a "ark\\"\\\\id" -w "key \\"quoted\\" \\\\ $(touch /tmp/no) `no` ; -w other"\n')
    expect(run.mock.calls[0]![0].join(' ')).not.toContain(key)
  })

  it.each(['\n', '\r', '\0'])('rejects command injection characters %j', async character => {
    const run = vi.fn<SecurityCommandRunner>()
    const store = createKeychainSecretStore({ platform: 'darwin', run })
    await expect(store.set('ark', `key${character}delete-keychain`)).rejects.toThrow()
    await expect(store.set(`ark${character}help`, 'key')).rejects.toThrow()
    await expect(store.get(`ark${character}help`)).rejects.toThrow()
    await expect(store.has(`ark${character}help`)).rejects.toThrow()
    await expect(store.delete(`ark${character}help`)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects commands exceeding the security interactive buffer, including multibyte characters and escaped length', async () => {
    const run = vi.fn<SecurityCommandRunner>()
    const store = createKeychainSecretStore({ platform: 'darwin', run })
    for (const key of ['x'.repeat(4096), '密'.repeat(1400), '\\'.repeat(2100)]) {
      await expect(store.set('ark', key)).rejects.toThrow('too long')
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('only treats missing entries as absent and allows retrying deletion of missing entries', async () => {
    const run = vi.fn<SecurityCommandRunner>().mockResolvedValue({ stdout: '', exitCode: 44 })
    const store = createKeychainSecretStore({ platform: 'darwin', run })
    expect(await store.get('ark')).toBeUndefined()
    expect(await store.has('ark')).toBe(false)
    await store.delete('ark')
    expect(run).toHaveBeenLastCalledWith(['delete-generic-password', '-s', 'vis-creative.provider', '-a', 'ark'], undefined)
  })

  it('does not treat permission or process errors as absence or return keys from command output or errors', async () => {
    const run = vi.fn<SecurityCommandRunner>().mockResolvedValue({ stdout: 'secret-must-stay-private', exitCode: 36 })
    const store = createKeychainSecretStore({ platform: 'darwin', run })
    for (const operation of [() => store.get('ark'), () => store.has('ark'), () => store.set('ark', 'secret-must-stay-private'), () => store.delete('ark')]) {
      await expect(operation()).rejects.toThrow(/macOS/)
      await expect(operation()).rejects.not.toThrow('secret-must-stay-private')
    }
    run.mockRejectedValue(new Error('secret-must-stay-private'))
    await expect(store.set('ark', 'secret-must-stay-private')).rejects.toThrow('macOS Keychain operation failed')
  })

  it('explicitly rejects all operations on non-macOS platforms without running security', async () => {
    const run = vi.fn<SecurityCommandRunner>()
    const store = createKeychainSecretStore({ platform: 'linux', run })
    await expect(store.get('ark')).rejects.toThrow('not supported')
    await expect(store.has('ark')).rejects.toThrow('not supported')
    await expect(store.set('ark', 'key')).rejects.toThrow('not supported')
    await expect(store.delete('ark')).rejects.toThrow('not supported')
    expect(run).not.toHaveBeenCalled()
  })
})

describe('Hosting credential service (fake commands only)', () => {
  it('uses the hosting service and tos account for every Keychain operation, with secrets only on stdin', async () => {
    const run = vi.fn<SecurityCommandRunner>().mockResolvedValue({ stdout: 'testSK\n', exitCode: 0 })
    const store = createKeychainSecretStore({ platform: 'darwin', run, service: 'vis-creative.hosting.test' })
    try {
      await store.set('tos', 'testSK')
      expect(await store.get('tos')).toBe('testSK')
      expect(await store.has('tos')).toBe(true)
    } finally { await store.delete('tos') }
    expect(run.mock.calls).toEqual([
      [['-i'], 'add-generic-password -U -s "vis-creative.hosting.test" -a "tos" -w "testSK"\n'],
      [['find-generic-password', '-s', 'vis-creative.hosting.test', '-a', 'tos', '-w'], undefined],
      [['find-generic-password', '-s', 'vis-creative.hosting.test', '-a', 'tos'], undefined],
      [['delete-generic-password', '-s', 'vis-creative.hosting.test', '-a', 'tos'], undefined],
    ])
    expect(run.mock.calls.flatMap(([args]) => args)).not.toContain('testSK')
  })

  it('uses the independent hosting resource in PasswordVault through the existing stdin script', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: Buffer.from('testSK').toString('base64'), exitCode: 0 })
    const store = createWindowsCredentialStore({ platform: 'win32', run, resource: 'vis-creative.hosting.test' })
    try {
      await store.set('tos', 'testSK')
      expect(await store.get('tos')).toBe('testSK')
      expect(await store.has('tos')).toBe(true)
    } finally { await store.delete('tos') }
    for (const [args, script] of run.mock.calls) {
      expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-'])
      expect(script).toContain(Buffer.from('vis-creative.hosting.test').toString('base64'))
      expect(script).toContain(Buffer.from('tos').toString('base64'))
      expect(script).not.toContain(Buffer.from('vis-creative.provider').toString('base64'))
    }
    expect(run.mock.calls[2]![1]).not.toContain('RetrievePassword')
  })
})
