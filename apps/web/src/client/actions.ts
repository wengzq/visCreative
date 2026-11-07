import type { CanvasOp, JobView, MediaPreview, MediaTaskView, MethodParams, MethodResult, NodeKind, NodeView } from '@vis/protocol'
import { ASSET_REF_PATTERN, isMediaKind, PROMPT_REF_PATTERN } from '@vis/protocol'
import type { CanvasActions } from '@vis/canvas-ui'
import { assembleScriptTimeline, nodeTitleNumber, readChoice, resolveChoice, timelineMessages } from '@vis/canvas-ui'
import { describeError, formatter, messagesFor, type Locale } from '@vis/ui-kit'
import { actionMessages } from './messages'
import { RpcError } from './rpc'
import type { SpaceConnection } from './space'
import { generationOperations, operationChoice } from './operations'
import { previzCanvasActions } from './previz-actions'
import { scriptCanvasActions } from './script-actions'
import { scriptMessages } from './script-messages'

export type Notice = { id: number; kind: 'info' | 'error'; text: string; copy?: string }

const MEDIA_WIDTH = 320
const rid = () => `web-${crypto.randomUUID()}`
type PreparedRender = { params: MethodParams<'generation.submit'>; revision: number }
const renderRequestsByConnection = new WeakMap<SpaceConnection, Map<string, Promise<PreparedRender>>>()

