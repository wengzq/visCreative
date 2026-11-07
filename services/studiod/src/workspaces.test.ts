import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, ftruncateSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaTools } from '@vis/assets'
import { appSchema as a, eq, openAppDb, openSpaceDb, spaceSchema as s } from '@vis/storage'
import { DispatchError, type DispatchInput } from '@vis/workbench-core'
import { listProjectSkills, pickDirectory, validateDirectory } from './filesystem'
import { importAgentFile } from './media'
import { createSpaceRegistry, type SpaceRegistry } from './space-host'

let dir: string
let appDb: ReturnType<typeof openAppDb>
let spaces: SpaceRegistry
let dispatched: DispatchInput[]
let rejectDispatch: boolean
let sequence = 0
const requestId = () => `workspace-${++sequence}`

function registry() {
  return createSpaceRegistry({
    appDb, dataDir: dir,
    host: {
      runtimes: { codex: () => ({
        async ensureReady() {},
        async dispatchTurn(input) {
          dispatched.push(input)
          if (rejectDispatch) { rejectDispatch = false; throw new DispatchError('unknown', 'lost reply') }
        },
        async terminateTurn() {}, async interruptTurn() {},
      }) },
      providers: [], defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    },
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-workspaces-'))
  vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
  appDb = openAppDb(join(dir, 'app.db'))
  dispatched = []
  rejectDispatch = false
  spaces = registry()
})

afterEach(async () => {
  await spaces.closeAll()
  appDb.$client.close()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('Project and session directories', () => {
  it('project creation initializes directories without duplicates on global idempotent retries', async () => {
    const params = { requestId: requestId(), name: '海报项目' }
    const created = spaces.create(params)
    expect(created.rootPath).toBe(join(dir, 'projects', '海报项目'))
    for (const name of ['assets', 'skills', 'workspaces']) expect(existsSync(join(created.rootPath, name))).toBe(true)
    expect(spaces.create(params)).toEqual(created)
    expect(() => spaces.create({ ...params, name: '其他' })).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
    expect(() => spaces.create({ requestId: requestId(), name: '相对路径', rootPath: './relative' })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    expect(spaces.create({ requestId: requestId(), name: '../外部' }).rootPath).toBe(join(dir, 'projects', '..-外部'))
    await spaces.closeAll()
    spaces = registry()
    expect(spaces.create(params)).toEqual(created)
    expect(spaces.list()).toHaveLength(2)
  })

  it('migrates legacy projects and idle sessions, preserving the old cwd without recreating directories that later disappear', async () => {
    appDb.insert(a.spaces).values({ id: 'old', name: '原有空间', dir: 'spaces/old', createdAt: 1 }).run()
    const legacyDir = join(dir, 'spaces', 'old')
    mkdirSync(legacyDir, { recursive: true })
    const old = openSpaceDb(join(legacyDir, 'space.db'))
    old.insert(s.sessions).values({ id: 'never-run', agentKind: 'codex', title: '旧会话', agentResumeId: 'resume-old', createdAt: 1 }).run()
    old.$client.close()
    spaces = registry()
    const project = spaces.list()[0]!
    expect(project.rootPath).toBe(join(legacyDir, 'project'))
    expect(project.name).toBe('原有空间')
    for (const folder of ['assets', 'skills', 'workspaces']) expect(existsSync(join(project.rootPath, folder))).toBe(true)
    const host = spaces.get('old')!
    const workDir = join(legacyDir, 'sessions', 'never-run')
    expect(host.workDir('never-run')).toBe(workDir)
    expect(host.db.select().from(s.sessions).get()).toMatchObject({ workDir, agentResumeId: 'resume-old', title: '旧会话' })
    await spaces.closeAll()
    rmSync(workDir, { recursive: true })
    spaces = registry()
    expect(() => spaces.get('old')!.workDir('never-run')).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(existsSync(workDir)).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('POSIX: rejects project roots and existing workspaces with non-writable mode bits', () => {
    const project = spaces.create('权限项目')
    const host = spaces.get(project.spaceId)!
    chmodSync(project.rootPath, 0o500)
    try {
      expect(validateDirectory(project.rootPath)).toMatchObject({ valid: false })
      expect(() => spaces.create({ requestId: requestId(), name: '不可写', rootPath: project.rootPath })).toThrow()
      expect(() => host.sessions.create({ requestId: requestId(), workDir: project.rootPath })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    } finally { chmodSync(project.rootPath, 0o700) }
  })

  it('automatically names empty names, prevents traversal and collisions in named directories, reuses existing directories and does not move cwd on rename', () => {
    const project = spaces.create('目录项目')
    const host = spaces.get(project.spaceId)!
    const create = (title?: string, workDir?: string) => host.sessions.create({ requestId: requestId(), title, workDir })
    const automatic = create('  ')
    expect(automatic).toMatchObject({ title: 'Codex 1', titleSource: 'default' })
    expect(automatic.workDir).toMatch(/[\\/]workspaces[\\/]ws-[A-Z0-9]{8}$/)
    const first = create('../海报 / V1')
    const second = create('../海报 / V1')
    expect(first).toMatchObject({ titleSource: 'user', workDir: join(project.rootPath, 'workspaces', '海报-v1') })
    expect(second.workDir).not.toBe(first.workDir)
    const existing = join(dir, 'existing')
    mkdirSync(existing)
    writeFileSync(join(existing, 'AGENTS.md'), '用户规则')
    const attached = create('已有工作区', existing)
    expect(attached.workDir).toBe(existing)
    host.sessions.rename({ requestId: requestId(), sessionId: attached.sessionId, title: '改名' })
    expect(host.workDir(attached.sessionId)).toBe(existing)
    expect(readFileSync(join(existing, 'AGENTS.md'), 'utf8')).toBe('用户规则')
    for (const workDir of ['./relative', join(dir, 'missing')]) {
      expect(() => create('无效', workDir)).toThrow(expect.objectContaining({ code: 'invalid_params' }))
    }
  })
})

describe('Project skills', () => {
  function skill(root: string, folder: string, body: string) {
    const path = join(root, 'skills', folder, 'SKILL.md')
    mkdirSync(join(root, 'skills', folder), { recursive: true })
    writeFileSync(path, body)
    return path
  }

  it('parses single- and double-quoted metadata and retains only one duplicate skill name in directory order', () => {
    const project = spaces.create('元数据项目')
    const path = realpathSync(skill(project.rootPath, 'a', '---\nname: "quoted"\ndescription: \'A \'\'quoted\'\' skill\' # 注释\n---\n'))
    skill(project.rootPath, 'b', '---\nname: quoted\ndescription: second\n---\n')
    expect(listProjectSkills(project.rootPath)).toEqual([{ name: 'quoted', description: "A 'quoted' skill", path }])
  })

  it('lists only one level of valid frontmatter; selected skill names persist in the database, retries and deliveries', async () => {
    const project = spaces.create('技能项目')
    const path = realpathSync(skill(project.rootPath, 'story', '---\nname: story\ndescription: >-\n  第一行\n  第二行\n---\n正文'))
    skill(project.rootPath, 'broken', '没有 frontmatter')
    skill(project.rootPath, 'nested/deeper', '---\nname: hidden\ndescription: hidden\n---\n')
    const outside = join(dir, 'external-skill.md')
    writeFileSync(outside, '---\nname: escaped\ndescription: escaped\n---\n')
    mkdirSync(join(project.rootPath, 'skills', 'escape'))
    symlinkSync(outside, join(project.rootPath, 'skills', 'escape', 'SKILL.md'))
    expect(listProjectSkills(project.rootPath)).toEqual([{ name: 'story', description: '第一行 第二行', path }])
    const host = spaces.get(project.spaceId)!
    const session = host.sessions.create({ requestId: requestId() })
    rejectDispatch = true
    const sent = host.sessions.sendMessage({ requestId: requestId(), sessionId: session.sessionId, text: '写分镜', refs: [], skills: ['story'] })
    await host.sessions.idle()
    expect(dispatched[0]).toMatchObject({ skills: ['story'], projectContext: { rootPath: project.rootPath, workDir: session.workDir, skills: [{ name: 'story', path }] } })
    expect(host.sessions.getTranscript({ sessionId: session.sessionId }).items[0]?.payload).toMatchObject({ skills: ['story'] })
    const retry = host.sessions.retryMessage({ requestId: requestId(), messageId: sent.messageId })
    await host.sessions.idle()
    expect(host.db.select().from(s.messages).where(eq(s.messages.id, retry.messageId)).get()?.skills).toEqual(['story'])
    expect(dispatched[1]?.skills).toEqual(['story'])
    expect(() => host.sessions.sendMessage({ requestId: requestId(), sessionId: session.sessionId, text: '非法技能', refs: [], skills: ['unknown'] })).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  })
})

describe('Restricted file import', () => {
  const media: MediaTools = {
    async process() { throw new Error('Unexpected local processing') },
    async analyzeSilence() { throw new Error('Unexpected silence analysis') },
    async probe(path) {
      if (!path.endsWith('.png')) throw new Error('unsupported media')
      return { kind: 'image', mime: 'image/png' }
    },
    async extractFrames() { return [] },
  }

  it('accepts only files inside cwd and assets, prevents symlink escapes and limits file size', async () => {
    const project = spaces.create('导入项目')
    const host = spaces.get(project.spaceId)!
    const session = host.sessions.create({ requestId: requestId() })
    const other = host.sessions.create({ requestId: requestId() })
    const allowed = join(session.workDir, 'frame.png')
    const asset = join(project.rootPath, 'assets', 'frame.png')
    const outside = join(other.workDir, 'frame.png')
    for (const path of [allowed, asset, outside]) writeFileSync(path, 'png bytes')
    const params = { requestId: requestId(), path: allowed }
    const first = await importAgentFile(host, media, session.sessionId, params)
    expect(await importAgentFile(host, media, session.sessionId, params)).toEqual(first)
    expect(await importAgentFile(host, media, session.sessionId, { requestId: requestId(), path: asset })).toMatchObject({ kind: 'image' })
    const link = join(session.workDir, 'escape.png')
    symlinkSync(outside, link)
    const traversal = join(session.workDir, '..', other.workDir.split(/[\\/]/).at(-1)!, 'frame.png')
    for (const path of [outside, link, traversal]) await expect(importAgentFile(host, media, session.sessionId, { requestId: requestId(), path })).rejects.toMatchObject({ code: 'forbidden' })
    const text = join(session.workDir, 'source.txt')
    writeFileSync(text, '不是媒体')
    await expect(importAgentFile(host, media, session.sessionId, { requestId: requestId(), path: text })).rejects.toMatchObject({ code: 'invalid_params' })
    const huge = join(session.workDir, 'huge.png')
    const fd = openSync(huge, 'w')
    ftruncateSync(fd, 2 * 1024 ** 3 + 1)
    closeSync(fd)
    await expect(importAgentFile(host, media, session.sessionId, { requestId: requestId(), path: huge })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(importAgentFile(host, media, session.sessionId, { requestId: requestId(), path: './relative.png' })).rejects.toMatchObject({ code: 'invalid_params' })
  })
})

it('directory validation and controlled directory selection do not create user paths', async () => {
  expect(validateDirectory(dir)).toEqual({ valid: true })
  expect(validateDirectory('./relative')).toMatchObject({ valid: false })
  expect(validateDirectory(join(dir, 'missing'))).toMatchObject({ valid: false })
  vi.stubEnv('VIS_PICK_DIRECTORY', dir)
  expect(await pickDirectory({})).toEqual({ path: dir, cancelled: false, unsupported: false })
  vi.stubEnv('VIS_PICK_DIRECTORY', 'cancel')
  expect(await pickDirectory({})).toEqual({ cancelled: true, unsupported: false })
})
