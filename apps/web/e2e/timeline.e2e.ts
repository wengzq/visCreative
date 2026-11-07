import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Edge, ReactFlowState } from '@xyflow/react'
import type { CanvasOp, NodeView, SessionSummary, TimelineDoc, WorkItemView } from '@vis/protocol'
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
const screenshots = join(tmpdir(), 'vis-0024-A3')
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let spaceId: string
let videoAsset: string
let audioAsset: string
let worker: WorkItemView
const errors: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const main = (node: NodeView) => node.slots.find(slot => slot.slotKey === 'main')!
const document = (node: NodeView): TimelineDoc => {
  const content = main(node).content
  if (content.type !== 'timeline') throw new Error('Expected a timeline document')
  return content.doc
}
const card = (title: string) => page.getByRole('region', { name: new RegExp(`^Timeline ${title},`) })
const failureName = (name: string) => `failure-${name.replaceAll(/[^a-z0-9]+/gi, '-')}`
const screenshot = (name: string) => page.screenshot({ path: join(screenshots, `${name}.png`), animations: 'disabled' })

async function captureSourceEdges(name: string, sourceIds: string[], timeline: NodeView) {
  const evidence = await page.evaluate(() => {
    type Fiber = {
      return?: Fiber; child?: Fiber; sibling?: Fiber; stateNode?: unknown
      memoizedProps?: { nodes?: unknown[]; edges?: Edge[]; value?: { getState?: () => Partial<ReactFlowState> } }
    }
    const canvas = window.document.querySelector('.react-flow')!
    const properties = canvas as unknown as Record<string, Fiber>
    let root = properties[Object.keys(canvas).find(key => key.startsWith('__reactFiber$'))!]!
    while (root.return) root = root.return
    root = (root.stateNode as { current: Fiber }).current
    let clientNodes: NodeView[] | undefined
    let computedEdges: Edge[] | undefined
    let flow: Partial<ReactFlowState> | undefined
    // As in timeline-editor's host-identity check, follow the root's current tree: DOM fibers can retain an alternate from an older render.
    const visit = (fiber: Fiber | undefined) => {
      if (!fiber) return
      const props = fiber.memoizedProps
      const first = props?.nodes?.[0] as NodeView | undefined
      if (first?.nodeId && !clientNodes) clientNodes = props!.nodes as NodeView[]
      if (props?.edges && props.nodes && !computedEdges) computedEdges = props.edges
      const state = props?.value?.getState?.()
      if (state?.nodeLookup instanceof Map && Array.isArray(state.edges)) flow = state
      visit(fiber.child)
      visit(fiber.sibling)
    }
    visit(root)
    const edgeViews = (edges: Edge[] | undefined) => edges?.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle })) ?? null
    const renderedEdges = [...window.document.querySelectorAll('.react-flow__edge')].map(element => ({
      id: element.getAttribute('data-id'), label: element.getAttribute('aria-label'), path: element.querySelector('path')?.getAttribute('d'),
    }))
    return {
      clientNodes: clientNodes?.map(({ nodeId, title, inputs }) => ({ nodeId, title, inputs: inputs ?? [] })) ?? null,
      computedEdges: edgeViews(computedEdges),
      storedEdges: edgeViews(flow?.edges),
      renderedEdgeCount: renderedEdges.length,
      renderedEdges,
      internalNodes: flow?.nodeLookup ? [...flow.nodeLookup.values()].map(node => ({
        nodeId: node.id, inputs: (node.data.view as NodeView | undefined)?.inputs ?? [], measured: node.measured,
        controlledMeasured: node.internals.userNode.measured, handleBounds: node.internals.handleBounds ?? null,
      })) : null,
      domNodes: [...window.document.querySelectorAll('.react-flow__node')].map(element => ({
        nodeId: element.getAttribute('data-id'),
        handles: [...element.querySelectorAll('.react-flow__handle')].map(handle => {
          const { x, y, width, height } = handle.getBoundingClientRect()
          return { id: handle.getAttribute('data-handleid'), type: handle.classList.contains('source') ? 'source' : 'target', bounds: { x, y, width, height } }
        }),
      })),
    }
  }).catch(error => ({ captureError: String(error) }))
  writeFileSync(join(screenshots, `${failureName(name)}.edges.json`), JSON.stringify({ sourceIds, timelineNodeId: timeline.nodeId, serverInputs: timeline.inputs, ...evidence }, null, 2))
}

async function fit() {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  let previous = ''
  await expect.poll(async () => {
    const transform = await page.getByRole('region', { name: /^Timeline / }).first().evaluate(element => {
      const viewport = element.closest('.react-flow__viewport')
      return viewport ? getComputedStyle(viewport).transform : ''
    })
    const settled = transform === previous
    previous = transform
    return settled
  }, { intervals: [100] }).toBe(true)
}

