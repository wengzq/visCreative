import type { MethodResult } from '@vis/protocol'
import { formatter, LocaleProvider } from '@vis/ui-kit'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProjectDeleteDialog } from './ProjectDelete'
import { diskSize, PurgeProjectDialog } from './RecentlyDeleted'

const plan: MethodResult<'space.deletePlan'> = { runningTurns: 0, unfinishedJobs: 0, workInProgress: 0, unresolvedMessages: 0, rootPath: '/projects/电影' }
const project: MethodResult<'space.listDeleted'>['spaces'][number] = { spaceId: 'project', name: '电影', rootPath: plan.rootPath, deletedAt: 1, rootPathExists: true, canDeleteProjectDir: true, canDeleteProjectDirReason: null, purgeError: null }
const renderDelete = (value: typeof plan | null, extra = {}) => renderToStaticMarkup(createElement(ProjectDeleteDialog, { name: project.name, plan: value, onClose() {}, onDelete() {}, ...extra }))

describe('Project deletion confirmation', () => {
  it('English deletion confirmation formats counts, preserves project data, and translates backend errors', () => {
    const html = renderToStaticMarkup(createElement(LocaleProvider, { locale: 'en', setLocale() {}, children: createElement(ProjectDeleteDialog, {
      name: project.name, plan: { ...plan, runningTurns: 1000 }, error: '读取失败', onClose() {}, onDelete() {},
    }) }))
    expect(html).toContain('Delete project “电影”?')
    expect(html).toContain('1,000 Agents are working and will be stopped before deletion')
    expect(html).toContain('Stop and delete')
    expect(html).toContain('Something went wrong')
    expect(html).not.toContain('读取失败')
    expect(html).toContain(plan.rootPath)
  })

  it('cannot confirm without deletion impact; focuses cancel by default', () => {
    const html = renderDelete(null, { loading: true })
    expect(html).toContain('正在读取删除影响…')
    expect(html).toContain('type="submit" class="is-danger" disabled=""')
    expect(html).toMatch(/autofocus=""[^>]*>取消/)
    expect(renderDelete(null, { error: '读取失败' })).toContain('role="alert">读取失败')
  })

  it('idle projects can be restored with their directories preserved; running impacts warn individually', () => {
    const idle = renderDelete(plan)
    expect(idle).toContain('项目会移到设置里的「最近删除」，可以恢复。项目目录不会被删除：')
    expect(idle).toContain(plan.rootPath)
    expect(idle).toContain('class="is-danger">删除</button>')
    expect(idle).not.toContain('⚠')
    const running = renderDelete({ ...plan, runningTurns: 2, unfinishedJobs: 3, workInProgress: 4, unresolvedMessages: 5 })
    for (const warning of ['有 2 个 Agent 正在工作，删除会先停止它们', '有 3 个生成任务未完成，会被取消（已提交的可能仍会计费）', '有 4 个工作项进行中', '有 5 条提问在等你回复，删除后不再处理']) expect(running).toContain(warning)
    expect(running).toContain('停止并删除')
  })
})

describe('Permanent project deletion confirmation', () => {
  const render = (value = project) => renderToStaticMarkup(createElement(PurgeProjectDialog, { project: value, usage: { dataBytes: 2.5 * 1024 ** 3, projectDirBytes: 850 * 1024 ** 2 }, busy: false, error: '', onClose() {}, onPurge() {} }))
  it('clearly states irreversibility, preserves directories by default, and focuses cancel', () => {
    const html = render()
    expect(html).toContain(`画布、历史和生成的素材（${formatter('zh-CN').bytes(2.5 * 1024 ** 3)}）会被删除，无法撤销。`)
    expect(html).toContain(`同时删除项目目录（${formatter('zh-CN').bytes(850 * 1024 ** 2)}）`)
    expect(html).not.toContain('checked=""')
    expect(html).toMatch(/autofocus=""[^>]*>取消/)
  })
  it('dangerous directories disable the checkbox and show the server reason; missing directories are also disabled', () => {
    const html = render({ ...project, canDeleteProjectDir: false, canDeleteProjectDirReason: '项目目录不能是用户主目录' })
    expect(html).toMatch(/type="checkbox" disabled=""/)
    expect(html).toContain('项目目录不能是用户主目录')
    const missing = render({ ...project, rootPathExists: false })
    expect(missing).toContain('项目目录已不存在')
    expect(missing).toMatch(/type="checkbox" disabled=""/)
  })
  it('app data and project directory sizes use the same units', () => {
    expect(diskSize(0)).toBe(formatter('zh-CN').bytes(0))
    expect(diskSize(1024)).toBe(formatter('zh-CN').bytes(1024))
    expect(diskSize(2.5 * 1024 ** 3)).toBe(formatter('zh-CN').bytes(2.5 * 1024 ** 3))
    expect(diskSize(1024, 'en')).toBe(formatter('en').bytes(1024))
  })
})
