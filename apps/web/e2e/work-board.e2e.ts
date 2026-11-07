import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { chromePath, removeTempDir } from './platform'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
// Real studiod, web host, and Chrome; only Codex app-server is replaced with a local echo program.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { NodeView, WorkItemView, WorkSlotsView } from '@vis/protocol'
import { type Browser, chromium, type Locator, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const CHROME = chromePath()
const ready = existsSync(CHROME) && existsSync(join(root, 'services/studiod/dist/studiod.mjs')) && existsSync(join(root, 'apps/web/dist/vis-web.mjs'))
const artifacts = join(tmpdir(), 'vis-0010-impl/shots-c')
const Database = createRequire(new URL('../../../packages/storage/package.json', import.meta.url))('better-sqlite3')
const processes: ChildProcess[] = []
const errors: string[] = []
const historyReads: string[] = []
const reparentRequests: Array<{ workItemId: string; parentId: string | null }> = []
let dir: string
let projectsDir: string
let browser: Browser
let page: Page
let admin: StudiodLink
let spaceId: string
let projectName: string
let webUrl: string
let sequence = 0
const rid = () => `work-board-e2e-${++sequence}`

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

async function item(id: string, project = spaceId): Promise<WorkItemView> {
  return (await admin.call('work.get', { spaceId: project, workItemId: id })).item
}

const board = () => page.getByRole('region', { name: '工作看板', exact: true })
const card = (title: string) => board().getByRole('listitem', { name: new RegExp(`^${title}，`) })

async function showBoard() {
  await page.getByRole('tab', { name: '看板', exact: true }).click()
  await board().waitFor()
}

async function createTodo(title: string) {
  await showBoard()
  await board().getByRole('button', { name: '新建待办', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建待办', exact: true })
  await dialog.getByLabel('标题', { exact: true }).fill(title)
  await dialog.getByLabel('任务说明（Markdown）', { exact: true }).fill(`完成${title}`)
  expect(await dialog.getByRole('combobox', { name: /^建框/ }).count()).toBe(0)
  await dialog.getByRole('button', { name: '创建待办', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const items = (await admin.call('work.list', { spaceId })).items as WorkItemView[]
  const created = items.find(work => work.title === title)!
  expect(created).toBeDefined()
  await card(title).waitFor()
  return created
}

async function drag(source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded()
  const from = (await source.boundingBox())!
  expect(from).not.toBeNull()
  await page.mouse.move(from.x + Math.min(from.width / 2, 75), from.y + 20)
  await page.mouse.down()
  await page.mouse.move(from.x + 85, from.y + 30, { steps: 3 })
  await target.waitFor()
  const to = (await target.boundingBox())!
  expect(to).not.toBeNull()
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height - 20, 95), { steps: 15 })
  await page.mouse.up()
}

async function beginListDrag(source: Locator) {
  await source.scrollIntoViewIfNeeded()
  const from = (await source.boundingBox())!
  await page.mouse.move(from.x + 75, from.y + 20)
  await page.mouse.down()
  await page.mouse.move(from.x + 55, from.y + 30, { steps: 3 })
  await page.getByRole('region', { name: '看板状态条', exact: true }).waitFor()
  await expect.poll(() => source.getAttribute('aria-grabbed')).toBe('true')
}

async function dropOn(target: Locator) {
  const to = (await target.boundingBox())!
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.getByRole('region', { name: '看板状态条', exact: true }).waitFor({ state: 'hidden' })
}

async function showWorkTree() {
  const back = page.getByRole('button', { name: '返回列表', exact: true })
  if (await back.isVisible()) await back.click()
  await page.getByRole('tab', { name: '画布', exact: true }).click()
  return page.getByRole('region', { name: '工作区', exact: true })
}

async function move(title: string, status: string) {
  await drag(card(title), board().getByRole('region', { name: status, exact: true }))
}

// After the server changes status, cards wait for events before changing columns; wait for arrival before the next drag to avoid using an element being redrawn
async function landed(title: string, status: string) {
  await board().getByRole('list', { name: `${status}工作项`, exact: true }).getByRole('listitem', { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}，${status}`) }).waitFor()
}

async function chooseCodex() {
  const dialog = page.getByRole('dialog', { name: /选择(?: Agent|智能体)/ })
  await dialog.getByRole('button', { name: 'DeepSeek', exact: true }).click()
  expect(await dialog.locator('svg.vis-agent-icon.is-deepseek[aria-hidden="true"]').count()).toBe(1)
  await dialog.getByRole('button', { name: 'Codex', exact: true }).click()
  expect(await dialog.locator('svg.vis-agent-icon.is-codex[aria-hidden="true"]').count()).toBe(1)
  await dialog.getByRole('button', { name: '激活', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}

async function menu(title: string, action: string) {
  await card(title).getByRole('button', { name: `${title}的更多操作`, exact: true }).click()
  await page.getByRole('dialog', { name: `${title}的操作`, exact: true }).getByRole('menuitem', { name: action, exact: true }).click()
}

// Status changes do not open a confirmation dialog
async function recall(title: string) {
  await menu(title, '回收')
}

async function screenshot(name: string) {
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(artifacts, name) })
}

describe.skipIf(!ready)('Work board and project canvas', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-work-e2e-'))
    projectsDir = mkdtempSync(join(tmpdir(), 'vis-work-projects-'))
    const env = {
      VIS_DATA_DIR: dir, VIS_PROJECTS_DIR: projectsDir,
      VIS_CLI_BIN_DIR: join(root, 'apps/cli/dist'), VIS_CODEX_PATH: join(root, 'apps/web/e2e/fake-codex.mjs'),
      // Picker-only coverage needs an available executable; this fake cannot call a real Agent.
      VIS_DSH_PATH: join(root, 'apps/web/e2e/fake-codex.mjs'),
    }
    await start(join(root, 'services/studiod/dist/studiod.mjs'), env, /\[studiod\] Started /)
    webUrl = await start(join(root, 'apps/web/dist/vis-web.mjs'), env, /(http:\/\/127\.0\.0\.1:\d+\/#t=\S+)/)
    admin = await openStudiodLink({ socketPath: studiodEndpoint(dir), tokenPath: join(dir, 'run/studiod.token') })
    const { spaces } = await admin.call('space.list')
    spaceId = spaces[0].spaceId
    projectName = spaces[0].name
    await admin.call('events.subscribe', { spaceId })
    await admin.call('work.setSlotLimit', { limit: 6 })
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.stack ?? error.message))
    page.on('websocket', socket => socket.on('framesent', frame => {
      const request = JSON.parse(String(frame.payload))
      if (request.method === 'work.changes') historyReads.push(request.params.workItemId)
      if (request.method === 'work.reparent') reparentRequests.push(request.params)
    }))
    await page.goto(webUrl)
    await showBoard()
  }, 30_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await screenshot(`failure-${task.name.replace(/[^\p{L}\p{N}]+/gu, '-')}.png`)
    await page?.keyboard.press('Escape')
    const { items } = await admin.call('work.list', { scope: 'all' })
    for (const listed of items as WorkItemView[]) {
      // Parent recall cascades to children; reread to avoid recalling again with pre-cleanup state.
      const work = await item(listed.workItemId, listed.spaceId)
      if (work.status === 'in_progress' || work.status === 'in_review' || work.waitingSlotSince !== null) {
        await admin.call('work.recall', { requestId: rid(), spaceId: work.spaceId, workItemId: work.workItemId })
      }
    }
    await admin.call('work.setSlotLimit', { limit: 6 })
    // Notices disappear automatically; click close buttons still present one by one instead of reusing stale locator results
    const close = page.getByRole('button', { name: '关闭', exact: true }).first()
    for (let attempt = 0; attempt < 10 && await close.count(); attempt++) await close.click({ timeout: 1000 }).catch(() => {})
  })

  afterAll(async () => {
    admin?.close()
    await browser?.close()
    for (const proc of processes) proc.kill('SIGINT')
    await Promise.all(processes.map(proc => proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => proc.once('exit', () => resolve()))))
    removeTempDir(dir)
    removeTempDir(projectsDir)
  })

  it('list dragging expands the status bar, cancellation preserves status, and moving running turns keeps them active with a warning', async () => {
    const work = (await admin.call('work.create', { requestId: rid(), spaceId, title: '状态条拖动检查' })).item as WorkItemView
    const tree = await showWorkTree()
    const source = () => tree.getByRole('listitem', { name: /^状态条拖动检查，/ })
    await beginListDrag(source())
    expect(await page.getByRole('region', { name: '看板状态条', exact: true }).getByRole('region').count()).toBe(4)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.getByRole('region', { name: '看板状态条', exact: true }).waitFor({ state: 'hidden' })
    expect((await item(work.workItemId)).status).toBe('todo')
    await expect.poll(() => source().getAttribute('aria-grabbed')).toBe('false')
    expect(await page.getByRole('button', { name: '返回列表', exact: true }).count()).toBe(0)
    await beginListDrag(source())
    await dropOn(page.getByRole('region', { name: '移到进行中', exact: true }))
    await chooseCodex()
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'in_progress' })
    const active = await item(work.workItemId)
    await expect.poll(async () => (await item(work.workItemId)).sessions[0]?.activeTurnId).toBeNull()
    await admin.call('session.sendMessage', { requestId: rid(), sessionId: active.sessions[0]!.sessionId, text: `工作代理检查：${JSON.stringify({ scenario: 'hold' })}`, refs: [] })
    await expect.poll(async () => (await item(work.workItemId)).sessions[0]?.activeTurnId).toBeTruthy()
    const turnId = (await item(work.workItemId)).sessions[0]!.activeTurnId
    await tree.getByRole('listitem', { name: /^状态条拖动检查，进行中/ }).waitFor()
    await beginListDrag(source())
    await dropOn(page.getByRole('region', { name: '移到待审阅', exact: true }))
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'in_review', sessions: [expect.objectContaining({ activeTurnId: turnId })] })
    await page.getByText('「状态条拖动检查」的任务还在运行，会继续跑完当前这一步；要立刻停下，请在会话里停止', { exact: true }).waitFor()
  })

  it('list menus and dragging submit only valid parents; reparenting and moving out preserve status', async () => {
    const first = (await admin.call('work.create', { requestId: rid(), spaceId, title: '成功挪动 · 原父项' })).item as WorkItemView
    const second = (await admin.call('work.create', { requestId: rid(), spaceId, title: '成功挪动 · 新父项' })).item as WorkItemView
    const child = (await admin.call('work.dispatch', { requestId: rid(), spaceId, parentId: first.workItemId, title: '成功挪动 · 子项', brief: '只检查挪动', agentKind: 'codex', activate: false })).item as WorkItemView
    const tree = await showWorkTree()
    await tree.getByRole('searchbox', { name: '搜索工作项', exact: true }).fill('成功挪动')
    const source = () => tree.getByRole('listitem', { name: /^成功挪动 · 子项，/ })
    const destination = () => tree.getByRole('listitem', { name: /^成功挪动 · 新父项，/ })
    const before = reparentRequests.length
    // Root workspaces with children cannot become children; another child is not a valid drop target either.
    await beginListDrag(tree.getByRole('listitem', { name: /^成功挪动 · 原父项，/ }))
    await dropOn(destination())
    expect(reparentRequests.length).toBe(before)
    await beginListDrag(destination())
    await dropOn(source())
    expect(reparentRequests.length).toBe(before)
    const openMenu = async () => {
      await source().getByRole('button', { name: `${child.title}的更多操作`, exact: true }).click()
      return page.getByRole('dialog', { name: `${child.title}的操作`, exact: true })
    }
    const menu = await openMenu()
    expect(await menu.getByRole('menuitem', { name: '移出为独立工作区', exact: true }).isEnabled()).toBe(true)
    await menu.getByRole('menuitem', { name: '移到…', exact: true }).click()
    await menu.getByRole('menuitem', { name: '作为子项移到…', exact: true }).click()
    const choices = menu.getByRole('group', { name: '目标根工作区', exact: true })
    expect(await choices.getByRole('menuitem', { name: first.title, exact: true }).count()).toBe(0)
    expect(await choices.getByRole('menuitem', { name: child.title, exact: true }).count()).toBe(0)
    await choices.getByRole('menuitem', { name: second.title, exact: true }).click()
    await expect.poll(() => reparentRequests.length).toBe(before + 1)
    expect(reparentRequests.at(-1)).toMatchObject({ workItemId: child.workItemId, parentId: second.workItemId })
    await expect.poll(() => item(child.workItemId)).toMatchObject({ parentId: second.workItemId, status: 'todo' })
    await tree.getByRole('list', { name: `${second.title}的子工作项`, exact: true }).getByRole('listitem', { name: /^成功挪动 · 子项，/ }).waitFor()
    expect((await item(first.workItemId)).childIds).toEqual([])
    expect((await item(second.workItemId)).childIds).toContain(child.workItemId)
    await beginListDrag(source())
    await dropOn(tree.getByRole('listitem', { name: /^成功挪动 · 原父项，/ }))
    await expect.poll(() => reparentRequests.length).toBe(before + 2)
    expect(reparentRequests.at(-1)).toMatchObject({ workItemId: child.workItemId, parentId: first.workItemId })
    await expect.poll(() => item(child.workItemId)).toMatchObject({ parentId: first.workItemId, status: 'todo' })
    await tree.getByRole('list', { name: `${first.title}的子工作项`, exact: true }).getByRole('listitem', { name: /^成功挪动 · 子项，/ }).waitFor()
    await (await openMenu()).getByRole('menuitem', { name: '移出为独立工作区', exact: true }).click()
    await expect.poll(() => reparentRequests.length).toBe(before + 3)
    expect(reparentRequests.at(-1)).toMatchObject({ workItemId: child.workItemId, parentId: null })
    await expect.poll(() => item(child.workItemId)).toMatchObject({ parentId: null, status: 'todo' })
    await tree.getByRole('searchbox', { name: '搜索工作项', exact: true }).fill('')
  })

  it('more than three children can expand; columns have equal heights and independent scrolling, and dragging after scrolling still changes status', async () => {
    const parent = (await admin.call('work.create', { requestId: rid(), spaceId, title: '折叠检查工作区' })).item as WorkItemView
    const children: WorkItemView[] = []
    for (let index = 0; index < 8; index++) children.push((await admin.call('work.dispatch', { requestId: rid(), spaceId, parentId: parent.workItemId, title: `折叠子项 ${index}`, brief: '只检查界面，不激活', agentKind: 'codex', activate: false })).item)
    await showBoard()
    const todo = board().getByRole('region', { name: '待办', exact: true })
    const more = todo.getByRole('button', { name: '折叠检查工作区：还有 5 项', exact: true })
    await more.waitFor()
    expect(await more.textContent()).toBe('还有 5 项')
    await more.scrollIntoViewIfNeeded()
    mkdirSync(join(tmpdir(), 'vis-ux1'), { recursive: true })
    await page.screenshot({ path: join(tmpdir(), 'vis-ux1/work-board-folded-dark.png') })
    expect(await todo.getByRole('listitem', { name: /^折叠子项/ }).count()).toBe(3)
    await more.click()
    expect(await todo.getByRole('listitem', { name: /^折叠子项/ }).count()).toBe(8)
    await todo.getByRole('button', { name: '折叠检查工作区：收起子项', exact: true }).click()
    expect(await todo.getByRole('listitem', { name: /^折叠子项/ }).count()).toBe(3)
    await more.click()
    const geometry = await board().evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return [...element.querySelectorAll('.vis-work-column')].map(column => {
        const rect = column.getBoundingClientRect()
        return { height: rect.height, inside: rect.top >= bounds.top && rect.bottom <= bounds.bottom, scroll: column.querySelector('.vis-work-column-scroll')!.scrollHeight > column.querySelector('.vis-work-column-scroll')!.clientHeight }
      })
    })
    expect(geometry).toHaveLength(4)
    expect(geometry.every(column => column.inside && column.height === geometry[0]!.height)).toBe(true)
    expect(geometry[0]!.scroll).toBe(true)
    const last = todo.getByRole('listitem', { name: /^折叠子项/ }).last()
    await last.scrollIntoViewIfNeeded()
    expect(await todo.locator('.vis-work-column-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    expect(await board().getByRole('region', { name: '已完成', exact: true }).locator('.vis-work-column-scroll').evaluate(element => element.scrollTop)).toBe(0)
    const title = (await last.getAttribute('aria-label'))!.split('，')[0]!
    expect(await last.locator('svg.vis-agent-icon.is-codex[aria-hidden="true"]').count()).toBe(1)
    await move(title, '已完成')
    const moved = children.find(child => child.title === title)!
    await expect.poll(() => item(moved.workItemId)).toMatchObject({ status: 'done' })
    await landed(title, '已完成')
    mkdirSync(join(tmpdir(), 'vis-ux1'), { recursive: true })
    await page.screenshot({ path: join(tmpdir(), 'vis-ux1/work-board-dark.png') })
    await admin.call('work.delete', { requestId: rid(), spaceId, workItemId: parent.workItemId })
  })

  it('switching project views preserves floating positions; double-clicking blank canvas does not create nodes', async () => {
    const tabs = page.getByRole('tablist', { name: '主视图', exact: true })
    const bounds = () => tabs.evaluate(element => {
      const parent = element.parentElement!
      const { x, y, width, height } = parent.getBoundingClientRect()
      return { x, y, width, height, project: parent.textContent, inHeader: parent.closest('header') !== null }
    })
    await page.getByRole('tab', { name: '画布', exact: true }).click()
    const canvasBounds = await bounds()
    expect(canvasBounds.project).toBe('画布看板')
    expect(canvasBounds.project).not.toContain(projectName)
    expect(await tabs.getByRole('tab').allTextContents()).toEqual(['画布', '看板'])
    expect(await page.locator('.app-header').getByRole('button', { name: '切换项目', exact: true }).textContent()).toContain(projectName)
    expect(canvasBounds.inHeader).toBe(false)
    const pane = page.locator('.react-flow__pane')
    const area = (await pane.boundingBox())!
    expect(canvasBounds.x + canvasBounds.width / 2).toBeCloseTo(area.x + area.width / 2, 0)
    expect(canvasBounds.y).toBeGreaterThanOrEqual(area.y)
    const before = (await admin.call('canvas.get')).nodes
    await pane.dblclick({ position: { x: 200, y: 200 } })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect((await admin.call('canvas.get')).nodes).toEqual(before)
    expect(await page.getByRole('textbox', { name: '文本内容', exact: true }).count()).toBe(0)
    expect(await page.locator('.app-header').getByText('拖入图片或视频导入 · 选中后按 Delete 删除', { exact: true }).count()).toBe(0)
    await showBoard()
    expect(await bounds()).toEqual(canvasBounds)
    await page.keyboard.press('ControlOrMeta+Shift+B')
    await expect.poll(() => page.getByRole('tab', { name: '画布', exact: true }).getAttribute('aria-selected')).toBe('true')
    expect(await bounds()).toEqual(canvasBounds)
  })

  it('board creation and activation do not create canvas frames; cards and shortcut buttons both open the main session', async () => {
    const before = (await admin.call('canvas.get')).nodes
    const work = await createTodo('看板创作工作区')
    await move(work.title, '进行中')
    await chooseCodex()
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'in_progress', sessions: [expect.objectContaining({ agentKind: 'codex' })] })
    const activated = await item(work.workItemId)
    expect(activated.sessions[0]).not.toHaveProperty('role')
    expect(activated).not.toHaveProperty('frameNodeId')
    expect((await admin.call('canvas.get')).nodes).toEqual(before)
    await landed(work.title, '进行中')
    await card(work.title).getByText(work.title, { exact: true }).click()
    await expect.poll(() => page.getByRole('tab', { name: '画布', exact: true }).getAttribute('aria-selected')).toBe('true')
    await showBoard()
    await card(work.title).hover()
    await card(work.title).getByRole('button', { name: '打开会话', exact: true }).click()
    await expect.poll(() => page.getByRole('tab', { name: '画布', exact: true }).getAttribute('aria-selected')).toBe('true')
  })

  it('first and subsequent root-workspace dispatches are automatically confirmed; the board preserves parent-child relationships', async () => {
    const parent = await createTodo('对话发起派发')
    await move(parent.title, '进行中')
    await chooseCodex()
    await expect.poll(async () => (await item(parent.workItemId)).sessions[0]?.activeTurnId, { timeout: 10_000 }).toBeNull()
    const sessionId = (await item(parent.workItemId)).sessions[0]!.sessionId
    const childTitles = ['对话派发 · 镜头 A', '对话派发 · 镜头 B']
    for (const [index, childTitle] of childTitles.entries()) {
      await admin.call('session.sendMessage', { requestId: rid(), sessionId, text: `工作代理检查：${JSON.stringify({ scenario: 'dispatch', confirm: true, children: [{ title: childTitle, script: { scenario: 'hold' } }] })}`, refs: [] })
      // Wait for fake Codex to finish a turn before the child work item exists; busy machines can exceed the default 1-second expect.poll timeout
      await expect.poll(async () => (await admin.call('work.list', { spaceId, parentId: parent.workItemId })).items.length, { timeout: 10_000 }).toBe(index + 1)
      await expect.poll(async () => (await item(parent.workItemId)).sessions[0]?.activeTurnId, { timeout: 10_000 }).toBeNull()
    }
    const children = (await admin.call('work.list', { spaceId, parentId: parent.workItemId })).items as WorkItemView[]
    expect(children.map(work => work.title).sort()).toEqual(childTitles)
    const transcript = await admin.call('session.getTranscript', { sessionId })
    expect(transcript.items.filter((entry: any) => entry.kind === 'approval')).toEqual([])
    await showBoard()
    await card(parent.title).getByText('Codex', { exact: true }).waitFor()
    for (const childTitle of childTitles) {
      await card(childTitle).getByText(`↳ ${parent.title}`, { exact: true }).waitFor()
      await card(childTitle).getByText('Codex', { exact: true }).waitFor()
    }
    expect(errors).toEqual([])
  })

  it('board dragging is unrestricted: todo directly to done, first agent selection, in-progress directly to done, recall, and drag pinning', async () => {
    const before = (await admin.call('canvas.get')).nodes
    const work = await createTodo('镜头一 · 城市雨夜')
    expect(work).toMatchObject({ status: 'todo', sessions: [], brief: '完成镜头一 · 城市雨夜' })
    expect(work).not.toHaveProperty('frameNodeId')
    expect((await admin.call('canvas.get')).nodes).toEqual(before)
    expect(work.changeCount).toBe(0)
    expect(await card(work.title).getByText('今日生成 0', { exact: true }).count()).toBe(0)
    expect(await card(work.title).locator('.vis-work-directory').count()).toBe(0)
    expect(await board().locator('.vis-work-board-heading').getByText(projectName, { exact: true }).count()).toBe(0)
    expect(await card(work.title).getByText(/^本轮改动/).count()).toBe(0)
    expect(await card(work.title).getByRole('button', { name: '在画布中定位', exact: true }).count()).toBe(0)
    await card(work.title).getByRole('button', { name: `${work.title}的更多操作`, exact: true }).click()
    const actions = page.getByRole('dialog', { name: `${work.title}的操作`, exact: true })
    expect(await actions.getByRole('menuitem', { name: '在画布中定位', exact: true }).count()).toBe(0)
    expect(await actions.getByRole('menuitem', { name: '打开目录', exact: true }).getAttribute('title')).toBe(work.workDir)
    await actions.press('Escape')
    await move(work.title, '已完成')
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'done', sessions: [] })
    await landed(work.title, '已完成')
    await move(work.title, '待办')
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'todo' })
    await landed(work.title, '待办')
    await move(work.title, '进行中')
    await chooseCodex()
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'in_progress', sessions: [expect.objectContaining({ agentKind: 'codex' })] })
    await landed(work.title, '进行中')
    await move(work.title, '已完成')
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'done' })
    expect(await page.getByRole('dialog').count()).toBe(0)
    await landed(work.title, '已完成')
    await move(work.title, '进行中')
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'in_progress' })
    await landed(work.title, '进行中')
    await recall(work.title)
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'todo' })
    await landed(work.title, '待办')
    await drag(card(work.title), board().getByLabel('已固定', { exact: true }))
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'todo', pinned: true })
    await board().getByRole('button', { name: `取消固定 ${work.title}`, exact: true }).waitFor()
    await screenshot('board-current.png')
    mkdirSync(join(tmpdir(), 'vis-0019-workbench'), { recursive: true })
    await page.screenshot({ path: join(tmpdir(), 'vis-0019-workbench/zh-board.png') })
  })

  it('cards count this activation history and locate changes proactively; review preserves before/after differences and state transitions', async () => {
    const work = await createTodo('镜头二 · 霓虹细节')
    const beforeText = '霓虹灯光说明\n旧稿：冷蓝灯光照亮雨滴。'
    const afterText = '霓虹灯光说明\n新稿：暖橙窗光映在湿润路面。'
    const deletedText = '待删除的备用镜头\n旧稿：正午阳光下的空街。'
    // Seed Agent-owned drafts before this activation; writer-owned text now requires explicit review and deletion approval.
    const seed = await admin.call('session.create', { requestId: rid(), title: 'History baseline', agentKind: 'codex' })
    await admin.call('session.sendMessage', { requestId: rid(), sessionId: seed.sessionId, refs: [], text: `工作代理检查：${JSON.stringify({ scenario: 'canvas', ops: [
      { op: 'node.create', tempId: 'updated', kind: 'text', x: 2000, y: 400, w: 400, h: 150, content: { text: beforeText } },
      { op: 'node.create', tempId: 'deleted', kind: 'text', x: 2000, y: 720, w: 400, h: 150, content: { text: deletedText } },
    ] })}` })
    await expect.poll(async () => (await admin.call('canvas.get')).nodes.filter((node: NodeView) => node.slots.some(slot => slot.content.type === 'text' && [beforeText, deletedText].includes(slot.content.body))).length, { timeout: 10_000 }).toBe(2)
    await expect.poll(async () => (await admin.call('session.list')).sessions.find((session: { sessionId: string }) => session.sessionId === seed.sessionId)?.activeTurnId, { timeout: 10_000 }).toBeNull()
    await admin.call('work.delete', { requestId: rid(), workItemId: seed.workItemId })
    const originals = (await admin.call('canvas.get')).nodes as NodeView[]
    const updated = originals.find(node => node.slots.some(slot => slot.content.type === 'text' && slot.content.body === beforeText))!
    const deleted = originals.find(node => node.slots.some(slot => slot.content.type === 'text' && slot.content.body === deletedText))!
    expect(updated.slots[0]!.writer?.actor).toBe('agent')
    expect(deleted.slots[0]!.writer?.actor).toBe('agent')
    const updatedSlot = updated.slots.find(slot => slot.slotKey === 'main')!
    const deletedSlot = deleted.slots.find(slot => slot.slotKey === 'main')!
    await move(work.title, '进行中')
    await chooseCodex()
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'in_progress' })
    const activated = await item(work.workItemId)
    // Commit attribution and events in the same real MCP operation so database fixtures do not bypass the changes cache.
    await admin.call('session.sendMessage', { requestId: rid(), sessionId: activated.sessions[0]!.sessionId, refs: [], text: `工作代理检查：${JSON.stringify({ scenario: 'canvas', ops: [
      { op: 'slot.setText', slotId: updatedSlot.slotId, expectedRevision: updatedSlot.revision, body: afterText },
      { op: 'node.layout', nodeId: updated.nodeId, x: 2200, y: 500 },
      { op: 'node.delete', nodeId: deleted.nodeId },
      { op: 'node.create', tempId: 'added', kind: 'text', x: 2800, y: 500, w: 400, h: 150, content: { text: '霓虹补充镜头\n雨滴落进暖橙色的倒影。' } },
    ] })}` })
    await expect.poll(async () => (await admin.call('work.changes', { spaceId, workItemId: work.workItemId })).changes.length, { timeout: 10_000 }).toBe(4)
    await expect.poll(async () => (await item(work.workItemId)).sessions.every(session => session.activeTurnId === null), { timeout: 10_000 }).toBe(true)
    const changes = await admin.call('work.changes', { spaceId, workItemId: work.workItemId })
    expect(changes.changes).toHaveLength(4)
    const added = changes.changes.find(change => change.change === 'created')!.nodeId
    expect(changes.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: updated.nodeId, slotId: updatedSlot.slotId, change: 'updated', fromRevision: 1, toRevision: 2 }),
      expect.objectContaining({ nodeId: deleted.nodeId, slotId: deletedSlot.slotId, change: 'deleted', fromRevision: 1, toRevision: null }),
      expect.objectContaining({ change: 'created', fromRevision: null, toRevision: 1 }),
    ]))
    expect((await item(work.workItemId)).changeCount).toBe(3)
    await page.reload()
    await showBoard()
    await card(work.title).getByText('本轮改动 3 处', { exact: true }).waitFor()
    expect(await card(work.title).getByText(/框内|未绑定画布框/).count()).toBe(0)
    await expect.poll(() => historyReads.filter(id => id === work.workItemId).length).toBeGreaterThan(0)
    const reads = historyReads.filter(id => id === work.workItemId).length
    await page.getByRole('tab', { name: '画布', exact: true }).click()
    await showBoard()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect(historyReads.filter(id => id === work.workItemId)).toHaveLength(reads)
    await board().getByRole('tab', { name: '全部项目', exact: true }).click()
    await page.getByRole('tab', { name: '画布', exact: true }).click()
    const current = await item(work.workItemId)
    await admin.call('work.update', { requestId: rid(), spaceId, workItemId: work.workItemId, expectedRevision: current.revision, title: current.title })
    await showBoard()
    expect(await board().getByRole('tab', { name: '当前项目', exact: true }).getAttribute('aria-selected')).toBe('true')
    await expect.poll(() => historyReads.filter(id => id === work.workItemId).length).toBeGreaterThan(reads)
    await screenshot('board.png')
    const viewport = () => page.locator('.react-flow__viewport').getAttribute('style')
    const selected = () => page.locator('.react-flow__node.selected').evaluateAll(elements => elements.map(element => element.getAttribute('data-id')).sort())
    const beforeViewport = await viewport()
    const beforeSelected = await selected()
    await card(work.title).getByText(work.title, { exact: true }).click()
    await expect.poll(() => page.getByRole('tab', { name: '画布', exact: true }).getAttribute('aria-selected')).toBe('true')
    expect(await viewport()).toBe(beforeViewport)
    expect(await selected()).toEqual(beforeSelected)
    await showBoard()
    await card(work.title).hover()
    await card(work.title).getByRole('button', { name: '在画布中定位', exact: true }).click()
    await expect.poll(() => page.getByRole('tab', { name: '画布', exact: true }).getAttribute('aria-selected')).toBe('true')
    await expect.poll(selected).toEqual([updated.nodeId, added].sort())
    for (const text of [afterText, '霓虹补充镜头\n雨滴落进暖橙色的倒影。']) {
      const target = page.getByText(text, { exact: true })
      await expect.poll(() => target.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        return hit !== null && (hit === element || element.contains(hit))
      })).toBe(true)
    }
    await screenshot('canvas.png')
    await showBoard()
    await move(work.title, '待审阅')
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'in_review' })
    await card(work.title).hover()
    await card(work.title).getByRole('button', { name: '审阅', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: work.title, exact: true })
    await drawer.getByText('没有完成报告', { exact: true }).waitFor()
    await drawer.getByRole('heading', { name: '产物变更', exact: true }).waitFor()
    const changedPreview = drawer.getByRole('article').filter({ hasText: beforeText })
    await changedPreview.getByRole('heading', { name: '修改后 · r2', exact: true }).waitFor()
    await changedPreview.getByText(beforeText, { exact: true }).waitFor()
    await changedPreview.getByText(afterText, { exact: true }).waitFor()
    const deletedPreview = drawer.getByRole('article').filter({ has: page.getByRole('heading', { name: '删除前 · r1', exact: true }) })
    await deletedPreview.getByText(deletedText, { exact: true }).waitFor()
    await changedPreview.getByRole('button', { name: '定位到节点：霓虹灯光说明', exact: true }).waitFor()
    await deletedPreview.getByRole('button', { name: '定位到节点：待删除的备用镜头', exact: true }).waitFor()
    expect(await drawer.getByRole('alert').count()).toBe(0)
    await screenshot('review.png')
    await drawer.getByRole('button', { name: '打回', exact: true }).click()
    await drawer.getByRole('button', { name: '取消打回', exact: true }).waitFor()
    expect(await drawer.getByRole('button', { name: '打回', exact: true }).isEnabled()).toBe(true)
    await drawer.getByRole('textbox', { name: '打回意见', exact: true }).fill('补充雨滴反光细节')
    await drawer.getByRole('button', { name: '打回并发送意见', exact: true }).click()
    await drawer.waitFor({ state: 'hidden' })
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'in_progress' })
    const history = await admin.call('work.get', { spaceId, workItemId: work.workItemId })
    expect(history.messages).toContainEqual(expect.objectContaining({ kind: 'review_feedback', body: '补充雨滴反光细节' }))
    await expect.poll(async () => (await item(work.workItemId)).sessions.every(session => session.activeTurnId === null), { timeout: 10_000 }).toBe(true)
    await landed(work.title, '进行中')
    await move(work.title, '待审阅')
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'in_review' })
    await landed(work.title, '待审阅')
    await move(work.title, '进行中')
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'in_progress' })
    expect((await admin.call('work.get', { spaceId, workItemId: work.workItemId })).messages).toHaveLength(history.messages.length)
    await landed(work.title, '进行中')
    await move(work.title, '待审阅')
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'in_review' })
    await card(work.title).hover()
    await card(work.title).getByRole('button', { name: '审阅', exact: true }).click()
    await drawer.getByRole('button', { name: '通过', exact: true }).click()
    await drawer.waitFor({ state: 'hidden' })
    await expect.poll(() => item(work.workItemId)).toMatchObject({ status: 'done' })
    await board().getByRole('list', { name: '已完成工作项', exact: true }).getByRole('listitem', { name: `${work.title}，已完成`, exact: true }).waitFor()
  })

  it('with a global limit of 1, work queues and the next item starts automatically after recalling the slot holder', async () => {
    await admin.call('work.setSlotLimit', { limit: 1 })
    const first = await createTodo('名额一 · 先开始')
    const second = await createTodo('名额二 · 等待空位')
    await move(first.title, '进行中')
    await chooseCodex()
    await landed(first.title, '进行中')
    await expect.poll(() => item(first.workItemId)).toMatchObject({ status: 'in_progress' })
    await move(second.title, '进行中')
    await chooseCodex()
    await expect.poll(() => item(second.workItemId)).toMatchObject({ status: 'todo', waitingSlotSince: expect.any(Number) })
    await card(second.title).getByText('等待空位 · 第 1 位', { exact: true }).waitFor()
    await board().getByRole('button', { name: '运行中 1/1 · 全局', exact: true }).click()
    const slots = page.getByRole('dialog', { name: '运行中 1/1 · 全局', exact: true })
    await slots.getByRole('button', { name: `取消排队：${second.title}`, exact: true }).waitFor()
    await screenshot('slots.png')
    await slots.press('Escape')
    await recall(first.title)
    await expect.poll(() => item(second.workItemId)).toMatchObject({ status: 'in_progress', waitingSlotSince: null })
    await expect.poll(async () => (await admin.call('work.slots') as WorkSlotsView).queue).toEqual([])
    await board().getByRole('list', { name: '进行中工作项', exact: true }).getByRole('listitem', { name: `${second.title}，进行中`, exact: true }).waitFor()
  })

  it('deleting a running parent aggregates child risks, stops all turns, archives sessions, and preserves the project canvas', async () => {
    const parent = (await admin.call('work.create', { requestId: rid(), spaceId, title: '删除测试 · 父工作项', chat: { agentKind: 'codex' } })).item as WorkItemView
    await admin.call('session.sendMessage', { requestId: rid(), sessionId: parent.sessions[0]!.sessionId, text: `工作代理检查：${JSON.stringify({ scenario: 'dispatch', hold: true, children: [{ title: '删除测试 · 子工作项', script: { scenario: 'hold' } }] })}`, refs: [] })
    await expect.poll(async () => (await item(parent.workItemId)).childIds.length, { timeout: 10_000 }).toBe(1)
    const child = await item((await item(parent.workItemId)).childIds[0]!)
    for (const work of [parent, child]) await expect.poll(async () => (await item(work.workItemId)).sessions[0]?.activeTurnId, { timeout: 10_000 }).toBeTruthy()
    const db = new Database(join(dir, 'spaces', spaceId, 'space.db'), { fileMustExist: true })
    try {
      db.prepare('INSERT INTO work_messages (id, work_item_id, kind, "from", "to", body, refs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('wmsg_e2e_delete_question', child.workItemId, 'question', JSON.stringify({ kind: 'session', sessionId: child.sessions[0]!.sessionId }), 'user', '删除前尚未回复的提问', '{}', Date.now())
    } finally { db.close() }
    const canvas = await admin.call('canvas.apply', { requestId: rid(), ops: [
      { op: 'frame.create', tempId: 'keep-frame', title: '项目分镜整理', x: 3200, y: 0, w: 800, h: 600 },
      { op: 'node.create', tempId: 'keep-member', kind: 'text', x: 3240, y: 80, w: 160, h: 80, content: { text: '删除工作区后保留的项目草稿' } },
    ] })
    await page.reload()
    await showBoard()
    await card(child.title).getByText(child.title, { exact: true }).click()
    await expect.poll(() => page.getByRole('tab', { name: '画布', exact: true }).getAttribute('aria-selected')).toBe('true')
    await showBoard()
    await menu(parent.title, '删除…')
    const dialog = page.getByRole('dialog', { name: `删除「${parent.title}」？`, exact: true })
    await dialog.getByText('⚠ Agent 正在工作，删除会先停止它', { exact: true }).waitFor()
    await dialog.getByText('⚠ 包含 1 个子工作项（1 个进行中），会一起删除', { exact: true }).waitFor()
    await dialog.getByText('⚠ 有 1 条提问在等你回复，删除后不再处理', { exact: true }).waitFor()
    expect(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    expect(await dialog.getByRole('checkbox').count()).toBe(0)
    await screenshot('delete.png')
    await dialog.getByRole('button', { name: '停止并删除', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(async () => (await admin.call('work.list', { spaceId })).items.some((work: WorkItemView) => [parent.workItemId, child.workItemId].includes(work.workItemId))).toBe(false)
    for (const work of [parent, child]) {
      await card(work.title).waitFor({ state: 'hidden' })
      expect(existsSync(work.workDir)).toBe(true)
      await expect(admin.call('work.get', { spaceId, workItemId: work.workItemId })).rejects.toMatchObject({ code: 'not_found' })
    }
    const deletedDb = new Database(join(dir, 'spaces', spaceId, 'space.db'), { fileMustExist: true })
    try {
      for (const work of [parent, child]) {
        expect(deletedDb.prepare('SELECT archived_at FROM sessions WHERE id = ?').get(work.sessions[0]!.sessionId).archived_at).toEqual(expect.any(Number))
        expect(deletedDb.prepare("SELECT COUNT(*) AS count FROM turns WHERE session_id = ? AND status IN ('running', 'waiting_user')").get(work.sessions[0]!.sessionId).count).toBe(0)
      }
    } finally { deletedDb.close() }
    expect((await admin.call('canvas.get', { nodeIds: Object.values(canvas.idMap) })).nodes.map((node: NodeView) => node.nodeId).sort()).toEqual(Object.values(canvas.idMap).sort())
    expect(errors).toEqual([])
    await page.getByText(`已删除「${parent.title}」`, { exact: true }).waitFor()
    await page.reload()
    await showBoard()
    for (const work of [parent, child]) expect(await card(work.title).count()).toBe(0)
  }, 30_000)

  it('idle work-item deletion can be cancelled with Esc, offers no canvas-deletion option, and preserves all content', async () => {
    const work = await createTodo('删除测试 · 空闲保留画布')
    const before = (await admin.call('canvas.get')).nodes
    await menu(work.title, '删除…')
    const dialog = page.getByRole('dialog', { name: `删除「${work.title}」？`, exact: true })
    await dialog.getByText('会话会归档，画布内容保留。', { exact: true }).waitFor()
    await dialog.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    expect((await item(work.workItemId)).archivedAt).toBeNull()
    await menu(work.title, '删除…')
    await dialog.getByText('会话会归档，画布内容保留。', { exact: true }).waitFor()
    expect(await dialog.getByRole('checkbox').count()).toBe(0)
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await card(work.title).waitFor({ state: 'hidden' })
    expect((await admin.call('canvas.get')).nodes).toEqual(before)
    expect(existsSync(work.workDir)).toBe(true)
    await page.reload()
    await showBoard()
    expect(await card(work.title).count()).toBe(0)
  })

  it('failed deletion can be retried, preserves the request ID, and sends no canvas-deletion parameter', async () => {
    const work = await createTodo('删除测试 · 失败重试')
    const before = (await admin.call('canvas.get')).nodes
    const originalPage = page
    const retryPage = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    retryPage.setDefaultTimeout(5000)
    const requests: Record<string, unknown>[] = []
    await retryPage.routeWebSocket(/\/ws\?/, socket => {
      const server = socket.connectToServer()
      socket.onMessage(data => {
        const message = JSON.parse(String(data))
        if (message.method === 'work.delete') {
          requests.push(message.params)
          if (requests.length === 1) {
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Failed to stop; please retry', data: { code: 'unavailable' } } }))
            return
          }
        }
        server.send(data)
      })
    })
    try {
      page = retryPage
      await page.goto(webUrl)
      await showBoard()
      await menu(work.title, '删除…')
      const dialog = page.getByRole('dialog', { name: `删除「${work.title}」？`, exact: true })
      expect(await dialog.getByRole('checkbox').count()).toBe(0)
      await dialog.getByRole('button', { name: '删除', exact: true }).click()
      await dialog.getByRole('alert').filter({ hasText: 'Failed to stop; please retry' }).waitFor()
      expect(await dialog.getByRole('checkbox').count()).toBe(0)
      await dialog.getByRole('button', { name: '删除', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      expect(requests).toHaveLength(2)
      expect(requests[0]!.requestId).toBe(requests[1]!.requestId)
      for (const request of requests) expect(request).not.toHaveProperty('deleteCanvas')
      expect((await admin.call('canvas.get')).nodes).toEqual(before)
    } finally {
      page = originalPage
      await retryPage.close()
    }
  })

  it('dragging an ordinary frame title bar moves its members and supports one-step undo', async () => {
    // Earlier cases leave unrelated nodes behind; they must not cover this frame's drag handle.
    const previous = (await admin.call('canvas.get')).nodes as NodeView[]
    if (previous.length) await admin.call('canvas.apply', { requestId: rid(), ops: previous.map(node => ({ op: 'node.delete', nodeId: node.nodeId })) })
    const title = '普通画布框 · 分镜整理'
    const created = await admin.call('canvas.apply', { requestId: rid(), ops: [
      { op: 'frame.create', tempId: 'frame', title, x: 500, y: 100, w: 800, h: 600 },
      { op: 'node.create', tempId: 'member', kind: 'text', x: 550, y: 170, w: 200, h: 100, content: { text: '随普通框移动的分镜说明' } },
    ] })
    const nodes = async () => (await admin.call('canvas.get')).nodes as NodeView[]
    const frame = (await nodes()).find(node => node.nodeId === created.idMap.frame)!
    const memberId = created.idMap.member
    await expect.poll(async () => (await nodes()).find(node => node.nodeId === memberId)?.frameId).toBe(frame.nodeId)
    const before = (await nodes()).filter(node => node.nodeId === frame.nodeId || node.nodeId === memberId).map(({ nodeId, x, y }) => ({ nodeId, x, y }))
    await page.getByRole('tab', { name: '画布', exact: true }).click()
    await page.getByRole('button', { name: '适应画布', exact: true }).click()
    const heading = page.locator('.vis-frame-header').getByText(title, { exact: true })
    await heading.waitFor()
    await heading.hover()
    const header = (await heading.boundingBox())!
    await page.mouse.move(header.x + 15, header.y + header.height / 2)
    await page.mouse.down()
    await page.mouse.move(header.x + 115, header.y + header.height / 2 + 65, { steps: 12 })
    await page.mouse.up()
    await expect.poll(async () => (await nodes()).find(node => node.nodeId === frame.nodeId)?.x).not.toBe(frame.x)
    const after = (await nodes()).filter(node => before.some(previous => previous.nodeId === node.nodeId))
    const movedFrame = after.find(node => node.nodeId === frame.nodeId)!
    const movedMember = after.find(node => node.nodeId === memberId)!
    expect(movedMember.x - before.find(node => node.nodeId === memberId)!.x).toBeCloseTo(movedFrame.x - frame.x)
    expect(movedMember.y - before.find(node => node.nodeId === memberId)!.y).toBeCloseTo(movedFrame.y - frame.y)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(async () => (await nodes()).filter(node => before.some(previous => previous.nodeId === node.nodeId)).map(({ nodeId, x, y }) => ({ nodeId, x, y }))).toEqual(before)
  })

  it('activating, pinning, recalling, and deleting cards across all projects use their owning project without switching projects', async () => {
    const other = await admin.call('space.create', { requestId: rid(), name: '城市夜景 MV' })
    const remote = (await admin.call('work.create', { requestId: rid(), spaceId: other.spaceId, title: '跨项目 · 片尾字幕', brief: '完成片尾字幕' })).item as WorkItemView
    const externallyDeleted = (await admin.call('work.create', { requestId: rid(), spaceId: other.spaceId, title: '跨项目 · 另一界面删除' })).item as WorkItemView
    await page.reload()
    await showBoard()
    await board().getByRole('tab', { name: '全部项目', exact: true }).click()
    await card(remote.title).getByText(other.name, { exact: true }).waitFor()
    const selectedProject = () => page.evaluate(() => localStorage.getItem('vis.project'))
    expect(await selectedProject()).toBe(spaceId)
    await move(remote.title, '进行中')
    await chooseCodex()
    await expect.poll(() => item(remote.workItemId, other.spaceId)).toMatchObject({ status: 'in_progress' })
    // The RPC state precedes the board event; opening a menu before the column move can detach it.
    await landed(remote.title, '进行中')
    await menu(remote.title, '固定')
    await expect.poll(() => item(remote.workItemId, other.spaceId)).toMatchObject({ pinned: true })
    await screenshot('board-all.png')
    await recall(remote.title)
    await expect.poll(() => item(remote.workItemId, other.spaceId)).toMatchObject({ status: 'todo' })
    // Wait for the all-projects board to render recall before opening the menu, or the card rerender replaces the newly opened menu
    await board().getByRole('listitem', { name: new RegExp(`^${remote.title}，待办`) }).waitFor()
    await menu(remote.title, '删除…')
    const deletion = page.getByRole('dialog', { name: `删除「${remote.title}」？`, exact: true })
    await deletion.getByRole('button', { name: '删除', exact: true }).click()
    await deletion.waitFor({ state: 'hidden' })
    await card(remote.title).waitFor({ state: 'hidden' })
    await card(externallyDeleted.title).waitFor()
    await admin.call('work.delete', { requestId: rid(), spaceId: other.spaceId, workItemId: externallyDeleted.workItemId })
    await card(externallyDeleted.title).waitFor({ state: 'hidden' })
    expect((await admin.call('work.list', { spaceId: other.spaceId })).items).toEqual([])
    expect(await selectedProject()).toBe(spaceId)
    await board().getByRole('tab', { name: '当前项目', exact: true }).click()
    await expect.poll(() => page.getByRole('button', { name: '切换项目', exact: true }).textContent()).toContain(projectName)
    expect(await card(remote.title).count()).toBe(0)
  })

  it('opens an Agent session across projects directly from the all-projects board', async () => {
    const other = await admin.call('space.create', { requestId: rid(), name: 'Session destination' })
    const remote = (await admin.call('work.create', { requestId: rid(), spaceId: other.spaceId, title: '跨项目会话跳转', chat: { agentKind: 'codex' } })).item as WorkItemView
    // A canvas first mounted behind the board has no size; opening it must still fit its content.
    await admin.call('events.subscribe', { spaceId: other.spaceId })
    await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'note', kind: 'text', x: 200, y: 200, w: 320, h: 240, content: { text: '目的地内容' } }] })
    await admin.call('events.subscribe', { spaceId })
    const jump = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 } })
    try {
      await jump.goto(webUrl)
      await jump.evaluate(id => localStorage.setItem('vis.project', id), spaceId)
      await jump.reload()
      await jump.getByRole('tab', { name: '看板', exact: true }).click()
      const allBoard = jump.getByRole('region', { name: '工作看板', exact: true })
      await allBoard.getByRole('tab', { name: '全部项目', exact: true }).click()
      const remoteCard = allBoard.getByRole('listitem', { name: new RegExp(`^${remote.title}，`) })
      await remoteCard.getByRole('button', { name: '打开 Codex 会话', exact: true }).click()
      await expect.poll(() => jump.evaluate(() => localStorage.getItem('vis.project'))).toBe(other.spaceId)
      await jump.getByRole('textbox', { name: '给 Agent 发消息', exact: true }).waitFor()
      expect(await jump.locator('.vis-session-heading strong').innerText()).toBe(remote.title)
      expect(await jump.getByRole('tab', { name: '画布', exact: true }).getAttribute('aria-selected')).toBe('true')
      const note = jump.locator('.react-flow__node').filter({ hasText: '目的地内容' })
      await note.waitFor()
      await expect.poll(() => note.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBeGreaterThan(200)
    } finally {
      await jump.close()
      await admin.call('work.delete', { requestId: rid(), spaceId: other.spaceId, workItemId: remote.workItemId })
    }
  })

  it('opening the inbox marks visible questions read while preserving awaiting-reply status', async () => {
    const parent = (await admin.call('work.create', { requestId: rid(), spaceId, title: '收件箱测试父工作项' })).item as WorkItemView
    const work = (await admin.call('work.dispatch', { requestId: rid(), spaceId, parentId: parent.workItemId, title: '收件箱 · 色调确认', brief: '确认夜景色调', agentKind: 'codex' })).item as WorkItemView
    // Prepare only message fixtures; reads and replies go through the page and real RPC without relying on model-generated content.
    const db = new Database(join(dir, 'spaces', spaceId, 'space.db'), { fileMustExist: true })
    try {
      db.prepare('INSERT INTO work_messages (id, work_item_id, kind, "from", "to", body, refs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('wmsg_e2e_inbox_question', work.workItemId, 'question', JSON.stringify({ kind: 'session', sessionId: work.sessions[0]!.sessionId }), 'user', '夜景采用冷蓝色还是暖橙色？', '{}', Date.now())
    } finally { db.close() }
    await page.reload()
    // Inbox data can arrive before the project snapshot and its session labels.
    const tree = await showWorkTree()
    await tree.getByRole('listitem', { name: new RegExp(`^${work.title}，`) }).waitFor()
    const inbox = page.getByRole('button', { name: '收件箱，1 条未读，1 条等待回复', exact: true })
    await inbox.click()
    const dialog = page.getByRole('dialog', { name: '收件箱', exact: true })
    await dialog.getByText('夜景采用冷蓝色还是暖橙色？', { exact: true }).waitFor()
    await expect.poll(() => dialog.getByRole('region', { name: '提问：Codex', exact: true }).locator('svg.vis-agent-icon.is-codex[aria-hidden="true"]').count()).toBe(1)
    await expect.poll(async () => (await admin.call('work.inbox')).counts).toMatchObject({ unread: 0, unresolved: 1 })
    await screenshot('inbox.png')
    await dialog.press('Escape')
    await page.getByRole('button', { name: '收件箱，0 条未读，1 条等待回复', exact: true }).click()
    await dialog.getByText('夜景采用冷蓝色还是暖橙色？', { exact: true }).waitFor()
    await expect.poll(() => dialog.getByRole('region', { name: '提问：Codex', exact: true }).locator('svg.vis-agent-icon.is-codex[aria-hidden="true"]').count()).toBe(1)
    const reply = dialog.getByRole('textbox', { name: '回复提问', exact: true })
    await reply.fill('采用冷蓝色，保留少量暖色窗光。')
    await reply.press('ControlOrMeta+Enter')
    await dialog.getByText('已由你回复', { exact: true }).waitFor()
    // Reply acknowledgement precedes the inbox refresh and its global count notification.
    await page.getByRole('button', { name: '收件箱，0 条未读，0 条等待回复', exact: true }).waitFor()
    await dialog.getByRole('status').filter({ hasText: '正在读取消息…' }).waitFor({ state: 'hidden' })
    await expect.poll(async () => (await admin.call('work.inbox')).counts).toMatchObject({ unread: 0, unresolved: 0 })
    await dialog.press('Escape')
    expect(errors).toEqual([])
  })

  it('when inbox replies race with deletion, clearly shows the work item is deleted and closes the reply entry', async () => {
    const work = (await admin.call('work.create', { requestId: rid(), spaceId, title: '删除测试 · 收件箱竞争' })).item as WorkItemView
    const db = new Database(join(dir, 'spaces', spaceId, 'space.db'), { fileMustExist: true })
    try {
      db.prepare('INSERT INTO work_messages (id, work_item_id, kind, "from", "to", body, refs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('wmsg_e2e_delete_race', work.workItemId, 'question', JSON.stringify({ kind: 'system' }), 'user', '删除竞争：需要保留哪个镜头？', '{}', Date.now())
    } finally { db.close() }
    await page.reload()
    await page.getByRole('button', { name: /^收件箱，/ }).click()
    const dialog = page.getByRole('dialog', { name: '收件箱', exact: true })
    const message = dialog.getByRole('article').filter({ hasText: '删除竞争：需要保留哪个镜头？' })
    const reply = message.getByRole('textbox', { name: '回复提问', exact: true })
    await reply.fill('保留第一个镜头')
    await admin.call('work.delete', { requestId: rid(), spaceId, workItemId: work.workItemId })
    await message.getByRole('button', { name: '发送回复', exact: true }).click()
    await message.getByText('工作项已删除', { exact: true }).waitFor()
    expect(await message.getByRole('textbox').count()).toBe(0)
    expect(await message.getByText('上级已先回复：', { exact: true }).count()).toBe(0)
    expect(await message.getByRole('button', { name: '改为追加说明', exact: true }).count()).toBe(0)
    await dialog.press('Escape')
  })
})
