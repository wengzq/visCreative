import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { chromePath, removeTempDir } from './platform'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
// Real studiod, web host, and English Chrome; uses only temporary data and local fake Codex.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SpaceSummary, WorkItemView } from '@vis/protocol'
import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const CHROME = chromePath()
const ready = existsSync(CHROME) && existsSync(join(root, 'services/studiod/dist/studiod.mjs')) && existsSync(join(root, 'apps/web/dist/vis-web.mjs'))
const artifacts = join(tmpdir(), 'vis-0018-locale')
const processes: ChildProcess[] = []
const pageErrors: string[] = []
// english-exempt: Seeded user message must stay Chinese to verify locale changes preserve user content.
const userData = { project: '用户的中文项目', work: '用户的中文工作区', node: '这段节点内容保持中文', category: '用户类别', message: '这段用户消息保持中文' }
let dir: string
let projectsDir: string
let browser: Browser
let page: Page
let admin: StudiodLink
let webUrl: string
let project: SpaceSummary
let work: WorkItemView
let sequence = 0
const rid = () => `locale-e2e-${++sequence}`

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

async function screenshot(name: string) {
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(artifacts, name), animations: 'disabled' })
}

async function expectEnglishUI(surface: string) {
  // Exempt only explicitly seeded user data; buttons containing that data still have their remaining UI copy checked.
  const projects = (await admin.call('space.list')).spaces as SpaceSummary[]
  const ignored = [`收到：${userData.message}`, ...Object.values(userData), ...projects.map(project => project.name)].filter(Boolean).sort((a, b) => b.length - a.length)
  const chinese = await page.evaluate(ignored => {
    const found: string[] = []
    const check = (value: string, source: string) => {
      const ui = ignored.reduce((text, data) => text.replaceAll(data, ''), value)
      if (/\p{Script=Han}/u.test(ui)) found.push(`${source}: ${value}`)
    }
    for (const element of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
      for (const attribute of ['aria-label', 'title', 'placeholder']) {
        const value = element.getAttribute(attribute)
        if (value) check(value, `${element.tagName.toLowerCase()}[${attribute}]`)
      }
    }
    for (const option of document.querySelectorAll('option')) check(option.textContent ?? '', 'option')
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const element = node.parentElement
      if (!element || element.closest('script, style, option')) continue
      const style = getComputedStyle(element)
      if (style.visibility !== 'visible' || style.opacity === '0') continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = range.getBoundingClientRect()
      if (rect.width && rect.height && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth) check(node.textContent ?? '', element.tagName.toLowerCase())
    }
    return found
  }, ignored)
  expect(chinese, `${surface} 含有未翻译的界面文案`).toEqual([])
}

async function openGeneral(chinese = false) {
  await page.getByRole('button', { name: chinese ? '设置' : 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: chinese ? '设置' : 'Settings', exact: true })
  await settings.getByRole('button', { name: chinese ? '语言' : 'Language', exact: true }).click()
  return settings
}

