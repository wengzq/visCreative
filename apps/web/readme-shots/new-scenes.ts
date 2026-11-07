import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_AGENT_KIND, EMPTY_PREVIZ, emptyPrevizPanel, type CanvasOp, type NodeView, type SceneObject, type Vec3, type WorkItemView } from '@vis/protocol'
import { expect } from 'vitest'
import type { Page } from 'playwright-core'
import type { StudiodLink } from '../src/host/studiod-link'
import { sceneHtml, type Scene } from './artwork'

type Context = {
  page: Page
  admin: StudiodLink
  locale: 'en' | 'zh-CN'
  spaceId: string
  director: WorkItemView
  children: WorkItemView[]
  scriptId: string
  shotIds: string[]
  shot(name: string): Promise<void>
  fit(): Promise<void>
  renderAsset(scene: Scene, variant: number, durationMs?: number, fps?: number): Promise<string>
}

export async function captureNewScenes({ page, admin, locale, spaceId, director, children, scriptId, shotIds, shot, fit, renderAsset }: Context) {
  const t = (en: string, cn: string) => locale === 'zh-CN' ? cn : en
  const rid = () => crypto.randomUUID()
  const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: rid(), ops })
  const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
  const node = async (id: string) => (await nodes()).find(node => node.nodeId === id)!
  const main = (node: NodeView) => node.slots.find(slot => slot.slotKey === 'main')!
  const button = (en: string, cn: string) => page.getByRole('button', { name: t(en, cn), exact: true })
  const fixture = (item: WorkItemView, value: unknown) => writeFileSync(join(item.workDir, '.vis-readme-shots.json'), JSON.stringify(value))
  const createWork = async (title: string): Promise<WorkItemView> => (await admin.call('work.create', { requestId: rid(), title, chat: { agentKind: DEFAULT_AGENT_KIND } })).item
  const send = async (item: WorkItemView, text: string) => {
    const current = (await admin.call('work.get', { workItemId: item.workItemId })).item as WorkItemView
    return admin.call('session.sendMessage', { requestId: rid(), sessionId: current.sessions[0]!.sessionId, text, refs: [] })
  }
  const idle = (item: WorkItemView) => expect.poll(async () => (await admin.call('work.get', { workItemId: item.workItemId })).item.sessions[0]?.activeTurnId, { timeout: 30_000 }).toBeNull()
  const openWork = async (item: WorkItemView) => {
    if (await button('Expand session panel', '展开会话面板').isVisible()) await button('Expand session panel', '展开会话面板').click()
    const back = button('Back to list', '返回列表')
    if (await back.isVisible()) await back.click()
    await page.getByRole('listitem').filter({ has: page.getByText(item.title, { exact: true }) }).first().click()
    const resize = page.getByRole('separator', { name: t('Resize session panel', '调整会话面板宽度'), exact: true })
    const box = (await resize.boundingBox())!
    const width = Number(await resize.getAttribute('aria-valuenow'))
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + width - 480, box.y + box.height / 2, { steps: 6 })
    await page.mouse.up()
    await fit()
  }
  await apply((await nodes()).filter(node => node.purpose !== 'working').map((node): CanvasOp => ({ op: 'node.setMeta', nodeId: node.nodeId, purpose: 'working' })))
  const manuscript = t(
    '# First Light\n\n## The lantern\n\nBefore dawn, A-Shan carried his father’s brass lantern to the ridge. The path was still blue with night, but a thin line of amber had begun to warm the farthest peaks.\n\n**He kept the little flame alive with both hands.** Below, Cloud Valley waited in the mist. A bell sounded once.\n\n> “Does the sea begin where the mountains end?”\n\nXiao Hai waited by the old pine with breakfast for two.\n\n### Notes for the opening\n\n| Moment | Picture | Sound |\n| --- | --- | --- |\n| Before dawn | A lantern against blue hills | One distant bell |\n| At the ridge | Two friends, a winding path | Pine needles in the wind |\n| First light | A pale sail beyond the mountains | The first hint of surf |\n\n## A promise at the ridge\n\nThey shared a steamed bun while the sun climbed. Neither hurried to speak. The road below was familiar; the blue beyond it was not.\n\n“Someday,” A-Shan said, “we will see the sea.”\n\n## Beyond Cloud Valley\n\nWhen they returned, the village was opening its shutters. The lantern no longer needed its flame, but A-Shan carried it carefully all the same.',
    '# 晨光\n\n## 一盏铜灯\n\n村庄还未醒来，阿山已提着父亲的旧铜灯走向山脊。小路仍浸在夜色的蓝里，最远的山峰却已染上一线琥珀色。\n\n**他用双手护着那一点小小的火光。** 山下，云岚谷静候在薄雾中。风铃只响了一声。\n\n> “群山结束的地方，就是大海吗？”\n\n小海站在老松树旁，带来了两个人的早饭。\n\n### 开场笔记\n\n| 时刻 | 画面 | 声音 |\n| --- | --- | --- |\n| 破晓之前 | 青蓝群山中的一盏铜灯 | 远处一声风铃 |\n| 登上山脊 | 两个伙伴，一条蜿蜒小路 | 松针掠过山风 |\n| 第一缕光 | 群山之外的一叶浅色风帆 | 最初隐约的潮声 |\n\n## 山脊上的约定\n\n他们分着一个馒头，看太阳慢慢升起，谁也不急着开口。脚下的路很熟悉，远处的蓝却是陌生的。\n\n“总有一天，”阿山说，“我们会看见大海。”\n\n## 云岚谷之外\n\n回来时，村庄正一扇扇推开窗。铜灯已不再需要火光，阿山却仍小心地提着它。',
  )
  const bookId = (await apply([{ op: 'node.create', tempId: 'book', kind: 'text', format: 'markdown', title: t('First Light · Manuscript', '晨光 · 文稿'), x: 0, y: 0, w: 640, h: 420, content: { text: manuscript } }])).idMap.book as string
  await fit()
  await button('Open writing page', '打开写作页').click()
  const writing = page.getByRole('dialog', { name: t('Writing page', '写作页'), exact: true })
  await writing.waitFor()
  await writing.getByRole('table', { name: t('Table (click to edit)', '表格（点击编辑）'), exact: true }).waitFor()
  await writing.getByRole('textbox', { name: t('Manuscript', '正文'), exact: true }).locator('.cm-line').filter({ hasText: t('Before dawn,', '村庄还未醒来') }).click()
  await shot('writing')
  const writer = await createWork(t('Writing · First Light', '写作 · 晨光'))
  const book = main(await node(bookId))
  const reviewRequest = t('Suggest a more concrete opening image. Leave the choice to me.', '为开场建议一个更具体的画面，保留给我决定。')
  fixture(writer, { request: reviewRequest, reasoning: t('Start with what A-Shan can see and hear. Keep the quiet pace the author asked for.', '从阿山能看见、能听见的事物写起，保留作者要求的安静节奏。'), plan: [t('Read the opening', '阅读开场'), t('Offer one anchored suggestion', '提出一处锚定建议')], toolResult: t('Opening passage read; manuscript unchanged.', '已阅读开场，原文未改动。'), calls: [{ name: 'text_propose', args: { requestId: rid(), slotId: book.slotId, baseRevision: book.revision, summary: t('Let the morning arrive through the lantern light.', '让清晨从灯光的变化中到来。'), edits: [{ find: t('The path was still blue with night, but a thin line of amber had begun to warm the farthest peaks.', '小路仍浸在夜色的蓝里，最远的山峰却已染上一线琥珀色。'), replace: t('Blue shadows filled the path. Above the last ridge, a thread of amber caught the lantern’s glass.', '青蓝的影子铺满小路。越过最后一道山脊，一线琥珀光映上铜灯的玻璃。') }] } }], answer: t('I left one suggestion in the opening paragraph. You can accept it or keep your original.', '我在开场段落留下一处建议，你可以采纳，也可以保留原文。'), ack: t('I will keep your wording.', '我会保留你的措辞。') })
  await send(writer, reviewRequest)
  await idle(writer)
  await writing.getByRole('button', { name: t('Accept edit 1', '接受建议 1'), exact: true }).waitFor()
  await shot('writing-review')
  await button('Close writing page', '关闭写作页').click()
  await apply([{ op: 'node.setMeta', nodeId: bookId, purpose: 'working' }])

  const previzId = (await apply([{ op: 'node.create', tempId: 'previz', kind: 'previz', title: t('Lantern · Ridge composition', '提灯 · 山脊构图'), x: 0, y: 0, w: 640, h: 400 }])).idMap.previz as string
  const previz = main(await node(previzId))
  await apply([{ op: 'previz.set', slotId: previz.slotId, expectedRevision: previz.revision, doc: { ...EMPTY_PREVIZ, panels: [0, 1].map(i => ({ ...emptyPrevizPanel(`lantern-${i}`), durationSec: 2, note: i ? t('Move closer; keep the lantern against the open sky.', '缓缓靠近，让铜灯留在开阔天空前。') : t('Wide ridge. A-Shan enters from the left; hold the horizon low.', '山脊远景。阿山从左侧入画，压低地平线。'), shot: { scriptNodeId: scriptId, shotId: shotIds[1]! } })) } }])
  await fit()
  await button('Open shot previz', '打开镜头预演').click()
  const previzEditor = page.getByRole('dialog', { name: t('Lantern · Ridge composition', '提灯 · 山脊构图'), exact: true })
  await previzEditor.waitFor()
  const surface = previzEditor.getByRole('img', { name: t('Panel drawing', '画格绘图'), exact: true })
  const draw = async (points: number[][]) => {
    await expect.poll(() => surface.getAttribute('aria-disabled'), { timeout: 15_000 }).toBe('false')
    const box = (await surface.boundingBox())!
    const point = (p: number[]) => ({ x: box.x + p[0]! * box.width, y: box.y + p[1]! * box.height })
    await page.mouse.move(point(points[0]!).x, point(points[0]!).y)
    await page.mouse.down()
    for (const p of points.slice(1)) await page.mouse.move(point(p).x, point(p).y, { steps: 3 })
    await page.mouse.up()
    await expect.poll(() => surface.getAttribute('aria-disabled'), { timeout: 15_000 }).toBe('false')
    await previzEditor.getByRole('button', { name: t('Save', '保存'), exact: true }).click()
    await expect.poll(() => previzEditor.locator('header [role=status]').textContent(), { timeout: 15_000 }).toBe(t('Saved', '已保存'))
  }
  for (const i of [0, 1]) {
    if (i) await previzEditor.getByRole('button', { name: t('Panel 2', '画格 2'), exact: true }).click()
    for (const path of [
      [[.04,.58],[.18,.25],[.29,.48],[.40,.17],[.57,.54],[.73,.30],[.96,.60]],
      [[.02,.74],[.21,.68],[.38,.72],[.52,.64],[.71,.70],[.98,.66]],
      [[.30,.98],[.39,.84],[.57,.77],[.75,.84],[.89,.97]],
      [[.47,.53],[.45,.50],[.45,.44],[.47,.41],[.50,.42],[.52,.45],[.51,.50],[.49,.53],[.47,.53]],
      [[.46,.54],[.43,.72],[.53,.72],[.51,.54],[.46,.54]],
      [[.45,.72],[.43,.83],[.46,.83],[.48,.74],[.50,.83],[.54,.83],[.52,.72]],
      [[.45,.56],[.41,.66],[.43,.68],[.47,.59]],
      [[.51,.57],[.57,.60],[.61,.59]],
      [[.60,.59],[.60,.65],[.57,.65],[.57,.73],[.63,.73],[.63,.65],[.60,.65]],
      [[.15,.72],[.16,.49],[.10,.60],[.21,.60],[.13,.68],[.22,.68]],
    ]) await draw(i ? path.map(([x, y]) => [Math.max(.02, Math.min(.98, .5 + (x! - .5) * 1.2)), Math.max(.02, Math.min(.98, .5 + (y! - .5) * 1.2))]) : path)
    await previzEditor.getByRole('button', { name: t('Save', '保存'), exact: true }).click()
    await previzEditor.getByRole('status').filter({ hasText: t('Saved', '已保存') }).waitFor()
  }
  await previzEditor.getByRole('button', { name: t('Panel 1', '画格 1'), exact: true }).click()
  await shot('previz-editor')
  await button('Close editor', '关闭编辑器').click()
  const blockoutVideo = await renderAsset('blockout', 0, 4000, 8)
  await apply([{ op: 'node.setMeta', nodeId: scriptId, purpose: 'artifact' }, { op: 'node.layout', nodeId: scriptId, x: 720, y: 0, w: 360, h: 250 }, { op: 'node.create', tempId: 'blockout', kind: 'video', title: t('Lantern · Camera blockout', '提灯 · 运镜白模'), x: 720, y: 300, w: 360, h: 250, purpose: 'artifact', inputNodeIds: [previzId], content: { assetVersionId: blockoutVideo } }])
  const current = main(await node(previzId))
  await admin.call('previz.extractBlockout', { requestId: rid(), slotId: current.slotId, expectedRevision: current.revision, assetVersionId: blockoutVideo })
  await page.locator('.vis-previz-blockout img').waitFor()
  await fit()
  await shot('previz')

  const sceneTitle = t('Ridge · Camera study', '山脊 · 机位研究')
  const sceneId = (await apply([{ op: 'node.create', tempId: 'scene', kind: 'scene', title: sceneTitle, x: 0, y: 620, w: 640, h: 400 }])).idMap.scene as string
  const sceneSlot = main(await node(sceneId))
  const sceneObject = (id: string, name: string, position: Vec3, source: SceneObject['source']): SceneObject => ({ id, name, transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, hidden: false, createdBy: 'user', userTouched: false, source })
  const hero = t('A-Shan', '阿山')
  await apply([{ op: 'scene.set', slotId: sceneSlot.slotId, expectedRevision: sceneSlot.revision, doc: { version: 1, rev: 0, objects: [
    sceneObject('hero', hero, [-0.5, 0, 0], { type: 'figure', bodyId: 'human', heightM: 1.7, pose: {} }),
    sceneObject('friend', t('Xiao Hai', '小海'), [0.8, 0, -0.7], { type: 'figure', bodyId: 'human', heightM: 1.6, pose: {} }),
    sceneObject('bench', t('Bench', '长椅'), [1.7, 0, 0.9], { type: 'prop', propId: 'bench' }),
  ], views: [{ id: 'wide', name: t('Wide', '远景'), camera: { position: [2.6, 1.6, 6], target: [0.2, 1, 0], roll: 0, focalLengthMm: 35 }, aspectRatio: '16:9', still: null }] } }])
  await fit()
  await button('Open scene', '打开场景').click()
  const sceneEditor = page.getByRole('dialog', { name: sceneTitle, exact: true })
  await sceneEditor.waitFor()
  await expect.poll(() => sceneEditor.getByRole('button', { name: t('Add view', '添加视图'), exact: true }).isEnabled(), { timeout: 15_000 }).toBe(true)
  await sceneEditor.getByRole('button', { name: t(`Select object: ${hero}`, `选择对象：${hero}`), exact: true }).click()
  await sceneEditor.getByRole('combobox', { name: t('Preset pose', '预设姿势'), exact: true }).selectOption('pointing')
  await sceneEditor.getByRole('button', { name: t('Apply pose', '应用姿势'), exact: true }).click()
  await sceneEditor.getByRole('button', { name: t('Select joint: Right shoulder', '选择关节：右肩'), exact: true }).click()
  await sceneEditor.getByRole('button', { name: t('Save', '保存'), exact: true }).click()
  await expect.poll(() => sceneEditor.getByRole('status').allTextContents(), { timeout: 15_000 }).toContain(t('Saved', '已保存'))
  await shot('scene-editor')
  await sceneEditor.getByRole('button', { name: t('Close scene editor', '关闭场景编辑器'), exact: true }).click()
  await sceneEditor.waitFor({ state: 'detached' })
  await apply([{ op: 'node.setMeta', nodeId: sceneId, purpose: 'working' }])

  const method = await createWork(t('Method · Quiet storytelling', '方法 · 安静叙事'))
  const skillRequest = t('Save my method as a skill: describe what we see before naming an emotion, and let each image breathe so small details can carry the story.', '把我的方法写成 Skill：先写看见的事物，再写情绪；让每个画面留有呼吸，让细节推动故事。')
  const skillBody = t('# Quiet storytelling\n\nDescribe what I can see before naming an emotion. Leave room between images so a small gesture can carry the story.\n\nUse the sounds I name; do not add music or explain the mood for me. Offer distinct directions when I have not chosen one.\n', '# 安静叙事\n\n先写我能看见的事物，再写情绪。在画面之间留出呼吸，让一个细小的动作推动故事。\n\n使用我提到的声音，不替我添加配乐或解释情绪。方向尚未确定时，给我有区别的选项。\n')
  const skillName = 'quiet-storytelling'
  const description = t('My way of telling a story through pauses, gestures and sound.', '用停顿、动作与声音讲述故事，这是我的创作方法。')
  fixture(method, { request: skillRequest, reasoning: t('Keep the author’s method and reasons in their words.', '按作者的话保留方法与理由。'), plan: [t('Draft the stated method', '起草作者的方法')], toolResult: t('Draft prepared for the author; no skill installed.', '草稿已交作者审阅，尚未安装 Skill。'), calls: [{ name: 'skill_proposeDraft', args: { requestId: rid(), name: skillName, description, body: skillBody } }], answer: t('Your draft is ready. Review it here, then decide whether to save it to My skills.', '草稿已就绪。请在这里审阅，再决定是否保存到「我的 Skill」。'), ack: t('I will wait for your review.', '等待你的审阅。') })
  await openWork(method)
  await send(method, skillRequest)
  await idle(method)
  const draftCard = page.getByRole('article', { name: t('Skill draft', 'Skill 草稿'), exact: true })
  await draftCard.getByRole('button', { name: t('Review', '审阅'), exact: true }).waitFor()
  await shot('skill-draft')
  await draftCard.getByRole('button', { name: t('Review', '审阅'), exact: true }).click()
  await button('Save to my skills', '保存到我的 Skill').click()
  await page.getByText(t('Saved to My skills.', '已保存到我的 Skill。'), { exact: true }).waitFor()
  await button('Back to My skills', '返回我的 Skill').click()
  const saved = (await admin.call('skill.libraryList', {})).skills[0]
  await admin.call('skill.use', { requestId: rid(), spaceId, skillId: saved.skillId, version: saved.version })
  await admin.call('skill.librarySave', { requestId: rid(), skillId: saved.skillId, expectedRevision: saved.revision, name: skillName, description, body: skillBody + t('\nWhen I ask for a revision, preserve the pauses I chose.\n', '\n当我要求修改时，保留我已选定的停顿。\n') })
  const rootPath = (await admin.call('space.list', {})).spaces.find((space: { spaceId: string }) => space.spaceId === spaceId).rootPath
  writeFileSync(join(rootPath, 'skills', skillName, 'SKILL.md'), (await admin.call('skill.export', { skillId: saved.skillId })).content + t('\nFor this episode, keep the lantern as the recurring image.\n', '\n这一集以铜灯作为贯穿的意象。\n'))
  await button('Refresh', '重新读取').click()
  await page.getByText(t('Newer version available', '有新版本可用'), { exact: true }).waitFor()
  await page.getByText(t('Edited here', '已在此项目修改'), { exact: true }).waitFor()
  await shot('skills')
  await button('Close settings', '关闭设置').click()

  const motion = await createWork(t('Previz · Lantern motion', '预演 · 铜灯运镜'))
  await openWork(motion)
  const sourceId = (await apply([{ op: 'node.create', tempId: 'source', kind: 'text', format: 'code', purpose: 'working', title: t('Lantern · Motion source', '提灯 · 动态源代码'), content: { text: sceneHtml('lantern', 2) } }])).idMap.source as string
  const source = main(await node(sourceId))
  const motionRequest = t('Render the lantern study locally. Keep the push-in gentle while I review the composition.', '请在本机渲染铜灯动态练习。我审阅构图时，保持轻柔的推进。')
  fixture(motion, { request: motionRequest, reasoning: t('Read the panel notes and render a gentle push-in using the local source.', '阅读画格备注，使用本机代码渲染轻柔的推进。'), plan: [t('Read the composition', '阅读构图'), t('Render a local motion study', '本机渲染动态练习')], toolResult: t('Local render completed with the lantern palette preserved.', '本机渲染完成，保留铜灯的暖色。'), calls: [{ name: 'gen_submit', args: { kind: 'video', provider: 'render', model: 'html', prompt: t('Lantern at first light · gentle push-in', '晨光铜灯 · 轻柔推进'), inputs: [{ slotId: source.slotId, revision: source.revision }], params: { width: 960, height: 540, fps: 8, durationMs: 4000 } }, waitForGeneration: true }], hold: true, ack: t('Ready when you are.', '等你准备好。') })
  const beforeMotion = new Set((await nodes()).map(node => node.nodeId))
  await send(motion, motionRequest)
  await page.getByRole('region', { name: t('Video result', '视频生成结果'), exact: true }).waitFor()
  await page.getByRole('region', { name: t('Video result', '视频生成结果'), exact: true }).getByRole('button', { name: new RegExp(t('^Preview generation result:', '^预览生成结果：')) }).waitFor()
  await send(motion, t('Before the next pass, hold on the lantern for one more beat.', '下一版请在铜灯上再多停留一拍。'))
  await button('Send now', '立即发送').waitFor()
  const resultNodeId = (await nodes()).find(node => node.kind === 'video' && !beforeMotion.has(node.nodeId))!.nodeId
  await apply([
    ...(await nodes()).filter(node => node.purpose !== 'working' && node.nodeId !== resultNodeId).map((node): CanvasOp => ({ op: 'node.setMeta', nodeId: node.nodeId, purpose: 'working' })),
    { op: 'node.layout', nodeId: resultNodeId, x: 0, y: 0, w: 760, h: 500 },
  ])
  await page.locator('.react-flow__pane').click({ position: { x: 15, y: 80 } })
  await fit()
  await shot('turn-view')
  await button('Send now', '立即发送').click()
  await idle(motion)

  await openWork(director)
  const cleanupRequest = t('Please clean up the unused sound workspace and completed edit workspace. Keep the canvas and all assets.', '请清理未使用的声音工作区和已完成的剪辑工作区，保留画布及全部素材。')
  fixture(director, { request: cleanupRequest, reasoning: t('Only request the two workspaces named by the author. Their canvas content stays.', '仅请求清理作者指定的两个工作区，保留画布内容。'), plan: [t('Request author approval', '请求作者确认')], toolResult: t('Cleanup request prepared; waiting for the author.', '清理请求已就绪，等待作者确认。'), calls: [{ name: 'work_request_delete', args: { requestId: rid(), workItemIds: [children[0]!.workItemId, children[3]!.workItemId] } }], answer: t('The cleanup card is waiting for your decision. Canvas content and assets will stay.', '清理卡片等待你决定，画布内容与素材会保留。'), ack: t('The workspaces will stay until you decide.', '你决定前，工作区会保留。') })
  await send(director, cleanupRequest)
  await idle(director)
  await page.getByRole('region', { name: t('Approval pending: Delete child work items', '待审批：删除子工作项'), exact: true }).waitFor()
  await shot('cleanup-card')
}