async function seedMedia() {
  const created = await apply([
    { op: 'node.create', tempId: 'third', kind: 'video', title: 'Shot 3', x: 40, y: 520, w: 240, h: 135, content: { assetVersionId: videoAsset } },
    { op: 'node.create', tempId: 'first', kind: 'video', title: 'Shot 1', x: 40, y: 40, w: 240, h: 135, content: { assetVersionId: videoAsset } },
    { op: 'node.create', tempId: 'second', kind: 'video', title: 'Shot 2', x: 40, y: 280, w: 240, h: 135, content: { assetVersionId: videoAsset } },
    { op: 'node.create', tempId: 'audio', kind: 'audio', title: 'Music source', x: 420, y: 520, w: 300, h: 140, content: { assetVersionId: audioAsset } },
  ])
  return [created.idMap.first, created.idMap.second, created.idMap.third] as string[]
}

async function scenario(text: string) {
  await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId: worker.sessions[0]!.sessionId, text, refs: [] })
  await expect.poll(async () => {
    const transcript = await admin.call('session.getTranscript', { sessionId: worker.sessions[0]!.sessionId })
    return JSON.stringify(transcript.items)
  }, { timeout: 15_000 }).toContain(`Completed ${text}`)
  await expect.poll(async () => {
    const sessions: SessionSummary[] = (await admin.call('session.list')).sessions
    return sessions.find(session => session.sessionId === worker.sessions[0]!.sessionId)?.activeTurnId
  }).toBeNull()
}

