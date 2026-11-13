import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { EMPTY_SCENE, emptyPrevizPanel, type CanvasOp, type EntityView, type MethodName, type MethodParams, type MethodResult, type NodeView, type PrevizDoc, type SceneDoc, type ScriptDoc, type TextProposal, type TimelineDoc, type WorkItemView } from '@vis/protocol'

export type Call = <M extends MethodName>(method: M, params: MethodParams<M>) => Promise<MethodResult<M>>
export type EpisodeSnapshot = { spaceId: string; seq: number; nodes: NodeView[]; entities: EntityView[]; proposals: TextProposal[] }
export type Fixture = { vars: Record<string, string>; nodeIds: string[]; jobIds: string[]; earlierEpisode?: EpisodeSnapshot; workItems?: WorkItemView[] }
export const requestId = () => randomUUID()
export const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
export const mainSlot = (node: NodeView) => node.slots.find(slot => slot.slotKey === 'main')!
export const scriptDoc = (node?: NodeView): ScriptDoc | undefined => {
  const content = node && mainSlot(node).content
  return content?.type === 'script' ? content.doc : undefined
}
export const timelineDoc = (node?: NodeView): TimelineDoc | undefined => {
  const content = node && mainSlot(node).content
  return content?.type === 'timeline' ? content.doc : undefined
}
export const previzDoc = (node?: NodeView): PrevizDoc | undefined => {
  const content = node && mainSlot(node).content
  return content?.type === 'previz' ? content.doc : undefined
}
export const sceneDoc = (node?: NodeView): SceneDoc | undefined => {
  const content = node && mainSlot(node).content
  return content?.type === 'scene' ? content.doc : undefined
}

// A deterministic raster storyboard keeps real image inspection independent of providers and external tools.
function panelPng(index: number, layer: 'underlay' | 'sketch' | 'image'): Buffer {
  const width = 640, height = 360
  const pixels = Buffer.alloc((width * 4 + 1) * height)
  const put = (x: number, y: number, color: number[]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const offset = y * (width * 4 + 1) + 1 + x * 4
    color.forEach((value, i) => { pixels[offset + i] = value })
  }
  const rect = (x: number, y: number, w: number, h: number, color: number[]) => {
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) put(px, py, color)
  }
  const line = (x1: number, y1: number, x2: number, y2: number, color: number[]) => {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1))
    for (let step = 0; step <= steps; step++) rect(Math.round(x1 + (x2 - x1) * step / steps), Math.round(y1 + (y2 - y1) * step / steps), 3, 3, color)
  }
  const ink = [45, 54, 65, 255], blue = [70, 105, 155, 255]
  if (layer !== 'sketch') {
    rect(0, 0, width, height, [236, 231, 218, 255])
    rect(0, 245, width, 115, [205, 200, 186, 255])
    rect(475, 65, 100, 205, [133, 143, 150, 255])
    rect(485, 75, 80, 195, [224, 221, 210, 255])
    line(0, 245, 640, 245, ink)
    line(140, 360, 300, 245, ink)
    line(480, 360, 380, 245, ink)
  }
  if (layer !== 'underlay') {
    const x = [150, 240, 350, 475][index]!
    rect(x - 15, 174, 30, 57, blue)
    for (let y = -16; y <= 16; y++) for (let dx = -16; dx <= 16; dx++) if (dx * dx + y * y <= 256) put(x + dx, 151 + y, ink)
    line(x - 8, 230, x - 20, 277, ink)
    line(x + 8, 230, x + 25, 277, ink)
    line(x - 15, 180, x - 35, 207, ink)
    line(x + 15, 180, x + 39, 205, ink)
    rect(x + 25, 199, 48, 38, [158, 130, 92, 255])
    line(75, 310, 420, 310, blue)
    line(420, 310, 400, 299, blue)
    line(420, 310, 400, 321, blue)
    for (let n = 0; n <= index; n++) rect(20 + n * 15, 20, 8, 16, ink)
  }
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

export async function snapshotEpisode(call: Call, spaceId: string): Promise<EpisodeSnapshot> {
  const snapshot = await call('events.subscribe', { spaceId })
  if (!snapshot.reset) throw new Error('Expected a full episode snapshot')
  return { spaceId, seq: snapshot.seq, nodes: snapshot.snapshot.nodes, entities: (await call('entity.list', { includeDeleted: true })).items, proposals: (await call('text.proposal.list', { status: 'all' })).proposals }
}

