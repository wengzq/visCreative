/// <reference types="node" />
import { existsSync, mkdirSync } from 'node:fs'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromePath } from '../../e2e/platform'

const output = '/tmp/vis-0037-S3'
let browser: Browser
let page: Page
const events = () => page.evaluate(() => (window as any).events as { action: string; args: unknown[] }[])
const mount = (mode: string) => page.evaluate(mode => (window as any).mount(mode), mode)

describe.skipIf(!existsSync(chromePath()))('Scene cards and explicit panel links', () => {
  beforeAll(async () => {
    const built = await build({
      stdin: { resolveDir: import.meta.dirname, loader: 'tsx', contents: `
        import React, { useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { LocaleProvider } from '@vis/ui-kit'
        import '@vis/ui-kit/theme.css'
        import './app.css'
        import { CanvasView } from '@vis/canvas-ui'
        import { PrevizEditor } from '@vis/previz-ui'
        import '@vis/previz-ui/previz.css'
        import { emptyPrevizPanel } from '@vis/protocol'
        const root = createRoot(document.getElementById('root'))
        const picture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
        const view = (id, name, still) => ({ id, name, still, aspectRatio: '16:9', camera: { position: [0, 2, 5], target: [0, 1, 0], roll: 0, focalLengthMm: 35 } })
        const node = (nodeId, kind, content) => ({ nodeId, kind, title: kind === 'scene' ? 'Room' : 'Panels', x: 0, y: 0, w: 360, h: 280, z: 1, layoutRevision: 1, slots: [{ slotId: nodeId+'-main', slotKey: 'main', contentType: kind, revision: 7, content }] })
        const record = (action, ...args) => window.events.push({ action, args })
        const common = { onLayout: async () => {}, onMove: async () => {}, onDelete() {}, onTextCommit: async () => 'ok', onCreateText() {}, onCreateGenNode() {}, onSetInputs: async () => {}, onExtend: async () => '', onGenerate: async () => {}, onClone: async () => [], onExtendReferences: async () => '', onDownload() {}, onDropFiles() {} }
        function Fixture({ mode }) {
          const scene = node('scene', 'scene', { type: 'scene', doc: { version: 1, rev: 5, objects: [], views: mode === 'empty' ? [] : [view('wide', 'Wide', 'first-frame'), view('close', 'Close', 'second-frame')] } })
          if (mode === 'changed') scene.slots[0].revision = 8
          const panel = { ...emptyPrevizPanel('panel'), underlay: 'drawing', sketch: 'ink', image: 'drawing-image', blockout: 'saved-picture', sceneRef: mode === 'unlinked' ? undefined : { sceneNodeId: mode === 'dangling' ? 'missing' : 'scene', viewId: 'wide', sceneRev: 7 } }
          const [previz, setPreviz] = useState(() => node('previz', 'previz', { type: 'previz', doc: { version: 1, rev: 3, aspectRatio: '16:9', panels: [panel] } }))
          if (mode === 'card' || mode === 'empty') return <div style={{ display: 'flex', width: '100%', height: '100vh' }}><CanvasView nodes={[scene]} {...common} assetUrl={() => picture} posterUrl={() => picture} thumbnailUrl={id => '/thumbnail/'+id}
            onCreateScene={async at => { record('create', at); return 'new-scene' }} onOpenScene={id => record('open-card', id)} /></div>
          return <PrevizEditor host={{ node: previz, nodes: [scene, previz], initialPanelId: 'panel', assetUrl: () => picture, upload: async () => 'uploaded',
            commit: async (doc, revision) => { record('commit', doc, revision); setPreviz(current => ({ ...current, slots: [{ ...current.slots[0], revision: revision+1, content: { type: 'previz', doc } }] })); return 'ok' },
            onClose() {}, onOpenScene: (...args) => record('open-panel', ...args) }} />
        }
        window.mount = mode => { window.events = []; root.render(<LocaleProvider locale="en" setLocale={() => {}}><Fixture key={mode} mode={mode} /></LocaleProvider>) }
      ` },
      bundle: true, write: false, outdir: '/tmp/vis-scene-links-bundle', format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
    })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(3000)
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }))
    await page.goto('http://localhost/')
    await page.addStyleTag({ content: built.outputFiles.find(file => file.path.endsWith('.css'))!.text })
    await page.addScriptTag({ content: built.outputFiles.find(file => file.path.endsWith('.js'))!.text })
    mkdirSync(output, { recursive: true })
  }, 30_000)
  afterAll(async () => { await browser?.close() }, 30_000)

  it('shows the first view thumbnail, view count and both scene creation controls', async () => {
    await mount('card')
    const card = page.getByRole('region', { name: 'Room · 2 views' })
    await card.waitFor()
    expect(await card.getByRole('img', { name: 'Wide', exact: true }).getAttribute('src')).toBe('/thumbnail/first-frame')
    await card.getByRole('button', { name: 'Open scene', exact: true }).click()
    await card.dblclick()
    expect((await events()).filter(event => event.action === 'open-card')).toHaveLength(2)
    await page.getByRole('button', { name: 'New 3D scene', exact: true }).click()
    await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 25, y: 25 } })
    await page.getByRole('menuitem', { name: 'New 3D scene', exact: true }).click()
    expect((await events()).filter(event => event.action === 'create')).toHaveLength(2)
  })

  it('shows an empty stage without loading an image', async () => {
    await mount('empty')
    const card = page.getByRole('region', { name: 'Room · 0 views' })
    await card.waitFor()
    expect(await card.getByRole('img').count()).toBe(0)
    expect(await card.getByText('Open the scene to add figures or objects').isVisible()).toBe(true)
    await page.screenshot({ path: output + '/scene-empty.png', animations: 'disabled' })
  })

  it('opens a chosen scene view without writing the panel', async () => {
    await mount('unlinked')
    await page.getByRole('combobox', { name: 'Choose scene', exact: true }).selectOption('scene')
    await page.getByRole('combobox', { name: 'Choose view', exact: true }).selectOption('close')
    await page.getByRole('button', { name: 'Use a scene view', exact: true }).click()
    expect(await events()).toEqual([{ action: 'open-panel', args: ['scene', 'close', 'panel'] }])
  })

  it('flushes drawing edits before opening an explicit update and keeps the saved scene frame', async () => {
    await mount('changed')
    await page.getByRole('button', { name: 'Update', exact: true }).waitFor()
    expect(await events()).toEqual([])
    await page.screenshot({ path: output + '/scene-link-update.png', animations: 'disabled' })
    await page.getByRole('textbox', { name: 'Panel note', exact: true }).fill('New panel note')
    await page.getByRole('button', { name: 'Update', exact: true }).click()
    await expect.poll(async () => (await events()).at(-1)?.action).toBe('open-panel')
    const changes = await events()
    expect(changes[0]).toMatchObject({ action: 'commit', args: [{ panels: [{ note: 'New panel note', blockout: 'saved-picture', underlay: 'drawing', sketch: 'ink' }] }, 7] })
    expect(changes.at(-1)).toEqual({ action: 'open-panel', args: ['scene', 'wide', 'panel'] })
  })

  it('shows no update for current or dangling links and keeps their picture', async () => {
    for (const mode of ['current', 'dangling']) {
      await mount(mode)
      await page.getByRole('combobox', { name: 'Choose scene', exact: true }).waitFor()
      await expect.poll(() => page.getByRole('button', { name: 'Update', exact: true }).count()).toBe(0)
      expect(await page.getByRole('img', { name: 'Scene frame', exact: true }).isVisible()).toBe(true)
      expect(await events()).toEqual([])
    }
  })
})
