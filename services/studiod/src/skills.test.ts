import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { listProjectSkills } from './filesystem'
import { createSkillService, listSkills } from './skills'

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, copyFileSync: vi.fn(fs.copyFileSync), renameSync: vi.fn(fs.renameSync) }
})

let dir: string
let root: string
let data: string
let now: number
let service: ReturnType<typeof createSkillService>
function skill(path: string, name = '示例', description = '描述') {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n正文`)
  return path
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-skills-'))
  root = join(dir, 'project')
  data = join(dir, 'data')
  mkdirSync(join(root, 'skills'), { recursive: true })
  now = 1000
  service = createSkillService(root, data, () => now)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.mocked(copyFileSync).mockClear(); vi.mocked(renameSync).mockClear() })

it('identifies root, wrapper and multiple candidates; avoids rescanning inside candidates and keeps snapshots independent of source changes', () => {
  const source = skill(join(dir, 'source'))
  skill(join(source, 'nested'), '内嵌')
  const first = service.stage({ path: source })
  expect(first.candidates.map(c => c.name)).toEqual(['示例'])
  const wrapped = join(dir, 'wrapped')
  skill(join(wrapped, 'inner'), '外包')
  expect(service.stage({ path: wrapped }).candidates.map(c => c.name)).toEqual(['外包'])
  skill(source, '已改动')
  const imported = service.import({ stagingId: first.stagingId, names: ['示例'] })
  expect(readFileSync(imported.imported[0]!.path, 'utf8')).toContain('name: 示例')
  expect(existsSync(join(data, 'skill-staging', first.stagingId))).toBe(false)
  const many = join(dir, 'many')
  skill(join(many, 'skills/a'), '甲')
  skill(join(many, 'skills/b'), '乙')
  expect(service.stage({ path: many }).candidates.map(c => c.name).sort()).toEqual(['乙', '甲'])
})

it('puts missing fields, invalid names and duplicate names in skipped and scans at most three levels', () => {
  const source = join(dir, 'source')
  skill(join(source, 'a'), '')
  skill(join(source, 'b'), 'bad/name')
  skill(join(source, 'c'), '正常', '')
  skill(join(source, 'd'), '正常')
  skill(join(source, 'e'), '正常')
  skill(join(source, 'x/y/z/deep'), '过深')
  const result = service.stage({ path: source })
  expect(result.candidates.map(c => c.name)).toEqual(['正常'])
  expect(result.skipped).toHaveLength(4)
  expect(result.skipped.map(s => s.error).join()).toMatch(/name/)
  expect(result.skipped.map(s => s.error).join()).toMatch(/description/)
  expect(result.skipped).toEqual([
    { dir: 'a', reason: 'skill.metadata_missing_name', error: 'Missing SKILL.md name' },
    { dir: 'b', reason: 'skill.metadata_invalid_name', error: 'Name cannot be used as a directory name' },
    { dir: 'c', reason: 'skill.metadata_missing_description', error: 'Missing SKILL.md description' },
    { dir: 'e', reason: 'skill.duplicate_name', params: { name: '正常' }, error: 'Duplicate name: 正常' },
  ])
})

it('returns structured reasons for invalid frontmatter and the scan depth limit', () => {
  const source = skill(join(dir, 'source'))
  writeFileSync(join(source, 'SKILL.md'), '---\nname: "unterminated\ndescription: invalid\n---\n')
  expect(service.stage({ path: source }).skipped).toEqual([
    { dir: '.', reason: 'skill.metadata_invalid', error: 'Cannot parse SKILL.md frontmatter' },
  ])
  rmSync(join(source, 'SKILL.md'))
  skill(join(source, 'a/b/c/deep'), 'too-deep')
  expect(service.stage({ path: source }).skipped).toEqual([
    { dir: '.', reason: 'skill.metadata_not_found', params: { levels: 3 }, error: 'No SKILL.md found within 3 levels' },
  ])
})

it('marks scripts and ignores system directories', () => {
  const source = skill(join(dir, 'source'))
  writeFileSync(join(source, 'script.py'), 'print(1)')
  mkdirSync(join(source, '.git'))
  symlinkSync(join(dir, 'outside'), join(source, '.git', 'ignored'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(source, '.DS_Store'), 'ignored')
  const staged = service.stage({ path: source })
  expect(staged.candidates[0]).toMatchObject({ fileCount: 2, executables: ['script.py'] })
  service.import({ stagingId: staged.stagingId, names: ['示例'] })
  expect(readFileSync(join(root, 'skills/示例/script.py'), 'utf8')).toBe('print(1)')
  expect(existsSync(join(root, 'skills/示例/.git'))).toBe(false)
})

it.runIf(process.platform !== 'win32')('POSIX: preserves executable bits', () => {
  const source = skill(join(dir, 'source'))
  writeFileSync(join(source, 'run'), 'echo hello')
  chmodSync(join(source, 'run'), 0o751)
  writeFileSync(join(source, 'script.py'), 'print(1)')
  mkdirSync(join(source, '.git'))
  symlinkSync(join(dir, 'outside'), join(source, '.git', 'ignored'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(source, '.DS_Store'), 'ignored')
  const staged = service.stage({ path: source })
  expect(staged.candidates[0]).toMatchObject({ fileCount: 3, executables: ['run', 'script.py'] })
  service.import({ stagingId: staged.stagingId, names: ['示例'] })
  expect(statSync(join(root, 'skills/示例/run')).mode & 0o777).toBe(0o755)
  expect(existsSync(join(root, 'skills/示例/.git'))).toBe(false)
})

it('rejects symlinks and excessive depth, with relative paths in errors', () => {
  const source = skill(join(dir, 'source'))
  symlinkSync(join(source, 'SKILL.md'), join(source, 'link'))
  expect(() => service.stage({ path: source })).toThrow(/link.*[Ss]ymlinks/)
  rmSync(join(source, 'link'))
  const deep = join(source, ...Array.from({ length: 17 }, () => 'd'))
  mkdirSync(deep, { recursive: true })
  expect(() => service.stage({ path: source })).toThrow(/depth/)
  expect(readdirSync(join(data, 'skill-staging'))).toEqual([])
})

// Staging copies every file before the count trips, so this is 10,000 real copies; on a two-CPU Windows runner
// with Defender scanning each one that has exceeded a minute.
it('rejects more than 10000 files', () => {
  const source = skill(join(dir, 'source'))
  for (let i = 0; i < 10_000; i++) writeFileSync(join(source, `${i}.txt`), '')
  expect(() => service.stage({ path: source })).toThrow(/10000/)
  expect(readdirSync(join(data, 'skill-staging'))).toEqual([])
}, 180_000)

it('rejects more than 512 MiB from file metadata', () => {
  const source = skill(join(dir, 'source'))
  // Sparse: the limit is read from file metadata before any content.
  writeFileSync(join(source, 'big'), '')
  truncateSync(join(source, 'big'), 512 * 1024 * 1024)
  expect(() => service.stage({ path: source })).toThrow(/512 MiB/)
  expect(readdirSync(join(data, 'skill-staging'))).toEqual([])
})

it('writes nothing on name conflicts without replacement; replacement backs up original directories by frontmatter name', () => {
  skill(join(root, 'skills/old-dir'), '同名', '旧描述')
  const source = join(dir, 'source')
  skill(join(source, 'one'), '新建')
  skill(join(source, 'two'), '同名', '新描述')
  const staged = service.stage({ path: source })
  expect(staged.candidates.find(c => c.name === '同名')?.exists).toBe(true)
  // english-exempt: The message embeds the Chinese skill name supplied as user-content test data.
  expect(() => service.import({ stagingId: staged.stagingId, names: ['新建', '同名'] })).toThrow(expect.objectContaining({ code: 'invalid_params', message: '同名: a skill with this name already exists; confirm replacement', details: { reason: 'skill.name_conflict', params: { path: '同名' } } }))
  expect(existsSync(join(root, 'skills/新建'))).toBe(false)
  const result = service.import({ stagingId: staged.stagingId, names: ['新建', '同名'], replace: true })
  expect(result.replaced).toEqual(['同名'])
  expect(existsSync(join(root, 'skills/old-dir'))).toBe(false)
  const backup = readdirSync(join(data, 'removed-skills'))[0]!
  expect(readFileSync(join(data, 'removed-skills', backup, 'SKILL.md'), 'utf8')).toContain('旧描述')
  const removed = service.remove('同名')
  expect(readFileSync(join(removed.removedPath, 'SKILL.md'), 'utf8')).toContain('新描述')
  // english-exempt: The message embeds the Chinese skill name supplied as user-content test data.
  expect(() => service.remove('同名')).toThrow(expect.objectContaining({ code: 'not_found', message: '同名: does not exist or has expired', details: { reason: 'skill.not_found', params: { path: '同名' } } }))
})

it('listing reports issues and hides importing while preserving existing selector behavior', () => {
  skill(join(root, 'skills/.importing-test'), '隐藏')
  skill(join(root, 'skills/a'), '有效')
  skill(join(root, 'skills/b'), '有效')
  skill(join(root, 'skills/c'), '缺描述', '')
  mkdirSync(join(root, 'skills/d'))
  mkdirSync(join(root, 'skills/e'))
  writeFileSync(join(dir, 'outside'), 'secret')
  symlinkSync(join(dir, 'outside'), join(root, 'skills/e/SKILL.md'))
  const result = listSkills(root)
  expect(result.skills.map(s => s.name)).toEqual(['有效'])
  expect(result.problems.map(p => p.dir)).toEqual(['b', 'c', 'd', 'e'])
  expect(result.problems).toEqual([
    { dir: 'b', reason: 'skill.duplicate_name', params: { name: '有效' }, error: 'Duplicate name: 有效' },
    { dir: 'c', reason: 'skill.metadata_missing_description', error: 'Missing SKILL.md description' },
    { dir: 'd', reason: 'skill.metadata_missing', error: 'Missing SKILL.md' },
    { dir: 'e', reason: 'skill.metadata_outside_root', error: 'SKILL.md points outside the project skills directory' },
  ])
  expect(listProjectSkills(root).map(s => s.name)).toEqual(['有效'])
})

it('expiry, discard and project reopening clean staging; imports cannot cross projects', () => {
  const source = skill(join(dir, 'source'))
  const staged = service.stage({ path: source })
  const other = createSkillService(join(dir, 'other'), join(dir, 'other-data'))
  expect(() => other.import({ stagingId: staged.stagingId, names: ['示例'] })).toThrow(expect.objectContaining({ code: 'not_found' }))
  now += 60 * 60_000
  expect(() => service.import({ stagingId: staged.stagingId, names: ['示例'] })).toThrow(expect.objectContaining({ code: 'not_found' }))
  expect(service.discard(staged.stagingId)).toEqual({ ok: true })
  const second = service.stage({ path: source })
  now += 60 * 60_000
  const third = service.stage({ path: source })
  expect(existsSync(join(data, 'skill-staging', second.stagingId))).toBe(false)
  createSkillService(root, data)
  expect(existsSync(join(data, 'skill-staging', third.stagingId))).toBe(false)
})

it('copies the specified skill from another project without changing the source project', () => {
  const fromRoot = join(dir, 'other')
  skill(join(fromRoot, 'skills/original'), '来源')
  skill(join(fromRoot, 'skills/unselected'), '未选')
  const staged = service.stage({ fromSpaceId: 'other', names: ['来源'] }, fromRoot)
  expect(staged.candidates.map(c => c.name)).toEqual(['来源'])
  service.import({ stagingId: staged.stagingId, names: ['来源'] })
  expect(listSkills(fromRoot).skills).toHaveLength(2)
  expect(listSkills(root).skills.map(s => s.name)).toEqual(['来源'])
})

it('replacement backs up all directories with duplicate names so the selector cannot read old copies', () => {
  skill(join(root, 'skills/a'), '重复', '旧一')
  skill(join(root, 'skills/b'), '重复', '旧二')
  const staged = service.stage({ path: skill(join(dir, 'source'), '重复', '新内容') })
  service.import({ stagingId: staged.stagingId, names: ['重复'], replace: true })
  expect(readdirSync(join(data, 'removed-skills'))).toHaveLength(2)
  expect(listProjectSkills(root)).toMatchObject([{ name: '重复', description: '新内容' }])
})

it('cross-project names differing only in case do not merge content during staging', () => {
  const fromRoot = join(dir, 'other')
  skill(join(fromRoot, 'skills/a'), 'Foo', '第一份')
  skill(join(fromRoot, 'skills/b'), 'foo', '第二份')
  writeFileSync(join(fromRoot, 'skills/b/extra'), '不要混入')
  const staged = service.stage({ fromSpaceId: 'other', names: ['Foo', 'foo'] }, fromRoot)
  expect(staged.candidates).toMatchObject([{ name: 'Foo', description: '第一份', fileCount: 1 }])
  expect(staged.skipped).toHaveLength(1)
})

it('rejects sources containing the staging area to avoid recursively copying itself', () => {
  expect(() => service.stage({ path: dir })).toThrow(/staging area/)
})

it('backs up only once when differently cased directories and same-name targets point to the same directory', () => {
  skill(join(root, 'skills/Foo'), 'foo', '旧')
  const staged = service.stage({ path: skill(join(dir, 'source'), 'foo', '新') })
  expect(service.import({ stagingId: staged.stagingId, names: ['foo'], replace: true }).replaced).toEqual(['foo'])
  expect(readdirSync(join(data, 'removed-skills'))).toHaveLength(1)
  expect(listProjectSkills(root)).toMatchObject([{ name: 'foo', description: '新' }])
})

it('cross-volume removal copies non-ASCII paths with spaces, nested files and file modes', () => {
  const source = skill(join(root, 'skills/示例 skill'), '示例')
  const nested = join(source, '嵌套 folder', 'scripts')
  mkdirSync(nested, { recursive: true })
  const executable = join(nested, 'run')
  writeFileSync(executable, 'echo hello')
  chmodSync(executable, 0o751)
  chmodSync(nested, 0o750)
  const fileMode = statSync(executable).mode & 0o777
  const directoryMode = statSync(nested).mode & 0o777
  vi.mocked(renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('Cross-volume'), { code: 'EXDEV' }) })
  const removed = service.remove('示例')
  expect(readFileSync(join(removed.removedPath, 'SKILL.md'), 'utf8')).toContain('name: 示例')
  const copied = join(removed.removedPath, '嵌套 folder', 'scripts')
  expect(readFileSync(join(copied, 'run'), 'utf8')).toBe('echo hello')
  expect(statSync(join(copied, 'run')).mode & 0o777).toBe(fileMode)
  expect(statSync(copied).mode & 0o777).toBe(directoryMode)
  expect(existsSync(source)).toBe(false)
})

it('cross-volume removal rejects an existing target without changing either directory', () => {
  const source = skill(join(root, 'skills/示例 skill'), '示例')
  let target = ''
  vi.mocked(renameSync).mockImplementationOnce((_from, to) => {
    target = String(to)
    mkdirSync(target)
    writeFileSync(join(target, 'existing'), 'keep')
    throw Object.assign(new Error('Cross-volume'), { code: 'EXDEV' })
  })
  expect(() => service.remove('示例')).toThrow(expect.objectContaining({ code: 'EEXIST' }))
  expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toContain('name: 示例')
  expect(readdirSync(target)).toEqual(['existing'])
  expect(readFileSync(join(target, 'existing'), 'utf8')).toBe('keep')
  expect(copyFileSync).not.toHaveBeenCalled()
})

it('cross-volume removal cleans partial copies and leaves the complete source after a copy failure', async () => {
  const source = skill(join(root, 'skills/示例 skill'), '示例')
  mkdirSync(join(source, 'nested'))
  writeFileSync(join(source, 'nested', 'run'), 'echo hello')
  const original = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('Cross-volume'), { code: 'EXDEV' }) })
  let copied = ''
  vi.mocked(copyFileSync).mockImplementationOnce((from, to, mode) => {
    original.copyFileSync(from, to, mode)
    copied = String(to)
  }).mockImplementationOnce(() => {
    expect(statSync(copied).isFile()).toBe(true)
    throw new Error('Simulated copy failure')
  })
  expect(() => service.remove('示例')).toThrow('Simulated copy failure')
  expect(readFileSync(join(source, 'SKILL.md'), 'utf8')).toContain('name: 示例')
  expect(readFileSync(join(source, 'nested', 'run'), 'utf8')).toBe('echo hello')
  expect(readdirSync(join(data, 'removed-skills'))).toEqual([])
  expect(existsSync(copied)).toBe(false)
})

it('cross-volume removal rejects directory links without following or removing their targets', () => {
  const source = skill(join(root, 'skills/示例 skill'), '示例')
  const outside = skill(join(dir, 'outside'), 'outside')
  symlinkSync(outside, join(source, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  vi.mocked(renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('Cross-volume'), { code: 'EXDEV' }) })
  expect(() => service.remove('示例')).toThrow(/Symlinks/)
  expect(existsSync(join(source, 'link'))).toBe(true)
  expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toContain('name: outside')
  expect(readdirSync(join(data, 'removed-skills'))).toEqual([])
})

it('restores backed-up directories and retains staging for retry when publishing a new directory fails', async () => {
  skill(join(root, 'skills/a'), '示例', '旧内容')
  const staged = service.stage({ path: skill(join(dir, 'source'), '示例', '新内容') })
  const original = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(renameSync).mockImplementationOnce(original.renameSync)
    .mockImplementationOnce(() => { throw new Error('Simulated write failure') })
    .mockImplementationOnce(() => { throw Object.assign(new Error('Cross-volume'), { code: 'EXDEV' }) })
  expect(() => service.import({ stagingId: staged.stagingId, names: ['示例'], replace: true })).toThrow(/restored/)
  expect(listProjectSkills(root)).toMatchObject([{ name: '示例', description: '旧内容' }])
  expect(readdirSync(join(root, 'skills'))).toEqual(['a'])
  expect(readdirSync(join(data, 'removed-skills'))).toEqual([])
  expect(service.import({ stagingId: staged.stagingId, names: ['示例'], replace: true }).imported).toMatchObject([{ description: '新内容' }])
})

it('rejects more than 100 candidates and returns not_found for missing sources', () => {
  const source = join(dir, 'source')
  for (let i = 0; i < 101; i++) skill(join(source, String(i)), `候选${i}`)
  expect(() => service.stage({ path: source })).toThrow(/100/)
  expect(() => service.stage({ path: join(dir, 'missing') })).toThrow(expect.objectContaining({ code: 'not_found' }))
})

it('rejects archives exceeding 256 MiB without reading them into memory', () => {
  const archive = join(dir, 'big.zip')
  writeFileSync(archive, '')
  truncateSync(archive, 256 * 1024 * 1024 + 1)
  expect(() => service.stage({ path: archive })).toThrow(/256 MiB/)
})

it('import scans for duplicate names skip SKILL.md files pointing outside skills', () => {
  const outside = skill(join(dir, 'outside'), '同名', '不能读入')
  mkdirSync(join(root, 'skills/unsafe'))
  symlinkSync(join(outside, 'SKILL.md'), join(root, 'skills/unsafe/SKILL.md'))
  const staged = service.stage({ path: skill(join(dir, 'source'), '同名', '新') })
  expect(service.import({ stagingId: staged.stagingId, names: ['同名'], replace: true }).replaced).toEqual([])
  expect(existsSync(join(root, 'skills/unsafe/SKILL.md'))).toBe(true)
  expect(listSkills(root).problems).toMatchObject([{ dir: 'unsafe', error: expect.stringContaining('outside the project skills directory') }])
})

it('deduplicates conflicting directories by file identity during multi-selection replacement', () => {
  skill(join(root, 'skills/Foo'), 'bar', '旧')
  const source = join(dir, 'source')
  skill(join(source, 'one'), 'bar', '新一')
  skill(join(source, 'two'), 'foo', '新二')
  const staged = service.stage({ path: source })
  expect(service.import({ stagingId: staged.stagingId, names: ['bar', 'foo'], replace: true }).imported).toHaveLength(2)
  expect(readdirSync(join(data, 'removed-skills'))).toHaveLength(1)
  expect(listProjectSkills(root).map(s => s.description).sort()).toEqual(['新一', '新二'])
})
