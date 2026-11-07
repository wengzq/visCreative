import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { chromePath, removeTempDir } from './platform'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
// Real studiod, web host, and Chrome; projects, import sources, and app data use temporary directories, with local fake Codex.
import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import type { SpaceSummary, WorkItemView } from '@vis/protocol'
import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const CHROME = chromePath()
const ready = existsSync(CHROME) && existsSync(join(root, 'services/studiod/dist/studiod.mjs')) && existsSync(join(root, 'apps/web/dist/vis-web.mjs'))
const artifacts = join(tmpdir(), 'vis-0017-skills')
const processes: ChildProcess[] = []
const errors: string[] = []
let dir: string
let projectsDir: string
let sourceDir: string
let browser: Browser
let page: Page
let admin: StudiodLink
let webUrl: string
let project: SpaceSummary
let work: WorkItemView
let sequence = 0
const rid = () => `skills-e2e-${++sequence}`
const skillText = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n请先读取项目素材，再整理分镜。\n`
const manager = () => page.getByRole('dialog', { name: '项目 Skill', exact: true })
const confirmation = () => page.getByRole('dialog', { name: '确认导入', exact: true })
const picker = () => page.getByRole('listbox', { name: 'Skill', exact: true })
const composer = () => page.getByRole('textbox', { name: '给 Agent 发消息', exact: true })
const children = (path: string) => existsSync(path) ? readdirSync(path).sort() : []

function writeSkill(directory: string, name: string, description: string) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), skillText(name, description))
}

// Generate a stored ZIP to avoid committed binary fixtures and dependencies on local compression tools.
function storedZip(files: Record<string, string>): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [path, contents] of Object.entries(files)) {
    const name = Buffer.from(path)
    const body = Buffer.from(contents)
    const checksum = crc32(body)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x800, 6)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(body.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, body)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x800, 8)
    entry.writeUInt32LE(checksum, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(body.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += header.length + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

async function start(script: string, env: Record<string, string>, readyText: RegExp): Promise<string> {
  const proc = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  processes.push(proc)
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${script}\n${output}`)), 15_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(readyText)
      if (match) { clearTimeout(timeout); resolve(match[1] ?? match[0]) }
    }
    proc.stdout!.on('data', onData)
    proc.stderr!.on('data', onData)
    proc.once('error', error => { clearTimeout(timeout); reject(error) })
    proc.once('exit', code => { clearTimeout(timeout); reject(new Error(`${script} exited (${code}): ${output}`)) })
  })
}

async function openManager(importOpen = false) {
  await page.getByRole('button', { name: 'Skill', exact: true }).click()
  await picker().waitFor()
  await page.getByRole('button', { name: importOpen ? '导入 Skill…' : '管理', exact: true }).click()
  await manager().waitFor()
}

async function stageFolder() {
  await openManager(true)
  await manager().getByRole('button', { name: '从文件夹…', exact: true }).click()
  await confirmation().waitFor()
}

async function finishImport(button = '导入 1 个') {
  await confirmation().getByRole('button', { name: button, exact: true }).click()
  await confirmation().waitFor({ state: 'hidden' })
  await manager().waitFor()
  await page.getByText('已导入 1 个 Skill', { exact: true }).waitFor()
}

async function closeManager() {
  await manager().getByRole('button', { name: '关闭', exact: true }).click()
  await manager().waitFor({ state: 'hidden' })
}

