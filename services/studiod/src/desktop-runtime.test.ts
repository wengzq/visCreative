import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { defaultDataDir } from '../../../runtime/app-paths'
import { mergePath, readLoginShellPath } from '../../../runtime/login-shell-path'
import { logToFile } from './log-file'
import { mediaBinaries } from './media-binaries'

// RFC 0046 step a: runtime prerequisites the desktop app relies on, testable without Electron.

describe('defaultDataDir', () => {
  it('uses each platform\'s per-user application data location', () => {
    expect(defaultDataDir('darwin', {}, '/Users/me')).toBe(join('/Users/me', 'Library', 'Application Support', 'visCreative'))
    expect(defaultDataDir('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me')).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'visCreative'))
    expect(defaultDataDir('win32', {}, 'C:\\Users\\me')).toBe(join('C:\\Users\\me', 'AppData', 'Roaming', 'visCreative'))
    expect(defaultDataDir('linux', { XDG_DATA_HOME: '/data' }, '/home/me')).toBe(join('/data', 'visCreative'))
    expect(defaultDataDir('linux', {}, '/home/me')).toBe(join('/home/me', '.local', 'share', 'visCreative'))
  })
})

describe('readLoginShellPath', () => {
  it('reads only the marked PATH line, ignoring start-up noise', async () => {
    const run = vi.fn(async (_shell: string, args: string[]) => {
      expect(args[0]).toBe('-ilc')
      return 'Welcome!\nnvm: using node 24\n\n__VIS_LOGIN_PATH__/opt/homebrew/bin:/Users/me/.nvm/bin:/usr/bin__VIS_LOGIN_PATH__\n'
    })
    expect(await readLoginShellPath({ platform: 'darwin', shell: '/bin/zsh', run })).toBe('/opt/homebrew/bin:/Users/me/.nvm/bin:/usr/bin')
    expect(run).toHaveBeenCalledWith('/bin/zsh', expect.any(Array), 5000)
  })

  it('returns undefined on Windows, without a usable shell, on failure or without the marker', async () => {
    const run = vi.fn(async () => '__VIS_LOGIN_PATH__/usr/bin__VIS_LOGIN_PATH__')
    expect(await readLoginShellPath({ platform: 'win32', shell: '/bin/zsh', run })).toBeUndefined()
    expect(await readLoginShellPath({ platform: 'darwin', run })).toBeUndefined()
    expect(await readLoginShellPath({ platform: 'darwin', shell: 'zsh', run })).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
    expect(await readLoginShellPath({ platform: 'darwin', shell: '/bin/zsh', run: async () => { throw new Error('timed out') } })).toBeUndefined()
    expect(await readLoginShellPath({ platform: 'darwin', shell: '/bin/zsh', run: async () => 'no marker' })).toBeUndefined()
    expect(await readLoginShellPath({ platform: 'darwin', shell: '/bin/zsh', run: async () => '__VIS_LOGIN_PATH____VIS_LOGIN_PATH__' })).toBeUndefined()
  })

  it.runIf(process.platform !== 'win32')('reads PATH from a real login shell', async () => {
    const path = await readLoginShellPath({ platform: process.platform, shell: '/bin/sh', timeoutMs: 10_000 })
    expect(path?.split(':')).toContain('/usr/bin')
  })
})

describe('mergePath', () => {
  it('puts login-shell entries first and keeps the app\'s own entries without duplicates', () => {
    expect(mergePath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin:/usr/sbin')).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin')
    expect(mergePath(undefined, '/usr/bin:/bin')).toBe('/usr/bin:/bin')
    expect(mergePath('/a::/b', undefined)).toBe('/a:/b')
    expect(mergePath('C:\\tools', 'C:\\Windows;C:\\tools', ';')).toBe('C:\\tools;C:\\Windows')
  })
})

describe('mediaBinaries', () => {
  it('uses PATH lookups unless the app points at its own build', () => {
    expect(mediaBinaries({})).toEqual({})
    expect(mediaBinaries({ VIS_FFMPEG_PATH: '  ' })).toEqual({})
  })
  it('takes ffprobe from beside a configured ffmpeg unless set separately', () => {
    const mac = '/Applications/visCreative.app/Contents/Resources/ffmpeg/ffmpeg'
    expect(mediaBinaries({ VIS_FFMPEG_PATH: mac })).toEqual({ ffmpegPath: mac, ffprobePath: join('/Applications/visCreative.app/Contents/Resources/ffmpeg', 'ffprobe') })
    const win = 'C:\\Program Files\\visCreative\\resources\\ffmpeg\\ffmpeg.exe'
    expect(mediaBinaries({ VIS_FFMPEG_PATH: win }).ffprobePath).toMatch(/ffprobe\.exe$/)
    expect(mediaBinaries({ VIS_FFMPEG_PATH: mac, VIS_FFPROBE_PATH: '/opt/probe' })).toEqual({ ffmpegPath: mac, ffprobePath: '/opt/probe' })
    expect(mediaBinaries({ VIS_FFPROBE_PATH: '/opt/probe' })).toEqual({ ffprobePath: '/opt/probe' })
  })
})

describe('logToFile', () => {
  it('appends console output to the file with a timestamp and level, creating the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vis-log-'))
    try {
      const path = join(dir, 'logs', 'studiod.log')
      const quiet = (..._args: unknown[]) => {}
      const target = { log: quiet, info: quiet, warn: quiet, error: quiet }
      const write = logToFile(path, target)
      target.log('started on %s', 'pipe')
      target.warn('slow', { ms: 12 })
      target.error(new Error('boom'))
      write('fatal', 'gone')
      // A second writer appends instead of truncating: a restarted studiod keeps the earlier lines.
      logToFile(path, target)
      target.info('again')
      const lines = readFileSync(path, 'utf8').split('\n').filter(line => /^\d{4}-\d\d-\d\dT/.test(line))
      expect(lines.map(line => line.split(' ').slice(1, 3).join(' '))).toEqual(['info started', 'warn slow', 'error Error:', 'fatal gone', 'info again'])
      expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z info started on pipe$/)
      expect(lines[1]).toContain('{ ms: 12 }')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
