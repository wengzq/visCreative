import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

/** Windows shell tool entry points live in the runtime directory; Agent adapters still enforce the environment allowlist. */
export function prepareAgentCli(dataDir: string, cliBinDir: string, source: NodeJS.ProcessEnv = process.env): {
  cliBinDir: string
  env: NodeJS.ProcessEnv
} {
  if (process.platform !== 'win32') return { cliBinDir, env: { ...source } }
  const runtimeBin = resolve(dataDir, 'run', 'cli')
  const quote = (path: string) => {
    if (/["\r\n\0]/.test(path)) throw new Error('Invalid command-line entry point path')
    return `"${path.replace(/%/g, '%%')}"`
  }
  const command = `${quote(process.execPath)} ${quote(resolve(cliBinDir, 'vis.mjs'))} %*`
  mkdirSync(runtimeBin, { recursive: true })
  writeFileSync(join(runtimeBin, 'vis.cmd'), `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${command}\r\n`, 'utf8')
  // Windows environment variable names are case-insensitive; avoid passing both PATH / Path and making Node pick the wrong value.
  const env = { ...source }
  const pathKey = Object.keys(source).find(key => key.toUpperCase() === 'PATH')
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
  env.PATH = [runtimeBin, pathKey ? source[pathKey] : undefined].filter(Boolean).join(delimiter)
  return { cliBinDir: runtimeBin, env }
}
