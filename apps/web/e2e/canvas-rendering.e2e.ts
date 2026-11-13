import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { chromePath } from './platform'

it.skipIf(!existsSync(chromePath()))('Keeps relation handles when content updates before measured dimensions return', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: resolve(import.meta.dirname, '..'), loader: 'tsx',
      contents: `
        import { useLayoutEffect } from 'react'
        import { createRoot } from 'react-dom/client'
        import { flushSync } from 'react-dom'
        import { applyNodeChanges, Handle, Position, ReactFlow, ReactFlowProvider, useStoreApi } from '@xyflow/react'
        import '@xyflow/react/dist/style.css'
        import { toFlowNode } from '../../packages/canvas/ui/src/flow-nodes'
        import { inputEdges } from '../../packages/canvas/ui/src/graph'
        const root = createRoot(document.getElementById('canvas'))
        const views = ['source', 'result'].map((nodeId, i) => ({
          nodeId, kind: 'text', x: i * 400, y: i * 40, w: 320, h: 240, z: i, layoutRevision: 1,
          slots: [{ slotId: nodeId, slotKey: 'main', revision: 1, content: { type: 'text', body: nodeId } }],
          ...(i ? { inputs: ['source'] } : {}),
        }))
        let nodes = views.map(view => toFlowNode(view, undefined, false, undefined))
        let store
        const held = []
        const onNodesChange = changes => held.push(...changes.filter(change => change.type === 'dimensions'))
        function Probe() {
          const api = useStoreApi()
          useLayoutEffect(() => { store = api }, [api])
          return null
        }
        function NodeBody() {
          return <><Handle id="out-right" type="source" position={Position.Right} />
            <Handle id="in-left" type="target" position={Position.Left} /></>
        }
        const nodeTypes = { text: NodeBody }
        const render = () => flushSync(() => root.render(<ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={inputEdges(views)} nodeTypes={nodeTypes} onNodesChange={onNodesChange}>
            <Probe />
          </ReactFlow>
        </ReactFlowProvider>))
        render()
        window.run = () => {
          // Force the first measurement, then reconcile content before acknowledging its dimensions.
          store.getState().updateNodeInternals(new Map(nodes.map(node => [node.id, {
            id: node.id, nodeElement: document.querySelector('[data-id="' + node.id + '"]'), force: true,
          }])))
          const bounds = () => nodes.map(node => Boolean(store.getState().nodeLookup.get(node.id).internals.handleBounds))
          const before = bounds()
          const pendingDimensions = held.length
          nodes = nodes.map(node => toFlowNode({ ...node.data.view, title: 'Delivered' }, undefined, false, undefined, node))
          render()
          const afterContent = bounds()
          nodes = applyNodeChanges(held, nodes)
          render()
          return { before, pendingDimensions, afterContent, afterAcknowledgement: bounds() }
        }
      `,
    },
    outfile: 'canvas.js', bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
  })
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent('<div id="canvas" style="width:1200px;height:900px"></div>')
    await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text })
    await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text })
    await expect.poll(() => page.locator('.react-flow__node').count()).toBe(2)
    const result = await page.evaluate(() => (window as any).run())
    expect(result.before).toEqual([true, true])
    expect(result.pendingDimensions).toBeGreaterThan(0)
    expect(result.afterContent).toEqual([true, true])
    expect(result.afterAcknowledgement).toEqual([true, true])
    await expect.poll(() => page.locator('.react-flow__edge').count()).toBe(1)
    expect(errors).toEqual([])
  } finally { await browser.close() }
}, 15_000)