describe.skipIf(!ready)('RFC 0017 importing and managing project Skills', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-skill-data-'))
    projectsDir = mkdtempSync(join(tmpdir(), 'vis-skill-projects-'))
    sourceDir = mkdtempSync(join(tmpdir(), 'vis-skill-source-'))
    const env = {
      VIS_DATA_DIR: dir, VIS_PROJECTS_DIR: projectsDir, VIS_PICK_DIRECTORY: sourceDir,
      VIS_CLI_BIN_DIR: join(root, 'apps/cli/dist'), VIS_CODEX_PATH: join(root, 'apps/web/e2e/fake-codex.mjs'),
    }
    await start(join(root, 'services/studiod/dist/studiod.mjs'), env, /\[studiod\] Started /)
    webUrl = await start(join(root, 'apps/web/dist/vis-web.mjs'), env, /(http:\/\/127\.0\.0\.1:\d+\/#t=\S+)/)
    admin = await openStudiodLink({ socketPath: studiodEndpoint(dir), tokenPath: join(dir, 'run/studiod.token') })
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.stack ?? error.message))
    await page.goto(webUrl)
    await page.getByRole('button', { name: '开始创作', exact: true }).waitFor()
  }, 30_000)

  beforeEach(async () => {
    await page.reload()
    rmSync(sourceDir, { recursive: true, force: true })
    mkdirSync(sourceDir)
    const name = `Skill 导入项目 ${++sequence}`
    project = await admin.call('space.create', { requestId: rid(), name, rootPath: join(projectsDir, rid()) })
    work = (await admin.call('work.create', { requestId: rid(), spaceId: project.spaceId, title: 'Skill 导入会话', chat: { agentKind: 'codex' } })).item
    const back = page.getByRole('button', { name: '返回列表', exact: true })
    if (await back.isVisible()) await back.click()
    await page.getByRole('button', { name: '切换项目', exact: true }).click()
    await page.getByRole('menu', { name: '项目', exact: true }).getByRole('menuitem').filter({ has: page.getByText(name, { exact: true }) }).click()
    await expect.poll(() => page.getByRole('button', { name: '切换项目', exact: true }).textContent()).toContain(name)
    await page.getByRole('region', { name: '工作区', exact: true }).getByRole('listitem', { name: /^Skill 导入会话，/ }).click()
    await composer().waitFor()
    await admin.call('events.subscribe', { spaceId: project.spaceId })
  })

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(artifacts, `failure-${task.name.replace(/[^\p{L}\p{N}]+/gu, '-')}.png`), animations: 'disabled' })
    if (page) {
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
    }
    expect(errors).toEqual([])
  })

  afterAll(async () => {
    admin?.close()
    await browser?.close()
    for (const proc of processes) proc.kill('SIGINT')
    await Promise.all(processes.map(proc => proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => proc.once('exit', () => resolve()))))
    removeTempDir(dir)
    removeTempDir(projectsDir)
    removeTempDir(sourceDir)
  }, 30_000)

  it('folder imports are not automatically selected; selecting and sending passes the Skill path to the agent', async () => {
    writeSkill(sourceDir, 'e2e-folder', '从文件夹导入的分镜 Skill')
    writeFileSync(join(sourceDir, 'story.sh'), '#!/bin/sh\nprintf storyboard\n')
    chmodSync(join(sourceDir, 'story.sh'), 0o755)
    await page.getByRole('button', { name: 'Skill', exact: true }).click()
    await picker().getByText('项目里还没有 Skill', { exact: true }).waitFor()
    await page.getByRole('button', { name: '导入 Skill…', exact: true }).click()
    await manager().getByRole('button', { name: '从文件夹…', exact: true }).click()
    const sourcePath = confirmation().getByText(/[\\/]vis-skill-source-[^\\/]+$/)
    await sourcePath.waitFor()
    expect(realpathSync((await sourcePath.textContent())!)).toBe(realpathSync(sourceDir))
    expect(await confirmation().getByRole('checkbox', { name: 'e2e-folder', exact: true }).isChecked()).toBe(true)
    await confirmation().getByText('含脚本', { exact: true }).waitFor()
    await finishImport()
    await manager().getByRole('button', { name: '移除 e2e-folder', exact: true }).waitFor()
    expect(await manager().getByRole('button', { name: '在访达中显示', exact: true }).getAttribute('title')).toBe(join(project.rootPath, 'skills'))
    expect(await manager().getByText(join(project.rootPath, 'skills'), { exact: true }).count()).toBe(0)
    mkdirSync(join(tmpdir(), 'vis-0019-workbench'), { recursive: true })
    await page.screenshot({ path: join(tmpdir(), 'vis-0019-workbench/zh-skills.png') })

    await closeManager()
    expect(await page.getByRole('button', { name: '移除 Skill e2e-folder', exact: true }).count()).toBe(0)
    const skillPath = realpathSync(join(project.rootPath, 'skills', 'e2e-folder', 'SKILL.md'))
    expect(readFileSync(skillPath, 'utf8')).toBe(skillText('e2e-folder', '从文件夹导入的分镜 Skill'))
    expect(readFileSync(join(project.rootPath, 'skills', 'e2e-folder', 'story.sh'), 'utf8')).toBe('#!/bin/sh\nprintf storyboard\n')
    // Checked here because beforeEach gives every case a new empty project; Windows has no executable bit
    if (process.platform !== 'win32') expect(statSync(join(project.rootPath, 'skills', 'e2e-folder', 'story.sh')).mode & 0o111).toBe(0o111)
    await page.getByRole('button', { name: 'Skill', exact: true }).click()
    await picker().getByRole('option', { name: /[\\/]e2e-folder/ }).click()
    await page.getByRole('button', { name: '移除 Skill e2e-folder', exact: true }).waitFor()
    const text = '用导入的 Skill 整理分镜'
    await composer().fill(text)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const evidence = () => {
      const file = join(work.workDir, '.vis-e2e-agent.jsonl')
      return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    }
    await expect.poll(() => evidence().find(entry => entry.method === 'turn/start' && entry.prompt?.startsWith(text))?.prompt, { timeout: 10_000 }).toContain(JSON.stringify(skillPath))
    const transcript = await admin.call('session.getTranscript', { sessionId: work.sessions[0]!.sessionId })
    expect(transcript.items.find((item: { kind: string }) => item.kind === 'user')?.payload).toMatchObject({ text, skills: ['e2e-folder'] })
    await page.getByText(`收到：${text}`, { exact: true }).waitFor()
    await expect.poll(async () => (await admin.call('session.list', { spaceId: project.spaceId })).sessions.find((session: { sessionId: string }) => session.sessionId === work.sessions[0]!.sessionId)?.activeTurnId).toBeNull()
  })

  it('uploading a zip with two Skills imports only the checked item and shows skip reasons', async () => {
    await openManager(true)
    const choosing = page.waitForEvent('filechooser')
    await manager().getByRole('button', { name: '从压缩包…', exact: true }).click()
    await (await choosing).setFiles({ name: 'skills.zip', mimeType: 'application/zip', buffer: storedZip({
      'bundle/skills/e2e-zip-a/SKILL.md': skillText('e2e-zip-a', '保留的分镜 Skill'),
      'bundle/skills/e2e-zip-a/参考.txt': '压缩包内的参考说明',
      'bundle/skills/e2e-zip-b/SKILL.md': skillText('e2e-zip-b', '不导入的分镜 Skill'),
      'bundle/skills/invalid/SKILL.md': '---\ndescription: 缺少名称\n---\n无效 Skill\n',
    }) })
    await confirmation().getByRole('checkbox', { name: 'e2e-zip-a', exact: true }).waitFor()
    expect(await confirmation().getByRole('checkbox', { name: 'e2e-zip-b', exact: true }).isChecked()).toBe(true)
    await confirmation().getByRole('checkbox', { name: 'e2e-zip-b', exact: true }).uncheck()
    await confirmation().getByText('已跳过的目录（1）', { exact: true }).click()
    await confirmation().getByText(/缺少.*name/).waitFor()
    await page.screenshot({ path: join(artifacts, 'confirm-zip.png'), animations: 'disabled' })
    await finishImport()
    await manager().getByRole('button', { name: '移除 e2e-zip-a', exact: true }).waitFor()
    expect(await manager().getByRole('button', { name: '移除 e2e-zip-b', exact: true }).count()).toBe(0)
    expect(children(join(project.rootPath, 'skills'))).toEqual(['e2e-zip-a'])
    expect(readFileSync(join(project.rootPath, 'skills', 'e2e-zip-a', '参考.txt'), 'utf8')).toBe('压缩包内的参考说明')
    await closeManager()
    await page.getByRole('button', { name: 'Skill', exact: true }).click()
    await picker().getByRole('option', { name: /\/e2e-zip-a/ }).waitFor()
    expect(await picker().getByRole('option').count()).toBe(1)
  })

  it('same-name candidates are unchecked by default; selecting replacement preserves old content in the removed directory', async () => {
    const old = skillText('e2e-replace', '替换前的 Skill')
    writeSkill(join(project.rootPath, 'skills', 'e2e-replace'), 'e2e-replace', '替换前的 Skill')
    writeSkill(sourceDir, 'e2e-replace', '替换后的 Skill')
    writeFileSync(join(sourceDir, 'story.sh'), '#!/bin/sh\nprintf replacement\n')
    await stageFolder()
    const candidate = confirmation().getByRole('checkbox', { name: 'e2e-replace', exact: true })
    expect(await candidate.isChecked()).toBe(false)
    await confirmation().getByText('已存在', { exact: true }).waitFor()
    expect(await confirmation().getByRole('button', { name: '导入 0 个', exact: true }).isDisabled()).toBe(true)
    expect(readFileSync(join(project.rootPath, 'skills', 'e2e-replace', 'SKILL.md'), 'utf8')).toBe(old)
    await candidate.check()
    await confirmation().getByText('含脚本', { exact: true }).waitFor()
    await page.screenshot({ path: join(tmpdir(), 'vis-0017-confirm-replace.png'), animations: 'disabled' })
    await finishImport('导入并替换')
    await manager().getByText('替换后的 Skill', { exact: true }).waitFor()
    expect(readFileSync(join(project.rootPath, 'skills', 'e2e-replace', 'SKILL.md'), 'utf8')).toBe(skillText('e2e-replace', '替换后的 Skill'))
    const removed = join(dir, 'spaces', project.spaceId, 'removed-skills')
    const backups = children(removed)
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(removed, backups[0]!, 'SKILL.md'), 'utf8')).toBe(old)
  })

  it('removal can be cancelled; confirmation refreshes management and selector lists and preserves a recoverable copy', async () => {
    const directory = join(project.rootPath, 'skills', 'e2e-remove')
    writeSkill(directory, 'e2e-remove', '可以移除的 Skill')
    await openManager()
    await manager().getByRole('button', { name: '移除 e2e-remove', exact: true }).click()
    const removing = page.getByRole('dialog', { name: '移除 Skill', exact: true })
    await removing.getByText(/移到应用的已移除目录，之后可以找回/).waitFor()
    await removing.getByRole('button', { name: '取消', exact: true }).click()
    expect(existsSync(directory)).toBe(true)
    await manager().getByRole('button', { name: '移除 e2e-remove', exact: true }).click()
    await removing.getByRole('button', { name: '确认移除', exact: true }).click()
    await manager().getByText('项目里还没有 Skill', { exact: true }).waitFor()
    expect(await manager().getByRole('button', { name: '移除 e2e-remove', exact: true }).count()).toBe(0)
    expect(existsSync(directory)).toBe(false)
    const removed = join(dir, 'spaces', project.spaceId, 'removed-skills')
    const backups = children(removed)
    expect(backups).toHaveLength(1)
    const removedPath = join(removed, backups[0]!)
    expect(readFileSync(join(removedPath, 'SKILL.md'), 'utf8')).toBe(skillText('e2e-remove', '可以移除的 Skill'))
    const notice = page.getByText(/^已移除 Skill，可从这里找回：/)
    await notice.waitFor()
    expect(realpathSync((await notice.textContent())!.replace('已移除 Skill，可从这里找回：', ''))).toBe(realpathSync(removedPath))
    await closeManager()
    await page.getByRole('button', { name: 'Skill', exact: true }).click()
    await picker().getByText('项目里还没有 Skill', { exact: true }).waitFor()
    expect(await picker().getByRole('option').count()).toBe(0)
  })

  it('unrecognized directories display their names and reasons in the management window', async () => {
    writeSkill(join(project.rootPath, 'skills', 'e2e-valid'), 'e2e-valid', '可识别的 Skill')
    mkdirSync(join(project.rootPath, 'skills', 'missing-skill'), { recursive: true })
    mkdirSync(join(project.rootPath, 'skills', 'missing-description'), { recursive: true })
    writeFileSync(join(project.rootPath, 'skills', 'missing-description', 'SKILL.md'), '---\nname: missing-description\n---\n缺少描述\n')
    await openManager()
    await manager().getByRole('button', { name: '移除 e2e-valid', exact: true }).waitFor()
    await manager().getByText('无法识别的目录（2）', { exact: true }).click()
    await manager().getByText('missing-skill', { exact: true }).waitFor()
    await manager().getByText('missing-description', { exact: true }).waitFor()
    await manager().getByText('missing-skill', { exact: true }).locator('..').getByText(/SKILL\.md/).waitFor()
    await manager().getByText('missing-description', { exact: true }).locator('..').getByText(/缺少.*description/).waitFor()
    await page.screenshot({ path: join(tmpdir(), 'vis-0017-problems.png'), animations: 'disabled' })
  })

  it('cancel or Escape discards staging; closing management restores focus to the Skill button', async () => {
    writeSkill(sourceDir, 'e2e-cancel', '取消的 Skill')
    await stageFolder()
    const staging = join(dir, 'spaces', project.spaceId, 'skill-staging')
    expect(children(staging)).toHaveLength(1)
    await confirmation().getByRole('button', { name: '取消', exact: true }).click()
    await manager().waitFor()
    await expect.poll(() => children(staging)).toEqual([])
    expect(existsSync(join(project.rootPath, 'skills', 'e2e-cancel'))).toBe(false)
    expect(await manager().getByRole('button', { name: '移除 e2e-cancel', exact: true }).count()).toBe(0)
    expect(readFileSync(join(sourceDir, 'SKILL.md'), 'utf8')).toBe(skillText('e2e-cancel', '取消的 Skill'))
    // With no skills the sources are the empty state itself, so there is no menu to open.
    expect(await manager().getByRole('button', { name: '导入', exact: true }).count()).toBe(0)
    await manager().getByRole('button', { name: '从文件夹…', exact: true }).click()
    await confirmation().waitFor()
    expect(children(staging)).toHaveLength(1)
    await page.keyboard.press('Escape')
    await manager().waitFor()
    await expect.poll(() => children(staging)).toEqual([])
    expect(existsSync(join(project.rootPath, 'skills', 'e2e-cancel'))).toBe(false)
    await closeManager()
    await expect.poll(() => page.getByRole('button', { name: 'Skill', exact: true }).evaluate(button => button === document.activeElement)).toBe(true)
  })

  it('keeps import in a floating menu once the project has skills', async () => {
    const dir = join(project.rootPath, 'skills', 'e2e-layout')
    writeSkill(dir, 'e2e-layout', '布局检查用的 Skill')
    try {
      await openManager()
      const row = manager().getByText('e2e-layout', { exact: true })
      const before = (await row.boundingBox())!.y
      expect(await manager().getByRole('button', { name: '从文件夹…', exact: true }).count()).toBe(0)
      await manager().getByRole('button', { name: '导入', exact: true }).click()
      await manager().getByRole('button', { name: '从其他项目…', exact: true }).waitFor()
      expect((await row.boundingBox())!.y).toBe(before)
      await manager().getByRole('button', { name: '在访达中显示', exact: true }).focus()
      await expect.poll(() => manager().getByRole('button', { name: '从文件夹…', exact: true }).count()).toBe(0)
      await page.keyboard.press('Escape')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('copies selected Skills from another project, preserving the source project and independent copies', async () => {
    const source: SpaceSummary = await admin.call('space.create', { requestId: rid(), name: 'Skill 来源项目', rootPath: join(projectsDir, rid()) })
    const sourceSkill = join(source.rootPath, 'skills', 'e2e-project')
    writeSkill(sourceSkill, 'e2e-project', '来自其他项目的 Skill')
    await openManager(true)
    await manager().getByRole('button', { name: '从其他项目…', exact: true }).click()
    const importing = page.getByRole('dialog', { name: '从其他项目导入', exact: true })
    const projects = importing.getByLabel('来源项目', { exact: true })
    expect(await projects.getByRole('option', { name: project.name, exact: true }).count()).toBe(0)
    await projects.selectOption(source.spaceId)
    await importing.getByRole('checkbox', { name: 'e2e-project', exact: true }).check()
    await importing.getByRole('button', { name: '下一步', exact: true }).click()
    await confirmation().getByRole('checkbox', { name: 'e2e-project', exact: true }).waitFor()
    await finishImport()
    await manager().getByRole('button', { name: '移除 e2e-project', exact: true }).waitFor()
    expect(readFileSync(join(sourceSkill, 'SKILL.md'), 'utf8')).toBe(skillText('e2e-project', '来自其他项目的 Skill'))
    writeFileSync(join(sourceSkill, 'SKILL.md'), skillText('e2e-project', '来源后续修改'))
    expect(readFileSync(join(project.rootPath, 'skills', 'e2e-project', 'SKILL.md'), 'utf8')).toBe(skillText('e2e-project', '来自其他项目的 Skill'))
  })
})
