import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, sep } from 'node:path'
import type { ApprovalRequest } from './runtime-port'

function inside(path: string, root: string): boolean {
  if (process.platform === 'win32') {
    path = path.toLowerCase()
    root = root.toLowerCase()
  }
  const fromRoot = relative(root, path)
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}

function plainCanonical(path: string, allowMissing: boolean): string | undefined {
  try { return realpathSync.native(path) } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') return
    try {
      lstatSync(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
    const parent = dirname(path)
    if (parent === path) return
    const resolved = plainCanonical(parent, true)
    if (resolved === undefined) return
    try { if (!statSync(resolved).isDirectory()) return } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
    return join(resolved, basename(path))
  }
}

function canonical(path: string, allowMissing: boolean): string | undefined {
  try {
    // Windows realpath removes .. first; resolve segment by segment to preserve junction/.. boundaries.
    if (process.platform === 'win32') {
      path = path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
    }
    const root = parse(path).root
    let current = root
    const parts = path.slice(root.length).split(process.platform === 'win32' ? /[/\\]+/ : /\/+/).filter(Boolean)
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!
      if (part === '.' || part === '..') {
        const resolved = plainCanonical(current, allowMissing)
        if (resolved === undefined) return
        try { if (!statSync(resolved).isDirectory()) return } catch (error) {
          if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') return
        }
        current = part === '..' ? dirname(resolved) : resolved
      } else {
        current = join(current, part)
      }
    }
    return plainCanonical(current, allowMissing)
  } catch { return }
}

export function canAutoApprove(request: ApprovalRequest, context: { workDir: string; rootPath?: string }): boolean {
  if (request.autoApprovalBlocked || (request.kind !== 'command' && request.kind !== 'file_write')) return false
  const paths = request.kind === 'command' ? [request.cwd] : request.paths
  if (!paths?.length) return false
  const roots = [context.workDir, context.rootPath].flatMap(root => {
    if (!root || !isAbsolute(root)) return []
    try {
      const realPath = canonical(root, false)
      return realPath && statSync(realPath).isDirectory() ? [{ realPath }] : []
    } catch {
      return []
    }
  })
  return paths.every(path => {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return false
    if (request.kind === 'command') {
      try {
        if (!statSync(path).isDirectory()) return false
      } catch {
        return false
      }
    }
    const realPath = canonical(path, request.kind === 'file_write')
    // Check only resolved real paths: normalizing first misses symlink traversal through link/..;
    // literal path comparison would instead misclassify aliases of the same directory (such as macOS /tmp and /private/tmp) as outside.
    return realPath !== undefined && roots.some(root => inside(realPath, root.realPath))
  })
}
