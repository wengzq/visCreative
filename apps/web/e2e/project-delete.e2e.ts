import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { chromePath, removeTempDir } from './platform'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
// Real studiod, web host, and Chrome; project and app data use temporary directories and Codex is a local fake program only.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NodeView, SpaceSummary, WorkItemView } from '@vis/protocol'
import { type Browser, chromium, type Locator, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const CHROME = chromePath()
const ready = existsSync(CHROME) && existsSync(join(root, 'services/studiod/dist/studiod.mjs')) && existsSync(join(root, 'apps/web/dist/vis-web.mjs'))
const artifacts = join(tmpdir(), 'vis-0011-project-delete')
const processes: ChildProcess[] = []
const errors: string[] = []
let dir: string
let projectsDir: string
let browser: Browser
let page: Page
let admin: StudiodLink
let original: SpaceSummary
let sequence = 0
const rid = () => `project-delete-e2e-${++sequence}`

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

async function spaces(): Promise<SpaceSummary[]> { return (await admin.call('space.list')).spaces }
async function createProject(name: string, directory: string): Promise<SpaceSummary> {
  return admin.call('space.create', { requestId: rid(), name, rootPath: join(projectsDir, directory) })
}
async function switchProject(name: string) {
  const back = page.getByRole('button', { name: '返回列表', exact: true })
  if (await back.isVisible()) await back.click()
  await page.getByRole('button', { name: '切换项目', exact: true }).click()
  await page.getByRole('menu', { name: '项目', exact: true }).getByRole('menuitem').filter({ has: page.getByText(name, { exact: true }) }).click()
  await expect.poll(() => page.getByRole('button', { name: '切换项目', exact: true }).textContent()).toContain(name)
  await page.getByRole('button', { name: '开始创作', exact: true }).waitFor()
}
async function deleteDialog(name: string) {
  await page.getByRole('button', { name: '切换项目', exact: true }).click()
  const menu = page.getByRole('menu', { name: '项目', exact: true })
  await menu.getByRole('menuitem').filter({ has: page.getByText(name, { exact: true }) }).hover()
  const more = menu.getByRole('menuitem', { name: `${name}的更多操作`, exact: true })
  if (await more.getAttribute('aria-expanded') !== 'true') await more.click()
  await page.getByRole('menu', { name: `${name}的操作`, exact: true }).getByRole('menuitem', { name: '删除项目…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `删除项目「${name}」？`, exact: true })
  await dialog.getByText('项目会移到设置里的「最近删除」，可以恢复。项目目录不会被删除：', { exact: true }).waitFor()
  return dialog
}
async function recentlyDeleted() {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '最近删除', exact: true }).click()
}
const deletedRow = (name: string) => page.getByRole('listitem', { name: `已删除项目「${name}」`, exact: true })
const closeSettings = () => page.getByRole('button', { name: '关闭设置', exact: true }).click()
async function expectCancelFocus(dialog: Locator) {
  await expect.poll(() => dialog.getByRole('button', { name: '取消', exact: true }).evaluate(button => button === document.activeElement)).toBe(true)
}
async function openPurge(name: string) {
  await deletedRow(name).getByRole('button', { name: '永久删除…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `永久删除「${name}」？`, exact: true })
  await dialog.waitFor()
  await expectCancelFocus(dialog)
  expect(await dialog.getByRole('checkbox', { name: /^同时删除项目目录/ }).isChecked()).toBe(false)
  return dialog
}

describe.skipIf(!ready)('RFC 0011 project deletion and recently deleted', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-project-delete-data-'))
    projectsDir = mkdtempSync(join(tmpdir(), 'vis-project-delete-projects-'))
    const env = {
      VIS_DATA_DIR: dir, VIS_PROJECTS_DIR: projectsDir,
      VIS_CLI_BIN_DIR: join(root, 'apps/cli/dist'), VIS_CODEX_PATH: join(root, 'apps/web/e2e/fake-codex.mjs'),
    }
    await start(join(root, 'services/studiod/dist/studiod.mjs'), env, /\[studiod\] Started /)
    const url = await start(join(root, 'apps/web/dist/vis-web.mjs'), env, /(http:\/\/127\.0\.0\.1:\d+\/#t=\S+)/)
    admin = await openStudiodLink({ socketPath: studiodEndpoint(dir), tokenPath: join(dir, 'run/studiod.token') })
    original = (await spaces())[0]!
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.stack ?? error.message))
    await page.goto(url)
    await page.getByRole('button', { name: '开始创作', exact: true }).waitFor()
  }, 30_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(artifacts, `failure-${task.name.replace(/[^\p{L}\p{N}]+/gu, '-')}.png`), animations: 'disabled' })
    if (page) {
      await page.keyboard.press('Escape')
      const close = page.getByRole('button', { name: '关闭设置', exact: true })
      if (await close.isVisible()) await close.click()
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
  }, 30_000)

  it('deletion confirmation defaults to cancel and supports Esc; stopping the current project switches automatically, and restoring preserves canvas and work items', async () => {
    const fallback = await createProject('最近打开项目', 'fallback')
    const restored = await createProject('可恢复项目', 'restore')
    writeFileSync(join(restored.rootPath, '自己的文件.txt'), '项目目录必须保留')
    await admin.call('events.subscribe', { spaceId: restored.spaceId })
    const { idMap } = await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'draft', kind: 'text', x: 0, y: 0, w: 240, h: 120, content: { text: '恢复后仍在的草稿' } }] })
    const { item } = await admin.call('work.create', { requestId: rid(), spaceId: restored.spaceId, title: '恢复后仍在的工作区', chat: { agentKind: 'codex' } }) as { item: WorkItemView }
    await admin.call('session.sendMessage', { requestId: rid(), sessionId: item.sessions[0]!.sessionId, text: '工作代理检查：{"scenario":"hold"}', refs: [] })
    await expect.poll(async () => (await admin.call('work.get', { spaceId: restored.spaceId, workItemId: item.workItemId })).item.sessions[0].activeTurnId).toBeTruthy()
    await switchProject(original.name)
    await switchProject(fallback.name)
    await switchProject(restored.name)

    let dialog = await deleteDialog(restored.name)
    await expectCancelFocus(dialog)
    await dialog.getByText('⚠ 有 1 个 Agent 正在工作，删除会先停止它们', { exact: true }).waitFor()
    await dialog.getByText('⚠ 有 1 个工作项进行中', { exact: true }).waitFor()
    await dialog.getByText(restored.rootPath, { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    expect((await spaces()).some(space => space.spaceId === restored.spaceId)).toBe(true)
    dialog = await deleteDialog(restored.name)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    expect((await spaces()).some(space => space.spaceId === restored.spaceId)).toBe(true)
    dialog = await deleteDialog(restored.name)
    await dialog.getByRole('button', { name: '停止并删除', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => page.getByRole('button', { name: '切换项目', exact: true }).textContent()).toContain(fallback.name)
    await page.getByText(`已删除「${restored.name}」，可在设置 › 最近删除中恢复`, { exact: true }).waitFor()
    expect((await spaces()).some(space => space.spaceId === restored.spaceId)).toBe(false)
    expect(readFileSync(join(restored.rootPath, '自己的文件.txt'), 'utf8')).toBe('项目目录必须保留')

    await recentlyDeleted()
    const row = deletedRow(restored.name)
    await row.getByText(restored.rootPath, { exact: true }).waitFor()
    await row.getByRole('button', { name: '恢复', exact: true }).click()
    await row.waitFor({ state: 'hidden' })
    await closeSettings()
    await switchProject(restored.name)
    await admin.call('events.subscribe', { spaceId: restored.spaceId })
    const nodes = (await admin.call('canvas.get')).nodes as NodeView[]
    expect(nodes.find(node => node.nodeId === idMap.draft)).toMatchObject({ kind: 'text', slots: [{ content: { type: 'text', body: '恢复后仍在的草稿' } }] })
    const recovered = (await admin.call('work.get', { spaceId: restored.spaceId, workItemId: item.workItemId })).item as WorkItemView
    expect(recovered).toMatchObject({ title: item.title, status: 'todo', sessions: [{ activeTurnId: null }] })
    await page.getByRole('listitem', { name: /^恢复后仍在的工作区，/ }).waitFor()
  })

  it('recently deleted shows disk usage; permanent deletion is cancellable and preserves the project directory by default', async () => {
    const project = await createProject('保留目录项目', 'keep-directory')
    const ownFile = join(project.rootPath, '自己的文件.txt')
    writeFileSync(ownFile, 'x'.repeat(2048))
    const dialog = await deleteDialog(project.name)
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await recentlyDeleted()
    const row = deletedRow(project.name)
    await expect.poll(() => row.textContent()).toMatch(/素材与历史\s+[\d.]+\s*(?:B|KB|MB|GB|TB)\s*·\s*项目目录\s+[\d.]+\s*(?:B|KB|MB|GB|TB)/)
    const usage = await admin.call('space.diskUsage', { spaceId: project.spaceId })
    expect(usage.projectDirBytes).toBe(2048)
    expect(usage.dataBytes).toBeGreaterThan(0)
    await row.getByText(/· 项目目录 2 KB$/).waitFor()
    await page.screenshot({ path: join(artifacts, 'recently-deleted.png'), animations: 'disabled' })

    let purge = await openPurge(project.name)
    await page.keyboard.press('Escape')
    await purge.waitFor({ state: 'hidden' })
    await row.waitFor()
    purge = await openPurge(project.name)
    await purge.getByText(/画布、历史和生成的素材.*会被删除，无法撤销。/).waitFor()
    await purge.getByText(project.rootPath, { exact: true }).waitFor()
    await purge.getByRole('button', { name: '取消', exact: true }).click()
    await purge.waitFor({ state: 'hidden' })
    expect(existsSync(join(dir, 'spaces', project.spaceId, 'space.db'))).toBe(true)
    expect(existsSync(ownFile)).toBe(true)
    await row.waitFor()
    purge = await openPurge(project.name)
    await purge.getByRole('button', { name: '永久删除', exact: true }).click()
    await purge.waitFor({ state: 'hidden' })
    await row.waitFor({ state: 'hidden' })
    expect(existsSync(join(dir, 'spaces', project.spaceId))).toBe(false)
    expect(readFileSync(ownFile, 'utf8')).toBe('x'.repeat(2048))
    expect((await admin.call('space.listDeleted')).spaces.some((space: SpaceSummary) => space.spaceId === project.spaceId)).toBe(false)
    await closeSettings()
  })

  it('permanent deletion removes the project directory and its user files when checked', async () => {
    const project = await createProject('连同目录删除项目', 'remove-directory')
    writeFileSync(join(project.rootPath, '自己的文件.txt'), '勾选后删除')
    const dialog = await deleteDialog(project.name)
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await recentlyDeleted()
    const purge = await openPurge(project.name)
    await purge.getByRole('checkbox', { name: /^同时删除项目目录/ }).check()
    await purge.getByText('项目目录里的所有文件都会被删除，包括你自己放进去的文件', { exact: true }).waitFor()
    await page.screenshot({ path: join(artifacts, 'purge-project-directory.png'), animations: 'disabled' })
    await purge.getByRole('button', { name: '永久删除', exact: true }).click()
    await purge.waitFor({ state: 'hidden' })
    await deletedRow(project.name).waitFor({ state: 'hidden' })
    expect(existsSync(join(dir, 'spaces', project.spaceId))).toBe(false)
    expect(existsSync(project.rootPath)).toBe(false)
    await closeSettings()
  })

  it('deleting the last project shows the empty state; it can still be restored from recently deleted after refresh', async () => {
    const active = await spaces()
    const restoreTarget = active[0]!
    for (const project of active) {
      await switchProject(project.name)
      const dialog = await deleteDialog(project.name)
      await dialog.getByRole('button', { name: '删除', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
    }
    await page.getByRole('main').getByText('还没有项目，请新建项目', { exact: true }).waitFor()
    expect(await spaces()).toEqual([])
    await page.reload()
    await page.getByRole('main').getByText('还没有项目，请新建项目', { exact: true }).waitFor()
    await recentlyDeleted()
    await deletedRow(restoreTarget.name).getByRole('button', { name: '恢复', exact: true }).click()
    await deletedRow(restoreTarget.name).waitFor({ state: 'hidden' })
    await closeSettings()
    await expect.poll(() => page.getByRole('button', { name: '切换项目', exact: true }).textContent()).toContain(restoreTarget.name)
    expect((await spaces()).map(space => space.spaceId)).toEqual([restoreTarget.spaceId])
    await page.getByRole('button', { name: '开始创作', exact: true }).waitFor()
  })
})
