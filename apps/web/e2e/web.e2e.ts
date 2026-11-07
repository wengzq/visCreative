import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { chromePath, removeTempDir, supportsNativeApprovals } from './platform'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
// End-to-end: real studiod + web host + local Chrome. Requires pnpm build output; run with pnpm --filter @vis/web test:e2e.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const Database = createRequire(new URL('../../../packages/storage/package.json', import.meta.url))('better-sqlite3')
mkdirSync(join(tmpdir(), 'vis-j2'), { recursive: true })
mkdirSync(join(tmpdir(), 'vis-k'), { recursive: true })
mkdirSync(join(tmpdir(), 'vis-l'), { recursive: true })
mkdirSync(join(tmpdir(), 'vis-n'), { recursive: true })
mkdirSync(join(tmpdir(), 'vis-m'), { recursive: true })
const CHROME = chromePath()
const ready = existsSync(CHROME) && existsSync(join(root, 'services/studiod/dist/studiod.mjs')) && existsSync(join(root, 'apps/web/dist/vis-web.mjs'))

let dir: string
let projectsDir: string
let procs: ChildProcess[] = []
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
let admin: Awaited<ReturnType<typeof adminClient>>
let url: string

function start(script: string, env: Record<string, string>, readyText: RegExp): Promise<{ proc: ChildProcess; match: RegExpMatchArray }> {
  const proc = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  procs.push(proc)
  return new Promise((resolve, reject) => {
    let out = ''
    const onData = (c: Buffer) => {
      out += c.toString()
      const match = out.match(readyText)
      if (match) resolve({ proc, match })
    }
    proc.stdout!.on('data', onData)
    proc.stderr!.on('data', onData)
    proc.once('exit', code => reject(new Error(`${script} exited (${code}): ${out}`)))
  })
}

/** Another UI connection: simulates someone else editing the canvas and reads actual backend state */
async function adminClient(run: string) {
  const sock = connect(studiodEndpoint(dirname(run)))
  await new Promise(r => sock.once('connect', r))
  sock.setEncoding('utf8')
  let buf = ''
  let id = 0
  const pending = new Map<number, (m: any) => void>()
  sock.on('data', (c: string) => {
    buf += c
    for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
      const m = JSON.parse(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      if (m.id !== undefined) pending.get(m.id)?.(m)
    }
  })
  const call = (method: string, params: unknown = {}) => new Promise<any>((res, rej) => {
    const i = ++id
    pending.set(i, m => (m.error ? rej(new Error(m.error.message)) : res(m.result)))
    sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: i, method, params })}\n`)
  })
  await call('runtime.hello', { protocolVersion: 1, credential: { kind: 'ui', token: readFileSync(join(run, 'studiod.token'), 'utf8') } })
  const { spaces } = await call('space.list')
  await call('events.subscribe', { spaceId: spaces[0].spaceId })
  return { call, spaceId: spaces[0].spaceId as string, nodes: async () => (await call('canvas.get')).nodes as any[], close: () => sock.end() }
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`Wait timed out: ${JSON.stringify(v)}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

function jobInputs(jobId: string) {
  const db = new Database(join(dir, 'spaces', admin.spaceId, 'space.db'), { readonly: true, fileMustExist: true })
  try {
    return db.prepare('SELECT slot_id, slot_revision, from_snapshot FROM job_inputs WHERE job_id = ? ORDER BY ordinal').all(jobId)
  } finally {
    db.close()
  }
}

