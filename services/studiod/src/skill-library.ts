import { isUtf8 } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { replaceFileSync } from '@vis/assets'
import { VisError } from '@vis/domain'
import { SkillContent, SkillOrigin, type LibrarySkill, type MethodParams, type MethodResult, type SkillDraft, type SkillView } from '@vis/protocol'
import { and, appSchema as a, asc, desc, eq, fingerprint, isNull, type AppDb } from '@vis/storage'
import { parseSkillMetadata } from './filesystem'
import { listSkills } from './skills'

type Tx = Parameters<Parameters<AppDb['transaction']>[0]>[0]
const fail = (code: 'not_found' | 'revision_conflict' | 'invalid_params' | 'idempotency_conflict', message: string): never => { throw VisError.of(code, `skill.library_${code}`, {}, message) }
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex')
const render = (content: { name: string; description: string; body: string }) => `---\nname: ${JSON.stringify(content.name)}\ndescription: ${JSON.stringify(content.description)}\n---\n${content.body}`
const view = (row: typeof a.authorSkills.$inferSelect): LibrarySkill => ({ skillId: row.id, revision: row.revision, version: row.version, contentHash: row.version, name: row.name, description: row.description, createdAt: row.createdAt, updatedAt: row.updatedAt, addToNewProjects: row.addToNewProjects })
const draftView = ({ id, status: _status, ...row }: typeof a.authorSkillDrafts.$inferSelect): SkillDraft => ({ draftId: id, ...row })
function parse(content: string) {
  try {
    const source = content.replace(/^\uFEFF/, '')
    const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source)
    const parsed = SkillContent.safeParse({ ...parseSkillMetadata(source), body: match ? source.slice(match[0].length) : '' })
    if (parsed.success) return parsed.data
  } catch { /* Invalid frontmatter is untrusted input, not an internal failure. */ }
  return fail('invalid_params', 'A valid SKILL.md with portable name, description and body is required')
}

