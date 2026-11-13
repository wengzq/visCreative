import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultRenderLibs } from './index'
import { canInstallRenderLibrary, readRenderLibrary } from './render-libs'

// Windows needs Developer Mode or elevation for file symlinks, and junctions cannot point at files.
const canSymlinkFiles = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'vis-symlink-probe-'))
  try {
    writeFileSync(join(probe, 'target'), '')
    symlinkSync(join(probe, 'target'), join(probe, 'link'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
})()

let dir: string
let userLibDir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-render-libs-'))
  userLibDir = join(dir, 'render-libs')
  mkdirSync(userLibDir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('render libraries', () => {
  it('defaults to the anime.js browser global bundle with its copyright and MIT notice', () => {
    const libs = defaultRenderLibs()
    expect(Object.keys(libs)).toEqual(['anime.js', 'rough.js', 'three.module.js', 'three.core.js', 'vis-scene.js'])
    expect(libs).not.toHaveProperty('gsap.js')
    const script = readFileSync(libs['anime.js']!, 'utf8')
    expect(script).toContain('@version v4.5.0')
    expect(script).toContain('@license MIT')
    expect(script).toContain('@copyright 2026 - Julian Garnier')
    expect(script).toContain('.anime={}')
  })

  it('builds the shared scene module on demand and reserves its name case insensitively', async () => {
    const libs = defaultRenderLibs()
    const scene = (await readRenderLibrary('vis-scene.js', libs))?.toString()
    expect(scene).toContain('from "three"')
    expect(scene).toContain('buildScene')
    expect(scene).toContain('sampleScene')
    expect(scene).toContain('applySceneFrame')
    expect(scene).toContain('GLTFLoader')
    for (const name of ['vis-scene.js', 'VIS-SCENE.js']) {
      expect(canInstallRenderLibrary(name)).toBe(false)
      writeFileSync(join(userLibDir, name), 'window.authorOverride = true')
      expect(await readRenderLibrary(name, {}, userLibDir)).toBeUndefined()
    }
  })

  it('reads arbitrary direct author scripts on each request without a cached directory listing', async () => {
    for (const name of ['gsap.js', 'helper-1.2_test.js']) {
      expect(await readRenderLibrary(name, {}, userLibDir)).toBeUndefined()
      writeFileSync(join(userLibDir, name), 'window.authorLibrary = 1')
      expect((await readRenderLibrary(name, {}, userLibDir))?.toString()).toBe('window.authorLibrary = 1')
      writeFileSync(join(userLibDir, name), 'window.authorLibrary = 2')
      expect((await readRenderLibrary(name, {}, userLibDir))?.toString()).toBe('window.authorLibrary = 2')
    }
  })

  it('gives built-ins priority and reserves all three.js names even when their bundled file is missing', async () => {
    const libs = defaultRenderLibs()
    for (const name of [...Object.keys(libs), 'three.extra.js', 'Anime.js', 'ROUGH.js', 'THREE.js']) {
      writeFileSync(join(userLibDir, name), 'window.authorOverride = true')
      const result = await readRenderLibrary(name, libs, userLibDir)
      if (Object.hasOwn(libs, name)) expect(result?.equals(readFileSync(libs[name]!))).toBe(true)
      else expect(result).toBeUndefined()
    }
    expect(await readRenderLibrary('anime.js', { 'anime.js': join(dir, 'missing.js') }, userLibDir)).toBeUndefined()
  })

  it.each(['bad name.js', 'bad@name.js', 'bad.js:stream', 'helper.mjs', 'helper.JS', '../escape.js', 'nested/helper.js', 'nested\\helper.js', 'helper%2fescape.js', 'helper.js\0'])('refuses invalid library name %j', async name => {
    if (!/[\\/:\0]/.test(name)) writeFileSync(join(userLibDir, name), 'window.invalidLibrary = true')
    expect(await readRenderLibrary(name, {}, userLibDir)).toBeUndefined()
  })

  it('refuses subdirectories, including directories named like scripts', async () => {
    mkdirSync(join(userLibDir, 'nested'))
    writeFileSync(join(userLibDir, 'nested', 'helper.js'), 'window.nestedLibrary = true')
    mkdirSync(join(userLibDir, 'folder.js'))
    expect(await readRenderLibrary('nested/helper.js', {}, userLibDir)).toBeUndefined()
    expect(await readRenderLibrary('folder.js', {}, userLibDir)).toBeUndefined()
  })

  it.skipIf(!canSymlinkFiles)('checks canonical file paths and refuses an escaping symlink before reading its target', async () => {
    const outside = join(dir, 'outside.js')
    writeFileSync(outside, 'window.escapedLibrary = true')
    symlinkSync(outside, join(userLibDir, 'escape.js'), 'file')
    expect(await readRenderLibrary('escape.js', {}, userLibDir)).toBeUndefined()
  })

  it.skipIf(!canSymlinkFiles)('allows a symlink to another direct file but rechecks its target on the next request', async () => {
    const target = join(userLibDir, 'target.js')
    const link = join(userLibDir, 'alias.js')
    writeFileSync(target, 'window.safeLibrary = true')
    symlinkSync(target, link, 'file')
    expect((await readRenderLibrary('alias.js', {}, userLibDir))?.toString()).toBe('window.safeLibrary = true')
    rmSync(link)
    const outside = join(dir, 'outside.js')
    writeFileSync(outside, 'window.escapedLibrary = true')
    symlinkSync(outside, link, 'file')
    expect(await readRenderLibrary('alias.js', {}, userLibDir)).toBeUndefined()
  })

  it('refuses a symlink used as the library directory', async () => {
    const alias = join(dir, 'alias')
    symlinkSync(userLibDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(userLibDir, 'helper.js'), 'window.authorLibrary = true')
    expect(await readRenderLibrary('helper.js', {}, alias)).toBeUndefined()
  })
})