describe.skipIf(!ready)('RFC 0018 UI language', () => {
  beforeAll(async () => {
    mkdirSync(artifacts, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-locale-data-'))
    projectsDir = mkdtempSync(join(tmpdir(), 'vis-locale-projects-'))
    const env = {
      VIS_DATA_DIR: dir, VIS_PROJECTS_DIR: projectsDir,
      VIS_CLI_BIN_DIR: join(root, 'apps/cli/dist'), VIS_CODEX_PATH: join(root, 'apps/web/e2e/fake-codex.mjs'),
    }
    await start(join(root, 'services/studiod/dist/studiod.mjs'), env, /\[studiod\] Started /)
    webUrl = await start(join(root, 'apps/web/dist/vis-web.mjs'), env, /(http:\/\/127\.0\.0\.1:\d+\/#t=\S+)/)
    admin = await openStudiodLink({ socketPath: studiodEndpoint(dir), tokenPath: join(dir, 'run/studiod.token') })
    project = await admin.call('space.create', { requestId: rid(), name: userData.project, rootPath: join(projectsDir, 'project') })
    work = (await admin.call('work.create', { requestId: rid(), spaceId: project.spaceId, title: userData.work, chat: { agentKind: 'codex' } })).item
    await admin.call('events.subscribe', { spaceId: project.spaceId })
    await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'text', kind: 'text', x: 0, y: 0, w: 360, h: 200, category: userData.category, content: { text: userData.node } }] })
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => pageErrors.push(error.stack ?? error.message))
    await page.goto(webUrl)
    await page.getByRole('button', { name: 'Switch project', exact: true }).click()
    await page.getByRole('menu').getByRole('menuitem').filter({ has: page.getByText(userData.project, { exact: true }) }).click()
    await page.getByText(userData.node, { exact: true }).waitFor()
  }, 30_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await screenshot(`failure-${task.name.replace(/[^\p{L}\p{N}]+/gu, '-')}.png`)
    await page?.keyboard.press('Escape')
    expect(pageErrors).toEqual([])
  })

  afterAll(async () => {
    admin?.close()
    await browser?.close()
    for (const proc of processes) proc.kill('SIGINT')
    await Promise.all(processes.map(proc => proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => proc.once('exit', () => resolve()))))
    removeTempDir(dir)
    removeTempDir(projectsDir)
  }, 30_000)

  it('English browsers default to English; all three language settings apply immediately and persist across refresh', async () => {
    expect(await page.locator('html').getAttribute('lang')).toBe('en')
    expect(await page.title()).not.toMatch(/\p{Script=Han}/u)
    expect(await admin.call('preferences.get')).toEqual({ locale: null })
    await openGeneral()
    expect(await page.getByRole('combobox', { name: 'Language', exact: true }).inputValue()).toBe('system')
    await expectEnglishUI('英文通用设置')
    await screenshot('en-settings.png')
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN')
    await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('zh-CN')
    await page.getByRole('combobox', { name: '语言', exact: true }).waitFor()
    await expect.poll(() => admin.call('preferences.get')).toEqual({ locale: 'zh-CN' })
    await screenshot('zh-settings.png')
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await screenshot('zh-canvas.png')
    await page.evaluate(() => localStorage.setItem('vis.locale', 'en'))
    await page.reload()
    await page.getByRole('button', { name: '设置', exact: true }).waitFor()
    expect(await page.locator('html').getAttribute('lang')).toBe('zh-CN')
    await openGeneral(true)
    expect(await page.getByRole('combobox', { name: '语言', exact: true }).inputValue()).toBe('zh-CN')
    await page.getByRole('combobox', { name: '语言', exact: true }).selectOption('en')
    await page.getByRole('combobox', { name: 'Language', exact: true }).waitFor()
    await expect.poll(() => admin.call('preferences.get')).toEqual({ locale: 'en' })
    await page.reload()
    await openGeneral()
    expect(await page.getByRole('combobox', { name: 'Language', exact: true }).inputValue()).toBe('en')
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('system')
    await expect.poll(() => admin.call('preferences.get')).toEqual({ locale: null })
    expect(await page.locator('html').getAttribute('lang')).toBe('en')
    await page.reload()
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
    expect(await page.locator('html').getAttribute('lang')).toBe('en')
    await page.getByText(userData.node, { exact: true }).waitFor()
    await screenshot('en-canvas.png')
  }, 40_000)

  it('canvas, sessions, board, settings, and Skill management have no Chinese UI copy while user data stays unchanged', async () => {
    await page.getByText(userData.node, { exact: true }).click()
    await expectEnglishUI('画布')
    await page.getByRole('listitem').filter({ has: page.getByText(userData.work, { exact: true }) }).click()
    const composer = page.getByRole('textbox', { name: 'Message the Agent', exact: true })
    await page.getByRole('button', { name: 'Split this storyboard into three shots', exact: true }).waitFor()
    mkdirSync(join(tmpdir(), 'vis-0019-workbench'), { recursive: true })
    await page.screenshot({ path: join(tmpdir(), 'vis-0019-workbench/en-empty.png') })
    await composer.fill(userData.message)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByText(`收到：${userData.message}`, { exact: true }).waitFor()
    await expect.poll(async () => (await admin.call('session.list', { spaceId: project.spaceId })).sessions.find((session: { sessionId: string }) => session.sessionId === work.sessions[0]!.sessionId)?.activeTurnId).toBeNull()
    await expectEnglishUI('会话')
    await screenshot('en-session.png')
    await page.screenshot({ path: join(tmpdir(), 'vis-0019-workbench/en-session.png') })
    await page.getByRole('button', { name: 'Skill', exact: true }).click()
    await page.getByRole('button', { name: 'Manage', exact: true }).click()
    await page.getByRole('dialog', { name: 'Project skills', exact: true }).waitFor()
    await expectEnglishUI('Skill 管理')
    await screenshot('en-skills.png')
    await page.screenshot({ path: join(tmpdir(), 'vis-0019-workbench/en-skills.png') })
    await page.getByRole('dialog', { name: 'Project skills', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('tab', { name: 'Board', exact: true }).click()
    await expectEnglishUI('工作看板')
    await screenshot('en-board.png')
    await page.screenshot({ path: join(tmpdir(), 'vis-0019-workbench/en-board.png') })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await expectEnglishUI('生成服务设置')
    for (const section of ['Language', 'Safety and limits', 'Recently deleted']) {
      await settings.getByRole('button', { name: section, exact: true }).click()
      await expectEnglishUI(`${section} 设置`)
    }
    await settings.getByRole('button', { name: 'Close settings', exact: true }).click()
    const node = (await admin.call('canvas.get')).nodes.find((entry: { kind: string }) => entry.kind === 'text')
    expect(node).toMatchObject({ category: userData.category, slots: [{ content: { type: 'text', body: userData.node } }] })
    expect((await admin.call('work.get', { spaceId: project.spaceId, workItemId: work.workItemId })).item.title).toBe(userData.work)
    const transcript = await admin.call('session.getTranscript', { sessionId: work.sessions[0]!.sessionId })
    expect(transcript.items.find((entry: { kind: string }) => entry.kind === 'user')?.payload).toMatchObject({ text: userData.message })
  }, 40_000)

  it('a corrupt Skill archive backend reason travels through upload and displays in English in the English UI', async () => {
    await page.getByRole('tab', { name: 'Canvas', exact: true }).click()
    await page.getByRole('button', { name: 'Skill', exact: true }).click()
    await page.getByRole('button', { name: 'Manage', exact: true }).click()
    const manager = page.getByRole('dialog', { name: 'Project skills', exact: true })
    const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === '/upload')
    await manager.getByLabel('Skill archive', { exact: true }).setInputFiles({ name: 'broken.skill', mimeType: 'application/zip', buffer: Buffer.from('not an archive') })
    const response = await uploaded
    expect(response.status()).toBe(400)
    expect((await response.json()).error.data).toMatchObject({ code: 'invalid_params', reason: 'skill.zip.end_record' })
    const alert = manager.getByRole('alert')
    await alert.waitFor()
    expect(await alert.textContent()).toMatch(/zip/i)
    expect(await alert.textContent()).not.toMatch(/\p{Script=Han}/u)
    await expectEnglishUI('Skill 后台错误')
    await manager.getByRole('button', { name: 'Close', exact: true }).click()
  })

  it('temporarily unavailable preferences silently follow the browser, overriding a stale cached language', async () => {
    const fallback = await browser.newPage({ locale: 'en-US' })
    let read = false
    try {
      await fallback.addInitScript(() => localStorage.setItem('vis.locale', 'zh-CN'))
      await fallback.routeWebSocket('**', socket => {
        const server = socket.connectToServer()
        socket.onMessage(message => {
          const request = JSON.parse(String(message))
          if (request.method === 'preferences.get') {
            read = true
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Temporarily unavailable', data: { code: 'unavailable' } } }))
          } else server.send(message)
        })
      })
      await fallback.goto(webUrl)
      await fallback.getByRole('button', { name: 'Settings', exact: true }).waitFor()
      expect(read).toBe(true)
      expect(await fallback.locator('html').getAttribute('lang')).toBe('en')
      expect(await fallback.getByRole('alert').count()).toBe(0)
      await expect.poll(() => fallback.evaluate(() => localStorage.getItem('vis.locale'))).toBe('en')
    } finally { await fallback.close() }
  })

  it('failed language saves restore the original language and selection; refresh still follows the English browser', async () => {
    let rejectSave: (() => void) | undefined
    await page.routeWebSocket('**', socket => {
      const server = socket.connectToServer()
      socket.onMessage(message => {
        const request = JSON.parse(String(message))
        if (request.method === 'preferences.set') {
          // english-exempt: Chinese backend diagnostic fixture verifies English fallback after a failed locale save.
          rejectSave = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: '保存语言设置失败', data: { code: 'unavailable' } } }))
        } else server.send(message)
      })
    })
    await page.reload()
    const settings = await openGeneral()
    await settings.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN')
    await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('zh-CN')
    const pendingSettings = page.getByRole('dialog', { name: '设置', exact: true })
    expect(await pendingSettings.getByRole('combobox', { name: '语言', exact: true }).isDisabled()).toBe(true)
    expect(await pendingSettings.getByRole('button', { name: '关闭设置', exact: true }).isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
    expect(await pendingSettings.isVisible()).toBe(true)
    await expect.poll(() => Boolean(rejectSave)).toBe(true)
    rejectSave!()
    await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('en')
    await settings.getByRole('alert').waitFor()
    expect(await settings.getByRole('combobox', { name: 'Language', exact: true }).inputValue()).toBe('system')
    expect(await settings.getByRole('alert').textContent()).toContain('Temporarily unavailable')
    expect(await admin.call('preferences.get')).toEqual({ locale: null })
    expect(await page.evaluate(() => localStorage.getItem('vis.locale'))).toBe('en')
    await expectEnglishUI('保存语言失败')
    await page.reload()
    await openGeneral()
    expect(await page.getByRole('combobox', { name: 'Language', exact: true }).inputValue()).toBe('system')
    expect(await page.locator('html').getAttribute('lang')).toBe('en')
  })
})