it.skipIf(!existsSync(chromePath()))('Keeps canvas callbacks stable and rejects bindings from discarded renders', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: resolve(import.meta.dirname, '..'), loader: 'tsx',
      contents: `
        import { startTransition, Suspense } from 'react'
        import { createRoot } from 'react-dom/client'
        import { flushSync } from 'react-dom'
        import { useCanvasCallbacks } from './src/client/canvas-callbacks'
        import { useStableCallback } from '../../packages/canvas/ui/src/render-state'
        window.run = async () => {
          const root = createRoot(document.body.appendChild(document.createElement('div')))
          const actions = []
          const calls = []
          const notify = () => {}
          let project = 'first'
          const conn = { getView: () => ({ space: { spaceId: project }, ready: true, providers: null }) }
          function Bindings({ version }) {
            actions.push(useCanvasCallbacks(conn, notify, project, {
              locale: version === 1 ? 'en' : 'zh-CN',
              openSession: id => calls.push([version, id]),
              openTimeline: id => calls.push([version, 'timeline', id]),
              focus() {},
              reference: ids => calls.push([version, ids]),
              selection() {}, record() {},
            }))
            return null
          }
          flushSync(() => root.render(<Bindings version={1} />))
          flushSync(() => root.render(<Bindings version={2} />))
          const sameActions = actions[0] === actions[1]
          actions[0].onOpenSession('owner')
          actions[0].onReference(['node'])
          actions[0].onOpenTimeline('cut')
          project = 'second'
          flushSync(() => root.render(<Bindings version={3} />))
          const changedProject = actions[2] !== actions[1]
          let staleProjectRejected = false
          try { await actions[0].onApply([]) } catch { staleProjectRejected = true }
          const discardedCalls = []
          let savedActions
          let savedCallback
          let attempted
          const suspended = new Promise(resolve => { attempted = resolve })
          const never = new Promise(() => {})
          function Interrupted({ version }) {
            const callbacks = useCanvasCallbacks(conn, notify, project, {
              locale: 'en', openSession: () => discardedCalls.push(['actions', version]),
              openTimeline: () => discardedCalls.push(['timeline', version]), focus() {},
              reference() {}, selection() {}, record() {},
            })
            const stable = useStableCallback(() => discardedCalls.push(['stable', version]))
            if (version === 99) { attempted(); throw never }
            savedActions = callbacks
            savedCallback = stable
            return null
          }
          flushSync(() => root.render(<Suspense fallback={null}><Interrupted version={1} /></Suspense>))
          startTransition(() => root.render(<Suspense fallback={null}><Interrupted version={99} /></Suspense>))
          await suspended
          savedActions.onOpenSession('owner')
          savedActions.onOpenTimeline('cut')
          savedCallback()
          root.unmount()
          return { sameActions, changedProject, staleProjectRejected, calls, discardedCalls }
        }
      `,
    },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.DEV': 'false' },
  })
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const result = await page.evaluate(() => (window as unknown as { run(): Promise<any> }).run())
    expect(errors).toEqual([])
    expect(result.sameActions).toBe(true)
    expect(result.changedProject).toBe(true)
    expect(result.staleProjectRejected).toBe(true)
    expect(result.calls).toEqual([[2, 'owner'], [2, ['node']], [2, 'timeline', 'cut']])
    expect(result.discardedCalls).toEqual([['actions', 1], ['timeline', 1], ['stable', 1]])
  } finally { await browser.close() }
}, 15_000)

