import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_KIND, type CanvasOp, type EntityView, type NodeView, type TimelineDoc, type WorkItemView } from '@vis/protocol'
import { createMockProvider, createRenderProvider } from '../../../packages/generation/src/index'
import { assembleScriptTimeline } from '../../../packages/canvas/ui/src/script-table'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from '../e2e/platform'
import { sceneHtml, type Scene } from './artwork'
import { captureNewScenes } from './new-scenes'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = resolve(process.env.VIS_SHOTS_OUT ?? join(tmpdir(), 'vis-readme-shots'))
const cli = join(root, 'apps/cli/dist/vis.mjs')
const ffmpeg = process.env.VIS_SHOTS_FFMPEG ?? 'ffmpeg'
const rid = () => crypto.randomUUID()
const main = (node: NodeView) => node.slots.find(slot => slot.slotKey === 'main')!
let browser: Browser
let daemon: Studiod | undefined
let host: WebHost | undefined
let admin: StudiodLink | undefined
let page: Page | undefined
let dataDir: string | undefined
let projectsDir: string | undefined
const errors: string[] = []
const manifest: Record<string, string[]> = {}
const nodes = async (): Promise<NodeView[]> => (await admin!.call('canvas.get', {})).nodes
const apply = (ops: CanvasOp[]) => admin!.call('canvas.apply', { requestId: rid(), ops })
const getNode = async (id: string) => (await nodes()).find(node => node.nodeId === id)!

async function cleanup() {
  await page?.close()
  page = undefined
  admin?.close()
  admin = undefined
  await host?.close()
  host = undefined
  await daemon?.stop('user_quit')
  daemon = undefined
  removeTempDir(dataDir)
  dataDir = undefined
  removeTempDir(projectsDir)
  projectsDir = undefined
  vi.unstubAllEnvs()
}

afterAll(async () => {
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png'), animations: 'disabled' }).catch(() => {})
    writeFileSync(join(output, 'failure.html'), await page.content().catch(() => ''))
  }
  await cleanup()
  await browser?.close()
}, 60_000)

async function shot(locale: string, name: string, hover?: Locator) {
  await page!.mouse.move(1590, 990)
  await hover?.hover()
  await page!.evaluate(() => document.fonts.ready)
  await expect.poll(() => page!.locator('video').evaluateAll(videos => videos.filter(video => {
    const rect = video.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth && getComputedStyle(video).visibility !== 'hidden'
  }).every(video => (video as HTMLVideoElement).readyState >= 2)), { timeout: 30_000 }).toBe(true)
  await page!.locator('.vis-timeline-preview video').evaluateAll(async elements => {
    await Promise.all(elements.map(async element => {
      const video = element as HTMLVideoElement
      video.pause()
      if (!video.videoWidth || !Number.isFinite(video.duration)) return
      await new Promise<void>(resolve => {
        video.requestVideoFrameCallback(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        video.currentTime = Math.min(video.duration - .01, video.currentTime + .001)
      })
    }))
  })
  await expect.poll(() => page!.locator('img').evaluateAll(images => images.filter(image => {
    const rect = image.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth && getComputedStyle(image).visibility !== 'hidden'
  }).every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)), { timeout: 30_000 }).toBe(true)
  await expect.poll(() => page!.locator('.vis-version-media.is-changing').count()).toBe(0)
  expect(await page!.getByRole('alert').allTextContents()).toEqual([])
  expect(errors).toEqual([])
  await page!.screenshot({ path: join(output, locale, `${name}.png`), animations: 'disabled' })
  manifest[locale] ??= []
  manifest[locale].push(name)
  console.log(`[shots] ${locale}/${name}.png`)
}

async function renderAsset(scene: Scene, variant: number, durationMs = 1000, fps = 1) {
  const cache = join(tmpdir(), 'vis-readme-render-cache')
  mkdirSync(cache, { recursive: true })
  const key = createHash('sha256').update(`${sceneHtml(scene, variant)}-${durationMs}-${fps}`).digest('hex')
  const video = join(cache, `${key}.mp4`)
  const path = durationMs === 1000 ? join(cache, `${key}.png`) : video
  if (existsSync(path)) return (await admin!.call('asset.import', { requestId: rid(), path })).assetVersionId as string
  const provider = createRenderProvider({ workDir: join(cache, 'jobs'), chromePath: chromePath(), ffmpegPath: ffmpeg })
  await provider.submit({ operation: 'generate', kind: 'video', model: 'html', prompt: `Mountain & Sea: ${scene}`, params: { width: 960, height: 540, fps, durationMs }, inputs: [{ type: 'text', text: sceneHtml(scene, variant) }] }, { idempotencyKey: key })
  await expect.poll(async () => {
    const state = await provider.getTask(key)
    if (state.state === 'failed') throw new Error(state.error.message)
    return state.state
  }, { timeout: 120_000, interval: 150 }).toBe('succeeded')
  const rendered = await provider.download({ ref: key, outputIndex: 0 })
  writeFileSync(video, rendered.data)
  if (durationMs === 1000) execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', video, '-frames:v', '1', path], { windowsHide: true })
  return (await admin!.call('asset.import', { requestId: rid(), path })).assetVersionId as string
}

