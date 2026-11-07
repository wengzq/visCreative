# 0003 · 核心接口契约（MVP）

状态：已决定（MVP 契约）

日期：2026-10-26

0010 更新：2026-10-28。工作项方法按工作区父子关系授权；移除画框绑定与会话角色，改动数来自本轮事件，见 [0010](0010-workspaces-without-canvas-binding.md)。

依赖：[0001](0001-multi-agent-creative-space.md) 的语义约束、[0002](0002-sqlite-storage.md) 的表结构。本文定义五个核心接口及配套接口；实现落在 `packages/protocol`（zod schema），studiod、CLI、UI 共用。

## 共用规则

### 协议

- JSON-RPC 2.0。传输方式（本机 socket / pipe、渲染层如何接入）另行确定，不影响本文契约。
- 空间修改类请求携带 `requestId`。同一 `requestId` 同内容重试，返回首次结果；内容不同返回 `idempotency_conflict`。由 `idempotency_keys` 表实现，指纹为参数的规范化哈希。全局 Provider 配置及 Keychain 修改是例外：`providers.update`、`providers.setKey`、`providers.clearKey` 严格不接受 `requestId`，不进入空间幂等表（[0007](0007-generation-providers.md)）。
- 修改类接口返回“已接受”回执，不代表执行完成；执行进度通过事件推送（界面）或 `generation.get`（Agent）获取。

