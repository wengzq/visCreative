import { AgentKind, type NodeView, type SessionSummary, type SpaceEvent, type SpaceSnapshot, type TranscriptItem, type TransientEvent } from '@vis/protocol'

export const HELP = `
直接输入文字：发消息给当前会话（附带 /ref 选中的引用）
/sessions               列出会话
/new [Agent] <标题>     新建会话并切换过去；Agent 为 agents.list 中的类型，省略时使用默认类型
/use <序号|会话ID>       切换当前会话
/log [条数]             查看当前会话记录
/canvas                 列出画布节点（带序号）
/text <内容>            在画布上新建文本节点
/import <绝对路径>        导入本机图片或视频，放到画布上
/ref <序号|节点ID>       给下一条消息附加引用；/refs 查看，/unref 清空
/stop                   停止当前回合
/resume                 恢复暂停的队列
/retry <消息ID>          重试未确认或被拒的消息
/quit                   退出
`.trim()

type Call = (method: string, params?: unknown) => Promise<any>

/** Development client core: command parsing, state, and event rendering; avoids direct terminal access for testing */
export function createDevConsole(deps: {
  call: Call
  print(line: string): void
  /** Refreshes one line in place to display the streaming reply; optional outside terminals */
  status?(prefix: string, body: string): void
  spaceId: string
  snapshot: SpaceSnapshot
}) {
  const { call, print } = deps
  let sessions: SessionSummary[] = deps.snapshot.sessions
  let nodes: NodeView[] = deps.snapshot.nodes
  let current: string | undefined = sessions.at(-1)?.sessionId
  let refs: string[] = []
  /** The current session streaming reply, discarded when the final entry arrives */
  const drafts = new Map<string, string>()
  let seq = 0
  const rid = () => `dev_${Date.now().toString(36)}_${++seq}`

  const sessionLabel = (id: string) => {
    const i = sessions.findIndex(x => x.sessionId === id)
    return i >= 0 ? `#${i + 1} ${sessions[i]!.title}` : id
  }

  async function refreshNodes() {
    nodes = (await call('canvas.get', {})).nodes
  }

  function resolveNode(arg: string): string | undefined {
    const n = Number(arg)
    if (Number.isInteger(n) && n >= 1) return nodes[n - 1]?.nodeId
    return nodes.find(x => x.nodeId === arg)?.nodeId
  }

  function requireSession(): string {
    if (!current) throw new Error('No session yet: create one with /new <title> first')
    return current
  }

  async function handleLine(raw: string): Promise<'quit' | void> {
    const line = raw.trim()
    if (!line) return
    if (!line.startsWith('/')) {
      const sessionId = requireSession()
      const r = await call('session.sendMessage', { requestId: rid(), sessionId, text: line, refs: refs.map(nodeId => ({ nodeId, versionPolicy: 'latest-at-execution' })) })
      refs = []
      print(r.deliveryState === 'draft' ? `· 已排队（前面还有 ${r.queuePosition} 条）` : '· 已发送')
      return
    }
    const [cmd, ...rest] = line.slice(1).split(/\s+/)
    const arg = rest.join(' ')
    switch (cmd) {
      case 'help': print(HELP); return
      case 'quit': case 'exit': return 'quit'
      case 'sessions':
        sessions = (await call('session.list', {})).sessions
        if (!sessions.length) print('（没有会话）')
        sessions.forEach((x, i) => print(`${x.sessionId === current ? '*' : ' '} #${i + 1} ${x.title}  ${x.agentKind}${x.activeTurnId ? '  运行中' : ''}${x.queuePaused ? '  队列已暂停' : ''}  ${x.sessionId}`))
        return
      case 'new': {
        const [first = '', ...words] = arg.split(/\s+/)
        const { agents } = await call('agents.list', {}) as { agents: { kind: string }[] }
        const kind = AgentKind.safeParse(agents.some(agent => agent.kind === first) ? first : '')
        const title = (kind.success ? words.join(' ') : arg) || '未命名会话'
        const created: SessionSummary = await call('session.create', { requestId: rid(), title, ...(kind.success ? { agentKind: kind.data } : {}) })
        sessions = [...sessions.filter(x => x.sessionId !== created.sessionId), created]
        current = created.sessionId
        drafts.clear()
        print(`· 已新建并切换到 ${sessionLabel(current)}`)
        return
      }
      case 'use': {
        sessions = (await call('session.list', {})).sessions
        const n = Number(arg)
        const found = Number.isInteger(n) && n >= 1 ? sessions[n - 1] : sessions.find(x => x.sessionId === arg)
        if (!found) throw new Error(`No session ${arg}`)
        current = found.sessionId
        drafts.clear()
        print(`· 当前会话：${sessionLabel(current)}`)
        return
      }
      case 'log': {
        const { items } = await call('session.getTranscript', { sessionId: requireSession(), limit: Number(arg) || 20 })
        for (const item of items as TranscriptItem[]) renderItem(item, true)
        return
      }
      case 'canvas':
        await refreshNodes()
        if (!nodes.length) print('（画布为空）')
        nodes.forEach((n, i) => print(`${String(i + 1).padStart(3)}. ${n.kind.padEnd(5)} ${n.nodeId}  (${n.x},${n.y} ${n.w}×${n.h})  ${n.slots.map(slotText).join(' | ')}`))
        return
      case 'import': {
        if (!arg) throw new Error('Usage: /import <absolute-path>')
        const v = await call('asset.import', { requestId: rid(), path: arg })
        await refreshNodes()
        const bottom = Math.max(0, ...nodes.map(x => x.y + x.h))
        const w = 320
        const h = v.width && v.height ? Math.round((w * v.height) / v.width) : 320
        const { idMap } = await call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'n', kind: v.kind, x: 0, y: bottom + 40, w, h, content: { assetVersionId: v.assetVersionId } }] })
        await refreshNodes()
        print(`· 已导入 ${v.kind} ${v.mime}${v.durationMs ? ` ${(v.durationMs / 1000).toFixed(1)}s` : ''}，节点 ${idMap.n}（/ref ${nodes.findIndex(n => n.nodeId === idMap.n) + 1} 可引用）`)
        return
      }
      case 'text': {
        if (!arg) throw new Error('Usage: /text <content>')
        await refreshNodes()
        const x = nodes.reduce((m, n) => Math.max(m, n.x + n.w + 40), 0)
        const { idMap } = await call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'n', kind: 'text', x, y: 0, w: 320, h: 200, content: { text: arg } }] })
        await refreshNodes()
        print(`· 已新建文本节点 ${idMap.n}（/ref ${nodes.findIndex(n => n.nodeId === idMap.n) + 1} 可引用）`)
        return
      }
      case 'ref': {
        if (!nodes.length) await refreshNodes()
        const nodeId = resolveNode(arg)
        if (!nodeId) throw new Error(`No node ${arg}; use /canvas to view indices first`)
        if (!refs.includes(nodeId)) refs.push(nodeId)
        print(`· 下一条消息将引用：${refs.join(', ')}`)
        return
      }
      case 'refs': print(refs.length ? refs.join(', ') : '（没有引用）'); return
      case 'unref': refs = []; print('· 已清空引用'); return
      case 'stop': {
        const sessionId = requireSession()
        const s = (await call('session.list', {})).sessions.find((x: SessionSummary) => x.sessionId === sessionId)
        if (!s?.activeTurnId) throw new Error('The current session has no active turn')
        await call('session.stop', { requestId: rid(), sessionId, turnId: s.activeTurnId })
        print('· 已请求停止；队列已暂停，/resume 继续')
        return
      }
      case 'resume': await call('session.resumeQueue', { requestId: rid(), sessionId: requireSession() }); print('· 队列已恢复'); return
      case 'retry': {
        if (!arg) throw new Error('Usage: /retry <message-ID>')
        const r = await call('session.retryMessage', { requestId: rid(), messageId: arg })
        print(`· 已重试，新消息 ${r.messageId}`)
        return
      }
      default: throw new Error(`Unknown command /${cmd}; enter /help for commands`)
    }
  }

  function renderItem(item: TranscriptItem, all = false) {
    const p = item.payload as Record<string, any>
    switch (item.kind) {
      case 'user': if (all) print(`你 › ${p.text}`); return
      case 'assistant_text': print(`Agent › ${p.text}`); return
      case 'tool_call': print(`  → ${p.name} ${clip(JSON.stringify(p.input), 160)}`); return
      case 'tool_result': print(`  ${p.isError ? '✗' : '←'} ${clip(String(p.text ?? ''), 200)}`); return
      case 'notice': print(`[提示] ${p.message}`); return
    }
  }

  function handleEvent(e: SpaceEvent) {
    const p = e.payload as Record<string, any>
    switch (e.type) {
      case 'transcript.itemUpserted':
        drafts.delete((p as TranscriptItem).itemId)
        if (e.entityId !== current) { if ((p as TranscriptItem).kind === 'assistant_text') print(`（${sessionLabel(e.entityId)} 有新回复）`); return }
        renderItem(p as TranscriptItem)
        return
      case 'session.created':
        if (!sessions.some(x => x.sessionId === e.entityId)) sessions = [...sessions, p as SessionSummary]
        return
      case 'session.updated':
        sessions = sessions.map(x => (x.sessionId === e.entityId ? (p as SessionSummary) : x))
        return
      case 'turn.stateChanged':
        if (p.status !== 'running') print(`· 回合${({ completed: '完成', failed: '失败', interrupted: '已中断', waiting_user: '等待回答' } as Record<string, string>)[p.status] ?? p.status}`)
        return
      case 'message.stateChanged':
        if (p.deliveryState === 'rejected' || p.deliveryState === 'unknown') print(`· 消息 ${p.messageId} ${p.deliveryState === 'rejected' ? '被拒绝' : '投递结果未知'}，可 /retry ${p.messageId}`)
        return
      case 'job.stateChanged':
        print(`· 生成 ${p.jobId}：${p.status}${p.error ? `（${p.error.message}）` : ''}`)
        return
      case 'node.created':
        print(`· 画布：新建 ${p.kind} 节点 ${e.entityId}`)
        return
      case 'node.deleted':
        print(`· 画布：删除节点 ${e.entityId}`)
        return
    }
  }

  function handleTransient(e: TransientEvent) {
    if (e.sessionId !== current) return
    const text = (drafts.get(e.itemId) ?? '') + e.delta
    drafts.set(e.itemId, text)
    deps.status?.('Agent ✎ ', text.replace(/\s+/g, ' '))
  }

  return { handleLine, handleEvent, handleTransient, currentSession: () => current, pendingRefs: () => [...refs], drafts: () => new Map(drafts) }
}

function slotText(slot: NodeView['slots'][number]): string {
  const c = slot.content
  if (c.type === 'text') return `“${clip(c.body, 40)}” r${slot.revision}`
  if (c.type === 'asset') return `[${c.mime} ${c.assetVersionId}] r${slot.revision}`
  return '（空）'
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ')
  return one.length > max ? `${one.slice(0, max)}…` : one
}
