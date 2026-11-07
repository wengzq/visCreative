import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

const libraryName = /^[A-Za-z0-9._-]+\.js$/

export function canInstallRenderLibrary(name: string) {
  const lower = name.toLowerCase()
  // Reserve the whole three.js namespace, including modules added in later releases.
  return libraryName.test(name) && lower !== 'anime.js' && lower !== 'rough.js' && !lower.startsWith('three')
}

export async function readRenderLibrary(name: string, builtins: Record<string, string>, userLibDir?: string): Promise<Buffer | undefined> {
  if (!libraryName.test(name)) return
  try {
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