RFC 0010 的升级边界例外：旧游标重取当前快照，旧请求仍不重复执行；无法安全重放时返回 `request_not_replayable`，调用方重新读取当前状态，不自动换 requestId 重试。详见 [0010 迁移](0010-workspaces-without-canvas-binding.md#迁移)。

### 调用方身份

身份不从参数中取。

| 调用方 | 凭据 | 服务端得到的身份 | 可访问范围 |
|---|---|---|---|
| 界面 | 连接建立时的本机凭据 | 用户 | 当前打开的空间；`work.*` 可显式选择项目或聚合全部项目 |
| Agent（经 CLI） | 启动 Agent 进程时注入的运行令牌（环境变量） | 空间 + 会话 + 运行实例 + 当前回合 | 仅所属空间 |

- 运行令牌随运行实例生成，实例退出即失效；库中只存哈希（`agent_instances.token_hash`）。
- Agent 不能用 `spaceId` 跨项目访问。共用的 `work.*` schema 为界面声明可选 `spaceId`，Agent 只要显式携带就返回 `forbidden`；`work.list({ scope: 'all' })` 同样仅界面可用。
- 所属工作项从令牌绑定的会话行实时读取，不从参数或握手缓存取值。能力枚举、能力说明与请求执行共用调用方限制；Agent 工作项写操作再按根项、父项与直接子项关系检查。写操作仍须核对当前活动回合；未关联工作项或已归档的会话不能作为工作项写入身份。

### 错误码

JSON-RPC `error.data.code` 取以下值：

| code | 含义 |
|---|---|
| `invalid_params` | 参数不合法（schema 校验失败、类型不兼容等） |
| `not_found` | 对象不存在或已删除 |
| `forbidden` | 调用方无权访问该对象 |
| `revision_conflict` | 修订条件不满足；槽位冲突使用 `data.conflicts`，工作项冲突使用 `data.expectedRevision`、`data.currentRevision` |
| `idempotency_conflict` | 同一 `requestId` 携带了不同内容 |
| `request_not_replayable` | 升级前请求已执行，旧结果不可重放；重读当前状态，不自动换 ID 再执行 |
| `busy` | 当前状态不允许该操作 |
| `unavailable` | 空间暂不可写，例如正在做崩溃恢复 |
| `provider_error` | 生成服务返回错误 |
| `job_terminal` | 任务已结束，不能再次取消 |
| `quota_exceeded` | 今日付费任务额度不足；data.kind/count/limit 供界面确认 |
| `invalid_transition` | 工作项状态不允许该转换；`data.status` 为当前状态，子项未完成时附 `data.incompleteChildren` |
| `already_resolved` | 提问、阻塞或升级已被回复或回收；`data.resolution` 返回最先解决它的完整 `WorkMessageView` |

工作项错误的附加数据由 `VisError(code, message, conflicts?, quota?, details?)` 的第五个参数传递，并平铺到 `error.data`；不会再套一层 `details`。

## 1. `session.sendMessage`

调用方：界面。

```ts
params: {
  requestId: string
  sessionId: string
  text: string
  refs: {
    nodeId: string
    slotId?: string
    versionPolicy: 'latest-at-execution' | 'pinned'
    pinnedRevision?: number
  }[]
}
result: {
  messageId: string
  deliveryState: 'draft' | 'submitted'
  queuePosition?: number
}
```

- 只保存引用意图，不解析版本。版本在回合开始、首次交给 Claude 之前解析并写入输入快照（0001“素材引用与执行快照”）。
- Agent 空闲、队列未暂停、没有积压且关联工作项为 `in_progress` 时直接进入 `submitted`；否则作为草稿排队。兼容的无工作项测试夹具沿用原行为。
- MVP 不提供“立即发送”：Claude 适配器首版不支持执行中途插话，空闲时与普通发送无异，忙时无法实现。

配套接口：

| 方法 | 作用 |
|---|---|
| `session.create` / `session.list` | 创建、列出会话；创建同时写入根工作项和会话 |
| `session.stop` | 停止当前回合并暂停队列，语义沿用 0001“停止与恢复” |
| `session.resumeQueue` | 解除队列暂停 |
| `session.retryMessage` | 对 `unknown` / `rejected` 消息重试：生成新消息 ID，原消息标为 `withdrawn` |
| `session.getTranscript` | 分页读取会话记录 |

`SessionSummary` 包含 `workItemId: string | null`，每次从数据库读取，不再包含 `role`。线上新建会话必须绑定工作项；nullable 只保留存储兼容，理由见 [0002](0002-sqlite-storage.md#会话与运行)。旧 `session.create` 的参数保留；名额不足时工作项为 `todo` 并设置 `waitingSlotSince`，不会因创建会话而绕过全局名额。

核心内部接口 `SessionService.notifyWorkActivated(sessionId: string): void` 用于激活后唤醒待投递工作消息与既有用户草稿；它会重新检查工作项状态。`createSessionService` 可接收 `acquireWorkSlot?: (workItemId: string) => boolean` 和 `releaseWorkSlot?: (workItemId: string) => void`：空间写入失败补偿释放名额，幂等重放不重复申请名额。

## 2. `generation.submit`

调用方：Agent（经 CLI）、界面。界面提交的 Job 不关联会话、回合或回合输入快照（均为 null）。

```ts
params: {
  requestId: string
  kind: 'image' | 'video'
  provider?: string                 // 缺省取用户配置的默认值
  model?: string
  prompt: string
  overrideQuota?: boolean           // 仅界面人工确认后可用，Agent 不允许
  params?: Record<string, unknown>  // 由对应 Provider 的 schema 校验
  inputs?: { slotId: string; revision?: number }[]
  targets?: (
    | { outputIndex: number; kind: 'slot'; slotId: string; expectedRevision?: number }
    | { outputIndex: number; kind: 'new_node'; nearNodeId?: string }
  )[]
}
result: {
  jobId: string
  status: 'queued'
  bindings: {
    bindingId: string
    outputIndex: number
    target: { kind: 'slot'; nodeId: string; slotId: string; expectedRevision: number }
          | { kind: 'new_node'; nearNodeId?: string }
  }[]
}
```

服务端在同一个事务内：

1. 创建 Job，关联当前回合及其输入快照；
2. 解析输入并写入 `job_inputs`：
   - 本回合快照中已有的槽位，沿用快照中的修订；
   - 快照之外的槽位，按 `revision` 或提交时刻的当前修订固定；
   - 之后执行、重试、恢复都只用 `job_inputs`，不再重新取最新；
3. 写入 `delivery_bindings`。`expectedRevision` 缺省取提交时刻的当前修订；
4. 将目标槽位的 `accepted_binding_id` 切换为本次绑定，旧请求失去自动回填资格；
5. 登记事件。

缺省规则：`targets` 缺省时，为每个产物在第一个输入节点旁新建节点；没有输入时放进结果区域。

## 3. `generation.get`

调用方：Agent、界面。

```ts
params: {
  jobId: string
  waitMs?: number                   // 有限等待，上限 30000
}
result: {
  jobId: string
  status: 'queued' | 'running' | 'finalizing' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'
  outputs: {
    outputIndex: number
    assetVersionId: string
    mime: string
    delivery: {
      status: 'pending' | 'delivered' | 'conflict' | 'target_missing'
      nodeId?: string
      slotId?: string
    }
  }[]
  missingOutputIndexes?: number[]   // Job 已结束但没有产物的位置
  recheckable?: true               // unknown 但已有外部任务、可 generation.recheck 继续查询
  error?: { code: string; message: string }
}
```

- 带 `waitMs` 时，状态变化或超时即返回。Agent 需要等待时反复调用；CLI 提供 `vis gen wait` 封装这个循环。
- 工具调用断开不取消 Job。

## 4. `canvas.apply`

调用方：界面、Agent。一次调用是一个操作批次，在一个事务内执行，全部成功或全部不生效。

```ts
params: {
  requestId: string                 // 同时作为 operationId
  description?: string
  ops: (
    | { op: 'node.create'; tempId: string; kind: 'image' | 'video' | 'text'
        x: number; y: number; w: number; h: number
        content?: { text: string } | { assetVersionId: string }; prompt?: string; inputNodeIds?: string[]; generation?: NodeGeneration }
    | { op: 'node.layout'; nodeId: string
        x?: number; y?: number; w?: number; h?: number; z?: number }
    | { op: 'frame.move'; nodeId: string; dx: number; dy: number }
    | { op: 'node.setInputs'; nodeId: string; inputNodeIds: string[] }
    | { op: 'node.setGeneration'; nodeId: string; generation?: NodeGeneration; onlyIfUnset?: boolean }
    | { op: 'node.delete'; nodeId: string }
    | { op: 'slot.setText'; slotId: string; body: string; expectedRevision: number }
    | { op: 'slot.setAsset'; slotId: string; assetVersionId: string; expectedRevision: number }
    | { op: 'slot.clear'; slotId: string; expectedRevision: number }
  )[]
}
result: {
  operationId: string
  idMap: Record<string, string>     // tempId → 节点 ID；槽位 ID 通过 canvas.get 或事件获得
  slotRevisions: Record<string, number>
  eventSeq: number
}
```

- 同一批次内的后续操作可以用 `tempId` 引用新建节点，也可以用 `tempId:main` 引用它的主槽位。
- `node.create.prompt` 仅用于 image/video 节点，提供时额外创建 `prompt` 文本槽位并写入初始修订（允许空字符串）；同批次可用 `tempId:prompt` 引用，后续沿用 `slot.setText` 的修订校验。文本节点携带 prompt 返回 `invalid_params`。所有节点视图的 main 槽位排在前面。
- `node.create.inputNodeIds` 仅可与 `prompt` 一起提供。`node.setInputs` 整替带未删除 `prompt` 槽位的 image/video 节点参考输入，空数组表示清空；按传入顺序去重并排除自身，其他输入必须存在且未删除，否则返回 `not_found`。目标或输入均可用同批次前面创建的 `tempId`。非生成节点返回 `invalid_params`，目标不存在或已删除返回 `not_found`。
- 参考输入存于 `node_inputs(node_id, ordinal, input_node_id)`，主键为 `(node_id, ordinal)`；新建时包含在完整 `node.created` 中，整替时递增 `layoutRevision` 并发送完整 `node.updated`，不修改槽位内容修订。
- 内容修改必须带 `expectedRevision`（先读后写）；布局修改不强制，以最后一次为准。
- `frame.move` 对框及按 `frameId` 递归收集的全部成员统一平移 `dx`、`dy`，保留已有框归属。成员由服务端选择，不需要客户端为每个成员生成 `node.layout`；超过 200 个成员也只是一条操作，用户撤销时整体作为一步。普通 `node.layout` 仍可移动、缩放单个框并重新计算归属，不代替整体平移。
- 任一修订冲突则整批拒绝，返回 `revision_conflict`，`data.conflicts` 给出冲突槽位及当前修订。
- 生成结果因冲突未能自动回填时，用户“手动填入”即一次 `slot.setAsset`，作为新的受校验修改，不恢复旧请求的回填资格。
- `node.delete` 写入墓碑；进行中的生成任务不取消，产物保留为素材（0001“删除与替换”）。

`@vis/canvas-core` 导出 `frameMemberIds(tx: SpaceTx, frameNodeId: string): string[]`，返回框本身及递归的未删除成员；目标不存在或已删除返回 `not_found`，目标不是框返回 `invalid_params`。整体移动使用同一服务端成员选择结果。框不关联工作项，不作为授权边界。

配套只读接口：

| 方法 | 作用 |
|---|---|
| `canvas.get` | 读取当前画布，可按节点筛选；Agent 可传 `snapshot: 'turn'` 读取本回合固定快照 |
| `slot.history` | 按修订号倒序分页读取槽位内容历史与实际生成来源 |
| `asset.get` | 读取素材版本元数据及受控访问地址 |

### `slot.history`

调用方：界面、Agent。只读当前空间内未删除槽位的已持久化修订，不写入事件。

```ts
params: {
  slotId: string
  limit?: number                  // 默认 50，整数范围 1–200
  beforeRevision?: number         // 排他游标，下一页传上一页末条 revision
}
result: {
  versions: {
    revision: number
    content: SlotContent          // 与 SlotView.content 一致，含 empty / text / asset
    createdAt: number             // slot_revisions.created_at
    actor: 'user' | 'agent' | 'system' // operations.actor_kind
    isCurrent: boolean
    source?: {
      jobId: string
      prompt?: string
      provider: string
      model: string
      params: Record<string, unknown>
      inputNodeIds: string[]
    }
  }[]
  hasMore: boolean
}
```

- `versions` 按 `revision` 降序；包含清空修订和空字符串文本，不虚构未持久化的初始修订 0。存在但从未写入内容的空槽返回空数组；槽位或所属节点不存在、已删除时返回 `not_found`。
- `source` 仅从该修订 `operation_id` 对应的生成交付绑定推导；复用同一生成素材的手动写入不继承来源。输入节点沿用当前槽位来源的规则：按任务固定输入 ordinal 去重、排除自身，并保留已删除输入的 ID。
- `prompt` 取任务持久化的 `params.prompt` 字符串（包括空串），缺少字符串时省略；`params` 保留任务实际持久化的完整参数，包括 `prompt`。固定文本输入另存于 `job_inputs` 指向的槽位修订，不读取或拼接当前可编辑提示词。
- 恢复旧文本、素材或清空状态均沿用 `canvas.apply` 的 `slot.setText`、`slot.setAsset` 或 `slot.clear`，携带当前 `expectedRevision` 并产生新修订，保留原历史。

## 5. `events.subscribe`

调用方：仅界面。Agent 不订阅事件。

```ts
params: { spaceId: string; afterSeq?: number }
result:
  | { reset: true; snapshot: SpaceSnapshot; seq: number }
  | { reset: false }

notification 'events.event':     { seq: number; type: string; entityType: string; entityId: string; payload: unknown }
notification 'events.transient': { sessionId: string; itemId: string; revision: number; delta: string }
notification 'events.providersChanged': {}
notification 'events.workInboxChanged': WorkInboxCounts
notification 'events.workSlotsChanged': WorkSlotsView
```

- `afterSeq` 缺省或已过期时，在同一个读事务内返回快照与当前序号，随后推送该序号之后的事件。
- `SpaceSnapshot` 包含 `nodes`、`sessions`、`activeJobs` 和 `workItems`；`workItems` 为当前项目的完整卡片视图。完整会话记录经 `session.getTranscript` 按需读取，工作消息历史经 `work.get` 分页读取。
- 持久事件允许重复投递，客户端按 `seq` 去重。`events.transient` 用于流式文本，不落库，丢失无妨；最终内容以持久化的会话记录条目为准。
- 图片、视频只传引用，内容经 `asset.get` 的受控地址获取。
- `events.providersChanged` 是全局配置变化的瞬时通知，不写空间事件表、不占 `seq`，向已连接的界面推送。客户端收到后或重连后调用 `providers.list`；配置文件是事实来源，通知不承载配置或密钥，也不参与 `afterSeq` 重放。
- `events.workInboxChanged` 直接携带跨项目 `WorkInboxCounts`（`unread`、`unresolved`、`bySpace`），`events.workSlotsChanged` 直接携带全局 `WorkSlotsView`。两者推送给所有已握手的界面连接，不受当前订阅项目限制，不落空间事件表、不参与序号重放。重连须重新读取 `work.inbox` 与 `work.slots`。

MVP 事件类型：

| 范围 | 事件 |
|---|---|
| 画布 | `node.created`、`node.updated`、`node.deleted`、`slot.revised` |
| 会话 | `session.created`、`session.updated`、`message.stateChanged`、`turn.stateChanged`、`transcript.itemUpserted` |
| 生成 | `job.stateChanged`、`binding.stateChanged` |
| 素材 | `asset.versionAdded` |
| 工作项 | `work.itemChanged`、`work.messageAdded`、`work.messageAcked`；确认事件与工作批次回合成功结束同事务登记 |

槽位视图 `SlotView` 可带 `source: { jobId, inputNodeIds }`，仅当前修订由生成交付时存在；输入节点按 ordinal 去重、排除自身，删除的输入仍保留 ID，手动改写后来源消失。

节点视图 `NodeView` 可带 `inputs: string[]`，表示可编辑的参考输入，按设置顺序排列；当前画布与回合快照视图均过滤已删除的输入，过滤后为空时省略该字段。快照内的槽位内容仍固定为快照修订，参考输入与布局一样取当前值。删除输入节点只写墓碑，`node_inputs` 中的引用保留。

`node.created`、`node.updated` 的载荷是完整的节点视图；`slot.revised` 的载荷带节点 ID 与新的槽位视图（`{ nodeId, slotId, revision, slot }`），界面据此直接更新，不必再读一次。`job.stateChanged` 的载荷是 `{ jobId, status, error?, job }`，`job` 为完整的任务视图（含交付目标 `targets`）；`binding.stateChanged` 的载荷是 `{ bindingId, jobId, status, nodeId? }`，`nodeId` 是交付到的节点（新建节点时为新节点）。

`work.itemChanged` 的载荷直接是完整 `WorkItemView`，`work.messageAdded` 的载荷直接是完整 `WorkMessageView`。会话活动、标题或归档变化导致卡片派生字段变化时，也要刷新完整卡片，不能只依靠工作项状态转换事件。

`work.messageAcked` 的载荷为 `{ deliveryId, sessionId, messageIds, ackedAt }`，由批次确认函数在写入首次确认时间的同一事务中登记；幂等确认不重复发出。W1 已提供函数与事件，实际 Agent 回合的调用接线仍属 W2。

## 6. 生成服务配置

完整配置、密钥边界和方舟请求映射见 [0007](0007-generation-providers.md)。

| 方法 | 调用方 | 参数 | 结果 |
|---|---|---|---|
| `providers.list` | 界面、Agent | `{}` | 服务和模型的 ID、名称、媒体类型、参数 JSON Schema、`hasKey`、默认选择；没有密钥 |
| `providers.update` | 界面 | `{ config: ProviderConfig }`，整体替换 | 同 `providers.list` |
| `providers.setKey` | 界面 | `{ providerId, apiKey }` | `{ providerId, hasKey }` |
| `providers.clearKey` | 界面 | `{ providerId }` | `{ providerId, hasKey }` |

后三者均不接受 `requestId`，不会把参数写入 `idempotency_keys`。密钥仅存系统 Keychain；不进入配置、空间库、命令行参数或 Agent 工具。配置与密钥变更成功后推送 `events.providersChanged`。

## 7. 工作项方法（0010 修订）

工作项和消息的完整 schema 位于 `packages/protocol/src/work.ts`，状态转换和交互要求见 [0009](0009-work-items-and-board.md)。以下写请求除 `work.markRead`、全局 `work.setSlotLimit` 外携带 `requestId`；工作项修改的幂等键还绑定调用方身份。共同的 `spaceId?` 仅界面可传，不传时使用当前订阅项目。

| 方法 | 调用方 | 关键参数与结果 |
|---|---|---|
| `work.list` | ui、agent | `{ status?, parentId?, scope? }` → `{ items }`；ui 的 `scope: 'all'` 卡片附 `spaceName` |
| `work.get` | ui、agent | `{ workItemId?, beforeCreatedAt?, limit? }` → `{ item, messages, hasMore }`；Agent 省略 ID 时取自己的工作项 |
| `work.create` | ui | `{ requestId, title, brief?, workDir?, chat?: { agentKind } }` → `{ item, queued }`；普通新建停在 todo，带 chat 时新建会话并申请激活 |
| `work.dispatch` | ui、agent | `{ requestId, parentId?, title, brief, agentKind, activate?, reviewBy? }` → `{ item, queued }`；ui 指定父项，Agent 取自己的根工作项；仅允许一层子项 |
| `work.activate` | ui、agent | `{ requestId, workItemId, expectedRevision?, agentKind? }` → `{ item, queued }`；没有会话且没有已保存 Agent 类型时须指定 agentKind |
| `work.recall` | ui、agent | `{ requestId, workItemId, expectedRevision? }` → `{ items, cancelledJobs: { jobId, providerCancelled }[] }`；父项回收包含未完成子项，排队 todo 则只取消排队 |
| `work.reopen` | ui | `{ requestId, workItemId, expectedRevision?, note? }` → `{ item, queued }` |
| `work.submitReview` | ui | `{ requestId, workItemId, expectedRevision? }` → `WorkItemView` |
| `work.report` | agent（子工作项） | `{ requestId, kind, body, refs? }` → `{ messageId, item }`；不接受 workItemId/spaceId，归属从身份推导 |
| `work.reply` | ui、agent | `{ requestId, workItemId, replyTo?, body, refs? }` → `{ messageId }`；带 replyTo 解决原消息，不带则追加说明 |
| `work.review` | ui、agent | `{ requestId, workItemId, expectedRevision?, decision, feedback? }` → `{ item, queued }`；Agent reject 必须有非空 feedback，用户可省略 |
| `work.update` | ui | `{ requestId, workItemId, expectedRevision, title?, brief?, pinned?, reviewBy? }` → `WorkItemView` |
| `work.markRead` | ui | `{ workItemId }` → `{ marked }`；只改用户收件箱已读时间，不解决提问 |
| `work.changes` | ui | `{ workItemId }` → `{ baselineSeq, changes }`；列出本轮激活基线后本工作项会话的画布变更，按每节点最近 `lastSeq` 降序 |
| `work.inbox` | ui | `{}` → `{ groups, counts }`，始终跨项目，保留未读或未解决消息 |
| `work.slots` | ui | `{}` → `WorkSlotsView`，含全局/各项目占额与等待队列 |
| `work.setSlotLimit` | ui | `{ spaceId?, limit }` → `WorkSlotsView`；1–32，全局不能为 null，项目 null 表示不设项目上限 |

工作项不创建或绑定画框；删除工作项保留全部画布节点。激活、打回、重开遇到名额不足会返回 `queued: true`，工作项保留在 `todo`；这不是请求失败，不能靠重试绕过队列。打回保留原激活基线，排队时保留待处理意见；重开建立新一轮基线。结束父项前检查全部子项均已完成。

Agent 只读自己的工作项和直接子项，只能激活、回收、回复或审阅自己的直接子项；审阅还要求 `reviewBy: 'parent'`。根工作项的任意会话可派发一层子项；只有有父项的工作区会话可报告 `done | question | blocked | escalation`，根项直接回复用户。没有工作项的会话调用 work 写方法返回 `forbidden`。这些检查在网关和工作项服务执行，参数不能指定别的会话身份。

报告与提问投递到父工作项的主会话，回复、打回意见与回收投递到子项主会话；主会话取未归档会话中 `createdAt` 升序的第一个，同时间按 ID 升序。`WorkMessageTo` 为 `parent | child | user`，会话来源只有 `sessionId`，不含角色。所有会话的 vis 工具确认一律自动通过，仍需通过调用方、活动回合、工作区关系、修订号与费用护栏检查。

`WorkItemView.changeCount` 是本轮激活以来，本工作项会话改动的不同节点数；同一节点的提示词和产物只计一次。`WorkChange.lastSeq` 是这些会话本轮在该节点上的最近画布事件序号，`work.changes` 按它降序返回。`FrameView` 只有普通框属性，不含 `workItemId`；`work.deletePlan` 不含画框计数，`work.delete` 不接受 `deleteCanvas`。

状态机、目录与会话关联、持久消息批次、审阅和名额账本沿用 0009；消息表有记录或卡片进入 `in_progress` 不能单独作为 Agent 已启动回合的证据。界面改动的集成与 e2e 验证见 0010。

## 已决定（2026-10-26）

1. Agent 身份由运行时注入令牌确定，不信任参数中的 ID。
2. 生成任务可以引用快照之外的槽位，提交时固定版本，记入 `job_inputs`。
3. 内容修改必须带 `expectedRevision`，布局修改不强制。
4. MVP 不提供“立即发送”，只排队。

## canvas.undo / canvas.redo

仅 `ui` 可调用，参数为 `{ requestId }`；沿用 RPC 幂等机制。成功返回 `{ operationId, description }`，空栈返回 `{ nothing: true }`。

- 每次用户 `canvas.apply`（包括其中所有 ops）为一步。空间库 `undo_entries` 持久化逆操作，同一空间的全部界面连接共享，刷新与重启后仍有效。Agent 操作与生成交付不入栈。
- 撤销最近的 `done`，重做最近撤销的批次；新的用户 apply 清空重做栈。失败或幂等重放不改变栈。
- 创建的逆操作是软删除，删除的逆操作恢复原节点和槽位；布局恢复 x/y/w/h/z，参考输入恢复原列表。槽位内容以新修订写回，修订号始终递增，历史不回退。撤销产生的新修订同步对应历史内容的栈条件，以支持连续撤销与重做。
- 执行前检查受影响节点的删除状态和受影响槽位修订（创建/删除检查节点的所有槽位）。若 Agent 或生成交付修改了槽位，或其他操作删除了节点，返回 `revision_conflict`，整步原子回滚，条目保留且不跳过。复用该错误码，因为失败原因仍是内容/存活状态的并发条件不满足。布局沿用最后写入者优先。
- 每次实际撤销/重做生成 user operation，描述前缀为“撤销：”/“重做：”，发出普通 `node.created`、`node.updated`、`node.deleted`、`slot.revised` 事件；恢复节点沿用原 ID。撤销/重做自身不新增栈条目，不取消或重启生成任务。


## 节点生成设置

`NodeGeneration = { provider?: string; model?: string; params?: Record<string, unknown> }`，通过 `NodeView.generation` 随 `canvas.get`、空间快照及完整节点事件返回。持久化为 `nodes.generation` JSON TEXT；旧库迁移后为 NULL，视图省略该字段。回合快照仍固定槽位内容，生成偏好和布局一样读取当前值。

`node.create.generation` 可初始化偏好；`node.setGeneration` 整体替换，省略 generation 清除。它属于布局类元数据，以最后写入为准，不要求 expectedRevision，递增 layoutRevision，不改槽位修订及生成绑定，发出 node.updated。用户修改进入现有空间撤销/重做栈，Agent 修改不入用户栈；撤销恢复此前设置，沿用布局的最后写入语义。旧浏览器数据迁移可传 onlyIfUnset: true，仅当事务内的 generation 为 NULL 时写入，否则跳过，不产生节点事件或撤销步骤，防止迁移覆盖同时发生的用户修改。

提交生成时每个字段按显式请求 → 主产物（outputIndex 0）slot 目标所属节点的 generation → 全局默认（模型再退到所选服务默认）解析；params 是整个对象替换，不混合不同来源的参数。没有主产物槽位目标时使用全局默认；new_node.nearNodeId 仅为布局提示，不继承其设置。偏好不修改已排队 Job 的服务、模型及参数快照，显式或节点中不存在的服务/模型仍按原校验返回 invalid_params。

## 取消、重新生成与用量

- `generation.cancel({ requestId, jobId }) => JobView`，界面及 Agent 可用；Agent 仅能取消本会话提交的任务。终态再次取消返回 `job_terminal`，同一 requestId 重试仍返回首次回执。
- `cancelled` 是终态。先持久化取消再调用供应商；排队或已明确未接单的重试不再提交。进行中的请求晚到后不得恢复状态或回填槽位。任务视图保留 `cancelRequestedAt` 与 `providerCancelled`；后者为 false 时必须提示“已取消，但服务端可能仍会计费”。取消不是退款承诺。
- `generation.recheck({ requestId, jobId }) => JobView`，界面及 Agent 可用（Agent 限本会话任务）。仅适用于 `recheckable: true` 的 `unknown`（已有外部任务 ID、因查询或下载暂时失败而停下）：Job 回到 running，未交付的绑定恢复 pending，继续查询原外部任务；绝不重新提交，其他任务返回 `invalid_params`。
- `generation.regenerate({ requestId, jobId, overrideQuota? })` 仅界面可用，返回新的排队回执。复用原任务的模型、参数、服务配置与固定输入修订，目标槽位不变；重新接受绑定并用当前槽位修订校验交付，成功结果进入新修订历史。失败、unknown、cancelled 可重新生成，成功可再来一版；unknown 必须先确认“上一次可能已在服务端生成并计费，确定重新生成？”。
- `generation.usage({})` 返回本地日期、全局 image/video 任务数、limits 和今日任务明细（含 spaceId/spaceName）。mock/render 不计入付费。排队受并发限制时 JobView 带 `queueReason: 'concurrency_limit'`。
- 取消与排队状态沿用 `job.stateChanged` 持久广播，所有订阅窗口同步；当前槽位仍接受的失败、未知或取消任务在重连快照中保留，供用户重新生成。
