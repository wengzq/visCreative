import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasOp, NodeView, ScriptDoc, WorkItemView } from '@vis/protocol'
import { createMockProvider } from '../../../packages/generation/src/index'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const chrome = chromePath()
const cli = join(root, 'apps/cli/dist/vis.mjs')
const ready = existsSync(chrome) && existsSync(cli) && existsSync(join(root, 'apps/web/dist/client/index.html'))
let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let scriptId: string
let imageId: string
const errors: string[] = []
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
async function document(): Promise<ScriptDoc | undefined> {
  const main = (await nodes()).find(node => node.nodeId === scriptId)?.slots.find(slot => slot.slotKey === 'main')?.content
  return main?.type === 'script' ? main.doc : undefined
}
const editor = () => page.getByRole('dialog', { name: 'Script editor', exact: true })
// Seeds the fake Agent's scenario word in the prompt slot; the node's input panel is hidden while the editor is open
async function instructions(text: string) {
  const prompt = (await nodes()).find(node => node.nodeId === scriptId)!.slots.find(slot => slot.slotKey === 'prompt')!
  await apply([{ op: 'slot.setText', slotId: prompt.slotId, body: text, expectedRevision: prompt.revision }])
  await expect.poll(async () => (await nodes()).find(node => node.nodeId === scriptId)?.slots.find(slot => slot.slotKey === 'prompt')?.content).toEqual({ type: 'text', body: text })
}

