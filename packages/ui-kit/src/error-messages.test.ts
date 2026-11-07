/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { reasons, type Params } from './error-messages'
import { describeError } from './errors'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const directories = ['packages/domain', 'packages/storage/src/idempotency.ts', 'packages/storage/src/work-messages.ts', 'services', 'packages/canvas/core', 'packages/generation', 'packages/assets', 'packages/library/core', 'packages/workbench/core', 'apps/web/src/host', 'packages/ui-kit/src/errors.ts']

function sources(dir: string): string[] {
  if (dir.endsWith('.ts')) return [dir]
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'dist'].includes(entry.name)) return []
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sources(path) : /\.ts$/.test(path) && !/\.test\.ts$/.test(path) ? [path] : []
  })
}

describe('Backend error dictionary (0018)', () => {
  it('every reason has Chinese and English functions that render with parameters', () => {
    expect(Object.keys(reasons.en).sort()).toEqual(Object.keys(reasons['zh-CN']).sort())
    const params: Params = new Proxy({}, { get: () => 2 })
    for (const locale of ['zh-CN', 'en'] as const) {
      for (const [reason, translate] of Object.entries(reasons[locale])) {
        expect(typeof translate, reason).toBe('function')
        const text = translate(params)
        expect(typeof text, reason).toBe('string')
        expect(text.length, reason).toBeGreaterThan(0)
        if (locale === 'en') expect(text, reason).not.toMatch(/[㐀-鿿]/)
      }
    }
  })

  it('English does not forward potentially Chinese low-level diagnostics; Chinese retains diagnostics', () => {
    for (const reason of ['runtime.invalid_params', 'session.models_unavailable', 'generation.invalid_params', 'asset.media_probe_failed', 'asset.frame_extraction_failed'] as const) {
      // english-exempt: Chinese diagnostic fixture verifies that English UI suppresses untranslated diagnostics.
      const error = { message: '底层错误', data: { reason, params: { detail: '未安装 Agent' } } }
      expect(describeError(error, 'en')).not.toMatch(/[㐀-鿿]/)
      expect(describeError(error, 'zh-CN')).toContain('未安装 Agent')
    }
  })

  it('all backend reason literals have dictionary entries', () => {
    const found = new Set<string>()
    for (const file of directories.flatMap(dir => sources(join(root, dir)))) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const collect = (node: ts.Node | undefined) => {
        if (!node) return
        if (ts.isStringLiteral(node) && /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(node.text)) found.add(node.text)
        ts.forEachChild(node, collect)
      }
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.getText(source) === 'VisError.of') collect(node.arguments[1])
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'invalid') {
          collect(node.arguments[basename(file) === 'zip.ts' ? 0 : 1])
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'ProviderError') collect(node.arguments?.[2])
        if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'reason') collect(node.initializer)
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'textReasons') collect(node.initializer)
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(found.size).toBeGreaterThan(0)
    for (const reason of found) expect(Object.hasOwn(reasons.en, reason), reason).toBe(true)
  })

  it('upload limits and invalid archives use actionable English notices', () => {
    expect(reasons.en['upload.too_large']({ maxBytes: 2 * 1024 ** 3 })).toBe('File is too large (max 2 GB)')
    expect(reasons.en['skill.zip.end_record']({ path: '' })).toBe('This isn\'t a valid zip archive')
  })

  it('parameterized reasons take precedence over raw messages and error codes', () => {
    // english-exempt: Chinese diagnostic fixture verifies that localized reasons take precedence over raw messages.
    const error = { message: '原始错误', data: { code: 'not_found', reason: 'space.missing_id', params: { spaceId: 'demo' } } }
    expect(describeError(error, 'zh-CN')).toBe('空间 demo 不存在')
    expect(describeError(error, 'en')).toBe('Project demo does not exist')
  })

  it.each([
    ['Enter an absolute path', '请输入绝对路径'],
    ['Directory does not exist or is not readable and writable', '目录不存在或不可读写'],
    ['Permanent deletion is not complete; try again', '永久删除尚未完成，请重试'],
    ['Project directory has moved or is inaccessible', '项目目录已移动或无法访问'],
    ['Project directory contains the application data directory', '项目目录包含应用数据目录', 'The project directory contains the application data directory'],
    ['Generation service demo configuration is invalid; cannot confirm the job result', '生成服务 demo 的配置已失效，无法确认任务结果'],
    ['Generation service demo is unavailable; cannot confirm the job result', '生成服务 demo 已不可用，无法确认任务结果'],
    ['Generation service returned running, inconsistent with the completed record', '生成服务返回 running，与已完成的记录不符'],
    ['Cannot confirm submission result; not resubmitted to avoid duplicate generation', '提交结果无法确认，未重新提交以免重复生成'],
    ['Generation service cannot find this job; outputs cannot be downloaded', '生成服务找不到该任务，产物无法下载'],
    ['Simulated generation failure', '模拟生成失败'],
    ['Ark returned no usable images', 'Ark 未返回可用图片'],
    ['Ark video generation timed out', 'Ark 视频生成超时'],
    ['Configure Ark API Key first', '请先配置 Ark API Key'],
    ['Ark query temporarily failed', 'Ark 查询暂时失败'],
    ['Ark request failed (HTTP 429)', 'Ark 请求失败（HTTP 429）'],
    ['Ark output download failed (HTTP 503)', 'Ark 产物下载失败（HTTP 503）'],
    ['Cannot find Chrome for rendering; install Google Chrome', '找不到 Chrome，无法渲染；请安装 Google Chrome'],
    ['Codex startup failed: Cannot start Codex: ENOENT', 'Codex 启动失败：无法启动 Codex：ENOENT'],
    ['Waiting for DeepSeek Harness startup exceeded 60 seconds', '等待 DeepSeek Harness 启动超过 60 秒'],
    ['DeepSeek Harness rejected this message: connection reset', 'DeepSeek Harness 拒绝了这条消息：connection reset'],
    ['Page did not define window.vis = { duration, seek(t) } within 5 seconds', '页面在 5 秒内没有定义 window.vis = { duration, seek(t) }'],
    ['Invalid duration: window.vis.duration must be a number from 0 to 30 seconds; got 40', '时长无效：window.vis.duration 应为 0–30 秒的数字，实际 40'],
    ['Cannot find ffmpeg.exe; install ffmpeg first', '找不到 ffmpeg.exe，请先安装 ffmpeg'],
    ['Error at frame 10 (0.50 seconds)\nPage error: example', '第 10 帧（0.50 秒）出错\nPage error: example'],
  ])('localizes legacy backend text %s without changing diagnostics', (message, chinese, english = message) => {
    expect(describeError({ code: 'provider_error', message }, 'zh-CN')).toBe(chinese)
    expect(describeError({ code: 'provider_error', message }, 'en')).toBe(english)
  })

  it('skill problem reasons retain the approved Chinese text and interpolate names and levels', () => {
    expect(reasons['zh-CN']['skill.metadata_missing_name']({})).toBe('缺少 SKILL.md 的 name')
    expect(reasons['zh-CN']['skill.metadata_missing_description']({})).toBe('缺少 SKILL.md 的 description')
    expect(reasons['zh-CN']['skill.duplicate_name']({ name: 'demo' })).toBe('名称重复：demo')
    expect(reasons.en['skill.duplicate_name']({ name: 'demo' })).toBe('Duplicate name: demo')
    expect(reasons['zh-CN']['skill.metadata_not_found']({ levels: 3 })).toBe('向下 3 层内未找到 SKILL.md')
    expect(reasons.en['skill.metadata_not_found']({ levels: 3 })).toBe('No SKILL.md found within 3 levels')
  })
})