export const manuscriptChapter = '# 第三章 夜航\n\n## 候船\n\n林舟把旧船票压在掌心。码头的灯隔着雾，只剩一圈圈淡黄的光。他答应过阿岚，天亮前会把信送到北岸。\n\n## 门前\n\n林舟在旧书店门前停下。雨水沿着屋檐落下来，他听见门里有人轻轻咳了一声，却迟迟没有抬手敲门。\n\n## 来客\n\n阿岚推开门，灰围巾上沾着细雨。她把一把铜钥匙放进林舟手里，说北岸渡口今夜只留一盏灯。林舟收好钥匙，转身走向河边。'
export const repeatedSentence = '门外的雨还没停。'
export const repeatedChapter = `# 第四章 两次等候\n\n## 午后\n\n${repeatedSentence}林舟在码头等阿岚，把船票折成四折。\n\n## 深夜\n\n${repeatedSentence}林舟回到旧书店，终于听见了钥匙转动的声音。`
export const earlierChapter = '# 第一章 约定\n\n林舟的左耳听不见声音，他总把右耳朝向说话的人。阿岚是他的姐姐，习惯系一条灰围巾。他们约好只在天亮后乘渡船，绝不夜航。那封没有署名的信一直锁在旧书店的木匣里，钥匙由阿岚保管。'

