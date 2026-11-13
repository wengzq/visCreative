/// <reference types="node" />
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromePath } from '../../e2e/platform'

let browser: Browser
let page: Page
const editor = () => page.getByRole('dialog', { name: 'Review stage', exact: true })
const banner = () => editor().getByRole('status').filter({ hasText: 'Previewing proposal' })
const button = (name: string) => editor().getByRole('button', { name, exact: true })
const field = (name: string) => editor().getByRole('spinbutton', { name, exact: true })
const row = (name: string) => editor().getByRole('article', { name, exact: true })
const rendered = () => page.evaluate(() => (window as any).rendered as { bench: number[]; camera: number[]; uuid: string })
const stats = () => page.evaluate(() => (window as any).stats as { flushes: number; commits: number; disposedOutlines: number; registrations: number; requests: unknown[]; resolves: number })
async function mount(mode = 'pending') {
  await page.evaluate(mode => (window as any).mount(mode), mode)
  if (mode !== 'cache') await expect.poll(() => button('Add view').isEnabled(), { timeout: 10_000 }).toBe(true)
}

describe.skipIf(!existsSync(chromePath()))('Scene proposal review interactions', () => {
  beforeAll(async () => {
    const three = createRequire(new URL('../../../../packages/scene/ui/package.json', import.meta.url)).resolve('three').replace(/three\.cjs$/, 'three.module.js')
    const built = await build({
      stdin: { resolveDir: import.meta.dirname, loader: 'tsx', contents: `
        import React, { useEffect, useMemo, useState } from 'react'
        import { createRoot } from 'react-dom/client'
        import { SceneEditor } from '@vis/scene-ui'
        import '@vis/scene-ui/scene.css'
        import { LocaleProvider } from '@vis/ui-kit'
        import '@vis/ui-kit/theme.css'
        import './app.css'
        import { Scene, BoxHelper } from ${JSON.stringify(three)}
        import { SceneProposalCard } from '../../../../packages/workbench/ui/src/SceneProposalCard'
        import { registerSceneDraft, resolveSceneProposal, useSceneProposals, useSceneProposalsForNode } from './scene-proposals'
        const originalDispose = BoxHelper.prototype.dispose
        BoxHelper.prototype.dispose = function() { window.stats.disposedOutlines++; originalDispose.call(this) }
        const originalRender = Scene.prototype.onAfterRender
        Scene.prototype.onAfterRender = function(renderer, scene, camera) {
          originalRender.call(this, renderer, scene, camera)
          scene.traverse(object => { if (object.userData.sceneObjectId === 'bench') window.rendered = { bench: object.position.toArray(), uuid: object.uuid, camera: camera.position.toArray() } })
        }
        const root = createRoot(document.getElementById('root'))
        let mountSeq = 0
        const transform = x => ({ position: [x,0,0], rotation: [0,0,0,1], scale: [1,1,1] })
        const bench = { id: 'bench', name: 'Bench', source: { type: 'prop', propId: 'bench' }, hidden: false, createdBy: 'user', userTouched: true, transform: transform(0), tracks: { transform: [{ t: 0, value: transform(0), ease: 'linear' }, { t: 2, value: transform(2), ease: 'linear' }] } }
        const marker = { ...bench, id: 'marker', name: 'Marker', transform: transform(-3), tracks: undefined }
        const content = object => { const { createdBy, userTouched, ...item } = object; return item }
        const a = { proposalId: 'a', nodeId: 'scene', slotId: 'slot', baseRevision: 1, sessionId: 'session', summary: 'Move bench', changes: [{ target: 'object', id: 'bench', action: 'update', base: content(bench), item: { ...content(bench), tracks: { transform: [{ t: 0, value: transform(0), ease: 'linear' }, { t: 2, value: transform(8), ease: 'linear' }] } }, changeId: 'a-change', status: 'pending' }], status: 'open', createdAt: 1 }
        const b = { ...a, proposalId: 'b', summary: 'Move marker', changes: [{ ...a.changes[0], id: 'marker', base: content(marker), item: { ...content(marker), transform: transform(-6) }, changeId: 'b-change' }] }
        const c = { ...a, proposalId: 'c', summary: 'Earlier change', status: 'resolved', changes: [{ ...a.changes[0], changeId: 'c-change', status: 'accepted' }] }
        const node = { nodeId: 'scene', kind: 'scene', title: 'Review stage', x: 0, y: 0, w: 360, h: 280, z: 1, layoutRevision: 1, slots: [{ slotId: 'slot', slotKey: 'main', contentType: 'scene', revision: 1, content: { type: 'scene', doc: { version: 1, rev: 1, durationS: 5, objects: [bench, marker], views: [] } } }] }
        const nodes = [node]
        const close = () => { window.closedEditor = true; root.render(null) }
        const baseHost = { node, nodes, assetUrl: () => '', upload: async () => '', importModel: async () => '', listModels: async () => [], saveImage: async () => {}, renderVideo: async () => {}, sendToPanel: async () => {}, sessionName: () => 'Scene partner', onClose: close }
        function EditorFixture({ mode }) {
          const [proposals, setProposals] = useState(mode === 'loading' ? [] : mode === 'resolved' ? [c] : [a,b])
          const [currentNode, setNode] = useState(node)
          const conn = useMemo(() => ({ getView: () => ({ ready: true, space: { spaceId: 'project' }, state: { nodes: new Map([['scene', node]]) } }), refreshNodes: async () => {}, rpc: { call: async () => { window.stats.resolves++; return { proposals: [] } } } }), [])
          window.setReviewProposals = value => setProposals(value === 'resolved' ? [{ ...a, status: 'resolved', changes: a.changes.map(change => ({ ...change, status: 'accepted' })) },b] : [a,b])
          const host = useMemo(() => ({ ...baseHost, node: currentNode, proposals, initialProposalId: mode === 'resolved' ? 'c' : 'a',
            commit: async (doc, revision) => {
              window.stats.commits++
              if (mode === 'flush-failure') return 'conflict'
              setNode(previous => ({ ...previous, slots: [{ ...previous.slots[0], revision: revision+1, content: { type: 'scene', doc } }] }))
              return 'ok'
            },
            registerDraft: handle => { window.stats.registrations++; return registerSceneDraft(conn, 'slot', { ...handle, flush: async () => { window.stats.flushes++; return handle.flush() } }) },
            resolveProposal: async (action, changes) => { await resolveSceneProposal(conn, 'project', 'en', 'slot', action, changes) },
          }), [currentNode, proposals, conn, mode])
          return <SceneEditor host={host} />
        }
        function CacheFixture({ mode }) {
          const [tick, setTick] = useState(0)
          const conn = useMemo(() => {
            const listeners = new Set()
            let values = [a,b,c]
            window.emitReviewEvent = () => { values = values.map(proposal => proposal.proposalId === 'b' ? { ...proposal, status: 'resolved', changes: proposal.changes.map(change => ({ ...change, status: 'rejected' })) } : proposal); for (const listener of listeners) listener({ type: 'scene.proposalChanged', payload: { proposalId: 'b', slotId: 'slot' } }) }
            return { resolve: (action, refs) => { const incoming = refs.map(ref => ({ ...values.find(proposal => proposal.proposalId === ref.proposalId), status: 'resolved', changes: values.find(proposal => proposal.proposalId === ref.proposalId).changes.map(change => ({ ...change, status: action === 'accept' ? 'accepted' : 'rejected' })) })); values = values.map(proposal => incoming.find(item => item.proposalId === proposal.proposalId) ?? proposal); return incoming }, rpc: { call: async (method, params) => { window.stats.requests.push({ method, params }); return { proposals: structuredClone(values) } } }, onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
          }, [])
          const cache = useSceneProposals(conn, 'project', true)
          const selected = useSceneProposalsForNode(cache.proposals, 'scene')
          window.rerenderShell = () => setTick(value => value+1)
          const host = useMemo(() => ({
            state: id => cache.byId.get(id), open() {},
            resolve: async (slotId, action, refs) => { window.stats.resolves++; cache.update(conn.resolve(action, refs)) },
          }), [cache.byId, cache.update, conn])
          const editorHost = useMemo(() => ({ ...baseHost, proposals: selected, commit: async () => 'ok', registerDraft: () => { window.stats.registrations++; return () => {} } }), [selected])
          if (mode === 'stable-host') return <SceneEditor host={editorHost} />
          return <div>{[a,b,c].map(proposal => <SceneProposalCard key={proposal.proposalId} proposal={proposal} host={host} />)}</div>
        }
        window.mount = mode => { window.closedEditor = false; window.rendered = null; window.stats = { requests: [], registrations: 0, flushes: 0, commits: 0, disposedOutlines: 0, resolves: 0 }; const key = ++mountSeq; root.render(<LocaleProvider locale="en" setLocale={() => {}}>{mode === 'cache' || mode === 'stable-host' ? <CacheFixture key={key} mode={mode} /> : <EditorFixture key={key} mode={mode} />}</LocaleProvider>) }
      ` },
      bundle: true, write: false, outdir: '/tmp/vis-scene-review-bundle', format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
    })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(3000)
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }))
    await page.goto('http://localhost/')
    await page.addStyleTag({ content: built.outputFiles.find(file => file.path.endsWith('.css'))!.text })
    await page.addScriptTag({ content: built.outputFiles.find(file => file.path.endsWith('.js'))!.text })
  }, 30_000)
  afterAll(async () => { await browser?.close() }, 30_000)

  it('closes on the first Escape when the requested preview is resolved or still loading', async () => {
    for (const mode of ['resolved', 'loading']) {
      await mount(mode)
      expect(await banner().count()).toBe(0)
      await editor().focus()
      await page.keyboard.press('Escape')
      await expect.poll(() => page.evaluate(() => (window as any).closedEditor)).toBe(true)
    }
  })

  it('clears a resolved preview request so reloading the proposal cannot resurrect it', async () => {
    await mount()
    await banner().waitFor()
    await page.evaluate(() => (window as any).setReviewProposals('resolved'))
    await expect.poll(() => banner().count()).toBe(0)
    await page.evaluate(() => (window as any).setReviewProposals('pending'))
    expect(await banner().count()).toBe(0)
  })

  it('keeps preview through all playhead navigation and samples proposed keys in place', async () => {
    await mount()
    await button('Select object: Bench').click()
    await field('Playhead time (s)').fill('1')
    await field('Playhead time (s)').press('Enter')
    await expect.poll(async () => (await rendered()).bench[0]).toBe(4)
    const uuid = (await rendered()).uuid
    await editor().getByRole('slider', { name: 'Playhead', exact: true }).fill('1.5')
    await expect.poll(async () => (await rendered()).bench[0]).toBe(6)
    await button('Next frame').click()
    await expect.poll(async () => Number(await field('Playhead time (s)').inputValue())).toBeCloseTo(1.5 + 1 / 24, 3)
    await editor().focus()
    await page.keyboard.press('[')
    await expect.poll(async () => (await rendered()).bench[0]).toBe(0)
    await page.keyboard.press(']')
    await expect.poll(async () => (await rendered()).bench[0]).toBe(8)
    expect(await banner().isVisible()).toBe(true)
    expect((await rendered()).uuid).toBe(uuid)
    expect((await stats()).resolves).toBe(0)
    await button('Play').click()
    await expect.poll(() => banner().count()).toBe(0)
    await button('Pause').click()
  })

  it('keeps a pinned proposal when another change is hovered or focused', async () => {
    await mount()
    await row('Move marker').getByRole('listitem').hover()
    expect(await banner().textContent()).toContain('Move bench')
    await row('Move marker').getByRole('listitem').focus()
    expect(await banner().textContent()).toContain('Move bench')
    await button('Frame selection').hover({ force: true })
    expect(await banner().textContent()).toContain('Move bench')
    await row('Move marker').getByRole('button', { name: 'Preview', exact: true }).click()
    await row('Move bench').getByRole('listitem').hover()
    expect(await banner().textContent()).toContain('Move marker')
  })

  it('allows orbit, pan, zoom and frame during read-only preview and ends it on a document edit', async () => {
    await mount()
    await button('Select object: Bench').click()
    const surface = await editor().getByRole('img', { name: '3D viewport', exact: true }).boundingBox()
    const x = surface!.x + surface!.width * 0.45, y = surface!.y + surface!.height * 0.45
    for (const mouseButton of ['left', 'right'] as const) {
      const before = (await rendered()).camera
      await page.mouse.move(x, y)
      await page.mouse.down({ button: mouseButton })
      await page.mouse.move(x + 65, y + 30, { steps: 3 })
      await page.mouse.up({ button: mouseButton })
      await expect.poll(async () => (await rendered()).camera).not.toEqual(before)
      expect(await banner().isVisible()).toBe(true)
    }
    const before = (await rendered()).camera
    await page.mouse.wheel(0, 160)
    await expect.poll(async () => (await rendered()).camera).not.toEqual(before)
    await button('Frame selection').click()
    expect(await banner().isVisible()).toBe(true)
    expect((await stats()).resolves).toBe(0)
    expect((await stats()).commits).toBe(0)
    await editor().getByRole('textbox', { name: 'Object name', exact: true }).fill('Bench edited')
    await editor().getByRole('textbox', { name: 'Object name', exact: true }).press('Enter')
    await expect.poll(() => banner().count()).toBe(0)
  })

  it('shows the localized save failure and flushes through the host once on inspector Accept', async () => {
    await mount('flush-failure')
    await button('Select object: Bench').click()
    await editor().getByRole('textbox', { name: 'Object name', exact: true }).fill('Unsaved bench')
    await row('Move bench').getByRole('button', { name: 'Accept all', exact: true }).click()
    await editor().getByRole('alert').filter({ hasText: 'Resolve the scene save conflict before accepting a proposal.' }).waitFor()
    expect((await stats()).flushes).toBe(1)
    expect((await stats()).resolves).toBe(0)
  })

  it('keeps the editor host and draft registration stable on unrelated shell renders', async () => {
    await mount('stable-host')
    await row('Move bench').waitFor()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const registrations = (await stats()).registrations
    await page.evaluate(() => (window as any).rerenderShell())
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect((await stats()).registrations).toBe(registrations)
  })

  it('disposes a still-visible proposal outline when the viewport unmounts', async () => {
    await mount()
    await expect.poll(rendered).not.toBeNull()
    const disposed = (await stats()).disposedOutlines
    await button('Close scene editor').click()
    await editor().waitFor({ state: 'detached' })
    expect((await stats()).disposedOutlines).toBe(disposed + 1)
  })

  it('shares one project cache for all receipt cards, retains resolved state and does no post-resolve read', async () => {
    await mount('cache')
    const cards = () => page.getByRole('article', { name: 'Scene proposal', exact: true })
    const receipt = (summary: string) => cards().filter({ hasText: summary })
    await receipt('Earlier change').getByText('Accepted', { exact: true }).waitFor()
    expect((await stats()).requests).toEqual([{ method: 'scene.proposal.list', params: { status: 'all' } }])
    await receipt('Move bench').getByRole('button', { name: 'Accept all', exact: true }).click()
    await receipt('Move bench').getByText('Accepted', { exact: true }).waitFor()
    expect((await stats()).requests).toHaveLength(1)
    await page.evaluate(() => (window as any).emitReviewEvent())
    await receipt('Move marker').getByText('Rejected', { exact: true }).waitFor()
    expect((await stats()).requests).toHaveLength(2)
    expect(await receipt('Move bench').getByText('Accepted', { exact: true }).isVisible()).toBe(true)
  })
})
