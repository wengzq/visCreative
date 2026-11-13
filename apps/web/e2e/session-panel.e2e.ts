import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { chromePath, removeTempDir, supportsNativeApprovals } from './platform'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
// Real studiod, web host, and Chrome; only Codex app-server is replaced with a local echo program.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import type { WorkItemView } from '@vis/protocol'
import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const CHROME = chromePath()
const ready = existsSync(CHROME) && existsSync(join(root, 'services/studiod/dist/studiod.mjs')) && existsSync(join(root, 'apps/web/dist/vis-web.mjs'))
const artifacts = join(tmpdir(), 'vis-0019-workbench')
const Database = createRequire(new URL('../../../packages/storage/package.json', import.meta.url))('better-sqlite3')
const processes: ChildProcess[] = []
const errors: string[] = []
let dir: string
let projectsDir: string
let browser: Browser
let page: Page
let admin: StudiodLink
let spaceId: string
let webUrl: string
let sequence = 0
const temporaryWorkIds: string[] = []
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

async function createWork(title: string, parentId?: string) {
  if (parentId) return (await admin.call('work.dispatch', { requestId: rid(), spaceId, parentId, title, brief: '工作代理检查：{"scenario":"hold"}', agentKind: 'codex', activate: false })).item as WorkItemView
  return (await admin.call('work.create', { requestId: rid(), spaceId, title, chat: { agentKind: 'codex' } })).item as WorkItemView
}
async function createTemporaryWork(title: string) {
  const item = await createWork(title)
  temporaryWorkIds.push(item.workItemId)
  return item
}
const tree = () => page.getByRole('region', { name: '工作区', exact: true })
const card = (title: string) => tree().getByRole('listitem', { name: new RegExp(`^${title}，`) })
const composer = () => page.getByRole('textbox', { name: '给 Agent 发消息', exact: true })
async function back() {
  const button = page.getByRole('button', { name: '返回列表', exact: true })
  if (await button.isVisible()) await button.click()
  await tree().waitFor()
}
async function work(id: string): Promise<WorkItemView> { return (await admin.call('work.get', { spaceId, workItemId: id })).item }

