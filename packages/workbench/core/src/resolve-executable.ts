import { readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, resolve } from 'node:path'

export type ResolvedExecutable = { command: string; args: string[] }

function file(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

/** Resolve only the npm Node entry without executing wrapper scripts, avoiding a second argument expansion by cmd. */
export function resolveExecutable(name: string, explicitPath?: string, env: Record<string, string | undefined> = process.env): ResolvedExecutable {
  const requested = explicitPath ?? name
  if (process.platform !== 'win32') return { command: requested, args: [] }
  const lookup = (key: string) => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]
  const extensions = (lookup('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const candidates = extname(requested) ? [''] : [...extensions, '']
  const directories = explicitPath || isAbsolute(requested) || /[/\\]/.test(requested) ? [''] : (lookup('PATH') ?? '').split(delimiter).filter(Boolean)
  let path = requested
  outer: for (const dir of directories) {
    for (const suffix of candidates) {
      const candidate = resolve(dir.replace(/^"|"$/g, ''), `${requested}${suffix.toLowerCase()}`)
      if (file(candidate)) {
        path = candidate
        break outer
      }
    }
  }
  const extension = extname(path).toLowerCase()
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return { command: process.execPath, args: [path] }
  if (extension === '.cmd') {
    const shim = readFileSync(path, 'utf8')
    const entries = [...shim.matchAll(/"((?:%~dp0|%dp0%)[^"\r\n]*\.(?:mjs|cjs|js))"\s+%\*/gi)]
    const targets = new Set(entries.map(match => resolve(dirname(path), match[1]!.replace(/^%(?:~dp0|dp0%)[/\\]?/i, ''))))
    if (targets.size !== 1) throw new Error(`Unsupported Node command shim: ${path}`)
    const entry = [...targets][0]!
    if (!file(entry)) throw new Error(`Missing Node command entry: ${path}`)
    return { command: process.execPath, args: [entry] }
  }
  if (extension === '.bat') throw new Error(`Unsupported command script: ${path}`)
  return { command: path, args: [] }
}