export type SkillLibrary = ReturnType<typeof createSkillLibrary>
export function createSkillLibrary(db: AppDb, dataDir: string, now = Date.now) {
  const root = join(dataDir, 'skill-library')
  const file = (skillId: string, version: string) => join(root, skillId, version, 'SKILL.md')
  function event(tx: Tx, type: string, payload: unknown) { tx.insert(a.authorSkillEvents).values({ type, payload, createdAt: now() }).run() }
  function request<T>(method: string, params: { requestId: string; [key: string]: unknown }, fn: (tx: Tx) => T): T {
    return db.transaction(tx => {
      const fp = fingerprint(method, params)
      const previous = tx.select().from(a.idempotencyKeys).where(eq(a.idempotencyKeys.requestId, params.requestId)).get()
      if (previous) {
        if (previous.fingerprint !== fp) fail('idempotency_conflict', 'Request ID has already been used for different content')
        return previous.result as T
      }
      const result = fn(tx)
      tx.insert(a.idempotencyKeys).values({ requestId: params.requestId, fingerprint: fp, result }).run()
      return result
    }, { behavior: 'immediate' })
  }
  function live(skillId: string) {
    const row = db.select().from(a.authorSkills).where(and(eq(a.authorSkills.id, skillId), isNull(a.authorSkills.deletedAt))).get()
    if (!row) return fail('not_found', 'Skill does not exist')
    return row
  }
  function readVersion(skillId: string, version: string) {
    const row = db.select().from(a.authorSkillVersions).where(and(eq(a.authorSkillVersions.skillId, skillId), eq(a.authorSkillVersions.contentHash, version))).get()
    if (!row) return fail('not_found', 'Skill version does not exist')
    const content = readFileSync(file(skillId, version), 'utf8')
    if (hash(content) !== version) fail('revision_conflict', 'Saved skill content does not match its immutable hash')
    return { row, content }
  }
  function persist(tx: Tx, content: ReturnType<typeof parse>, text: string, previous?: typeof a.authorSkills.$inferSelect, draftId?: string) {
    const skillId = previous?.id ?? randomUUID()
    const version = hash(text)
    const target = file(skillId, version)
    const known = tx.select().from(a.authorSkillVersions).where(and(eq(a.authorSkillVersions.skillId, skillId), eq(a.authorSkillVersions.contentHash, version))).get()
    // Files precede metadata commits, so an interrupted save leaves only unreferenced immutable bytes.
    if (existsSync(target)) {
      if (readFileSync(target, 'utf8') !== text) fail('revision_conflict', 'Immutable skill version content differs')
    } else {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text, { flag: 'wx', mode: 0o600 })
    }
    const at = now()
    const row = { id: skillId, revision: (previous?.revision ?? 0) + 1, version, name: content.name, description: content.description, createdAt: previous?.createdAt ?? at, updatedAt: at, addToNewProjects: previous?.addToNewProjects ?? false, deletedAt: null }
    if (previous) tx.update(a.authorSkills).set(row).where(eq(a.authorSkills.id, skillId)).run()
    else tx.insert(a.authorSkills).values(row).run()
    if (!known) tx.insert(a.authorSkillVersions).values({ id: randomUUID(), skillId, contentHash: version, name: content.name, description: content.description, createdAt: at }).run()
    if (draftId) tx.update(a.authorSkillDrafts).set({ status: 'saved' }).where(eq(a.authorSkillDrafts.id, draftId)).run()
    event(tx, 'skill.saved', { skillId, version, draftId })
    return view(row)
  }
  function copy(rootPath: string, path: string) {
    const skills = join(rootPath, 'skills')
    if (lstatSync(skills, { throwIfNoEntry: false })?.isSymbolicLink()) fail('invalid_params', 'Project skills directory cannot be a symlink')
    const directory = dirname(path)
    if (dirname(directory) !== skills || basename(path) !== 'SKILL.md' || basename(directory).startsWith('.')) fail('invalid_params', 'A direct project skill copy is required')
    const directoryInfo = lstatSync(directory, { throwIfNoEntry: false })
    const info = lstatSync(path, { throwIfNoEntry: false })
    if (!directoryInfo || !info) return fail('not_found', 'Project copy does not exist')
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !info.isFile() || info.isSymbolicLink()) fail('invalid_params', 'Skill files cannot be symlinks or special files')
    const originPath = join(directory, '.vis-skill-origin.json')
    const originInfo = lstatSync(originPath, { throwIfNoEntry: false })
    if (!originInfo?.isFile() || originInfo.isSymbolicLink()) fail('invalid_params', 'Skill origin must be a regular file')
    let origin
    try { origin = SkillOrigin.parse(JSON.parse(readFileSync(originPath, 'utf8'))) }
    catch { return fail('invalid_params', 'Project copy has no valid origin') }
    const bytes = readFileSync(path)
    const content = bytes.toString('utf8')
    let metadata
    try { metadata = parseSkillMetadata(content) } catch { /* The pinned metadata keeps damaged copies recoverable. */ }
    if (!metadata?.description || !SkillContent.shape.name.safeParse(metadata.name).success) {
      const pinned = db.select().from(a.authorSkillVersions).where(and(eq(a.authorSkillVersions.skillId, origin.skillId), eq(a.authorSkillVersions.contentHash, origin.version))).get()
      if (!pinned) return fail('invalid_params', 'Project copy metadata and pinned version are unavailable')
      metadata = { name: pinned.name, description: pinned.description }
    }
    return { skill: { ...metadata, path }, origin, content, currentHash: hash(bytes), utf8: isUtf8(bytes), originPath }
  }
  function checkedCopy(rootPath: string, params: MethodParams<'skill.copyUpdate'>) {
    const found = copy(rootPath, params.path)
    if (found.currentHash !== params.expectedHash) fail('revision_conflict', 'Project copy changed; reread before replacing or publishing')
    return found
  }
  function replaceCopy(params: MethodParams<'skill.copyUpdate'>, rootPath: string, update: boolean): SkillView {
    return request(update ? 'skill.copyUpdate' : 'skill.copyReset', params, tx => {
      const found = checkedCopy(rootPath, params)
      const version = update ? live(found.origin.skillId).version : found.origin.version
      const { row: versionRow, content } = readVersion(found.origin.skillId, version)
      const normalized = (name: string) => name.normalize('NFC').toLowerCase()
      if (listSkills(rootPath).skills.some(skill => skill.path !== params.path && normalized(skill.name) === normalized(versionRow.name))) {
        throw VisError.of('invalid_params', 'skill.library_name_conflict', { name: versionRow.name }, 'A different project skill already uses the target name')
      }
      const origin = { skillId: found.origin.skillId, version, contentHash: version }
      const pending = join(dirname(params.path), `.updating-${randomUUID()}`)
      try {
        writeFileSync(pending, content, { flag: 'wx' })
        // Replace only the approved Markdown; supplemental project files are preserved.
        try { replaceFileSync(pending, params.path, { beforeAttempt: () => checkedCopy(rootPath, params) }) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EPERM') throw VisError.of('unavailable', 'skill.copy_file_locked', { path: params.path }, 'Close SKILL.md in other applications, then retry updating or resetting this copy')
          throw error
        }
        writeFileSync(found.originPath, `${JSON.stringify(origin, null, 2)}\n`)
      } finally { rmSync(pending, { force: true }) }
      event(tx, update ? 'copy.updated' : 'copy.reset', { spaceId: params.spaceId })
      return service.listProject(rootPath).skills.find(skill => skill.path === params.path)!
    })
  }
  const service = {
    sequence() { return db.select().from(a.authorSkillEvents).orderBy(desc(a.authorSkillEvents.seq)).limit(1).get()?.seq ?? 0 },
    list(): MethodResult<'skill.libraryList'> {
      return { skills: db.select().from(a.authorSkills).where(isNull(a.authorSkills.deletedAt)).orderBy(asc(a.authorSkills.createdAt), asc(a.authorSkills.id)).all().map(view), drafts: db.select().from(a.authorSkillDrafts).where(eq(a.authorSkillDrafts.status, 'draft')).orderBy(asc(a.authorSkillDrafts.createdAt), asc(a.authorSkillDrafts.id)).all().map(draftView) }
    },
    listProject(rootPath: string): MethodResult<'skill.list'> {
      const result = listSkills(rootPath)
      const skills = [...result.skills]
      const skillsPath = join(rootPath, 'skills')
      if (lstatSync(skillsPath, { throwIfNoEntry: false })?.isDirectory()) {
        for (const entry of readdirSync(skillsPath, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue
          const path = join(skillsPath, entry.name, 'SKILL.md')
          if (skills.some(skill => skill.path === path) || !existsSync(join(skillsPath, entry.name, '.vis-skill-origin.json'))) continue
          try { skills.push(copy(rootPath, path).skill) } catch { /* Unrecognized or unsafe origins stay in the problems list. */ }
        }
      }
      return { ...result, skills: skills.map(skill => {
        if (!existsSync(join(dirname(skill.path), '.vis-skill-origin.json'))) return skill
        try {
          const found = copy(rootPath, skill.path)
          const row = db.select().from(a.authorSkills).where(eq(a.authorSkills.id, found.origin.skillId)).get()
          return { ...skill, copy: { ...found.origin, currentHash: found.currentHash, edited: found.currentHash !== found.origin.contentHash, newer: !!row && row.deletedAt === null && row.version !== found.origin.version, missing: !row || row.deletedAt !== null } }
        } catch { return skill }
      }) }
    },
    get(skillId: string): MethodResult<'skill.libraryGet'> {
      const row = live(skillId)
      const { content } = readVersion(skillId, row.version)
      const frontmatter = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(content)
      return { ...view(row), body: frontmatter ? content.slice(frontmatter[0].length) : '' }
    },
    draftState(draftId: string): MethodResult<'skill.draftState'> {
      const row = db.select().from(a.authorSkillDrafts).where(eq(a.authorSkillDrafts.id, draftId)).get()
      if (!row) {
        // Step a removed decided drafts; its durable receipts still identify their final state after an upgrade.
        const decision = db.select().from(a.authorSkillEvents).orderBy(desc(a.authorSkillEvents.seq)).all().find(event =>
          ['skill.saved', 'draft.discarded'].includes(event.type) && (event.payload as { draftId?: string } | null)?.draftId === draftId)
        if (decision) return { status: decision.type === 'skill.saved' ? 'saved' : 'discarded' }
        return fail('not_found', 'Draft does not exist')
      }
      return { status: row.status, ...(row.status === 'draft' ? { draft: draftView(row) } : {}) }
    },
    propose(params: MethodParams<'skill.proposeDraft'>, spaceId: string, sessionId: string): MethodResult<'skill.proposeDraft'> {
      // The library renders its own frontmatter; a second block would land in the skill's text.
      if (/^\uFEFF?---\r?\n/.test(params.body)) throw VisError.of('invalid_params', 'skill.draft_frontmatter', {}, 'The body is Markdown only; put name and description in their own fields')
      return request('skill.proposeDraft', { ...params, spaceId, sessionId }, tx => {
        const draft = { id: randomUUID(), revision: 1, ...SkillContent.parse(params), spaceId, sessionId, createdAt: now(), status: 'draft' as const }
        tx.insert(a.authorSkillDrafts).values(draft).run()
        event(tx, 'draft.created', { draftId: draft.id, spaceId, sessionId })
        return { draft: draftView(draft), location: 'Settings > My skills' as const }
      })
    },
    save(params: MethodParams<'skill.librarySave'>): MethodResult<'skill.librarySave'> {
      return request('skill.librarySave', params, tx => {
        const content = SkillContent.parse(params)
        const draft = params.draftId ? tx.select().from(a.authorSkillDrafts).where(and(eq(a.authorSkillDrafts.id, params.draftId), eq(a.authorSkillDrafts.status, 'draft'))).get() : undefined
        const previous = params.skillId ? live(params.skillId) : undefined
        const source = draft ?? previous
        if (!source) return fail('not_found', 'Skill or draft does not exist')
        if (source.revision !== params.expectedRevision) fail('revision_conflict', 'Skill or draft changed; reread before saving')
        return persist(tx, content, render(content), previous, draft?.id)
      })
    },
    discard(params: MethodParams<'skill.discardDraft'>): MethodResult<'skill.discardDraft'> {
      return db.transaction(tx => {
        const row = tx.select().from(a.authorSkillDrafts).where(eq(a.authorSkillDrafts.id, params.draftId)).get()
        if (row?.status === 'draft') {
          if (row.revision !== params.expectedRevision) fail('revision_conflict', 'Draft changed; reread before discarding')
          tx.update(a.authorSkillDrafts).set({ status: 'discarded' }).where(eq(a.authorSkillDrafts.id, row.id)).run()
          event(tx, 'draft.discarded', { draftId: row.id })
        }
        return { ok: true as const }
      }, { behavior: 'immediate' })
    },
    setAutoAdd(params: MethodParams<'skill.setAutoAdd'>): LibrarySkill {
      return db.transaction(tx => {
        const row = live(params.skillId)
        if (row.revision !== params.expectedRevision) fail('revision_conflict', 'Skill changed; reread before changing preferences')
        const next = { ...row, addToNewProjects: params.enabled, revision: row.revision + 1, updatedAt: now() }
        tx.update(a.authorSkills).set(next).where(eq(a.authorSkills.id, row.id)).run()
        event(tx, 'skill.preferencesChanged', { skillId: row.id })
        return view(next)
      }, { behavior: 'immediate' })
    },
    delete(params: MethodParams<'skill.libraryDelete'>): MethodResult<'skill.libraryDelete'> {
      return db.transaction(tx => {
        const row = live(params.skillId)
        if (row.revision !== params.expectedRevision) fail('revision_conflict', 'Skill changed; reread before deleting')
        tx.update(a.authorSkills).set({ deletedAt: now(), revision: row.revision + 1 }).where(eq(a.authorSkills.id, row.id)).run()
        event(tx, 'skill.deleted', { skillId: row.id })
        return { ok: true as const }
      }, { behavior: 'immediate' })
    },
    export(skillId: string): MethodResult<'skill.export'> { const row = live(skillId); return { filename: 'SKILL.md', content: readVersion(skillId, row.version).content } },
    importDrafts(params: MethodParams<'skill.importDrafts'>): MethodResult<'skill.importDrafts'> {
      return request('skill.importDrafts', params, tx => {
        const contents = params.files.map(file => parse(file.content))
        const drafts = contents.map(content => ({ ...content, id: randomUUID(), revision: 1, createdAt: now(), spaceId: 'import', sessionId: 'import', status: 'draft' as const }))
        for (const draft of drafts) { tx.insert(a.authorSkillDrafts).values(draft).run(); event(tx, 'draft.created', { draftId: draft.id }) }
        return { drafts: drafts.map(draftView) }
      })
    },
    update: (params: MethodParams<'skill.copyUpdate'>, rootPath: string) => replaceCopy(params, rootPath, true),
    reset: (params: MethodParams<'skill.copyReset'>, rootPath: string) => replaceCopy(params, rootPath, false),
    publish(params: MethodParams<'skill.copyPublish'>, rootPath: string): LibrarySkill {
      return request('skill.copyPublish', params, tx => {
        const found = checkedCopy(rootPath, params)
        const previous = live(found.origin.skillId)
        if (!found.utf8) fail('invalid_params', 'Project skill Markdown must be UTF-8')
        if (previous.revision !== params.expectedRevision) fail('revision_conflict', 'Library skill changed; reread before publishing')
        const saved = persist(tx, parse(found.content), found.content, previous)
        checkedCopy(rootPath, params)
        writeFileSync(found.originPath, `${JSON.stringify({ skillId: saved.skillId, version: saved.version, contentHash: saved.contentHash }, null, 2)}\n`)
        return saved
      })
    },
    addToProject(spaceId: string, rootPath: string): string[] {
      const skipped: string[] = []
      for (const skill of service.list().skills.filter(skill => skill.addToNewProjects)) {
        try { service.use({ requestId: `skill-auto-${spaceId}-${skill.skillId}`, spaceId, skillId: skill.skillId, version: skill.version }, rootPath) }
        catch (error) { if (error instanceof VisError && error.details?.reason === 'skill.library_name_conflict') skipped.push(skill.name); else throw error }
      }
      return skipped
    },
    use(params: MethodParams<'skill.use'>, rootPath: string): MethodResult<'skill.use'> {
      return request('skill.use', params, tx => {
        live(params.skillId)
        const { row, content } = readVersion(params.skillId, params.version)
        if (!SkillContent.shape.name.safeParse(row.name).success) fail('invalid_params', 'Rename this skill to a portable directory name before using it')
        const skills = join(rootPath, 'skills')
        if (lstatSync(skills, { throwIfNoEntry: false })?.isSymbolicLink()) fail('invalid_params', 'Project skills directory cannot be a symlink')
        mkdirSync(skills, { recursive: true })
        const target = join(skills, row.name)
        const normalized = (name: string) => name.normalize('NFC').toLowerCase()
        if (lstatSync(target, { throwIfNoEntry: false }) || readdirSync(skills).some(name => normalized(name) === normalized(row.name)) || listSkills(rootPath).skills.some(skill => normalized(skill.name) === normalized(row.name))) {
          throw VisError.of('invalid_params', 'skill.library_name_conflict', { name: row.name }, 'A skill with this name already exists; choose another name in My skills or remove the project copy first')
        }
        const pending = join(skills, `.importing-${randomUUID()}`)
        const origin = { skillId: params.skillId, version: params.version, contentHash: params.version }
        try {
          mkdirSync(pending)
          writeFileSync(join(pending, 'SKILL.md'), content)
          writeFileSync(join(pending, '.vis-skill-origin.json'), `${JSON.stringify(origin, null, 2)}\n`)
          renameSync(pending, target)
        } finally { rmSync(pending, { recursive: true, force: true }) }
        event(tx, 'skill.used', { ...origin, spaceId: params.spaceId })
        return { skill: { name: row.name, description: row.description, path: join(target, 'SKILL.md') }, origin }
      })
    },
  }
  return service
}
