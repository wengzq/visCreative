import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type { MethodParams, MethodResult, SkillView } from '@vis/protocol'
import { powershellString, runPowerShell, type WindowsCommandRunner } from './windows-process'

const run = promisify(execFile)

export function validateDirectory(path: string): MethodResult<'fs.validateDirectory'> {
  if (!isAbsolute(path)) return { valid: false, error: 'Enter an absolute path' }
  try {
    if (statSync(path).isDirectory()) {
      accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK)
      return { valid: true }
    }
  } catch {
    // Missing paths are not accepted as existing directories.
  }
  return { valid: false, error: 'Directory does not exist or is not readable and writable' }
}

export async function pickDirectory(p: MethodParams<'fs.pickDirectory'>, options: { platform?: NodeJS.Platform; runWindows?: WindowsCommandRunner } = {}): Promise<MethodResult<'fs.pickDirectory'>> {
  const fake = process.env.VIS_PICK_DIRECTORY
  if (fake) return fake === 'cancel' ? { cancelled: true, unsupported: false } : { path: fake, cancelled: false, unsupported: false }
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    const selected = p.defaultPath && validateDirectory(p.defaultPath).valid ? p.defaultPath : ''
    const script = `& { $ErrorActionPreference = 'Stop'; try { Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; try { $dialog.SelectedPath = ${powershellString(selected)}; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath))) } } finally { $dialog.Dispose() }; exit 0 } catch { exit 1 } }\n`
    try {
      const result = await (options.runWindows ?? runPowerShell)(['-NoProfile', '-NonInteractive', '-STA', '-Command', '-'], script)
      if (result.exitCode !== 0) return { cancelled: false, unsupported: true }
      const path = Buffer.from(result.stdout.trim(), 'base64').toString('utf8')
      return path ? { path, cancelled: false, unsupported: false } : { cancelled: true, unsupported: false }
    } catch { return { cancelled: false, unsupported: true } }
  }
  if (platform !== 'darwin') return { cancelled: false, unsupported: true }
  const escape = (value: string) => JSON.stringify(value)
  const defaultPath = p.defaultPath && validateDirectory(p.defaultPath).valid ? ` default location (POSIX file ${escape(p.defaultPath)})` : ''
  try {
    const { stdout } = await run('osascript', ['-e', `POSIX path of (choose folder with prompt "选择工作区目录"${defaultPath})`])
    return { path: stdout.trim(), cancelled: false, unsupported: false }
  } catch (error) {
    if ((error as { stderr?: string }).stderr?.includes('(-128)')) return { cancelled: true, unsupported: false }
    return { cancelled: false, unsupported: true }
  }
}

export function parseSkillMetadata(text: string): { name: string; description: string } {
  const source = text.replace(/^\uFEFF/, '')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1]
  if (!frontmatter) return { name: '', description: '' }
  // shortcut: Only parse strings in skill metadata; switch to a full parser when supporting more YAML types.
  const field = (key: string) => {
    const value = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter)?.[1]?.trim()
    if (!value) return ''
    if (/^[>|][-+]?$/.test(value)) {
      const block = new RegExp(`^${key}:[^\\n]*\\n((?:[ \\t]+[^\\n]*(?:\\n|$))+)`, 'm').exec(frontmatter)?.[1] ?? ''
      return block.trim().replace(/\s*\n\s*/g, value.startsWith('>') ? ' ' : '\n')
    }
    if (value.startsWith('"')) {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'string' ? parsed : ''
    }
    if (value.startsWith("'")) return /^'(.*)'(?:\s+#.*)?$/.exec(value)?.[1]?.replace(/''/g, "'") ?? ''
    return value.replace(/\s+#.*$/, '')
  }
  const name = field('name')
  const description = field('description')
  return { name, description }
}

/** Read only immediate subdirectories under project skills, without recursively scanning the user workspace. */
export function listProjectSkills(rootPath: string): SkillView[] {
  const root = join(rootPath, 'skills')
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const names = new Set<string>()
  return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(root, entry.name, 'SKILL.md')
    try {
      const resolved = realpathSync(path)
      const rel = relative(realpathSync(root), resolved)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return []
      const { name, description } = parseSkillMetadata(readFileSync(path, 'utf8'))
      if (!name || !description || names.has(name)) return []
      names.add(name)
      return [{ name, description, path: resolved }]
    } catch { return [] }
  })
}

export async function reveal(path: string, options: { platform?: NodeJS.Platform; run?: (command: string, args: string[]) => Promise<unknown> } = {}): Promise<MethodResult<'fs.reveal'>> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'win32') return { ok: true, path, revealed: false }
  await (options.run ?? run)(platform === 'win32' ? 'explorer.exe' : 'open', platform === 'win32' ? [`/select,${path}`] : [path])
  return { ok: true, path, revealed: true }
}