export async function buildFixture(kind: string, call: Call, rootPath: string, checkAbort: () => void, repositoryRoot: string, projectSpaceId?: string): Promise<Fixture> {
  const fixture: Fixture = { vars: {}, nodeIds: [], jobIds: [] }
  const apply = (ops: CanvasOp[]) => call('canvas.apply', { requestId: requestId(), ops })
  const nodes = async () => (await call('canvas.get', {})).nodes
  if (kind === 'scene-protected') {
    const created = await apply([{ op: 'node.create', tempId: 'stage', kind: 'scene', title: 'Author stage' }])
    const nodeId = created.idMap.stage!
    const slot = mainSlot((await nodes()).find(node => node.nodeId === nodeId)!)
    const doc: SceneDoc = { ...EMPTY_SCENE, objects: [{
      id: 'bench', name: 'Author bench', createdBy: 'agent', userTouched: false, hidden: false,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      source: { type: 'prop', propId: 'bench' },
    }], views: [{
      id: 'wide', name: 'Author wide', createdBy: 'agent', userTouched: false, still: null, aspectRatio: '16:9',
      camera: { position: [4, 2, 5], target: [0, 0.8, 0], roll: 0, focalLengthMm: 35 },
    }] }
    await apply([{ op: 'scene.set', slotId: slot.slotId, expectedRevision: slot.revision, doc }])
    const edited: SceneDoc = { ...doc, objects: doc.objects.map(object => ({ ...object, transform: { ...object.transform, position: [0.25, 0, 0] } })) }
    const revision = mainSlot((await nodes()).find(node => node.nodeId === nodeId)!).revision
    await apply([{ op: 'scene.set', slotId: slot.slotId, expectedRevision: revision, doc: edited }])
    const saved = sceneDoc((await nodes()).find(node => node.nodeId === nodeId))!
    if (!saved.objects.every(object => object.createdBy === 'user' && object.userTouched)) throw new Error('Protected scene fixture must contain an author-touched object')
    Object.assign(fixture.vars, { sceneNodeId: nodeId, sceneObjectId: 'bench', sceneObjectName: 'Author bench' })
    fixture.nodeIds.push(nodeId)
  }
  if (kind === 'finished-children') {
    const created = await apply([{ op: 'node.create', tempId: 'notes', kind: 'text', title: '已审阅的笔记', purpose: 'working', content: { text: '动机审阅：按灭又点亮手机有清楚的犹豫。结尾审阅：旁白解释过满，建议交给动作。作者已读，保留笔记。' } }])
    fixture.nodeIds.push(created.idMap.notes!)
  }
  if (kind === 'child-review') {
    const created = await apply([{ op: 'node.create', tempId: 'brief', kind: 'text', title: '等雨停', format: 'markdown', content: { text: '下班后，姐姐站在便利店门口等雨停。她把手机屏幕按灭，又点亮，始终没有拨出弟弟的号码。雨停了，她仍站着。旁白说：她终于明白，亲人之间不该有秘密。' } }])
    fixture.vars.reviewNodeId = created.idMap.brief!
    fixture.nodeIds.push(fixture.vars.reviewNodeId)
  }
  if (kind.startsWith('manuscript-')) {
    const writeUserText = async (title: string, body: string) => {
      const created = await apply([{ op: 'node.create', tempId: 'chapter', kind: 'text', title, format: 'markdown', content: { text: 'An earlier draft, before the writer revised it.' } }])
      const nodeId = created.idMap.chapter!
      const slot = mainSlot((await nodes()).find(node => node.nodeId === nodeId)!)
      await apply([{ op: 'slot.setText', slotId: slot.slotId, expectedRevision: slot.revision, body }])
      const latest = mainSlot((await nodes()).find(node => node.nodeId === nodeId)!)
      if (latest.writer?.actor !== 'user' || latest.revision <= slot.revision) throw new Error('Manuscript fixture must have a user-written latest revision')
      return nodeId
    }
    const body = kind === 'manuscript-repeat' ? repeatedChapter : kind === 'manuscript-note' ? '待办：周五去旧书店取回阿岚留下的地图，顺便问问北岸渡口几点开船。' : kind === 'manuscript-series' ? '# 第二章 木匣\n\n清晨，林舟来到旧书店。阿岚已经等在门前，灰围巾被晨雾打湿。她打开木匣，把信交给弟弟。林舟把右耳转向她，等她解释信的来历。' : manuscriptChapter
    fixture.vars.manuscriptNodeId = await writeUserText(kind === 'manuscript-note' ? '取地图备忘' : '夜航手稿', body)
    fixture.nodeIds.push(fixture.vars.manuscriptNodeId)
    if (kind === 'manuscript-repeat') Object.assign(fixture.vars, { repeatedSentence, replacementSentence: '门外的雨渐渐小了。' })
    if (kind === 'manuscript-shots') {
      const created = await apply([{ op: 'node.create', tempId: 'script', kind: 'script', title: '夜航分镜' }])
      fixture.vars.scriptNodeId = created.idMap.script!
      fixture.nodeIds.push(fixture.vars.scriptNodeId)
    }
    if (kind === 'manuscript-settings') {
      const existing = await call('entity.create', { requestId: requestId(), kind: 'character', name: '林舟', description: '作者手动设定：五十岁的退休钟表匠，右手戴黑色手套，住在山城；这条设定暂时保留，不按本章覆盖。' })
      Object.assign(fixture.vars, { existingEntityId: existing.id, existingEntityName: existing.name })
    }
    if (kind === 'manuscript-series') {
      if (!projectSpaceId) throw new Error('Series fixture requires the current project ID')
      const series = await call('series.create', { requestId: requestId(), name: '雾中来信' })
      await call('space.setSeries', { requestId: requestId(), spaceId: projectSpaceId, series: { seriesId: series.seriesId }, episode: 2 })
      const earlier = await call('space.create', { requestId: requestId(), name: '第一章 约定', rootPath: `${rootPath}-earlier`, series: { seriesId: series.seriesId }, episode: 1 })
      await call('events.subscribe', { spaceId: earlier.spaceId })
      const earlierNodeId = await writeUserText('第一章 约定', earlierChapter)
      Object.assign(fixture.vars, { earlierSpaceId: earlier.spaceId, earlierNodeId })
      fixture.earlierEpisode = await snapshotEpisode(call, earlier.spaceId)
      await call('events.subscribe', { spaceId: projectSpaceId })
    }
  }
  if (kind.startsWith('previz')) {
    const created = await apply([
      { op: 'node.create', tempId: 'script', kind: 'script', title: '搬箱子：走向右侧门口' },
      { op: 'node.create', tempId: 'previz', kind: 'previz', title: '搬箱子镜头预演' },
    ])
    const scriptNodeId = created.idMap.script!, previzNodeId = created.idMap.previz!
    const notes = ['全景，人物在画面左侧抱着箱子，右侧是门口；镜头平视。', '人物抱箱向右走，摄影机轻轻向右平移跟随。', '中景，人物接近右侧门口，摄影机缓慢推近，保持行进方向。', '人物在门边停下并放下箱子，摄影机停稳。']
    const durations = [2, 1.5, 2.5, 2]
    const scriptSlot = mainSlot((await nodes()).find(node => node.nodeId === scriptNodeId)!)
    await apply([{ op: 'script.replace', slotId: scriptSlot.slotId, expectedRevision: scriptSlot.revision, doc: {
      style: 'Simple interior, one person carrying a box toward a door on the right', assets: [],
      shots: notes.map((description, index) => ({ tempId: `shot${index + 1}`, description, durationSec: durations[index]!, transition: 'cut', framePrompt: description, videoPrompt: description })),
    } }])
    const shots = scriptDoc((await nodes()).find(node => node.nodeId === scriptNodeId))!.shots
    const panels: PrevizDoc['panels'] = []
    for (let index = 0; index < 4; index++) {
      checkAbort()
      const pictures: Record<string, string> = {}
      for (const layer of ['underlay', 'sketch', 'image'] as const) {
        const path = join(rootPath, `panel-${index + 1}-${layer}.png`)
        writeFileSync(path, panelPng(index, layer))
        pictures[layer] = (await call('asset.import', { requestId: requestId(), path })).assetVersionId
      }
      panels.push({ ...emptyPrevizPanel(`panel-${index + 1}`), underlay: pictures.underlay!, sketch: pictures.sketch!, image: pictures.image!, note: notes[index]!,
        durationSec: kind === 'previz-missing-duration' && [1, 3].includes(index) ? null : durations[index]!,
        shot: kind === 'previz-unlinked' && [1, 3].includes(index) ? null : { scriptNodeId, shotId: shots[index]!.id },
      })
    }
    const previzSlot = mainSlot((await nodes()).find(node => node.nodeId === previzNodeId)!)
    await apply([{ op: 'previz.set', slotId: previzSlot.slotId, expectedRevision: previzSlot.revision, doc: { version: 1, rev: 0, aspectRatio: '16:9', panels } }])
    fixture.nodeIds.push(previzNodeId, scriptNodeId)
    Object.assign(fixture.vars, { previzNodeId, scriptNodeId })
    if (kind === 'previz-blockout') {
      const html = readFileSync(join(repositoryRoot, 'packages/generation/src/providers/render/fixtures/blockout.html'), 'utf8').replace('duration: 1,', 'duration: 8,')
      const code = await apply([{ op: 'node.create', tempId: 'code', kind: 'text', format: 'code', title: 'Existing blockout source', content: { text: html } }])
      const codeNodeId = code.idMap.code!
      const codeSlot = mainSlot((await nodes()).find(node => node.nodeId === codeNodeId)!)
      const job = await call('generation.submit', { requestId: requestId(), kind: 'video', provider: 'render', model: 'html', prompt: 'Fixture blockout',
        inputs: [{ slotId: codeSlot.slotId, revision: codeSlot.revision }, ...panels.map(panel => ({ assetVersionId: panel.image! }))],
        params: { width: 640, height: 360, durationMs: 8000, fps: 24 },
      })
      fixture.jobIds.push(job.jobId)
      const deadline = Date.now() + 120_000
      for (;;) {
        checkAbort()
        const view = await call('generation.get', { jobId: job.jobId })
        if (view.status === 'succeeded') {
          const output = view.outputs[0]!
          const videoNodeId = output.delivery.nodeId!
          await apply([
            { op: 'node.setInputs', nodeId: videoNodeId, inputNodeIds: [codeNodeId, previzNodeId] },
            { op: 'node.setMeta', nodeId: videoNodeId, shot: { ...panels[0]!.shot!, role: 'previz' } },
          ])
          fixture.nodeIds.push(videoNodeId)
          Object.assign(fixture.vars, { blockoutVideoNodeId: videoNodeId, blockoutAssetVersionId: output.assetVersionId })
          break
        }
        if (['failed', 'cancelled', 'unknown'].includes(view.status)) throw new Error(`Fixture blockout failed: ${view.error?.code ?? view.status}`)
        if (Date.now() >= deadline) throw new Error('Fixture blockout timed out')
        await pause(100)
      }
    }
  }
  if (kind === 'csv') {
    fixture.vars.csvPath = join(rootPath, 'monthly-sales.csv')
    writeFileSync(fixture.vars.csvPath, 'month,sales\n2026-01,12\n2026-02,18\n2026-03,15\n2026-04,24\n2026-05,28\n2026-06,35\n')
  }
  if (kind === 'script') {
    const result = await apply([{ op: 'node.create', tempId: 'script', kind: 'script', title: 'Six-shot commute' }])
    const scriptNodeId = result.idMap.script!
    const slot = mainSlot((await nodes()).find(node => node.nodeId === scriptNodeId)!)
    await apply([{ op: 'script.replace', slotId: slot.slotId, expectedRevision: slot.revision, doc: {
      style: 'Natural light, warm everyday story',
      assets: [{ tempId: 'hero', kind: 'character', name: 'Commuter', description: 'A young commuter wearing a blue coat' }],
      shots: ['An alarm rings at dawn', 'The commuter brews coffee', 'The commuter picks up a travel cup', 'The commuter walks along a rainy street', 'The commuter boards a bus', 'The commuter smiles by the window'].map((description, i) => ({
        tempId: `shot${i + 1}`, durationSec: 4, transition: 'cut', description, characterIds: ['hero'],
        framePrompt: `${description}, natural light, medium shot`, videoPrompt: `Slow camera movement: ${description}`,
      })),
    } }])
    fixture.nodeIds.push(scriptNodeId)
    fixture.vars.scriptNodeId = scriptNodeId
  }
  // 0024e: overlay scenarios start from the captioned three-shot timeline; E2's picture-in-picture
  // fixture has no captions, so its export also runs on an FFmpeg without the ASS filter
  const timelineKind = ['timeline', 'overlay', 'overlay-logo', 'pip'].includes(kind)
  const generate = async (media: 'image' | 'video', prompt: string, params: { width: number; height: number }) => {
    checkAbort()
    const job = await call('generation.submit', { requestId: requestId(), kind: media, provider: 'mock', model: media === 'image' ? 'mock-image-1' : 'mock-video-1', prompt, params })
    fixture.jobIds.push(job.jobId)
    const deadline = Date.now() + 60_000
    for (;;) {
      checkAbort()
      const view = await call('generation.get', { jobId: job.jobId })
      if (view.status === 'succeeded') {
        const nodeId = view.outputs[0]?.delivery.nodeId
        if (!nodeId) throw new Error('Fixture job succeeded without a delivered node')
        fixture.nodeIds.push(nodeId)
        return nodeId
      }
      if (['failed', 'cancelled', 'unknown'].includes(view.status)) throw new Error(`Fixture job failed: ${view.error?.code ?? view.status}`)
      if (Date.now() >= deadline) throw new Error('Fixture generation timed out')
      await pause(100)
    }
  }
  if (['image', 'videos'].includes(kind) || timelineKind) {
    for (let i = 0; i < (kind === 'image' ? 1 : 3); i++) await generate(kind === 'image' ? 'image' : 'video', `Fixture shot ${i + 1}`, { width: 128, height: 128 })
    if (kind === 'image') fixture.vars.imageNodeId = fixture.nodeIds[0]!
    else fixture.vars.videoNodeIds = fixture.nodeIds.join(', ')
  }
  if (timelineKind) {
    const result = await apply([{ op: 'node.create', tempId: 'timeline', kind: 'timeline', content: { timelineFrom: [...fixture.nodeIds] } }])
    const timelineNodeId = result.idMap.timeline!
    const node = (await nodes()).find(node => node.nodeId === timelineNodeId)!
    const doc = timelineDoc(node)!
    if (kind !== 'pip') doc.textTracks = [{ id: 'captions', hidden: false, clips: doc.tracks[0]!.clips.map((clip, i) => ({
      id: `caption${i + 1}`, startMs: clip.startMs, durationMs: clip.outMs - clip.inMs,
      text: `Shot ${i + 1}`, style: { preset: 'subtitle' }, fadeInMs: 0, fadeOutMs: 0,
    })) }]
    if (kind === 'pip') fixture.vars.shot3NodeId = fixture.nodeIds[2]!
    await apply([{ op: 'timeline.set', slotId: mainSlot(node).slotId, expectedRevision: mainSlot(node).revision, doc }])
    fixture.vars.timelineNodeId = timelineNodeId
    fixture.nodeIds.push(timelineNodeId)
  }
  if (kind === 'overlay' || kind === 'overlay-logo') {
    fixture.vars.logoNodeId = await generate('image', 'Fixture logo', { width: 128, height: 128 })
    fixture.vars.stickerNodeId = await generate('image', 'Fixture sticker', { width: 128, height: 96 })
  }
  if (kind === 'overlay-logo') {
    const node = (await nodes()).find(node => node.nodeId === fixture.vars.timelineNodeId)!
    const doc = timelineDoc(node)!
    const logo = mainSlot((await nodes()).find(item => item.nodeId === fixture.vars.logoNodeId)!).content
    if (logo.type !== 'asset') throw new Error('Fixture logo has no asset')
    const length = Math.max(...doc.tracks[0]!.clips.map(clip => clip.startMs + clip.outMs - clip.inMs))
    doc.tracks.splice(1, 0, { id: 'logos', kind: 'overlay', name: 'Logo', muted: false, volume: 1, clips: [{
      id: 'logo1', source: { nodeId: fixture.vars.logoNodeId!, assetVersionId: logo.assetVersionId },
      startMs: 0, inMs: 0, outMs: length, volume: 1, fadeInMs: 0, fadeOutMs: 0,
      overlay: { x: 0.9, y: 0.1, width: 0.12, opacity: 1 },
    }] })
    await apply([{ op: 'timeline.set', slotId: mainSlot(node).slotId, expectedRevision: mainSlot(node).revision, doc }])
  }
  if (kind === 'transparent-timeline') {
    // Both sources are deterministic local renders, so alpha compositing can be reviewed against a known blue underlay.
    const render = async (title: string, html: string, transparent: boolean) => {
      const created = await apply([{ op: 'node.create', tempId: 'code', kind: 'text', format: 'code', title: `${title} source`, content: { text: html } }])
      const slot = mainSlot((await nodes()).find(node => node.nodeId === created.idMap.code)!)
      const job = await call('generation.submit', { requestId: requestId(), kind: 'video', provider: 'render', model: 'html', prompt: title, inputs: [{ slotId: slot.slotId, revision: slot.revision }], params: { width: 320, height: 180, fps: 12, durationMs: 3000, transparent } })
      fixture.jobIds.push(job.jobId)
      const deadline = Date.now() + 120_000
      for (;;) {
        checkAbort()
        const current = await call('generation.get', { jobId: job.jobId })
        if (current.status === 'succeeded') {
          const output = current.outputs[0]!
          if (!output.delivery.nodeId) throw new Error('Fixture render has no delivered video')
          fixture.nodeIds.push(output.delivery.nodeId)
          return { nodeId: output.delivery.nodeId, assetVersionId: output.assetVersionId }
        }
        if (['failed', 'cancelled', 'unknown'].includes(current.status)) throw new Error(`Transparent timeline fixture failed: ${current.error?.code ?? current.status}`)
        if (Date.now() >= deadline) throw new Error('Transparent timeline fixture timed out')
        await pause(100)
      }
    }
    const alpha = await render('Transparent data card fixture', '<body style="margin:0"><div style="position:absolute;left:80px;top:45px;width:160px;height:90px;background:#ff6347;border-radius:12px;color:white;font:24px sans-serif;display:grid;place-items:center">42%</div><script>window.vis={duration:3,seek(t){document.querySelector("div").style.opacity=Math.min(1,t*4)}}</script>', true)
    const asset = await call('asset.get', { assetVersionId: alpha.assetVersionId })
    if (asset.hasAlpha !== true || asset.mime !== 'video/webm') throw new Error('Transparent timeline fixture must be an alpha WebM')
    const base = await render('Blue underlay fixture', '<body style="margin:0;background:#2460c0"><script>window.vis={duration:3,seek(){}}</script>', false)
    const created = await apply([{ op: 'node.create', tempId: 'timeline', kind: 'timeline', title: 'Data card overlay edit', content: { timelineFrom: [base.nodeId] } }])
    fixture.nodeIds.push(created.idMap.timeline!)
    Object.assign(fixture.vars, { transparentVideoNodeId: alpha.nodeId, transparentAssetVersionId: alpha.assetVersionId, timelineNodeId: created.idMap.timeline! })
  }
  return fixture
}

export async function finishedChildren(call: Call, parentId: string, agentKind: MethodParams<'work.dispatch'>['agentKind']): Promise<WorkItemView[]> {
  const children: WorkItemView[] = []
  for (const [index, title] of ['动机审阅', '结尾审阅'].entries()) {
    const child = await call('work.dispatch', { requestId: requestId(), parentId, title, brief: index === 0 ? '审阅人物动作的动机。' : '审阅结尾是否说得太满。', agentKind, activate: false, reviewBy: 'parent' })
    const finished = await call('work.move', { requestId: requestId(), workItemId: child.item.workItemId, status: 'done', expectedRevision: child.item.revision })
    children.push(finished.item)
  }
  return children
}
