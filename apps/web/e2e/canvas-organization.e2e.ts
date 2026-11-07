import { chromePath, removeTempDir } from './platform'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
// Real studiod + web host + Chrome; uses only isolated projects and local HTML rendering, without agents or paid services.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockProvider, createRenderProvider } from '../../../packages/generation/src/index'
import type { CanvasOp, NodeView } from '../../../packages/protocol/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const CHROME = chromePath()
const ready = existsSync(CHROME) && existsSync(join(root, 'apps/web/dist/client/index.html'))

let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page

/** Fit-to-canvas animates for 300ms: wait for the viewport to stop before interacting, or right-clicks and drags will hit moving nodes */
async function fitCanvas() {
  await page.getByRole('button', { name: '适应画布', exact: true }).click()
  const viewport = page.locator('.react-flow__viewport')
  let last = ''
  await expect.poll(async () => {
    const now = await viewport.evaluate(el => getComputedStyle(el).transform)
    const settled = now === last
    last = now
    return settled
  }, { intervals: [100], timeout: 5_000 }).toBe(true)
}
const pageErrors: string[] = []
const nodes = async () => (await admin.call('canvas.get')).nodes as NodeView[]
const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`)
const menu = () => page.getByRole('menu', { name: '画布右键菜单', exact: true })
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const layout = (items: NodeView[]) => items.map(({ nodeId, x, y, w, h }) => ({ nodeId, x, y, w, h })).sort((a, b) => a.nodeId.localeCompare(b.nodeId))

async function drag(id: string, dx: number, dy: number) {
  const label = (await node(id).locator('.vis-node-label').boundingBox())!
  await page.mouse.move(label.x + 20, label.y + 8)
  await page.mouse.down()
  await page.mouse.move(label.x + 20 + dx, label.y + 8 + dy, { steps: 12 })
  await page.mouse.up()
}

describe.skipIf(!ready)('Canvas organization and content purpose', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-s16-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 }), createRenderProvider({ workDir: join(dir, 'render'), chromePath: CHROME, libs: {} })],
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    })
    const { spaceId } = studiod.spaces.create('画布整理与内容用途')
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
  })

  beforeEach(async () => {
    const existing = await nodes()
    if (existing.length) await apply(existing.map(item => ({ op: 'node.delete', nodeId: item.nodeId })))
    pageErrors.length = 0
    // Use separate browser preferences per test so the work-document toggle does not affect default-hidden assertions.
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(host.url)
    await page.waitForSelector('.react-flow__pane')
    await page.evaluate(() => document.fonts.ready)
  })

  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(tmpdir(), 'vis-s16-organization-failure.png'), animations: 'disabled' })
      expect(pageErrors).toEqual([])
    } finally {
      await page?.close()
    }
  })

  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await studiod?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('previews optional empty-frame removal and undoes it with member placement in one batch', async () => {
    const result = await apply([
      { op: 'frame.create', tempId: 'old', title: '旧框', x: 0, y: 0, w: 800, h: 600 },
      { op: 'frame.create', tempId: 'empty', title: '原本空框', x: 1200, y: 0, w: 800, h: 600 },
      { op: 'node.create', tempId: 'member', kind: 'text', category: '文案', content: { text: '保留的完整内容' }, x: 80, y: 100 },
    ])
    const before = await nodes()
    const member = before.find(item => item.nodeId === result.idMap.member)!
    expect(member.frameId).toBe(result.idMap.old)
    await page.getByRole('button', { name: '整理', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '整理画布', exact: true })
    const checkbox = dialog.getByRole('checkbox', { name: /移除整理后为空的框/ })
    expect(await checkbox.isChecked()).toBe(true)
    await dialog.getByText('旧框', { exact: true }).waitFor()
    await dialog.getByText('原本空框', { exact: true }).waitFor()
    mkdirSync('/tmp/vis-round2', { recursive: true })
    await page.screenshot({ path: '/tmp/vis-round2/tidy-preview.png', animations: 'disabled' })
    await checkbox.uncheck()
    await dialog.getByRole('button', { name: '确认整理', exact: true }).click()
    await expect.poll(async () => (await nodes()).length).toBe(4)
    expect((await nodes()).some(item => item.nodeId === result.idMap.old)).toBe(true)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(async () => layout(await nodes())).toEqual(layout(before))
    await page.getByRole('button', { name: '整理', exact: true }).click()
    expect(await checkbox.isChecked()).toBe(true)
    await dialog.getByRole('button', { name: '确认整理', exact: true }).click()
    await expect.poll(async () => (await nodes()).map(item => item.nodeId).filter(id => id === result.idMap.old || id === result.idMap.empty)).toEqual([])
    expect((await nodes()).find(item => item.nodeId === member.nodeId)?.slots).toEqual(member.slots)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(async () => layout(await nodes())).toEqual(layout(before))
    expect((await nodes()).find(item => item.nodeId === member.nodeId)?.frameId).toBe(result.idMap.old)
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect.poll(async () => (await nodes()).length).toBe(2)
    expect((await nodes()).find(item => item.nodeId === member.nodeId)?.slots).toEqual(member.slots)
  })

  it('keeps text node dimensions and full editing content when zooming out and back', async () => {
    const body = '# Detail heading\n\n**Full Markdown content** ' + 'A readable canvas sentence. '.repeat(12)
    await apply([{ op: 'node.create', tempId: 'detail', kind: 'text', x: 100, y: 100, w: 320, h: 240, content: { text: body } }])
    const original = (await nodes())[0]!
    const card = node(original.nodeId)
    await card.locator('.vis-node-markdown strong').waitFor()
    expect(await card.locator('.vis-node-markdown strong').textContent()).toBe('Full Markdown content')
    const dimensions = () => card.evaluate(element => ({ w: (element as HTMLElement).offsetWidth, h: (element as HTMLElement).offsetHeight }))
    const initial = await dimensions()
    const settle = async () => {
      let previous = ''
      await expect.poll(async () => {
        const current = await page.locator('.react-flow__viewport').getAttribute('style')
        const settled = current === previous
        previous = current ?? ''
        return settled
      }, { intervals: [100] }).toBe(true)
    }
    for (let i = 0; i < 8 && !await card.locator('.vis-node-text-summary').count(); i++) {
      await page.getByRole('button', { name: '缩小画布', exact: true }).click()
      await settle()
    }
    await card.locator('.vis-node-text-summary').waitFor()
    expect(await card.locator('.vis-node-markdown strong').count()).toBe(0)
    expect(await dimensions()).toEqual(initial)
    await card.locator('.vis-node-text-summary').dblclick()
    const editor = card.getByRole('textbox', { name: '文本内容', exact: true })
    expect(await editor.inputValue()).toBe(body)
    await editor.press('Escape')
    await page.getByRole('button', { name: '重置缩放', exact: true }).click()
    await card.locator('.vis-node-markdown strong').waitFor()
    expect(await card.locator('.vis-node-markdown strong').textContent()).toBe('Full Markdown content')
    expect(await dimensions()).toEqual(initial)
    const restored = (await nodes())[0]!
    expect(layout([restored])).toEqual(layout([original]))
    expect(restored.layoutRevision).toBe(original.layoutRevision)
  })

  it('0020: unified dialog backdrops, settings groups, and safety/quota entry', async () => {
    const shots = join(tmpdir(), 'vis-0020-web')
    mkdirSync(shots, { recursive: true })
    const backdrop = () => page.locator('dialog:modal').evaluate(dialog => getComputedStyle(dialog, '::backdrop').backgroundColor)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    const color = await backdrop()
    expect(color).toBe('rgba(0, 0, 0, 0.55)')
    const navigation = settings.getByRole('navigation', { name: '生成服务', exact: true })
    for (const group of ['通用', '生成服务', '数据']) {
      expect(await navigation.getByRole('heading', { name: group, exact: true }).count()).toBe(1)
    }
    // Safety and quotas has only one item; merge it into General instead of a separate group
    expect(await navigation.getByRole('heading', { name: '安全与额度', exact: true }).count()).toBe(0)
    await page.screenshot({ path: `${shots}/settings-providers.png`, animations: 'disabled' })
    for (const [section, shot] of [['语言', 'language'], ['外观', 'appearance'], ['安全与额度', 'limits'], ['最近删除', 'deleted']]) {
      await navigation.getByRole('button', { name: section, exact: true }).click()
      if (section === '外观') await settings.getByText('亮色主题以后提供', { exact: true }).waitFor()
      if (section === '安全与额度') await settings.getByLabel('最大并发任务数', { exact: true }).waitFor()
      await page.screenshot({ path: `${shots}/settings-${shot}.png`, animations: 'disabled' })
    }
    await navigation.getByRole('button', { name: '安全与额度', exact: true }).click()
    await settings.getByLabel('最大并发任务数', { exact: true }).fill('4')
    await page.mouse.click(4, 4)
    expect(await settings.isVisible()).toBe(true)
    page.once('dialog', dialog => void dialog.accept())
    await settings.getByRole('button', { name: '关闭设置', exact: true }).click()
    await page.getByRole('button', { name: '画布快捷键', exact: true }).click()
    expect(await backdrop()).toBe(color)
    await page.screenshot({ path: `${shots}/shortcuts.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '切换项目', exact: true }).click()
    await page.getByRole('menuitem', { name: '＋ 新建项目', exact: true }).click()
    expect(await backdrop()).toBe(color)
    await page.screenshot({ path: `${shots}/new-project.png`, animations: 'disabled' })
    const project = page.getByRole('dialog', { name: '新建项目', exact: true })
    await page.mouse.click(5, 5)
    await project.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '切换项目', exact: true }).click()
    await page.getByRole('menuitem', { name: '＋ 新建项目', exact: true }).click()
    await project.getByRole('textbox', { name: '项目名称', exact: true }).fill('保留未保存输入')
    await page.mouse.click(5, 5)
    expect(await project.isVisible()).toBe(true)
    expect(await project.getByRole('textbox', { name: '项目名称', exact: true }).inputValue()).toBe('保留未保存输入')
    await page.keyboard.press('Escape')
    expect(await page.locator('dialog:modal').count()).toBe(0)
  })

  it('0020: daily usage and inbox have no backdrop and close on Esc or outside clicks', async () => {
    const shots = join(tmpdir(), 'vis-0020-web')
    mkdirSync(shots, { recursive: true })
    for (const [name, title, shot] of [
      ['今日用量（全部项目）', '今日用量（全部项目）', 'usage'],
      [/收件箱，/, '收件箱', 'inbox'],
    ] as const) {
      const trigger = page.getByRole('button', { name, exact: typeof name === 'string' })
      await trigger.click()
      const panel = page.getByRole('dialog', { name: title, exact: true })
      await panel.waitFor()
      expect(await page.locator('dialog:modal').count()).toBe(0)
      await page.screenshot({ path: `${shots}/${shot}.png`, animations: 'disabled' })
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'hidden' })
      await trigger.click()
      await panel.waitFor()
      await page.getByRole('tab', { name: '画布', exact: true }).click()
      await panel.waitFor({ state: 'hidden' })
    }
  })

  it('0020: video nodes, version bars, and lightboxes share play and close icons', async () => {
    const shots = join(tmpdir(), 'vis-0020-web')
    mkdirSync(shots, { recursive: true })
    await apply([
      { op: 'node.create', tempId: 'image', kind: 'image', x: 0, y: 0, w: 320, h: 240 },
      { op: 'node.create', tempId: 'video', kind: 'video', x: 380, y: 0, w: 320, h: 240 },
    ])
    for (const item of await nodes()) {
      for (let version = 0; version < 2; version++) {
        const job = await admin.call('generation.submit', {
          requestId: crypto.randomUUID(), kind: item.kind, provider: 'mock', prompt: `媒体版本 ${version}`,
          targets: [{ outputIndex: 0, kind: 'slot', slotId: item.slots.find(slot => slot.slotKey === 'main')!.slotId }],
        })
        await expect.poll(async () => (await admin.call('generation.get', { jobId: job.jobId })).status, { timeout: 10_000 }).toBe('succeeded')
      }
    }
    await fitCanvas()
    const video = (await nodes()).find(item => item.kind === 'video')!
    await node(video.nodeId).locator('.vis-node-label').click()
    await page.getByRole('group', { name: '历史版本', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '播放', exact: true }).locator('svg').count()).toBeGreaterThan(0)
    await page.screenshot({ path: `${shots}/canvas-video-versions.png`, animations: 'disabled' })
    await node(video.nodeId).locator('.vis-node-label').click()
    await page.keyboard.press('Space')
    await page.getByRole('button', { name: '关闭预览', exact: true }).waitFor()
    await page.screenshot({ path: `${shots}/lightbox-video.png`, animations: 'disabled' })
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()
  }, 30_000)

  it('0020: square nodes automatically adjust height after generating a widescreen mock image', async () => {
    // Mock defaults to square; explicit parameters make the output ratio differ from the initial node ratio.
    const { idMap } = await apply([{ op: 'node.create', tempId: 'wide', kind: 'image', x: 0, y: 0, w: 320, h: 320 }])
    const before = (await nodes()).find(item => item.nodeId === idMap.wide)!
    const media = node(before.nodeId)
    await media.waitFor()
    expect(await media.evaluate(el => el.getBoundingClientRect().width / el.getBoundingClientRect().height)).toBeCloseTo(1, 1)
    const job = await admin.call('generation.submit', {
      requestId: crypto.randomUUID(), kind: 'image', provider: 'mock', prompt: '宽屏测试', params: { width: 640, height: 360 },
      targets: [{ outputIndex: 0, kind: 'slot', slotId: before.slots.find(slot => slot.slotKey === 'main')!.slotId }],
    })
    await expect.poll(async () => (await admin.call('generation.get', { jobId: job.jobId })).status, { timeout: 10_000 }).toBe('succeeded')
    await expect.poll(async () => (await nodes()).find(item => item.nodeId === before.nodeId)?.h, { timeout: 10_000 }).toBe(180)
    await expect.poll(() => media.evaluate(el => el.getBoundingClientRect().width / el.getBoundingClientRect().height), { timeout: 10_000 }).toBeCloseTo(640 / 360, 1)
  })

  it('empty-canvas shortcuts appear, disappear, and reappear with content; the full panel supports question mark and restores focus on Esc', async () => {
    const emptyTitle = page.getByText('画布快捷键', { exact: true })
    await emptyTitle.waitFor()
    await page.getByRole('button', { name: '文本', exact: true }).click()
    await expect.poll(nodes).toHaveLength(1)
    const [created] = await nodes()
    await node(created!.nodeId).waitFor()
    await expect.poll(() => emptyTitle.count()).toBe(0)
    await node(created!.nodeId).locator('.vis-node-label').click()
    await page.keyboard.press('Delete')
    await expect.poll(nodes).toHaveLength(0)
    await emptyTitle.waitFor()

    const shortcuts = page.getByRole('dialog', { name: '画布快捷键', exact: true })
    await page.getByRole('button', { name: '画布快捷键', exact: true }).click()
    await shortcuts.waitFor()
    for (const group of ['画布', '节点', '会话', '视图']) await shortcuts.getByText(group, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await shortcuts.waitFor({ state: 'hidden' })
    expect(await page.locator('.vis-canvas-wrap').evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('?')
    await shortcuts.waitFor()
    await page.keyboard.press('Escape')
    await shortcuts.waitFor({ state: 'hidden' })
    await page.keyboard.press('ControlOrMeta+Shift+B')
    await page.keyboard.press('?')
    expect(await page.locator('dialog[open]').count()).toBe(0)
    await page.keyboard.press('ControlOrMeta+Shift+B')

    await page.getByRole('button', { name: '文本', exact: true }).click()
    await page.locator('.vis-node-text-body').dblclick()
    await page.locator('.vis-node-text textarea').press('?')
    expect(await shortcuts.isVisible()).toBe(false)
    expect(await page.locator('.vis-node-text textarea').inputValue()).toBe('?')
  })

  it('safe Markdown rendering, source editing, node decluttering, and media aspect adjustments are undoable', async () => {
    const shots = join(tmpdir(), 'vis-0019-canvas')
    mkdirSync(shots, { recursive: true })
    expect(await page.locator('.react-flow__attribution').count()).toBe(0)
    await page.getByText('拖入图片或视频导入', { exact: true }).waitFor()
    await page.screenshot({ path: `${shots}/zh-empty.png`, animations: 'disabled' })
    const englishEmpty = await browser.newPage({ locale: 'en', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    try {
      await englishEmpty.goto(host.url)
      await englishEmpty.getByText('Drop images or videos to import', { exact: true }).waitFor()
      await englishEmpty.screenshot({ path: `${shots}/en-empty.png`, animations: 'disabled' })
    } finally { await englishEmpty.close() }

    const body = '# 标题\n\n**重点**\n\n- 列表\n\n<script>window.canvasInjected = true</script>\n<img src=x onerror="window.canvasInjected = true">'
    const { idMap } = await apply([{ op: 'node.create', tempId: 'markdown', kind: 'text', x: 0, y: 0, w: 320, h: 300, content: { text: body } }])
    const text = node(idMap.markdown)
    await text.getByRole('heading', { name: '标题' }).waitFor()
    expect(await text.locator('strong').textContent()).toBe('重点')
    expect(await text.locator('li').textContent()).toBe('列表')
    expect(await text.locator('script, .vis-node-markdown img').count()).toBe(0)
    expect(await page.evaluate(() => 'canvasInjected' in window)).toBe(false)
    expect(await text.locator('.vis-node-rev').count()).toBe(0)
    await text.locator('.vis-node-text-body').dblclick()
    expect(await text.getByRole('textbox', { name: '文本内容' }).inputValue()).toBe(body)
    await page.keyboard.press('Escape')
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 400; canvas.height = 200
      const context = canvas.getContext('2d')!
      context.fillStyle = '#797fff'; context.fillRect(0, 0, 400, 200)
      context.fillStyle = '#282a48'; context.fillRect(120, 0, 160, 200)
      return canvas.toDataURL('image/png').split(',')[1]!
    })
    await page.getByLabel('上传图片、视频或音频').setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
    await expect.poll(async () => (await nodes()).filter(n => n.kind === 'image').length, { timeout: 10_000 }).toBe(1)
    const media = (await nodes()).find(n => n.kind === 'image')!
    await apply([{ op: 'node.layout', nodeId: media.nodeId, x: 400, y: 0, h: 320 }])
    await fitCanvas()
    await expect.poll(() => node(media.nodeId).locator('img').evaluate(el => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 }).toBe(400)
    expect(await node(media.nodeId).locator('img').evaluate(el => getComputedStyle(el).objectFit)).toBe('cover')
    await node(media.nodeId).click({ button: 'right' })
    await menu().getByRole('menuitem', { name: '按素材比例调整', exact: true }).click()
    await expect.poll(async () => (await nodes()).find(n => n.nodeId === media.nodeId)!.h, { timeout: 10_000 }).toBe(160)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(async () => (await nodes()).find(n => n.nodeId === media.nodeId)!.h, { timeout: 10_000 }).toBe(320)
    await node(media.nodeId).click({ button: 'right' })
    await menu().getByRole('menuitem', { name: '按素材比例调整', exact: true }).click()
    await expect.poll(async () => (await nodes()).find(n => n.nodeId === media.nodeId)!.h, { timeout: 10_000 }).toBe(160)
    await node(media.nodeId).click({ button: 'right' })
    expect(await menu().getByRole('menuitem', { name: '按素材比例调整', exact: true }).isDisabled()).toBe(true)
    await page.screenshot({ path: `${shots}/zh-media-menu.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
    await text.locator('.vis-node-label').click()
    await page.screenshot({ path: `${shots}/zh-markdown-selected.png`, animations: 'disabled' })
    await page.getByRole('button', { name: '生图', exact: true }).click()
    await page.getByRole('button', { name: '生成', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '生成', exact: true }).getAttribute('class')).toBe('vis-send-button')
    await fitCanvas()
    await page.getByRole('button', { name: '缩小画布', exact: true }).click({ clickCount: 2 })
    await expect.poll(async () => (await page.getByRole('button', { name: '生成', exact: true }).boundingBox())!.x).toBeLessThan(1160)
    await page.getByRole('button', { name: '收起小地图', exact: true }).click()
    await page.getByRole('textbox', { name: '提示词', exact: true }).fill('城市夜景，胶片质感')
    await page.screenshot({ path: `${shots}/zh-generation.png`, animations: 'disabled' })
    const english = await browser.newPage({ locale: 'en', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    try {
      await english.goto(host.url)
      await english.getByRole('button', { name: 'Generate image', exact: true }).waitFor()
      await english.getByRole('heading', { name: '标题' }).waitFor()
      await english.screenshot({ path: `${shots}/en-canvas.png`, animations: 'disabled' })
      await english.locator(`[data-id="${media.nodeId}"]`).click({ button: 'right' })
      await english.getByRole('menuitem', { name: 'Fit to media aspect ratio', exact: true }).waitFor()
      await english.screenshot({ path: `${shots}/en-media-menu.png`, animations: 'disabled' })
      await english.keyboard.press('Escape')
      await english.getByRole('button', { name: 'Generate image', exact: true }).click()
      await english.getByRole('button', { name: 'Generate', exact: true }).waitFor()
      await english.getByRole('button', { name: 'Fit canvas', exact: true }).click()
      await english.getByRole('button', { name: 'Zoom out on canvas', exact: true }).click({ clickCount: 2 })
      await expect.poll(async () => (await english.getByRole('button', { name: 'Generate', exact: true }).boundingBox())!.x).toBeLessThan(1160)
      await english.getByRole('button', { name: 'Hide minimap', exact: true }).click()
      await english.getByRole('textbox', { name: 'Prompt', exact: true }).fill('City at night, film texture')
      await english.screenshot({ path: `${shots}/en-generation.png`, animations: 'disabled' })
    } finally { await english.close() }

  })

  it('video adjusts to the loaded asset ratio, empty media is disabled, and node types appear only during interaction', async () => {
    const videoPath = join(dir, 'ratio-video.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath])
    await page.getByLabel('上传图片、视频或音频').setInputFiles(videoPath)
    // Uploads register assets in the backend before creating nodes; busy machines can exceed the default 1-second expect.poll timeout
    await expect.poll(async () => (await nodes()).length, { timeout: 10_000 }).toBe(1)
    const video = (await nodes())[0]!
    await apply([{ op: 'node.layout', nodeId: video.nodeId, h: 320 }])
    await fitCanvas()
    const videoNode = node(video.nodeId)
    await videoNode.hover()
    await expect.poll(() => videoNode.locator('video').evaluate(el => (el as HTMLVideoElement).videoWidth), { timeout: 10_000 }).toBe(160)
    expect(await videoNode.locator('video').evaluate(el => getComputedStyle(el).objectFit)).toBe('cover')
    await videoNode.click({ button: 'right' })
    await menu().getByRole('menuitem', { name: '按素材比例调整', exact: true }).click()
    await expect.poll(async () => (await nodes())[0]!.h, { timeout: 10_000 }).toBe(180)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(async () => (await nodes())[0]!.h, { timeout: 10_000 }).toBe(320)
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 300 } })
    await page.mouse.move(20, 300)
    await expect.poll(() => videoNode.locator('.vis-node-kind').evaluate(el => getComputedStyle(el).opacity)).toBe('0')
    await videoNode.hover()
    expect(await videoNode.locator('.vis-node-kind').evaluate(el => getComputedStyle(el).opacity)).toBe('1')
    await videoNode.click()
    await page.mouse.move(20, 300)
    expect(await videoNode.locator('.vis-node-kind').evaluate(el => getComputedStyle(el).opacity)).toBe('1')
    await page.screenshot({ path: join(tmpdir(), 'vis-0019-canvas/zh-video-selected.png'), animations: 'disabled' })
    await page.getByRole('button', { name: '生图', exact: true }).click()
    await expect.poll(async () => (await nodes()).length, { timeout: 10_000 }).toBe(2)
    const empty = (await nodes()).find(n => n.kind === 'image')!
    await fitCanvas()
    await node(empty.nodeId).click({ button: 'right' })
    expect(await menu().getByRole('menuitem', { name: '按素材比例调整', exact: true }).isDisabled()).toBe(true)
  })

  it('members stop at frame edges when dragged; after moving out through the context menu they can be dragged further outward', async () => {
    const { idMap } = await apply([
      { op: 'frame.create', tempId: 'frame', title: '人物', x: 0, y: 0, w: 620, h: 460 },
      { op: 'node.create', tempId: 'member', kind: 'text', x: 80, y: 100, w: 220, h: 160, content: { text: '框内人物' } },
    ])
    const before = (await nodes()).find(item => item.nodeId === idMap.member)!
    expect(before.frameId).toBe(idMap.frame)
    await node(idMap.member).waitFor()
    await fitCanvas()
    await node(idMap.member).locator('.vis-node-label').click()
    await drag(idMap.member, 650, 420)
    await expect.poll(async () => (await nodes()).find(item => item.nodeId === idMap.member)!.layoutRevision).toBeGreaterThan(before.layoutRevision)
    const constrained = (await nodes()).find(item => item.nodeId === idMap.member)!
    const frame = (await nodes()).find(item => item.nodeId === idMap.frame)!
    expect(frame).toMatchObject({ x: 0, y: 0, w: 620, h: 460 })
    expect(constrained.frameId).toBe(frame.nodeId)
    expect(constrained.x).toBeGreaterThanOrEqual(frame.x)
    expect(constrained.y).toBeGreaterThanOrEqual(frame.y)
    expect(constrained.x + constrained.w).toBeLessThanOrEqual(frame.x + frame.w)
    expect(constrained.y + constrained.h).toBeLessThanOrEqual(frame.y + frame.h)
    await node(idMap.member).focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await nodes()).find(item => item.nodeId === idMap.member)!.x).toBe(constrained.x - 5)

    await node(idMap.member).locator('.vis-node-label').click({ button: 'right' })
    await menu().getByRole('menuitem', { name: '移出框', exact: true }).click()
    await expect.poll(async () => (await nodes()).find(item => item.nodeId === idMap.member)!.frameId).toBeNull()
    const detached = (await nodes()).find(item => item.nodeId === idMap.member)!
    await fitCanvas()
    await node(idMap.member).locator('.vis-node-label').click()
    await drag(idMap.member, 240, 0)
    await expect.poll(async () => (await nodes()).find(item => item.nodeId === idMap.member)!.x).toBeGreaterThan(detached.x)
    const moved = (await nodes()).find(item => item.nodeId === idMap.member)!
    expect(moved.frameId).toBeNull()
    expect(moved.x + moved.w).toBeGreaterThan(frame.x + frame.w)
  })

  it('previews organization of uncategorized outputs and undoes it in one step; undo remains available after auto-expansion', async () => {
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'a', kind: 'text', x: 500, y: 30, w: 220, h: 160, content: { text: '文案一' } },
      { op: 'node.create', tempId: 'b', kind: 'text', x: 20, y: 280, w: 260, h: 180, content: { text: '文案二' } },
    ])
    await node(idMap.b).waitFor()
    const before = layout(await nodes())
    await page.getByRole('button', { name: '整理', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '整理画布', exact: true })
    await dialog.getByRole('img', { name: '按类别排列的框与节点' }).waitFor()
    expect(layout(await nodes())).toEqual(before)
    await dialog.getByRole('button', { name: '确认整理', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(item => item.kind === 'frame').length).toBe(1)
    const frame = (await nodes()).find(item => item.kind === 'frame')!
    expect(frame.frame!.title).toBe('未分类')
    for (const member of (await nodes()).filter(item => item.kind !== 'frame')) expect(member.frameId).toBe(frame.nodeId)
    await fitCanvas()
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.vis-canvas')!.getBoundingClientRect()
      return [...document.querySelectorAll('.react-flow__node')].every(node => { const bounds = node.getBoundingClientRect(); return bounds.left > canvas.left + 10 && bounds.right < canvas.right - 10 && bounds.top > canvas.top + 10 && bounds.bottom < canvas.bottom - 10 })
    })
    await page.screenshot({ path: join(tmpdir(), 'vis-s16-organization-uncategorized.png'), animations: 'disabled' })
    await page.locator('.vis-canvas-wrap').focus()
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(async () => layout(await nodes())).toEqual(before).catch(async error => { throw new Error(`${error.message}\nUI notice: ${await page.locator('.app-notice').allTextContents()}`) })

    const created = await apply([{ op: 'frame.create', tempId: 'small', title: '自动撑大', x: 1200, y: 0, w: 320, h: 200 }])
    const member = await apply([{ op: 'node.create', tempId: 'large', kind: 'text', x: 1210, y: 10, w: 300, h: 180, content: { text: '保留内边距' } }])
    await expect.poll(async () => (await nodes()).find(item => item.nodeId === created.idMap.small)!.w).toBeGreaterThan(320)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(async () => (await nodes()).find(item => item.nodeId === created.idMap.small)!.w).toBe(320)
    // Cover the delayed expansion window to confirm undo is not automatically written back.
    await page.waitForTimeout(250)
    expect((await nodes()).find(item => item.nodeId === created.idMap.small)!.w).toBe(320)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(async () => (await nodes()).some(item => item.nodeId === member.idMap.large)).toBe(false)
    await apply([{ op: 'node.create', tempId: 'replacement', kind: 'text', x: 1210, y: 10, w: 300, h: 180, content: { text: '新的成员' } }])
    await expect.poll(async () => (await nodes()).find(item => item.nodeId === created.idMap.small)!.w).toBeGreaterThan(320)
  })

  it('organizes custom categories into frames, preserving content and reference edges, with batch undo and redo', async () => {
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'person', kind: 'text', x: 520, y: 20, w: 220, h: 160, category: '人物', content: { text: '主角：蓝色外套' } },
      { op: 'node.create', tempId: 'person2', kind: 'text', x: 40, y: 410, w: 280, h: 180, category: '人物', content: { text: '配角：橙色围巾' } },
      { op: 'node.create', tempId: 'scene', kind: 'text', x: 40, y: 20, w: 280, h: 200, category: '场景', content: { text: '雨后的玻璃花房' } },
      { op: 'node.create', tempId: 'shot', kind: 'image', x: 520, y: 370, w: 320, h: 240, category: '镜头', prompt: '两人在花房相遇', inputNodeIds: ['person', 'scene'] },
    ])
    await node(idMap.shot).waitFor()
    await fitCanvas()
    await node(idMap.shot).locator('.vis-node-label').click({ button: 'right' })
    await menu().getByRole('menuitem', { name: '设置类别…', exact: true }).click()
    const category = page.getByRole('dialog', { name: '设置类别', exact: true })
    await category.getByRole('combobox', { name: '类别', exact: true }).fill('自定义镜头')
    await category.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => (await nodes()).find(item => item.nodeId === idMap.shot)!.category).toBe('自定义镜头')
    const before = await nodes()
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } })
    await expect.poll(() => page.locator('.react-flow__node.selected').count()).toBe(0)
    await page.getByRole('button', { name: '整理', exact: true }).click()
    const organize = page.getByRole('dialog', { name: '整理画布', exact: true })
    await organize.waitFor()
    expect(layout(await nodes())).toEqual(layout(before))
    await organize.getByRole('button', { name: '确认整理', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(item => item.kind === 'frame').length).toBe(3)
    const arranged = await nodes()
    const frames = arranged.filter(item => item.kind === 'frame')
    expect(frames.map(item => item.frame!.title).sort()).toEqual(['人物', '场景', '自定义镜头'])
    for (const original of before) {
      const current = arranged.find(item => item.nodeId === original.nodeId)!
      const frame = frames.find(item => item.frame!.title === original.category)!
      expect(current).toMatchObject({ category: original.category, slots: original.slots, frameId: frame.nodeId })
      expect(current.inputs ?? []).toEqual(original.inputs ?? [])
      expect(current.x).toBeGreaterThanOrEqual(frame.x)
      expect(current.y).toBeGreaterThanOrEqual(frame.y)
      expect(current.x + current.w).toBeLessThanOrEqual(frame.x + frame.w)
      expect(current.y + current.h).toBeLessThanOrEqual(frame.y + frame.h)
    }
    for (const source of [idMap.person, idMap.scene]) await page.locator(`.react-flow__edge[data-id="input-${source}-${idMap.shot}"]`).waitFor()
    await page.locator('.vis-canvas-wrap').focus()
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(async () => layout(await nodes())).toEqual(layout(before))
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect.poll(async () => layout(await nodes())).toEqual(layout(arranged))
    await fitCanvas()
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.vis-canvas')!.getBoundingClientRect()
      return [...document.querySelectorAll('.react-flow__node')].every(node => { const bounds = node.getBoundingClientRect(); return bounds.left > canvas.left + 10 && bounds.right < canvas.right - 10 && bounds.top > canvas.top + 10 && bounds.bottom < canvas.bottom - 10 })
    })
    await page.screenshot({ path: join(tmpdir(), 'vis-s16-organization.png'), animations: 'disabled' })
  })

  it('work documents are hidden by default, visibility persists across refresh, and the menu switches between work documents and outputs', async () => {
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'artifact', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: '交付文案' } },
      { op: 'node.create', tempId: 'working', kind: 'text', x: 400, y: 0, w: 320, h: 200, purpose: 'working', content: { text: 'Agent 内部工作计划' } },
    ])
    await node(idMap.artifact).waitFor()
    expect(await page.getByRole('button', { name: '显示工作文档', exact: true }).getAttribute('aria-pressed')).toBe('false')
    expect(await node(idMap.working).count()).toBe(0)
    await page.getByRole('button', { name: '显示工作文档', exact: true }).click()
    await node(idMap.working).waitFor()
    await page.reload()
    await node(idMap.working).waitFor()
    expect(await page.getByRole('button', { name: '显示工作文档', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await fitCanvas()
    await node(idMap.working).locator('.vis-node-label').click({ button: 'right' })
    await menu().getByRole('menuitem', { name: '标为产物', exact: true }).click()
    await expect.poll(async () => (await nodes()).find(item => item.nodeId === idMap.working)!.purpose).toBe('artifact')
    await page.getByRole('button', { name: '显示工作文档', exact: true }).click()
    await node(idMap.working).waitFor()
    await node(idMap.working).locator('.vis-node-label').click({ button: 'right' })
    await menu().getByRole('menuitem', { name: '标为工作文档', exact: true }).click()
    await expect.poll(async () => (await nodes()).find(item => item.nodeId === idMap.working)!.purpose).toBe('working')
    await expect.poll(() => node(idMap.working).count()).toBe(0)
    await node(idMap.artifact).waitFor()
  })

  it('manual local rendering after code edits produces a result with a source edge; rendering again preserves the same result version history', async () => {
    const html = (color: string) => `<!doctype html><html><body style="margin:0;background:${color}"><script>window.vis = { duration: 1, seek() {} }</script></body></html>`
    const { idMap } = await apply([{
      op: 'node.create', tempId: 'code', kind: 'text', x: 0, y: 0, w: 420, h: 260, format: 'code', category: '代码',
      content: { text: html('black') }, generation: { provider: 'render', model: 'html', params: { width: 64, height: 64, fps: 1, durationMs: 1000 } },
    }])
    const code = node(idMap.code)
    await code.waitFor()
    await fitCanvas()
    await code.getByText('html', { exact: true }).waitFor()
    await code.locator('.vis-node-text-body').dblclick()
    await code.locator('textarea').fill(html('orange'))
    await code.locator('textarea').press('ControlOrMeta+Enter')
    await code.getByText('代码已修改，未渲染', { exact: true }).waitFor()
    expect((await nodes()).filter(item => item.kind === 'video')).toHaveLength(0)
    await code.getByRole('button', { name: '渲染', exact: true }).click()
    // Local rendering starts a headless browser to record video; parallel e2e under heavy load can exceed 15 seconds
    await expect.poll(async () => (await nodes()).find(item => item.kind === 'video')?.slots.find(slot => slot.slotKey === 'main')?.source?.inputNodeIds, { timeout: 30_000 }).toEqual([idMap.code])
    const result = (await nodes()).find(item => item.kind === 'video')!
    const first = result.slots.find(slot => slot.slotKey === 'main')!
    expect(first.content).toMatchObject({ type: 'asset', mime: 'video/mp4' })
    expect((await admin.call('generation.get', { jobId: first.source!.jobId })).status).toBe('succeeded')
    await page.locator(`.react-flow__edge[data-id="source-${idMap.code}-${result.nodeId}"]`).waitFor()
    await expect.poll(() => code.getByText('代码已修改，未渲染', { exact: true }).count()).toBe(0)
    await node(result.nodeId).hover()
    await expect.poll(() => node(result.nodeId).locator('video').evaluate(video => (video as HTMLVideoElement).videoWidth), { timeout: 10_000 }).toBe(64)
    expect(await node(result.nodeId).locator('video').evaluate(video => (video as HTMLVideoElement).videoHeight)).toBe(64)

    await code.locator('.vis-node-text-body').dblclick()
    await code.locator('textarea').fill(html('teal'))
    await code.locator('textarea').press('ControlOrMeta+Enter')
    await code.getByText('代码已修改，未渲染', { exact: true }).waitFor()
    await code.getByRole('button', { name: '渲染', exact: true }).click()
    await expect.poll(async () => (await nodes()).find(item => item.nodeId === result.nodeId)!.slots.find(slot => slot.slotKey === 'main')!.revision, { timeout: 30_000 }).toBeGreaterThan(first.revision)
    expect((await nodes()).filter(item => item.kind === 'video')).toHaveLength(1)
    const { versions } = await admin.call('slot.history', { slotId: first.slotId })
    expect(versions.filter((version: { content: { type: string } }) => version.content.type === 'asset')).toHaveLength(2)
    expect(versions[0].source.inputNodeIds).toEqual([idMap.code])
    await expect.poll(() => code.getByText('代码已修改，未渲染', { exact: true }).count()).toBe(0)
  }, 45_000)
})
