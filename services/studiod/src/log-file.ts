import { mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { format } from 'node:util'

type ConsoleLike = Pick<Console, 'log' | 'info' | 'warn' | 'error'>

/**
 * RFC 0046: the desktop app starts studiod with no terminal and, on Windows, without inherited output handles, so
 * studiod writes its own log. Console output is appended to `path` with a timestamp; nothing else changes, and the
 * rule that secrets never reach a log applies exactly as it does to the terminal.
 */
export function logToFile(path: string, target: ConsoleLike = console): (level: string, ...args: unknown[]) => void {
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, 'a')
  const write = (level: string, ...args: unknown[]) => {
    // A full disk or a removed directory must not take studiod down with it.
    try { writeSync(fd, `${new Date().toISOString()} ${level} ${format(...args)}\n`) } catch { /* drop the line */ }
  }
  target.log = (...args) => write('info', ...args)
  target.info = (...args) => write('info', ...args)
  target.warn = (...args) => write('warn', ...args)
  target.error = (...args) => write('error', ...args)
  return write
}