// Startup and 120 synchronous history updates share CPU with the other browser workers.
it.skipIf(!existsSync(chromePath())).each([false, true])('Renders only affected canvas nodes for decoration, progress, selection and history snapshots (external source: %s)', async useSource => {
  const bundle = await build({
    stdin: {
      resolveDir: resolve(import.meta.dirname, '..'), loader: 'tsx',
      contents: `
        import { Profiler } from 'react'
        import { createRoot } from 'react-dom/client'
        import { flushSync } from 'react-dom'
        import { LocaleProvider } from '@vis/ui-kit'
        import { CanvasView } from '../../packages/canvas/ui/src/CanvasView'
        window.nodeRenders = []
        window.gateRenders = []
        window.commits = []
        const root = createRoot(document.getElementById('canvas'))
        const nodes = Array.from({ length: 24 }, (_, i) => ({
          nodeId: 'node-' + i, kind: i === 1 ? 'image' : 'text', title: 'Node ' + i,
          x: i % 6 * 340, y: Math.floor(i / 6) * 260, w: 320, h: 240,
          z: i, revision: 1, layoutRevision: 1, inputNodeIds: [],
          slots: [{
            slotId: 'slot-' + i, slotKey: 'main', revision: 1,
            content: i === 1
              ? { type: 'asset', assetVersionId: 'current', mime: 'image/png' }
              : { type: 'text', body: 'Body ' + i },
          }],
        }))
        const noop = () => {}
        const actions = {
          onLayout: noop, onMove: noop, onDelete: noop, onTextCommit: async () => 'ok',
          onCreateText: noop, onCreateGenNode: noop, onSetInputs: noop, onExtend: noop,
          onGenerate: noop, onClone: noop, onExtendReferences: noop,
          onDownload: noop, onDropFiles: noop,
        }
        const assetUrl = () => 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
        let decorations = new Map()
        let histories = new Map()
        let suspended = false
        const listeners = new Set()
        const historySource = {
          getSnapshot: () => ({ nodes: new Map(nodes.map(node => [node.nodeId, node])), histories }),
          subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
        }
        const render = () => flushSync(() => {
          root.render(
          <LocaleProvider locale="en" setLocale={noop}>
            <Profiler id="canvas" onRender={(_, phase) => window.commits.push(phase)}>
              <CanvasView {...actions} suspended={suspended} nodes={nodes} decorations={decorations} {...(${useSource} ? { historySource } : { histories })} assetUrl={assetUrl} />
            </Profiler>
          </LocaleProvider>
          )
          for (const listener of listeners) listener()
        })
        window.reset = () => { window.nodeRenders = []; window.gateRenders = []; window.commits = [] }
        window.suspend = value => { suspended = value; render() }
        window.decorate = progress => {
          decorations = new Map([['node-0', { running: 1, problems: [], activeJobs: [{
            jobId: 'job', status: 'running', progress,
          }] }]])
          render()
        }
        window.updateHistory = (revision = 0) => {
          histories = new Map([['slot-1', [
            { slotId: 'slot-1', revision, content: { type: 'asset', assetVersionId: 'previous-' + revision, mime: 'image/png' } },
            { slotId: 'slot-1', revision: 1, content: { type: 'asset', assetVersionId: 'current', mime: 'image/png' } },
          ]]])
          render()
        }
        render()
      `,
    },
    outfile: 'canvas.js',
    plugins: [{
      name: 'count-node-renders',
      setup(builder) {
        builder.onLoad({ filter: /[/\\]CanvasView\.tsx$/ }, args => ({
          contents: readFileSync(args.path, 'utf8').replace(
            /const CanvasNode = memo\(function CanvasNode\(props: [^\n]+\) \{/,
            match => match + ' window.nodeRenders.push(props.id)',
          ).replace(
            /const CanvasNodeSelection = memo\(function CanvasNodeSelection\(props: [^\n]+\) \{/,
            match => match + ' window.gateRenders.push(props.id)',
          ),
          loader: 'tsx',
        }))
      },
    }],
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.DEV': 'false' },
  })
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent('<div id="canvas" style="display:flex;width:1500px;height:900px"></div>')
    await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text })
    await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text })
    const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const reset = () => page.evaluate(() => (window as any).reset())
    const rendered = () => page.evaluate(() => [...new Set((window as any).nodeRenders)])
    await expect.poll(() => page.locator('.react-flow__node').count()).toBe(24)
    await settle()
    await reset()
    await page.evaluate(() => (window as any).decorate(.1))
    await settle()
    expect.soft(await rendered()).toEqual(['node-0'])
    expect.soft(await page.evaluate(() => (window as any).nodeRenders)).toEqual(['node-0'])
    await reset()
    await page.evaluate(() => (window as any).decorate(.5))
    await settle()
    expect.soft(await rendered()).toEqual(['node-0'])
    expect.soft(await page.evaluate(() => (window as any).nodeRenders)).toEqual(['node-0'])
    await reset()
    await page.getByText('Node 1', { exact: true }).hover()
    await page.getByText('Node 1', { exact: true }).click()
    await settle()
    expect.soft(await rendered()).toEqual(['node-1'])
    await reset()
    await page.getByText('Node 2', { exact: true }).hover()
    await page.getByText('Node 2', { exact: true }).click()
    await settle()
    expect.soft((await rendered()).sort()).toEqual(['node-1', 'node-2'])
    await page.getByText('Node 1', { exact: true }).click()
    await settle()
    await reset()
    await page.evaluate(() => (window as any).updateHistory())
    expect.soft(await page.getByRole('group', { name: 'Historical versions' }).getByRole('button').count()).toBe(2)
    expect.soft(await rendered()).toEqual(['node-1'])
    expect.soft(await page.evaluate(() => (window as any).commits)).toEqual(['update'])
    if (useSource) expect(await page.evaluate(() => (window as any).gateRenders)).toEqual(['node-1'])
    await reset()
    await page.evaluate(() => {
      for (let frame = 0; frame < 120; frame++) (window as any).updateHistory(frame + 2)
    })
    expect(await page.evaluate(() => (window as any).commits)).toEqual(Array(120).fill('update'))
    expect(await page.evaluate(() => (window as any).nodeRenders)).toEqual(Array(120).fill('node-1'))
    await reset()
    await page.evaluate(() => (window as any).suspend(true))
    await settle()
    expect((await rendered()).sort()).toEqual(Array.from({ length: 24 }, (_, index) => 'node-' + index).sort())
    expect(await page.getByRole('group', { name: 'Historical versions' }).count()).toBe(0)
    await reset()
    await page.evaluate(() => (window as any).suspend(true))
    await settle()
    expect(await rendered()).toEqual([])
    await page.evaluate(() => (window as any).decorate(.9))
    await settle()
    expect(await rendered()).toEqual(['node-0'])
    await page.evaluate(() => (window as any).suspend(false))
    await settle()
    expect(await page.getByRole('group', { name: 'Historical versions' }).getByRole('button').count()).toBe(2)
    expect(errors).toEqual([])
  } finally { await browser.close() }
}, 30_000)