describe.skipIf(!ready)('Web UI', () => {
  let extendedId: string
  let inputTextId: string
  let uploadedId: string
  const evidenceDirs = new Set<string>()
  const agentEvidence = (workDir: string) => {
    evidenceDirs.add(workDir)
    const path = join(workDir, '.vis-e2e-agent.jsonl')
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  }

  async function createCodexSession(title: string) {
    await showWorkspaces()
    await page.getByRole('button', { name: '开始创作', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '新建工作区', exact: true })
    await dialog.getByLabel('工作区名称（可选）', { exact: true }).fill(title)
    await dialog.getByRole('button', { name: 'Codex', exact: true }).click()
    await dialog.getByRole('button', { name: '创建工作区', exact: true }).click()
    await expect.poll(() => page.locator('.vis-session-heading strong').textContent()).toBe(title)

  }

  async function showWorkspaces() {
    const expand = page.getByRole('button', { name: '展开会话面板', exact: true })
    if (await expand.isVisible()) await expand.click()
    const back = page.getByRole('button', { name: '返回列表', exact: true })
    if (await back.isVisible()) await back.click()
    await page.getByRole('region', { name: '工作区', exact: true }).waitFor()
  }

  async function workspaceCard(title: string) {
    const session = (await admin.call('session.list')).sessions.find((entry: any) => entry.title === title)
    expect(session).toBeDefined()
    const { item } = await admin.call('work.get', { workItemId: session.workItemId })
    return page.getByRole('region', { name: '工作区', exact: true }).getByRole('listitem').filter({ has: page.getByTitle(item.title, { exact: true }) })
  }

  async function openSession(title: string) {
    await showWorkspaces()
    const card = await workspaceCard(title)
    const workTitle = await card.locator('.vis-work-card-title').textContent()
    await card.click()
    await expect.poll(() => page.locator('.vis-session-heading strong').textContent()).toBe(workTitle)
  }

  async function expectWorkspaceCount(count: number, reopen?: string) {
    await showWorkspaces()
    await expect.poll(() => page.getByRole('region', { name: '工作区', exact: true }).getByRole('listitem').count()).toBe(count)
    if (reopen) await openSession(reopen)
  }

  beforeAll(async () => {
    // Use a separate system temporary directory for each run.
    dir = mkdtempSync(join(tmpdir(), 'vis-e2e-'))
    // Separate workspaces from private app data to preserve sandbox directory boundaries in real deployments
    projectsDir = mkdtempSync(join(tmpdir(), 'vis-projects-e2e-'))
    // Replace Codex with a fake app-server: streams echoes without model calls
    const existingDir = join(projectsDir, 'existing-project')
    mkdirSync(existingDir)
    const env = {
      VIS_DATA_DIR: dir, VIS_PROJECTS_DIR: projectsDir, VIS_PICK_DIRECTORY: existingDir,
      VIS_CLI_BIN_DIR: join(root, 'apps/cli/dist'), VIS_CODEX_PATH: join(root, 'apps/web/e2e/fake-codex.mjs'),
      // Picker-only coverage needs an available executable; this fake cannot call a real Agent.
      VIS_DSH_PATH: join(root, 'apps/web/e2e/fake-codex.mjs'),
    }
    await start(join(root, 'services/studiod/dist/studiod.mjs'), env, /\[studiod\] Started /)
    const web = await start(join(root, 'apps/web/dist/vis-web.mjs'), env, /(http:\/\/127\.0\.0\.1:\d+\/#t=\S+)/)
    url = web.match[1]!
    admin = await adminClient(join(dir, 'run'))
    // These existing UI tests share a project and create multiple sessions; work-item integration tests cover slot queuing.
    await admin.call('work.setSlotLimit', { limit: 32 })
    browser = await chromium.launch({ executablePath: CHROME, headless: true })
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    await page.goto(url)
    await page.waitForSelector('.react-flow__pane')
  }, 30_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await page.screenshot({ path: join(tmpdir(), 'vis-canvas-e2e-failure.png'), fullPage: true })
  })

  afterAll(async () => {
    admin?.close()
    await browser?.close()
    for (const p of procs) p.kill('SIGINT')
    await Promise.all(procs.map(proc => proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => proc.once('exit', () => resolve()))))
    const evidence = [...evidenceDirs].map(path => join(path, '.vis-e2e-agent.jsonl')).filter(existsSync).map(path => readFileSync(path, 'utf8')).join('')
    writeFileSync(join(tmpdir(), 'vis-m/agent-evidence.jsonl'), evidence)
    removeTempDir(dir)
    removeTempDir(projectsDir)
  })

  it('removes the token from the address bar after reading it', () => {
    expect(page.url()).not.toContain('#t=')
  })

  it('shows a hint when there is nothing to undo or redo', async () => {
    await page.keyboard.press('ControlOrMeta+Z')
    await expect.poll(() => page.locator('.app-notice.is-info').last().textContent()).toContain('没有可撤销的操作')
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await expect.poll(() => page.locator('.app-notice.is-info').last().textContent()).toContain('没有可重做的操作')
  })

  it('two-finger trackpad scrolling pans, pinch or Ctrl+wheel zooms, and right-button dragging does not pan', async () => {
    const viewport = page.locator('.react-flow__viewport')
    const read = async () => {
      const m = (await viewport.getAttribute('style'))?.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/)
      return m ? { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) } : null
    }
    await page.mouse.move(640, 400)
    const start = (await read())!
    // Ordinary wheel events (two-finger trackpad scrolling) only pan without changing zoom
    await page.mouse.wheel(0, 120)
    await expect.poll(async () => (await read())!.y).not.toBe(start.y)
    expect((await read())!.zoom).toBe(start.zoom)
    await page.mouse.wheel(0, -120)
    await expect.poll(async () => (await read())!.y).toBeCloseTo(start.y, 0)
    // Trackpad pinch appears as ctrlKey + wheel in the browser
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    await expect.poll(async () => (await read())!.zoom).toBeGreaterThan(start.zoom)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, 100)
    await page.keyboard.up('Control')
    await expect.poll(async () => (await read())!.zoom).toBeCloseTo(start.zoom, 2)
    // Right-button dragging does not move the canvas
    const before = (await read())!
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(740, 480, { steps: 5 })
    await page.mouse.up({ button: 'right' })
    expect(await read()).toEqual(before)
    await page.keyboard.press('Escape')
  })

  it('creates text from the toolbar, edits on double-click, and submits', async () => {
    await page.getByRole('button', { name: '文本', exact: true }).click()
    await page.waitForSelector('.vis-node-text')
    await page.dblclick('.vis-node-text-body')
    await page.keyboard.type('第一镜：清晨')
    await page.keyboard.press('ControlOrMeta+Enter')
    const [node] = await until(admin.nodes, n => n[0]?.slots[0].content.body === '第一镜：清晨')
    expect(node.slots[0].revision).toBe(2)
    await expect.poll(() => page.textContent('.vis-node-text-body')).toBe('第一镜：清晨')
  })

  it('keyboard undo and redo update the canvas; redo remains available after refresh', async () => {
    await page.mouse.click(60, 700)
    await page.keyboard.press('ControlOrMeta+Z')
    await until(admin.nodes, n => n[0]?.slots[0].content.body === '')
    await expect.poll(() => page.textContent('.vis-node-text-body')).toBe('双击开始编辑')
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await until(admin.nodes, n => n[0]?.slots[0].content.body === '第一镜：清晨')
    await expect.poll(() => page.textContent('.vis-node-text-body')).toBe('第一镜：清晨')
    await page.keyboard.press('Control+Z')
    await until(admin.nodes, n => n[0]?.slots[0].content.body === '')
    await page.reload()
    await page.waitForSelector('.react-flow__pane')
    await page.keyboard.press('Control+Y')
    await until(admin.nodes, n => n[0]?.slots[0].content.body === '第一镜：清晨')
    await expect.poll(() => page.textContent('.vis-node-text-body')).toBe('第一镜：清晨')
  })

  it('inputs, textareas, and editable content retain their own undo and redo shortcuts', async () => {
    const before = await admin.nodes()
    await page.dblclick('.vis-node-text-body')
    const textarea = page.getByRole('textbox', { name: '文本内容', exact: true })
    await textarea.press('End')
    await textarea.press('x')
    expect(await textarea.inputValue()).toBe('第一镜：清晨x')
    await textarea.press('ControlOrMeta+Z')
    expect(await textarea.inputValue()).toBe('第一镜：清晨')
    await textarea.press('ControlOrMeta+Shift+Z')
    expect(await textarea.inputValue()).toBe('第一镜：清晨x')
    await textarea.press('Escape')
    const intercepted = await page.evaluate(() => {
      const fixture = document.createElement('div')
      fixture.innerHTML = '<input><textarea></textarea><div contenteditable="true"><span>草稿</span></div>'
      document.body.append(fixture)
      try {
        return [...fixture.querySelectorAll('input, textarea, span')].flatMap(editor => [
          { key: 'z', metaKey: true }, { key: 'Z', ctrlKey: true, shiftKey: true }, { key: 'y', ctrlKey: true },
        ].map(shortcut => {
          const event = new KeyboardEvent('keydown', { ...shortcut, bubbles: true, cancelable: true })
          editor.dispatchEvent(event)
          // Synthetic keys also need releasing, or React Flow treats them as held and affects subsequent Delete presses.
          editor.dispatchEvent(new KeyboardEvent('keyup', { ...shortcut, bubbles: true }))
          return event.defaultPrevented
        }))
      } finally {
        fixture.remove()
      }
    })
    expect(intercepted).toEqual(Array(9).fill(false))
    expect(await admin.nodes()).toEqual(before)
  })

  it('creation, editing, dragging, and deletion can all be undone step by step and then redone', async () => {
    const before = await admin.nodes()
    await page.getByRole('button', { name: '文本', exact: true }).click()
    const created = (await until(admin.nodes, n => n.length === before.length + 1)).find(n => !before.some(b => b.nodeId === n.nodeId))
    const node = page.locator(`.react-flow__node[data-id="${created.nodeId}"]`)
    await fitCanvas()
    await node.locator('.vis-node-text-body').dblclick()
    await node.locator('textarea').fill('完整撤销链')
    await node.locator('textarea').press('ControlOrMeta+Enter')
    await until(admin.nodes, n => n.find(n => n.nodeId === created.nodeId)?.slots[0].content.body === '完整撤销链')
    const label = (await node.locator('.vis-node-label').boundingBox())!
    await page.mouse.move(label.x + 20, label.y + 8)
    await page.mouse.down()
    await page.mouse.move(label.x + 100, label.y + 68, { steps: 8 })
    await page.mouse.up()
    const moved = (await until(admin.nodes, n => n.find(n => n.nodeId === created.nodeId)?.x !== created.x)).find(n => n.nodeId === created.nodeId)
    await node.locator('.vis-node-label').click()
    await page.keyboard.press('Delete')
    await until(admin.nodes, n => !n.some(n => n.nodeId === created.nodeId))

    await page.keyboard.press('ControlOrMeta+Z')
    await until(admin.nodes, n => n.some(n => n.nodeId === created.nodeId && n.x === moved.x && n.y === moved.y && n.slots[0].content.body === '完整撤销链'))
    await expect.poll(() => node.locator('.vis-node-text-body').textContent()).toBe('完整撤销链')
    await page.keyboard.press('ControlOrMeta+Z')
    await until(admin.nodes, n => n.some(n => n.nodeId === created.nodeId && n.x === created.x && n.y === created.y))
    await page.keyboard.press('ControlOrMeta+Z')
    await until(admin.nodes, n => n.find(n => n.nodeId === created.nodeId)?.slots[0].content.body === '')
    await expect.poll(() => node.locator('.vis-node-text-body').textContent()).toBe('双击开始编辑')
    await page.keyboard.press('ControlOrMeta+Z')
    await until(admin.nodes, n => !n.some(n => n.nodeId === created.nodeId))
    await expect.poll(() => node.count()).toBe(0)

    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await until(admin.nodes, n => n.find(n => n.nodeId === created.nodeId)?.slots[0].content.body === '')
    await expect.poll(() => node.locator('.vis-node-text-body').textContent()).toBe('双击开始编辑')
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await until(admin.nodes, n => n.find(n => n.nodeId === created.nodeId)?.slots[0].content.body === '完整撤销链')
    await expect.poll(() => node.locator('.vis-node-text-body').textContent()).toBe('完整撤销链')
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await until(admin.nodes, n => n.some(n => n.nodeId === created.nodeId && n.x === moved.x && n.y === moved.y))
    await page.keyboard.press('ControlOrMeta+Shift+Z')
    await until(admin.nodes, n => !n.some(n => n.nodeId === created.nodeId))
    await expect.poll(() => node.count()).toBe(0)
    expect((await admin.nodes()).map(n => n.nodeId)).toEqual(before.map(n => n.nodeId))
  })

  it('dragging and resizing write back to the backend on release', async () => {
    const [before] = await admin.nodes()
    const header = (await page.locator('.vis-node-label').first().boundingBox())!
    await page.mouse.move(header.x + 20, header.y + 8)
    await page.mouse.down()
    await page.mouse.move(header.x + 220, header.y + 108, { steps: 8 })
    await page.mouse.up()
    const [moved] = await until(admin.nodes, n => n[0].x !== before.x)
    expect(moved.x - before.x).toBeGreaterThan(100)
    expect(moved.y - before.y).toBeGreaterThan(50)

    await page.click('.vis-node-label')
    const handle = (await page.locator('.react-flow__resize-control.handle.bottom.right').boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + 120, handle.y + 90, { steps: 8 })
    await page.mouse.up()
    const [resized] = await until(admin.nodes, n => n[0].w !== moved.w)
    expect(resized.w).toBeGreaterThan(moved.w)
    expect(resized.h).toBeGreaterThan(moved.h)
  })

  it('when another user edits first during editing, shows a conflict and the latest content', async () => {
    const [node] = await admin.nodes()
    await page.dblclick('.vis-node-text-body')
    await page.keyboard.type('（我的草稿）')
    await admin.call('canvas.apply', { requestId: `admin-${Date.now()}`, ops: [{ op: 'slot.setText', slotId: node.slots[0].slotId, body: '别人改的', expectedRevision: node.slots[0].revision }] })
    await page.keyboard.press('ControlOrMeta+Enter')
    await page.waitForSelector('.app-notice.is-error')
    expect(await page.textContent('.app-notice')).toContain('刚被其他人修改')
    await expect.poll(() => page.textContent('.vis-node-text-body')).toBe('别人改的')
  })

  it('dropping an image imports it at the drop position and the image loads', async () => {
    const png = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=64x48', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-'])
    await page.evaluate(async ({ b64 }) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'orange.png', { type: 'image/png' }))
      document.querySelector('.vis-canvas-wrap')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 1000, clientY: 150, bubbles: true, cancelable: true }))
    }, { b64: png.toString('base64') })
    const nodes = await until(admin.nodes, n => n.some(x => x.kind === 'image'))
    const image = nodes.find(x => x.kind === 'image')
    expect(image).toMatchObject({ w: 320, h: 240 })
    await expect.poll(() => page.locator('.vis-node-image img').evaluate(i => (i as HTMLImageElement).naturalWidth)).toBe(64)
  })

  it('Delete removes the selection; refreshing the page still reconnects', async () => {
    // Click blank space to deselect first, then select the image
    await page.mouse.click(60, 700)
    await page.click('.react-flow__node:has(.vis-node-image) .vis-node-label')
    await page.keyboard.press('Delete')
    const left = await until(admin.nodes, n => !n.some(x => x.kind === 'image'))
    expect(left.map(x => x.kind)).toEqual(['text'])
    await expect.poll(() => page.locator('.vis-node-image').count()).toBe(0)

    await page.reload()
    await page.waitForSelector('.vis-node-text')
    expect(await page.locator('.app-status').getAttribute('aria-label')).toBe('已连接')
  })

  it('creates a Codex session, sends a canvas node reference with @, and streams the reply', async () => {
    await createCodexSession('Codex 1')
    await page.click('.react-flow__node:has(.vis-node-text) .vis-node-label')
    // Typing @ opens canvas nodes with selected nodes first; Enter references the node and removes @ from the input
    await page.locator('.vis-composer textarea').fill('@')
    const mention = page.getByRole('listbox', { name: '画布节点', exact: true })
    await mention.waitFor()
    const first = mention.getByRole('option').first()
    expect(await first.textContent()).toContain('画布上已选中')
    // Each item shows its content opening; the highlighted item has a large preview above the list to distinguish otherwise identical text references
    expect(await first.textContent()).toContain('@别人改的')
    expect(await page.locator('.vis-mention-preview').textContent()).toBe('别人改的')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('.vis-composer .vis-ref-thumb').count()).toBe(1)
    expect(await page.locator('.vis-composer textarea').inputValue()).toBe('')
    expect(await mention.count()).toBe(0)
    expect(await page.locator('.vis-composer .vis-ref-text').textContent()).toBe('别人改的')
    await page.fill('.vis-composer textarea', '你好')
    const streaming = page.waitForSelector('.vis-item.is-streaming', { timeout: 10_000 })
    await page.keyboard.press('Enter')
    await page.waitForSelector('.vis-item.is-user')
    expect(await page.locator('.vis-composer .vis-ref-thumb').count()).toBe(0)
    expect(await page.locator('.vis-item.is-user .vis-user-text').textContent()).toBe('你好')
    expect(await page.locator('.vis-item.is-user .vis-ref-text').textContent()).toBe('别人改的')
    // Reply fragments arrive as a streaming draft, replaced by a final entry on completion
    await streaming
    await expect.poll(() => page.locator('.vis-item.is-assistant:not(.is-streaming)').locator('.vis-message-markdown').textContent(), { timeout: 10_000 }).toBe('收到：你好（引用 1 个节点）')
    expect(await page.locator('.vis-item.is-assistant .vis-agent-heading').first().textContent()).toBe('Codex')
    expect(await page.locator('.vis-item.is-streaming').count()).toBe(0)
    await expect.poll(() => page.getByRole('button', { name: '停止', exact: true }).count()).toBe(0)
  })

  it('can stop an active turn', async () => {
    await page.fill('.vis-composer textarea', '慢一点')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: '停止', exact: true }).waitFor({ timeout: 10_000 })
    await page.locator('.vis-composer textarea').fill('下一条消息')
    expect(await page.getByRole('button', { name: '发送', exact: true }).isVisible()).toBe(true)
    expect(await page.locator('.vis-composer-hint').textContent()).toContain('本回合结束后发出')
    await page.locator('.vis-composer textarea').fill('')
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await expect.poll(async () => (await admin.call('session.list')).sessions[0].queuePaused, { timeout: 10_000 }).toBe(true)
    await expect.poll(async () => (await admin.call('session.list')).sessions[0].activeTurnId, { timeout: 10_000 }).toBeNull()
  })

  it('reads session records from the backend after refresh', async () => {
    await page.reload()
    await openSession('Codex 1')
    await page.waitForSelector('.vis-item.is-user')
    const users = await page.locator('.vis-item.is-user .vis-user-text').allTextContents()
    expect(users).toEqual(['你好', '慢一点'])
    expect(await page.locator('.vis-item.is-assistant').first().locator('.vis-message-markdown').textContent()).toBe('收到：你好（引用 1 个节点）')
  })

  /** Makes fake Codex submit generation jobs through vis CLI (the same path as real agents); returns jobId, space-separated for multiple jobs */
  async function agentGenerate(params: object | object[]): Promise<string> {
    if (!(await page.locator('.vis-composer textarea').isVisible())) {
      const { sessions } = await admin.call('session.list')
      await openSession(sessions.at(-1).title)
    }
    const title = await page.locator('.vis-session-heading strong').textContent()
    const work = (await admin.call('work.list')).items.find((item: any) => item.title === title)
    const session = (await admin.call('session.list')).sessions.find((entry: any) => entry.workItemId === work.workItemId)
    const { items } = await admin.call('session.getTranscript', { sessionId: session.sessionId, limit: 100 })
    const before = items.filter((item: any) => item.kind === 'assistant_text').length
    await expect.poll(() => page.locator('.vis-item.is-assistant').count()).toBe(before)
    await page.fill('.vis-composer textarea', `生成 ${JSON.stringify(params)}`)
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('.vis-item.is-assistant').count(), { timeout: 10_000 }).toBe(before + 1)
    const text = (await page.locator('.vis-item.is-assistant').last().locator('.vis-message-markdown').textContent())!
    expect(text).toMatch(/^已提交 /)
    return text.replace('已提交 ', '')
  }

  it('shows generation on the target node and highlights it after output fills it', async () => {
    // Stopping the previous session paused its queue; use a new session
    await createCodexSession('Codex 2')
    const { idMap } = await admin.call('canvas.apply', { requestId: `admin-${Date.now()}`, ops: [{ op: 'node.create', tempId: 'n', kind: 'image', x: 0, y: 420, w: 240, h: 240 }] })
    const [target] = (await admin.call('canvas.get', { nodeIds: [idMap.n] })).nodes
    const node = page.locator(`.react-flow__node[data-id="${target.nodeId}"]`)
    await node.waitFor()
    await agentGenerate({ kind: 'image', prompt: '屋顶花园', targets: [{ outputIndex: 0, kind: 'slot', slotId: target.slots[0].slotId }] })
    await node.locator('.vis-node-badge.is-running').waitFor()
    expect(await page.locator('.app-status').getAttribute('title')).toContain('1 个生成中')
    await node.locator('img').waitFor({ timeout: 10_000 })
    await node.locator('.vis-node-flash').waitFor({ state: 'attached' })
    expect(await node.locator('.vis-node-badge').count()).toBe(0)
    await expect.poll(() => page.locator('.app-status').getAttribute('title')).toContain('0 个生成中')
  })

  it('generating again in the same slot shows a dismissible notice for the older request that finishes first', async () => {
    const image = (await admin.nodes()).find(n => n.kind === 'image' && n.slots[0].content.type === 'asset')
    const node = page.locator(`.react-flow__node[data-id="${image.nodeId}"]`)
    const target = { outputIndex: 0, kind: 'slot', slotId: image.slots[0].slotId }
    // Submit sequentially in one turn: the later request takes over the slot, so the earlier one no longer fills it on completion
    await agentGenerate([{ kind: 'image', prompt: '第一版', targets: [target] }, { kind: 'image', prompt: '第二版', targets: [target] }])
    await node.locator('.vis-node-problem').waitFor({ timeout: 10_000 })
    expect(await node.locator('.vis-node-problem span').textContent()).toBe('目标已有更新，结果没有回填')
    // This node lies under the session panel; dispatch the click directly
    await node.locator('.vis-node-problem').getByRole('button', { name: '关闭', exact: true }).dispatchEvent('click')
    await expect.poll(() => node.locator('.vis-node-problem').count()).toBe(0)
  })

  it('text input generates a new node with live source edges and minimap; rewriting or deletion removes edges', async () => {
    const { idMap } = await admin.call('canvas.apply', { requestId: `source-${Date.now()}`, ops: [{ op: 'node.create', tempId: 'source', kind: 'text', x: -400, y: 0, w: 320, h: 200, content: { text: '屋顶花园' } }] })
    const [source] = (await admin.call('canvas.get', { nodeIds: [idMap.source] })).nodes
    const before = await page.locator('.react-flow__edge').count()
    const jobId = await agentGenerate({ kind: 'image', prompt: '屋顶花园', inputs: [{ slotId: source.slots[0].slotId }] })
    const nodes = await until(admin.nodes, nodes => nodes.some(n => n.slots[0]?.source?.jobId === jobId), 10_000)
    const product = nodes.find(n => n.slots[0]?.source?.jobId === jobId)
    await page.locator(`.react-flow__node[data-id="${product.nodeId}"] img`).waitFor()
    await expect.poll(() => page.locator('.react-flow__edge').count()).toBe(before + 1)
    const edge = page.locator(`.react-flow__edge[data-id="source-${source.nodeId}-${product.nodeId}"]`)
    await expect.poll(() => edge.count()).toBe(1)
    expect(await page.locator('.react-flow__minimap').isVisible()).toBe(true)
    await page.reload()
    await edge.waitFor()
    await admin.call('canvas.apply', { requestId: `clear-${Date.now()}`, ops: [{ op: 'slot.clear', slotId: product.slots[0].slotId, expectedRevision: product.slots[0].revision }] })
    await expect.poll(() => edge.count()).toBe(0)
    const nextJob = await agentGenerate({ kind: 'image', prompt: '再次生成', inputs: [{ slotId: source.slots[0].slotId }] })
    await until(admin.nodes, nodes => nodes.some(n => n.slots[0]?.source?.jobId === nextJob), 10_000)
    await expect.poll(() => page.locator('.react-flow__edge').count()).toBe(before + 1)
    await admin.call('canvas.apply', { requestId: `delete-${Date.now()}`, ops: [{ op: 'node.delete', nodeId: source.nodeId }] })
    await expect.poll(() => page.locator('.react-flow__edge').count()).toBe(before)
  })

  it('toolbar image generation disables empty prompts, then generates and fills the current node after saving', async () => {
    await page.getByRole('button', { name: '生图', exact: true }).click()
    const nodes = await until(admin.nodes, nodes => nodes.some(n => n.slots.some((s: any) => s.slotKey === 'prompt')))
    const created = nodes.find(n => n.slots.some((s: any) => s.slotKey === 'prompt'))
    const node = page.locator(`.react-flow__node[data-id="${created.nodeId}"]`)
    await node.waitFor()
    await node.locator('.vis-node-label').click()
    const button = page.getByRole('button', { name: '生成', exact: true })
    expect(await button.isDisabled()).toBe(true)
    await page.getByRole('textbox', { name: '提示词' }).fill('清晨的屋顶花园')
    await button.click()
    await node.locator('.vis-node-badge.is-running').waitFor()
    await node.locator('img').waitFor({ timeout: 10_000 })
    await expect.poll(() => node.locator('img').evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const saved = (await admin.nodes()).find(n => n.nodeId === created.nodeId)
    expect(saved.slots).toMatchObject([
      { slotKey: 'main', content: { type: 'asset' } },
      { slotKey: 'prompt', revision: 2, content: { type: 'text', body: '清晨的屋顶花园' } },
    ])
    expect(await button.isEnabled()).toBe(true)
  })

  it('generation prompt conflicts preserve the other version and block generation', async () => {
    const created = (await admin.nodes()).find(n => n.slots.some((s: any) => s.slotKey === 'prompt'))
    const prompt = created.slots.find((s: any) => s.slotKey === 'prompt')
    const main = created.slots.find((s: any) => s.slotKey === 'main')
    const node = page.locator(`.react-flow__node[data-id="${created.nodeId}"]`)
    await node.locator('.vis-node-label').click()
    const textarea = page.getByRole('textbox', { name: '提示词' })
    await textarea.fill('我的草稿')
    await admin.call('canvas.apply', { requestId: `admin-${Date.now()}`, ops: [{ op: 'slot.setText', slotId: prompt.slotId, body: '别人改的提示词', expectedRevision: prompt.revision }] })
    await page.getByRole('button', { name: '生成', exact: true }).click()
    await expect.poll(() => textarea.innerText()).toBe('别人改的提示词')
    expect(await page.locator('.app-notice.is-error').last().textContent()).toContain('刚被其他人修改')
    expect(await node.locator('.vis-node-badge.is-running').count()).toBe(0)
    const saved = (await admin.nodes()).find(n => n.nodeId === created.nodeId)
    expect(saved.slots.find((s: any) => s.slotKey === 'main')).toEqual(main)
  })

  it('video generation waits for the prompt being saved and rejects new input during saving', async () => {
    expect(await page.locator('.app-notice.is-error').last().isVisible()).toBe(true)
    await page.getByRole('button', { name: '生视频', exact: true }).click()
    const nodes = await until(admin.nodes, nodes => nodes.some(n => n.kind === 'video'))
    await page.locator('.app-notice.is-error').last().getByRole('button', { name: '关闭', exact: true }).click()
    const created = nodes.find(n => n.kind === 'video')
    const node = page.locator(`.react-flow__node[data-id="${created.nodeId}"]`)
    await node.locator('.vis-node-label').click()
    const textarea = page.getByRole('textbox', { name: '提示词' })
    await textarea.fill('雨中的街道')
    // Delay one save to reproduce the race from clicking Generate immediately after Cmd+Enter
    await page.evaluate(() => {
      const send = WebSocket.prototype.send
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && data.includes('slot.setText')) {
          WebSocket.prototype.send = send
          setTimeout(() => send.call(this, data), 500)
        } else send.call(this, data)
      }
    })
    await textarea.press('ControlOrMeta+Enter')
    expect(await textarea.getAttribute('aria-readonly')).toBe('true')
    await textarea.press('B')
    expect(await textarea.innerText()).toBe('雨中的街道')
    await page.getByRole('button', { name: '生成', exact: true }).dispatchEvent('click')
    await node.locator('.vis-node-badge.is-running').waitFor()
    expect(await page.getByRole('button', { name: '生成', exact: true }).isEnabled()).toBe(true)
    await node.hover()
    await node.locator('video').waitFor({ timeout: 10_000 })
    await expect.poll(() => node.locator('video').evaluate(v => (v as HTMLVideoElement).videoWidth)).toBeGreaterThan(0)
    const saved = (await admin.nodes()).find(n => n.nodeId === created.nodeId)
    expect(saved.slots).toMatchObject([
      { slotKey: 'main', content: { type: 'asset' } },
      { slotKey: 'prompt', revision: 2, content: { type: 'text', body: '雨中的街道' } },
    ])
  })

  it('extends right for image generation: reference edges, prompt Backspace, output filling, and real job_inputs', async () => {
    const before = await admin.nodes()
    const source = before.find(n => n.kind === 'text')
    await fitCanvas()
    const sourceNode = page.locator(`.react-flow__node[data-id="${source.nodeId}"]`)
    await sourceNode.locator('.vis-node-label').click()
    await sourceNode.getByRole('button', { name: '延伸节点', exact: true }).click()
    await page.getByRole('button', { name: '延伸生图', exact: true }).click()
    const nodes = await until(admin.nodes, nodes => nodes.length === before.length + 1)
    const created = nodes.find(n => !before.some(b => b.nodeId === n.nodeId))
    extendedId = created.nodeId
    expect(created).toMatchObject({ kind: 'image', inputs: [source.nodeId] })
    const node = page.locator(`.react-flow__node[data-id="${extendedId}"]`)
    await page.locator(`.react-flow__edge[data-id="input-${source.nodeId}-${extendedId}"]`).waitFor()
    expect(await page.locator('.vis-numbered-reference').count()).toBe(1)
    const prompt = page.getByRole('textbox', { name: '提示词' })
    await prompt.fill('根据参考绘制清晨的花园x')
    await prompt.press('Backspace')
    expect(await prompt.innerText()).toBe('根据参考绘制清晨的花园')
    expect((await admin.nodes()).some(n => n.nodeId === extendedId)).toBe(true)
    await page.getByRole('button', { name: '生成', exact: true }).click()
    await node.locator('.vis-node-badge.is-running').waitFor()
    await node.locator('img').waitFor({ timeout: 10_000 })
    await expect.poll(() => node.locator('img').evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const saved = (await admin.nodes()).find(n => n.nodeId === extendedId)
    const main = saved.slots.find((s: any) => s.slotKey === 'main')
    const savedPrompt = saved.slots.find((s: any) => s.slotKey === 'prompt')
    expect(main.content.type).toBe('asset')
    expect(savedPrompt.content.body).toBe('根据参考绘制清晨的花园')
    expect(jobInputs(main.source.jobId)).toEqual([
      { slot_id: savedPrompt.slotId, slot_revision: savedPrompt.revision, from_snapshot: 0 },
      { slot_id: source.slots[0].slotId, slot_revision: source.slots[0].revision, from_snapshot: 0 },
    ])
    await page.locator(`.react-flow__edge[data-id="source-${source.nodeId}-${extendedId}"]`).waitFor()
    expect(await page.locator(`.react-flow__edge[data-id="input-${source.nodeId}-${extendedId}"]`).count()).toBe(0)
    await prompt.fill('切换选中时保存的提示词')
    await fitCanvas()
    await sourceNode.locator('.vis-node-label').click()
    await until(admin.nodes, nodes => nodes.find(n => n.nodeId === extendedId)?.slots.find((s: any) => s.slotKey === 'prompt')?.content.body === '切换选中时保存的提示词')
    expect(await page.getByRole('textbox', { name: '提示词' }).count()).toBe(0)
    await node.locator('.vis-node-label').click()
    expect(await prompt.innerText()).toBe('切换选中时保存的提示词')
  })

  it('adds text input on the left; reference cards can be removed and reselected with the plus', async () => {
    const before = await admin.nodes()
    const target = before.find(n => n.nodeId === extendedId)
    const node = page.locator(`.react-flow__node[data-id="${extendedId}"]`)
    await node.getByRole('button', { name: '添加文本输入', exact: true }).click()
    const nodes = await until(admin.nodes, nodes => nodes.length === before.length + 1)
    const text = nodes.find(n => !before.some(b => b.nodeId === n.nodeId))
    inputTextId = text.nodeId
    expect(text.kind).toBe('text')
    const textNode = page.locator(`.react-flow__node[data-id="${inputTextId}"]`)
    await textNode.locator('.vis-node-text-body').dblclick()
    await textNode.locator('textarea').fill('花园里放一把橙色椅子')
    await textNode.locator('textarea').press('ControlOrMeta+Enter')
    await until(admin.nodes, nodes => nodes.find(n => n.nodeId === inputTextId)?.slots[0].content.body === '花园里放一把橙色椅子')
    await node.locator('.vis-node-label').click()
    await expect.poll(() => page.locator('.vis-numbered-reference').count()).toBe(2)
    await page.locator('.vis-numbered-reference').filter({ has: page.getByRole('button', { name: `移除参考 ${inputTextId}`, exact: true }) }).hover()
    await page.getByRole('button', { name: `移除参考 ${inputTextId}`, exact: true }).click()
    await until(admin.nodes, nodes => JSON.stringify(nodes.find(n => n.nodeId === extendedId)?.inputs) === JSON.stringify(target.inputs))
    await expect.poll(() => page.locator('.vis-numbered-reference').count()).toBe(1)
    await page.getByRole('button', { name: '添加参考', exact: true }).click()
    await page.locator('.vis-reference-hint').waitFor()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('.vis-reference-hint').count()).toBe(0)
    expect((await admin.nodes()).find(n => n.nodeId === extendedId).inputs).toEqual(target.inputs)
    await page.getByRole('button', { name: '添加参考', exact: true }).click()
    await textNode.locator('.vis-node-label').click()
    await until(admin.nodes, nodes => nodes.find(n => n.nodeId === extendedId)?.inputs?.includes(inputTextId))
    await expect.poll(() => page.locator('.vis-numbered-reference').count()).toBe(2)
    expect(await page.locator('.react-flow__node.selected').getAttribute('data-id')).toBe(extendedId)
    expect(await page.getByRole('textbox', { name: '提示词' }).count()).toBe(1)
    await page.locator(`.react-flow__edge[data-id="input-${inputTextId}-${extendedId}"]`).waitFor()
  })

  it('after deleting a reference node, references can still be removed and selected without refresh', async () => {
    const target = (await admin.nodes()).find(n => n.nodeId === extendedId)
    const removedId = target.inputs.find((id: string) => id !== inputTextId)
    await fitCanvas()
    await page.locator(`.react-flow__node[data-id="${removedId}"] .vis-node-label`).click()
    await page.keyboard.press('Delete')
    await until(admin.nodes, nodes => !nodes.some(n => n.nodeId === removedId))
    const node = page.locator(`.react-flow__node[data-id="${extendedId}"]`)
    await node.locator('.vis-node-label').click()
    await expect.poll(() => page.locator('.vis-numbered-reference').count()).toBe(1)
    await page.locator('.vis-numbered-reference').hover()
    await page.getByRole('button', { name: `移除参考 ${inputTextId}`, exact: true }).click()
    await until(admin.nodes, nodes => (nodes.find(n => n.nodeId === extendedId)?.inputs ?? []).length === 0)
    await expect.poll(() => page.locator('.vis-numbered-reference').count()).toBe(0)
    await page.getByRole('button', { name: '添加参考', exact: true }).click()
    await page.locator(`.react-flow__node[data-id="${inputTextId}"] .vis-node-label`).click()
    await until(admin.nodes, nodes => JSON.stringify(nodes.find(n => n.nodeId === extendedId)?.inputs) === JSON.stringify([inputTextId]))
    await expect.poll(() => page.locator('.vis-numbered-reference').count()).toBe(1)
  })

  it('the upload button imports a local image', async () => {
    const before = await admin.nodes()
    const png = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=80x60', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-'])
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('.vis-canvas-toolbar').getByRole('button', { name: '上传', exact: true }).click(),
    ])
    await chooser.setFiles({ name: 'blue.png', mimeType: 'image/png', buffer: png })
    const nodes = await until(admin.nodes, nodes => nodes.length === before.length + 1)
    const image = nodes.find(n => !before.some(b => b.nodeId === n.nodeId))
    uploadedId = image.nodeId
    expect(image).toMatchObject({ kind: 'image', w: 320, h: 240 })
    const img = page.locator(`.react-flow__node[data-id="${image.nodeId}"] img`)
    await expect.poll(() => img.evaluate(i => (i as HTMLImageElement).naturalWidth)).toBe(80)
  })

  it('media preview zoom, reading-order switching, video shortcuts, and card interactions', async () => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    const nodes = await admin.nodes()
    const image = nodes.find(n => n.nodeId === uploadedId)
    const video = nodes.find(n => n.kind === 'video' && n.slots.some((s: any) => s.content.type === 'asset'))
    expect(video).toBeTruthy()
    await admin.call('canvas.apply', { requestId: `preview-${Date.now()}`, ops: [
      { op: 'node.layout', nodeId: image.nodeId, x: 0, y: -1000, w: 320, h: 240 },
      { op: 'node.layout', nodeId: video.nodeId, x: 400, y: -1000, w: 400, h: 300 },
    ] })
    await page.reload()
    await fitCanvas()
    const imageNode = page.locator(`.react-flow__node[data-id="${image.nodeId}"]`)
    const videoNode = page.locator(`.react-flow__node[data-id="${video.nodeId}"]`)
    await imageNode.locator('img').dblclick()
    const preview = page.getByRole('dialog', { name: '媒体预览' })
    await preview.waitFor()
    await expect.poll(() => preview.locator('.vis-preview-dimensions').textContent()).toBe('80×60')
    const fitZoom = await preview.locator('output').textContent()
    expect(fitZoom).toBe('100%')
    expect(await preview.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(10, 10, 11, 0.94)')
    expect(await preview.evaluate(el => getComputedStyle(el).backdropFilter)).toBe('blur(6px)')
    expect(await preview.evaluate(el => el.parentElement === document.body)).toBe(true)
    await page.keyboard.press('1')
    const before = await preview.locator('output').textContent()
    await preview.locator('img').hover()
    await page.mouse.wheel(0, -100)
    await expect.poll(() => preview.locator('output').textContent()).not.toBe(before)
    await page.keyboard.press('0')
    await expect.poll(() => preview.locator('output').textContent()).toBe(fitZoom)
    await preview.getByRole('button', { name: '详情', exact: true }).click()
    await page.screenshot({ path: join(tmpdir(), 'vis-j2/image-small-details.png'), animations: 'disabled' })
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => page.locator('.react-flow__node.selected').getAttribute('data-id')).toBe(video.nodeId)
    await preview.locator('video').waitFor()
    await page.keyboard.press('Escape')
    expect(await preview.count()).toBe(0)
    expect(await videoNode.getAttribute('class')).toContain('selected')
    await page.keyboard.press('Space')
    const v = preview.locator('video')
    await v.waitFor()
    await expect.poll(() => v.evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(.1)
    await page.keyboard.press('Space')
    await expect.poll(() => v.evaluate(v => (v as HTMLVideoElement).paused)).toBe(true)
    const paused = await v.evaluate(v => (v as HTMLVideoElement).currentTime)
    await page.keyboard.press('.')
    await expect.poll(() => v.evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(paused)
    const muted = await v.evaluate(v => (v as HTMLVideoElement).muted)
    await page.keyboard.press('m')
    await expect.poll(() => v.evaluate(v => (v as HTMLVideoElement).muted)).toBe(!muted)
    await page.screenshot({ path: join(tmpdir(), 'vis-j2/video-preview.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await fitCanvas()
    await videoNode.locator('video').hover({ position: { x: 10, y: 10 } })
    await expect.poll(() => videoNode.locator('.vis-video-controls').evaluate(el => getComputedStyle(el).opacity)).toBe('1')
    await page.screenshot({ path: join(tmpdir(), 'vis-j2/video-card-hover.png'), animations: 'disabled' })
    await videoNode.getByRole('button', { name: '播放', exact: true }).click()
    await expect.poll(() => videoNode.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(.1)
    await videoNode.getByRole('button', { name: '暂停', exact: true }).click()
    const progress = (await videoNode.getByRole('slider', { name: '视频进度' }).boundingBox())!
    await page.mouse.click(progress.x + progress.width * .75, progress.y + progress.height / 2)
    await expect.poll(() => videoNode.locator('video').evaluate(v => (v as HTMLVideoElement).currentTime / (v as HTMLVideoElement).duration)).toBeGreaterThan(.6)
    const box = (await videoNode.locator('video').boundingBox())!
    await page.mouse.move(box.x + 10, box.y + 10)
    await page.mouse.down()
    await page.mouse.move(box.x + 90, box.y + 40, { steps: 8 })
    await page.mouse.up()
    await until(admin.nodes, ns => ns.find(n => n.nodeId === video.nodeId).x !== 400)
    const prompt = page.getByRole('textbox', { name: '提示词' })
    await prompt.focus()
    await page.keyboard.press('Space')
    expect(await preview.count()).toBe(0)
    await page.setViewportSize({ width: 1280, height: 800 })
  })

  it('large images fit the remaining media area without details covering them', async () => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    const before = await admin.nodes()
    const png = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=2048x1536', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-'])
    const choose = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '上传', exact: true }).click()
    await (await choose).setFiles({ name: 'large-preview.png', mimeType: 'image/png', buffer: png })
    const nodes = await until(admin.nodes, ns => ns.length > before.length)
    const large = nodes.find(n => !before.some(old => old.nodeId === n.nodeId))
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('vis:preview', { detail: id })), large.nodeId)
    const preview = page.getByRole('dialog', { name: '媒体预览' })
    await expect.poll(() => preview.locator('.vis-preview-dimensions').textContent()).toBe('2048×1536')
    if (await preview.getByRole('button', { name: '详情', exact: true }).getAttribute('aria-pressed') !== 'true') await preview.getByRole('button', { name: '详情', exact: true }).click()
    await page.keyboard.press('0')
    await expect.poll(() => preview.locator('img').boundingBox()).toMatchObject({ height: 904 })
    const image = (await preview.locator('img').boundingBox())!
    const stage = (await preview.locator('.vis-preview-stage').boundingBox())!
    const details = (await preview.locator('aside').boundingBox())!
    expect(image.x + image.width).toBeLessThan(details.x)
    expect(Math.abs(image.x + image.width / 2 - stage.x - stage.width / 2)).toBeLessThan(1)
    expect(await preview.locator('aside').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(34, 34, 34)')
    expect(Number((await preview.locator('output').textContent())!.replace('%', ''))).toBeLessThan(100)
    await page.screenshot({ path: join(tmpdir(), 'vis-j2/image-preview-details.png'), animations: 'disabled' })
    await preview.getByRole('button', { name: '详情', exact: true }).click()
    await page.keyboard.press('0')
    await page.screenshot({ path: join(tmpdir(), 'vis-j2/large-image-fit.png'), animations: 'disabled' })
    await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'node.delete', nodeId: large.nodeId }] })
    await expect.poll(() => preview.count()).toBe(0)
    await page.locator(`.react-flow__node[data-id="${uploadedId}"] .vis-node-label`).click()
    await page.keyboard.press('Space')
    await preview.waitFor()
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1280, height: 800 })
  })

  it('multi-selection hides floating prompts; minimap collapse persists across refresh and saves a canvas screenshot', async () => {
    await fitCanvas()
    const node = page.locator(`.react-flow__node[data-id="${extendedId}"]`)
    await node.locator('.vis-node-label').click()
    await page.getByRole('textbox', { name: '提示词' }).waitFor()
    await page.locator(`.react-flow__node[data-id="${inputTextId}"] .vis-node-label`).click({ modifiers: ['ControlOrMeta'] })
    await expect.poll(() => page.locator('.react-flow__node.selected').count(), { timeout: 5_000 }).toBe(2)
    await expect.poll(() => page.getByRole('textbox', { name: '提示词' }).count(), { timeout: 5_000 }).toBe(0)
    await page.getByRole('button', { name: '收起小地图', exact: true }).click()
    await expect.poll(() => page.locator('.react-flow__minimap').count(), { timeout: 5_000 }).toBe(0)
    await page.reload()
    await node.waitFor()
    await expect.poll(() => page.getByRole('button', { name: '展开小地图', exact: true }).isVisible(), { timeout: 5_000 }).toBe(true)
    await expect.poll(() => page.locator('.react-flow__minimap').count(), { timeout: 5_000 }).toBe(0)
    await page.getByRole('button', { name: '展开小地图', exact: true }).click()
    await expect.poll(() => page.locator('.react-flow__minimap').isVisible(), { timeout: 5_000 }).toBe(true)
    await page.setViewportSize({ width: 1600, height: 1000 })
    // Keep only the three relevant test nodes in the screenshot so distant nodes from earlier tests do not shrink them too much.
    const screenshotNodes = await admin.nodes()
    await admin.call('canvas.apply', {
      requestId: `screenshot-${Date.now()}`,
      ops: [
        ...screenshotNodes.filter(n => ![inputTextId, extendedId, uploadedId].includes(n.nodeId)).map(n => ({ op: 'node.delete', nodeId: n.nodeId })),
        { op: 'node.layout', nodeId: inputTextId, x: 0, y: 80, w: 320, h: 200 },
        { op: 'node.layout', nodeId: extendedId, x: 400, y: 40, w: 320, h: 320 },
        { op: 'node.layout', nodeId: uploadedId, x: 800, y: 80, w: 320, h: 240 },
      ],
    })
    await page.reload()
    await expect.poll(() => page.locator('.react-flow__node').count(), { timeout: 5_000 }).toBe(3)
    await node.locator('.vis-node-label').click()
    await page.getByRole('textbox', { name: '提示词' }).waitFor()
    await expect.poll(() => page.getByRole('button', { name: '生成', exact: true }).isVisible(), { timeout: 5_000 }).toBe(true)
    await page.screenshot({ path: join(tmpdir(), 'vis-canvas-restyle.png'), fullPage: true })
    console.info('Canvas screenshot:', join(tmpdir(), 'vis-canvas-restyle.png'))
    await page.setViewportSize({ width: 1280, height: 800 })
  })

  it('collapsing expands the canvas and persists across refresh; idle workspaces show no avatar', async () => {
    const canvas = page.locator('.vis-canvas-wrap')
    const before = (await canvas.boundingBox())!.width
    const transform = await page.locator('.react-flow__viewport').getAttribute('style')
    await page.getByRole('button', { name: '收起会话面板', exact: true }).click()
    await page.locator('.vis-session-rail').waitFor()
    await expect.poll(async () => (await page.locator('.vis-session-panel').boundingBox())!.width).toBe(44)
    expect((await canvas.boundingBox())!.width).toBeGreaterThan(before + 300)
    expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(transform)
    await page.reload()
    await page.getByRole('button', { name: '展开会话面板', exact: true }).waitFor()
    expect(await page.locator('.vis-session-rail').isVisible()).toBe(true)
    expect((await page.locator('.vis-session-panel').boundingBox())!.width).toBe(44)
    expect(await page.locator('.vis-session-rail .vis-session-icon').count()).toBe(0)
    await page.getByRole('button', { name: '展开会话面板', exact: true }).click()
    await openSession('Codex 1')
    await page.locator('.vis-item.is-user').first().waitFor()
    expect(await page.locator('.vis-item.is-user').first().textContent()).toContain('你好')
  })

  it('dragging the panel edge constrains width and persists across refresh; keyboard width adjustment is supported', async () => {
    const panel = page.locator('.vis-session-panel')
    const resize = page.getByRole('separator', { name: '调整会话面板宽度' })
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(400)
    const dragWidth = async (delta: number) => {
      const box = (await resize.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + 100)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 - delta, box.y + 100, { steps: 8 })
      await page.mouse.up()
    }
    await dragWidth(120)
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(520)
    await page.reload()
    await resize.waitFor()
    expect((await panel.boundingBox())!.width).toBe(520)
    await dragWidth(400)
    expect((await panel.boundingBox())!.width).toBe(640)
    await dragWidth(-500)
    expect((await panel.boundingBox())!.width).toBe(300)
    await resize.press('ArrowLeft')
    await expect.poll(async () => (await panel.boundingBox())!.width).toBe(320)
  })

  it('the collapse shortcut in the input preserves drafts; streaming replies complete while hidden', async () => {
    await createCodexSession('Codex 3')
    const composer = page.locator('.vis-composer textarea')
    await composer.fill('保留草稿')
    await composer.press('Backslash')
    expect(await composer.inputValue()).toBe('保留草稿\\')
    await composer.press('Control+Backslash')
    await page.locator('.vis-session-rail').waitFor()
    expect(await page.getByRole('button', { name: '展开会话面板', exact: true }).evaluate(el => el === document.activeElement)).toBe(true)
    await page.keyboard.press('Meta+Backslash')
    await composer.waitFor()
    expect(await page.getByRole('button', { name: '收起会话面板', exact: true }).evaluate(el => el === document.activeElement)).toBe(true)
    expect(await composer.inputValue()).toBe('保留草稿\\')
    const text = '收起之后流式回复仍会继续，完整内容应当保留在会话里'
    await composer.fill(text)
    await composer.press('Enter')
    await page.locator('.vis-item.is-streaming').waitFor()
    await page.getByRole('button', { name: '收起会话面板', exact: true }).click()
    await page.locator('.vis-session-rail').waitFor()
    await expect.poll(async () => (await admin.call('session.list')).sessions.find((session: any) => session.title === 'Codex 3').activeTurnId, { timeout: 10_000 }).toBeNull()
    await expect.poll(() => page.locator('.vis-session-rail .vis-session-icon').count()).toBe(0)
    await page.getByRole('button', { name: '展开会话面板', exact: true }).click()
    await expect.poll(() => page.locator('.vis-item.is-assistant:not(.is-streaming)').locator('.vis-message-markdown').textContent()).toBe(`收到：${text}`)
    expect(await composer.inputValue()).toBe('')
    await page.reload()
    await openSession('Codex 3')
    await page.locator('.vis-item.is-assistant').waitFor()
    expect(await page.locator('.vis-item.is-assistant').locator('.vis-message-markdown').textContent()).toBe(`收到：${text}`)
  })

  it('image, video, and text references stay with messages; tools group and collapse; list/session switching preserves drafts', async () => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    const resize = page.getByRole('separator', { name: '调整会话面板宽度' })
    for (let i = 0; i < 4; i++) await resize.press('ArrowLeft')
    try {
      await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } })
      await expect.poll(() => page.locator('.react-flow__node.selected').count()).toBe(0)
      const nodes = await admin.nodes()
      const referenceText = '雨后的城市街道，橙色灯光映在湿润路面。\n保留安静、克制的镜头节奏。'
      const text = nodes.find(n => n.nodeId === inputTextId)
      const { idMap } = await admin.call('canvas.apply', {
        requestId: `session-references-${crypto.randomUUID()}`,
        ops: [
          ...nodes.filter(n => ![inputTextId, uploadedId].includes(n.nodeId)).map(n => ({ op: 'node.delete', nodeId: n.nodeId })),
          { op: 'slot.setText', slotId: text.slots[0].slotId, body: referenceText, expectedRevision: text.slots[0].revision },
          { op: 'node.layout', nodeId: inputTextId, x: 0, y: 80, w: 320, h: 200 },
          { op: 'node.layout', nodeId: uploadedId, x: 400, y: 0, w: 320, h: 240 },
          { op: 'node.create', tempId: 'video', kind: 'video', x: 400, y: 340, w: 320, h: 240 },
        ],
      })
      const [video] = (await admin.call('canvas.get', { nodeIds: [idMap.video] })).nodes
      const job = await admin.call('generation.submit', {
        requestId: `session-video-${crypto.randomUUID()}`, kind: 'video', prompt: '雨后的城市街道',
        targets: [{ outputIndex: 0, kind: 'slot', slotId: video.slots[0].slotId }],
      })
      await until(() => admin.call('generation.get', { jobId: job.jobId }), j => j.status === 'succeeded', 10_000)
      await page.locator(`.react-flow__node[data-id="${video.nodeId}"]`).hover()
      await page.locator(`.react-flow__node[data-id="${video.nodeId}"] video`).waitFor()
      await fitCanvas()
      while (await page.locator('.app-notice').count()) await page.locator('.app-notice').first().getByRole('button', { name: '关闭', exact: true }).click()
      const addReferences = async () => {
        for (const id of [uploadedId, video.nodeId, inputTextId]) {
          await page.locator(`.react-flow__node[data-id="${id}"] .vis-node-label`).click()
          // Type @ after the existing draft to reference a node; @ is removed afterward, then restore the draft for the later persistence check
          const textarea = page.locator('.vis-composer textarea')
          const draftBefore = await textarea.inputValue()
          await textarea.fill(draftBefore ? `${draftBefore} @` : '@')
          await page.getByRole('listbox', { name: '画布节点', exact: true }).waitFor()
          // Image nodes have list thumbnails and a larger image above when highlighted
          if (id === uploadedId) await expect.poll(() => page.locator('.vis-mention-preview img').count()).toBe(1)
          await page.keyboard.press('Enter')
          await expect.poll(() => textarea.inputValue()).toBe(draftBefore ? `${draftBefore} ` : '')
          await textarea.fill(draftBefore)
        }
        await expect.poll(() => page.locator('.vis-composer .vis-ref-thumb').count()).toBe(3)
      }
      await addReferences()
      expect(await page.locator('.vis-composer .vis-ref-text').textContent()).toBe(referenceText)
      await expect.poll(() => page.locator('.vis-composer .vis-ref-thumb.is-image img').evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      const videoPoster = page.locator('.vis-composer .vis-ref-thumb.is-video img')
      await expect.poll(() => videoPoster.evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      expect(await videoPoster.getAttribute('src')).toContain('/poster?t=')
      expect(await page.locator('.vis-composer video').count()).toBe(0)
      const message = '工具检查：根据这些参考素材整理分镜'
      await page.locator('.vis-composer textarea').fill(message)
      await page.locator('.vis-composer textarea').press('Enter')
      await expect.poll(() => page.locator('.vis-item.is-assistant:not(.is-streaming)').last().locator('.vis-message-markdown').textContent(), { timeout: 10_000 }).toBe(`收到：${message}（引用 3 个节点）`)
      const user = page.locator('.vis-item.is-user').last()
      expect(await user.locator('.vis-user-text').textContent()).toBe(message)
      expect(await user.locator('.vis-ref-thumb').count()).toBe(3)
      expect(await user.locator('.vis-ref-text').textContent()).toBe(referenceText)
      expect(await page.locator('.vis-composer .vis-ref-thumb').count()).toBe(0)
      const imageRef = user.locator('.vis-ref-thumb.is-image')
      await expect.poll(() => imageRef.locator('img').evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      for (let i = 0; i < 2; i++) {
        await imageRef.click()
        await expect.poll(() => page.locator('.react-flow__node.selected').getAttribute('data-id')).toBe(uploadedId)
        expect(await page.getByRole('dialog', { name: '媒体预览' }).count()).toBe(0)
      }
      await page.locator('.vis-work-block > summary').click()
      const tools = page.locator('.vis-tool-group')
      expect(await tools.count()).toBe(1)
      expect(await tools.getAttribute('open')).toBeNull()
      expect(await tools.locator(':scope > summary').textContent()).toContain('调用了 2 个工具')
      expect(await tools.locator('.vis-tool-call').count()).toBe(2)
      expect(await tools.locator('.vis-tool-call').first().isVisible()).toBe(false)
      await expectWorkspaceCount(3, 'Codex 3')
      expect(await page.locator('.vis-session-card.is-expanded').count()).toBe(1)
      await page.screenshot({ path: join(tmpdir(), 'vis-k/sessions-references-tools-collapsed.png'), animations: 'disabled' })

      // Reopening the session above remounts the transcript with its work block folded.
      await page.locator('.vis-work-block > summary').click()
      await tools.locator(':scope > summary').click()
      for (const tool of await tools.locator('.vis-tool-call').all()) await tool.locator(':scope > summary').click()
      expect(await tools.locator('.vis-tool-result').allTextContents()).toEqual(['参考素材已就绪', '参考版本已读取'])
      expect(await tools.locator('.vis-tool-result').first().isVisible()).toBe(true)
      await user.locator('.vis-ref-thumb.is-text').click()
      await expect.poll(() => page.locator('.react-flow__node.selected').getAttribute('data-id')).toBe(inputTextId)
      expect(await tools.getAttribute('open')).not.toBeNull()
      expect(await tools.locator('.vis-tool-call[open]').count()).toBe(2)
      await page.screenshot({ path: join(tmpdir(), 'vis-k/tools-expanded.png'), animations: 'disabled' })

      const draft = '保持画面风格，继续补充下一镜。'
      await page.locator('.vis-composer textarea').fill(draft)
      await openSession('Codex 1')
      await expect.poll(() => page.locator('.vis-session-heading strong').textContent()).toBe('Codex 1')
      expect(await page.locator('.vis-session-card.is-expanded').count()).toBe(1)
      await openSession('Codex 3')
      await expect.poll(() => page.locator('.vis-session-heading strong').textContent()).toBe('Codex 3')
      expect(await page.locator('.vis-composer textarea').inputValue()).toBe(draft)
      await showWorkspaces()
      expect(await page.locator('.vis-session-card.is-expanded').count()).toBe(0)
      expect(await page.locator('.vis-composer').count()).toBe(0)
      await page.screenshot({ path: join(tmpdir(), 'vis-k/sessions-all-collapsed.png'), animations: 'disabled' })

      await openSession('Codex 3')
      expect(await page.locator('.vis-composer textarea').inputValue()).toBe(draft)
      await addReferences()
      await page.screenshot({ path: join(tmpdir(), 'vis-k/composer-three-references.png'), animations: 'disabled' })
      await showWorkspaces()
      await page.getByRole('button', { name: '开始创作', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '新建工作区', exact: true })
      const name = dialog.getByLabel('工作区名称（可选）', { exact: true })
      expect(await name.evaluate(el => el === document.activeElement)).toBe(true)
      const codex = dialog.getByRole('button', { name: 'Codex', exact: true })
      const deepseek = dialog.getByRole('button', { name: 'DeepSeek', exact: true })
      expect(await codex.getAttribute('aria-pressed')).toBe('true')
      await deepseek.click()
      expect(await deepseek.getAttribute('aria-pressed')).toBe('true')
      await codex.click()
      await page.screenshot({ path: join(tmpdir(), 'vis-k/create-session-menu.png'), animations: 'disabled' })
      await page.keyboard.press('Escape')
      expect(await dialog.count()).toBe(0)
      await openSession('Codex 3')
      expect(await page.locator('.vis-composer textarea').inputValue()).toBe(draft)
      expect(await page.locator('.vis-composer .vis-ref-thumb').count()).toBe(3)
      for (let i = 0; i < 3; i++) await page.locator('.vis-composer').getByRole('button', { name: '移除引用', exact: true }).first().click()
      await page.locator('.vis-composer textarea').fill('慢一点：折叠后停止')
      await page.locator('.vis-composer textarea').press('Enter')
      await page.getByRole('button', { name: '停止', exact: true }).waitFor()
      await showWorkspaces()
      await (await workspaceCard('Codex 3')).getByText(/Codex 正在/).waitFor()
      await openSession('Codex 3')
      await page.getByRole('button', { name: '停止', exact: true }).click()
      await expect.poll(async () => (await admin.call('session.list')).sessions.find((session: any) => session.title === 'Codex 3').queuePaused, { timeout: 10_000 }).toBe(true)
      await expect.poll(async () => (await admin.call('session.list')).sessions.find((session: any) => session.title === 'Codex 3').activeTurnId, { timeout: 10_000 }).toBeNull()
      await openSession('Codex 1')
      expect(await page.locator('.vis-session-heading strong').textContent()).toBe('Codex 1')
      const session = (await admin.call('session.list')).sessions.find((s: any) => s.title === 'Codex 3')
      expect(session.activeTurnId).toBeNull()
      expect(session.queuePaused).toBe(true)
      await admin.call('session.resumeQueue', { requestId: `resume-after-stop-${crypto.randomUUID()}`, sessionId: session.sessionId })
      await openSession('Codex 3')
      await expect.poll(() => page.getByRole('button', { name: '停止', exact: true }).count()).toBe(0)
      console.info('Session screenshot (1600x1000, 2x):', join(tmpdir(), 'vis-k'))
    } finally {
      for (let i = 0; i < 4; i++) await resize.press('ArrowRight')
      await page.setViewportSize({ width: 1280, height: 800 })
    }
  })

  let versionNodeId: string
  let versionSlotId: string
  let versionPromptSlotId: string
  let versionInputSlotId: string
  let versionCopyId: string
  const versionAssets: string[] = []
  const versionNode = () => page.locator(`.react-flow__node[data-id="${versionNodeId}"]`)
  const versionMedia = () => versionNode().locator('.vis-version-body .vis-version-media > img:last-child')
  const versionThumb = (n: number) => page.getByRole('button', { name: `查看版本 v${n}`, exact: true })
  const readVersionNode = async () => (await admin.call('canvas.get', { nodeIds: [versionNodeId] })).nodes[0]
  const mainSlot = (node: any) => node.slots.find((s: any) => s.slotKey === 'main')

  async function submitVersion(prompt: string) {
    return admin.call('generation.submit', {
      requestId: `version-${crypto.randomUUID()}`, kind: 'image', prompt,
      inputs: [{ slotId: versionPromptSlotId }, { slotId: versionInputSlotId }],
      targets: [{ outputIndex: 0, kind: 'slot', slotId: versionSlotId }],
    })
  }

  async function finishVersion(jobId: string) {
    const job = await until(() => admin.call('generation.get', { jobId }), j => j.status === 'succeeded', 10_000)
    expect(job.outputs[0].delivery.status).toBe('delivered')
    const assetId = job.outputs[0].assetVersionId as string
    await until(readVersionNode, node => mainSlot(node).content.assetVersionId === assetId)
    versionAssets.push(assetId)
    return assetId
  }

  it('after three generations, shows a deduplicated oldest-to-newest filmstrip with the current version at the right', async () => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    const oldNodes = await admin.nodes()
    await admin.call('canvas.apply', { requestId: `version-scene-${Date.now()}`, ops: oldNodes.map(n => ({ op: 'node.delete', nodeId: n.nodeId })) })
    await expect.poll(() => page.locator('.react-flow__node').count()).toBe(0)
    await page.getByRole('button', { name: '收起会话面板', exact: true }).click()
    await page.getByRole('button', { name: '生图', exact: true }).click()
    const [created] = await until(admin.nodes, nodes => nodes.length === 1)
    versionNodeId = created.nodeId
    versionSlotId = mainSlot(created).slotId
    versionPromptSlotId = created.slots.find((s: any) => s.slotKey === 'prompt').slotId
    const { idMap } = await admin.call('canvas.apply', {
      requestId: `version-reference-${Date.now()}`,
      ops: [
        { op: 'node.layout', nodeId: versionNodeId, x: 400, y: 40, w: 320, h: 320 },
        { op: 'node.create', tempId: 'reference', kind: 'text', x: 0, y: 100, w: 280, h: 200, content: { text: '屋顶花园：保留城市天际线，前景是一把橙色椅子。' } },
        { op: 'node.setInputs', nodeId: versionNodeId, inputNodeIds: ['reference'] },
      ],
    })
    const [reference] = (await admin.call('canvas.get', { nodeIds: [idMap.reference] })).nodes
    versionInputSlotId = reference.slots[0].slotId
    await fitCanvas()
    await versionNode().locator('.vis-node-label').click()
    await page.getByRole('textbox', { name: '提示词' }).fill('黄昏的屋顶花园，暖色调，城市天际线')
    await page.getByRole('button', { name: '生成', exact: true }).click()
    await versionNode().locator('.vis-node-badge.is-running').waitFor()
    await versionMedia().waitFor({ timeout: 10_000 })
    const first = await readVersionNode()
    versionAssets.push(mainSlot(first).content.assetVersionId)
    expect(first.inputs).toEqual([reference.nodeId])
    expect(await versionNode().getByRole('button', { name: '版本历史', exact: true }).count()).toBe(0)
    for (const prompt of ['蓝调时刻的屋顶花园，霓虹灯刚刚亮起', '夜晚的屋顶花园，明亮的橙色椅子']) {
      const { jobId } = await submitVersion(prompt)
      await finishVersion(jobId)
    }
    await expect.poll(() => versionNode().getByRole('button', { name: '版本历史', exact: true }).textContent()).toBe('3/3')
    const strip = page.locator('.vis-version-strip')
    expect(await strip.locator('button').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label')))).toEqual(['查看版本 v1', '查看版本 v2', '查看版本 v3'])
    expect(await strip.locator('[aria-current="true"]').getAttribute('aria-label')).toBe('查看版本 v3')
    for (let i = 0; i < versionAssets.length; i++) expect(await versionThumb(i + 1).locator('img').getAttribute('src')).toContain(versionAssets[i])
    expect(await versionMedia().getAttribute('src')).toContain(versionAssets[2])
    await expect.poll(() => versionMedia().evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect.poll(() => versionNode().locator('.vis-version-media.is-changing').count()).toBe(0)
    await page.mouse.move(30, 900)
    await page.screenshot({ path: join(tmpdir(), 'vis-version-strip.png'), fullPage: true })
  })

  it('hover previews send no RPC; clicking pins an old version, Escape returns, and brackets plus Enter restore it as a new revision', async () => {
    const sent: string[] = []
    page.once('websocket', socket => socket.on('framesent', ({ payload }) => {
      if (typeof payload === 'string') {
        const message = JSON.parse(payload)
        if (message.method) sent.push(message.method)
      }
    }))
    await page.reload()
    await versionNode().getByRole('button', { name: '版本历史', exact: true }).waitFor()
    await versionNode().locator('.vis-node-label').click()
    await expect.poll(() => page.locator('.vis-version-strip button').count()).toBe(3)
    const before = await readVersionNode()
    sent.length = 0
    await versionThumb(1).hover()
    await expect.poll(() => versionMedia().getAttribute('src')).toContain(versionAssets[0])
    await page.getByRole('tooltip').waitFor()
    expect(await page.getByRole('tooltip').textContent()).toContain('mock-image-1 / mock')
    expect(await page.getByRole('tooltip').textContent()).toContain('黄昏的屋顶花园')
    expect(await page.locator('.vis-version-actions').count()).toBe(0)
    await page.mouse.move(30, 900)
    await expect.poll(() => versionMedia().getAttribute('src')).toContain(versionAssets[2])
    expect(sent).toEqual([])
    expect(mainSlot(await readVersionNode())).toEqual(mainSlot(before))

    await versionThumb(1).click()
    await page.mouse.move(30, 900)
    expect(await versionNode().locator('.vis-node.is-viewing-version').count()).toBe(1)
    expect(await versionNode().locator('.vis-node').evaluate(n => getComputedStyle(n).borderTopStyle)).toBe('dashed')
    expect(await versionNode().locator('.vis-version-actions > span').textContent()).toBe('v1 / 3')
    expect(await versionMedia().getAttribute('src')).toContain(versionAssets[0])
    expect(mainSlot(await readVersionNode())).toEqual(mainSlot(before))
    await page.screenshot({ path: join(tmpdir(), 'vis-version-review.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('.vis-version-actions').count()).toBe(0)
    expect(await versionMedia().getAttribute('src')).toContain(versionAssets[2])
    await versionNode().locator('.vis-node-label').click()
    await page.keyboard.press('[')
    expect(await versionNode().locator('.vis-version-actions > span').textContent()).toBe('v2 / 3')
    await page.keyboard.press(']')
    expect(await page.locator('.vis-version-actions').count()).toBe(0)
    await page.keyboard.press('[')
    await page.keyboard.press('[')
    expect(await versionNode().locator('.vis-version-actions > span').textContent()).toBe('v1 / 3')
    await page.keyboard.press('Enter')
    const restored = await until(readVersionNode, node => mainSlot(node).revision === mainSlot(before).revision + 1)
    expect(mainSlot(restored).content.assetVersionId).toBe(versionAssets[0])
    expect(restored.slots.find((s: any) => s.slotKey === 'prompt')).toEqual(before.slots.find((s: any) => s.slotKey === 'prompt'))
    expect(restored.inputs).toEqual(before.inputs)
    await expect.poll(() => versionNode().getByRole('button', { name: '版本历史', exact: true }).textContent()).toBe('1/3')
    expect(await page.locator('.vis-version-strip button').count()).toBe(3)
    expect(await versionThumb(1).getAttribute('aria-current')).toBe('true')
    expect(await page.locator('.vis-version-actions').count()).toBe(0)
    const history = await admin.call('slot.history', { slotId: versionSlotId })
    expect(history.versions).toHaveLength(4)
    expect(history.versions[0]).toMatchObject({ revision: mainSlot(restored).revision, actor: 'user', isCurrent: true, content: { assetVersionId: versionAssets[0] } })
  })

  it('saving an old version separately creates and selects only a same-size asset node without copying prompts or reference inputs', async () => {
    const before = await readVersionNode()
    const nodesBefore = await admin.nodes()
    await versionThumb(2).click()
    const save = versionNode().getByRole('button', { name: '另存为节点', exact: true })
    await save.focus()
    await save.press('Enter')
    const nodes = await until(admin.nodes, nodes => nodes.length === nodesBefore.length + 1)
    const saved = nodes.find(n => !nodesBefore.some(b => b.nodeId === n.nodeId))
    versionCopyId = saved.nodeId
    expect(saved).toMatchObject({ kind: before.kind, w: before.w, h: before.h, x: before.x + before.w + 80, y: before.y })
    expect(saved.slots).toHaveLength(1)
    expect(saved.slots[0]).toMatchObject({ slotKey: 'main', content: { type: 'asset', assetVersionId: versionAssets[1] } })
    expect(saved.inputs ?? []).toEqual([])
    expect(await readVersionNode()).toEqual(before)
    await expect.poll(() => page.locator('.react-flow__node.selected').getAttribute('data-id')).toBe(versionCopyId)
    expect(await page.locator('.vis-version-actions').count()).toBe(0)
    expect(await page.getByRole('textbox', { name: '提示词' }).count()).toBe(0)
    await fitCanvas()
    const savedImage = page.locator(`.react-flow__node[data-id="${versionCopyId}"] .vis-version-media > img:last-child`)
    await expect.poll(() => savedImage.evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  })

  it('new deliveries do not interrupt old-version previews; deliveries while unselected show an unread dot', async () => {
    await versionNode().locator('.vis-node-label').click()
    await versionThumb(2).click()
    await page.mouse.move(30, 900)
    const { jobId } = await submitVersion('第四版：日出时分的屋顶花园')
    await page.getByLabel('新版本生成中', { exact: true }).waitFor()
    expect(await versionMedia().getAttribute('src')).toContain(versionAssets[1])
    await finishVersion(jobId)
    await expect.poll(() => versionNode().getByRole('button', { name: '版本历史', exact: true }).textContent()).toBe('4/4')
    expect(await versionNode().locator('.vis-version-actions > span').textContent()).toBe('v2 / 4')
    expect(await versionMedia().getAttribute('src')).toContain(versionAssets[1])
    expect(await page.locator('.vis-version-strip button').count()).toBe(4)
    expect(await versionThumb(4).getAttribute('aria-current')).toBe('true')
    expect(await page.getByLabel('新版本生成中', { exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await expect.poll(() => versionMedia().getAttribute('src')).toContain(versionAssets[3])
    await page.locator(`.react-flow__node[data-id="${versionCopyId}"] .vis-node-label`).click()
    const fifth = await submitVersion('第五版：午后的屋顶花园')
    await finishVersion(fifth.jobId)
    await expect.poll(() => versionNode().locator('.vis-version-unread').count()).toBe(1)
    expect(await versionNode().getByRole('button', { name: '版本历史', exact: true }).textContent()).toBe('5/5')
    expect(await versionMedia().getAttribute('src')).toContain(versionAssets[4])
    await versionNode().getByRole('button', { name: '版本历史', exact: true }).click()
    await expect.poll(() => versionNode().locator('.vis-version-unread').count()).toBe(0)
    expect(await page.locator('.react-flow__node.selected').getAttribute('data-id')).toBe(versionNodeId)
    expect(await page.locator('.vis-version-strip button').count()).toBe(5)
  })

  it('restore conflicts with another edit preserve the latest content, leave preview, and prompt reselection', async () => {
    await versionThumb(1).click()
    await page.evaluate(() => {
      const send = WebSocket.prototype.send
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && data.includes('slot.setAsset')) {
          WebSocket.prototype.send = send
          Object.assign(window, { releaseVersionRestore: () => send.call(this, data) })
        } else send.call(this, data)
      }
    })
    await versionNode().getByRole('button', { name: '设为当前', exact: true }).click()
    expect(await versionNode().getByRole('button', { name: '设为当前', exact: true }).isDisabled()).toBe(true)
    const before = await readVersionNode()
    await admin.call('canvas.apply', { requestId: `version-conflict-${Date.now()}`, ops: [{ op: 'slot.setAsset', slotId: versionSlotId, assetVersionId: versionAssets[2], expectedRevision: mainSlot(before).revision }] })
    await page.evaluate(() => {
      const pending = window as typeof window & { releaseVersionRestore: () => void }
      pending.releaseVersionRestore()
      Reflect.deleteProperty(pending, 'releaseVersionRestore')
    })
    await expect.poll(() => page.locator('.app-notice.is-error').last().textContent()).toContain('节点内容刚更新，请重新选择')
    await expect.poll(() => versionNode().locator('.vis-version-actions').count()).toBe(0)
    const latest = await readVersionNode()
    expect(mainSlot(latest)).toMatchObject({ revision: mainSlot(before).revision + 1, content: { assetVersionId: versionAssets[2] } })
    expect(await versionMedia().getAttribute('src')).toContain(versionAssets[2])
    expect(await versionNode().getByRole('button', { name: '版本历史', exact: true }).textContent()).toBe('3/5')
    expect(await page.locator('.vis-version-strip button').count()).toBe(5)
  })

  it('while two successive new images are still loading, retains the last successfully loaded image until the new one is visible', async () => {
    await expect.poll(() => versionMedia().getAttribute('src')).toContain(versionAssets[2])
    await expect.poll(() => versionMedia().evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect.poll(() => versionNode().locator('.vis-version-media.is-changing').count()).toBe(0)
    const known = new Set(versionAssets)
    const held = new Set<string>()
    const release: Array<() => void> = []
    const pending: Promise<void>[] = []
    let holding = true
    await page.route('**/assets/**', route => {
      const assetId = new URL(route.request().url()).pathname.split('/').at(-1)!
      if (known.has(assetId) || !holding) return route.continue()
      held.add(assetId)
      const request = new Promise<void>(resolve => release.push(resolve)).then(() => route.continue())
      pending.push(request)
      return request
    })
    try {
      for (const prompt of ['第六版：加载中的蓝色花园', '第七版：加载中的紫色花园']) {
        const { jobId } = await submitVersion(prompt)
        const assetId = await finishVersion(jobId)
        await expect.poll(() => held.has(assetId)).toBe(true)
        await expect.poll(() => versionMedia().getAttribute('src')).toContain(assetId)
        expect(await versionMedia().evaluate(i => (i as HTMLImageElement).naturalWidth)).toBe(0)
        const previous = versionNode().locator('.vis-version-media > img.is-previous')
        await expect.poll(() => previous.getAttribute('src')).toContain(versionAssets[2])
        // The old image element may have just been recreated and need time to decode from cache; it must remain fully visible while the new image is blocked
        await expect.poll(() => previous.evaluate(i => (i as HTMLImageElement).complete)).toBe(true)
        await expect.poll(() => previous.evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
        expect(await versionMedia().evaluate(i => (i as HTMLImageElement).naturalWidth)).toBe(0)
      }
    } finally {
      holding = false
      for (const resume of release) resume()
      await Promise.all(pending)
      await page.unroute('**/assets/**')
    }
    await expect.poll(() => versionMedia().evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect.poll(() => versionNode().locator('.vis-version-media.is-changing').count()).toBe(0)
    expect(await versionNode().locator('.vis-version-media > img').count()).toBe(1)
    expect(await versionMedia().getAttribute('src')).toContain(versionAssets.at(-1))
  })

  it('the preview version strip peeks and switches independently; setting current reuses main-slot restoration', async () => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await versionNode().locator('.vis-node-label').click()
    const before = mainSlot(await readVersionNode())
    await page.keyboard.press('Space')
    const preview = page.getByRole('dialog', { name: '媒体预览' })
    const strip = preview.getByRole('group', { name: '历史版本' })
    await strip.waitFor()
    expect(await strip.getAttribute('class')).toContain('is-lg')
    const first = strip.getByRole('button', { name: '查看版本 v1', exact: true })
    const media = preview.locator('.vis-preview-media > img')
    await first.hover()
    await expect.poll(() => media.getAttribute('src')).toContain(versionAssets[0])
    await page.mouse.move(40, 40)
    await expect.poll(() => media.getAttribute('src')).toContain(before.content.assetVersionId)
    await first.click()
    await page.mouse.move(40, 40)
    await expect.poll(() => media.getAttribute('src')).toContain(versionAssets[0])
    expect(mainSlot(await readVersionNode())).toEqual(before)
    expect(await versionMedia().getAttribute('src')).toContain(before.content.assetVersionId)
    await page.keyboard.press(']')
    await expect.poll(() => media.getAttribute('src')).toContain(versionAssets[1])
    await page.keyboard.press('[')
    await expect.poll(() => media.getAttribute('src')).toContain(versionAssets[0])
    await expect.poll(() => media.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect.poll(() => preview.locator('.vis-preview-dimensions').textContent()).toBe('512×512')
    await expect.poll(() => preview.evaluate(el => getComputedStyle(el).opacity)).toBe('1')
    await page.screenshot({ path: join(tmpdir(), 'vis-j2/preview-versions.png'), animations: 'disabled' })
    await preview.getByRole('button', { name: '设为当前', exact: true }).click()
    await until(readVersionNode, node => mainSlot(node).revision === before.revision + 1)
    expect(mainSlot(await readVersionNode()).content.assetVersionId).toBe(versionAssets[0])
    await expect.poll(() => strip.locator('[aria-current="true"]').getAttribute('aria-label')).toBe('查看版本 v1')
    await page.keyboard.press('ArrowRight')
    expect(await preview.getByRole('group', { name: '历史版本' }).count()).toBe(0)
    await page.keyboard.press('ArrowLeft')
    await preview.getByRole('group', { name: '历史版本' }).waitFor()
    await page.keyboard.press('Escape')
    expect(await preview.count()).toBe(0)
  })

  it('canvas wheel handling follows selection and overflow, related edges highlight, and videos keep a uniform width', async () => {
    const existing = await admin.nodes()
    if (existing.length) await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: existing.map(n => ({ op: 'node.delete', nodeId: n.nodeId })) })
    await page.reload()
    await page.waitForSelector('.react-flow__pane')
    await page.setViewportSize({ width: 1600, height: 1000 })
    const { idMap } = await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [
      { op: 'node.create', tempId: 'text', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: Array.from({ length: 60 }, (_, i) => `第${i}行代码与文本`).join('\n') } },
      { op: 'node.create', tempId: 'target', kind: 'image', x: 440, y: 0, w: 320, h: 320, prompt: '', inputNodeIds: ['text'] },
    ] })
    await fitCanvas()
    const text = page.locator(`[data-id="${idMap.text}"] .vis-node-text-body`)
    await text.waitFor()
    const viewport = page.locator('.react-flow__viewport')
    const transform = () => viewport.getAttribute('style')
    await text.hover()
    let before = await transform()
    await page.mouse.wheel(0, 80)
    await expect.poll(transform).not.toBe(before)
    expect(await text.evaluate(el => el.scrollTop)).toBe(0)
    await text.click()
    await expect.poll(() => page.locator('.react-flow__edge').getAttribute('aria-label')).toContain('已高亮')
    await text.hover()
    before = await transform()
    await page.mouse.wheel(0, 80)
    await expect.poll(() => text.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    expect(await transform()).toBe(before)
    await text.evaluate(el => { el.scrollTop = el.scrollHeight })
    await page.mouse.wheel(0, 80)
    await expect.poll(transform).not.toBe(before)
    // Selected nodes without overflow must not swallow wheel events either.
    const current = (await admin.nodes()).find(n => n.nodeId === idMap.text)
    await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'slot.setText', slotId: current.slots[0].slotId, expectedRevision: current.slots[0].revision, body: '短文本' }] })
    await expect.poll(() => text.textContent()).toBe('短文本')
    await text.hover()
    before = await transform()
    await page.mouse.wheel(0, 80)
    await expect.poll(transform).not.toBe(before)
    // After wheel panning, fixed coordinates may hit nodes; try several blank positions until deselected
    const spots = [[30, 30], [30, 300], [600, 30], [600, 300]]
    let spot = 0
    await expect.poll(async () => {
      const [x, y] = spots[spot++ % spots.length]!
      await page.locator('.react-flow__pane').click({ position: { x, y }, timeout: 1000 }).catch(() => {})
      return page.locator('.react-flow__edge').getAttribute('aria-label')
    }, { timeout: 10_000 }).not.toContain('已高亮')
    mkdirSync(join(tmpdir(), 'vis-ux1'), { recursive: true })
    for (const [name, size] of [['landscape', '160x90'], ['portrait', '90x160']]) {
      const path = join(dir, `${name}.mp4`)
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${size}:d=0.2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path])
      await page.getByLabel('上传图片、视频或音频').setInputFiles(path)
      await until(admin.nodes, nodes => nodes.filter(n => n.kind === 'video').length === (name === 'landscape' ? 1 : 2))
    }
    const videos = (await admin.nodes()).filter(n => n.kind === 'video')
    expect(videos.map(n => n.w)).toEqual([320, 320])
    expect(videos.map(n => n.h).sort((a, b) => a - b)).toEqual([180, 569])
    await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: videos.map((n, i) => ({ op: 'node.layout', nodeId: n.nodeId, x: i * 440, y: 440 })) })
    for (const video of videos) {
      await expect.poll(() => page.locator(`[data-id="${video.nodeId}"]`).getAttribute('style')).toContain('440px')
      await expect.poll(() => page.locator(`[data-id="${video.nodeId}"]`).evaluate(el => (el as HTMLElement).offsetWidth)).toBe(320)
    }
    await fitCanvas()
    for (const video of videos) {
      await expect.poll(async () => {
        const box = await page.locator(`[data-id="${video.nodeId}"]`).boundingBox()
        return box ? box.y + box.height : Infinity
      }).toBeLessThanOrEqual(920)
    }
    await text.click()
    await page.screenshot({ path: join(tmpdir(), 'vis-ux1/canvas.png'), fullPage: true })
    await page.setViewportSize({ width: 1280, height: 800 })
  }, 30_000)

  describe('Canvas context menu', () => {
    const menu = () => page.getByRole('menu', { name: '画布右键菜单', exact: true })
    const node = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`)

    async function resetCanvas() {
      const nodes = await admin.nodes()
      if (nodes.length) await admin.call('canvas.apply', { requestId: `context-reset-${crypto.randomUUID()}`, ops: nodes.map(n => ({ op: 'node.delete', nodeId: n.nodeId })) })
      // Earlier tests may leave the session panel collapsed
      await page.evaluate(() => localStorage.removeItem('vis.session.collapsed'))
      await page.reload()
      await page.waitForSelector('.react-flow__pane')
      await expect.poll(() => page.locator('.react-flow__node').count()).toBe(0)
    }

    async function canvasPoint(x: number, y: number) {
      return page.evaluate(({ x, y }) => {
        const bounds = document.querySelector('.react-flow')!.getBoundingClientRect()
        const viewport = document.querySelector('.react-flow__viewport')!
        const point = new DOMPoint(x - bounds.x, y - bounds.y).matrixTransform(new DOMMatrix(getComputedStyle(viewport).transform).inverse())
        return { x: Math.round(point.x), y: Math.round(point.y) }
      }, { x, y })
    }

    beforeEach(resetCanvas)

    it('the blank-space menu creates text, image, video, and audio generation at the right-click position', async () => {
      for (const [name, kind] of [['新建文本', 'text'], ['生图', 'image'], ['生视频', 'video'], ['生音频', 'audio']] as const) {
        await expect.poll(() => page.evaluate(() => Boolean(document.elementFromPoint(280, 220)?.closest('.react-flow__pane')))).toBe(true)
        const at = await canvasPoint(280, 220)
        await page.mouse.click(280, 220, { button: 'right' })
        await menu().waitFor()
        for (const label of ['新建文本', '生图', '生视频', '生音频']) await menu().getByRole('menuitem', { name: label, exact: true }).waitFor()
        expect(await menu().getByRole('menuitem', { name: /^粘贴/ }).isDisabled()).toBe(true)
        await menu().getByRole('menuitem', { name, exact: true }).click()
        const [created] = await until(admin.nodes, nodes => nodes.length === 1)
        expect(created).toMatchObject({ kind, ...at, w: kind === 'audio' ? 360 : kind === 'text' ? 560 : 320, h: kind === 'audio' ? 140 : kind === 'text' ? 420 : kind === 'image' ? 320 : 180 })
        expect(created.slots).toMatchObject(kind === 'text'
          ? [{ slotKey: 'main', content: { type: 'text', body: '' } }]
          : [{ slotKey: 'main', content: { type: 'empty' } }, { slotKey: 'prompt', content: { type: 'text', body: '' } }])
        expect(await menu().count()).toBe(0)
        // RPC responses may precede rendering of creation events; confirm the node appears before waiting for an empty canvas after deletion.
        await node(created.nodeId).waitFor()
        await admin.call('canvas.apply', { requestId: `context-delete-${crypto.randomUUID()}`, ops: [{ op: 'node.delete', nodeId: created.nodeId }] })
        await expect.poll(() => page.locator('.react-flow__node').count()).toBe(0)
      }
    })

    it('node-menu copy and paste preserve content snapshots, offset copies by 40, and allow deletion', async () => {
      const body = '右键复制的文字\n保留第二行'
      const { idMap } = await admin.call('canvas.apply', { requestId: `context-source-${crypto.randomUUID()}`, ops: [{ op: 'node.create', tempId: 'source', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: body } }] })
      const [source] = await admin.nodes()
      await node(idMap.source).waitFor()
      await fitCanvas()
      await node(source.nodeId).locator('.vis-node-label').click({ button: 'right' })
      for (const name of [/^复制/, /^粘贴/, /^创建副本/, /^删除/, /^作为参考发给 Agent$/, /^以它为参考生成/, /^下载$/]) {
        expect(await menu().getByRole('menuitem', { name }).isVisible()).toBe(true)
      }
      await menu().getByRole('menuitem', { name: /^复制/ }).click()
      await admin.call('canvas.apply', { requestId: `context-change-${crypto.randomUUID()}`, ops: [{ op: 'slot.setText', slotId: source.slots[0].slotId, body: '复制后修改', expectedRevision: source.slots[0].revision }] })
      const at = await canvasPoint(100, 150)
      await page.mouse.click(100, 150, { button: 'right' })
      await menu().getByRole('menuitem', { name: /^粘贴/ }).click()
      const pasted = (await until(admin.nodes, nodes => nodes.length === 2)).find(n => n.nodeId !== source.nodeId)
      expect(pasted).toMatchObject({ kind: 'text', ...at, w: source.w, h: source.h, slots: [{ content: { type: 'text', body } }] })
      expect(pasted.slots[0].slotId).not.toBe(source.slots[0].slotId)

      await node(source.nodeId).locator('.vis-node-label').click({ button: 'right' })
      await menu().getByRole('menuitem', { name: /^创建副本/ }).click()
      const duplicate = (await until(admin.nodes, nodes => nodes.length === 3)).find(n => ![source.nodeId, pasted.nodeId].includes(n.nodeId))
      expect(duplicate).toMatchObject({ x: source.x + 40, y: source.y + 40, slots: [{ content: { type: 'text', body: '复制后修改' } }] })
      await node(duplicate.nodeId).locator('.vis-node-label').click({ button: 'right' })
      await menu().getByRole('menuitem', { name: /^删除/ }).click()
      await until(admin.nodes, nodes => nodes.length === 2 && !nodes.some(n => n.nodeId === duplicate.nodeId))
      await expect.poll(() => node(duplicate.nodeId).count()).toBe(0)
    })

    it('Ctrl and Cmd C/V/D copy selected nodes and remap references between copies', async () => {
      for (const modifier of ['Control', 'Meta']) {
        if (modifier === 'Meta') await resetCanvas()
        const { idMap } = await admin.call('canvas.apply', {
          requestId: `context-linked-${crypto.randomUUID()}`,
          ops: [
            { op: 'node.create', tempId: 'text', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: `${modifier} 参考内容` } },
            { op: 'node.create', tempId: 'image', kind: 'image', x: 400, y: 80, w: 320, h: 320, prompt: '保留提示词', inputNodeIds: ['text'] },
          ],
        })
        await node(idMap.image).waitFor()
        await fitCanvas()
        await node(idMap.text).locator('.vis-node-label').click()
        if (modifier === 'Control') {
          const textBox = (await node(idMap.text).boundingBox())!
          const imageBox = (await node(idMap.image).boundingBox())!
          await page.keyboard.down('Shift')
          await page.mouse.move(textBox.x - 15, textBox.y - 35)
          await page.mouse.down()
          await page.mouse.move(imageBox.x + imageBox.width + 15, imageBox.y + imageBox.height + 15, { steps: 8 })
          await page.mouse.up()
          await page.keyboard.up('Shift')
        } else {
          await node(idMap.image).locator('.vis-node-label').click({ modifiers: ['ControlOrMeta'] })
        }
        await expect.poll(() => page.locator('.react-flow__node.selected').count()).toBe(2)
        await page.keyboard.press(`${modifier}+C`)
        if (modifier === 'Control') {
          const box = (await node(idMap.text).boundingBox())!
          await page.mouse.click(box.x + box.width + 20, box.y + 100, { button: 'right' })
          await menu().getByRole('menuitem', { name: /^复制/ }).click()
        }
        await page.keyboard.press(`${modifier}+V`)
        const pasted = (await until(admin.nodes, nodes => nodes.length === 4)).filter(n => !Object.values(idMap).includes(n.nodeId))
        const text = pasted.find(n => n.kind === 'text')
        const image = pasted.find(n => n.kind === 'image')
        expect(text.slots[0].content).toEqual({ type: 'text', body: `${modifier} 参考内容` })
        expect(image.slots.find((s: any) => s.slotKey === 'prompt').content).toEqual({ type: 'text', body: '保留提示词' })
        expect(image.inputs).toEqual([text.nodeId])
        expect(image.x - text.x).toBe(400)
        expect(image.y - text.y).toBe(80)
        await page.locator(`.react-flow__edge[data-id="input-${text.nodeId}-${image.nodeId}"]`).waitFor()
        await expect.poll(() => page.locator('.react-flow__node.selected').count()).toBe(2)
        await page.keyboard.press(`${modifier}+D`)
        const duplicated = (await until(admin.nodes, nodes => nodes.length === 6)).filter(n => ![...Object.values(idMap), ...pasted.map(n => n.nodeId)].includes(n.nodeId))
        const duplicateText = duplicated.find(n => n.kind === 'text')
        const duplicateImage = duplicated.find(n => n.kind === 'image')
        expect(duplicateText).toMatchObject({ x: text.x + 40, y: text.y + 40, slots: [{ content: text.slots[0].content }] })
        expect(duplicateImage).toMatchObject({ x: image.x + 40, y: image.y + 40, inputs: [duplicateText.nodeId] })
      }
    })

    it('sending references to an agent affects only the open session; list mode does not select one automatically', async () => {
      const { idMap } = await admin.call('canvas.apply', { requestId: `context-reference-${crypto.randomUUID()}`, ops: [{ op: 'node.create', tempId: 'source', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: '右键发送的参考' } }] })
      await node(idMap.source).waitFor()
      await showWorkspaces()
      await fitCanvas()
      await node(idMap.source).locator('.vis-node-label').click({ button: 'right' })
      await menu().getByRole('menuitem', { name: '作为参考发给 Agent', exact: true }).click()
      expect(await page.getByRole('region', { name: '工作区', exact: true }).isVisible()).toBe(true)
      expect(await page.locator('.vis-composer').count()).toBe(0)
      await openSession('Codex 3')
      expect(await page.locator('.vis-composer .vis-ref-thumb').count()).toBe(0)
      await page.getByRole('button', { name: '收起会话面板', exact: true }).click()
      await page.locator('.vis-session-rail').waitFor()
      await node(idMap.source).locator('.vis-node-label').click({ button: 'right' })
      await menu().getByRole('menuitem', { name: '作为参考发给 Agent', exact: true }).click()
      await page.getByRole('button', { name: '收起会话面板', exact: true }).waitFor()
      await expect.poll(() => page.locator('.vis-composer .vis-ref-thumb').count()).toBe(1)
      expect(await page.locator('.vis-composer .vis-ref-text').textContent()).toBe('右键发送的参考')
      const before = await page.locator('.vis-item.is-assistant').count()
      await page.fill('.vis-composer textarea', '右键引用')
      await page.locator('.vis-composer textarea').press('Enter')
      await expect.poll(() => page.locator('.vis-item.is-assistant:not(.is-streaming)').count(), { timeout: 10_000 }).toBe(before + 1)
      expect(await page.locator('.vis-item.is-assistant').last().locator('.vis-message-markdown').textContent()).toBe('收到：右键引用（引用 1 个节点）')
    })

    it('the reference-generation submenu creates image, video, and audio input edges and saves a menu screenshot', async () => {
      const { idMap } = await admin.call('canvas.apply', { requestId: `context-extend-${crypto.randomUUID()}`, ops: [{ op: 'node.create', tempId: 'source', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: '雨中的霓虹街道' } }] })
      await node(idMap.source).waitFor()
      for (const [name, kind] of [['生图', 'image'], ['生视频', 'video'], ['生音频', 'audio']] as const) {
        const before = await admin.nodes()
        await fitCanvas()
        await node(idMap.source).locator('.vis-node-label').click({ button: 'right' })
        await menu().getByRole('menuitem', { name: /^以它为参考生成/ }).click()
        const submenu = page.getByRole('menu', { name: '以它为参考生成', exact: true })
        await submenu.waitFor()
        expect(await submenu.getByRole('menuitem', { name: '生图', exact: true }).isVisible()).toBe(true)
        expect(await submenu.getByRole('menuitem', { name: '生视频', exact: true }).isVisible()).toBe(true)
        expect(await submenu.getByRole('menuitem', { name: '生音频', exact: true }).isVisible()).toBe(true)
        if (kind === 'video') await page.screenshot({ path: join(tmpdir(), 'vis-context-menu.png'), fullPage: true })
        await submenu.getByRole('menuitem', { name, exact: true }).click()
        const created = (await until(admin.nodes, nodes => nodes.length === before.length + 1)).find(n => !before.some(b => b.nodeId === n.nodeId))
        expect(created).toMatchObject({ kind, inputs: [idMap.source], slots: [{ slotKey: 'main', content: { type: 'empty' } }, { slotKey: 'prompt', content: { type: 'text', body: '' } }] })
        await page.locator(`.react-flow__edge[data-id="input-${idMap.source}-${created.nodeId}"]`).waitFor()
      }
      console.info('Context menu screenshot:', join(tmpdir(), 'vis-context-menu.png'))
    })

    it('text downloads use date-based filenames; assets preserve uploaded filenames and original content', async () => {
      const body = '下载内容\n第二行也要保留'
      const { idMap } = await admin.call('canvas.apply', { requestId: `context-download-${crypto.randomUUID()}`, ops: [{ op: 'node.create', tempId: 'text', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: body } }] })
      await node(idMap.text).waitFor()
      await fitCanvas()
      await node(idMap.text).locator('.vis-node-label').click({ button: 'right' })
      const [textDownload] = await Promise.all([page.waitForEvent('download'), menu().getByRole('menuitem', { name: '下载', exact: true }).click()])
      expect(textDownload.suggestedFilename()).toBe(`文本-${new Date().toISOString().slice(0, 10)}.txt`)
      expect(readFileSync((await textDownload.path())!, 'utf8')).toBe(body)
      const png = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=48x32', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-'])
      const at = await canvasPoint(100, 150)
      await page.mouse.click(100, 150, { button: 'right' })
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menu().getByRole('menuitem', { name: '上传…', exact: true }).click()])
      await chooser.setFiles({ name: '右键素材.png', mimeType: 'image/png', buffer: png })
      const image = (await until(admin.nodes, nodes => nodes.length === 2)).find(n => n.kind === 'image')
      expect(image).toMatchObject(at)
      await admin.call('canvas.apply', { requestId: `context-media-layout-${crypto.randomUUID()}`, ops: [{ op: 'node.layout', nodeId: image.nodeId, x: 400, y: 0 }] })
      // The node is already on the page, so waitFor returns immediately; wait for its new position before fitting the canvas, or the viewport uses its old position and places it under the session panel
      await expect.poll(() => node(image.nodeId).evaluate(el => (el as HTMLElement).style.transform)).toContain('translate(400px, 0px)')
      await fitCanvas()
      await node(image.nodeId).locator('.vis-node-label').click({ button: 'right' })
      const [imageDownload] = await Promise.all([page.waitForEvent('download'), menu().getByRole('menuitem', { name: '下载', exact: true }).click()])
      expect(imageDownload.suggestedFilename()).toBe('右键素材.png')
      expect(readFileSync((await imageDownload.path())!)).toEqual(png)
    })

    it('menus scroll in short windows; scrolling the canvas closes the menu', async () => {
      const { idMap } = await admin.call('canvas.apply', { requestId: `context-small-${crypto.randomUUID()}`, ops: [{ op: 'node.create', tempId: 'text', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: '矮窗口菜单' } }] })
      await page.setViewportSize({ width: 1280, height: 240 })
      try {
        await node(idMap.text).waitFor()
        await fitCanvas()
        await node(idMap.text).locator('.vis-node-text-body').click({ button: 'right' })
        const bounds = (await menu().boundingBox())!
        expect(bounds.y).toBeGreaterThanOrEqual(0)
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(240)
        expect(await menu().evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
        await menu().hover()
        await page.mouse.wheel(0, 400)
        await expect.poll(() => menu().evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        expect(await menu().isVisible()).toBe(true)
        await page.mouse.move(20, 100)
        await page.mouse.wheel(0, -100)
        await expect.poll(() => menu().count()).toBe(0)
      } finally {
        await page.setViewportSize({ width: 1280, height: 800 })
      }
    })

    it('text, prompt, and session inputs do not intercept Ctrl/Cmd C/V/D', async () => {
      if (!(await page.locator('.vis-composer textarea').isVisible())) {
        const { sessions } = await admin.call('session.list')
        await openSession(sessions.at(-1).title)
      }
      const { idMap } = await admin.call('canvas.apply', {
        requestId: `context-editable-${crypto.randomUUID()}`,
        ops: [
          { op: 'node.create', tempId: 'text', kind: 'text', x: 0, y: 0, w: 320, h: 200, content: { text: '文本内容' } },
          { op: 'node.create', tempId: 'image', kind: 'image', x: 400, y: 0, w: 320, h: 320, prompt: '提示词内容' },
        ],
      })
      await node(idMap.image).waitFor()
      await fitCanvas()
      await page.evaluate(() => {
        const events: boolean[] = []
        ;(window as any).contextShortcutEvents = events
        document.addEventListener('keydown', event => {
          if ((event.ctrlKey || event.metaKey) && ['c', 'v', 'd'].includes(event.key.toLowerCase()) && (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLElement && event.target.isContentEditable)) {
            queueMicrotask(() => events.push(event.defaultPrevented))
          }
        }, true)
      })
      await node(idMap.text).locator('.vis-node-text-body').dblclick()
      const editors = [page.getByRole('textbox', { name: '文本内容', exact: true }), page.getByRole('textbox', { name: '提示词', exact: true }), page.locator('.vis-composer textarea')]
      for (const [index, editor] of editors.entries()) {
        if (index === 1) {
          await page.keyboard.press('Escape')
          await node(idMap.image).locator('.vis-node-label').click()
        }
        await editor.focus()
        for (const modifier of ['Control', 'Meta']) {
          for (const key of ['C', 'V', 'D']) await editor.press(`${modifier}+${key}`)
        }
      }
      await expect.poll(() => page.evaluate(() => (window as any).contextShortcutEvents)).toEqual(Array(18).fill(false))
      expect((await admin.nodes()).map(n => n.nodeId).sort()).toEqual(Object.values(idMap).sort())
    })
  })

  it('workspace-menu renaming, agent session naming, manual protection, and restoration remain independent', async () => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    try {
      await page.evaluate(() => {
        localStorage.setItem('vis.session.collapsed', 'false')
        localStorage.setItem('vis.session.width', '440')
      })
      await page.reload()
      await page.waitForSelector('.react-flow__pane')
      let { sessions } = await admin.call('session.list')
      while (sessions.length < 3) {
        await createCodexSession(`Codex ${sessions.length + 1}`)
        ;({ sessions } = await admin.call('session.list'))
      }
      const sessionId = sessions.at(-1).sessionId
      const readSession = async () => (await admin.call('session.list')).sessions.find((session: any) => session.sessionId === sessionId)
      const workItemId = (await readSession()).workItemId
      const readWork = async () => (await admin.call('work.get', { workItemId })).item
      if ((await readSession()).queuePaused) await admin.call('session.resumeQueue', { requestId: `naming-resume-${crypto.randomUUID()}`, sessionId })
      await admin.call('session.resetTitle', { requestId: `naming-reset-${crypto.randomUUID()}`, sessionId })
      await openSession((await readSession()).title)
      const card = page.locator('.vis-session-card.is-expanded')
      const title = page.locator('.vis-session-heading strong')
      const originalWorkTitle = (await readWork()).title
      const openMenu = async () => {
        const workTitle = (await readWork()).title
        await page.getByRole('button', { name: `${workTitle}的更多操作`, exact: true }).click()
        return page.getByRole('dialog', { name: `${workTitle}的操作`, exact: true })
      }
      const renameWork = async (name: string | null) => {
        const menu = await openMenu()
        const prompt = page.waitForEvent('dialog')
        const click = menu.getByRole('menuitem', { name: '重命名', exact: true }).click()
        const dialog = await prompt
        expect(dialog.message()).toBe('重命名工作项')
        expect(dialog.defaultValue()).toBe((await readWork()).title)
        if (name === null) await dialog.dismiss()
        else await dialog.accept(name)
        await click
      }
      const nameWithAgent = async (name: string) => {
        const message = `命名检查：${name}`
        const { items: previousItems } = await admin.call('session.getTranscript', { sessionId, limit: 100 })
        const before = previousItems.filter((item: any) => item.kind === 'assistant_text').length
        await expect.poll(() => card.locator('.vis-item.is-assistant:not(.is-streaming)').count()).toBe(before)
        await card.locator('.vis-composer textarea').fill(message)
        await card.locator('.vis-composer textarea').press('Enter')
        await expect.poll(() => card.locator('.vis-item.is-assistant:not(.is-streaming)').count(), { timeout: 10_000 }).toBe(before + 1)
        await expect.poll(() => card.locator('.vis-item.is-assistant:not(.is-streaming)').last().locator('.vis-message-markdown').textContent(), { timeout: 10_000 }).toBe(`收到：${message}`)
        await expect.poll(async () => (await readSession()).activeTurnId).toBeNull()
        const { items } = await admin.call('session.getTranscript', { sessionId })
        const result = items.filter((item: any) => item.kind === 'tool_result').at(-1)
        expect(result.payload.isError).toBe(false)
        return JSON.parse(result.payload.text)
      }

      const menu = await openMenu()
      await menu.getByRole('menuitem', { name: '打开目录', exact: true }).waitFor()
      await menu.getByRole('menuitem', { name: '复制目录路径', exact: true }).waitFor()
      expect(await menu.getByRole('menuitem', { name: '交给 Agent 命名', exact: true }).count()).toBe(0)
      await page.keyboard.press('Escape')
      expect(await nameWithAgent('雨夜街道分镜')).toMatchObject({ applied: true, title: '雨夜街道分镜', requestId: expect.any(String) })
      expect(await readSession()).toMatchObject({ title: '雨夜街道分镜', titleSource: 'agent' })
      expect(await title.textContent()).toBe(originalWorkTitle)
      expect(await page.locator('[title="由 Agent 命名"]').count()).toBe(0)
      await expectWorkspaceCount(3, '雨夜街道分镜')
      await page.screenshot({ path: join(tmpdir(), 'vis-l/three-sessions-agent-title.png'), animations: 'disabled' })

      await renameWork('城市漫游手稿')
      await expect.poll(() => title.textContent()).toBe('城市漫游手稿')
      expect(await readWork()).toMatchObject({ title: '城市漫游手稿' })
      expect(await readSession()).toMatchObject({ title: '雨夜街道分镜', titleSource: 'agent' })
      await page.reload()
      await openSession('雨夜街道分镜')
      expect(await title.textContent()).toBe('城市漫游手稿')
      await renameWork(null)
      expect(await title.textContent()).toBe('城市漫游手稿')
      expect(await readWork()).toMatchObject({ title: '城市漫游手稿' })
      await page.screenshot({ path: join(tmpdir(), 'vis-l/work-title-menu.png'), animations: 'disabled' })

      // Session naming was removed from the header; verify manual-name protection and restoration through the same RPC.
      await admin.call('session.rename', { requestId: `naming-user-${crypto.randomUUID()}`, sessionId, title: '城市漫游终稿' })
      expect(await nameWithAgent('午夜霓虹分镜')).toMatchObject({ applied: false, reason: 'user_named', title: '城市漫游终稿' })
      expect(await readSession()).toMatchObject({ title: '城市漫游终稿', titleSource: 'user' })
      await admin.call('session.resetTitle', { requestId: `naming-restore-${crypto.randomUUID()}`, sessionId })
      expect(await readSession()).toMatchObject({ title: '城市漫游终稿', titleSource: 'default', activeTurnId: null })
      expect(await nameWithAgent('午夜霓虹分镜')).toMatchObject({ applied: true, title: '午夜霓虹分镜' })
      expect(await readSession()).toMatchObject({ title: '午夜霓虹分镜', titleSource: 'agent' })
      expect(await title.textContent()).toBe('城市漫游手稿')

      const { idMap } = await admin.call('canvas.apply', {
        requestId: `naming-reference-${crypto.randomUUID()}`,
        ops: [{ op: 'node.create', tempId: 'image', kind: 'image', x: 0, y: 0, w: 320, h: 320, prompt: '雨夜街道' }],
      })
      const image = page.locator(`.react-flow__node[data-id="${idMap.image}"]`)
      await image.waitFor()
      await fitCanvas()
      await image.locator('.vis-node-label').click()
      await page.getByRole('button', { name: '添加参考', exact: true }).click()
      const hint = page.locator('.vis-reference-hint')
      await hint.waitFor()
      await openMenu()
      await page.keyboard.press('Escape')
      expect(await hint.isVisible()).toBe(true)
      await page.locator('.vis-canvas-wrap').focus()
      await page.keyboard.press('Escape')
      await expect.poll(() => hint.count()).toBe(0)
      console.info('Naming screenshot (1600x1000, 2x):', join(tmpdir(), 'vis-l'))
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 })
    }
  })

  it.skipIf(!supportsNativeApprovals)('approvals: cards display separately, collapsed notices expand, and allow/deny resume the turn', async () => {
    await page.setViewportSize({ width: 1600, height: 1000 })
    try {
      await page.evaluate(() => {
        localStorage.setItem('vis.session.collapsed', 'false')
        localStorage.setItem('vis.session.width', '440')
      })
      await page.reload()
      await page.waitForSelector('.react-flow__pane')
      const { sessions } = await admin.call('session.list')
      await createCodexSession(`Codex ${sessions.filter((s: any) => s.agentKind === 'codex').length + 1}`)
      const approvalSession = (await admin.call('session.list')).sessions.at(-1)
      const card = page.locator('.vis-session-card.is-expanded')
      const sendApproval = async () => {
        await card.locator('.vis-composer textarea').fill('审批检查')
        await card.locator('.vis-composer textarea').press('Enter')
        await card.getByRole('region', { name: '待审批：执行命令', exact: true }).waitFor()
      }
      await sendApproval()
      const approval = card.locator('.vis-approval')
      expect(await approval.locator('button').allTextContents()).toEqual(['展开详情', '允许一次', '本会话都允许', '拒绝'])
      expect(await approval.getByRole('button', { name: '本会话都允许', exact: true }).getAttribute('title')).toBe('仅限完全相同的命令')
      expect(await card.locator('.vis-tool-group .vis-approval').count()).toBe(0)
      expect(await approval.locator('.vis-approval-detail').evaluate(el => getComputedStyle(el).webkitLineClamp)).toBe('3')
      await approval.getByRole('button', { name: '展开详情', exact: true }).click()
      expect(await approval.getByRole('button', { name: '收起详情', exact: true }).getAttribute('aria-expanded')).toBe('true')
      await approval.getByRole('button', { name: '收起详情', exact: true }).click()
      await page.screenshot({ path: join(tmpdir(), 'vis-n/approval-pending.png'), animations: 'disabled' })
      await showWorkspaces()
      expect(await page.locator('.vis-conversation').count()).toBe(0)
      await (await workspaceCard(approvalSession.title)).getByText('Codex 等待审批', { exact: true }).waitFor()
      await page.screenshot({ path: join(tmpdir(), 'vis-n/approval-collapsed-badge.png'), animations: 'disabled' })
      await openSession(approvalSession.title)
      await approval.getByRole('button', { name: '允许一次', exact: true }).press('Enter')
      await expect.poll(() => card.locator('.vis-item.is-assistant').last().locator('.vis-message-markdown').textContent()).toBe('已获准')
      await expect.poll(() => card.locator('.vis-approval').count()).toBe(0)
      expect(await card.locator('.vis-approval-handled').textContent()).toContain('已允许 · 执行命令')
      expect(await card.locator('.vis-approval-handled button').count()).toBe(0)
      expect(await card.locator('.vis-approval-badge').count()).toBe(0)
      await page.screenshot({ path: join(tmpdir(), 'vis-n/approval-handled.png'), animations: 'disabled' })

      await sendApproval()
      // Refresh shows the workspace tree; sessions with unloaded records must still show approval notices.
      await createCodexSession('审批观察会话')
      await page.reload()
      await showWorkspaces()
      expect(await page.locator('.vis-conversation').count()).toBe(0)
      await (await workspaceCard(approvalSession.title)).getByText('Codex 等待审批', { exact: true }).waitFor()
      await openSession(approvalSession.title)
      await card.locator('.vis-approval').getByRole('button', { name: '拒绝', exact: true }).click()
      await expect.poll(() => card.locator('.vis-item.is-assistant').last().locator('.vis-message-markdown').textContent()).toBe('已拒绝')
      await expect.poll(() => card.locator('.vis-approval-handled').count()).toBe(2)
      expect(await card.locator('.vis-approval-handled').last().textContent()).toContain('已拒绝')
      expect((await admin.call('session.list')).sessions.find((s: any) => s.sessionId === approvalSession.sessionId).pendingApprovals).toBe(0)

      await sendApproval()
      await card.locator('.vis-approval').getByRole('button', { name: '本会话都允许', exact: true }).click()
      await expect.poll(() => card.locator('.vis-approval-handled').count()).toBe(3)
      await expect.poll(() => card.locator('.vis-item.is-assistant').last().locator('.vis-message-markdown').textContent()).toBe('已获准')
      const { items } = await admin.call('session.getTranscript', { sessionId: approvalSession.sessionId })
      expect(items.filter((item: any) => item.kind === 'approval').map((item: any) => item.payload)).toMatchObject([
        { status: 'approved', decision: 'allow_once' }, { status: 'denied', decision: 'deny' }, { status: 'approved', decision: 'allow_session' },
      ])
      console.info('Approval screenshot (1600x1000, 2x):', join(tmpdir(), 'vis-n'))
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 })
    }
  })

  describe('Projects and workspaces', () => {
    let project: { spaceId: string; name: string; rootPath: string }
    const dialog = () => page.getByRole('dialog', { name: '新建工作区', exact: true })
    const switchProject = async (name: string) => {
      await showWorkspaces()
      await page.getByRole('button', { name: '切换项目', exact: true }).click()
      await page.getByRole('menu', { name: '项目', exact: true }).getByRole('menuitem').filter({ has: page.getByText(name, { exact: true }) }).click()
      await page.waitForSelector('.react-flow__pane')
    }
    const sendAndCheckCwd = async (text: string, workDir: string) => {
      await page.locator('.vis-composer textarea').fill(text)
      await page.locator('.vis-composer textarea').press('Enter')
      await expect.poll(() => agentEvidence(workDir).find(entry => entry.method === 'turn/start' && entry.prompt?.startsWith(text))).toMatchObject({ cwd: realpathSync(workDir) })
      expect(agentEvidence(workDir).find(entry => entry.method === 'thread/start' && entry.threadCwd === workDir)).toMatchObject({ cwd: realpathSync(workDir) })
      await expect.poll(() => page.locator('.vis-session-card.is-expanded .vis-item.is-assistant:not(.is-streaming)').last().locator('.vis-message-markdown').textContent(), { timeout: 10_000 }).toBe(`收到：${text}`)
    }

    it('new projects show an empty canvas; switching back preserves nodes and workspaces', async () => {
      await page.setViewportSize({ width: 1600, height: 1000 })
      const original = (await admin.call('space.list')).spaces.find((space: any) => space.spaceId === admin.spaceId)
      const nodeIds = (await admin.nodes()).map(node => node.nodeId).sort()
      await showWorkspaces()
      const sessionTitles = await page.locator('.vis-work-card-title').allTextContents()
      expect(nodeIds.length).toBeGreaterThan(0)
      await page.getByRole('button', { name: '切换项目', exact: true }).click()
      await page.getByRole('menuitem', { name: '＋ 新建项目', exact: true }).click()
      const create = page.getByRole('dialog', { name: '新建项目', exact: true })
      await create.getByLabel('项目名称', { exact: true }).fill('工作区隔离测试')
      await create.getByLabel('项目位置', { exact: true }).fill(join(projectsDir, 'm-project'))
      await create.getByRole('button', { name: '暂不创建', exact: true }).click()
      expect(await create.getByRole('button', { name: '暂不创建', exact: true }).getAttribute('aria-pressed')).toBe('true')
      await create.getByRole('button', { name: '创建项目', exact: true }).click()
      await expect.poll(() => page.getByRole('button', { name: '切换项目', exact: true }).textContent()).toContain('工作区隔离测试')
      await expect.poll(() => page.locator('.react-flow__node').count()).toBe(0)
      expect(await page.locator('.vis-session-card').count()).toBe(0)
      project = (await admin.call('space.list')).spaces.find((space: any) => space.name === '工作区隔离测试')
      expect(project.rootPath).toBe(join(projectsDir, 'm-project'))
      expect(existsSync(join(project.rootPath, 'assets'))).toBe(true)
      const skillDir = join(project.rootPath, 'skills', 'e2e-story')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: e2e-story\ndescription: 整理清晨街道的三镜分镜\n---\n请先阅读参考素材，再整理分镜。\n')
      await page.getByRole('button', { name: '切换项目', exact: true }).click()
      await page.screenshot({ path: join(tmpdir(), 'vis-m/project-dropdown.png'), animations: 'disabled' })
      await page.keyboard.press('Escape')
      await switchProject(original.name)
      await expect.poll(() => page.locator('.react-flow__node').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')).sort())).toEqual(nodeIds)
      await expect.poll(() => page.locator('.vis-work-card-title').allTextContents()).toEqual(sessionTitles)
      await switchProject(project.name)
      await admin.call('events.subscribe', { spaceId: project.spaceId })
    })

    it('creating a project can select an agent at the same time, producing the canvas and first workspace session in one step', async () => {
      const previous = project
      try {
        await page.getByRole('button', { name: '切换项目', exact: true }).click()
        await page.getByRole('menuitem', { name: '＋ 新建项目', exact: true }).click()
        const create = page.getByRole('dialog', { name: '新建项目', exact: true })
        await create.getByLabel('项目名称', { exact: true }).fill('一步创建')
        await create.getByLabel('项目位置', { exact: true }).fill(join(projectsDir, 'one-step'))
        await create.getByRole('button', { name: 'Codex', exact: true }).click()
        await create.getByRole('button', { name: '创建项目', exact: true }).click()
        await expect.poll(() => page.getByRole('button', { name: '切换项目', exact: true }).textContent()).toContain('一步创建')
        // Project selection renders before its first workspace; wait for the composer before checking the single-step result.
        await page.getByRole('textbox', { name: '给 Agent 发消息', exact: true }).waitFor()
        await expect.poll(() => page.getByRole('textbox', { name: '给 Agent 发消息', exact: true }).count()).toBe(1)
      } finally {
        await page.keyboard.press('Escape')
        await switchProject(previous.name)
        await admin.call('events.subscribe', { spaceId: previous.spaceId })
      }
    })

    it('blank names still create directories under project workspaces; agent cwd matches the backend workspace', async () => {
      await page.getByRole('button', { name: '开始创作', exact: true }).click()
      expect(await dialog().getByLabel('工作区名称（可选）', { exact: true }).inputValue()).toBe('')
      expect(await dialog().getByRole('radio', { name: '在项目内新建', exact: true }).isChecked()).toBe(true)
      await expect.poll(() => dialog().locator('.vis-dialog-skills summary').textContent()).toBe('1 个 Skill')
      await page.screenshot({ path: join(tmpdir(), 'vis-m/new-workspace-new-directory.png'), animations: 'disabled' })
      await dialog().getByRole('button', { name: '创建工作区', exact: true }).click()
      await expect.poll(() => page.locator('.vis-session-card').count()).toBe(1)
      const [session] = (await admin.call('session.list')).sessions
      expect(session).toMatchObject({ title: 'Codex 1', titleSource: 'default' })
      expect(dirname(session.workDir)).toBe(join(project.rootPath, 'workspaces'))
      expect(existsSync(session.workDir)).toBe(true)
      expect((await admin.call('work.get', { workItemId: session.workItemId })).item.workDir).toBe(session.workDir)
      await sendAndCheckCwd('检查空名称工作区目录', session.workDir)
    })

    it('existing directories use the local picker; the workspace and agent use the selected directory', async () => {
      const existingDir = join(projectsDir, 'existing-project')
      await showWorkspaces()
      await page.getByRole('button', { name: '开始创作', exact: true }).click()
      await dialog().getByLabel('工作区名称（可选）', { exact: true }).fill('已有目录工作区')
      await dialog().getByRole('radio', { name: '使用已有目录', exact: true }).check()
      await dialog().getByRole('button', { name: '选择目录', exact: true }).click()
      await expect.poll(() => dialog().getByLabel('已有目录', { exact: true }).inputValue()).toBe(existingDir)
      await page.screenshot({ path: join(tmpdir(), 'vis-m/new-workspace-existing-directory.png'), animations: 'disabled' })
      await dialog().getByRole('button', { name: '创建工作区', exact: true }).click()
      await dialog().waitFor({ state: 'hidden' })
      await expectWorkspaceCount(2, '已有目录工作区')
      const session = (await admin.call('session.list')).sessions.find((session: any) => session.title === '已有目录工作区')
      expect(session.workDir).toBe(existingDir)
      expect((await admin.call('work.get', { workItemId: session.workItemId })).item.workDir).toBe(existingDir)
      await sendAndCheckCwd('检查已有工作区目录', existingDir)
      await page.screenshot({ path: join(tmpdir(), 'vis-m/workspace-directory-card.png'), animations: 'disabled' })
    })

    it('create more keeps the dialog open and clears the name; the workspace uses the project directory', async () => {
      await showWorkspaces()
      await page.getByRole('button', { name: '开始创作', exact: true }).click()
      await dialog().getByLabel('工作区名称（可选）', { exact: true }).fill('连续创建的工作区')
      await dialog().getByRole('checkbox', { name: '创建更多', exact: true }).check()
      await dialog().getByRole('button', { name: '创建工作区', exact: true }).click()
      await expect.poll(async () => (await admin.call('work.list')).items.length).toBe(3)
      expect(await dialog().isVisible()).toBe(true)
      await expect.poll(() => dialog().getByLabel('工作区名称（可选）', { exact: true }).inputValue()).toBe('')
      expect(await dialog().getByLabel('工作区名称（可选）', { exact: true }).evaluate(input => input === document.activeElement)).toBe(true)
      const session = (await admin.call('session.list')).sessions.find((session: any) => session.title === '连续创建的工作区')
      expect(session.workDir).toBe(join(project.rootPath, 'workspaces', '连续创建的工作区'))
      await dialog().press('Escape')
      expect(await dialog().count()).toBe(0)
    })

    it('selecting a Skill with slash shows a message chip and passes its SKILL.md path to the agent prompt', async () => {
      const skillPath = realpathSync(join(project.rootPath, 'skills', 'e2e-story', 'SKILL.md'))
      const composer = page.locator('.vis-composer textarea')
      await composer.fill('/e2e')
      const list = page.getByRole('listbox', { name: 'Skill', exact: true })
      await list.waitFor()
      expect(await list.getByRole('option').count()).toBe(1)
      expect(await list.getByRole('option').textContent()).toContain('整理清晨街道的三镜分镜')
      await page.screenshot({ path: join(tmpdir(), 'vis-m/slash-skill-list.png'), animations: 'disabled' })
      await composer.press('Enter')
      expect(await composer.inputValue()).toBe('')
      expect(await page.locator('.vis-composer .vis-skill-chip').getAttribute('title')).toBe(skillPath)
      const session = (await admin.call('session.list')).sessions.find((session: any) => session.title === '连续创建的工作区')
      const text = '用技能整理清晨三镜'
      await sendAndCheckCwd(text, session.workDir)
      expect(await page.locator('.vis-item.is-user .vis-skill-chip').textContent()).toBe('/e2e-story')
      expect(await page.locator('.vis-composer .vis-skill-chip').count()).toBe(0)
      expect(agentEvidence(session.workDir).find(entry => entry.method === 'turn/start' && entry.prompt?.startsWith(text)).prompt).toContain(JSON.stringify(skillPath))
      const { items } = await admin.call('session.getTranscript', { sessionId: session.sessionId })
      expect(items.find((item: any) => item.kind === 'user').payload.skills).toEqual(['e2e-story'])
      await page.reload()
      await openSession(session.title)
      await page.locator('.vis-item.is-user .vis-skill-chip').waitFor()
      expect(await page.locator('.vis-item.is-user .vis-skill-chip').textContent()).toBe('/e2e-story')
      console.info('Projects and workspaces screenshot (1600x1000, 2x); agent cwd / prompt: agent-evidence.jsonl:', join(tmpdir(), 'vis-m'))
    })
  })

})