/** Canvas user actions -> canvas.apply / upload; failures notify the user through notify */
export function canvasActions(conn: SpaceConnection, notify: (n: Omit<Notice, 'id'>) => void, locale: Locale | (() => Locale) = 'zh-CN'): CanvasActions {
  const getLocale = () => typeof locale === 'function' ? locale() : locale
  const m = () => messagesFor(actionMessages, getLocale())
  const format = () => formatter(getLocale())
  const projectId = conn.getView().space?.spaceId
  const assertCurrentProject = () => {
    if (!projectId || conn.getView().space?.spaceId !== projectId || !conn.getView().ready) throw new Error(m().projectChanged)
  }
  const call = async <T = any>(method: string, params?: unknown): Promise<T> => {
    assertCurrentProject()
    const result = await conn.rpc.call<T>(method, params)
    assertCurrentProject()
    return result
  }
  const apply = (ops: unknown[], description?: string) => call<{ idMap: Record<string, string>; eventSeq: number }>('canvas.apply', { requestId: rid(), ops, ...(description ? { description } : {}) })
  const defaultGeneration = (kind: 'image' | 'video' | 'audio') => {
    const saved = readChoice(`vis.gen.last.${kind}`)
    const catalog = conn.getView().providers
    const generation = catalog ? resolveChoice(catalog, kind, saved) : saved
    return generation ? { generation } : {}
  }
  const fail = (what: () => string) => (error: unknown) => {
    notify({ kind: 'error', text: m().failed(what(), describeError(error, getLocale())) })
    throw error
  }
  const jobActions = new Map<string, Promise<void>>()
  const jobAction = (key: string, work: () => Promise<void>) => {
    const pending = jobActions.get(key)
    if (pending) return pending
    const result = work().finally(() => jobActions.delete(key))
    jobActions.set(key, result)
    return result
  }
  let renderRequests = renderRequestsByConnection.get(conn)
  if (!renderRequests) {
    renderRequests = new Map()
    renderRequestsByConnection.set(conn, renderRequests)
  }

  return {
    ...scriptCanvasActions(conn, call, apply, getLocale),
    ...previzCanvasActions(call, apply, () => conn.getView().providers),
    onPreview: (assetVersionId, kind) => call<MediaPreview>('media.preview', { assetVersionId, kind }),
    async onAssembleScriptTimeline(scriptNodeId) {
      const sm = () => messagesFor(scriptMessages, getLocale())
      try {
        const { nodes } = await call<{ nodes: NodeView[] }>('canvas.get', {})
        const script = nodes.find(node => node.nodeId === scriptNodeId)
        if (!script) throw new Error(m().nodeDeleted)
        const content = script.slots.find(slot => slot.slotKey === 'main')?.content
        if (content?.type !== 'script') throw new Error(m().nodeDeleted)
        const candidates = assembleScriptTimeline(scriptNodeId, content.doc, nodes)
        const selected = new Set(candidates.items.map(item => typeof item === 'string' ? item : item.nodeId))
        const assetIds = new Set(nodes.filter(node => selected.has(node.nodeId) && node.kind === 'video').flatMap(node => {
          const main = node.slots.find(slot => slot.slotKey === 'main')?.content
          return main?.type === 'asset' ? [main.assetVersionId] : []
        }))
        const durations = new Map(await Promise.all([...assetIds].map(async assetVersionId => {
          const asset = await call<MethodResult<'asset.get'>>('asset.get', { assetVersionId })
          return [assetVersionId, asset.durationMs] as const
        })))
        const { items, skipped } = assembleScriptTimeline(scriptNodeId, content.doc, nodes, durations)
        if (!items.length) throw new Error(skipped.some(shot => shot.reason === 'limit') ? sm().limitedShots(format().number(skipped.length)) : sm().noTimelineShots)
        const scriptTitle = script.title ?? m().defaultTitle(m().script, format().number(nodeTitleNumber(script, nodes)))
        const suffix = sm().timelineTitle('')
        const { idMap } = await apply([{ op: 'node.create', tempId: 'n', kind: 'timeline', title: sm().timelineTitle(scriptTitle.slice(0, 60 - suffix.length)), content: { timelineFrom: items } }], sm().assembleTimeline)
        const missing = skipped.filter(shot => shot.reason === 'missing').length
        const limited = skipped.filter(shot => shot.reason === 'limit').length
        notify({ kind: 'info', text: [sm().timelineCreated, missing ? sm().missingShots(format().number(missing)) : '', limited ? sm().limitedShots(format().number(limited)) : ''].filter(Boolean).join(' · ') })
        return idMap.n!
      } catch (error) { return fail(() => sm().assembleTimeline)(error) }
    },
    async onCreatePreviz(at) {
      const { idMap } = await apply([{ op: 'node.create', tempId: 'n', kind: 'previz', ...at }], m().previz)
      return idMap.n!
    },
    async onCreateScene(at) {
      const { idMap } = await apply([{ op: 'node.create', tempId: 'n', kind: 'scene', ...at }], m().scene)
      return idMap.n!
    },
    async onCreateTimeline(at) {
      const { idMap } = await apply([{ op: 'node.create', tempId: 'n', kind: 'timeline', ...at }], messagesFor(timelineMessages, getLocale()).create)
      return idMap.n!
    },
    async onCreateTimelineFrom(nodeIds) {
      const { idMap } = await apply([{ op: 'node.create', tempId: 'n', kind: 'timeline', content: { timelineFrom: nodeIds } }], messagesFor(timelineMessages, getLocale()).create)
      return idMap.n!
    },
    generationOperations: generationOperations(conn.getView().providers),

    onResolveAsset: assetVersionId => call('asset.get', { assetVersionId }),
    onMediaCancel: taskId => call('media.cancel', { taskId }),
    onMediaDismiss: taskId => call('media.dismiss', { taskId }),
    onMediaDownload(taskId) {
      assertCurrentProject()
      const link = document.createElement('a')
      link.href = `/exports/${encodeURIComponent(projectId!)}/${encodeURIComponent(taskId)}?t=${encodeURIComponent(conn.token)}`
      link.download = ''
      link.click()
    },
    async onMediaProcess(request, onStarted) {
      try {
        let task = await call<MediaTaskView>('media.process', { ...request, requestId: rid(), waitMs: 0 })
        conn.recordMediaTask(task)
        onStarted?.(task)
        while (task.status === 'queued' || task.status === 'running') {
          task = await call<MediaTaskView>('media.get', { taskId: task.taskId, waitMs: 30_000 })
          conn.recordMediaTask(task)
        }
        if (task.status === 'failed') throw new RpcError(task.error?.code ?? 'media.failed', task.error?.message ?? m().processMedia)
        return task
      } catch (error) { return fail(() => m().processMedia)(error) }
    },

    onMediaAnalyze: (nodeId, slotId) => call<{ durationMs: number; pointsMs: number[] }>('media.analyze', { operation: 'audio.silence', nodeId, slotId })
      .catch(fail(() => m().analyzeMedia)),

    async onRunOperation(nodeId, operation) {
      try {
        const { nodes } = await call<{ nodes: NodeView[] }>('canvas.get', { nodeIds: [nodeId] })
        const node = nodes.find(node => node.nodeId === nodeId)
        if (!node) throw new Error(m().nodeDeleted)
        const main = node.slots.find(slot => slot.slotKey === 'main')
        if (!main || main.content.type !== 'asset') throw new Error(m().missingMedia)
        const catalog = conn.getView().providers
        const choice = catalog ? operationChoice(catalog, node, operation) : null
        if (!choice) throw new Error(m().unsupportedOperation)
        await call('generation.submit', {
          requestId: rid(), operation, kind: node.kind, ...choice,
          inputs: [{ slotId: main.slotId, revision: main.revision }],
          targets: [{ outputIndex: 0, kind: 'new_node', nearNodeId: nodeId }],
        })
      } catch (error) { fail(() => m().generate)(error) }
    },

    async onUploadReference(nodeId, files) {
      try {
        assertCurrentProject()
        const spaceId = projectId!
        const uploaded: { kind: NodeKind; assetVersionId: string; width?: number; height?: number }[] = []
        for (const file of files) {
          const res = await fetch(`/upload?t=${encodeURIComponent(conn.token)}&space=${encodeURIComponent(spaceId)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
          const json = await res.json()
          assertCurrentProject()
          if (!res.ok) throw new RpcError(json.error?.data?.code ?? json.error?.code ?? 'rpc_error', json.error?.message ?? `HTTP ${res.status}`, json.error?.data ?? json.error)
          if (isMediaKind(json.kind)) uploaded.push(json)
          else if (json.kind === 'model') notify({ kind: 'info', text: m().modelImported(file.name) })
        }
        if (!uploaded.length) return
        const { nodes } = await call<{ nodes: NodeView[] }>('canvas.get', { nodeIds: [nodeId] })
        const target = nodes.find(node => node.nodeId === nodeId)
        if (!target) throw new Error(m().nodeDeleted)
        const ops: CanvasOp[] = uploaded.map((asset, index) => ({
          op: 'node.create', tempId: `reference-${index}`, kind: asset.kind,
          x: target.x - (MEDIA_WIDTH + 40), y: target.y + index * (MEDIA_WIDTH + 40),
          w: asset.kind === 'audio' ? 360 : MEDIA_WIDTH,
          h: asset.kind === 'audio' ? 140 : asset.width && asset.height ? Math.max(1, Math.round(MEDIA_WIDTH * asset.height / asset.width)) : asset.kind === 'video' ? 180 : MEDIA_WIDTH,
          content: { assetVersionId: asset.assetVersionId },
        }))
        ops.push({ op: 'node.setInputs', nodeId, inputNodeIds: [...(target.inputs ?? []), ...uploaded.map((_, index) => `reference-${index}`)] })
        await apply(ops, m().uploadReferences)
      } catch (error) { fail(() => m().uploadReferences)(error) }
    },

    onApply: (ops, description) => {
      const requestLocale = getLocale()
      return apply(ops, description).catch(async error => {
        if (error instanceof RpcError && error.code === 'revision_conflict' && ops.some(op => op.op === 'script.patch')) {
          const slotIds = new Set(ops.flatMap(op => op.op === 'script.patch' ? [op.slotId] : []))
          const nodeIds = [...conn.getView().state.nodes.values()].filter(node => node.slots.some(slot => slotIds.has(slot.slotId))).map(node => node.nodeId)
          await conn.refreshNodes(nodeIds).catch(() => {})
          const copy = ops.flatMap(op => op.op === 'script.patch' ? op.ops.flatMap(row => row.kind === 'shot.update' || row.kind === 'asset.update'
            ? Object.values(row.fields).filter((value): value is string => typeof value === 'string') : []) : []).join('\n')
          notify({ kind: 'error', text: m().textConflict, copy })
          throw error
        }
        return fail(() => getLocale() === requestLocale ? description ?? m().updateCanvas : m().updateCanvas)(error)
      }).then(() => {})
    },

    async onRenderCode(nodeId, requestId) {
      try {
        assertCurrentProject()
        const key = `${projectId}:${nodeId}:${requestId}`
        let prepared = renderRequests.get(key)
        if (!prepared) {
          // Retries must reuse the initially read revisions and targets to avoid changing content under the same idempotency key after outputs fill targets.
          prepared = (async () => {
            const { nodes } = await call<{ nodes: NodeView[] }>('canvas.get', {})
            const node = nodes.find(n => n.nodeId === nodeId)
            const main = node?.slots.find(s => s.slotKey === 'main')
            if (!node) throw new Error(m().nodeDeleted)
            if (node.kind !== 'text' || node.format !== 'code') throw new Error(m().codeNodesOnly)
            if (!main || main.revision === 0 || main.content.type !== 'text' || !main.content.body.trim()) throw new Error(m().emptyCode)
            const inputs = [{ slotId: main.slotId, revision: main.revision }]
            for (const id of new Set(node.inputs ?? [])) {
              if (id === nodeId) continue
              const slot = nodes.find(n => n.nodeId === id)?.slots.find(s => s.slotKey === 'main')
              if (!slot || slot.revision === 0 || slot.content.type === 'empty') continue
              if (slot.content.type === 'text' && !slot.content.body.trim()) continue
              inputs.push({ slotId: slot.slotId, revision: slot.revision })
            }
            const result = nodes.find(n => n.kind === 'video' && n.slots.find(s => s.slotKey === 'main')?.source?.inputNodeIds.includes(nodeId))
            const target = result?.slots.find(s => s.slotKey === 'main')
            return {
              revision: main.revision,
              params: {
                requestId, provider: 'render', model: 'html', kind: 'video' as const,
                prompt: m().renderPrompt(nodeId), inputs,
                ...(node.generation?.params ? { params: node.generation.params } : {}),
                targets: target
                  ? [{ outputIndex: 0, kind: 'slot' as const, slotId: target.slotId, expectedRevision: target.revision }]
                  : [{ outputIndex: 0, kind: 'new_node' as const, nearNodeId: nodeId }],
              },
            }
          })().catch(error => { renderRequests.delete(key); throw error })
          renderRequests.set(key, prepared)
        }
        const { params, revision } = await prepared
        const { jobId } = await call<{ jobId: string }>('generation.submit', params)
        return { jobId, revision }
      } catch (error) { return fail(() => m().render)(error) }
    },

    onGetRenderJob: jobId => call<JobView>('generation.get', { jobId }).catch(fail(() => m().getRenderJob)),

    onLayout: (nodeId, l) => apply([{ op: 'node.layout', nodeId, x: l.x, y: l.y, w: l.w, h: l.h }]).then(() => {}, fail(() => m().move)),

    onMove: ops => apply(ops, m().moveNodes).then(() => {}, fail(() => m().move)),

    onDelete: nodeIds => {
      apply(nodeIds.map(nodeId => ({ op: 'node.delete', nodeId })), m().deleteNodes).catch(fail(() => m().deleteAction)).catch(() => {})
    },

    async onTextCommit(slotId, body, expectedRevision) {
      try {
        await apply([{ op: 'slot.setText', slotId, body, expectedRevision }])
        return 'ok'
      } catch (error) {
        if (error instanceof RpcError && error.code === 'revision_conflict') {
          notify({ kind: 'error', text: m().textConflict, copy: body })
          return 'conflict'
        }
        return fail(() => m().saveText)(error)
      }
    },

    onLoadHistory: async slotId => {
      try { assertCurrentProject(); await conn.loadHistory(slotId); assertCurrentProject() }
      catch (error) { fail(() => m().loadHistory)(error) }
    },

    async onRestoreVersion(slotId, assetVersionId, expectedRevision, version) {
      try {
        await apply([{ op: 'slot.setAsset', slotId, assetVersionId, expectedRevision }], m().restoreVersionDescription(format().number(version)))
        return 'ok'
      } catch (error) {
        if (error instanceof RpcError && error.code === 'revision_conflict') {
          assertCurrentProject()
          notify({ kind: 'error', text: m().nodeChanged })
          await conn.loadHistory(slotId, true).catch(error => {
            notify({ kind: 'error', text: m().failed(m().loadHistory, describeError(error, getLocale())) })
          })
          return 'conflict'
        }
        return fail(() => m().restoreVersion)(error)
      }
    },

    async onSaveVersion(node, assetVersionId, version, at) {
      try {
        const { idMap } = await apply([{ op: 'node.create', tempId: 'n', kind: node.kind, x: at.x, y: at.y, w: node.w, h: node.h, content: { assetVersionId }, ...(node.generation ? { generation: node.generation } : {}) }], m().saveVersionDescription(format().number(version)))
        return idMap.n!
      } catch (error) {
        return fail(() => m().saveVersion)(error)
      }
    },

    onCreateText: at => {
      apply([{ op: 'node.create', tempId: 'n', kind: 'text', x: at.x, y: at.y, w: 560, h: 420, content: { text: '' } }]).catch(fail(() => m().createText)).catch(() => {})
    },

    onCreateGenNode: (kind, at) => {
      apply([{ op: 'node.create', tempId: 'n', kind, x: at.x, y: at.y, w: kind === 'audio' ? 360 : 320, h: kind === 'audio' ? 140 : kind === 'image' ? 320 : 180, prompt: '', ...defaultGeneration(kind) }]).catch(fail(() => m().createGenerationNode)).catch(() => {})
    },

    onSetInputs: (nodeId, inputNodeIds) => apply([{ op: 'node.setInputs', nodeId, inputNodeIds }]).then(() => {}, fail(() => m().setInputs)),
    async onSetGeneration(nodeId, generation) {
      try {
        const { eventSeq } = await apply([{ op: 'node.setGeneration', nodeId, ...(generation ? { generation } : {}) }], m().setGenerationDescription)
        if (conn.getView().state.seq >= eventSeq) return
        // Acknowledgments can precede events; retain the panel draft until the store applies these settings.
        await new Promise<void>((resolve, reject) => {
          const stop = conn.subscribe(() => {
            try {
              assertCurrentProject()
              if (conn.getView().status === 'closed') throw new Error(m().connectionClosed)
              if (conn.getView().state.seq >= eventSeq) { stop(); resolve() }
            } catch (error) { stop(); reject(error) }
          })
        })
      } catch (error) { fail(() => m().saveGeneration)(error) }
    },

    async onExtend(nodeId, kind, at) {
      try {
        const { nodes } = await call<{ nodes: NodeView[] }>('canvas.get', { nodeIds: [nodeId] })
        const source = nodes[0]
        if (!source) throw new Error(m().nodeDeleted)
        const create = { op: 'node.create', tempId: 'n', kind, x: at.x, y: at.y, w: kind === 'audio' ? 360 : 320, h: kind === 'audio' ? 140 : kind === 'text' ? 200 : kind === 'image' ? 320 : 180 }
        const ops = kind === 'text'
          ? [{ ...create, content: { text: '' } }, { op: 'node.setInputs', nodeId, inputNodeIds: [...(source.inputs ?? []), 'n'] }]
          : [{ ...create, prompt: '', inputNodeIds: [nodeId], ...(source.kind === kind ? source.generation ? { generation: source.generation } : {} : defaultGeneration(kind)) }]
        const { idMap } = await apply(ops, m().extendNodes)
        return idMap.n!
      } catch (error) {
        return fail(() => m().extendNodes)(error)
      }
    },

    async onClone(nodes, at) {
      nodes = nodes.filter(node => node.kind !== 'frame')
      if (!nodes.length) return []
      const left = Math.min(...nodes.map(n => n.x))
      const top = Math.min(...nodes.map(n => n.y))
      const ids = new Map(nodes.map((n, i) => [n.nodeId, `copy-${i}`]))
      // Frames are created with work items and are not copied
      const ops: CanvasOp[] = nodes.filter((node): node is NodeView & { kind: NodeKind } => node.kind !== 'frame').map(node => {
        const main = node.slots.find(s => s.slotKey === 'main')?.content
        const prompt = node.slots.find(s => s.slotKey === 'prompt')
        const sourceTitle = node.title ?? m().defaultTitle(m()[node.kind], format().number(nodeTitleNumber(node, [...(conn.getView().state.nodes?.values() ?? nodes)])))
        const suffix = m().copyTitle('')
        return {
          op: 'node.create', tempId: ids.get(node.nodeId)!, kind: node.kind,
          x: at.x + node.x - left, y: at.y + node.y - top, w: node.w, h: node.h,
          title: m().copyTitle(sourceTitle.slice(0, 60 - suffix.length)),
          ...(main?.type === 'text' ? { content: { text: main.body } } : main?.type === 'asset' ? { content: { assetVersionId: main.assetVersionId } } : {}),
          ...(prompt ? { prompt: prompt.content.type === 'text' ? prompt.content.body : '' } : {}),
          ...(node.generation ? { generation: node.generation } : {}),
        }
      })
      // Create all nodes first so references can point to copies anywhere in the selection order
      for (const node of nodes) {
        const main = node.slots.find(slot => slot.slotKey === 'main')?.content
        if (main?.type === 'previz') ops.push({ op: 'previz.set', slotId: `${ids.get(node.nodeId)}:main`, expectedRevision: 1, doc: main.doc })
        if (main?.type === 'scene') ops.push({ op: 'scene.set', slotId: `${ids.get(node.nodeId)}:main`, expectedRevision: 1, doc: main.doc })
        if (node.kind === 'script' && main?.type === 'script') {
          const { doc } = main
          const rowId = (id: string) => `${ids.get(node.nodeId)}-${id}`
          const assets = new Map(doc.assets.map(asset => [asset.id, rowId(asset.id)]))
          const remapText = (value: unknown) => typeof value === 'string'
            ? value.replace(ASSET_REF_PATTERN, (match, id: string) => assets.has(id) ? `{{asset:${assets.get(id)}}}` : match)
              .replace(PROMPT_REF_PATTERN, (match, id: string) => ids.has(id) ? `{{ref:${ids.get(id)}}}` : match)
            : value
          ops.push({ op: 'script.replace', slotId: `${ids.get(node.nodeId)}:main`, expectedRevision: 1, doc: {
            style: doc.style, sessionId: doc.sessionId,
            shots: doc.shots.map(({ id, rev: _rev, promptState: _promptState, ...fields }) => ({
              ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, remapText(value)])),
              tempId: rowId(id), description: remapText(fields.description) as string,
              sceneId: fields.sceneId ? assets.get(fields.sceneId) ?? fields.sceneId : fields.sceneId,
              characterIds: fields.characterIds.map(id => assets.get(id) ?? id),
              propIds: fields.propIds.map(id => assets.get(id) ?? id),
            })),
            assets: doc.assets.map(({ id, rev: _rev, ...fields }) => ({
              ...fields, tempId: rowId(id), description: remapText(fields.description) as string,
              imageNodeId: fields.imageNodeId ? ids.get(fields.imageNodeId) ?? fields.imageNodeId : fields.imageNodeId,
            })),
          } })
        }
        if (node.inputs?.length) ops.push({ op: 'node.setInputs', nodeId: ids.get(node.nodeId)!, inputNodeIds: node.inputs.map(id => ids.get(id) ?? id) })
      }
      try {
        const { idMap } = await apply(ops, m().cloneNodes)
        return nodes.map(n => idMap[ids.get(n.nodeId)!]!)
      } catch (error) { return fail(() => m().cloneNodes)(error) }
    },

    async onExtendReferences(nodeIds, kind, at) {
      try {
        const { idMap } = await apply([{ op: 'node.create', tempId: 'n', kind, ...at, w: kind === 'audio' ? 360 : 320, h: kind === 'audio' ? 140 : kind === 'image' ? 320 : 180, prompt: '', inputNodeIds: nodeIds, ...defaultGeneration(kind) }], m().generateFromReferences)
        return idMap.n!
      } catch (error) { return fail(() => m().extendNodes)(error) }
    },

    onDownload(nodes) {
      assertCurrentProject()
      const spaceId = conn.getView().space?.spaceId
      if (!spaceId) return
      for (const node of nodes) {
        const content = node.slots.find(s => s.slotKey === 'main')?.content
        const link = document.createElement('a')
        let blobUrl: string | undefined
        if (node.kind === 'text') {
          blobUrl = URL.createObjectURL(new Blob([content?.type === 'text' ? content.body : ''], { type: 'text/plain;charset=utf-8' }))
          link.href = blobUrl
          link.download = m().textFilename(new Date().toISOString().slice(0, 10))
        } else if (content?.type === 'asset') {
          link.href = `/assets/${encodeURIComponent(spaceId)}/${encodeURIComponent(content.assetVersionId)}?t=${encodeURIComponent(conn.token)}&download=1`
          link.download = ''
        } else continue
        document.body.append(link)
        link.click()
        link.remove()
        if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl!), 1000)
      }
    },

    async onGenerate(nodeId, choice) {
      try {
        // Text submission acknowledgments may precede UI events; read the saved backend prompt when generating
        const { nodes } = await call<{ nodes: NodeView[] }>('canvas.get', { nodeIds: [nodeId] })
        const node = nodes[0]
        const main = node?.slots.find(s => s.slotKey === 'main')
        const prompt = node?.slots.find(s => s.slotKey === 'prompt')
        if (!node || node.kind === 'text' || !main || prompt?.content.type !== 'text' || !prompt.content.body.trim()) return
        const refs = node.inputs?.length
          ? (await call<{ nodes: NodeView[] }>('canvas.get', { nodeIds: node.inputs })).nodes
          : []
        const inputs = [{ slotId: prompt.slotId, revision: prompt.revision }]
        for (const id of node.inputs ?? []) {
          const slot = refs.find(n => n.nodeId === id)?.slots.find(s => s.slotKey === 'main')
          // Skip references without content (empty generation nodes or text), or the backend rejects the entire submission
          if (!slot || slot.revision === 0 || slot.content.type === 'empty') continue
          if (slot.content.type === 'text' && !slot.content.body.trim()) continue
          inputs.push({ slotId: slot.slotId, revision: slot.revision })
        }
        await call('generation.submit', {
          requestId: rid(),
          kind: node.kind, prompt: prompt.content.body,
          inputs,
          ...choice,
          targets: [{ outputIndex: 0, kind: 'slot', slotId: main.slotId }],
        })
      } catch (error) {
        fail(() => m().generate)(error)
      }
    },

    onCancelGeneration: jobId => jobAction(`cancel:${jobId}`, async () => {
      try { await call('generation.cancel', { requestId: rid(), jobId }) }
      catch (error) { fail(() => m().cancelGeneration)(error) }
    }),

    onRecheck: jobId => jobAction(`recheck:${jobId}`, async () => {
      try { await call('generation.recheck', { requestId: rid(), jobId }) }
      catch (error) { fail(() => m().recheck)(error) }
    }),

    onRegenerate: jobId => jobAction(`regenerate:${jobId}`, async () => {
      try {
        const job = await call<JobView>('generation.get', { jobId })
        if (job.status === 'unknown' && !window.confirm(m().regenerateConfirm)) return
        await call('generation.regenerate', { requestId: rid(), jobId })
        conn.dismissJobs([jobId])
      } catch (error) { fail(() => m().regenerate)(error) }
    }),

    onDropFiles: (files, at) => {
      assertCurrentProject()
      const spaceId = conn.getView().space?.spaceId
      if (!spaceId) return
      files.forEach((file, i) => {
        void (async () => {
          const res = await fetch(`/upload?t=${encodeURIComponent(conn.token)}&space=${encodeURIComponent(spaceId)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
          const json = await res.json()
          if (!res.ok) throw new RpcError(json.error?.data?.code ?? json.error?.code ?? 'rpc_error', json.error?.message ?? `HTTP ${res.status}`, json.error?.data ?? json.error)
          if (json.kind === 'model') notify({ kind: 'info', text: m().modelImported(file.name) })
          if (!isMediaKind(json.kind)) return
          const w = json.kind === 'audio' ? 360 : MEDIA_WIDTH
          const h = json.kind === 'audio' ? 140 : json.width && json.height ? Math.round((MEDIA_WIDTH * json.height) / json.width) : json.kind === 'video' ? 180 : MEDIA_WIDTH
          await apply([{ op: 'node.create', tempId: 'n', kind: json.kind, x: at.x + i * (MEDIA_WIDTH + 40), y: at.y, w, h, content: { assetVersionId: json.assetVersionId } }], m().importDescription(file.name))
        })().catch(error => notify({ kind: 'error', text: m().importFailed(file.name, describeError(error, getLocale())) }))
      })
    },
  }
}
