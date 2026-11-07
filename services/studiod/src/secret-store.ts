import { spawn } from 'node:child_process'
import { POWERSHELL_ARGS, powershellString, runPowerShell, type WindowsCommandRunner } from './windows-process'

export interface SecretStore {
  get(providerId: string): Promise<string | undefined>
  set(providerId: string, secret: string): Promise<void>
  delete(providerId: string): Promise<void>
  has(providerId: string): Promise<boolean>
}

export function createMemorySecretStore(): SecretStore {
  const secrets = new Map<string, string>()
  return {
    async get(id) { return secrets.get(id) },
    async set(id, secret) { secrets.set(id, secret) },
    async delete(id) { secrets.delete(id) },
    async has(id) { return secrets.has(id) },
  }
}

export type SecurityCommandRunner = (args: string[], input?: string) => Promise<{ stdout: string; exitCode: number }>

const runSecurity: SecurityCommandRunner = (args, input) => new Promise((resolve, reject) => {
  const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'ignore'] })
  let stdout = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.on('error', () => { reject(new Error('Cannot start the macOS Keychain command')) })
  child.stdin.on('error', () => { reject(new Error('Cannot write to the macOS Keychain command')) })
  child.on('close', code => { resolve({ stdout, exitCode: code ?? -1 }) })
  child.stdin.end(input)
})

const SERVICE = 'vis-creative.provider'
const NOT_FOUND = 44

export function createSystemSecretStore(): SecretStore {
  return process.platform === 'win32' ? createWindowsCredentialStore() : createKeychainSecretStore()
}

export function createWindowsCredentialStore(options: {
  platform?: NodeJS.Platform
  run?: WindowsCommandRunner
  resource?: 'vis-creative.provider' | 'vis-creative.provider.test'
} = {}): SecretStore {
  const run = options.run ?? runPowerShell
  const resource = options.resource ?? SERVICE

  async function execute(operation: 'get' | 'set' | 'delete' | 'has', id: string, secret?: string) {
    if ((options.platform ?? process.platform) !== 'win32') throw new Error('Windows Credential Manager is not supported on this platform')
    if ([id, secret ?? ''].some(value => /[\r\n\0]/.test(value))) throw new Error('Credential fields cannot contain newlines or null characters')
    const action = operation === 'set'
      ? '$vault.Add([Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime]::new($resource, $id, $secret))'
      : [
        'try { $credential = $vault.Retrieve($resource, $id) } catch { $e = $_.Exception; while ($null -ne $e.InnerException) { $e = $e.InnerException }; if ($e.HResult -eq -2147023728) { exit 44 }; throw }',
        operation === 'delete' ? '$vault.Remove($credential)' : operation === 'get'
          ? '$credential.RetrievePassword(); [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($credential.Password)))'
          : '',
      ].join('; ')
    // A single compound command avoids line-by-line stdin interpretation; fields are encoded as data and cannot inject PowerShell syntax.
    const script = `& { $ErrorActionPreference = 'Stop'; try { $resource = ${powershellString(resource)}; $id = ${powershellString(id)}; $secret = ${powershellString(secret ?? '')}; $vault = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new(); ${action}; exit 0 } catch { exit 1 } }\n`
    let result: { stdout: string; exitCode: number }
    try { result = await run(POWERSHELL_ARGS, script) } catch { throw new Error('Windows Credential Manager operation failed') }
    if (result.exitCode === NOT_FOUND && operation !== 'set') return undefined
    if (result.exitCode !== 0) throw new Error('Windows Credential Manager operation failed')
    return result.stdout
  }

  return {
    async get(id) {
      const output = await execute('get', id)
      if (output === undefined) return undefined
      const encoded = output.trim()
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Windows Credential Manager returned an invalid result')
      return Buffer.from(encoded, 'base64').toString('utf8')
    },
    async set(id, secret) { await execute('set', id, secret) },
    async delete(id) { await execute('delete', id) },
    async has(id) { return await execute('has', id) !== undefined },
  }
}

export function createKeychainSecretStore(options: { platform?: NodeJS.Platform; run?: SecurityCommandRunner } = {}): SecretStore {
  const run = options.run ?? runSecurity
  const platform = options.platform ?? process.platform

  function validate(value: string): void {
    if (platform !== 'darwin') throw new Error('macOS Keychain is not supported on this platform; configure provider API keys on macOS')
    if (/[\r\n\0]/.test(value)) throw new Error('Keychain fields cannot contain newlines or null characters')
  }

  async function execute(args: string[], input?: string) {
    try {
      return await run(args, input)
    } catch {
      throw new Error('macOS Keychain operation failed')
    }
  }

  return {
    async get(id) {
      validate(id)
      const result = await execute(['find-generic-password', '-s', SERVICE, '-a', id, '-w'])
      if (result.exitCode === NOT_FOUND) return undefined
      if (result.exitCode !== 0) throw new Error('Cannot read the API key from macOS Keychain')
      return result.stdout.replace(/\r?\n$/, '')
    },
    async set(id, secret) {
      validate(id)
      validate(secret)
      const quote = (value: string) => `"${value.replace(/[\\"]/g, '\\$&')}"`
      const command = `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(id)} -w ${quote(secret)}\n`
      // The security interactive command buffer is only 4096 bytes; truncation would interpret the remainder as another command.
      if (Buffer.byteLength(command, 'utf8') >= 4096) throw new Error('Keychain field is too long')
      const result = await execute(['-i'], command)
      if (result.exitCode !== 0) throw new Error('Cannot write the API key to macOS Keychain')
    },
    async delete(id) {
      validate(id)
      const result = await execute(['delete-generic-password', '-s', SERVICE, '-a', id])
      if (result.exitCode !== 0 && result.exitCode !== NOT_FOUND) throw new Error('Cannot delete the API key from macOS Keychain')
    },
    async has(id) {
      validate(id)
      const result = await execute(['find-generic-password', '-s', SERVICE, '-a', id])
      if (result.exitCode === NOT_FOUND) return false
      if (result.exitCode !== 0) throw new Error('Cannot check the API key in macOS Keychain')
      return true
    },
  }
}
