import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 ** 2, ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr ?? ''}\n${result.stdout ?? ''}`)
  }
  return result.stdout ?? ''
}

export async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function linkedLibraries(path) {
  return run('otool', ['-L', path]).split('\n').slice(1)
    .map(line => line.trim().split(' (')[0]).filter(Boolean)
}

export function rpaths(path) {
  return [...run('otool', ['-l', path]).matchAll(/cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.+) \(offset \d+\)/g)].map(match => match[1])
}

export const isSystemLibrary = path => path.startsWith('/usr/lib/') || path.startsWith('/System/')
