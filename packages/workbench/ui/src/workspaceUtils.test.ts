import { describe, expect, it } from 'vitest'
import { workspaceSlug } from './WorkspaceDialog'
import { mentionQuery, plainTextSummary, shortenDirectory, slashSkillQuery, workMessageText } from './workspaceUtils'

describe('Workspace display and Skill references', () => {
  it('Node summaries strip Markdown markers while retaining link text, code, and ordinary punctuation', () => {
    expect(plainTextSummary('# 标题\n**重点** 和 *强调*\n- [x] 第一镜\n2. [参考](https://example.com)')).toBe('标题\n重点 和 强调\n第一镜\n参考')
    expect(plainTextSummary('```ts\nconst file_name = "C#"\n```')).toBe('const file_name = "C#"')
    expect(plainTextSummary('> __旁白__ ~~删除~~ `代码`')).toBe('旁白 删除 代码')
    expect(plainTextSummary('```js\nconst area = width * height * scale\n```')).toBe('const area = width * height * scale')
    expect(plainTextSummary('2 * 3 * 4 和 `*字面内容*`')).toBe('2 * 3 * 4 和 *字面内容*')
  })
  it('Directories retain their beginning and end; short directories display in full', () => {
    expect(shortenDirectory('/tmp/project')).toBe('/tmp/project')
    const path = '/Users/creative/very-long-project/workspaces/storyboard-2026'
    expect(shortenDirectory(path)).toBe(`${path.slice(0, 18)}…${path.slice(-23)}`)
  })
  it('New-directory previews follow the backend Unicode slug rules', () => {
    expect(workspaceSlug(' ..测试 Story / 01.. ')).toBe('测试-story-01')
    expect(workspaceSlug('...')).toBe('')
  })
  it('Recognize slash only at a word boundary before the cursor without mistaking file paths', () => {
    expect(slashSkillQuery('/story', 6)).toEqual({ query: 'story', start: 0, end: 6 })
    expect(slashSkillQuery('使用 /港风 后续', 6)).toEqual({ query: '港风', start: 3, end: 6 })
    expect(slashSkillQuery('/story text', 11)).toBeNull()
    expect(slashSkillQuery('/tmp/skills', 11)).toBeNull()
    expect(slashSkillQuery('https://example.com', 19)).toBeNull()
    expect(mentionQuery('@', 1)).toEqual({ query: '', start: 0, end: 1 })
    expect(mentionQuery('看看 @主角', 6)).toEqual({ query: '主角', start: 3, end: 6 })
    expect(mentionQuery('@主角 后面', 6)).toBeNull()
    expect(mentionQuery('a@b.com', 7)).toBeNull()
  })
})

describe('workMessageText', () => {
  it('hides delivery IDs from every header in a batch and keeps the source and body', () => {
    const header = (id: string) => `[工作消息 · brief · 来自 系统 · wmsg_${id} · 批次 dlv_1]`
    expect(workMessageText(`${header('a')}\n写第一段\n\n${header('b')}\n写第二段`)).toBe('[工作消息 · brief · 来自 系统]\n写第一段\n\n[工作消息 · brief · 来自 系统]\n写第二段')
  })
})
