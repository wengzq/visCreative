import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const libraryName = /^[A-Za-z0-9._-]+\.js$/
let sourceBundle: string | undefined
let building: Promise<unknown> | undefined

export function sourceSceneBundlePath(): string {
  sourceBundle ??= join(mkdtempSync(join(tmpdir(), 'vis-scene-lib-')), 'vis-scene.js')
  return sourceBundle
}

export function canInstallRenderLibrary(name: string) {
  const lower = name.toLowerCase()
  // Reserve the whole three.js namespace, including modules added in later releases.
  return libraryName.test(name) && lower !== 'anime.js' && lower !== 'rough.js' && lower !== 'vis-scene.js' && !lower.startsWith('three')
}

export async function readRenderLibrary(name: string, builtins: Record<string, string>, userLibDir?: string): Promise<Buffer | undefined> {
  if (!libraryName.test(name)) return
  try {
    if (name === 'vis-scene.js' && sourceBundle && builtins[name] === sourceBundle) {
      building ??= promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../../../../scripts/build-render-scene.mjs', import.meta.url)), sourceBundle], { windowsHide: true, ...(process.versions.electron ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}) })
      await building
    }
    if (Object.hasOwn(builtins, name)) return await readFile(builtins[name]!)
    if (!canInstallRenderLibrary(name) || !userLibDir) return
    if (!(await lstat(userLibDir)).isDirectory()) return
    const root = await realpath(userLibDir)
    const path = await realpath(join(root, name))
    // Compare canonical paths before reading: a direct entry must stay directly inside the library directory.
    const fromRoot = relative(root, path)
    if (!fromRoot || dirname(fromRoot) !== '.' || !(await stat(path)).isFile()) return
    return await readFile(path)
  } catch {
    return
  }
}
