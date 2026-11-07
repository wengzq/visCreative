import { randomUUID } from 'node:crypto'
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { VisError } from '@vis/domain'
import { SKILL_SOURCE_LIMITS, type MethodParams, type MethodResult, type SkillCandidate, type SkillProblem, type SkillView } from '@vis/protocol'
import { parseSkillMetadata } from './filesystem'
import { readSkillZip } from './zip'

// Archives are read whole and block the daemon while unpacking, so these stay well below asset limits.
const { maxBytes: MAX_BYTES, maxFiles: MAX_FILES, maxArchiveBytes: MAX_ARCHIVE_BYTES } = SKILL_SOURCE_LIMITS
const ignored = (name: string) => ['.git', '__MACOSX', '.DS_Store'].includes(name)
const validName = (name: string) => name.length <= 64 && !name.startsWith('.') && !/[\\/:\x00-\x1f\x7f-\x9f]/.test(name) && name.length > 0
function invalid(path: string, reason: string, message: string): never { throw VisError.of('invalid_params', reason, { path }, `${path}: ${message}`) }
function missing(path: string): never { throw VisError.of('not_found', 'skill.not_found', { path }, `${path}: does not exist or has expired`) }
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function metadata(path: string) {
  let result
  try { result = parseSkillMetadata(readFileSync(path, 'utf8')) } catch { return { reason: 'skill.metadata_invalid', error: 'Cannot parse SKILL.md frontmatter' } }
  if (!result.name) return { reason: 'skill.metadata_missing_name', error: 'Missing SKILL.md name' }
  if (!result.description) return { reason: 'skill.metadata_missing_description', error: 'Missing SKILL.md description' }
  if (!validName(result.name)) return { reason: 'skill.metadata_invalid_name', error: 'Name cannot be used as a directory name' }
  return result
}

export function listSkills(rootPath: string): MethodResult<'skill.list'> {
  const skillsPath = join(rootPath, 'skills')
  const skills: SkillView[] = []
  const problems: SkillProblem[] = []
  if (!existsSync(skillsPath)) return { skillsPath, skills, problems }
  const root = realpathSync(skillsPath)
  for (const entry of readdirSync(skillsPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue
    const path = join(skillsPath, entry.name, 'SKILL.md')
    let problem: Omit<SkillProblem, 'dir'> | undefined
    try {
      if (entry.isSymbolicLink()) problem = { reason: 'skill.list_directory_symlink', error: 'Skill directory cannot be a symlink' }
      else if (!existsSync(path)) problem = { reason: 'skill.metadata_missing', error: 'Missing SKILL.md' }
      else if (!inside(root, realpathSync(path))) problem = { reason: 'skill.metadata_outside_root', error: 'SKILL.md points outside the project skills directory' }
      else {
        const info = metadata(path)
        if ('error' in info) problem = info
        else if (skills.some(s => s.name === info.name)) problem = { reason: 'skill.duplicate_name', params: { name: info.name }, error: `Duplicate name: ${info.name}` }
        else skills.push({ ...info, path })
      }
    } catch { problem = { reason: 'skill.metadata_unreadable', error: 'Cannot read SKILL.md' } }
    if (problem) problems.push({ dir: entry.name, ...problem })
  }
  return { skillsPath, skills, problems }
}

type FileInfo = { path: string; bytes: number; mode: number }
function copyTree(source: string, target: string, files: FileInfo[], prefix = '', depth = 0, used = { bytes: 0 }) {
  const info = lstatSync(source)
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) invalid(prefix || '.', 'skill.special_file', 'Symlinks and special files are not supported')
  if (depth - (info.isFile() ? 1 : 0) > 16) invalid(prefix, 'skill.depth_limit', 'Directory depth exceeds 16 levels')
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: true })
    const names = new Set<string>()
    for (const entry of readdirSync(source)) {
      if (ignored(entry)) continue
      const key = entry.normalize('NFC').toLowerCase()
      if (names.has(key)) invalid(prefix ? `${prefix}/${entry}` : entry, 'skill.path_conflict', 'Duplicate normalized paths')
      names.add(key)
      copyTree(join(source, entry), join(target, entry), files, prefix ? `${prefix}/${entry}` : entry, depth + 1, used)
    }
  } else {
    if (files.length >= MAX_FILES) invalid(prefix, 'skill.file_limit', 'File count exceeds 10000')
    const remaining = MAX_BYTES - used.bytes
    if (info.size > remaining) invalid(prefix, 'skill.size_limit', 'Total file size exceeds 512 MiB')
    copyFileSync(source, target)
    const size = lstatSync(target).size
    if (size > remaining) invalid(prefix, 'skill.size_limit', 'Total file size exceeds 512 MiB')
    chmodSync(target, 0o644 | (info.mode & 0o111))
    used.bytes += size
    files.push({ path: prefix, bytes: size, mode: info.mode })
  }
}

