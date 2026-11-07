/// <reference types="node" />
import { existsSync, mkdirSync } from 'node:fs'
import { build } from 'esbuild'
import { chromium, type Browser, type Page, type Locator } from 'playwright-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromePath } from '../../e2e/platform'

const output = process.env.VIS_POLISH_CAPTURE ?? '/tmp/vis-next/polish/after'
let browser: Browser
let page: Page
let js: string
let css: string
const mount = (mode: string) => page.evaluate(mode => (window as any).mount(mode), mode)
const shot = async (name: string) => {
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: `${output}/${name}.png`, animations: 'disabled' })
}
const rect = (locator: Locator) => locator.boundingBox().then(box => { if (!box) throw new Error('Missing control bounds'); return box })
const overlap = async (a: Locator, b: Locator) => {
  const [x, y] = await Promise.all([rect(a), rect(b)])
  return x.x < y.x + y.width && x.x + x.width > y.x && x.y < y.y + y.height && x.y + x.height > y.y
}

describe.skipIf(!existsSync(chromePath()))('polished author controls', () => {
  beforeAll(async () => {
    mkdirSync(output, { recursive: true })
    const built = await build({
      stdin: { resolveDir: import.meta.dirname, loader: 'tsx', contents: `
        import React, { useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { LocaleProvider } from '@vis/ui-kit'
        import '@vis/ui-kit/theme.css'
        import './app.css'
        import { CanvasView } from '@vis/canvas-ui'
        import { ProviderSettings } from './ProviderSettings'
        import { SettingsTab } from '../../../../packages/library/ui/src/settings/SettingsTab'
        const root = createRoot(document.getElementById('root'))
        const assets = ['River', 'Stone', 'Wind'].map((name, i) => ({ id: 'cast-'+i, kind: 'character', name, description: 'A traveller at the edge of the mountain.', imageNodeId: 'reference', rev: 1 }))
        const doc = { rev: 1, sessionId: 'director', assets, shots: [{ id: 'shot', rev: 1, description: 'The travellers meet at dawn.', characterIds: ['cast-0'], sceneId: null, propIds: [], durationSec: 5 }] }
        const node = kind => ({ nodeId: 'node', kind, title: kind === 'script' ? 'First light' : 'Timeline', x: 0, y: 0, w: 400, h: 280, z: 0, revision: 1, createdAt: 1, updatedAt: 1,
          slots: [{ slotId: 'slot', slotKey: 'main', revision: 2, content: kind === 'script' ? { type: 'script', doc } : kind === 'timeline' ? { type: 'timeline', doc: { tracks: [] } } : { type: 'empty' } }] })
        const common = { renderScriptSettingPicker: () => null, onLayout: async () => {}, onMove: async () => {}, onDelete() {}, onTextCommit: async () => 'ok', onCreateText() {}, onCreateGenNode() {}, onSetInputs: async () => {}, onExtend: async () => '', onGenerate: async () => {}, onDownload() {}, onOpenSession() {}, onScriptAgent: async () => {}, scriptSessions: [{ sessionId: 'director', title: 'Director', agentKind: 'codex', archived: false }] }
        function Canvas({ mode }) {
          const [nodes, setNodes] = useState([node(mode)])
          const actions = { ...common, onApply: async ops => { window.ops = ops; setNodes(current => current.map(n => ({ ...n, slots: n.slots.map(slot => ({ ...slot, content: slot.content.type === 'script' ? { ...slot.content, doc: { ...slot.content.doc, shots: slot.content.doc.shots.map(shot => ({ ...shot, ...ops[0]?.ops?.[0]?.fields })) } } : slot.content })) }))) } }
          const history = [1, 2].map(revision => ({ slotId: 'slot', revision, content: { type: 'timeline', doc: { tracks: [] } }, createdAt: 1 }))
          return <div data-canvas-surface style={{ position: 'relative', display: 'flex', width: '100%', height: '100vh' }}>
            <CanvasView nodes={nodes} {...actions} assetUrl={() => ''} posterUrl={() => ''} histories={new Map([['slot', history]])} />
            <div className="app-view-switch" data-canvas-obstacle="top"><div role="tablist"><button role="tab">Canvas</button><button role="tab">Board</button></div></div>
          </div>
        }
        const catalog = { providers: [{ id: 'ark', type: 'volcengine-ark', label: 'Volcengine Ark · Studio', baseUrl: 'https://example.invalid', needsKey: true, hasKey: false, available: true, models: [{ id: 'model', label: 'Model', kind: 'image', paramsSchema: {} }] }], providerTypes: [{ type: 'volcengine-ark', label: { zh: '火山方舟', en: 'Volcengine Ark' }, needsKey: true, kinds: ['image'], regions: [], allowCustomBaseUrl: true, knownModels: [], help: { consoleUrl: 'https://example.invalid', key: { zh: '', en: '' } }, verified: true }], defaults: {}, limits: { maxConcurrent: 2, dailyImage: 5, dailyVideo: 2, dailyAudio: 5 } }
        const host = { call: async method => method === 'entity.list' || method === 'entity.proposalList' ? { items: [] } : { series: { seriesId: 'series', name: 'Mountain & Sea' }, items: [{ seriesEntityId: 'hero', kind: 'character', latest: { name: 'River', description: 'Traveller', revision: 1, refs: [], hasVoice: false, publishedAt: 1 } }] }, onEvent: () => () => {}, onSeriesChanged: () => () => {} }
        window.mount = mode => { window.ops = []; root.render(<LocaleProvider locale="en" setLocale={() => {}}>{mode === 'providers' ? <ProviderSettings catalog={catalog} rpc={{ call: async () => ({}) }} localePreference={null} onLocaleChange={async () => {}} onClose={() => {}} onUpdated={() => {}} /> : mode === 'library' ? <div style={{ width: 400, margin: '60px auto' }}><SettingsTab host={host} /></div> : <Canvas key={mode} mode={mode} />}</LocaleProvider>) }
      ` }, bundle: true, write: false, outdir: '/tmp/vis-polish-bundle', format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    })
    js = built.outputFiles.find(file => file.path.endsWith('.js'))!.text
    css = built.outputFiles.find(file => file.path.endsWith('.css'))!.text
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(3000)
    page.on('pageerror', error => console.error(error.message))
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }))
  }, 30_000)
  beforeEach(async () => {
    await page.goto('http://localhost/')
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: js })
  })
  afterAll(async () => { await browser?.close() }, 30_000)

  it('keeps the service name readable and uses consistent English service labels', async () => {
    await mount('providers')
    const name = page.getByRole('textbox', { name: 'Name', exact: true })
    await name.waitFor()
    await shot('providers')
    expect(await name.evaluate((input: HTMLInputElement) => input.scrollWidth <= input.clientWidth)).toBe(true)
    await page.getByRole('button', { name: 'Delete service', exact: true }).waitFor()
    await page.getByText('Service key', { exact: true }).waitFor()
    await page.getByText('Model ID', { exact: true }).waitFor()
  })
  it('keeps library copy together without artificial spaces or wrapped actions', async () => {
    await mount('library')
    await page.locator('.library-series-unused summary').click()
    const button = page.getByRole('button', { name: 'Use in this episode', exact: true })
    await button.waitFor()
    await shot('library-settings')
    expect(await button.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(40)
    expect(await page.locator('.library-series-unused summary').textContent()).toBe('Settings in “Mountain & Sea” not used in this episode (1)')
    expect(await page.locator('.library-series-unused summary').evaluate(element => getComputedStyle(element).display)).toBe('block')
  })
  it('shows the owner once in prompts and leaves the prompt action reachable', async () => {
    await mount('script')
    await page.getByRole('button', { name: 'Expand storyboard', exact: true }).click()
    await page.getByRole('tab', { name: 'Prompts', exact: true }).click()
    await shot('script-prompts')
    expect(await page.getByRole('button', { name: 'Owned by Director', exact: true }).count()).toBe(1)
    const action = page.getByRole('button', { name: 'Write prompts', exact: true })
    expect((await rect(action)).y).toBeLessThan(260)
  })
  it('selects cast with themed checkboxes without requiring modifier keys', async () => {
    await mount('script')
    await page.getByRole('button', { name: 'Expand storyboard', exact: true }).click()
    await page.locator('.vis-script-table-scroll').evaluate(element => { element.scrollLeft = 660 })
    await shot('script')
    const cast = page.getByRole('group', { name: /Shot 1.*Characters/ })
    await cast.getByRole('checkbox', { name: 'Stone', exact: true }).check()
    await expect.poll(() => page.evaluate(() => (window as any).ops[0]?.ops?.[0]?.fields.characterIds)).toEqual(['cast-0', 'cast-1'])
    expect(await cast.getByRole('checkbox', { name: 'River', exact: true }).isChecked()).toBe(true)
  })
  it('keeps the first reference cards and all their actions above the initial fold in English', async () => {
    await mount('script')
    await page.getByRole('button', { name: 'Expand storyboard', exact: true }).click()
    await page.getByRole('tab', { name: 'Settings', exact: true }).click()
    await shot('script-cast')
    const panel = await rect(page.locator('.vis-script-assets-panel'))
    for (const card of await page.locator('.vis-script-asset-card').all()) {
      const cardBounds = await rect(card)
      expect(cardBounds.y + cardBounds.height).toBeLessThanOrEqual(panel.y + panel.height)
      const remove = await rect(card.getByRole('button', { name: 'Delete', exact: true }))
      expect(remove.y + remove.height).toBeLessThanOrEqual(panel.y + panel.height)
    }
  })
  it.each(['image', 'timeline'])('keeps %s floating controls clear of fixed canvas controls while panning', async mode => {
    await mount(mode)
    const body = page.locator('.react-flow__node .vis-node-body')
    await body.waitFor()
    await body.click()
    const floating = mode === 'image' ? page.getByRole('toolbar', { name: 'Node operations', exact: true }) : page.locator('.vis-timeline-history')
    await floating.waitFor()
    const original = await rect(floating)
    const obstacle = mode === 'image' ? page.locator('.app-view-switch') : page.locator('.vis-canvas-toolbar')
    const fixed = await rect(obstacle)
    const dy = fixed.y + 8 - original.y
    await page.mouse.move(100, 500)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(100, 500 + dy, { steps: 6 })
    await page.mouse.up({ button: 'middle' })
    await shot(mode === 'image' ? 'canvas-toolbar' : 'timeline-versions')
    expect(await overlap(floating, obstacle)).toBe(false)
    const bounds = await rect(floating)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1000)
    if (mode === 'image') {
      expect(await overlap(floating, body)).toBe(false)
      expect(await overlap(floating, page.locator('.react-flow__node .vis-node-label'))).toBe(false)
      await page.locator('.react-flow__node .vis-node-title > span').dblclick()
      await page.getByRole('textbox', { name: 'Rename node', exact: true }).waitFor()
    }
    expect(await floating.evaluate(element => {
      const box = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
    })).toBe(true)
  })
})