it('localizes a missing transparent WebM encoder in both languages', () => {
  const error = { code: 'generation.render_alpha_encoder_missing', message: 'This ffmpeg lacks libvpx-vp9; transparent WebM rendering is unavailable' }
  expect(describeError(error, 'en')).toBe(error.message)
  expect(describeError(error, 'zh-CN')).toBe('此 ffmpeg 缺少 libvpx-vp9，无法渲染透明 WebM')
})

it('localizes missing author render libraries with their filename and installation folder in both languages', () => {
  const error = { code: 'render.lib_missing', message: 'Missing library', data: { reason: 'render.lib_missing', params: { name: 'gsap.js' } } }
  expect(describeError(error, 'en')).toBe('Render library "gsap.js" is missing or unavailable. Add the library to the render-libs folder in the application data directory and retry')
  expect(describeError(error, 'zh-CN')).toBe('渲染库“gsap.js”缺失或不可用。请将该库放入应用数据目录的 render-libs 文件夹后重试')
})


it('localizes render library failures from their text when a view drops the error data', () => {
  expect(describeError({ message: 'Render library "gsap.js" is missing or unavailable. Add the library to the render-libs folder and retry' }, 'zh-CN')).toContain('gsap.js')
  expect(describeError({ message: 'Render library "gsap.js" is missing or unavailable. Add the library to the render-libs folder and retry' }, 'zh-CN')).toContain('缺失')
  expect(describeError({ message: 'Render library "three.x.js" cannot be provided. Author libraries must be single .js files that do not use a built-in library name' }, 'zh-CN')).toContain('内置库')
})

it('localizes missing ProRes and expired delivery files in both languages', () => {
  expect(describeError({ message: 'This ffmpeg lacks prores_ks; MOV ProRes 4444 export is unavailable' }, 'zh-CN')).toContain('无法导出')
  expect(describeError({ data: { reason: 'media.export_user_only' } }, 'en')).toBe('Only the user can export MOV delivery files')
  expect(describeError({ message: 'The MOV export is unavailable or has expired; export it again' }, 'zh-CN')).toContain('重新导出')
})

it('explains an old ffmpeg release in both author languages', () => {
  const error = { message: 'fallback', data: { code: 'unavailable', reason: 'media.ffmpeg_version_unsupported', params: { version: '6.1.2', required: 7 } } }
  expect(describeError(error, 'en')).toBe('Found ffmpeg 6.1.2. Timeline export requires ffmpeg 7 or newer. Update ffmpeg and restart visCreative to export.')
  expect(describeError(error, 'zh-CN')).toBe('检测到 ffmpeg 6.1.2，剪辑导出需要 ffmpeg 7 或更高版本，请更新 ffmpeg 并重启 visCreative')
})

it('localizes version errors retained in background media-task text fields', () => {
  const error = { code: 'media.ffmpeg_version_unsupported', message: 'Found ffmpeg 6.1.2. Timeline export requires ffmpeg 7 or newer. Update ffmpeg and restart visCreative to export.' }
  expect(describeError(error, 'zh-CN')).toBe('检测到 ffmpeg 6.1.2，剪辑导出需要 ffmpeg 7 或更高版本，请更新 ffmpeg 并重启 visCreative')
  expect(describeError(error, 'en')).toBe(error.message)
})
