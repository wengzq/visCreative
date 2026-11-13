import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startOnStablePort } from './host-port'
import { appLayout, type LayoutInput } from './layout'
import { desktopMessages } from './messages'
import { navigationTarget, permissionAllowed } from './navigation'
import { ensureStudiod, startStudiodProcess, studiodLogPath, StudiodStartError, windowsStartScript } from './studiod-process'

// RFC 0046 step b: the parts of the shell that decide something, kept free of Electron so plain Node can test them.

const dirs: string[] = []
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-desktop-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('appLayout', () => {
  const base: LayoutInput = { packaged: false, platform: 'darwin', env: {}, home: '/Users/me', execPath: '/Applications/visCreative.app/Contents/MacOS/visCreative', resourcesPath: '/Applications/visCreative.app/Contents/Resources', repoRoot: '/repo', exists: () => false }

  it('from source uses the repository builds, the development data directory and a system Node', () => {
    const layout = appLayout(base)
    expect(layout.dataDir).toBe(join('/Users/me', '.vis-dev'))
    expect(layout.studiodCommand).toBe('node')
    expect(layout.studiodEnv).toEqual({})
    expect(layout.studiodEntry).toBe(join('/repo', 'services', 'studiod', 'dist', 'studiod.mjs'))
    expect(layout.cliBinDir).toBe(join('/repo', 'apps', 'cli', 'dist'))
    expect(layout.staticDir).toBe(join('/repo', 'apps', 'web', 'dist', 'client'))
    expect(appLayout({ ...base, env: { npm_node_execpath: '/opt/node' } }).studiodCommand).toBe('/opt/node')
    expect(appLayout({ ...base, env: { npm_node_execpath: '/opt/node', VIS_DESKTOP_NODE: '/custom/node' } }).studiodCommand).toBe('/custom/node')
  })

  it('packaged runs studiod through the app binary as Node, from the resources directory', () => {
    const layout = appLayout({ ...base, packaged: true })
    expect(layout.dataDir).toBe(join('/Users/me', 'Library', 'Application Support', 'visCreative'))
    expect(layout.studiodCommand).toBe(base.execPath)
    expect(layout.studiodEnv).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(layout.studiodEntry).toBe(join(base.resourcesPath, 'studiod', 'dist', 'studiod.mjs'))
    expect(layout.staticDir).toBe(join(base.resourcesPath, 'web', 'client'))
  })

  it('packaged points studiod at bundled ffmpeg and fonts only when they exist', () => {
    const layout = appLayout({ ...base, packaged: true, platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, exists: () => true })
    expect(layout.studiodEnv).toEqual({ ELECTRON_RUN_AS_NODE: '1', VIS_FFMPEG_PATH: join(base.resourcesPath, 'ffmpeg', 'ffmpeg.exe'), VIS_FONTS_DIR: join(base.resourcesPath, 'fonts') })
    expect(layout.dataDir).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'visCreative'))
  })

  it('VIS_DATA_DIR overrides the data directory in both modes', () => {
    expect(appLayout({ ...base, env: { VIS_DATA_DIR: '/data' } }).dataDir).toBe('/data')
    expect(appLayout({ ...base, packaged: true, env: { VIS_DATA_DIR: '/data' } }).dataDir).toBe('/data')
  })
})

describe('ensureStudiod', () => {
  const server = { protocolVersion: 1, studiodVersion: 'test' }
  const never = new Promise<number | null>(() => {})
  const sleep = async () => {}

  it('attaches to a running studiod without starting another', async () => {
    const start = vi.fn(() => ({ exited: never }))
    expect(await ensureStudiod({ probe: async () => server, start })).toEqual({ state: 'attached', server })
    expect(start).not.toHaveBeenCalled()
  })

  it('starts studiod once and waits until it answers', async () => {
    const answers = [undefined, undefined, undefined, server]
    const probe = vi.fn(async () => answers.shift())
    const start = vi.fn(() => ({ exited: never }))
    expect(await ensureStudiod({ probe, start, sleep })).toEqual({ state: 'started', server })
    expect(start).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(4)
  })

  it('keeps waiting when its own start lost the race to another launcher (exit 0)', async () => {
    const answers = [undefined, undefined, undefined, server]
    const result = await ensureStudiod({ probe: async () => answers.shift(), start: () => ({ exited: Promise.resolve(0) }), sleep })
    expect(result.state).toBe('started')
  })

  it('reports a studiod that exits with an error, and one that never answers', async () => {
    await expect(ensureStudiod({ probe: async () => undefined, start: () => ({ exited: Promise.resolve(2) }), sleep })).rejects.toMatchObject({ reason: 'exited', exitCode: 2 })
    let time = 0
    const slow = ensureStudiod({ probe: async () => undefined, start: () => ({ exited: never }), sleep: async ms => { time += ms }, now: () => time, timeoutMs: 1000, pollMs: 100 })
    await expect(slow).rejects.toBeInstanceOf(StudiodStartError)
    await expect(slow).rejects.toMatchObject({ reason: 'timeout' })
  })
})

