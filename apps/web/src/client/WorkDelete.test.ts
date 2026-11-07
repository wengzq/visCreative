import type { MethodResult } from '@vis/protocol'
import { DeleteWorkDialog } from '@vis/workbench-ui'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

const plan: MethodResult<'work.deletePlan'> = {
  runningTurns: 0, unfinishedJobs: 0, childrenTotal: 0, childrenInProgress: 0, unresolvedMessages: 0,
  hasUnreviewedReport: false, queued: false, workDir: '/项目/workspaces/镜头二',
}
const render = (value: typeof plan | null, extra = {}) => renderToStaticMarkup(createElement(DeleteWorkDialog, {
  title: '镜头二', plan: value, onClose() {}, onDelete() {}, ...extra,
}))

describe('Work-item deletion confirmation', () => {
  it('loading and read failures disable deletion; cancel receives default focus', () => {
    for (const html of [render(null, { loading: true }), render(null, { error: '读取失败' })]) {
      expect(html).toContain('type="submit" disabled=""')
      expect(html).toMatch(/autofocus=""[^>]*>取消/)
    }
    expect(render(null, { loading: true })).toContain('正在读取删除影响…')
    expect(render(null, { error: '读取失败' })).toContain('role="alert">读取失败')
  })

  it('idle work items show only preservation information and directory, no canvas checkbox, and a Delete button', () => {
    const html = render(plan)
    expect(html).toContain('会话会归档，画布内容保留。')
    expect(html).toContain(plan.workDir)
    expect(html).not.toContain('⚠')
    expect(html).not.toContain('type="checkbox"')
    expect(html).toContain('type="submit">删除</button>')
  })

  it('aggregated risks display individually and still preserve the canvas; active turns or generation require stop and delete', () => {
    const html = render({ ...plan, runningTurns: 1, unfinishedJobs: 2, childrenTotal: 3, childrenInProgress: 1, unresolvedMessages: 4, hasUnreviewedReport: true, queued: true })
    for (const warning of ['Agent 正在工作，删除会先停止它', '2 个生成任务未完成，取消后服务端可能仍会计费', '包含 3 个子工作项（1 个进行中），会一起删除', '有 4 条提问在等你回复，删除后不再处理', '完成报告还没审阅', '正在排队，删除会取消排队']) expect(html).toContain(warning)
    expect(html).toContain('会话会归档，画布内容保留。')
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('checked=""')
    expect(html).toContain('type="submit">停止并删除</button>')
    expect(render({ ...plan, unfinishedJobs: 1 })).toContain('停止并删除')
    expect(render({ ...plan, childrenTotal: 2 })).toContain('包含 2 个子工作项，会一起删除')
    expect(render({ ...plan, childrenTotal: 2 })).not.toContain('（0 个进行中）')
  })

  it('deletion failures show errors and allow retry', () => {
    const html = render(plan, { error: '停止失败，请重试' })
    expect(html).not.toContain('type="checkbox"')
    expect(html).toContain('type="submit">删除</button>')
    expect(html).toContain('停止失败，请重试')
  })
})
