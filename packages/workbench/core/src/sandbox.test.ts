import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSandboxPolicy as buildPolicy, prepareSandbox as prepare } from './sandbox'
import { codexDescriptor } from '../../codex/src/descriptor'
import { deepseekDescriptor } from '../../deepseek/src/descriptor'
import { claudeDescriptor } from '../../claude/src/descriptor'

const forbiddenPaths = [codexDescriptor, deepseekDescriptor, claudeDescriptor].flatMap(agent => [...agent.forbiddenPaths])
const prepareSandbox: typeof prepare = options => prepare({ ...options, agent: { ...(options.agent ?? codexSandbox), forbiddenPaths } })
const buildSandboxPolicy: typeof buildPolicy = (cwd, data, home, runtimeHome, agent = codexSandbox) => buildPolicy(cwd, data, home, runtimeHome, { ...agent, forbiddenPaths })

import { codexSandbox } from '../../codex/src/descriptor'
import { deepseekSandbox } from '../../deepseek/src/descriptor'

const sandboxAgent = (kind: string) => kind === 'codex' ? codexSandbox : deepseekSandbox

const temporary: string[] = []
const execute = promisify(execFile)

function fixture() {
  // Canonical root: macOS tmpdir() is under /var, a symlink to /private/var, and the sandbox resolves real paths
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vis-sandbox-')))
  temporary.push(root)
  const home = join(root, 'home')
  const dataDir = join(root, 'data')
  const cwd = join(dataDir, 'spaces', 'own', 'sessions', 'work')
  const codexHome = join(root, 'codex')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return { root, home, dataDir, cwd, codexHome }
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Codex sandbox policy', () => {
  it.each(['codex', 'deepseek'] as const)('%s preserves the complete pre-registry sandbox policy', agent => {
    const paths = fixture()
    const own = join(paths.home, agent === 'codex' ? '.codex' : '.dsh')
    const protectedRuntime = agent === 'codex' ? '.dsh' : '.codex'
    const normalized = buildSandboxPolicy(paths.cwd, paths.dataDir, paths.home, own, sandboxAgent(agent))
      .replaceAll(JSON.stringify(paths.root).slice(1, -1), '<root>')
      .replaceAll('\\\\', '/')
      .replace(/"[A-Za-z]:\/Library/g, '"/Library')
    expect(normalized).toBe([
      '(version 1)',
      '(allow default)',
      '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent"))',
      `(deny file-read* (subpath "<root>/data/run") (subpath "<root>/data/providers.json") (subpath "<root>/home/.vis-dev/run") (subpath "<root>/home/.ssh") (subpath "<root>/home/${protectedRuntime}") (subpath "<root>/home/.claude") (subpath "<root>/home/.claude.json") (subpath "<root>/home/Library/Keychains") (subpath "/Library/Keychains") (require-all (subpath "<root>/data") (regex #"/app[.]db[^/]*$")) (require-all (subpath "<root>/data/spaces") (regex #"/space[.]db[^/]*$")) (require-all (subpath "<root>/home") (regex #"/[.]claude[.]json[.][^/]*$")))`,
      '(deny file-write*)',
      `(allow file-write* (subpath "<root>/data/spaces/own/sessions/work") (subpath "<root>/home/${agent === 'codex' ? '.codex' : '.dsh'}") (literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd"))`,
    ].join('\n'))
  })

  it.each(['codex', 'deepseek'] as const)('%s denies Claude runtime files and backups without denying its own home', agent => {
    const paths = fixture()
    const own = join(paths.home, agent === 'codex' ? '.codex' : '.dsh')
    const policy = buildSandboxPolicy(paths.cwd, paths.dataDir, paths.home, own, sandboxAgent(agent))
    const denied = policy.split('\n').find(line => line.startsWith('(deny file-read*'))!
    for (const name of ['.claude', '.claude.json', agent === 'codex' ? '.dsh' : '.codex']) {
      expect(denied).toContain(`(subpath ${JSON.stringify(join(paths.home, name))})`)
    }
    expect(denied).not.toContain(`(subpath ${JSON.stringify(own)})`)
    // Seatbelt regexes match macOS paths; probe with '/' so the check also runs on Windows.
    const patterns = [...denied.matchAll(/\(regex #("(?:\\.|[^"])*")\)/g)].map(match => new RegExp(JSON.parse(match[1]!)))
    for (const name of ['.claude.json.backup', '.claude.json.2026-11-03']) {
      expect(patterns.some(pattern => pattern.test(`${paths.home}/${name}`))).toBe(true)
    }
    expect(patterns.some(pattern => pattern.test(`${paths.home}/.claude.jsonx`))).toBe(false)
  })

  it.each(['codex', 'deepseek'] as const)('%s rejects workspaces overlapping Claude files and backup paths', agent => {
    const paths = fixture()
    const own = join(paths.home, agent === 'codex' ? '.codex' : '.dsh')
    const base = { dataDir: paths.dataDir, agent: sandboxAgent(agent), platform: 'darwin' as const, available: () => true }
    for (const name of ['.claude', '.claude.json', '.claude.json.backup']) {
      const protectedPath = join(paths.home, name)
      for (const cwd of [protectedPath, join(protectedPath, 'child')]) {
        const result = prepareSandbox({ ...base, cwd, env: { HOME: paths.home, CODEX_HOME: own } })
        expect(result.policy, cwd).toBeUndefined()
        expect(result.notice, cwd).toBeTruthy()
      }
      if (agent === 'codex') {
        expect(prepareSandbox({ ...base, cwd: paths.cwd, env: { HOME: paths.home, CODEX_HOME: protectedPath } }).policy).toBeUndefined()
      }
    }
    // Existing credential aliases must protect their canonical target too.
    const target = join(paths.root, 'claude-backup-target')
    mkdirSync(target)
    symlinkSync(target, join(paths.home, '.claude.json.alias'), 'junction')
    expect(prepareSandbox({ ...base, cwd: target, env: { HOME: paths.home, CODEX_HOME: own } }).policy).toBeUndefined()
    const denied = buildSandboxPolicy(paths.cwd, paths.dataDir, paths.home, own, sandboxAgent(agent)).split('\n').find(line => line.startsWith('(deny file-read*'))!
    expect(denied).toContain(`(subpath ${JSON.stringify(target)})`)
  })

  it('Windows: do not fall back to read-only; preserve system environment while filtering service keys and tokens', () => {
    const paths = fixture()
    const essentials = { USERPROFILE: paths.home, APPDATA: paths.home, LOCALAPPDATA: paths.home, SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.EXE;.CMD', TEMP: paths.root, TMP: paths.root }
    const result = prepareSandbox({ cwd: paths.cwd, platform: 'win32', env: { ...essentials, Path: paths.root, ARK_API_KEY: 'fake', VIS_AGENT_TOKEN: 'fake', VIS_TOKEN: 'fake' } })
    expect(result).toMatchObject({ isolation: 'none', policy: undefined, notice: undefined })
    expect(result.env).toEqual({ ...essentials, PATH: paths.root, CODEX_HOME: join(paths.home, '.codex') })
    expect(existsSync(join(paths.cwd, '.vis-tmp'))).toBe(false)
  })
  it('canonicalizes symlinks and missing descendants, and quotes protected paths', () => {
    const paths = fixture()
    const alias = join(paths.root, 'alias')
    symlinkSync(paths.root, alias, 'junction')
    const dataDir = join(alias, 'data "quoted"')
    const codexHome = join(alias, 'missing', 'codex')
    const policy = buildSandboxPolicy(join(alias, 'data/spaces/own/sessions/work'), dataDir, join(alias, 'home'), codexHome)
    const canonicalRoot = realpathSync(paths.root)
    expect(policy).toContain(`(subpath ${JSON.stringify(realpathSync(paths.cwd))})`)
    expect(policy).toContain(`(subpath ${JSON.stringify(join(canonicalRoot, 'missing', 'codex'))})`)
    expect(policy).toContain(`(subpath ${JSON.stringify(join(canonicalRoot, 'data "quoted"', 'run'))})`)
    expect(policy).not.toContain(alias)
    expect(policy).toContain('(deny file-write*)')
    expect(policy).toContain('(global-name "com.apple.securityd")')
    expect(policy).toContain('(global-name "com.apple.SecurityServer")')
    expect(policy).toContain(`(require-all (subpath ${JSON.stringify(join(canonicalRoot, 'data "quoted"'))}) (regex`)
    const databasePattern = policy.match(/\(regex #("(?:\\.|[^"])*")\)/)?.[1]
    expect(databasePattern).toBeDefined()
    const database = new RegExp(JSON.parse(databasePattern!))
    // Seatbelt runs only on macOS; policy path separators always use POSIX format.
    const databasePath = join(canonicalRoot, 'data "quoted"', 'app.db').replaceAll('\\', '/')
    for (const suffix of ['', '-wal', '-shm', '-journal']) expect(database.test(`${databasePath}${suffix}`)).toBe(true)
    expect(database.test(databasePath.replace('app.db', 'appXdb'))).toBe(false)
  })

  it('keeps only the environment whitelist and supplies isolated runtime paths', () => {
    const paths = fixture()
    const allowed = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: paths.home, USER: 'sandbox-test', LOGNAME: 'sandbox-test',
      SHELL: '/bin/sh', LANG: 'en_US.UTF-8', LC_ALL: 'C', LC_CTYPE: 'UTF-8', TERM: 'xterm',
    }
    const result = prepareSandbox({ ...paths, platform: 'darwin', available: () => true, env: {
      ...allowed, CODEX_HOME: paths.codexHome, VIS_AGENT_TOKEN: 'secret', OPENAI_API_KEY: 'secret',
      ARK_API_KEY: 'secret', NODE_OPTIONS: '--require=secret', HTTPS_PROXY: 'secret',
      ENV_SENTINEL: 'secret', TMPDIR: '/untrusted', TMPPREFIX: '/untrusted', SSL_CERT_FILE: '/untrusted',
    } })
    expect(result.notice).toBeUndefined()
    expect(result.policy).toBeDefined()
    expect(result.env).toEqual({
      ...allowed, CODEX_HOME: realpathSync(paths.codexHome), TMPDIR: realpathSync(join(paths.cwd, '.vis-tmp')), TMPPREFIX: join(realpathSync(join(paths.cwd, '.vis-tmp')), 'zsh'),
      SSL_CERT_FILE: '/etc/ssl/cert.pem',
    })
  })

  it('DSH only passes its own credential reference and public CA, never the full parent environment', () => {
    const paths = fixture()
    const result = prepareSandbox({ ...paths, agent: sandboxAgent('deepseek'), platform: 'darwin', available: () => true, env: {
      HOME: paths.home, DEEPSEEK_API_KEY: 'fake-dsh-key', VIS_AGENT_TOKEN: 'secret', ARK_API_KEY: 'secret',
      CODEX_HOME: '/untrusted', DSH_HOME: '/untrusted', NODE_OPTIONS: '--require=secret',
    } })
    expect(result.policy).toBeDefined()
    expect(result.env).toEqual({ HOME: paths.home, DEEPSEEK_API_KEY: 'fake-dsh-key', TMPDIR: realpathSync(join(paths.cwd, '.vis-tmp')), TMPPREFIX: join(realpathSync(join(paths.cwd, '.vis-tmp')), 'zsh'), SSL_CERT_FILE: '/etc/ssl/cert.pem' })
    expect(result.policy).toContain(`(subpath ${JSON.stringify(realpathSync(join(paths.home, '.dsh')))})`)
    expect(result.policy).not.toContain('/untrusted')
    expect(result.policy).not.toContain('.npm')
  })

  it.each(['no data directory', 'non-macOS', 'missing sandbox-exec', 'missing PEM certificate'] as const)('fails closed with %s', reason => {
    const paths = fixture()
    const result = prepareSandbox({
      cwd: paths.cwd,
      ...(reason === 'no data directory' ? {} : { dataDir: paths.dataDir }),
      platform: reason === 'non-macOS' ? 'linux' : 'darwin',
      env: { HOME: paths.home, CODEX_HOME: paths.codexHome, ENV_SENTINEL: 'secret' },
      available: path => !((reason === 'missing sandbox-exec' && path === '/usr/bin/sandbox-exec') || (reason === 'missing PEM certificate' && path === '/etc/ssl/cert.pem')),
    })
    expect(result.policy).toBeUndefined()
    expect(result.notice).toBeTruthy()
    expect(result.env.ENV_SENTINEL).toBeUndefined()
    expect(result.env.SSL_CERT_FILE).toBeUndefined()
    expect(result.env.TMPDIR).toBeUndefined()
    expect(result.env.TMPPREFIX).toBeUndefined()
    expect(existsSync(paths.codexHome)).toBe(false)
    expect(existsSync(join(paths.cwd, '.vis-tmp'))).toBe(false)
  })

  it('keeps only legacy session and migrated project workspaces inside application data writable', () => {
    const paths = fixture()
    for (const cwd of [paths.cwd, join(paths.dataDir, 'spaces', 'own', 'project', 'workspaces', 'one')]) {
      mkdirSync(cwd, { recursive: true })
      const result = prepareSandbox({ cwd, dataDir: paths.dataDir, platform: 'darwin', available: () => true, env: { HOME: paths.home, CODEX_HOME: paths.codexHome } })
      expect(result.policy).toBeDefined()
    }
  })

  it('rejects working-directory and CODEX_HOME overlaps through symlinks', () => {
    const paths = fixture()
    const alias = join(paths.root, 'alias')
    symlinkSync(paths.root, alias, 'junction')
    const restricted = [join(alias, 'data', 'run'), join(alias, 'home', '.vis-dev', 'run'), join(alias, 'home', '.ssh'), join(alias, 'home', 'Library', 'Keychains')]
    const base = { dataDir: paths.dataDir, platform: 'darwin' as const, available: () => true }
    for (const directory of [paths.root, paths.home, paths.dataDir, join(paths.dataDir, 'spaces'), join(paths.dataDir, 'spaces', 'own'), join(paths.dataDir, 'spaces', 'own', 'agents'), join(paths.dataDir, 'spaces', 'own', 'blobs'), ...restricted, ...restricted.map(path => join(path, 'child'))]) {
      const result = prepareSandbox({ ...base, cwd: directory, env: { HOME: paths.home, CODEX_HOME: paths.codexHome } })
      expect(result.policy, `cwd ${directory}`).toBeUndefined()
      expect(result.notice, `cwd ${directory}`).toBeTruthy()
    }
    for (const directory of [paths.root, paths.home, paths.dataDir, join(paths.dataDir, 'spaces', 'other'), ...restricted, ...restricted.map(path => join(path, 'child'))]) {
      const result = prepareSandbox({ ...base, cwd: paths.cwd, env: { HOME: paths.home, CODEX_HOME: directory } })
      expect(result.policy, `CODEX_HOME ${directory}`).toBeUndefined()
      expect(result.notice, `CODEX_HOME ${directory}`).toBeTruthy()
    }
    expect(existsSync(paths.codexHome)).toBe(false)
    expect(existsSync(join(paths.cwd, '.vis-tmp'))).toBe(false)
  })
})

describe.skipIf(process.platform !== 'darwin')('macOS sandbox enforcement', () => {
  it.each(['codex', 'deepseek'] as const)('%s shell cannot stat Claude files under the generated profile', agent => {
    const paths = fixture()
    const home = join(paths.home, 'john.doe+test')
    const own = join(home, agent === 'codex' ? '.codex' : '.dsh')
    const forbidden = [join(home, '.claude', 'config'), join(home, '.claude.json'), join(home, '.claude.json.backup')]
    for (const path of forbidden) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'fake credential')
    }
    const prepared = prepareSandbox({ ...paths, agent: sandboxAgent(agent), env: { HOME: home, CODEX_HOME: own } })
    expect(prepared.policy).toBeDefined()
    expect(prepared.policy).toContain(`(require-all (subpath ${JSON.stringify(home)}) (regex #"/[.]claude[.]json[.][^/]*$"))`)
    expect(prepared.policy).not.toContain('\\')
    const loaded = spawnSync('/usr/bin/sandbox-exec', ['-p', prepared.policy!, '/usr/bin/true'], { env: prepared.env, encoding: 'utf8', timeout: 5000 })
    expect(loaded.status, loaded.stderr).toBe(0)
    const futureBackup = join(home, '.claude.json.future')
    writeFileSync(futureBackup, 'fake credential')
    forbidden.push(futureBackup)
    // Positional arguments avoid shell interpolation; stat inspects metadata and never reads contents.
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', prepared.policy!, '/bin/sh', '-c', 'for path do /usr/bin/stat "$path" >/dev/null 2>&1 && exit 1; done; exit 0', 'probe', ...forbidden], { cwd: paths.cwd, env: prepared.env, encoding: 'utf8', timeout: 5000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  })

  it.each(['codex', 'deepseek'] as const)('%s denies fake credentials and outside writes while allowing the workspace and Unix socket', async agent => {
    // Use a short path so the host TMPDIR does not make Unix sockets exceed the macOS length limit.
    const root = mkdtempSync('/tmp/vis-sb-')
    temporary.push(root)
    const home = join(root, 'home')
    const dataDir = join(root, 'data')
    const cwd = join(dataDir, 'spaces', 'own', 'sessions', 'work')
    const codexHome = agent === 'codex' ? join(root, 'codex') : join(home, '.dsh')
    const secret = `file-secret-${randomUUID()}`
    const environmentSecret = `environment-secret-${randomUUID()}`
    const forbidden = [
      join(dataDir, 'run', 'studiod.token'), join(dataDir, 'run', 'other.token'), join(dataDir, 'spaces', 'other', 'space.db'),
      join(home, '.vis-dev', 'run', 'studiod.token'), join(home, '.ssh', 'fake-key'), join(home, agent === 'codex' ? '.dsh' : '.codex', 'fake-config'),
      join(home, 'Library', 'Keychains', 'fake-keychain'),
      join(home, '.claude', 'fake-config'), join(home, '.claude.json'), join(home, '.claude.json.backup'),
      ...['', '-wal', '-shm', '-journal', '.bak'].map(suffix => join(dataDir, 'spaces', 'own', `space.db${suffix}`)),
      join(dataDir, 'providers.json'), ...['', '-wal', '-shm', '-journal', '.bak'].map(suffix => join(dataDir, `app.db${suffix}`)),
    ]
    const media = [join(dataDir, 'spaces', 'own', 'blobs', 'fake-asset'), join(dataDir, 'spaces', 'own', 'project', 'skills', 'test', 'SKILL.md')]
    for (const path of [...forbidden, ...media, join(cwd, 'own.txt'), join(root, 'outside.txt')]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, path === join(cwd, 'own.txt') ? 'own workspace' : media.includes(path) ? 'public project media' : secret)
    }
    const prepared = prepareSandbox({ cwd, dataDir, agent: sandboxAgent(agent), env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome,
      ENV_SENTINEL: environmentSecret, VIS_AGENT_TOKEN: environmentSecret, OPENAI_API_KEY: environmentSecret,
    } })
    expect(prepared.notice).toBeUndefined()
    expect(prepared.policy).toBeDefined()
    const service = 'vis-creative.provider.test'
    const account = `sandbox-${process.pid}-${randomUUID()}`
    const keychainSecret = `keychain-secret-${randomUUID()}`
    const keychainArgs = ['find-generic-password', '-s', service, '-a', account, '-w']
    const socketPath = join(dataDir, 'run', 'studiod.sock')
    const server = createServer(socket => socket.end('socket-ok'))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    let created = false
    try {
      const add = spawnSync('/usr/bin/security', ['-i'], {
        input: `add-generic-password -a ${account} -s ${service} -w ${keychainSecret}\n`, encoding: 'utf8', timeout: 15_000,
      })
      expect(add.error).toBeUndefined()
      expect(add.status).toBe(0)
      const trustedBefore = spawnSync('/usr/bin/security', keychainArgs, { encoding: 'utf8', timeout: 15_000 })
      created = trustedBefore.status === 0
      expect(trustedBefore.status).toBe(0)
      expect(trustedBefore.stdout.trim()).toBe(keychainSecret)
      const script = `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const { spawnSync } = require('node:child_process');
        const net = require('node:net');
        for (const path of ${JSON.stringify(forbidden)}) {
          assert.throws(() => fs.readFileSync(path), error => ['EACCES', 'EPERM'].includes(error.code), 'protected read: ' + path);
        }
        for (const path of ${JSON.stringify(media)}) {
          assert.equal(fs.readFileSync(path, 'utf8'), 'public project media');
          assert.throws(() => fs.writeFileSync(path, 'changed'), error => ['EACCES', 'EPERM'].includes(error.code));
        }
        assert.equal(fs.readFileSync('own.txt', 'utf8'), 'own workspace');
        fs.writeFileSync('created.txt', 'workspace write');
        fs.writeFileSync(${JSON.stringify(join(codexHome, 'runtime.txt'))}, 'codex write');
        for (const path of ${JSON.stringify([join(root, 'outside.txt'), join(root, 'new-outside.txt')])}) {
          assert.throws(() => fs.writeFileSync(path, 'overwrite'), error => ['EACCES', 'EPERM'].includes(error.code), 'outside write: ' + path);
        }
        for (const name of ['ENV_SENTINEL', 'VIS_AGENT_TOKEN', 'OPENAI_API_KEY']) assert.equal(process.env[name], undefined);
        const key = spawnSync('/usr/bin/security', ${JSON.stringify(keychainArgs)}, { encoding: 'utf8', timeout: 10000 });
        assert.notEqual(key.status, 0);
        assert.ok(!(key.stdout + key.stderr).includes(${JSON.stringify(keychainSecret)}));
        const socket = net.createConnection(${JSON.stringify(socketPath)});
        socket.setTimeout(5000, () => { socket.destroy(); process.exitCode = 1; });
        let response = '';
        socket.on('data', chunk => { response += chunk; });
        socket.on('error', error => { throw error; });
        socket.on('end', () => { assert.equal(response, 'socket-ok'); process.stdout.write('sandbox checks passed'); });
      `
      const result = await execute('/usr/bin/sandbox-exec', ['-p', prepared.policy!, process.execPath, '-e', script], {
        cwd, env: prepared.env, encoding: 'utf8', timeout: 20_000,
      })
      expect(result.stdout).toContain('sandbox checks passed')
      for (const sentinel of [secret, environmentSecret, keychainSecret]) expect(result.stdout + result.stderr).not.toContain(sentinel)
      expect(readFileSync(join(cwd, 'created.txt'), 'utf8')).toBe('workspace write')
      expect(readFileSync(join(codexHome, 'runtime.txt'), 'utf8')).toBe('codex write')
      expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe(secret)
      expect(existsSync(join(root, 'new-outside.txt'))).toBe(false)
      const trustedAfter = spawnSync('/usr/bin/security', keychainArgs, { encoding: 'utf8', timeout: 15_000 })
      expect(trustedAfter.status).toBe(0)
      expect(trustedAfter.stdout.trim()).toBe(keychainSecret)
    } finally {
      const removed = spawnSync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], { encoding: 'utf8', timeout: 15_000 })
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      if (created) expect(removed.status).toBe(0)
    }
  }, 60_000)
})