describe.skipIf(!ready)('RFC 0010 session panel', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-work-e2e-'))
    projectsDir = mkdtempSync(join(tmpdir(), 'vis-work-projects-'))
    const env = {
      VIS_DATA_DIR: dir, VIS_PROJECTS_DIR: projectsDir,
      VIS_CLI_BIN_DIR: join(root, 'apps/cli/dist'), VIS_CODEX_PATH: join(root, 'apps/web/e2e/fake-codex.mjs'),
    }
    await start(join(root, 'services/studiod/dist/studiod.mjs'), env, /\[studiod\] Started /)
    webUrl = await start(join(root, 'apps/web/dist/vis-web.mjs'), env, /(http:\/\/127\.0\.0\.1:\d+\/#t=\S+)/)
    admin = await openStudiodLink({ socketPath: studiodEndpoint(dir), tokenPath: join(dir, 'run/studiod.token') })
    const { spaces } = await admin.call('space.list')
    spaceId = spaces[0].spaceId
    await admin.call('events.subscribe', { spaceId })
    await admin.call('work.setSlotLimit', { limit: 6 })
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.stack ?? error.message))
    await page.goto(webUrl)
    await page.getByRole('button', { name: '开始创作', exact: true }).waitFor()
  }, 30_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await page.screenshot({ path: join(artifacts, `failure-${task.name.replace(/[^\p{L}\p{N}]+/gu, '-')}.png`) })
    await page.keyboard.press('Escape')
    const expand = page.getByRole('button', { name: '展开会话面板', exact: true })
    if (await expand.isVisible()) await expand.click()
    await back()
    for (const workItemId of temporaryWorkIds.splice(0)) await admin.call('work.delete', { requestId: rid(), spaceId, workItemId })
    expect(errors).toEqual([])
  })
  afterAll(async () => {
    admin?.close()
    await browser?.close()
    for (const proc of processes) proc.kill('SIGINT')
    await Promise.all(processes.map(proc => proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => proc.once('exit', () => resolve()))))
    removeTempDir(dir)
    removeTempDir(projectsDir)
  })

  it('start creating shows only a plus with hover/focus hints; agent icons appear in the list, header, and creation entry', async () => {
    const create = page.getByRole('button', { name: '开始创作', exact: true })
    expect(await create.textContent()).toBe('+')
    await create.hover()
    await page.getByRole('tooltip', { name: '开始创作', exact: true }).waitFor()
    await page.mouse.move(10, 10)
    await expect.poll(() => create.isEnabled()).toBe(true)
    await create.focus()
    await page.getByRole('tooltip', { name: '开始创作', exact: true }).waitFor()
    await create.press('Enter')
    const dialog = page.getByRole('dialog', { name: '新建工作区', exact: true })
    for (const name of ['Codex', 'DeepSeek']) expect(await dialog.getByRole('button', { name, exact: true }).locator('svg[aria-hidden="true"]').count()).toBe(1)
    await dialog.press('Escape')
    // Create sessions only, without sending messages; DeepSeek and Claude do not start real adapters.
    const created: string[] = []
    for (const agentKind of ['codex', 'deepseek', 'claude'] as const) {
      const title = `图标检查 ${agentKind}`
      const result = await admin.call('work.create', { requestId: rid(), spaceId, title, chat: { agentKind } })
      created.push(result.item.workItemId)
      await card(title).waitFor()
      expect(await card(title).locator(`svg.vis-agent-icon.is-${agentKind}[aria-hidden="true"]`).count()).toBe(1)
      await card(title).click()
      await composer().waitFor()
      expect(await page.locator('.vis-session-heading').locator(`svg.vis-agent-icon.is-${agentKind}[aria-hidden="true"]`).count()).toBe(1)
      await back()
    }
    mkdirSync(join(tmpdir(), 'vis-ux1'), { recursive: true })
    await create.focus()
    await page.getByRole('tooltip', { name: '开始创作', exact: true }).waitFor()
    await page.screenshot({ path: join(tmpdir(), 'vis-ux1/session-panel-dark.png') })
    for (const workItemId of created) await admin.call('work.delete', { requestId: rid(), spaceId, workItemId })
  })

  it('RFC 0019: empty-session examples only populate input, the entire input card focuses it, and the project path appears only on hover', async () => {
    const item = await createTemporaryWork('空会话引导')
    await page.getByRole('button', { name: '切换项目', exact: true }).click()
    const selectedProject = page.locator('.vis-project-menu [aria-current=true]')
    expect(await selectedProject.getAttribute('title')).toBeTruthy()
    expect(await selectedProject.locator('span[title]').count()).toBe(0)
    await page.screenshot({ path: join(artifacts, 'zh-project-menu.png') })
    await page.keyboard.press('Escape')
    await card(item.title).click()
    const example = page.getByRole('button', { name: '把这段分镜拆成三个镜头', exact: true })
    await example.waitFor()
    expect(await page.getByText('已到最早', { exact: true }).count()).toBe(0)
    await page.screenshot({ path: join(artifacts, 'zh-empty.png') })
    await example.click()
    expect(await composer().inputValue()).toBe('把这段分镜拆成三个镜头')
    expect(await composer().evaluate(element => document.activeElement === element)).toBe(true)
    expect(await page.locator('.vis-composer-card').evaluate(element => getComputedStyle(element).borderTopColor)).toBe('rgb(123, 127, 255)')
    expect((await admin.call('session.getTranscript', { sessionId: item.sessions[0]!.sessionId })).items).toEqual([])
    const modelButton = page.locator('.vis-composer-toolbar').getByRole('button', { name: /^模型与思考强度/ })
    expect(await modelButton.count()).toBe(1)
    // A long model and service label must truncate instead of pushing the tools onto a second row.
    const modelLabel = await modelButton.locator('span').innerText()
    await modelButton.locator('span').evaluate(label => { label.textContent = 'GPT-6-Astra · Codex · us-vps-codex · medium '.repeat(4) })
    const toolTops = await page.locator('.vis-composer-tools > button').evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().top + button.getBoundingClientRect().height / 2)))
    expect(new Set(toolTops).size).toBe(1)
    expect(await page.locator('.vis-composer-tools').evaluate(row => row.scrollWidth <= row.clientWidth)).toBe(true)
    await modelButton.locator('span').evaluate((label, text) => { label.textContent = text }, modelLabel)
    const send = page.getByRole('button', { name: '发送', exact: true })
    expect(await send.getAttribute('title')).toBe('回车发送 · Shift+回车换行')
    expect(await send.getAttribute('class')).toBe('vis-send-button')
    await page.screenshot({ path: join(artifacts, 'zh-composer.png') })
    await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'summary', kind: 'text', x: 0, y: 0, w: 300, h: 180, content: { text: '# 分镜摘要\n**镜头一**\n- 雨夜街道' } }] })
    await composer().fill('@')
    await page.getByRole('listbox', { name: '画布节点', exact: true }).waitFor()
    expect(await page.locator('.vis-mention-preview').textContent()).toBe('分镜摘要\n镜头一\n雨夜街道')
    expect(await page.locator('.vis-mention-info').textContent()).not.toContain('**')
    await page.screenshot({ path: join(artifacts, 'zh-mention.png') })
    await page.keyboard.press('Escape')

  })

  it('RFC 0015: attachment imports do not create nodes, registration disables sending, and failures can be removed and previewed', async () => {
    await createTemporaryWork('消息附件')
    await card('消息附件').click()
    const before = await page.locator('.react-flow__node').count()
    let release: (() => void) | undefined
    await page.route('**/upload?**', async route => {
      await new Promise<void>(resolve => { release = resolve })
      await route.continue()
    })
    const file = { name: '附件.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4i8AAAAASUVORK5CYII=', 'base64') }
    await composer().fill('请查看这张附件')
    await page.getByLabel('选择消息附件', { exact: true }).setInputFiles(file)
    await expect.poll(() => Boolean(release)).toBe(true)
    expect(await page.getByRole('button', { name: '发送', exact: true }).isDisabled()).toBe(true)
    release!()
    await page.getByRole('button', { name: '预览附件：附件.png', exact: true }).waitFor()
    expect(await page.locator('.react-flow__node').count()).toBe(before)
    expect(await page.getByRole('button', { name: '发送', exact: true }).isEnabled()).toBe(true)
    await page.getByRole('button', { name: '预览附件：附件.png', exact: true }).click()
    await page.getByRole('dialog', { name: '附件预览：附件.png', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '移除附件：附件.png', exact: true }).click()
    await page.unroute('**/upload?**')
    await page.getByLabel('选择消息附件', { exact: true }).setInputFiles({ name: 'unsupported.txt', mimeType: 'text/plain', buffer: Buffer.from('无效附件') })
    await page.getByText('不支持的文件类型，请选择图片、视频或音频', { exact: false }).waitFor()
    expect(await page.getByRole('button', { name: '发送', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: '移除附件：unsupported.txt', exact: true }).click()
    expect(await page.getByRole('button', { name: '发送', exact: true }).isEnabled()).toBe(true)
  })

  it('RFC 0015: the first permission switch explains its scope; cancellation keeps ask mode', async () => {
    await createTemporaryWork('权限确认')
    await card('权限确认').click()
    await page.getByRole('button', { name: '权限：每次询问', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '开启自动放行', exact: true })
    await dialog.waitFor()
    expect(await dialog.locator('li').count()).toBe(3)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    expect(await dialog.count()).toBe(0)
    expect(await page.getByRole('button', { name: '权限：每次询问', exact: true }).isVisible()).toBe(true)
  })

  it('RFC 0015: sends attachments and switches automatic approval', async () => {
    const item = await createTemporaryWork('附件与权限集成')
    const sessionId = item.sessions[0]!.sessionId
    await card('附件与权限集成').click()
    await page.getByRole('button', { name: '权限：每次询问', exact: true }).click()
    await page.getByRole('button', { name: '确认开启', exact: true }).click()
    await expect.poll(async () => (await admin.call('session.list', {})).sessions.find(session => session.sessionId === sessionId)?.approvalMode).toBe('auto')
    await page.getByLabel('选择消息附件', { exact: true }).setInputFiles({ name: '素材.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4i8AAAAASUVORK5CYII=', 'base64') })
    await page.getByRole('button', { name: '预览附件：素材.png', exact: true }).waitFor()
    const before = await page.locator('.react-flow__node').count()
    await composer().fill('查看素材附件')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.locator('.vis-item.is-user').getByRole('button', { name: '预览附件：素材.png', exact: true }).waitFor()
    expect(await page.locator('.react-flow__node').count()).toBe(before)
    const records = () => readFileSync(join(item.workDir, '.vis-e2e-agent.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    // Wait for the fake Codex process to start; busy machines can exceed the default 1-second expect.poll timeout
    await expect.poll(() => records().find(record => record.method === 'turn/start')?.prompt, { timeout: 10_000 }).toContain('<素材附件>')
    const prompt = records().find(record => record.method === 'turn/start')!.prompt as string
    const attachment = JSON.parse(prompt.match(/<素材附件>\n([^\n]+)\n<\/素材附件>/)![1]!)
    expect(attachment).toMatchObject({ assetId: expect.any(String), assetVersionId: expect.any(String), kind: 'image', filename: '素材.png' })
    expect(attachment.path).toContain(`${sep}assets${sep}`)
    expect(existsSync(attachment.path)).toBe(true)
    const transcript = await admin.call('session.getTranscript', { sessionId })
    expect(transcript.items.find(entry => entry.kind === 'user')?.payload).toMatchObject({ text: '查看素材附件', refs: [{ assetVersionId: attachment.assetVersionId }] })
    await page.getByRole('button', { name: '权限：自动放行', exact: true }).click()
    await page.getByRole('button', { name: '权限：每次询问', exact: true }).click()
    await page.getByRole('button', { name: '权限：自动放行', exact: true }).waitFor()
    expect(await page.getByRole('dialog', { name: '开启自动放行', exact: true }).count()).toBe(0)
    await expect.poll(async () => (await admin.call('session.list', {})).sessions.find(session => session.sessionId === sessionId)?.activeTurnId, { timeout: 10_000 }).toBeNull()
    const userMessage = page.locator('.vis-item.is-user').first()
    expect(await userMessage.locator('.vis-user-heading').textContent()).toMatch(/^你 /)
    expect(await userMessage.locator('time').getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const style = await userMessage.evaluate(element => {
      const value = getComputedStyle(element)
      return { borderLeftStyle: value.borderLeftStyle, borderLeftWidth: value.borderLeftWidth, borderRadius: value.borderRadius, backgroundColor: value.backgroundColor }
    })
    expect(style).toMatchObject({ borderLeftStyle: 'none', borderRadius: '10px', backgroundColor: 'rgb(38, 38, 38)' })
    expect(parseFloat(style.borderLeftWidth)).toBe(0)
    await page.screenshot({ path: join(tmpdir(), 'vis-0015-e-B.png') })
  })

  it.skipIf(!supportsNativeApprovals)('RFC 0015: automatically approves native commands inside the workspace', async () => {
    await page.evaluate(() => localStorage.removeItem('vis.approval.auto.confirmed'))
    const item = await createTemporaryWork('自动审批集成')
    const sessionId = item.sessions[0]!.sessionId
    await card(item.title).click()
    await page.getByRole('button', { name: '权限：每次询问', exact: true }).click()
    await page.getByRole('button', { name: '确认开启', exact: true }).click()
    await expect.poll(async () => (await admin.call('session.list', {})).sessions.find(session => session.sessionId === sessionId)?.approvalMode).toBe('auto')
    // The dialog restores focus when it closes; wait before typing into the new session's composer.
    await page.getByRole('dialog', { name: '开启自动放行', exact: true }).waitFor({ state: 'hidden' })
    await composer().click()
    await composer().fill('审批检查')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByText('已自动放行', { exact: false }).waitFor()
    await page.getByText('已获准', { exact: true }).waitFor()
    const audited = (await admin.call('session.getTranscript', { sessionId })).items.filter(entry => entry.kind === 'approval')
    expect(audited).toHaveLength(1)
    expect(audited[0]!.payload).toMatchObject({ kind: 'command', status: 'approved', auto: true, decision: 'allow_once' })
    expect(realpathSync((audited[0]!.payload as { cwd: string }).cwd)).toBe(realpathSync(item.workDir))
    expect((audited[0]!.payload as { detail: string }).detail).toContain('mkdir -p exports && touch exports/storyboard.txt')
    expect(await page.getByRole('button', { name: '允许一次', exact: true }).count()).toBe(0)
  })

  it('RFC 0015: scrolling up again at the top loads history; repeated scrolling requests only one page and preserves position', async () => {
    const item = await createTemporaryWork('历史分页')
    const sessionId = item.sessions[0]!.sessionId
    const historyPage = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 } })
    const pages: number[] = []
    let release: (() => void) | undefined
    await historyPage.routeWebSocket(/.*/, socket => {
      const server = socket.connectToServer()
      const requests = new Map<number, { method: string; params: { sessionId?: string; beforeSeq?: number } }>()
      socket.onMessage(message => {
        const request = JSON.parse(String(message))
        requests.set(request.id, request)
        server.send(message)
      })
      server.onMessage(message => {
        const response = JSON.parse(String(message))
        const request = requests.get(response.id)
        if (request?.method !== 'session.getTranscript' || request.params.sessionId !== sessionId) { socket.send(message); return }
        const end = request.params.beforeSeq ?? 121
        pages.push(end)
        response.result = { hasMore: end > 101, items: Array.from({ length: 20 }, (_, i) => {
          const seq = end - 20 + i
          return { itemId: `history-${seq}`, kind: 'user', turnId: null, createdSeq: seq, revision: 1, createdAt: seq, updatedAt: seq, payload: { text: `历史消息 ${seq}\n这是用于核对滚动位置的长段落。\n新增历史后仍应看到原来的内容。`, refs: [] } }
        }) }
        if (request.params.beforeSeq) release = () => socket.send(JSON.stringify(response))
        else socket.send(JSON.stringify(response))
      })
    })
    try {
      await historyPage.goto(webUrl)
      await historyPage.getByRole('listitem', { name: /^历史分页，/ }).click()
      await historyPage.getByText('历史消息 120', { exact: false }).waitFor()
      const scroller = historyPage.locator('.vis-transcript')
      await scroller.evaluate(el => { el.scrollTop = 0 })
      expect(pages).toEqual([121])
      await scroller.hover()
      await historyPage.mouse.wheel(0, -100)
      await expect.poll(() => pages.length).toBe(2)
      await historyPage.getByText('加载更早的记录…', { exact: true }).waitFor()
      await historyPage.mouse.wheel(0, -100)
      expect(pages).toEqual([121, 101])
      const original = historyPage.getByText('历史消息 101', { exact: false })
      const before = (await original.boundingBox())!.y
      release!()
      await historyPage.getByText('已到最早', { exact: true }).waitFor()
      await expect.poll(async () => Math.abs((await original.boundingBox())!.y - before)).toBeLessThan(2)
      expect(await historyPage.locator('.vis-item.is-user').count()).toBe(40)
    } finally { await historyPage.close() }
  })

  it('RFC 0015: after stopping, the header shows the queue count; refresh resumes sending in order', async () => {
    const item = await createTemporaryWork('恢复发送队列')
    const sessionId = item.sessions[0]!.sessionId
    const prompts = () => readFileSync(join(item.workDir, '.vis-e2e-agent.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(record => record.method === 'turn/start').map(record => record.prompt as string)
    await card(item.title).click()
    await composer().fill('工作代理检查：{"scenario":"hold"}')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByRole('button', { name: '停止', exact: true }).waitFor()
    await expect.poll(prompts).toHaveLength(1)
    for (const text of ['队列消息 A', '队列消息 B']) {
      await composer().fill(text)
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await page.locator('.vis-item.is-user').filter({ hasText: text }).getByText('排队中', { exact: true }).waitFor()
    }
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await expect.poll(async () => (await work(item.workItemId)).sessions[0]?.activeTurnId).toBeNull()
    const header = page.locator('.vis-session-heading')
    await header.getByText('已暂停，2 条消息等待发送', { exact: true }).waitFor()
    await page.reload()
    await card(item.title).click()
    await header.getByText('已暂停，2 条消息等待发送', { exact: true }).waitFor()
    await header.getByRole('button', { name: '继续', exact: true }).click()
    for (const text of ['队列消息 A', '队列消息 B']) await page.getByText(`收到：${text}`, { exact: true }).waitFor()
    await expect.poll(async () => (await admin.call('session.list', {})).sessions.find(session => session.sessionId === sessionId)).toMatchObject({ queuePaused: false, queuedMessageCount: 0, activeTurnId: null })
    expect(await header.getByText('已暂停，2 条消息等待发送', { exact: true }).count()).toBe(0)
    expect(prompts()).toHaveLength(3)
    expect(prompts()[1]).toContain('队列消息 A')
    expect(prompts()[2]).toContain('队列消息 B')
  })

  it('RFC 0015: clearing requires confirmation, withdraws only user drafts, and preserves work-item reports', async () => {
    const item = await createTemporaryWork('清空发送队列')
    const sessionId = item.sessions[0]!.sessionId
    await card(item.title).click()
    await composer().fill('工作代理检查：{"scenario":"hold"}')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByRole('button', { name: '停止', exact: true }).waitFor()
    const { item: child } = await admin.call('work.dispatch', { requestId: rid(), spaceId, parentId: item.workItemId, title: '清空时保留回报', brief: '工作代理检查：{"scenario":"done","body":"清空后仍需投递的回报"}', agentKind: 'codex' })
    await expect.poll(async () => (await work(child.workItemId)).status, { timeout: 10_000 }).toBe('in_review')
    const report = (await admin.call('work.get', { spaceId, workItemId: child.workItemId })).messages.find(message => message.kind === 'done')!
    expect(report.ackedAt).toBeNull()
    for (const text of ['撤回草稿 A', '撤回草稿 B']) {
      await composer().fill(text)
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await page.locator('.vis-item.is-user').filter({ hasText: text }).getByText('排队中', { exact: true }).waitFor()
    }
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await expect.poll(async () => (await work(item.workItemId)).sessions[0]?.activeTurnId).toBeNull()
    const header = page.locator('.vis-session-heading')
    await header.getByText('已暂停，2 条消息等待发送', { exact: true }).waitFor()
    for (const accept of [false, true]) {
      const pending = page.waitForEvent('dialog')
      const clicking = header.getByRole('button', { name: '清空', exact: true }).click()
      const dialog = await pending
      expect(dialog.type()).toBe('confirm')
      expect(dialog.message()).toContain('用户')
      expect(dialog.message()).toContain('回报')
      expect(dialog.message()).toMatch(/保留|不会撤回/)
      if (accept) await dialog.accept()
      else await dialog.dismiss()
      await clicking
      if (!accept) await header.getByText('已暂停，2 条消息等待发送', { exact: true }).waitFor()
    }
    for (const text of ['撤回草稿 A', '撤回草稿 B']) await page.locator('.vis-item.is-user').filter({ hasText: text }).getByText('已撤回', { exact: true }).waitFor()
    await expect.poll(async () => (await admin.call('session.list', {})).sessions.find(session => session.sessionId === sessionId)).toMatchObject({ queuePaused: true, queuedMessageCount: 0, activeTurnId: null })
    expect((await admin.call('work.get', { spaceId, workItemId: child.workItemId })).messages.find(message => message.messageId === report.messageId)).toMatchObject({ body: '清空后仍需投递的回报', ackedAt: null })
    await composer().fill('清空后发送')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByText('收到：清空后发送', { exact: true }).waitFor()
    await expect.poll(async () => (await admin.call('work.get', { spaceId, workItemId: child.workItemId })).messages.find(message => message.messageId === report.messageId)?.ackedAt).toBeTruthy()
    const prompts = readFileSync(join(item.workDir, '.vis-e2e-agent.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(record => record.method === 'turn/start').map(record => record.prompt as string)
    expect(prompts.some(prompt => prompt.includes(report.messageId))).toBe(true)
    expect(prompts.some(prompt => prompt.includes('撤回草稿 A') || prompt.includes('撤回草稿 B'))).toBe(false)
  })

  it('RFC 0049: a root Agent dispatches a configured child whose first turn and model picker agree with work.get', async () => {
    const parent = await createTemporaryWork('Child model selection')
    const config = { model: 'gpt-fast', effort: 'low', serviceTier: 'default' }
    await card(parent.title).click()
    await composer().fill(`工作代理检查：${JSON.stringify({ scenario: 'child-config', title: 'Configured child model', agentConfig: config })}`)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(async () => (await work(parent.workItemId)).childIds.length, { timeout: 10_000 }).toBe(1)
    const childId = (await work(parent.workItemId)).childIds[0]!
    const child = await work(childId)
    expect(child.sessions[0]!.agentConfig).toEqual(config)
    const records = (workDir: string) => {
      const path = join(workDir, '.vis-e2e-agent.jsonl')
      return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    }
    await expect.poll(() => records(parent.workDir).find(entry => entry.tool === 'work_get')?.output.item.sessions[0].agentConfig).toEqual(config)
    expect(records(parent.workDir).find(entry => entry.tool === 'work_agent_options')?.output.models.map((model: { id: string }) => model.id)).toEqual(['gpt-test', 'gpt-fast'])
    await expect.poll(() => records(child.workDir).find(entry => entry.method === 'turn/start')).toMatchObject({ model: 'gpt-fast', effort: 'low', serviceTierForTurn: 'default' })
    await back()
    await card(child.title).click()
    const settings = page.getByRole('button', { name: /^模型与思考强度：/ })
    await settings.click()
    await expect.poll(() => page.getByRole('combobox', { name: '模型', exact: true }).inputValue()).toBe('gpt-fast')
    expect(await page.getByRole('combobox', { name: '思考强度', exact: true }).inputValue()).toBe('low')
    expect(await page.getByRole('combobox', { name: '速度', exact: true }).inputValue()).toBe('default')
    await expect.poll(() => settings.textContent()).toContain('GPT Fast')
    await page.keyboard.press('Escape')
    await page.screenshot({ path: '/tmp/vis-0049-child-model.png' })
    await admin.call('work.submitReview', { requestId: rid(), spaceId, workItemId: childId })
    const reviewPage = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    reviewPage.setDefaultTimeout(5000)
    let catalogRequests = 0
    let releaseCatalog: (() => void) | undefined
    try {
      await reviewPage.routeWebSocket(/.*/, socket => {
        const server = socket.connectToServer()
        const held = new Set<number>()
        socket.onMessage(message => {
          const request = JSON.parse(String(message))
          if (request.method === 'work.agentOptions') { held.add(request.id); catalogRequests++ }
          server.send(message)
        })
        server.onMessage(message => {
          const response = JSON.parse(String(message))
          if (held.has(response.id)) { releaseCatalog = () => socket.send(message); return }
          socket.send(message)
        })
      })
      await reviewPage.goto(webUrl)
      await reviewPage.getByRole('button', { name: '开始创作', exact: true }).waitFor()
      await reviewPage.getByRole('tab', { name: '看板', exact: true }).click()
      const childCard = reviewPage.getByRole('region', { name: '工作看板', exact: true }).getByRole('listitem', { name: /^Configured child model，/ })
      await childCard.hover()
      await childCard.getByRole('button', { name: '审阅', exact: true }).click()
      const drawer = reviewPage.getByRole('dialog', { name: child.title, exact: true })
      await drawer.getByText('Codex · gpt-fast · low · 标准速度', { exact: true }).waitFor()
      await expect.poll(() => drawer.getByRole('button', { name: '通过', exact: true }).isEnabled()).toBe(true)
      await expect.poll(() => Boolean(releaseCatalog)).toBe(true)
      expect(catalogRequests).toBe(1)
      releaseCatalog!()
      await drawer.getByText('Codex · GPT Fast · low · 标准速度', { exact: true }).waitFor()
      await reviewPage.screenshot({ path: '/tmp/vis-0049-review-model.png' })
      await drawer.press('Escape')
      expect(await childCard.getByRole('button', { name: '打开 Codex 会话', exact: true }).count()).toBe(1)
      expect(await childCard.locator('.vis-work-agent-model').textContent()).toBe(' · GPT Fast · low · 标准速度')
      expect(catalogRequests).toBe(1)
    } finally { await reviewPage.close() }
  })

  it('RFC 0014: passes model and effort, resets on model changes, and applies on the next turn', async () => {
    const item = await createWork('会话模型设置')
    await card('会话模型设置').click()
    const settings = page.getByRole('button', { name: /^模型与思考强度：/ })
    await settings.focus()
    await page.keyboard.press('Enter')
    const model = page.getByRole('combobox', { name: '模型', exact: true })
    const effort = page.getByRole('combobox', { name: '思考强度', exact: true })
    await expect.poll(() => model.locator('option').allTextContents(), { timeout: 5000 }).toEqual(['默认', 'GPT Test（Agent 默认）', 'GPT Fast'])
    expect(await model.evaluate(element => element === document.activeElement)).toBe(true)
    await model.selectOption('gpt-test')
    await expect.poll(() => settings.textContent()).toContain('GPT Test')
    await effort.selectOption('high')
    await expect.poll(async () => (await admin.call('session.list', {})).sessions.find(session => session.sessionId === item.sessions[0]!.sessionId)?.agentConfig).toEqual({ model: 'gpt-test', effort: 'high', serviceTier: null })
    // Speed tiers come from the Codex model catalog; selection shows the tier description and includes its name in the button text
    const speed = page.getByRole('combobox', { name: '速度', exact: true })
    expect(await speed.locator('option').allTextContents()).toEqual(['默认', '标准', 'Fast'])
    await speed.selectOption('fast')
    await page.getByText('更快，消耗更多额度', { exact: true }).waitFor()
    await expect.poll(() => settings.textContent()).toContain('Fast')
    await expect.poll(async () => (await admin.call('session.list', {})).sessions.find(session => session.sessionId === item.sessions[0]!.sessionId)?.agentConfig, { timeout: 10_000 }).toEqual({ model: 'gpt-test', effort: 'high', serviceTier: 'fast' })
    await page.screenshot({ path: join(tmpdir(), 'vis-0014-picker.png') })
    await page.keyboard.press('Escape')
    await composer().fill('慢模型检查')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByRole('button', { name: '停止', exact: true }).waitFor()
    const records = () => readFileSync(join(item.workDir, '.vis-e2e-agent.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(record => record.method === 'turn/start')
    await expect.poll(() => records().at(-1), { timeout: 10_000 }).toMatchObject({ model: 'gpt-test', effort: 'high', serviceTierForTurn: 'fast' })
    await settings.click()
    await model.selectOption('gpt-fast')
    await page.getByText('此模型不支持原思考强度，已恢复默认。', { exact: true }).waitFor()
    await page.getByText('此模型不支持原速度，已恢复默认。', { exact: true }).waitFor()
    await expect.poll(() => effort.inputValue()).toBe('')
    // GPT Fast has no speed tiers, so speed options disappear
    expect(await page.getByRole('combobox', { name: '速度', exact: true }).count()).toBe(0)
    await page.getByText('下一回合生效', { exact: true }).waitFor()
    await page.screenshot({ path: join(tmpdir(), 'vis-0014-next-turn.png') })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await expect.poll(() => page.getByRole('button', { name: '停止', exact: true }).count()).toBe(0)
    expect(await page.getByText('下一回合生效', { exact: true }).count()).toBe(1)
    // Stopping pauses the queue; only the next message after resuming starts a new turn
    const sessionId = item.sessions[0]!.sessionId
    await expect.poll(async () => (await admin.call('session.list', {})).sessions.find(session => session.sessionId === sessionId)?.queuePaused).toBe(true)
    await admin.call('session.resumeQueue', { requestId: rid(), sessionId })
    await back()
    await card('会话模型设置').click()
    await page.getByText('下一回合生效', { exact: true }).waitFor()
    await composer().fill('新模型检查')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => records().length, { timeout: 10_000 }).toBe(2)
    expect(records()[1].model).toBe('gpt-fast')
    // When effort is set to default, explicitly pass the model default: Codex retains the previous turn override
    expect(records()[1].effort).toBe('low')
    // After restoring default speed, omit it to use the Codex configuration
    expect(records()[1]).not.toHaveProperty('serviceTierForTurn')
    await expect.poll(() => page.getByText('下一回合生效', { exact: true }).count(), { timeout: 10_000 }).toBe(0)
    await page.getByText('收到：新模型检查', { exact: true }).waitFor()
    await page.screenshot({ path: join(tmpdir(), 'vis-0014-applied.png') })
  })

  it('RFC 0013: reasoning deltas, timing, automatic collapse, in-place plan updates, and Chinese tool names', async () => {
    await createWork('Agent 活动')
    await card('Agent 活动').click()
    await composer().fill('活动检查')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const status = page.getByRole('status').filter({ hasText: '正在思考…' })
    await status.waitFor()
    await page.locator('.vis-work-block > summary').click()
    const thinking = page.getByRole('button', { name: '思考中', exact: true })
    await thinking.waitFor()
    expect(await thinking.getAttribute('aria-expanded')).toBe('true')
    await page.getByText('最后核对素材。', { exact: false }).waitFor()
    // The two-line preview must show complete glyphs; trailing paragraph margins must not scroll an extra half-line.
    const preview = page.locator('.vis-reasoning-body.is-preview')
    const lines = await preview.evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const rects: { top: number; bottom: number }[] = []
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(walker.currentNode)
        rects.push(...Array.from(range.getClientRects(), rect => ({ top: rect.top, bottom: rect.bottom })))
      }
      return { top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, rects }
    })
    expect(lines.rects).toHaveLength(3)
    expect(lines.rects[1]!.top).toBeGreaterThanOrEqual(lines.top)
    expect(lines.rects[2]!.bottom).toBeLessThanOrEqual(lines.bottom)
    expect(lines.rects[1]!.bottom).toBeLessThanOrEqual(lines.rects[2]!.top)

    const timer = page.getByLabel('本回合用时', { exact: true })
    await expect.poll(() => timer.textContent(), { timeout: 3000 }).toMatch(/^[1-9]\d*s$/)
    expect(await timer.getAttribute('aria-live')).toBe('off')
    expect(await status.textContent()).toBe('正在思考…')
    await page.screenshot({ path: join(artifacts, 'zh-thinking.png') })
    const completed = page.getByRole('button', { name: /^思考了 \d+s$/ })
    await completed.waitFor()
    expect(await completed.getAttribute('aria-expanded')).toBe('false')
    await completed.click()
    expect(await completed.getAttribute('aria-expanded')).toBe('true')
    await page.getByText('先检查画布。', { exact: false }).waitFor()
    const plan = page.getByRole('region', { name: '回合计划', exact: true })
    await plan.getByText('计划 0/2', { exact: true }).waitFor()
    await plan.getByText('计划 1/2', { exact: true }).waitFor()
    expect(await plan.count()).toBe(1)
    await page.getByText('正在调用 读取画布节点与槽位…', { exact: true }).waitFor()
    expect(await page.locator('.vis-agent-activity').count()).toBe(0)
    expect(await page.locator('.vis-work-block-summary [role=status]').textContent()).toContain('读取画布节点与槽位')
    await page.screenshot({ path: join(artifacts, 'zh-tools.png') })
    await page.getByText('活动检查完成', { exact: true }).waitFor()
    await plan.getByText('计划 2/2', { exact: true }).waitFor()
    expect(await plan.getByRole('img', { name: '已完成', exact: true }).count()).toBe(2)
    expect(await completed.getAttribute('aria-expanded')).toBe('true')
    expect(await timer.count()).toBe(0)
    await page.getByText('调用了 读取画布节点与槽位', { exact: true }).waitFor()
    await page.screenshot({ path: join(artifacts, 'zh-conversation.png') })
  })

  it('RFC 0013: after manually expanding reasoning, completion events and later plans preserve expansion', async () => {
    await createWork('手动思考展开')
    await card('手动思考展开').click()
    await composer().fill('活动检查')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.locator('.vis-work-block > summary').click()
    const thinking = page.getByRole('button', { name: '思考中', exact: true })
    await thinking.waitFor()
    await thinking.click()
    expect(await thinking.getAttribute('aria-expanded')).toBe('false')
    await thinking.click()
    expect(await thinking.getAttribute('aria-expanded')).toBe('true')
    const completed = page.getByRole('button', { name: /^思考了 \d+s$/ })
    await completed.waitFor()
    expect(await completed.getAttribute('aria-expanded')).toBe('true')
    await completed.click()
    // The fake agent completes 5 seconds after reasoning ends; allow additional time for event delivery and rendering.
    await expect.poll(() => page.getByText('活动检查完成', { exact: true }).isVisible(), { timeout: 10_000 }).toBe(true)
    expect(await completed.getAttribute('aria-expanded')).toBe('false')
  })

  it('click and Enter open sessions; canvas clicks preserve the panel; returning to the list removes the input', async () => {
    await createWork('会话入口')
    await card('会话入口').click()
    await composer().waitFor()
    await page.getByRole('tab', { name: '画布', exact: true }).click()
    await page.locator('.react-flow__pane').click({ position: { x: 80, y: 80 } })
    expect(await composer().isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: '返回列表' }).isVisible()).toBe(true)
    await back()
    expect(await composer().count()).toBe(0)
    await card('会话入口').focus()
    await page.keyboard.press('Enter')
    await composer().waitFor()
    await page.getByRole('button', { name: '会话入口的更多操作', exact: true }).click()
    await page.getByRole('dialog', { name: '会话入口的操作', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    expect(await page.getByRole('dialog', { name: '会话入口的操作', exact: true }).count()).toBe(0)
    await back()
    // macOS and Linux fire contextmenu on press; the menu must survive the release that follows outside it.
    const box = (await card('会话入口').boundingBox())!
    await page.mouse.move(box.x + 12, box.y + 8)
    await page.mouse.down({ button: 'right' })
    await page.mouse.up({ button: 'right' })
    const contextMenu = page.getByRole('dialog', { name: '会话入口的操作', exact: true })
    await contextMenu.waitFor()
    await page.waitForTimeout(300)
    expect(await contextMenu.isVisible()).toBe(true)
    await page.keyboard.press('Escape')
    expect(await contextMenu.count()).toBe(0)
  })

  it('clicking a todo without a session selects an agent; activation opens the new session', async () => {
    const { item } = await admin.call('work.create', { requestId: rid(), spaceId, title: '待办激活入口', brief: '工作代理检查：{"scenario":"hold"}' })
    await card('待办激活入口').click()
    const dialog = page.getByRole('dialog', { name: '选择 Agent', exact: true })
    await dialog.waitFor()
    await dialog.getByRole('button', { name: 'Codex', exact: true }).click()
    await dialog.getByRole('button', { name: '激活', exact: true }).click()
    await composer().waitFor()
    await page.getByRole('complementary').getByText('待办激活入口', { exact: true }).waitFor()
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await expect.poll(async () => (await work(item.workItemId)).sessions[0]?.activeTurnId, { timeout: 10_000 }).toBeNull()
    await back()
  })

  it('empty input stops the turn, nonempty input queues a message; the collapsed bar shows only running or awaiting-reply items', async () => {
    const running = await createWork('运行入口')
    await card('运行入口').click()
    await composer().fill('工作代理检查：{"scenario":"hold"}')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByRole('button', { name: '停止', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '停止', exact: true }).getAttribute('class')).toBe('vis-send-button is-stop')
    await composer().fill('下一条消息')
    await page.getByText('本回合结束后发出', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '发送', exact: true }).isEnabled()).toBe(true)
    await composer().fill('')
    await page.getByRole('button', { name: '收起会话面板', exact: true }).click()
    expect(await page.getByRole('button', { name: '展开会话：会话入口', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: '展开会话：运行入口', exact: true }).click()
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await expect.poll(async () => (await work(running.workItemId)).sessions[0]?.activeTurnId, { timeout: 10_000 }).toBeNull()
    await page.getByRole('button', { name: '发送', exact: true }).waitFor()
    await composer().fill('暂停后继续')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByText('收到：暂停后继续', { exact: true }).waitFor()
    await expect.poll(async () => (await admin.call('session.list', {})).sessions.find(session => session.sessionId === running.sessions[0]!.sessionId)?.queuePaused).toBe(false)
    await back()
  })

  it('collapsed previews sort by activity, prioritize awaiting replies and open the child main session, and group completed items at the bottom', async () => {
    const parent = await createWork('预览父项')
    const children: WorkItemView[] = []
    for (let i = 0; i < 5; i++) children.push(await createWork(`预览子项 ${i}`, parent.workItemId))
    const waiting = (await admin.call('work.activate', { requestId: rid(), spaceId, workItemId: children[4]!.workItemId, expectedRevision: children[4]!.revision, agentKind: 'codex' })).item as WorkItemView
    const db = new Database(join(dir, 'spaces', spaceId, 'space.db'), { fileMustExist: true })
    try {
      db.prepare('INSERT INTO work_messages (id, work_item_id, kind, "from", "to", body, refs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('panel-question', waiting.workItemId, 'question', JSON.stringify({ kind: 'session', sessionId: waiting.sessions[0]!.sessionId }), 'user', '请选择版本', '{}', Date.now())
      db.prepare("UPDATE work_items SET status = 'done' WHERE id = ?").run(children[0]!.workItemId)
    } finally { db.close() }
    await page.reload()
    await tree().getByRole('button', { name: '5 子工作项（1 已完成）', exact: true }).waitFor()
    const previews = tree().getByRole('list', { name: '预览父项的子工作项', exact: true })
    expect(await previews.getByRole('button').first().getAttribute('aria-label')).toBe('预览子项 4，等你回复')
    await previews.getByRole('button', { name: '预览子项 4，等你回复', exact: true }).click()
    await composer().waitFor()
    await page.getByText('预览子项 4', { exact: true }).waitFor()
    await back()
    await tree().getByRole('button', { name: '还有 1 个', exact: true }).click()
    const childList = tree().getByRole('list', { name: '预览父项的子工作项', exact: true })
    expect(await childList.getByRole('listitem').count()).toBe(4)
    // After expansion, the same position becomes Collapse; click twice to return to preview
    await tree().getByRole('button', { name: '收起', exact: true }).click()
    await childList.getByRole('button', { name: '预览子项 4，等你回复', exact: true }).waitFor()
    expect(await childList.getByRole('listitem').count()).toBe(0)
    await tree().getByRole('button', { name: '5 子工作项（1 已完成）', exact: true }).click()
    expect(await tree().getByRole('button', { name: '5 子工作项（1 已完成）', exact: true }).getAttribute('aria-expanded')).toBe('true')
    await tree().getByRole('button', { name: '5 子工作项（1 已完成）', exact: true }).click()
    expect(await tree().getByRole('button', { name: '5 子工作项（1 已完成）', exact: true }).getAttribute('aria-expanded')).toBe('false')
    // Expansion persists after entering a session and returning
    await tree().getByRole('button', { name: '还有 1 个', exact: true }).click()
    await childList.getByRole('listitem').first().click()
    await composer().waitFor()
    await back()
    expect(await childList.getByRole('listitem').count()).toBe(4)
    await tree().getByRole('button', { name: /^已完成 1/ }).click()
    await tree().getByRole('list', { name: '已完成工作项', exact: true }).getByText('↳ 预览父项', { exact: true }).waitFor()
    await page.screenshot({ path: join(artifacts, 'list.png') })
  })

  it('tabs for the same agent kind are numbered and conversation records stay isolated when switching', async () => {
    const first = await createWork('多 Agent 工作区')
    const second = await admin.call('session.create', { requestId: rid(), title: '第二会话', agentKind: 'codex' })
    const db = new Database(join(dir, 'spaces', spaceId, 'space.db'), { fileMustExist: true })
    try { db.prepare('UPDATE sessions SET work_item_id = ? WHERE id = ?').run(first.workItemId, second.sessionId) } finally { db.close() }
    await page.reload()
    await card('多 Agent 工作区').click()
    expect(await page.getByRole('tablist', { name: 'Agent', exact: true }).locator('svg.vis-agent-icon.is-codex[aria-hidden="true"]').count()).toBe(2)
    expect(await page.getByRole('tab', { name: 'Codex', exact: true }).getAttribute('aria-selected')).toBe('true')
    await composer().fill('第一会话独有内容')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => composer().inputValue()).toBe('')
    await expect.poll(async () => (await work(first.workItemId)).sessions[0]?.activeTurnId, { timeout: 10_000 }).toBeNull()
    await page.getByRole('tab', { name: 'Codex 2', exact: true }).click()
    expect(await composer().inputValue()).toBe('')
    await composer().fill('第二会话独有内容')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByText('第二会话独有内容', { exact: true }).waitFor()
    expect(await page.getByText('第一会话独有内容', { exact: true }).count()).toBe(0)
    await composer().fill('第二会话未发送草稿')
    await page.getByRole('tab', { name: 'Codex', exact: true }).click()
    await page.getByText('第一会话独有内容', { exact: true }).waitFor()
    expect(await page.getByText('第二会话独有内容', { exact: true }).count()).toBe(0)
    expect(await composer().inputValue()).toBe('')
    await page.getByRole('tab', { name: 'Codex 2', exact: true }).click()
    expect(await composer().inputValue()).toBe('第二会话未发送草稿')
    await page.screenshot({ path: join(artifacts, 'session.png') })
    await back()
  })

  it('archived sessions retain tabs and history but disable input; cards open the most recent session when all are archived', async () => {
    const { items } = await admin.call('work.list', { spaceId })
    const item = items.find((item: WorkItemView) => item.title === '多 Agent 工作区') as WorkItemView
    await expect.poll(async () => (await work(item.workItemId)).sessions.every(session => !session.activeTurnId), { timeout: 10_000 }).toBe(true)
    const sessionId = item.sessions[1]!.sessionId
    let queuedMessageId = ''
    const db = new Database(join(dir, 'spaces', spaceId, 'space.db'), { fileMustExist: true })
    try {
      db.prepare('UPDATE sessions SET queue_paused = 1 WHERE id = ?').run(sessionId)
      // The full suite may exhaust execution slots; the previous case only checks record isolation, so withdraw its leftover user drafts first.
      await admin.call('session.clearQueue', { requestId: rid(), sessionId })
      expect((await admin.call('session.list', {})).sessions.find(session => session.sessionId === sessionId)).toMatchObject({ queuePaused: true, queuedMessageCount: 0 })
      const queued = await admin.call('session.sendMessage', { requestId: rid(), sessionId, text: '归档前排队消息', refs: [] })
      expect(queued.deliveryState).toBe('draft')
      queuedMessageId = queued.messageId
      expect(db.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?').run(Date.now(), sessionId).changes).toBe(1)
    } finally { db.close() }
    await page.reload()
    await card(item.title).click()
    await page.getByRole('tab', { name: 'Codex 2 · 已归档', exact: true }).click()
    await page.getByText('第二会话独有内容', { exact: true }).waitFor()
    expect(await composer().isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: '发送', exact: true }).isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: 'Skill', exact: true }).isDisabled()).toBe(true)
    const header = page.locator('.vis-session-heading')
    await header.getByText('1 条消息未发送，因为工作已结束', { exact: true }).waitFor()
    await page.getByText('未发送：工作已结束', { exact: true }).waitFor()
    expect(await header.getByRole('button', { name: '重开工作并发送', exact: true }).isEnabled()).toBe(true)
    expect(await header.getByRole('button', { name: '清空', exact: true }).isEnabled()).toBe(true)
    mkdirSync('/tmp/vis-round2', { recursive: true })
    await page.screenshot({ path: '/tmp/vis-round2/stranded-message.png', animations: 'disabled' })
    expect((await admin.call('session.list', { includeArchived: true })).sessions.find(session => session.sessionId === sessionId)).toMatchObject({ queuePaused: true, queuedMessageCount: 1, activeTurnId: null })
    const archiveAll = new Database(join(dir, 'spaces', spaceId, 'space.db'), { fileMustExist: true })
    try {
      expect(archiveAll.prepare('SELECT delivery_state FROM messages WHERE id = ?').get(queuedMessageId).delivery_state).toBe('draft')
      archiveAll.prepare('UPDATE sessions SET archived_at = ? WHERE work_item_id = ?').run(Date.now(), item.workItemId)
    } finally { archiveAll.close() }
    page.once('dialog', dialog => dialog.accept())
    await header.getByRole('button', { name: '清空', exact: true }).click()
    await expect.poll(async () => (await admin.call('session.list', { includeArchived: true })).sessions.find(session => session.sessionId === sessionId)?.queuedMessageCount).toBe(0)
    await page.reload()
    await card(item.title).click()
    await expect.poll(() => page.getByRole('tab', { name: 'Codex 2 · 已归档', exact: true }).getAttribute('aria-selected')).toBe('true')
    expect(await composer().isDisabled()).toBe(true)
  })

  it('reopens ended work and sends its retained draft without interrupting the running turn', async () => {
    await admin.call('work.setSlotLimit', { limit: 32 })
    const item = await createTemporaryWork('恢复未发送消息')
    const sessionId = item.sessions[0]!.sessionId
    await page.reload(); await card(item.title).click()
    await composer().fill('慢')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(async () => (await work(item.workItemId)).sessions[0]?.activeTurnId, { timeout: 10_000 }).not.toBeNull()
    await composer().fill('请保留并发送这条消息')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByText('请保留并发送这条消息', { exact: true }).waitFor()
    await admin.call('work.move', { requestId: rid(), spaceId, workItemId: item.workItemId, status: 'done' })
    await page.getByText('未发送：工作已结束', { exact: true }).waitFor()
    await page.getByRole('button', { name: '重开工作并发送', exact: true }).click()
    await expect.poll(async () => (await work(item.workItemId)).status).toBe('in_progress')
    await expect.poll(() => {
      const db = new Database(join(dir, 'spaces', spaceId, 'space.db'), { fileMustExist: true })
      try { return db.prepare('SELECT delivery_state FROM messages WHERE session_id = ? AND text = ?').get(sessionId, '请保留并发送这条消息')?.delivery_state }
      finally { db.close() }
    }, { timeout: 15_000 }).toBe('delivered')
    await page.getByText('收到：请保留并发送这条消息', { exact: true }).waitFor()
    await admin.call('work.setSlotLimit', { limit: 6 })
  })

  it('shows all long user and Agent messages without a fold or clipped text', async () => {
    const item = await createTemporaryWork('完整长消息')
    const user = 'Long user message.\n'.repeat(30) + 'Last user line'
    const assistant = '**A full Agent reply**\n\n' + 'Long reply paragraph.\n\n'.repeat(30) + 'Last Agent line'
    const db = new Database(join(dir, 'spaces', spaceId, 'space.db'), { fileMustExist: true })
    try {
      const insert = db.prepare('INSERT INTO transcript_entries (session_id, item_id, created_seq, revision, kind, payload, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
      insert.run(item.sessions[0]!.sessionId, 'long-user', -2, 'user', JSON.stringify({ text: user }), Date.now(), Date.now())
      insert.run(item.sessions[0]!.sessionId, 'long-agent', -1, 'assistant_text', JSON.stringify({ text: assistant }), Date.now(), Date.now())
    } finally { db.close() }
    await page.reload(); await card(item.title).click()
    const userText = page.locator('.vis-user-text').filter({ hasText: 'Last user line' })
    const agentText = page.locator('.vis-message-markdown').filter({ hasText: 'Last Agent line' })
    for (const content of [userText, agentText]) {
      await content.waitFor()
      const size = await content.evaluate(element => ({ height: element.clientHeight, full: element.scrollHeight, max: getComputedStyle(element).maxHeight, mask: getComputedStyle(element).maskImage }))
      expect(size.height).toBeGreaterThan(400)
      expect(size.height).toBe(size.full)
      expect(size.max).toBe('none')
      expect(size.mask).toBe('none')
    }
    expect(await page.getByRole('button', { name: /展开长消息|收起长消息/ }).count()).toBe(0)
  })

  it('late session loads do not pull users back into a session after returning to the list', async () => {
    const item = await createWork('延迟会话')
    const sessionId = item.sessions[0]!.sessionId
    const delayedPage = await browser.newPage({ locale: 'zh-CN' })
    let release: (() => void) | undefined
    await delayedPage.routeWebSocket(/.*/, socket => {
      const server = socket.connectToServer()
      const methods = new Map<number, string>()
      socket.onMessage(message => {
        const request = JSON.parse(String(message))
        methods.set(request.id, request.method)
        server.send(message)
      })
      server.onMessage(message => {
        const response = JSON.parse(String(message))
        if (response.result?.snapshot?.sessions) response.result.snapshot.sessions = response.result.snapshot.sessions.filter((session: { sessionId: string }) => session.sessionId !== sessionId)
        if (methods.get(response.id) === 'session.list') release = () => socket.send(JSON.stringify(response))
        else socket.send(JSON.stringify(response))
      })
    })
    try {
      await delayedPage.goto(webUrl)
      await delayedPage.getByRole('listitem', { name: /^延迟会话，/ }).click()
      await expect.poll(() => !!release).toBe(true)
      await delayedPage.getByRole('button', { name: '返回列表', exact: true }).click()
      release!()
      // Wait for the message callback and its React commit instead of a fixed number of milliseconds.
      await delayedPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      expect(await delayedPage.getByRole('region', { name: '工作区', exact: true }).isVisible()).toBe(true)
      expect(await delayedPage.getByRole('button', { name: '返回列表', exact: true }).count()).toBe(0)
    } finally { await delayedPage.close() }
  })

})