function copyDirectory(source: string, target: string) {
  const info = lstatSync(source)
  if (!info.isDirectory()) invalid(basename(source), 'skill.special_file', 'Symlinks and special files are not supported')
  for (const name of readdirSync(source)) {
    const from = join(source, name)
    const to = join(target, name)
    const entry = lstatSync(from)
    if (entry.isDirectory()) {
      mkdirSync(to)
      copyDirectory(from, to)
    } else if (entry.isFile()) {
      copyFileSync(from, to, constants.COPYFILE_EXCL)
      chmodSync(to, entry.mode)
    } else invalid(name, 'skill.special_file', 'Symlinks and special files are not supported')
  }
  chmodSync(target, info.mode)
}

function move(source: string, target: string) {
  try { renameSync(source, target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    // Node 24 cpSync can abort on non-ASCII Windows paths.
    mkdirSync(target)
    try { copyDirectory(source, target) }
    catch (copyError) { rmSync(target, { recursive: true, force: true }); throw copyError }
    rmSync(source, { recursive: true })
  }
}

type Staged = { at: number; dir: string; candidates: Map<string, { view: SkillCandidate; path: string }> }
export type SkillService = ReturnType<typeof createSkillService>
export function createSkillService(rootPath: string, dataDir: string, now = Date.now) {
  const stagingRoot = join(dataDir, 'skill-staging')
  const removedRoot = join(dataDir, 'removed-skills')
  const skillsPath = join(rootPath, 'skills')
  const stages = new Map<string, Staged>()
  mkdirSync(dataDir, { recursive: true })
  // Previews are valid only in the current process; old content cannot be confirmed after a restart.
  rmSync(stagingRoot, { recursive: true, force: true })
  const discard = (stagingId: string) => {
    const stage = stages.get(stagingId)
    if (stage) { rmSync(stage.dir, { recursive: true, force: true }); stages.delete(stagingId) }
    return { ok: true as const }
  }
  const cleanup = () => {
    for (const [id, stage] of stages) if (now() - stage.at >= 60 * 60_000) discard(id)
  }
  const assertSkillsDirectory = () => {
    if (lstatSync(skillsPath, { throwIfNoEntry: false })?.isSymbolicLink()) invalid('skills', 'skill.directory_symlink', 'Cannot be a symlink')
    mkdirSync(skillsPath, { recursive: true })
  }
  const archive = (path: string) => {
    mkdirSync(removedRoot, { recursive: true })
    const target = join(removedRoot, `${basename(path)}-${now()}-${randomUUID()}`)
    move(path, target)
    return target
  }
  return {
    list: () => listSkills(rootPath),
    discard,
    stage(params: MethodParams<'skill.stage'>, fromRoot?: string): MethodResult<'skill.stage'> {
      cleanup()
      const stagingId = randomUUID()
      const dir = join(stagingRoot, stagingId)
      const content = join(dir, 'content')
      const files: FileInfo[] = []
      const source = params.path ?? join(fromRoot!, 'skills')
      if (!isAbsolute(source)) invalid(source, 'skill.absolute_path_required', 'An absolute path is required')
      const info = lstatSync(source, { throwIfNoEntry: false })
      if (!info) missing(source)
      if (info.isDirectory() && inside(realpathSync(source), realpathSync(dataDir))) invalid('.', 'skill.source_contains_staging', 'Source cannot contain the application staging area')
      mkdirSync(content, { recursive: true })
      try {
        if (params.path) {
          if (info.isDirectory()) copyTree(source, content, files)
          else if (info.isSymbolicLink()) invalid('.', 'skill.source_symlink', 'Symlinks are not supported')
          else if (info.isFile() && ['.zip', '.skill'].includes(extname(source).toLowerCase())) {
            // The whole archive is read into memory before parsing; limit its file size first.
            if (info.size > MAX_ARCHIVE_BYTES) invalid(basename(source), 'skill.archive_size_limit', 'Archive exceeds 256 MiB')
            for (const file of readSkillZip(readFileSync(source))) {
              const target = join(content, file.path)
              mkdirSync(dirname(target), { recursive: true })
              writeFileSync(target, file.data, { mode: file.mode })
              files.push({ path: file.path, bytes: file.data.length, mode: file.mode })
            }
          } else invalid(basename(source), 'skill.source_type', 'A directory or .zip / .skill archive is required')
        } else {
          const available = listSkills(fromRoot!).skills
          for (const [index, name] of [...new Set(params.names!)].entries()) {
            const skill = available.find(s => s.name === name)
            if (!skill) missing(name)
            copyTree(dirname(skill.path), join(content, String(index)), files, String(index), 1)
          }
        }
        const skipped: SkillProblem[] = []
        const candidates = new Map<string, { view: SkillCandidate; path: string }>()
        const existing = listSkills(rootPath).skills
        let found = 0
        const scan = (path: string, depth: number) => {
          const rel = relative(content, path) || '.'
          if (existsSync(join(path, 'SKILL.md'))) {
            if (++found > 100) invalid(rel, 'skill.candidate_limit', 'Candidate count exceeds 100')
            const meta = metadata(join(path, 'SKILL.md'))
            if ('error' in meta) { skipped.push({ dir: rel, ...meta }); return }
            if ([...candidates.keys()].some(name => name.normalize('NFC').toLowerCase() === meta.name.normalize('NFC').toLowerCase())) { skipped.push({ dir: rel, reason: 'skill.duplicate_name', params: { name: meta.name }, error: `Duplicate name: ${meta.name}` }); return }
            const selected = files.filter(f => path === content || f.path.startsWith(relative(content, path).split(sep).join('/') + '/'))
            const executables = selected.filter(f => (f.mode & 0o111) || /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd)$/i.test(f.path)).map(f => relative(path, join(content, f.path)))
            candidates.set(meta.name, { path, view: { ...meta, dir: meta.name, fileCount: selected.length, bytes: selected.reduce((sum, f) => sum + f.bytes, 0), executables, exists: existing.some(s => s.name === meta.name) || !!lstatSync(join(skillsPath, meta.name), { throwIfNoEntry: false }) } })
            return
          }
          if (depth < 3) for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) scan(join(path, entry.name), depth + 1)
        }
        scan(content, 0)
        if (!found) skipped.push({ dir: '.', reason: 'skill.metadata_not_found', params: { levels: 3 }, error: 'No SKILL.md found within 3 levels' })
        stages.set(stagingId, { at: now(), dir, candidates })
        return { stagingId, source, candidates: [...candidates.values()].map(c => c.view), skipped }
      } catch (error) {
        rmSync(dir, { recursive: true, force: true })
        if (error instanceof VisError) throw error
        invalid(basename(source), 'skill.source_unreadable', 'Cannot read or stage source')
      }
    },
    import(params: MethodParams<'skill.import'>): MethodResult<'skill.import'> {
      cleanup()
      const stage = stages.get(params.stagingId)
      if (!stage) missing(params.stagingId)
      assertSkillsDirectory()
      const existing = readdirSync(skillsPath, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).flatMap(entry => {
        const path = join(skillsPath, entry.name)
        const file = join(path, 'SKILL.md')
        try {
          if (!inside(realpathSync(skillsPath), realpathSync(file))) return []
          const info = metadata(file)
          return 'error' in info ? [] : [{ name: info.name, path }]
        } catch { return [] }
      })
      const selected = [...new Set(params.names)].map(name => {
        const candidate = stage.candidates.get(name)
        if (!candidate) invalid(name, 'skill.candidate_not_found', 'Not a staged candidate')
        const conflicts = new Set(existing.filter(s => s.name === name).map(s => s.path))
        const target = join(skillsPath, name)
        const targetInfo = lstatSync(target, { throwIfNoEntry: false })
        if (targetInfo && ![...conflicts].some(path => {
          const info = lstatSync(path)
          return info.dev === targetInfo.dev && info.ino === targetInfo.ino
        })) conflicts.add(target)
        if (conflicts.size && !params.replace) invalid(name, 'skill.name_conflict', 'a skill with this name already exists; confirm replacement')
        return { name, candidate, target, conflicts }
      })
      const conflicts = new Map<string, string>()
      for (const item of selected) for (const path of item.conflicts) {
        const info = lstatSync(path)
        const key = `${info.dev}:${info.ino}`
        if (!conflicts.has(key)) conflicts.set(key, path)
      }
      const pending = join(skillsPath, `.importing-${randomUUID()}`)
      const backups: { from: string; to: string }[] = []
      const installed: string[] = []
      try {
        mkdirSync(pending)
        for (const item of selected) copyTree(item.candidate.path, join(pending, item.name), [])
        for (const path of conflicts.values()) backups.push({ from: path, to: archive(path) })
        for (const item of selected) { renameSync(join(pending, item.name), item.target); installed.push(item.target) }
      } catch (error) {
        for (const path of installed) rmSync(path, { recursive: true, force: true })
        for (const backup of backups.reverse()) move(backup.to, backup.from)
        if (error instanceof VisError) throw error
        invalid('skills', 'skill.import_failed', 'Import failed; original directory restored')
      } finally { rmSync(pending, { recursive: true, force: true }) }
      const imported = selected.map(({ candidate, target }) => ({ name: candidate.view.name, description: candidate.view.description, path: join(target, 'SKILL.md') }))
      const replaced = selected.filter(item => item.conflicts.size).map(item => item.name)
      discard(params.stagingId)
      return { imported, replaced }
    },
    remove(name: string): MethodResult<'skill.remove'> {
      assertSkillsDirectory()
      const skill = listSkills(rootPath).skills.find(s => s.name === name)
      if (!skill) missing(name)
      return { ok: true, removedPath: archive(dirname(skill.path)) }
    },
  }
}
