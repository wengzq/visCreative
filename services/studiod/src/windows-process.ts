import { spawn } from 'node:child_process'

export type WindowsCommandRunner = (args: string[], input: string) => Promise<{ stdout: string; exitCode: number }>

/** Scripts go only through stdin; stderr may contain keys or script contents and must be discarded directly. */
export const runPowerShell: WindowsCommandRunner = (args, input) => new Promise((resolve, reject) => {
  const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
  let stdout = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.on('error', () => reject(new Error('Cannot start the Windows system command')))
  child.stdin.on('error', () => reject(new Error('Cannot write to the Windows system command')))
  child.on('close', code => resolve({ stdout, exitCode: code ?? -1 }))
  child.stdin.end(input)
})

export const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-']

export function powershellString(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}'))`
}