describe.skipIf(!ready)('Script assets and owning Agent session', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-script-agent-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'script-agent-e2e',
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }) },
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } }, secretStore: createMemorySecretStore(),
    })
    const { spaceId } = studiod.spaces.create('Script collaboration')
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chrome, headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(10_000)
  })

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    admin?.close()
    await host?.close()
    await studiod?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('breaks down linked text, writes and edits prompts, picks an asset image, and creates an unsubmitted shot node', async () => {
    try {
      const { item } = await admin.call('work.create', { requestId: crypto.randomUUID(), title: 'Script writer', chat: { agentKind: 'codex' } }) as { item: WorkItemView }
      const space = studiod.spaces.get(item.spaceId)!
      const staged = await space.assets.stageBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>'))
      const asset = space.assets.registerVersion(space.db, { staged, kind: 'image', mime: 'image/svg+xml', origin: 'import', width: 32, height: 32 })
      const { idMap } = await apply([
        { op: 'node.create', tempId: 'text', kind: 'text', title: 'Original screenplay', x: -420, y: 0, content: { text: 'A traveler walks through a quiet city.' } },
        { op: 'node.create', tempId: 'image', kind: 'image', title: 'Hero reference', x: -420, y: 300, content: { assetVersionId: asset.assetVersionId } },
      ])
      imageId = idMap.image
      await page.goto(host.url)
      await page.getByRole('button', { name: 'New script', exact: true }).click()
      await expect.poll(async () => (await nodes()).some(node => node.kind === 'script')).toBe(true)
      scriptId = (await nodes()).find(node => node.kind === 'script')!.nodeId
      await apply([{ op: 'node.setInputs', nodeId: scriptId, inputNodeIds: [idMap.text] }, { op: 'node.layout', nodeId: scriptId, x: 0, y: -600 }])
      // Keep the script node at the top so its input panel opens clear of the bottom canvas toolbar
      await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
      // Wait for the fit animation to settle; until then the node can sit under the top view switch
      let last = ''
      await expect.poll(async () => {
        const now = await page.locator('.react-flow__viewport').evaluate(el => getComputedStyle(el).transform)
        const settled = now === last
        last = now
        return settled
      }, { intervals: [100], timeout: 5_000 }).toBe(true)
      // Breakdown starts from the script node's input panel (RFC 0023 §4), shown while the node is selected
      const scriptCard = page.locator(`.react-flow__node[data-id="${scriptId}"]`)
      await scriptCard.getByText('Script 1', { exact: true }).click()
      const panel = page.getByRole('region', { name: 'Script or editing instructions', exact: true })
      await panel.getByRole('textbox', { name: 'Prompt', exact: true }).fill('script-breakdown script-hold')
      await panel.getByRole('button', { name: 'Breakdown', exact: true }).click()
      const chooser = page.getByRole('dialog', { name: 'Choose owning session', exact: true })
      await chooser.getByRole('combobox', { name: 'Session', exact: true }).selectOption(item.sessions[0]!.sessionId)
      await chooser.getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect.poll(() => page.getByRole('status').filter({ hasText: /Breaking down|Working/ }).count(), { timeout: 15_000 }).toBeGreaterThan(0)
      await expect.poll(async () => (await document())?.shots.length, { timeout: 15_000 }).toBe(3)
      expect((await document())?.assets).toHaveLength(2)
      expect((await document())?.shots[1]?.transition).toBe('continuous')
      await expect.poll(() => panel.getByRole('button', { name: 'Breakdown', exact: true }).isEnabled(), { timeout: 15_000 }).toBe(true)
      // The card and the node toolbar both offer it; use the card's
      await scriptCard.getByRole('button', { name: 'Expand storyboard', exact: true }).click()
      await editor().waitFor()
      const transcript = await admin.call('session.getTranscript', { sessionId: item.sessions[0]!.sessionId })
      const message = transcript.items.find((entry: any) => entry.kind === 'user' && entry.payload.text.includes('script-breakdown'))
      expect(message.payload.text).toContain('script-breakdown script-hold')
      expect(message.payload.refs.map((ref: { nodeId: string }) => ref.nodeId)).toEqual([scriptId, idMap.text])

      await instructions('script-prompts')
      await editor().getByRole('tab', { name: 'Prompts', exact: true }).click()
      await editor().getByRole('button', { name: 'Write prompts', exact: true }).click()
      await expect.poll(async () => (await document())?.shots.every(shot => shot.promptState === 'agent'), { timeout: 15_000 }).toBe(true)
      await editor().getByRole('button', { name: 'Shot 1 · First frame prompt', exact: true }).click()
      const prompt = editor().getByRole('textbox', { name: 'Shot 1 · First frame prompt', exact: true })
      await prompt.fill('User edited prompt')
      await prompt.press('Tab')
      await expect.poll(async () => (await document())?.shots[0]?.promptState).toBe('edited')
      await editor().getByRole('tab', { name: 'Shots', exact: true }).click()
      await editor().getByRole('button', { name: 'Shot 1 · Description', exact: true }).click()
      const description = editor().getByRole('textbox', { name: 'Shot 1 · Description', exact: true })
      await description.fill('The traveler pauses at the gate.')
      await description.press('Tab')
      await expect.poll(async () => (await document())?.shots[0]?.promptState).toBe('stale')

      await editor().getByRole('tab', { name: 'Settings', exact: true }).click()
      const currentDoc = (await document())!
      const firstShot = currentDoc.shots[0]!
      const assetIds = [firstShot.sceneId, ...firstShot.characterIds, ...firstShot.propIds]
      const referencedAsset = currentDoc.assets.find(asset => assetIds.includes(asset.id))!
      const card = editor().getByRole('article', { name: referencedAsset.name, exact: true })
      await card.getByRole('button', { name: 'Pick image from canvas', exact: true }).click()
      await page.keyboard.press('Escape')
      await editor().waitFor()
      expect((await document())!.assets.find(asset => asset.id === referencedAsset.id)?.imageNodeId).toBeFalsy()
      await card.getByRole('button', { name: 'Pick image from canvas', exact: true }).click()
      await page.getByText('Hero reference', { exact: true }).click()
      await editor().waitFor()
      await expect.poll(async () => (await document())!.assets.find(asset => asset.id === referencedAsset.id)?.imageNodeId).toBe(imageId)
      await editor().getByRole('tab', { name: 'Prompts', exact: true }).click()
      await editor().getByRole('button', { name: 'Write prompts', exact: true }).click()
      await expect.poll(async () => (await document())?.shots[0]?.promptState, { timeout: 15_000 }).toBe('agent')
      await editor().getByRole('tab', { name: 'Shots', exact: true }).click()
      await editor().getByRole('row', { name: 'Shot 1', exact: true }).getByRole('button', { name: 'Create image node', exact: true }).click()
      await expect.poll(async () => (await nodes()).some(node => node.shot?.scriptNodeId === scriptId && node.shot.role === 'first')).toBe(true)
      const shot = (await nodes()).find(node => node.shot?.scriptNodeId === scriptId && node.shot.role === 'first')!
      expect(shot.inputs).toContain(imageId)
      expect(shot.slots.find(slot => slot.slotKey === 'prompt')?.content).toEqual({ type: 'text', body: (await document())!.shots[0]!.framePrompt })
      expect((await document())!.shots[0]!.framePrompt).toContain(`{{ref:${imageId}}}`)
      // Creating a shot node selects it on the canvas, which leaves the script editor
      await expect.poll(() => editor().count()).toBe(0)
      await page.getByText('Shot 1', { exact: true }).click()
      await page.getByRole('textbox', { name: 'Prompt', exact: true }).getByText('Image 1', { exact: true }).waitFor()
      expect((await admin.call('generation.usage', {})).image).toBe(0)
      await page.screenshot({ path: join(tmpdir(), 'vis-script-agent.png'), animations: 'disabled' })
      expect(errors).toEqual([])
    } catch (error) {
      await page.screenshot({ path: join(tmpdir(), 'vis-script-agent-failure.png'), animations: 'disabled' })
      throw error
    }
  }, 60_000)
})