it.skipIf(!existsSync(chromePath()))('Keeps text save results and split analysis bound to committed renders', async () => {
  const bundle = await build({
    stdin: {
      resolveDir: resolve(import.meta.dirname, '..'), loader: 'tsx',
      contents: `
        import { startTransition, Suspense, useLayoutEffect } from 'react'
        import { createRoot } from 'react-dom/client'
        import { flushSync } from 'react-dom'
        import { LocaleProvider } from '@vis/ui-kit'
        import { Ctx, useTextDraft } from '../../packages/canvas/ui/src/CanvasView'
        import { SplitPanel } from '../../packages/canvas/ui/src/MediaOperationPanels'
        window.run = async () => {
          const root = createRoot(document.body.appendChild(document.createElement('div')))
          const never = new Promise(() => {})
          let attempted
          let draft
          let finishCommit
          const saved = new Promise(resolve => { finishCommit = resolve })
          const context = { actions: { onTextCommit: () => saved } }
          function Draft({ revision }) {
            const state = useTextDraft({ slotId: 'text', revision, content: { type: 'text', body: 'original-' + revision } })
            useLayoutEffect(() => { draft = state })
            if (revision === 99) { attempted(); throw never }
            return null
          }
          const renderDraft = revision => <Ctx.Provider value={context}><Suspense fallback={null}><Draft revision={revision} /></Suspense></Ctx.Provider>
          flushSync(() => root.render(renderDraft(1)))
          flushSync(() => draft.setDraft({ text: 'edited', baseRevision: 1 }))
          let committing
          flushSync(() => { committing = draft.commit() })
          const suspendedDraft = new Promise(resolve => { attempted = resolve })
          startTransition(() => root.render(renderDraft(99)))
          await suspendedDraft
          const latestAfterSuspension = draft.getLatest()
          finishCommit('ok')
          await committing
          await new Promise(resolve => setTimeout(resolve, 0))
          const retainedDraft = draft.draft
          const analyses = []
          const noop = () => {}
          function Suspend({ version }) {
            if (version === 99) { attempted(); throw never }
            return null
          }
          const renderSplit = version => <LocaleProvider locale="en" setLocale={noop}><Suspense fallback={null}>
            <SplitPanel view={{ kind: 'audio' }} slot={{}} src="data:audio/wav;base64," assetVersionId="audio"
              variant="smart" onSubmit={noop} onCancel={noop}
              onAnalyze={async () => { analyses.push(version); return { durationMs: 1000, pointsMs: [500] } }} />
            <Suspend version={version} />
          </Suspense></LocaleProvider>
          flushSync(() => root.render(renderSplit(1)))
          const analyzeButton = () => document.querySelector('button[aria-label="Detect split points again"]')
          while (analyzeButton()?.disabled) await new Promise(resolve => setTimeout(resolve, 0))
          analyses.length = 0
          const suspendedSplit = new Promise(resolve => { attempted = resolve })
          startTransition(() => root.render(renderSplit(99)))
          await suspendedSplit
          flushSync(() => analyzeButton().click())
          while (analyzeButton()?.disabled) await new Promise(resolve => setTimeout(resolve, 0))
          flushSync(() => root.render(renderSplit(2)))
          flushSync(() => analyzeButton().click())
          while (analyzeButton()?.disabled) await new Promise(resolve => setTimeout(resolve, 0))
          root.unmount()
          return { latestAfterSuspension, retainedDraft, analyses }
        }
      `,
    },
    plugins: [{
      name: 'expose-text-draft-test-boundary',
      setup(builder) {
        builder.onLoad({ filter: /[/\\]CanvasView\.tsx$/ }, args => ({
          contents: readFileSync(args.path, 'utf8').replace(
            'return { body, draft, setDraft, commit, saving }',
            'return { body, draft, setDraft, commit, saving, getLatest: () => latest.current }',
          ) + '\nexport { Ctx, useTextDraft }\n',
          loader: 'tsx',
        }))
      },
    }],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.DEV': 'false' },
  })
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const result = await page.evaluate(() => (window as unknown as { run(): Promise<any> }).run())
    expect.soft(result.latestAfterSuspension).toEqual({ revision: 1, body: 'original-1' })
    expect.soft(result.retainedDraft).toEqual({ text: 'edited', baseRevision: 1 })
    expect.soft(result.analyses).toEqual([1, 2])
    expect(errors).toEqual([])
  } finally { await browser.close() }
}, 15_000)
