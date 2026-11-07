import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LibrarySkill, SpaceSummary, WorkItemView } from '@vis/protocol'
import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const chrome = chromePath()
const ready = existsSync(chrome) && existsSync(join(root, 'services/studiod/dist/studiod.mjs')) && existsSync(join(root, 'apps/web/dist/vis-web.mjs'))
const artifacts = '/tmp/vis-next/rfc33b'
const processes: ChildProcess[] = []
const errors: string[] = []
let dir: string
let projects: string
let browser: Browser
let page: Page
let admin: StudiodLink
let sequence = 0
let first: SpaceSummary
let second: SpaceSummary
let work: WorkItemView
const rid = () => `author-skills-e2e-${++sequence}`
const settings = () => page.getByRole('dialog', { name: '设置', exact: true })
const library = () => settings().getByRole('region', { name: '我的 Skill', exact: true })
const composer = () => page.getByRole('textbox', { name: '给 Agent 发消息', exact: true })
const evidence = (item = work) => {
  const file = join(item.workDir, '.vis-e2e-agent.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
async function start(script: string, env: Record<string, string>, pattern: RegExp): Promise<string> {
  const proc = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  processes.push(proc)
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${script}\n${output}`)), 15_000)
    const data = (chunk: Buffer) => { output += chunk; const match = output.match(pattern); if (match) { clearTimeout(timeout); resolve(match[1] ?? match[0]) } }
    proc.stdout!.on('data', data)
    proc.stderr!.on('data', data)
    proc.once('error', reject)
    proc.once('exit', code => { clearTimeout(timeout); reject(new Error(`Process exited (${code}): ${output}`)) })
  })
}
async function openProject(project: SpaceSummary, item: WorkItemView) {
  const back = page.getByRole('button', { name: '返回列表', exact: true })
  if (await back.isVisible()) await back.click()
  await page.getByRole('button', { name: '切换项目', exact: true }).click()
  await page.getByRole('menu', { name: '项目', exact: true }).getByRole('menuitem').filter({ has: page.getByText(project.name, { exact: true }) }).click()
  await expect.poll(() => page.getByRole('button', { name: '切换项目', exact: true }).textContent()).toContain(project.name)
  await page.getByRole('region', { name: '工作区', exact: true }).getByRole('listitem', { name: new RegExp(`^${item.title}，`) }).click()
  await composer().waitFor()
  await admin.call('events.subscribe', { spaceId: project.spaceId })
}
async function openLibrary() {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await settings().getByRole('button', { name: '我的 Skill', exact: true }).click()
  await library().waitFor()
}
async function closeLibrary() {
  await settings().getByRole('button', { name: '关闭设置', exact: true }).click()
  await settings().waitFor({ state: 'hidden' })
}
async function send(text: string) {
  await composer().fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}
async function ended(project: SpaceSummary, item: WorkItemView) {
  await expect.poll(async () => (await admin.call('session.list', { spaceId: project.spaceId })).sessions.find((session: { sessionId: string }) => session.sessionId === item.sessions[0]!.sessionId)?.activeTurnId, { timeout: 10_000 }).toBeNull()
}

describe.skipIf(!ready)('RFC 0033 author skill library', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-author-skills-data-'))
    projects = mkdtempSync(join(tmpdir(), 'vis-author-skills-projects-'))
    const env = { VIS_DATA_DIR: dir, VIS_PROJECTS_DIR: projects, VIS_CLI_BIN_DIR: join(root, 'apps/cli/dist'), VIS_CODEX_PATH: join(root, 'apps/web/e2e/fake-codex.mjs') }
    await start(join(root, 'services/studiod/dist/studiod.mjs'), env, /\[studiod\] Started /)
    const url = await start(join(root, 'apps/web/dist/vis-web.mjs'), env, /(http:\/\/127\.0\.0\.1:\d+\/#t=\S+)/)
    admin = await openStudiodLink({ socketPath: studiodEndpoint(dir), tokenPath: join(dir, 'run/studiod.token') })
    first = await admin.call('space.create', { requestId: rid(), name: '创作方法 · 初稿', rootPath: join(projects, 'first') })
    second = await admin.call('space.create', { requestId: rid(), name: '创作方法 · 下一部', rootPath: join(projects, 'second') })
    work = (await admin.call('work.create', { requestId: rid(), spaceId: first.spaceId, title: '我的创作方法', chat: { agentKind: 'codex' } })).item
    browser = await chromium.launch({ executablePath: chrome, headless: true })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.stack ?? error.message))
    await page.goto(url)
    await page.getByRole('button', { name: '设置', exact: true }).waitFor()
  }, 30_000)
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(artifacts, 'failure.png'), animations: 'disabled' })
    if (page) { await page.keyboard.press('Escape'); await page.keyboard.press('Escape') }
  })
  afterAll(async () => {
    admin?.close()
    await browser?.close()
    for (const proc of processes) proc.kill('SIGINT')
    await Promise.all(processes.map(proc => proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => proc.once('exit', () => resolve()))))
    removeTempDir(dir)
    removeTempDir(projects)
  }, 30_000)

  it('drafts on request, reviews and saves, pins copies in two projects, and reads the second copy in a fake Codex turn', async () => {
    await openProject(first, work)
    await send('author-skill-draft quiet-story')
    await page.getByText('Draft “quiet-story” is in Settings > My skills. Review and save it there.', { exact: true }).waitFor()
    await ended(first, work)
    expect((await admin.call('skill.libraryList', {})).skills).toEqual([])
    expect((await admin.call('skill.list', { spaceId: first.spaceId })).skills).toEqual([])
    await openLibrary()
    await library().getByRole('button', { name: '编辑草稿 quiet-story', exact: true }).click()
    await library().getByLabel('名称', { exact: true }).fill('quiet-story')
    await library().getByLabel('描述', { exact: true }).fill('留白与细节：我的安静叙事方法')
    const body = '# 我的方法\n\n保留我要求的停顿。让每个画面有呼吸的时间，因为我想让人注意到细节。\n\n先写我看到的事物，再写声音；不替我总结情绪。\n'
    await library().getByLabel('Skill 正文', { exact: true }).fill(body)
    const nameBox = await library().getByLabel('名称', { exact: true }).boundingBox()
    const bodyBox = await library().getByLabel('Skill 正文', { exact: true }).boundingBox()
    const saveBox = await library().getByRole('button', { name: '保存到我的 Skill', exact: true }).boundingBox()
    expect(nameBox!.y + nameBox!.height).toBeLessThan(bodyBox!.y)
    expect(bodyBox!.y + bodyBox!.height).toBeLessThan(saveBox!.y)
    expect(saveBox!.y + saveBox!.height).toBeLessThan(1000)
    await page.screenshot({ path: join(artifacts, 'draft-editing.png'), animations: 'disabled' })
    await library().getByRole('button', { name: '保存到我的 Skill', exact: true }).click()
    await library().getByText('已保存到我的 Skill。', { exact: true }).waitFor()
    const saved: LibrarySkill = (await admin.call('skill.libraryList', {})).skills[0]
    expect((await admin.call('skill.libraryList', {})).drafts).toEqual([])
    expect((await admin.call('skill.libraryGet', { skillId: saved.skillId })).body).toBe(body)
    await library().getByRole('button', { name: '返回我的 Skill', exact: true }).click()
    await library().getByRole('button', { name: '在此项目使用 quiet-story', exact: true }).click()
    await library().getByText(/^已复制到此项目/).waitFor()
    const original = readFileSync(join(first.rootPath, 'skills/quiet-story/SKILL.md'), 'utf8')
    await closeLibrary()
    const otherWork = (await admin.call('work.create', { requestId: rid(), spaceId: second.spaceId, title: '下一部作品', chat: { agentKind: 'codex' } })).item
    await openProject(second, otherWork)
    await openLibrary()
    await library().getByRole('button', { name: '编辑 quiet-story', exact: true }).waitFor()
    const listBox = await library().getByRole('button', { name: '编辑 quiet-story', exact: true }).boundingBox()
    const useBox = await library().getByRole('button', { name: '在此项目使用 quiet-story', exact: true }).boundingBox()
    expect(listBox!.x + listBox!.width).toBeLessThan(useBox!.x)
    expect(useBox!.x + useBox!.width).toBeLessThan(1600)
    await page.screenshot({ path: join(artifacts, 'my-skills.png'), animations: 'disabled' })
    await library().getByRole('button', { name: '在此项目使用 quiet-story', exact: true }).click()
    await library().getByText(/^已复制到此项目/).waitFor()
    const skillPath = realpathSync(join(second.rootPath, 'skills/quiet-story/SKILL.md'))
    expect((await admin.call('skill.list', { spaceId: second.spaceId })).skills).toMatchObject([{ name: 'quiet-story', description: '留白与细节：我的安静叙事方法' }])
    expect(JSON.parse(readFileSync(join(second.rootPath, 'skills/quiet-story/.vis-skill-origin.json'), 'utf8'))).toEqual({ skillId: saved.skillId, version: saved.version, contentHash: saved.contentHash })
    await library().getByRole('button', { name: '编辑 quiet-story', exact: true }).click()
    await library().getByLabel('Skill 正文', { exact: true }).fill('A later library version, chosen by the author.')
    await library().getByRole('button', { name: '保存到我的 Skill', exact: true }).click()
    await library().getByText('已保存到我的 Skill。', { exact: true }).waitFor()
    expect(readFileSync(skillPath, 'utf8')).toBe(original)
    expect(readFileSync(join(first.rootPath, 'skills/quiet-story/SKILL.md'), 'utf8')).toBe(original)
    await library().getByRole('button', { name: '返回我的 Skill', exact: true }).click()
    await library().getByRole('button', { name: '在此项目使用 quiet-story', exact: true }).click()
    await library().getByRole('alert').getByText(/项目已有名为/).waitFor()
    expect(readFileSync(skillPath, 'utf8')).toBe(original)
    await closeLibrary()
    await page.getByRole('button', { name: 'Skill', exact: true }).click()
    await page.getByRole('listbox', { name: 'Skill', exact: true }).getByRole('option', { name: /quiet-story/ }).click()
    await send('author-skill-read quiet-story')
    await page.getByText('Read project skill: quiet-story', { exact: true }).waitFor()
    await ended(second, otherWork)
    const turn = evidence(otherWork).find(item => item.method === 'turn/start' && item.prompt.startsWith('author-skill-read'))
    expect(turn.prompt).toContain(JSON.stringify(skillPath))
    expect(evidence(otherWork).find(item => item.method === 'author-skill-read')).toMatchObject({ path: skillPath, body: original })
    expect(errors).toEqual([])
  }, 40_000)

  it('discards an Agent draft through the UI without saving it or installing any copy', async () => {
    await openProject(first, work)
    const before = await admin.call('skill.libraryList', {})
    await send('author-skill-draft unwanted-draft')
    await page.getByText('Draft “unwanted-draft” is in Settings > My skills. Review and save it there.', { exact: true }).waitFor()
    await openLibrary()
    await library().getByRole('button', { name: '编辑草稿 unwanted-draft', exact: true }).click()
    await library().getByLabel('Skill 正文', { exact: true }).fill('Unapproved edits')
    page.once('dialog', dialog => dialog.accept())
    await library().getByRole('button', { name: '丢弃', exact: true }).click()
    await library().getByText('已丢弃。', { exact: true }).waitFor()
    const result = await admin.call('skill.libraryList', {})
    expect(result.drafts).toEqual(before.drafts)
    expect(result.skills).toEqual(before.skills)
    expect(existsSync(join(first.rootPath, 'skills/unwanted-draft'))).toBe(false)
    await closeLibrary()
    await page.getByRole('article', { name: 'Skill 草稿', exact: true }).filter({ hasText: 'unwanted-draft' }).getByText('已丢弃', { exact: true }).waitFor()
    expect(errors).toEqual([])
  })
  it('reviews a live session draft card and keeps copies in step through author decisions', async () => {
    await openProject(first, work)
    const before = evidence().filter(item => item.method === 'turn/start').length
    await page.getByRole('button', { name: '保存为 Skill', exact: true }).click()
    await expect.poll(() => composer().inputValue()).toContain('起草为我的 Skill')
    await expect.poll(() => composer().evaluate(element => element === document.activeElement)).toBe(true)
    expect(evidence().filter(item => item.method === 'turn/start')).toHaveLength(before)
    await send('author-skill-draft sync-method')
    const card = page.getByRole('article', { name: 'Skill 草稿', exact: true }).filter({ hasText: 'sync-method' })
    await card.getByRole('button', { name: '审阅', exact: true }).waitFor()
    const cardBox = await card.boundingBox()
    const reviewBox = await card.getByRole('button', { name: '审阅', exact: true }).boundingBox()
    expect(reviewBox!.y).toBeGreaterThan(cardBox!.y)
    expect(reviewBox!.x + reviewBox!.width).toBeLessThan(cardBox!.x + cardBox!.width)
    await page.screenshot({ path: join(artifacts, 'session-draft-card.png'), animations: 'disabled' })
    await card.getByRole('button', { name: '审阅', exact: true }).click()
    await expect.poll(() => library().getByLabel('名称', { exact: true }).inputValue()).toBe('sync-method')
    await library().getByRole('button', { name: '保存到我的 Skill', exact: true }).click()
    await library().getByText('已保存到我的 Skill。', { exact: true }).waitFor()
    await closeLibrary()
    await card.getByText('已保存到我的 Skill', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: '审阅', exact: true }).count()).toBe(0)
    await page.screenshot({ path: join(artifacts, 'session-saved-card.png'), animations: 'disabled' })
    await openLibrary()
    await library().getByRole('button', { name: '在此项目使用 sync-method', exact: true }).click()
    await library().getByText(/^已复制到此项目/).waitFor()
    const path = join(first.rootPath, 'skills/sync-method/SKILL.md')
    const original = readFileSync(path, 'utf8')
    await library().getByRole('button', { name: '编辑 sync-method', exact: true }).click()
    await library().getByLabel('Skill 正文', { exact: true }).fill('The author chose a newer library method.')
    await library().getByRole('button', { name: '保存到我的 Skill', exact: true }).click()
    await library().getByText('已保存到我的 Skill。', { exact: true }).waitFor()
    await library().getByRole('button', { name: '返回我的 Skill', exact: true }).click()
    await closeLibrary()
    writeFileSync(path, original + '\nEdited here by the author.')
    await openLibrary()
    const copies = library().getByRole('list', { name: '此项目的副本', exact: true })
    const copy = copies.getByRole('listitem').filter({ hasText: 'sync-method' })
    await copy.getByText('有新版本可用', { exact: true }).waitFor()
    await copy.getByText('已在此项目修改', { exact: true }).waitFor()
    const nameBox = await copy.getByText('sync-method', { exact: true }).boundingBox()
    const updateBox = await copy.getByRole('button', { name: '更新 sync-method', exact: true }).boundingBox()
    expect(nameBox!.y).toBeLessThan(updateBox!.y + updateBox!.height)
    expect(updateBox!.x + updateBox!.width).toBeLessThan(1600)
    await page.screenshot({ path: join(artifacts, 'my-skills-copy-states.png'), animations: 'disabled' })
    page.once('dialog', dialog => dialog.dismiss())
    await copy.getByRole('button', { name: '更新 sync-method', exact: true }).click()
    expect(readFileSync(path, 'utf8')).toBe(original + '\nEdited here by the author.')
    page.once('dialog', dialog => dialog.accept())
    await copy.getByRole('button', { name: '更新 sync-method', exact: true }).click()
    await expect.poll(() => readFileSync(path, 'utf8')).toContain('The author chose a newer library method.')
    const pinned = readFileSync(path, 'utf8')
    await closeLibrary()
    writeFileSync(path, pinned + '\nAn edit to reset.')
    await openLibrary()
    await copy.getByText('已在此项目修改', { exact: true }).waitFor()
    page.once('dialog', dialog => dialog.dismiss())
    await copy.getByRole('button', { name: '重置 sync-method', exact: true }).click()
    expect(readFileSync(path, 'utf8')).toContain('An edit to reset.')
    page.once('dialog', dialog => dialog.accept())
    await copy.getByRole('button', { name: '重置 sync-method', exact: true }).click()
    await expect.poll(() => readFileSync(path, 'utf8')).toBe(pinned)
    await closeLibrary()
    const published = pinned + '\nMy project refinement.'
    writeFileSync(path, published)
    await openLibrary()
    await copy.getByText('已在此项目修改', { exact: true }).waitFor()
    await copy.getByRole('button', { name: '发布 sync-method', exact: true }).click()
    await expect.poll(async () => {
      const saved = (await admin.call('skill.libraryList', {})).skills.find((skill: LibrarySkill) => skill.name === 'sync-method')
      return (await admin.call('skill.export', { skillId: saved.skillId })).content
    }).toBe(published)
    await expect.poll(() => copy.getByText('已在此项目修改', { exact: true }).count()).toBe(0)
    await library().getByRole('checkbox', { name: '将 sync-method 加入新项目', exact: true }).check()
    await expect.poll(async () => (await admin.call('skill.libraryList', {})).skills.find((skill: LibrarySkill) => skill.name === 'sync-method')?.addToNewProjects).toBe(true)
    await closeLibrary()
    async function createProject(name: string, path: string) {
      await page.getByRole('button', { name: '切换项目', exact: true }).click()
      await page.getByRole('menuitem', { name: '＋ 新建项目', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '新建项目', exact: true })
      await dialog.getByLabel('项目名称', { exact: true }).fill(name)
      await dialog.getByLabel('项目位置', { exact: true }).fill(path)
      await dialog.getByRole('button', { name: '暂不创建', exact: true }).click()
      await dialog.getByRole('button', { name: '创建项目', exact: true }).click()
      await expect.poll(() => page.getByRole('button', { name: '切换项目', exact: true }).textContent()).toContain(name)
      return (await admin.call('space.list', {})).spaces.find((item: SpaceSummary) => item.name === name)
    }
    const newProject = await createProject('New project with my skill', join(projects, 'auto-added'))
    expect(readFileSync(join(newProject.rootPath, 'skills/sync-method/SKILL.md'), 'utf8')).toBe(published)
    expect(existsSync(join(second.rootPath, 'skills/sync-method'))).toBe(false)
    const clashing = join(projects, 'clashing')
    mkdirSync(join(clashing, 'skills/sync-method'), { recursive: true })
    const existing = '---\nname: sync-method\ndescription: Existing project method\n---\nKeep my existing work.'
    writeFileSync(join(clashing, 'skills/sync-method/SKILL.md'), existing)
    await createProject('New project with a name clash', clashing)
    await page.getByText('新项目中已有同名内容，已跳过这些 Skill：sync-method', { exact: true }).waitFor()
    expect(readFileSync(join(clashing, 'skills/sync-method/SKILL.md'), 'utf8')).toBe(existing)
    await openProject(first, work)
    await openLibrary()
    const downloadPromise = page.waitForEvent('download')
    await library().getByRole('button', { name: '导出 sync-method', exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe('SKILL.md')
    expect(readFileSync((await download.path())!, 'utf8')).toBe(published)
    const countBefore = (await admin.call('skill.libraryList', {})).skills.length
    await library().getByLabel('Skill Markdown 文件', { exact: true }).setInputFiles([
      { name: 'imported.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: imported-method\ndescription: Read this untrusted import\n---\nOnly a draft until saved.') },
      { name: 'another.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: another-import\ndescription: Another untrusted draft\n---\nRead and decide.') },
    ])
    await library().getByRole('button', { name: '编辑草稿 imported-method', exact: true }).waitFor()
    await library().getByRole('button', { name: '编辑草稿 another-import', exact: true }).waitFor()
    expect((await admin.call('skill.libraryList', {})).skills).toHaveLength(countBefore)
    expect(existsSync(join(first.rootPath, 'skills/imported-method'))).toBe(false)
    const live = (await admin.call('skill.libraryList', {})).skills.find((skill: LibrarySkill) => skill.name === 'sync-method')
    await admin.call('skill.setAutoAdd', { skillId: live.skillId, expectedRevision: live.revision, enabled: false })
    await expect.poll(() => library().getByRole('checkbox', { name: '将 sync-method 加入新项目', exact: true }).isChecked()).toBe(false)
    page.once('dialog', dialog => dialog.accept())
    await library().getByRole('button', { name: '删除 sync-method', exact: true }).click()
    await copy.getByText('已从我的 Skill 删除', { exact: true }).waitFor()
    expect(await copy.getByRole('button', { name: '发布 sync-method', exact: true }).isDisabled()).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(published)
    expect(errors).toEqual([])
  }, 60_000)

})