describe('README captures using local render assets and fake Codex', () => {
  it('captures the complete production in English and Chinese', async () => {
    if (!existsSync(chromePath()) || !existsSync(cli) || !existsSync(join(root, 'apps/web/dist/client/index.html'))) {
      throw new Error('Build the repository and install Chrome before running readme-shots')
    }
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    for (const locale of ['en', 'zh-CN'] as const) {
      const zh = locale === 'zh-CN'
      const t = (en: string, cn: string) => zh ? cn : en
      mkdirSync(join(output, locale), { recursive: true })
      dataDir = mkdtempSync(join(tmpdir(), 'vis-readme-data-'))
      projectsDir = mkdtempSync(join(tmpdir(), 'vis-readme-projects-'))
      vi.stubEnv('VIS_PROJECTS_DIR', projectsDir)
      daemon = await startStudiod({
        dataDir, studiodVersion: 'readme-shots', secretStore: createMemorySecretStore(),
        runtimes: { codex: codexRuntime({ dataDir, env: { ...process.env, CODEX_HOME: join(projectsDir, 'agent-home') }, socketPath: studiodEndpoint(dataDir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
        providers: [createMockProvider({ latencyMs: 0, seed: 7 }), createRenderProvider({ workDir: join(dataDir, 'jobs'), chromePath: chromePath(), ffmpegPath: ffmpeg })],
        defaults: { image: { provider: 'mock' }, audio: { provider: 'mock' }, video: { provider: 'render', model: 'html' } },
      })
      const first = daemon.spaces.create(t('Episode 1 · First Light', '第一集 · 晨光')).spaceId
      const second = daemon.spaces.create(t('Episode 2 · The Tide', '第二集 · 潮声')).spaceId
      admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
      await admin.call('events.subscribe', { spaceId: first })
      await admin.call('preferences.set', { locale })
      const images: string[][] = []
      const scenes: Scene[] = ['dawn', 'lantern', 'village', 'friend', 'sea']
      for (const scene of scenes) {
        console.log(`[shots] rendering ${locale}/${scene}`)
        images.push([await renderAsset(scene, 0), await renderAsset(scene, 1)])
      }
      const titleImage = await renderAsset('title', zh ? 1 : 0)
      const styleImage = await renderAsset('style', 0)
      const logo = await renderAsset('sticker', 0)
      const reviewImage = await renderAsset('lantern', 2)
      const videos = [await renderAsset('lantern', 0, 6000, 8), await renderAsset('sea', 0, 6000, 8)]
      const mock = createMockProvider({ latencyMs: 0, seed: 7 })
      const musicKey = (await mock.submit({ operation: 'generate', kind: 'audio', model: 'mock-music-1', prompt: 'Gentle bells and strings at dawn', params: { duration: 20 }, inputs: [] }, { idempotencyKey: 'music' })).externalTaskId
      const musicState = await mock.getTask(musicKey)
      if (musicState.state !== 'succeeded') throw new Error('Mock music was not ready')
      const musicFile = join(dataDir, 'first-light.wav')
      writeFileSync(musicFile, (await mock.download(musicState.outputs[0]!)).data)
      const music = (await admin.call('asset.import', { requestId: rid(), path: musicFile })).assetVersionId
      const fontPath = [
        process.env.VIS_SHOTS_FONT, join(root, 'resources/fonts/files/noto-sans-sc.otf'),
        'C:/Windows/Fonts/NotoSansSC-VF.ttf', '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
      ].find((path): path is string => !!path && existsSync(path))
      if (!fontPath) throw new Error('Provide an installed CJK font through VIS_SHOTS_FONT, or install the bundled fonts before capturing')
      const font = (await admin.call('asset.import', { requestId: rid(), path: fontPath })).assetVersionId as string
      const referenceIds = (await apply([
        { op: 'node.create', tempId: 'ashan', kind: 'image', title: t('A-Shan · Character reference', '阿山 · 角色参考'), x: 2200, y: 0, purpose: 'working', content: { assetVersionId: images[1]![0]! } },
        { op: 'node.create', tempId: 'hai', kind: 'image', title: t('Xiao Hai · Character reference', '小海 · 角色参考'), x: 2600, y: 0, purpose: 'working', content: { assetVersionId: images[3]![0]! } },
        { op: 'node.create', tempId: 'valley', kind: 'image', title: t('Cloud Valley · Scene reference', '云岚谷 · 场景参考'), x: 3000, y: 0, purpose: 'working', content: { assetVersionId: images[0]![0]! } },
      ])).idMap as Record<string, string>
      const entity = async (kind: string, name: string, description: string, assetVersionId: string, sourceNodeId?: string): Promise<EntityView> => admin!.call('entity.create', { requestId: rid(), kind, name, description, refs: [{ assetVersionId, ...(sourceNodeId ? { sourceNodeId } : {}) }] })
      const ashan = await entity('character', t('A-Shan', '阿山'), t('A curious mountain boy, teal coat and an old brass lantern.', '好奇的山村少年，青绿色外衣，随身携带旧铜灯。'), images[1]![0]!, referenceIds.ashan)
      const hai = await entity('character', t('Xiao Hai', '小海'), t('A brave friend in an ochre jacket, listening for the sea.', '勇敢的伙伴，赭色短袄，总在倾听远方的潮声。'), images[3]![0]!, referenceIds.hai)
      const valley = await entity('scene', t('Cloud Valley', '云岚谷'), t('Pine ridges, quiet stone lanes and a path toward the coast.', '松林山脊、宁静石巷，一条通向海岸的小路。'), images[0]![0]!, referenceIds.valley)
      const style = await entity('style', t('Painted dawn', '晨光绘本'), t('Layered paper shapes, muted jade, warm amber light, cinematic 16:9.', '层叠纸感，低饱和青玉色，暖琥珀光，电影感宽银幕。'), styleImage)
      const series = await admin.call('series.create', { requestId: rid(), name: t('Mountain & Sea', '山海少年') })
      await admin.call('space.setSeries', { requestId: rid(), spaceId: first, series: { seriesId: series.seriesId }, episode: 1, publishEntityIds: [ashan.id, hai.id, valley.id, style.id] })
      await admin.call('space.setSeries', { requestId: rid(), spaceId: second, series: { seriesId: series.seriesId }, episode: 2 })
      const shared = (await admin.call('series.entityList', {})).items
      const logoPath = join(dataDir, 'episode-two-reference.png')
      copyFileSync((await admin.call('asset.get', { assetVersionId: logo })).path, logoPath)
      await admin.call('events.subscribe', { spaceId: second })
      const otherAshan = await admin.call('entity.link', { requestId: rid(), seriesEntityId: shared.find((item: { linkedEntityId: string }) => item.linkedEntityId === ashan.id).seriesEntityId })
      const nextAshan = await admin.call('entity.update', { entityId: otherAshan.id, expectedRevision: otherAshan.revision, description: t('A mountain boy with a brighter brass lantern and a teal scarf.', '山村少年，铜灯更明亮，新增青绿色围巾。') })
      await admin.call('entity.publish', { requestId: rid(), entityId: nextAshan.id, expectedRevision: nextAshan.revision })
      const secondLogo = (await admin.call('asset.import', { requestId: rid(), path: logoPath })).assetVersionId
      const unused = await entity('prop', t('Tide compass', '听潮罗盘'), t('A brass compass reserved for the voyage in episode two.', '为第二集远航准备的黄铜罗盘。'), secondLogo)
      await admin.call('entity.publish', { requestId: rid(), entityId: unused.id, expectedRevision: unused.revision })
      await admin.call('events.subscribe', { spaceId: first })
      const localHai = await admin.call('entity.get', { entityId: hai.id })
      await admin.call('entity.update', { entityId: hai.id, expectedRevision: localHai.revision, description: t('Episode one: ochre jacket, a small shell tied to the wrist.', '第一集：赭色短袄，手腕系一枚小海螺。') })

      const titles = [t('01 · Dawn in Cloud Valley', '01 · 云谷初晓'), t('02 · The lantern keeper', '02 · 提灯少年'), t('03 · The village awakens', '03 · 山村苏醒'), t('04 · A promise to the sea', '04 · 听海之约'), t('05 · Beyond the mountains', '05 · 山外有海')]
      const descriptions = [
        t('Morning mist drifts between the ridges of Cloud Valley.', '晨雾从云岚谷的层叠山脊间缓缓升起。'),
        t(`{{asset:${ashan.id}}} lifts his lantern on the cliff, watching the first light.`, `{{asset:${ashan.id}}}在悬崖上提起铜灯，望向第一缕晨光。`),
        t('Warm windows light the stone lane as the village wakes.', '暖黄窗光照亮石巷，山村从梦中醒来。'),
        t(`{{asset:${hai.id}}} joins {{asset:${ashan.id}}}. Together, they promise to find the sea.`, `{{asset:${hai.id}}}来到{{asset:${ashan.id}}}身边，两人约定一起寻找大海。`),
        t('Beyond the last ridge, a little sail catches the evening tide.', '越过最后一重山，一叶小帆驶向暮色中的潮汐。'),
      ]
      const prompts = [
        t('Wide landscape, jade mountains in mist, amber sun, paper texture.', '远景，青玉色群山隐入薄雾，琥珀色朝阳，绘本纸感。'),
        t('Teal coat, brass lantern, pine cliff, soft rim light, medium wide.', '青绿外衣、黄铜灯笼、松林悬崖，柔和轮廓光，中远景。'),
        t('Stone houses, layered tiled roofs, lanterns and a winding lane.', '石屋、层叠瓦顶、暖灯与蜿蜒巷道，温柔的晨间气息。'),
        t('Two children on a ridge, teal and ochre, a quiet shared promise.', '两个孩子站在山脊，青绿与赭黄衣衫，安静而坚定的约定。'),
        t('Evening sea, gold reflections, a tiny sail, painterly waves.', '暮色海面，金色倒影，一叶小帆，绘本般舒展的波纹。'),
      ]
      const videoPrompts = [
        t('Slow aerial drift across the jade ridges. Morning mist parts as the sun rises.', '航拍缓慢掠过青玉色山脊，晨雾随朝阳升起而散开。'),
        t('Push in toward A-Shan as he raises the lantern. Let the amber light flicker softly.', '缓慢推近阿山举起铜灯的动作，让琥珀色灯光轻轻闪烁。'),
        t('Track forward along the stone lane. Curtains stir and window lights brighten.', '镜头沿石巷缓慢前移，窗帘轻动，窗内灯火渐亮。'),
        t('Arc gently around the two friends. Their coats move in the ridge-top breeze.', '镜头轻柔环绕两个伙伴，山脊上的微风拂动衣角。'),
        t('Pan across the evening sea, following the little sail through the gold reflections.', '横移掠过暮色海面，跟随小帆穿过金色倒影。'),
      ]
      const ids = (await apply([
        { op: 'node.create', tempId: 'script', kind: 'script', title: t('First Light · Storyboard', '晨光 · 分镜脚本'), x: 0, y: 0, w: 460, h: 450 },
        ...images.map((versions, i): CanvasOp => ({ op: 'node.create', tempId: `frame${i}`, kind: 'image', title: titles[i]!, x: 530 + i % 3 * 345, y: Math.floor(i / 3) * 290, w: 320, h: 230, prompt: prompts[i]!, content: { assetVersionId: versions[0]! } })),
        ...videos.map((assetVersionId, i): CanvasOp => ({ op: 'node.create', tempId: `video${i}`, kind: 'video', title: t(i ? 'Sea · Slow pan' : 'Lantern · Push in', i ? '海面 · 缓慢横移' : '提灯 · 缓慢推进'), x: 530 + i * 345, y: 590, w: 320, h: 230, content: { assetVersionId } })),
        { op: 'node.create', tempId: 'music', kind: 'audio', title: t('First Light · Music', '晨光 · 配乐'), x: 0, y: 520, w: 460, h: 170, content: { assetVersionId: music } },
        { op: 'node.create', tempId: 'logo', kind: 'image', title: t('Mountain & Sea · Emblem', '山海少年 · 徽章'), x: 1220, y: 590, w: 320, h: 230, content: { assetVersionId: logo } },
        { op: 'node.create', tempId: 'title', kind: 'image', title: t('Mountain & Sea · Title card', '山海少年 · 片名卡'), x: 1640, y: 590, w: 350, h: 240, content: { assetVersionId: titleImage } },
      ])).idMap as Record<string, string>
      const scriptNode = await getNode(ids.script!)
      await apply([{ op: 'script.replace', slotId: main(scriptNode).slotId, expectedRevision: main(scriptNode).revision, doc: {
        castIds: [ashan.id, hai.id, valley.id], styleId: style.id, style: t('Jade mountains · amber light · paper illustration', '青玉群山 · 琥珀晨光 · 纸感绘本'),
        shots: descriptions.map((description, i) => ({ tempId: `s${i}`, durationSec: 4, description, shotSize: t(i === 1 ? 'Medium wide' : 'Wide', i === 1 ? '中远景' : '远景'), camera: t(i === 1 ? 'Slow push in' : 'Slow pan', i === 1 ? '缓慢推进' : '缓慢横移'), sceneId: valley.id, characterIds: i === 1 ? [ashan.id] : i === 3 ? [ashan.id, hai.id] : [], framePrompt: prompts[i]!, videoPrompt: videoPrompts[i]!, sound: t('Soft wind · distant bells', '轻柔山风 · 远处风铃'), dialogue: i === 3 ? t('Someday, we will see the sea.', '总有一天，我们会看见大海。') : null })),
        assets: [],
      } }])
      const doc = main(await getNode(ids.script!)).content
      if (doc.type !== 'script') throw new Error('Script seeding failed')
      for (let i = 0; i < images.length; i++) {
        const frame = await getNode(ids[`frame${i}`]!)
        await apply([
          { op: 'slot.setAsset', slotId: main(frame).slotId, expectedRevision: main(frame).revision, assetVersionId: images[i]![1]! },
          { op: 'node.setMeta', nodeId: frame.nodeId, shot: { scriptNodeId: ids.script!, shotId: doc.doc.shots[i]!.id, role: 'first' } },
        ])
      }
      for (let i = 0; i < videos.length; i++) await apply([{ op: 'node.setMeta', nodeId: ids[`video${i}`]!, shot: { scriptNodeId: ids.script!, shotId: doc.doc.shots[i === 0 ? 1 : 4]!.id, role: 'video' } }])
      const assembled = assembleScriptTimeline(ids.script!, doc.doc, await nodes(), new Map(videos.map(assetVersionId => [assetVersionId, 6000])))
      expect(assembled.skipped).toEqual([])
      const timelineId = (await apply([{ op: 'node.create', tempId: 'timeline', kind: 'timeline', title: t('First Light · Picture edit', '晨光 · 画面剪辑'), x: 0, y: 750, w: 460, h: 220, content: { timelineFrom: assembled.items } }])).idMap.timeline as string
      const timelineNode = await getNode(timelineId)
      const timelineContent = main(timelineNode).content
      if (timelineContent.type !== 'timeline') throw new Error('Timeline seeding failed')
      const timeline: TimelineDoc = timelineContent.doc
      timeline.tracks = timeline.tracks.filter(track => track.kind === 'video')
      timeline.tracks[0]!.name = t('Picture', '画面')
      for (const [index, clip] of timeline.tracks[0]!.clips.entries()) {
        if (index === 1 || index === 4) {
          clip.source = { nodeId: ids[`video${index === 1 ? 0 : 1}`]!, assetVersionId: videos[index === 1 ? 0 : 1]! }
          clip.outMs = 6000
          clip.speed = 1.5
          clip.volume = .8
          clip.fadeInMs = 300
          clip.fadeOutMs = 500
        }
        clip.startMs = index * 4000 - (index > 0 ? 400 : 0)
        if (index === 1) clip.transitionIn = { kind: 'crossfade', durationMs: 400 }
      }
      timeline.tracks.push(
        { id: 'emblem-track', kind: 'overlay', name: t('Series emblem', '系列徽章'), muted: true, volume: 1, hidden: false, clips: [{ id: 'emblem', source: { nodeId: ids.logo!, assetVersionId: logo }, startMs: 0, inMs: 0, outMs: 20000, volume: 0, fadeInMs: 400, fadeOutMs: 400, overlay: { x: .88, y: .14, width: .14, opacity: .9 } }] },
        { id: 'music-track', kind: 'audio', name: t('First Light · Score', '晨光 · 原创配乐'), muted: false, volume: .7, clips: [{ id: 'music', source: { nodeId: ids.music!, assetVersionId: music }, startMs: 0, inMs: 0, outMs: 20000, volume: .65, fadeInMs: 600, fadeOutMs: 1200 }] },
      )
      timeline.textTracks = [{ id: 'captions', name: t('Story captions', '叙事字幕'), hidden: false, clips: descriptions.map((_, i) => ({ id: `caption-${i}`, startMs: i * 4000, durationMs: 4000, text: [
        t('Where the mountains meet the morning.', '群山与晨光相遇的地方。'), t('One small light. A whole world ahead.', '一盏小灯，照向辽阔远方。'), t('Every journey begins at home.', '每一段旅程，都从故乡开始。'), t('Someday, we will see the sea.', '总有一天，我们会看见大海。'), t('And beyond the mountains, the sea.', '翻过群山，就是大海。'),
      ][i]!, style: { preset: 'subtitle', font: { assetVersionId: font }, sizePct: 4.5 }, fadeInMs: 200, fadeOutMs: 200 })) }]
      await apply([{ op: 'timeline.set', slotId: main(timelineNode).slotId, expectedRevision: main(timelineNode).revision, doc: timeline }])
      // The script-to-timeline relationship is visible on the canvas as well as in shot provenance.
      await apply([{ op: 'node.setInputs', nodeId: timelineId, inputNodeIds: [ids.script!, ...timeline.tracks.flatMap(track => track.clips.map(clip => clip.source.nodeId))] }])
      const exportSource = await getNode(timelineId)
      let exported = await admin.call('media.process', { requestId: rid(), operation: 'timeline.export', nodeId: timelineId, slotId: main(exportSource).slotId, expectedRevision: main(exportSource).revision, params: {}, waitMs: 30000 })
      while (['queued', 'running'].includes(exported.status)) exported = await admin.call('media.get', { taskId: exported.taskId, waitMs: 30000 })
      if (exported.status !== 'succeeded') throw new Error(`Timeline export failed: ${JSON.stringify(exported.error)}`)
      const exportId = exported.nodeIds[0] as string
      await apply([{ op: 'node.layout', nodeId: exportId, x: 530, y: 880, w: 440, h: 285 }, { op: 'node.setMeta', nodeId: exportId, title: t('First Light · Final cut', '晨光 · 成片') }])
      await Promise.all([
        ...[...videos, exported.assetVersionIds[0]].flatMap(assetVersionId => ['filmstrip', 'poster'].map(kind => admin!.call('media.preview', { assetVersionId, kind }))),
        admin.call('media.preview', { assetVersionId: music, kind: 'peaks' }),
      ])

      const work = async (id: string): Promise<WorkItemView> => (await admin!.call('work.get', { workItemId: id })).item
      const fixture = (item: WorkItemView, value: unknown) => writeFileSync(join(item.workDir, '.vis-readme-shots.json'), JSON.stringify(value))
      const director = (await admin.call('work.create', { requestId: rid(), title: t('Director · First Light', '导演 · 晨光'), brief: t('Shape a gentle, hopeful opening for Mountain & Sea.', '为《山海少年》制作温柔而充满希望的开篇。') })).item as WorkItemView
      const request = t('Review the opening sequence and prepare the first cut.', '请检查开场分镜，准备第一版剪辑。')
      fixture(director, { request, reasoning: t('Keep the lantern as the visual anchor. Check character continuity, then let the edit breathe before the sea reveal.', '以铜灯作为视觉线索。先核对角色连续性，再让剪辑在海面揭晓前留出呼吸。'), plan: [t('Review the five shots and cast', '检查五个镜头与角色设定'), t('Check frames, captions and music', '核对画面、字幕与配乐'), t('Prepare the 20-second first cut', '完成二十秒初剪')], toolResult: t('5 shots · 2 characters · 1 scene · all references ready', '5 个镜头 · 2 位角色 · 1 处场景 · 参考图已就绪'), answer: t('The first cut is ready.\n\nFive shots follow A-Shan from Cloud Valley to the sea. The lantern palette stays consistent, with soft captions, the series emblem and a gentle music fade.\n\nThe new lantern frame is ready for review; Xiao Hai\'s costume detail needs your choice.', '第一版剪辑已就绪。\n\n五个镜头跟随阿山，从云岚谷走向大海。铜灯的暖色贯穿全片，已加入叙事字幕、系列徽章与渐弱配乐。\n\n新版提灯画面等待审阅；小海的服装细节需要你决定。'), ack: t('Production notes received.', '已收到制作记录。') })
      await admin.call('work.activate', { requestId: rid(), workItemId: director.workItemId, agentKind: DEFAULT_AGENT_KIND })
      await expect.poll(async () => (await work(director.workItemId)).sessions[0]?.activeTurnId, { timeout: 30_000 }).toBeNull()
      const children: WorkItemView[] = []
      const childNames = [t('Sound · Valley ambience', '声音 · 山谷氛围'), t('Character · Xiao Hai', '角色 · 小海'), t('Art · Lantern lighting', '美术 · 铜灯光影'), t('Edit · Opening rhythm', '剪辑 · 开场节奏')]
      for (const title of childNames) children.push((await admin.call('work.dispatch', { requestId: rid(), parentId: director.workItemId, title, brief: t('Prepare the episode-one production pass.', '完成第一集制作检查。'), agentKind: DEFAULT_AGENT_KIND, activate: false, reviewBy: 'user' })).item)
      for (const i of [1, 2, 3]) {
        const child = children[i]!
        fixture(child, { trigger: 'shots-deliver', toolResult: t('Production update saved.', '制作改动已保存。'), ack: t('Ready for the production pass.', '已准备好本轮制作。'), answer: t('Submitted to the director.', '已提交给导演。'), ...(i === 2 ? { ops: [{ op: 'slot.setAsset', slotId: main(await getNode(ids.frame1!)).slotId, expectedRevision: main(await getNode(ids.frame1!)).revision, assetVersionId: reviewImage }] } : {}), report: { kind: i === 1 ? 'question' : 'done', body: i === 1 ? t('Should Xiao Hai wear the shell bracelet in the opening? I recommend keeping it as a link to episode two.', '开场是否保留小海的海螺手链？建议保留，作为第二集的伏笔。') : i === 2 ? t('Updated the lantern lighting: warmer amber, cleaner silhouette and a softer mountain haze. The before/after frames are ready for review.', '已调整铜灯光影：琥珀色更温暖、剪影更清晰，远山薄雾更柔和。前后版本已备好，等待审阅。') : t('Opening rhythm approved: five shots, twenty seconds, music and captions aligned.', '开场节奏确认：五个镜头，共二十秒，配乐与字幕已对齐。'), refs: {} } })
        await admin.call('work.activate', { requestId: rid(), workItemId: child.workItemId, agentKind: DEFAULT_AGENT_KIND })
        await expect.poll(async () => (await work(child.workItemId)).sessions[0]?.activeTurnId, { timeout: 30_000 }).toBeNull()
        await admin.call('session.sendMessage', { requestId: rid(), sessionId: (await work(child.workItemId)).sessions[0]!.sessionId, text: 'shots-deliver', refs: [] })
        await expect.poll(async () => (await work(child.workItemId)).sessions[0]?.activeTurnId, { timeout: 30_000 }).toBeNull()
        await expect.poll(async () => (await work(child.workItemId)).status, { timeout: 30_000 }).toBe(i === 1 ? 'in_progress' : 'in_review')
        if (i === 3) {
          await admin.call('work.review', { requestId: rid(), workItemId: child.workItemId, decision: 'approve' })
          await admin.call('work.markRead', { workItemId: child.workItemId })
        }
      }
      await expect.poll(async () => (await work(director.workItemId)).sessions[0]?.activeTurnId, { timeout: 30_000 }).toBeNull()
      const directorSession = (await work(director.workItemId)).sessions[0]!.sessionId
      const currentScript = main(await getNode(ids.script!)).content
      if (currentScript.type === 'script') await apply([{ op: 'script.patch', slotId: main(await getNode(ids.script!)).slotId, ops: [{ kind: 'doc.set', rev: currentScript.doc.rev, fields: { sessionId: directorSession } }] }])
      await admin.call('session.sendMessage', { requestId: rid(), sessionId: directorSession, text: request, refs: [] })
      await expect.poll(async () => (await admin!.call('session.getTranscript', { sessionId: directorSession })).items.some((item: { kind: string; payload: { text?: string } }) => item.kind === 'assistant_text' && item.payload.text?.includes(t('The first cut is ready', '第一版剪辑已就绪'))), { timeout: 30_000 }).toBe(true)
      await expect.poll(async () => (await work(director.workItemId)).sessions[0]?.activeTurnId, { timeout: 30_000 }).toBeNull()
      await admin.call('session.sendMessage', { requestId: rid(), sessionId: directorSession, text: t('Keep this cut for review. I will confirm Xiao Hai\'s costume detail.', '先保留这一版供审阅，小海的服装细节由我确认。'), refs: [] })
      await expect.poll(async () => (await admin!.call('session.getTranscript', { sessionId: directorSession })).items.at(-1)?.payload?.text, { timeout: 30_000 }).toBe(t('Production notes received.', '已收到制作记录。'))
      const media = (await admin.call('asset.list', { limit: 200 })).items
      for (const asset of media) {
        const index = images.findIndex(versions => versions.includes(asset.latest.assetVersionId))
        await admin.call('asset.update', { assetId: asset.assetId, expectedRevision: asset.revision, displayName: index >= 0 ? titles[index] : asset.latest.assetVersionId === titleImage ? t('Mountain & Sea · Title', '山海少年 · 片名') : asset.kind === 'video' ? t('First Light · Motion study', '晨光 · 动态镜头') : asset.kind === 'audio' ? t('First Light · Score', '晨光 · 原创配乐') : asset.latest.assetVersionId === logo ? t('Series emblem', '系列徽章') : t('Painted dawn · Style reference', '晨光绘本 · 风格参考'), category: index >= 0 ? t('Key frames', '关键帧') : asset.kind === 'video' ? t('Motion', '动态镜头') : asset.kind === 'audio' ? t('Music', '配乐') : t('References', '参考图'), tags: index >= 0 ? [t('dawn', '晨光'), t('painted', '绘本'), t('episode 1', '第一集')] : [t('production', '制作素材')] })
      }

      await apply([
        { op: 'node.layout', nodeId: ids.script!, x: 0, y: 0, w: 400, h: 230 },
        { op: 'node.layout', nodeId: ids.frame4!, x: 420, y: 0, w: 280, h: 200 },
        { op: 'node.layout', nodeId: ids.frame1!, x: 740, y: 320, w: 350, h: 240 },
        { op: 'node.layout', nodeId: ids.frame2!, x: 0, y: 310, w: 400, h: 270 },
        { op: 'node.layout', nodeId: ids.title!, x: 420, y: 310, w: 220, h: 160 },
        { op: 'node.layout', nodeId: ids.video0!, x: 420, y: 650, w: 220, h: 160 },
        { op: 'node.layout', nodeId: timelineId, x: 0, y: 650, w: 400, h: 340 },
        ...['frame0', 'frame3', 'video1', 'music', 'logo'].map((key): CanvasOp => ({ op: 'node.setMeta', nodeId: ids[key]!, purpose: 'working' })),
        { op: 'node.setMeta', nodeId: exportId, purpose: 'working' },
      ])
      host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
      page = await browser.newPage({ locale: zh ? locale : 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
      page.setDefaultTimeout(15_000)
      errors.length = 0
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/*', route => {
        const url = new URL(route.request().url())
        return ['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort()
      })
      await page.addInitScript(() => {
        localStorage.setItem('vis.canvas.minimap', 'hidden')
        localStorage.setItem('vis.session.width', '360')
        localStorage.setItem('vis.theme', 'dark')
      })
      const url = new URL(host.url)
      url.searchParams.set('space', first)
      await page.goto(url.href)
      await page.locator('.react-flow__pane').waitFor()
      expect(await page.locator('html').getAttribute('lang')).toBe(locale)
      const button = (en: string, cn: string) => page!.getByRole('button', { name: t(en, cn), exact: true })
      const nodeElement = (id: string) => page!.locator(`.react-flow__node[data-id="${id}"]`)
      const deselect = async () => {
        await page!.locator('.react-flow__pane').click({ position: { x: 15, y: 80 } })
        await expect.poll(() => page!.locator('.react-flow__node.selected').count()).toBe(0)
        await expect.poll(() => page!.locator('.vis-operations-toolbar').count()).toBe(0)
      }
      const fit = async () => {
        await button('Fit canvas', '适应画布').click()
        let previous = ''
        await expect.poll(async () => {
          const current = await page!.locator('.react-flow__viewport').getAttribute('style') ?? ''
          const settled = previous === current
          previous = current
          return settled
        }, { interval: 150 }).toBe(true)
      }
      await page.getByRole('listitem').filter({ has: page.getByText(director.title, { exact: true }) }).first().click()
      await fit()
      await page.locator('.vis-work-block > summary').last().click()
      await page.locator('.vis-reasoning > button').last().click()
      await page.locator('.vis-tool-group > summary').last().click()
      const alignRequest = async () => {
        await page!.getByText(request, { exact: true }).evaluate(element => {
          const item = element.closest('.vis-item')!
          const transcript = item.closest('.vis-transcript')!
          transcript.scrollTop += item.getBoundingClientRect().top - transcript.getBoundingClientRect().top - 12
        })
        await expect.poll(() => page!.getByText(request, { exact: true }).evaluate(element => {
          const item = element.closest('.vis-item')!
          return item.getBoundingClientRect().top - item.closest('.vis-transcript')!.getBoundingClientRect().top
        })).toBeGreaterThanOrEqual(0)
      }
      await nodeElement(ids.frame1!).locator('.vis-node-label').click()
      await alignRequest()
      await shot(locale, 'hero', nodeElement(timelineId).locator('.vis-node-label'))
      await deselect()
      await alignRequest()
      await shot(locale, 'hero-b', nodeElement(timelineId).locator('.vis-node-label'))
      await nodeElement(ids.script!).getByRole('button', { name: t('Expand storyboard', '展开分镜表'), exact: true }).click()
      await page.getByRole('dialog', { name: t('Script editor', '脚本编辑器'), exact: true }).waitFor()
      await shot(locale, 'script')
      await page.getByRole('dialog', { name: t('Script editor', '脚本编辑器'), exact: true }).getByRole('tab', { name: t('Prompts', '生成提示词'), exact: true }).click()
      await shot(locale, 'script-prompts')
      await page.getByRole('dialog', { name: t('Script editor', '脚本编辑器'), exact: true }).getByRole('tab', { name: t('Settings', '设定'), exact: true }).click()
      await apply(Object.values(referenceIds).map((nodeId): CanvasOp => ({ op: 'node.setMeta', nodeId, purpose: 'artifact' })))
      await expect.poll(() => page!.locator('.vis-script-asset-card img').count()).toBe(3)
      await shot(locale, 'script-cast')
      await apply(Object.values(referenceIds).map((nodeId): CanvasOp => ({ op: 'node.setMeta', nodeId, purpose: 'working' })))
      await button('Close script editor', '关闭脚本编辑器').click()
      await deselect()
      await nodeElement(timelineId).locator('.vis-node-label').click()
      await button('Open timeline', '打开剪辑').click()
      const editor = page.getByRole('dialog', { name: t('First Light · Picture edit', '晨光 · 画面剪辑'), exact: true })
      await editor.waitFor()
      const seek = editor.getByRole('textbox', { name: t('Playback position', '播放位置'), exact: true })
      await seek.fill('5.5')
      await seek.press('Enter')
      await expect.poll(() => editor.locator('video').evaluateAll(videos => videos.filter(video => getComputedStyle(video).visibility !== 'hidden').every(video => (video as HTMLVideoElement).readyState >= 2)), { timeout: 30_000 }).toBe(true)
      await editor.locator('.vis-tl-clip-wave').waitFor()
      await shot(locale, 'timeline')
      await editor.getByRole('group', { name: t('Picture', '画面'), exact: true }).getByRole('button', { name: new RegExp(t('^Lantern', '^提灯')) }).first().click()
      await shot(locale, 'timeline-inspector')
      await editor.getByRole('group', { name: t('Series emblem', '系列徽章'), exact: true }).getByRole('button', { name: new RegExp(t('^Mountain & Sea', '^山海少年')) }).first().click()
      await shot(locale, 'timeline-overlay')
      await button('Close editor', '关闭编辑器').click()
      await deselect()
      await button('Collapse session panel', '收起会话面板').click()
      await button('Library', '资产库').click()
      const library = page.getByRole('complementary', { name: t('Library', '资产库'), exact: true })
      await library.waitFor()
      await library.getByRole('tab', { name: new RegExp(`^${t('Media', '素材')}`) }).click()
      await shot(locale, 'library-media')
      await library.getByRole('tab', { name: new RegExp(`^${t('Settings', '设定')}`) }).click()
      for (const label of [t('Scenes', '场景'), t('Styles', '风格')]) await library.locator('.library-setting-group > summary').filter({ hasText: new RegExp(`^${label}`) }).click()
      await library.locator('.library-series-unused summary').click()
      await library.locator('.library-settings').evaluate(element => { element.scrollTop = 0 })
      await shot(locale, 'library-settings')
      await library.getByRole('button', { name: t('Close library', '关闭资产库'), exact: true }).click()
      await button('Switch project', '切换项目').click()
      await page.getByRole('menu', { name: t('Project', '项目'), exact: true }).waitFor()
      await shot(locale, 'series')
      await page.keyboard.press('Escape')
      await page.getByRole('tab', { name: t('Board', '看板'), exact: true }).click()
      const board = page.getByRole('region', { name: t('Work board', '工作看板'), exact: true })
      await board.waitFor()
      await shot(locale, 'board')
      const reviewCard = board.getByRole('listitem').filter({ has: page.getByText(children[2]!.title, { exact: true }) })
      await reviewCard.hover()
      await reviewCard.getByRole('button', { name: t('Review', '审阅'), exact: true }).click()
      await page.getByRole('dialog', { name: children[2]!.title, exact: true }).waitFor()
      await shot(locale, 'review')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: new RegExp(t('^Inbox', '^收件箱')) }).click()
      await page.getByRole('dialog', { name: t('Inbox', '收件箱'), exact: true }).waitFor()
      await shot(locale, 'inbox')
      await page.keyboard.press('Escape')
      await page.getByRole('tab', { name: t('Canvas', '画布'), exact: true }).click()
      await apply([
        ...[ids.script!, ids.frame2!, ids.frame4!, ids.title!, ids.video0!, timelineId].map((nodeId): CanvasOp => ({ op: 'node.setMeta', nodeId, purpose: 'working' })),
        { op: 'node.setMeta', nodeId: ids.frame0!, purpose: 'artifact' },
        { op: 'node.layout', nodeId: ids.frame0!, x: 0, y: 540, w: 400, h: 270 },
        { op: 'node.layout', nodeId: ids.frame1!, x: 600, y: 300, w: 600, h: 380 },
      ])
      await expect.poll(() => page!.locator('.react-flow__node').count()).toBe(2)
      await fit()
      await nodeElement(ids.frame1!).locator('.vis-node-label').click()
      await button('View version v1', '查看版本 v1').click()
      await shot(locale, 'versions')
      await page.keyboard.press('Escape')
      await nodeElement(ids.frame1!).locator('.vis-node-body').click({ button: 'right' })
      await page.getByRole('menu').waitFor()
      await shot(locale, 'context-menu')
      await page.keyboard.press('Escape')
      await button('Settings', '设置').click()
      await admin.call('providers.update', { config: { providers: [{ id: 'ark-demo', type: 'volcengine-ark', label: t('Volcengine Ark · Studio', '火山方舟 · 工作室'), baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', imageModels: [{ id: 'demo-seedream', label: 'Seedream' }], videoModels: [{ id: 'demo-seedance', label: 'Seedance' }], audioModels: [] }], defaults: { image: { provider: 'mock', model: 'mock-image-1' }, video: { provider: 'render', model: 'html' }, audio: { provider: 'mock', model: 'mock-music-1' } }, limits: { maxConcurrent: 2, dailyImage: 5, dailyVideo: 2, dailyAudio: 5 } } })
      await admin.call('providers.setKey', { providerId: 'ark-demo', apiKey: 'readme-only-fake-key-never-sent' })
      await button('Close settings', '关闭设置').click()
      await button('Settings', '设置').click()
      await page.getByRole('dialog', { name: t('Settings', '设置'), exact: true }).getByRole('button', { name: new RegExp(`^${t('Volcengine Ark · Studio', '火山方舟 · 工作室')}`) }).click()
      await shot(locale, 'providers')
      await button('Close settings', '关闭设置').click()
      await apply([
        ...[ids.frame0!, ids.frame1!].map((nodeId): CanvasOp => ({ op: 'node.setMeta', nodeId, purpose: 'working' })),
        ...[ids.script!, timelineId, exportId].map((nodeId): CanvasOp => ({ op: 'node.setMeta', nodeId, purpose: 'artifact' })),
        { op: 'node.layout', nodeId: ids.script!, x: 0, y: 0, w: 440, h: 250 },
        { op: 'node.layout', nodeId: timelineId, x: 500, y: 0, w: 520, h: 360 },
        { op: 'node.layout', nodeId: exportId, x: 280, y: 460, w: 460, h: 310 },
      ])
      await expect.poll(() => page!.locator('.react-flow__node').count()).toBe(3)
      await deselect()
      await fit()
      await shot(locale, 'timeline-assemble')
      await captureNewScenes({ page, admin, locale, spaceId: first, director, children, scriptId: ids.script!, shotIds: doc.doc.shots.map(shot => shot.id), shot: name => shot(locale, name), fit, renderAsset })
      await cleanup()
    }
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({ viewport: { width: 1600, height: 1000, deviceScaleFactor: 2 }, locales: manifest }, null, 2))
  })
})
