// Real gateway, browser and Codex adapter; all agent replies and generation are local fakes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ApprovalPayload, NodeView, WorkItemView } from '@vis/protocol'
import { createMockProvider } from '../../../packages/generation/src/index'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = join(root, 'apps/cli/dist/vis.mjs')
const ready = existsSync(chromePath()) && existsSync(cli) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const shots = '/tmp/vis-next/rfc34'
const rid = () => crypto.randomUUID()
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let spaceId: string
const errors: string[] = []
const detail = async (workItemId: string): Promise<WorkItemView> => (await admin.call('work.get', { workItemId })).item
const board = () => page.getByRole('region', { name: 'Work board', exact: true })
const card = () => page.getByRole('region', { name: 'Approval pending: Delete child work items', exact: true })
const send = (sessionId: string, value: object) => admin.call('session.sendMessage', { requestId: rid(), sessionId, text: `工作代理检查：${JSON.stringify(value)}`, refs: [] })
const live = async (): Promise<WorkItemView[]> => (await admin.call('work.list')).items
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get')).nodes

async function request(sessionId: string, workItemIds: string[]) {
  await send(sessionId, { scenario: 'request-delete', workItemIds })
  await expect.poll(async () => (await admin.call('session.getTranscript', { sessionId })).items.filter(item => item.kind === 'approval').length, { timeout: 15_000 }).toBe(1)
  await expect.poll(async () => (await admin.call('session.list')).sessions.find(session => session.sessionId === sessionId)?.activeTurnId).toBeNull()
  return (await admin.call('session.getTranscript', { sessionId })).items.find(item => item.kind === 'approval')!.payload as ApprovalPayload
}

async function openSession(title: string) {
  await page.getByRole('listitem', { name: new RegExp(`^${title},`) }).click()
}

async function showBoard() {
  await page.getByRole('tab', { name: 'Board', exact: true }).click()
  await board().waitFor()
}

async function expectBoardTitles(titles: string[]) {
  for (const title of titles) await board().getByRole('listitem', { name: new RegExp(`^${title},`) }).waitFor()
}

