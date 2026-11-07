import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { replaceFileSync } from '@vis/assets'
import { appSchema as a, eq, openAppDb } from '@vis/storage'
import { createSkillLibrary } from './skill-library'
import { listProjectSkills } from './filesystem'

vi.mock('@vis/assets', async importOriginal => {
  const assets = await importOriginal<typeof import('@vis/assets')>()
  return { ...assets, replaceFileSync: vi.fn(assets.replaceFileSync) }
})

let dir: string
let db: ReturnType<typeof openAppDb>
let library: ReturnType<typeof createSkillLibrary>
let seq = 0
const requestId = () => `library-${++seq}`
const content = { name: 'my-method', description: 'My method and reasons', body: '# My method\nKeep the pauses I asked for.\n' }
const draft = () => library.propose({ ...content, requestId: requestId() }, 'project-a', 'session-a').draft
const save = () => { const d = draft(); return library.save({ ...content, draftId: d.draftId, expectedRevision: d.revision, requestId: requestId() }) }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vis-author-skills-')); db = openAppDb(join(dir, 'app.db')); library = createSkillLibrary(db, dir) })
afterEach(() => { db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

describe('author skill library', () => {
  it('keeps drafts across restarts without saving or installing them; deduplicates requests by session', () => {
    const params = { ...content, requestId: requestId() }
    const first = library.propose(params, 'a', 'session-a')
    expect(library.propose(params, 'a', 'session-a')).toEqual(first)
    expect(() => library.propose(params, 'a', 'session-b')).toThrow(/Request ID/)
    db.$client.close()
    db = openAppDb(join(dir, 'app.db'))
    library = createSkillLibrary(db, dir)
    expect(library.list()).toEqual({ skills: [], drafts: [first.draft] })
    expect(existsSync(join(dir, 'skill-library'))).toBe(false)
    expect(db.select().from(a.authorSkillEvents).all().map(row => row.type)).toEqual(['draft.created'])
  })

  it('refuses a draft body carrying its own frontmatter, leaving no draft behind', () => {
    expect(() => library.propose({ ...content, body: '---\nname: x\n---\nBody', requestId: requestId() }, 'a', 'session-a')).toThrow(/Markdown only/)
    expect(library.list().drafts).toEqual([])
  })

  it('creates immutable hashed versions with a stable identity; old files survive edits and repeated content deduplicates', () => {
    const d = draft()
    const params = { ...content, draftId: d.draftId, expectedRevision: 1, requestId: requestId() }
    const first = library.save(params)
    expect(library.save(params)).toEqual(first)
    const path = join(dir, 'skill-library', first.skillId, first.version, 'SKILL.md')
    const original = readFileSync(path, 'utf8')
    expect(createHash('sha256').update(original).digest('hex')).toBe(first.contentHash)
    expect(first.version).toBe(first.contentHash)
    expect(library.get(first.skillId).body).toBe(content.body)
    const changed = { ...content, name: 'renamed-method', body: 'My next method.' }
    const second = library.save({ ...changed, skillId: first.skillId, expectedRevision: 1, requestId: requestId() })
    expect(second.skillId).toBe(first.skillId)
    expect(second.revision).toBe(2)
    expect(second.version).not.toBe(first.version)
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(() => library.save({ ...content, skillId: first.skillId, expectedRevision: 1, requestId: requestId() })).toThrow(/reread/)
    const third = library.save({ ...changed, skillId: second.skillId, expectedRevision: 2, requestId: requestId() })
    expect(third.version).toBe(second.version)
    expect(db.select().from(a.authorSkillVersions).all()).toHaveLength(2)
    expect(library.list().drafts).toEqual([])
  })

  it('copies pinned bytes and origins into two projects for existing discovery, preserving them after library edits', () => {
    const first = save()
    for (const spaceId of ['a', 'b']) {
      const root = join(dir, spaceId)
      const params = { spaceId, skillId: first.skillId, version: first.version, requestId: requestId() }
      const result = library.use(params, root)
      expect(library.use(params, root)).toEqual(result)
      const directory = join(root, 'skills', first.name)
      expect(lstatSync(directory).isSymbolicLink()).toBe(false)
      expect(JSON.parse(readFileSync(join(directory, '.vis-skill-origin.json'), 'utf8'))).toEqual(result.origin)
      expect(result.origin).toEqual({ skillId: first.skillId, version: first.version, contentHash: first.contentHash })
      expect(listProjectSkills(root)).toEqual([{ ...result.skill, path: realpathSync(result.skill.path) }])
    }
    library.save({ ...content, body: 'Changed later.', skillId: first.skillId, expectedRevision: 1, requestId: requestId() })
    expect(readFileSync(join(dir, 'b', 'skills', content.name, 'SKILL.md'), 'utf8')).toContain(content.body)
    const older = library.use({ spaceId: 'c', skillId: first.skillId, version: first.version, requestId: requestId() }, join(dir, 'c'))
    expect(readFileSync(older.skill.path, 'utf8')).toContain(content.body)
  })

  it('refuses directory and metadata name clashes without overwriting any project content', () => {
    const first = save()
    const root = join(dir, 'project')
    const folder = join(root, 'skills', 'other-directory')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${content.name}\ndescription: Original\n---\nOriginal body`)
    const use = () => library.use({ spaceId: 'a', skillId: first.skillId, version: first.version, requestId: requestId() }, root)
    expect(use).toThrow(/already exists/)
    expect(readdirSync(join(root, 'skills'))).toEqual(['other-directory'])
    expect(readFileSync(join(folder, 'SKILL.md'), 'utf8')).toContain('Original body')
    rmSync(folder, { recursive: true })
    mkdirSync(join(root, 'skills', 'MY-METHOD'))
    expect(use).toThrow(/already exists/)
  })

  it('refuses symlink roots and corrupted version content', () => {
    const first = save()
    const root = join(dir, 'project')
    mkdirSync(root)
    mkdirSync(join(dir, 'outside'))
    symlinkSync(join(dir, 'outside'), join(root, 'skills'), 'junction')
    const params = { spaceId: 'a', skillId: first.skillId, version: first.version, requestId: requestId() }
    expect(() => library.use(params, root)).toThrow(/symlink/)
    writeFileSync(join(dir, 'skill-library', first.skillId, first.version, 'SKILL.md'), 'Changed outside the library')
    expect(() => library.get(first.skillId)).toThrow(/hash/)
    expect(readdirSync(join(dir, 'outside'))).toEqual([])
  })

  it('discard never creates a library entry, checks revisions and is repeatable', () => {
    const d = draft()
    expect(() => library.discard({ draftId: d.draftId, expectedRevision: 2 })).toThrow(/reread/)
    library.discard({ draftId: d.draftId, expectedRevision: 1 })
    expect(library.discard({ draftId: d.draftId, expectedRevision: 1 })).toEqual({ ok: true })
    expect(library.list()).toEqual({ skills: [], drafts: [] })
    expect(db.select().from(a.authorSkillEvents).where(eq(a.authorSkillEvents.type, 'draft.discarded')).all()).toHaveLength(1)
  })
})

it('detects independent edited and newer states and refuses all stale-hash mutations', () => {
  const first = save()
  const root = join(dir, 'copy-states')
  const used = library.use({ requestId: requestId(), spaceId: 'a', skillId: first.skillId, version: first.version }, root)
  const original = readFileSync(used.skill.path, 'utf8')
  const second = library.save({ ...content, body: 'Library revision two', requestId: requestId(), skillId: first.skillId, expectedRevision: first.revision })
  expect(library.listProject(root).skills[0]!.copy).toMatchObject({ newer: true, edited: false, missing: false })
  writeFileSync(used.skill.path, original + '\nLocal edit')
  const copy = library.listProject(root).skills[0]!
  expect(copy.copy).toMatchObject({ newer: true, edited: true, missing: false })
  const params = { requestId: requestId(), spaceId: 'a', path: copy.path, expectedHash: copy.copy!.currentHash, expectedRevision: second.revision }
  writeFileSync(copy.path, original + '\nChanged since review')
  for (const method of [library.update, library.reset, library.publish]) expect(() => method({ ...params, requestId: requestId() }, root)).toThrow(/reread/)
  expect(readFileSync(copy.path, 'utf8')).toBe(original + '\nChanged since review')
  expect(library.get(first.skillId).version).toBe(second.version)
})

it('updates, publishes exact bytes, and resets to the pinned version without touching supplemental files', () => {
  const first = save()
  const root = join(dir, 'mutations')
  const used = library.use({ requestId: requestId(), spaceId: 'a', skillId: first.skillId, version: first.version }, root)
  const extra = join(root, 'skills', content.name, 'notes.md')
  writeFileSync(extra, 'Project notes')
  const latest = library.save({ ...content, body: 'Library revision two', requestId: requestId(), skillId: first.skillId, expectedRevision: first.revision })
  const params = () => ({ requestId: requestId(), spaceId: 'a', path: used.skill.path, expectedHash: library.listProject(root).skills[0]!.copy!.currentHash })
  library.update(params(), root)
  expect(readFileSync(used.skill.path, 'utf8')).toBe(library.export(first.skillId).content)
  expect(library.listProject(root).skills[0]!.copy).toMatchObject({ newer: false, edited: false, version: latest.version })
  writeFileSync(used.skill.path, readFileSync(used.skill.path, 'utf8') + '\nLocal method')
  const local = readFileSync(used.skill.path, 'utf8')
  const published = library.publish({ ...params(), expectedRevision: latest.revision }, root)
  expect(library.export(first.skillId).content).toBe(local)
  expect(published.contentHash).toBe(createHash('sha256').update(local).digest('hex'))
  expect(library.listProject(root).skills[0]!.copy).toMatchObject({ edited: false, newer: false, version: published.version })
  writeFileSync(used.skill.path, local + '\nUnwanted edit')
  library.reset(params(), root)
  expect(readFileSync(used.skill.path, 'utf8')).toBe(local)
  expect(readFileSync(extra, 'utf8')).toBe('Project notes')
})

it('retains copies and pinned reset after deletion, refuses publish, and keeps deleted versions recoverable', () => {
  const saved = save()
  const root = join(dir, 'deleted')
  const used = library.use({ requestId: requestId(), spaceId: 'a', skillId: saved.skillId, version: saved.version }, root)
  const original = readFileSync(used.skill.path, 'utf8')
  library.delete({ skillId: saved.skillId, expectedRevision: saved.revision })
  expect(library.list().skills).toEqual([])
  expect(library.listProject(root).skills[0]!.copy).toMatchObject({ missing: true, newer: false, edited: false })
  writeFileSync(used.skill.path, original + '\nEdit')
  const params = { requestId: requestId(), spaceId: 'a', path: used.skill.path, expectedHash: library.listProject(root).skills[0]!.copy!.currentHash }
  expect(() => library.publish({ ...params, expectedRevision: 1 }, root)).toThrow(/does not exist/)
  library.reset({ ...params, requestId: requestId() }, root)
  expect(readFileSync(used.skill.path, 'utf8')).toBe(original)
  expect(existsSync(join(dir, 'skill-library', saved.skillId, saved.version, 'SKILL.md'))).toBe(true)
})

it('adds flagged current versions only to new projects and reports name clashes without replacing them', () => {
  const saved = save()
  library.setAutoAdd({ skillId: saved.skillId, expectedRevision: 1, enabled: true })
  const second = library.save({ ...content, body: 'Latest', skillId: saved.skillId, expectedRevision: 2, requestId: requestId() })
  const root = join(dir, 'new')
  expect(library.addToProject('new', root)).toEqual([])
  expect(library.listProject(root).skills[0]!.copy!.version).toBe(second.version)
  expect(library.addToProject('clashing', root)).toEqual([saved.name])
  expect(readFileSync(join(root, 'skills', saved.name, 'SKILL.md'), 'utf8')).toContain('Latest')
  library.setAutoAdd({ skillId: saved.skillId, expectedRevision: second.revision, enabled: false })
  expect(library.addToProject('unflagged', join(dir, 'unflagged'))).toEqual([])
  expect(existsSync(join(dir, 'unflagged', 'skills'))).toBe(false)
  expect(library.listProject(root).skills).toHaveLength(1)
})

it('imports multiple Markdown files only as drafts and persists saved/discarded card states', () => {
  const text = '---\nname: imported\ndescription: Untrusted import\n---\nRead me first.'
  const params = { requestId: requestId(), files: [{ filename: 'one.md', content: text }, { filename: 'two.md', content: text.replace('imported', 'second') }] }
  const imported = library.importDrafts(params)
  expect(library.importDrafts(params)).toEqual(imported)
  expect(library.list().skills).toEqual([])
  expect(library.list().drafts.map(draft => draft.name).sort()).toEqual(['imported', 'second'])
  const [first, second] = imported.drafts
  expect(library.draftState(first!.draftId)).toMatchObject({ status: 'draft', draft: first })
  library.save({ ...first!, requestId: requestId(), expectedRevision: 1 })
  library.discard({ draftId: second!.draftId, expectedRevision: 1 })
  expect(library.draftState(first!.draftId)).toEqual({ status: 'saved' })
  expect(library.draftState(second!.draftId)).toEqual({ status: 'discarded' })
  expect(() => library.importDrafts({ requestId: requestId(), files: [{ filename: 'bad.md', content: text.replace('imported', 'CON') }] })).toThrow(/portable/)
  expect(library.list().skills).toHaveLength(1)
})

it('refuses an update when a renamed library version clashes with another project skill', () => {
  const saved = save()
  const root = join(dir, 'rename-conflict')
  const used = library.use({ requestId: requestId(), spaceId: 'a', skillId: saved.skillId, version: saved.version }, root)
  const original = readFileSync(used.skill.path, 'utf8')
  const other = join(root, 'skills', 'other')
  mkdirSync(other)
  writeFileSync(join(other, 'SKILL.md'), '---\nname: other\ndescription: Project method\n---\nPreserve me.')
  library.save({ ...content, name: 'other', requestId: requestId(), skillId: saved.skillId, expectedRevision: 1 })
  expect(() => library.update({ requestId: requestId(), spaceId: 'a', path: used.skill.path, expectedHash: saved.contentHash }, root)).toThrow(/already uses/)
  expect(readFileSync(used.skill.path, 'utf8')).toBe(original)
  expect(library.listProject(root).skills.map(skill => skill.name).sort()).toEqual(['my-method', 'other'])
})


it('recovers saved and discarded card states for step a drafts removed before the upgrade', () => {
  const first = draft()
  library.save({ ...content, requestId: requestId(), draftId: first.draftId, expectedRevision: 1 })
  const second = draft()
  library.discard({ draftId: second.draftId, expectedRevision: 1 })
  db.delete(a.authorSkillDrafts).run()
  expect(library.draftState(first.draftId)).toEqual({ status: 'saved' })
  expect(library.draftState(second.draftId)).toEqual({ status: 'discarded' })
})


it('keeps edited copies recoverable when their metadata or UTF-8 encoding is damaged', () => {
  const saved = save()
  const root = join(dir, 'damaged-copy')
  const used = library.use({ requestId: requestId(), spaceId: 'a', skillId: saved.skillId, version: saved.version }, root)
  const original = readFileSync(used.skill.path, 'utf8')
  for (const edited of [Buffer.from('Project edits without frontmatter'), Buffer.from([0xff, 0xfe, 0x00])]) {
    writeFileSync(used.skill.path, edited)
    const copy = library.listProject(root).skills[0]!
    expect(copy).toMatchObject({ name: saved.name, path: used.skill.path, copy: { edited: true, newer: false } })
    expect(copy.copy!.currentHash).toBe(createHash('sha256').update(edited).digest('hex'))
    const params = { requestId: requestId(), spaceId: 'a', path: copy.path, expectedHash: copy.copy!.currentHash }
    expect(() => library.publish({ ...params, expectedRevision: saved.revision }, root)).toThrow(/valid SKILL|UTF-8/)
    expect(readFileSync(copy.path)).toEqual(edited)
    library.reset({ ...params, requestId: requestId() }, root)
    expect(readFileSync(copy.path, 'utf8')).toBe(original)
  }
})


it.each(['update', 'reset'] as const)('keeps copy bytes and origin on persistent Windows locks during %s and succeeds after release', async action => {
  const saved = save()
  const project = join(dir, 'project')
  library.use({ requestId: requestId(), spaceId: 'project', skillId: saved.skillId, version: saved.version }, project)
  const skill = library.listProject(project).skills[0]!
  const path = skill.path
  const original = readFileSync(path, 'utf8')
  const origin = readFileSync(join(project, 'skills', content.name, '.vis-skill-origin.json'), 'utf8')
  const assets = await vi.importActual<typeof import('@vis/assets')>('@vis/assets')
  const rename = vi.fn().mockImplementation(() => { throw Object.assign(new Error('Locked'), { code: 'EPERM' }) })
  vi.mocked(replaceFileSync).mockImplementationOnce((source, destination, options) => assets.replaceFileSync(source, destination, { ...options, platform: 'win32', rename, wait: () => {} }))
  const params = { requestId: requestId(), spaceId: 'project', path, expectedHash: skill.copy!.currentHash, expectedRevision: saved.revision }
  const replace = () => action === 'update' ? library.update(params, project) : library.reset(params, project)
  expect(replace).toThrow(expect.objectContaining({ code: 'unavailable', details: { reason: 'skill.copy_file_locked', params: { path } } }))
  expect(rename).toHaveBeenCalledTimes(8)
  expect(readFileSync(path, 'utf8')).toBe(original)
  expect(readFileSync(join(project, 'skills', content.name, '.vis-skill-origin.json'), 'utf8')).toBe(origin)
  expect(readdirSync(join(project, 'skills', content.name)).some(name => name.startsWith('.updating-'))).toBe(false)
  expect(replace().copy?.currentHash).toBe(skill.copy!.currentHash)
})
