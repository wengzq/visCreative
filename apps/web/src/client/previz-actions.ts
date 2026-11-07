import { extensionPosition } from '@vis/canvas-ui'
import type { CanvasActions, ProviderCatalog } from '@vis/canvas-ui'
import type { CanvasOp, JobView, MethodResult, NodeView, PrevizPanel } from '@vis/protocol'
import { RpcError } from './rpc'

type Call = <T = any>(method: string, params?: unknown) => Promise<T>
type Apply = (ops: CanvasOp[], description?: string) => Promise<{ idMap: Record<string, string>; eventSeq: number }>
const main = (node: NodeView | undefined) => node?.slots.find(slot => slot.slotKey === 'main')
const newest = (nodes: NodeView[], panel: PrevizPanel, role: 'first' | 'last') => nodes.filter(node => node.shot?.scriptNodeId === panel.shot?.scriptNodeId && node.shot?.shotId === panel.shot?.shotId && node.shot?.role === role)
  .sort((a, b) => a.nodeId.slice(5, 15).localeCompare(b.nodeId.slice(5, 15))).at(-1)

export function previzCanvasActions(call: Call, apply: Apply, catalog: () => ProviderCatalog | null): Pick<CanvasActions, 'onPrevizPanel' | 'onPrevizExtract'> {
  return {
    async onPrevizExtract(nodeId, assetVersionId, fillDurations) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { nodes } = await call<{ nodes: NodeView[] }>('canvas.get', { nodeIds: [nodeId] })
        const slot = main(nodes[0])
        if (!slot || slot.content.type !== 'previz') throw new Error('The previz no longer exists')
        try {
          await call('previz.extractBlockout', { requestId: `previz-extract-${crypto.randomUUID()}`, slotId: slot.slotId, expectedRevision: slot.revision, assetVersionId, ...(fillDurations ? { fillDurations } : {}) })
          return
        } catch (error) {
          if (attempt === 0 && error instanceof RpcError && error.code === 'revision_conflict') continue
          throw error
        }
      }
    },
    async onPrevizPanel(request) {
      const { nodes } = await call<{ nodes: NodeView[] }>('canvas.get', {})
      const node = nodes.find(node => node.nodeId === request.nodeId)
      const content = main(node)?.content
      const panel = content?.type === 'previz' ? content.doc.panels.find(panel => panel.id === request.panelId) : undefined
      if (!node || !panel || !(panel.image ?? (panel.use === 'composition' ? panel.blockout : null))) throw new Error('Draw or import a panel first')
      const script = nodes.find(node => node.nodeId === panel.shot?.scriptNodeId)
      const scriptContent = main(script)?.content
      const linked = scriptContent?.type === 'script' && scriptContent.doc.shots.some(shot => shot.id === panel.shot?.shotId) ? panel.shot : null
      if (request.action === 'set_frame' && (panel.use !== 'frame' || !linked)) throw new Error('Link a frame panel to a shot first')
      if (panel.use === 'frame' && panel.frameRole === 'last' && !linked) throw new Error('Link a shot first')
      let firstSlot: ReturnType<typeof main>
      if (panel.use === 'frame') {
        const role = panel.frameRole === 'last' ? 'last' : 'first'
        const existing = linked ? newest(nodes, panel, role) : undefined
        const existingContent = main(existing)?.content
        if (existingContent?.type === 'asset' && existingContent.assetVersionId === panel.image) firstSlot = main(existing)
        else {
          const ops: CanvasOp[] = [{ op: 'node.create', tempId: 'frame', kind: 'image', ...extensionPosition(node, 'image', nodes), w: 320, content: { assetVersionId: panel.image! } }]
          if (linked) ops.push({ op: 'node.setMeta', nodeId: 'frame', shot: { ...linked, role } })
          const created = await call<MethodResult<'canvas.apply'>>('canvas.apply', { requestId: `${request.requestId}:frame`, ops })
          firstSlot = main((await call<{ nodes: NodeView[] }>('canvas.get', { nodeIds: [created.idMap.frame!] })).nodes[0])
        }
        if (role === 'last' || request.action === 'set_frame') return
      }
      const kind = panel.use === 'composition' ? 'image' : 'video'
      const providers = catalog()
      const choice = request.choice ?? providers?.defaults.video
      const model = providers?.providers.find(provider => provider.id === choice?.provider)?.models.find(model => model.id === choice?.model)
      const last = linked && model?.frameModes?.includes('first_last') ? main(newest(nodes, panel, 'last')) : undefined
      const submitted = await call<MethodResult<'generation.submit'>>('generation.submit', {
        requestId: request.requestId, kind, ...request.choice, prompt: request.prompt,
        ...(firstSlot ? { frames: { first: { slotId: firstSlot.slotId, revision: firstSlot.revision }, ...(last?.content.type === 'asset' ? { last: { slotId: last.slotId, revision: last.revision } } : {}) } }
          : { inputs: [{ assetVersionId: (panel.blockout ?? panel.image)! }] }),
        targets: [{ outputIndex: 0, kind: 'new_node', nearNodeId: node.nodeId }],
      })
      let job = await call<JobView>('generation.get', { jobId: submitted.jobId, waitMs: 30_000 })
      while (['queued', 'running', 'finalizing'].includes(job.status)) job = await call<JobView>('generation.get', { jobId: job.jobId, waitMs: 30_000 })
      if (job.status !== 'succeeded') throw new RpcError(job.error?.code ?? 'unavailable', job.error?.message ?? 'Panel generation did not succeed', job.error?.data)
      const output = job.outputs[0]?.delivery.nodeId
      if (output && linked) await apply([{ op: 'node.setMeta', nodeId: output, shot: { ...linked, role: kind === 'image' ? 'first' : 'video' } }])
    },
  }
}