describe.skipIf(!ready)('Agent-requested work cleanup acceptance', () => {
  beforeAll(async () => {
    vi.setConfig({ expect: { poll: { timeout: 5000 } } })
    mkdirSync(shots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-work-cleanup-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'work-cleanup-e2e', secretStore: createMemorySecretStore(), providers: [createMockProvider({ latencyMs: 600_000 })], defaults: { image: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) } })
    spaceId = daemon.spaces.create('Child cleanup acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(8000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
  })
  afterEach(async ({ task }) => {
    if (task.result?.state !== 'fail') return
    await page.screenshot({ path: join(shots, 'failure.png'), animations: 'disabled' })
    writeFileSync(join(shots, 'failure.json'), JSON.stringify(await Promise.all((await live()).map(async item => ({ item, transcript: await admin.call('session.getTranscript', { sessionId: item.sessions[0]!.sessionId }), evidence: existsSync(join(item.workDir, '.vis-e2e-agent.jsonl')) ? readFileSync(join(item.workDir, '.vis-e2e-agent.jsonl'), 'utf8') : '' }))), null, 2))
  })
  afterAll(async () => {
    await browser?.close(); admin?.close(); await host?.close(); await daemon?.stop('user_quit')
    vi.unstubAllEnvs(); vi.resetConfig(); if (dir) removeTempDir(dir)
  })

  it('shows consequences from a fake Codex request, approves once, removes children from the board and keeps their canvas results', async () => {
    const { item: parent } = await admin.call('work.create', { requestId: rid(), title: 'Cleanup director', chat: { agentKind: 'codex' } })
    await admin.call('session.setApprovalMode', { requestId: rid(), sessionId: parent.sessions[0]!.sessionId, mode: 'auto' })
    const titles = ['Running exploration', 'Unanswered exploration', 'Unreviewed exploration']
    await send(parent.sessions[0]!.sessionId, { scenario: 'dispatch', children: titles.map((title, index) => ({ title, script: { scenario: ['cleanup-hold', 'question', 'done'][index] } })) })
    await expect.poll(async () => (await live()).filter(item => item.parentId === parent.workItemId).length, { timeout: 15_000 }).toBe(3)
    await expect.poll(async () => (await live()).find(item => item.title === titles[1])?.unresolvedCount, { timeout: 15_000 }).toBe(1)
    await expect.poll(async () => (await live()).find(item => item.title === titles[2])?.status).toBe('in_review')
    await expect.poll(async () => (await admin.call('runtime.activity')).activeJobs).toBe(1)
    await expect.poll(async () => (await detail(parent.workItemId)).sessions[0]!.activeTurnId).toBeNull()
    const children = (await live()).filter(item => item.parentId === parent.workItemId)
    const before = await nodes()
    expect(before.length).toBeGreaterThanOrEqual(2)
    const approval = await request(parent.sessions[0]!.sessionId, children.map(child => child.workItemId))
    expect(approval).toMatchObject({ status: 'pending', kind: 'work_delete', workDelete: { runningTurns: 1, unfinishedJobs: 1, unresolvedMessages: 1, hasUnreviewedReport: true } })
    await openSession('Cleanup director')
    await card().waitFor()
    for (const title of titles) expect(await card().getByRole('listitem').allTextContents()).toContain(title)
    for (const line of ['Running turns to stop: 1', 'Generation jobs to cancel: 1; cancelling is not a refund', 'Unanswered questions to close: 1', 'Includes reports not yet reviewed', 'Canvas content and assets stay.']) expect(await card().innerText()).toContain(line)
    expect(await card().getByRole('button').allTextContents()).toEqual(['Delete', 'Keep'])
    const region = (await card().boundingBox())!, remove = (await card().getByRole('button', { name: 'Delete', exact: true }).boundingBox())!, keep = (await card().getByRole('button', { name: 'Keep', exact: true }).boundingBox())!
    expect(region.x).toBeGreaterThanOrEqual(0)
    expect(region.y).toBeGreaterThanOrEqual(0)
    expect(region.y + region.height).toBeLessThanOrEqual(1000)
    expect(remove.y).toBeGreaterThan(region.y)
    expect(keep.x).toBeGreaterThan(remove.x)
    await page.screenshot({ path: join(shots, 'cleanup-card.png'), animations: 'disabled' })
    await showBoard()
    await expectBoardTitles(titles)
    await card().getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(async () => (await live()).filter(item => item.parentId === parent.workItemId)).toEqual([])
    for (const title of titles) await expect.poll(() => board().getByRole('listitem', { name: new RegExp(`^${title},`) }).count()).toBe(0)
    expect(await nodes()).toEqual(before)
    expect((await detail(parent.workItemId)).sessions[0]!.activeTurnId).toBeNull()
    expect(errors).toEqual([])
  }, 30_000)

  it('keeps children, their running work and canvas when the author chooses Keep', async () => {
    const { item: parent } = await admin.call('work.create', { requestId: rid(), title: 'Keep director', chat: { agentKind: 'codex' } })
    const { item: child } = await admin.call('work.dispatch', { requestId: rid(), parentId: parent.workItemId, title: 'Keep this exploration', brief: '工作代理检查：{"scenario":"hold"}', agentKind: 'codex' })
    await expect.poll(async () => (await detail(child.workItemId)).sessions[0]?.activeTurnId).toBeTruthy()
    const before = await nodes()
    const approval = await request(parent.sessions[0]!.sessionId, [child.workItemId])
    await openSession('Keep director')
    await card().waitFor()
    await card().getByRole('button', { name: 'Keep', exact: true }).click()
    await expect.poll(async () => ((await admin.call('session.getTranscript', { sessionId: parent.sessions[0]!.sessionId })).items.find(item => item.itemId === approval.approvalId)?.payload as ApprovalPayload)?.status).toBe('denied')
    await showBoard()
    await expectBoardTitles([child.title])
    const kept = await detail(child.workItemId)
    expect(kept.archivedAt).toBeNull()
    expect(kept.sessions[0]!.activeTurnId).toBeTruthy()
    expect(await nodes()).toEqual(before)
    expect(errors).toEqual([])
    await admin.call('work.recall', { requestId: rid(), workItemId: child.workItemId })
  })

  it('explains an expired card and removes its controls when approval would stop more turns than shown', async () => {
    const { item: parent } = await admin.call('work.create', { requestId: rid(), title: 'Expiry director', chat: { agentKind: 'codex' } })
    const { item: child } = await admin.call('work.dispatch', { requestId: rid(), parentId: parent.workItemId, title: 'Growing exploration', brief: '工作代理检查：{"scenario":"hold"}', agentKind: 'codex', activate: false })
    const approval = await request(parent.sessions[0]!.sessionId, [child.workItemId])
    expect(approval.workDelete!.runningTurns).toBe(0)
    await openSession('Expiry director')
    await card().waitFor()
    await admin.call('work.activate', { requestId: rid(), workItemId: child.workItemId })
    await expect.poll(async () => (await detail(child.workItemId)).sessions[0]!.activeTurnId).toBeTruthy()
    await card().getByRole('button', { name: 'Delete', exact: true }).click()
    const expired = page.getByRole('region', { name: 'Delete child work items', exact: true })
    await expect.poll(() => expired.innerText()).toContain('Expired')
    expect(await expired.innerText()).toContain('deletion scope and consequences changed')
    expect(await expired.getByRole('button').count()).toBe(0)
    expect((await detail(child.workItemId)).archivedAt).toBeNull()
    expect((await detail(child.workItemId)).sessions[0]!.activeTurnId).toBeTruthy()
    await admin.call('work.recall', { requestId: rid(), workItemId: child.workItemId })
  })
})