describe.skipIf(!ready)('Timeline canvas and fake Agent', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-timeline-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'timeline-e2e', secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { video: { provider: 'mock' }, audio: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
    })
    spaceId = daemon.spaces.create('Timeline acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const video = join(dir, 'short shot.mp4')
    const audio = join(dir, 'music.wav')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], { shell: false })
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'pcm_s16le', audio], { shell: false })
    const space = daemon.spaces.get(spaceId)!
    videoAsset = space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(video), kind: 'video', mime: 'video/mp4', origin: 'import', width: 160, height: 90, durationMs: 1000 }).assetVersionId
    audioAsset = space.assets.registerVersion(space.db, { staged: await space.assets.stageFile(audio), kind: 'audio', mime: 'audio/wav', origin: 'import', durationMs: 3000 }).assetVersionId
    worker = (await admin.call('work.create', { requestId: crypto.randomUUID(), title: 'Timeline editor', chat: { agentKind: 'codex' } })).item
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor()
  })
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await screenshot(failureName(task.name))
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('creates an empty timeline from the canvas toolbar and disables export', async () => {
    await page.getByRole('button', { name: 'Timeline', exact: true }).click()
    const empty = page.getByText('Add videos, images or audio to this timeline', { exact: true })
    await empty.waitFor()
    expect(await page.getByRole('toolbar', { name: 'Timeline', exact: true }).getByRole('button', { name: 'Export', exact: true }).isDisabled()).toBe(true)
    await screenshot('empty')
    const created = (await nodes()).find(node => node.kind === 'timeline')!
    await apply([{ op: 'node.delete', nodeId: created.nodeId }])
    await expect.poll(() => empty.count()).toBe(0)
  })

  it('orders selected shots, connects sources, exports inline and marks Agent edits out of date', async ({ task }) => {
    const ordered = await seedMedia()
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    // Titles stay outside the players, so selection never starts playback.
    for (const title of ['Shot 3', 'Shot 1', 'Shot 2']) await page.getByText(title, { exact: true }).click({ modifiers: ['ControlOrMeta'] })
    await page.getByText('Shot 1', { exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Create timeline', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.kind === 'timeline').length).toBe(1)
    const timeline = (await nodes()).find(node => node.kind === 'timeline')!
    await apply([{ op: 'node.setMeta', nodeId: timeline.nodeId, title: 'Rough cut' }])
    expect(document(timeline).tracks.find(track => track.kind === 'video')!.clips.map(clip => clip.source.nodeId)).toEqual(ordered)
    expect(timeline.inputs).toEqual(ordered)
    await card('Rough cut').waitFor()
    const clips = card('Rough cut').getByRole('group', { name: 'Video', exact: true }).getByRole('img')
    expect(await clips.allTextContents()).toHaveLength(3)
    expect(await clips.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(['Shot 1, 00:00–00:01', 'Shot 2, 00:01–00:02', 'Shot 3, 00:02–00:03'])
    try {
      for (const nodeId of ordered) await expect.poll(() => page.getByLabel(new RegExp(`connection.*${nodeId}.*${timeline.nodeId}`)).count()).toBe(1)
    } catch (error) {
      await captureSourceEdges(task.name, ordered, timeline).catch(() => {})
      throw error
    }
    expect(await card('Rough cut').getByText('Out of date', { exact: true }).count()).toBe(0)
    await fit()
    await screenshot('first-clip')
    await card('Rough cut').getByText('3 clips · 00:03', { exact: true }).click()
    await page.getByRole('toolbar', { name: 'Timeline', exact: true }).getByRole('button', { name: 'Export', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.exportOf?.timelineNodeId === timeline.nodeId).length, { timeout: 15_000 }).toBe(1)
    const exported = (await nodes()).find(node => node.exportOf?.timelineNodeId === timeline.nodeId)!
    expect(exported.kind).toBe('video')
    expect(exported.x).toBeGreaterThan(timeline.x)
    await card('Rough cut').getByRole('group', { name: 'Latest export', exact: true }).waitFor()
    const exportedContent = main(exported).content
    if (exportedContent.type !== 'asset') throw new Error('Expected exported media')
    await card('Rough cut').getByRole('group', { name: 'Latest export', exact: true }).hover()
    await expect.poll(() => card('Rough cut').getByRole('group', { name: 'Latest export', exact: true }).evaluate(element => element.querySelector('video')?.currentSrc ?? '')).toContain(exportedContent.assetVersionId)
    await expect.poll(() => page.getByLabel(new RegExp(`connection.*${timeline.nodeId}.*${exported.nodeId}`)).count()).toBe(1)
    await screenshot('exported')
    await scenario('timeline-edit')
    await card('Rough cut').getByText('Out of date', { exact: true }).waitFor()
    await screenshot('out-of-date')
    expect(errors).toEqual([])
  }, 30_000)

  it('shows empty, first-clip, exported and out-of-date cards together and downloads the latest export', async () => {
    const live = await nodes()
    const original = live.find(node => node.kind === 'timeline')!
    const sources = live.filter(node => node.kind === 'video' && !node.exportOf).sort((a, b) => a.y - b.y).map(node => node.nodeId)
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'empty', kind: 'timeline', title: 'Empty', x: 0, y: 0 },
      { op: 'node.create', tempId: 'first', kind: 'timeline', title: 'First clip', x: 460, y: 0, content: { timelineFrom: sources } },
      { op: 'node.create', tempId: 'exported', kind: 'timeline', title: 'Exported', x: 0, y: 410, content: { timelineFrom: sources } },
      { op: 'node.layout', nodeId: original.nodeId, x: 460, y: 410 },
      { op: 'node.setMeta', nodeId: original.nodeId, title: 'Outdated' },
      ...live.filter(node => node.kind !== 'timeline').map(node => ({ op: 'node.setMeta' as const, nodeId: node.nodeId, purpose: 'working' as const })),
    ])
    const fresh = (await nodes()).find(node => node.nodeId === idMap.exported)!
    const slot = main(fresh)
    const task = await admin.call('media.process', { requestId: crypto.randomUUID(), operation: 'timeline.export', nodeId: fresh.nodeId, slotId: slot.slotId, expectedRevision: slot.revision, params: {}, waitMs: 30_000 })
    expect(task.status).toBe('succeeded')
    await apply(task.nodeIds.map((nodeId: string) => ({ op: 'node.setMeta', nodeId, purpose: 'working' })))
    await fit()
    await card('Empty').getByText('Add videos, images or audio to this timeline', { exact: true }).waitFor()
    await card('First clip').getByRole('group', { name: 'First clip preview', exact: true }).waitFor()
    await card('Exported').getByRole('group', { name: 'Latest export', exact: true }).waitFor()
    await card('Outdated').getByText('Out of date', { exact: true }).waitFor()
    await card('Exported').getByText('3 clips · 00:03', { exact: true }).click()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('toolbar', { name: 'Timeline', exact: true }).getByRole('button', { name: 'Download latest export', exact: true }).click(),
    ])
    expect(await download.failure()).toBeNull()
    await screenshot('four-states')
    expect(errors).toEqual([])
  })

  it('drags timeline cards by their preview, still or player, and by the mini timeline', async () => {
    const dragBy = async (title: string, area: string | RegExp) => {
      const before = (await nodes()).find(node => node.title === title)!
      const target = typeof area === 'string' ? card(title).getByRole('group', { name: area, exact: true }) : card(title).getByText(area)
      const box = (await target.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 3 + 30, { steps: 12 })
      await page.mouse.up()
      await expect.poll(async () => (await nodes()).find(node => node.nodeId === before.nodeId)!.x).toBeGreaterThan(before.x)
    }
    await dragBy('Empty', 'First clip preview')
    await dragBy('First clip', 'First clip preview')
    await dragBy('Exported', 'Latest export')
    await dragBy('Outdated', /^\d+ clips · /)
    expect(errors).toEqual([])
  })

  it('creates a rough cut with music and an export through the fake Agent on a fresh canvas', async () => {
    await apply((await nodes()).map(node => ({ op: 'node.delete', nodeId: node.nodeId })))
    await seedMedia()
    await scenario('timeline-roughcut')
    const timeline = (await nodes()).find(node => node.kind === 'timeline')!
    const exported = (await nodes()).find(node => node.exportOf?.timelineNodeId === timeline.nodeId)!
    expect(document(timeline).tracks.filter(track => track.kind === 'audio').flatMap(track => track.clips)).toHaveLength(1)
    expect(exported.kind).toBe('video')
    expect(exported.exportOf?.timelineRevision).toBe(main(timeline).revision)
    await page.getByRole('region', { name: /^Timeline / }).getByRole('group', { name: 'Latest export', exact: true }).waitFor()
    expect(errors).toEqual([])
  }, 30_000)
})
