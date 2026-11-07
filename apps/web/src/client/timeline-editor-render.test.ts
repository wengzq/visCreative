/// <reference types="node" />
import { existsSync } from 'node:fs'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromePath } from '../../e2e/platform'

let browser: Browser
let page: Page
let bundle: string

describe.skipIf(!existsSync(chromePath()))('timeline editor host invalidation', () => {
  // Exercise real React memoization in Chrome, using the browser dependency already used by this host.
  // Panel probes count renders without media loading, animation frames or layout obscuring invalidation.
  beforeAll(async () => {
    const result = await build({
      stdin: { contents: `
        import { createElement, useMemo } from 'react'
        import { createRoot } from 'react-dom/client'
        import { flushSync } from 'react-dom'
        import { TimelineEditor } from '../../../../packages/timeline/ui/src/TimelineEditor'
        import { LocaleProvider } from '@vis/ui-kit'
        import { timelineEditorHost, useTimelineEditorNodes } from './timeline-editor'
        const root = createRoot(document.getElementById('root'))
        const actions = { onApply() {}, onMediaProcess() {}, onDownload() {} }
        const close = () => {}
        let input
        const conn = { token: 'test', rpc: { call: async () => ({ kind: 'video', version: 1, durationMs: 1000 }) }, getView: () => ({ ready: true, space: { spaceId: 'project' }, state: {
          nodes: new Map(input.nodes.map(node => [node.nodeId, node])),
          mediaTasks: new Map(input.task ? [['task', input.task]] : []), sessions: new Map(),
        } }) }
        const media = (nodeId, kind = 'video') => ({ nodeId, kind, title: nodeId, x: 0, y: 0, w: 100, h: 100, z: 0, layoutRevision: 1,
          slots: [{ slotId: nodeId, slotKey: 'main', revision: 1, contentType: 'asset', content: { type: 'asset', assetVersionId: nodeId } }] })
        const timeline = { ...media('timeline', 'timeline'), slots: [{ slotId: 'timeline', slotKey: 'main', revision: 1, contentType: 'timeline',
          content: { type: 'timeline', doc: { version: 1, tracks: [{ id: 'video', kind: 'video', muted: false, volume: 1, clips: [
            { id: 'clip', source: { nodeId: 'source', assetVersionId: 'source' }, startMs: 0, inMs: 0, outMs: 1000, volume: 1, fadeInMs: 0, fadeOutMs: 0 },
          ] }] } } }] }
        function Harness() {
          const node = input.nodes.find(node => node.nodeId === 'timeline')
          const nodes = useTimelineEditorNodes(node, input.nodes)
          const host = useMemo(() => timelineEditorHost({ conn, node, nodes, actions, locale: 'en', close, focus: close, upload: close }), [node, nodes, input.task])
          window.host = host
          return createElement(TimelineEditor, { host })
        }
        window.reset = () => {
          input = { nodes: [timeline, media('source'), media('bin', 'image'), media('note', 'text')] }
          window.counts = {}
          flushSync(() => root.render(createElement(LocaleProvider, { locale: 'en', setLocale: close }, createElement(Harness))))
        }
        window.edit = () => flushSync(() => window.draft.edit({ ...window.draft.doc, output: { width: 640, height: 360, fps: 24 } }))
        window.change = (kind, patch) => {
          if (kind === 'add') input = { ...input, nodes: [...input.nodes, media(patch.nodeId, patch.kind)] }
          else if (kind === 'remove') input = { ...input, nodes: input.nodes.filter(node => node.nodeId !== patch.nodeId) }
          else if (kind === 'task') input = { ...input, task: { taskId: 'task', nodeId: 'timeline', operation: 'timeline.export', status: 'running', createdAt: 1, ...patch } }
          else if (kind !== 'shell') input = { ...input, nodes: input.nodes.map(node => {
            if (node.nodeId !== kind) return node
            if (patch.assetVersionId) return { ...node, slots: [{ ...node.slots[0], revision: 2, content: { type: 'asset', assetVersionId: patch.assetVersionId } }] }
            if (patch.revision) return { ...node, slots: [{ ...node.slots[0], revision: patch.revision, writer: patch.writer, content: {
              type: 'timeline', doc: { ...node.slots[0].content.doc, output: { width: 1280, height: 720, fps: 24 },
              ...(patch.clearClips ? { tracks: [{ ...node.slots[0].content.doc.tracks[0], clips: [] }] } : {}),
            },
            } }] }
            return { ...node, ...patch }
          }) }
          flushSync(() => root.render(createElement(LocaleProvider, { locale: 'en', setLocale: close }, createElement(Harness))))
        }
      `, resolveDir: import.meta.dirname, loader: 'ts' },
      bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.css': 'empty' },
      plugins: [{ name: 'panel-probes', setup(builder) {
        builder.onLoad({ filter: /[/\\](TimelineArea|MediaBin|Inspector|Preview)\.tsx$/ }, args => {
          const name = args.path.match(/([^/\\]+)\.tsx$/)![1]!
          return { contents: `export function ${name}(props) { window.draft = props.draft
          window.counts['${name}'] = (window.counts['${name}'] || 0) + 1
            return null }
            export function OutputSettings() { return null }`, loader: 'js' }
        })
      } }],
    })
    bundle = result.outputFiles[0]!.text
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage()
  }, 30_000)
  beforeEach(async () => {
    // A fresh document isolates React roots and globals without recreating Chrome's context.
    await page.goto('about:blank')
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle })
    await page.evaluate('window.reset()')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  })
  // Closing Chrome on a loaded Windows machine has taken over the 10 s default.
  afterAll(async () => { await browser?.close() }, 30_000)

  const counts = () => page.evaluate('window.counts') as Promise<Record<string, number>>
  const change = (kind: string, patch: Record<string, unknown> = {}) => page.evaluate(({ kind, patch }) => {
    (window as unknown as { change(kind: string, patch: Record<string, unknown>): void }).change(kind, patch)
  }, { kind, patch })

  it('does not render any heavy panel for unrelated nodes or shell renders', async () => {
    const before = await counts()
    await change('note', { x: 30, title: 'Moved note' })
    await change('add', { nodeId: 'another-note', kind: 'text' })
    await change('remove', { nodeId: 'another-note' })
    await change('shell')
    expect(await counts()).toEqual(before)
  })

  it.each([
    ['source', { title: 'Renamed source' }],
    ['source', { assetVersionId: 'new-version' }],
    ['source', { kind: 'image' }],
    ['bin', { title: 'Renamed bin item' }],
    ['bin', { assetVersionId: 'new-image' }],
    ['add', { nodeId: 'new-media', kind: 'audio' }],
    ['remove', { nodeId: 'bin' }],
    ['timeline', { title: 'Renamed timeline' }],
    ['timeline', { revision: 2, writer: { actor: 'agent', sessionId: 'writer' } }],
    ['task', { progress: 0.5 }],
  ] as const)('updates all panels immediately for %s %j', async (kind, patch) => {
    const before = await counts()
    await change(kind, patch)
    const after = await counts()
    for (const panel of ['TimelineArea', 'MediaBin', 'Inspector', 'Preview']) expect(after[panel]).toBeGreaterThan(before[panel]!)
  })

  it('keeps sources of the retained local document live during a remote conflict', async () => {
    await change('source', { kind: 'text' })
    await page.evaluate('window.edit()')
    await change('timeline', { revision: 3, clearClips: true })
    await expect.poll(() => page.evaluate('Boolean(window.draft.conflict)')).toBe(true)
    expect(await page.evaluate('window.draft.doc.tracks[0].clips[0].source.nodeId')).toBe('source')
    expect(await page.evaluate('window.host.nodes.some(node => node.nodeId === "source")')).toBe(true)
    const before = await counts()
    await change('source', { title: 'Renamed local source' })
    expect((await counts()).TimelineArea).toBeGreaterThan(before.TimelineArea!)
  })

  it('keeps non-media clip sources and timeline exports live', async () => {
    await change('source', { kind: 'text' })
    const beforeSource = await counts()
    await change('source', { title: 'Changed non-media source' })
    expect((await counts()).TimelineArea).toBeGreaterThan(beforeSource.TimelineArea!)
    await change('add', { nodeId: 'export', kind: 'video' })
    const beforeExport = await counts()
    await change('export', { exportOf: { timelineNodeId: 'timeline', timelineRevision: 2 } })
    expect((await counts()).Inspector).toBeGreaterThan(beforeExport.Inspector!)
  })
})