describe('startStudiodProcess', () => {
  const layoutFor = (dataDir: string, entry: string) => ({ dataDir, studiodCommand: process.execPath, studiodEnv: { VIS_FFMPEG_PATH: '/bundled/ffmpeg' }, studiodEntry: entry, cliBinDir: join(dataDir, 'cli'), staticDir: join(dataDir, 'web') })

  it('passes the data directory, CLI directory, log path, layout variables and the given PATH to studiod', async () => {
    const dataDir = temporary()
    const entry = join(dataDir, 'entry.mjs')
    const out = join(dataDir, 'env.json')
    writeFileSync(entry, `import { writeFileSync } from 'node:fs'
const keys = ['VIS_DATA_DIR', 'VIS_CLI_BIN_DIR', 'VIS_STUDIOD_LOG', 'VIS_FFMPEG_PATH', 'VIS_KEPT', 'PATH']
writeFileSync(process.env.VIS_TEST_OUT, JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))))
`)
    // The direct launch is the POSIX path; plain Node can run it on any platform.
    const started = startStudiodProcess(layoutFor(dataDir, entry), { ...process.env, VIS_KEPT: 'yes', VIS_TEST_OUT: out, VIS_DATA_DIR: '/stale' }, '/login/bin', 'linux')
    expect(await started.exited).toBe(0)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ VIS_DATA_DIR: dataDir, VIS_CLI_BIN_DIR: join(dataDir, 'cli'), VIS_STUDIOD_LOG: studiodLogPath(dataDir), VIS_FFMPEG_PATH: '/bundled/ffmpeg', VIS_KEPT: 'yes', PATH: '/login/bin' })
  })

  it('reports a command that cannot start, and keeps one previous log once the log is large', async () => {
    const dataDir = temporary()
    const log = studiodLogPath(dataDir)
    mkdirSync(join(dataDir, 'logs'))
    writeFileSync(log, Buffer.alloc(5 * 1024 ** 2 + 1, 'x'))
    const started = startStudiodProcess({ ...layoutFor(dataDir, 'entry.mjs'), studiodCommand: join(dataDir, 'missing-node') }, {}, undefined, 'linux')
    expect(await started.exited).not.toBe(0)
    expect(existsSync(log)).toBe(false)
    expect(readFileSync(`${log}.1`)).toHaveLength(5 * 1024 ** 2 + 1)
  })

  it('writes a Windows launch script that carries paths as base64, so quotes and spaces cannot change the command', () => {
    const command = 'C:\\Program Files\\vis\'s app\\visCreative.exe'
    const entry = 'C:\\Program Files\\vis\'s app\\resources\\studiod\\dist\\studiod.mjs'
    const script = windowsStartScript(command, entry)
    expect(script).toContain('Start-Process')
    expect(script).toContain('-WindowStyle Hidden')
    expect(script).not.toContain('Program Files')
    const decoded = [...script.matchAll(/FromBase64String\('([^']+)'\)/g)].map(match => Buffer.from(match[1]!, 'base64').toString('utf8'))
    expect(decoded).toEqual([command, entry])
  })
})

describe('startOnStablePort', () => {
  it('remembers the first port and asks for it again on the next launch', async () => {
    const file = join(temporary(), 'shell', 'host-port')
    const start = vi.fn(async (port?: number) => ({ port: port ?? 51234 }))
    expect((await startOnStablePort(file, start)).port).toBe(51234)
    expect(start).toHaveBeenLastCalledWith()
    expect(readFileSync(file, 'utf8').trim()).toBe('51234')
    expect((await startOnStablePort(file, start)).port).toBe(51234)
    expect(start).toHaveBeenLastCalledWith(51234)
  })

  it('falls back to a random port when the remembered one is taken, and keeps the remembered one', async () => {
    const file = join(temporary(), 'host-port')
    writeFileSync(file, '51234\n')
    const start = vi.fn(async (port?: number) => {
      if (port) throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' })
      return { port: 50001 }
    })
    expect((await startOnStablePort(file, start)).port).toBe(50001)
    expect(readFileSync(file, 'utf8').trim()).toBe('51234')
  })

  it('ignores a corrupt file and passes other start failures through', async () => {
    const file = join(temporary(), 'host-port')
    writeFileSync(file, 'not a port')
    expect((await startOnStablePort(file, async port => ({ port: port ?? 50002 }))).port).toBe(50002)
    writeFileSync(file, '51234')
    await expect(startOnStablePort(file, async () => { throw new Error('boom') })).rejects.toThrow('boom')
  })
})

describe('navigation', () => {
  const origin = 'http://127.0.0.1:51234'

  it('keeps the host origin in the app, sends web links to the browser and drops everything else', () => {
    expect(navigationTarget(`${origin}/#t=abc`, origin)).toBe('app')
    expect(navigationTarget(`${origin}/assets/s/v?t=abc`, origin)).toBe('app')
    expect(navigationTarget('https://example.com/docs', origin)).toBe('external')
    expect(navigationTarget('http://127.0.0.1:9999/', origin)).toBe('external')
    expect(navigationTarget('http://localhost:51234/', origin)).toBe('external')
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://open', 'data:text/html,hi', 'not a url', '']) expect(navigationTarget(url, origin)).toBe('deny')
  })

  it('grants only clipboard writes and fullscreen, and only to the app\'s own pages', () => {
    expect(permissionAllowed('clipboard-sanitized-write', `${origin}/`, origin)).toBe(true)
    expect(permissionAllowed('fullscreen', origin, origin)).toBe(true)
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal']) expect(permissionAllowed(permission, `${origin}/`, origin)).toBe(false)
    expect(permissionAllowed('clipboard-sanitized-write', 'https://example.com/', origin)).toBe(false)
  })
})

describe('desktopMessages', () => {
  it('has the same entries in both languages and picks Chinese only for zh locales', () => {
    expect(Object.keys(desktopMessages('zh-CN')).sort()).toEqual(Object.keys(desktopMessages('en-US')).sort())
    expect(desktopMessages('zh-CN').quit).not.toBe(desktopMessages('en-US').quit)
    expect(desktopMessages('fr').quit).toBe(desktopMessages('en').quit)
  })
})
