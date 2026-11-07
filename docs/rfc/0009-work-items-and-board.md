# 0009 · 工作项、多 Agent 派发与看板

> 画布框绑定、按框写入范围与会话面板交互由 [0010](0010-workspaces-without-canvas-binding.md) 修订（实施中），冲突处以 0010 为准。

状态：0009 已实现；0010 后端、协议与迁移实施中，界面改动待集成验证

日期：2026-10-27

补充 [0003](0003-core-contracts.md)、[0005](0005-agent-adapters-and-mcp.md)、[0006](0006-web-ui.md) 和 [0008](0008-projects-and-workspaces.md)。参照 Orca 的工作区看板：同一块画布上多个 Agent 并行工作，由根工作区里的 Agent 派发、接收消息，用户在看板上随时接管。

## 当前实现边界（W1 + W2，0010 修订）

2026-10-28 的 W1 + W2 已落地数据与协议、消息队列投递与 Agent 工具。0010 正在移除会话角色、画框绑定与框外审批，以下描述修订后的后端契约；界面目标规格和验收边界见 [0010](0010-workspaces-without-canvas-binding.md)。

- 激活、派发、回复、打回和重开将持久工作消息交给已有会话队列；空闲时启动回合，忙碌时等待。批次领取与队列入库同事务，`messages.work_delivery_id` 关联每次投递尝试；重投沿用原批次 ID。
- 回合开始整批写 `delivered_at`，成功结束与整批 ack 同事务；失败或重启最多自动重投一次，保留首次投递时间并标记「重新投递」。再次失败保留未确认记录；投递结果 unknown 暂停，用户可重试，重启时恢复未确认工作批次。普通用户消息仍遵循原 unknown 不自动重发规则。
- `SessionService.notifyWorkActivated` 同时唤醒待投递工作消息与既有用户草稿；出队与异步就绪后都检查工作状态和停止围栏。已暂停、已归档或回收中的会话不会继续投递。
- 新激活且尚无会话时创建同一种 Agent 会话，始终关联工作项并遵守名额。根项的任意会话都能派发直接子项；不存在角色升级。
- 画布和资产属于项目；`canvas.apply`、`generation.submit` 与生成回填不再按框检查权限。并发内容修改仍由 `expectedRevision` 与生成绑定版本校验保护。
- 报告发给父项主会话；回复、打回意见与回收发给子项主会话。主会话为第一个未归档会话，按 `createdAt`、ID 升序。
- 所有会话（包括没有工作项的会话）的 vis 工具确认自动通过；其他命令和文件审批保留原规则。无工作项会话调用工作项写方法返回 `forbidden`。
- 假 Agent 回归与真实模型、真实方舟及界面接线是不同的验证范围；本后端任务不声明 0010 的 UI 已验收。

SQL 与协议的 `sessions.work_item_id` / `SessionSummary.workItemId` 暂留 nullable，用于旧的直接插表调用与测试夹具。迁移补齐已有会话，线上 `session.create` 及工作项服务新建会话均强制关联；nullable 是存储兼容安排，不改变本文所属工作项必填的业务约束。

## 目标与非目标

目标：

- 一个项目里可以同时有多个工作项，每个工作项有自己的工作目录和若干 Agent 会话；画布节点和资产属于项目。
- 根工作区里的 Agent 把需求拆成直接子工作项，并可靠地接收子项的完成、提问、阻塞、升级消息。
- 用户在看板（Todo / In progress / In review / Done）上看到全部进度，并可以激活、回收、审阅、打回、回复提问。
- 多个 Agent 写同一块画布时互不覆盖。

非目标（本期不做）：

- 子工作项再派发自己的子项。协调深度固定为一层。
- 跨项目派发、远程机器上的 Agent。
- 一个项目里有多块画布。
- 按工作项的 LLM token 预算。只沿用 [0007](0007-generation-providers.md) 的生成费用护栏。

## 已定的取舍

| 问题 | 决定 |
|---|---|
| 卡片和会话的关系 | 工作项 = 工作区。一个工作项可挂多个不分角色的 Agent 会话，工作目录归工作项所有 |
| 画布冲突 | 画布和资产由项目共享；框只整理内容，并发内容写入用修订号校验 |
| 谁派发 | 根工作项里的任意会话都能派发直接子项；报告发给父项主会话，用户随时接管 |
| 打回 | 工作项退回 In progress，审阅意见作为消息发给子项主会话继续改，产物留在版本历史 |
| 审阅人 | 默认用户；工作项可设为由父工作区审阅 |
| 多个项目 | 一个项目一块画布不变。运行名额全局；收件箱始终跨项目；看板默认当前项目，可切「全部项目」 |

## 数据模型（space.db）

### work_items

| 列 | 说明 |
|---|---|
| `id` | `work_…` |
| `parent_id` | 父工作项；派发的子工作项指向发起会话所在的根工作项。深度最多一层 |
| `title` | 卡片标题 |
| `brief` | 任务说明（Markdown），派发时写入，激活时作为第一条消息发给主会话 |
| `status` | `todo` / `in_progress` / `in_review` / `done` |
| `pinned` | 是否固定在看板顶部，不影响状态 |
| `review_by` | `user`（默认）或 `parent` |
| `work_dir` | 工作目录绝对路径；从 `sessions.work_dir` 迁移过来，同一工作项的会话共享 |
| `created_by` | `{ kind: 'user' } \| { kind: 'agent', sessionId }` |
| `revision` | 每次变更加一，界面和 Agent 修改时用它做乐观校验 |
| `activation_seq` | 最近一次激活或重开时的事件序号；审阅时以它为基线比较改动。打回不重置，审阅看到的是这一轮激活以来的累计改动 |
| `waiting_slot_since` | 激活请求因运行名额已满而排队的时间；为空表示不在排队 |
| `pending_feedback` | 名额满时打回或重开保留的意见待处理状态，默认 false |
| `review_report_id` | 本次 `in_review` 的 done 消息 ID；用户手动送审为 null，离开审阅状态清空，不能复用历史报告 |
| `agent_kind` | 尚未创建会话或排队激活时保存的 Agent 类型；未选择时可空 |
| `status_changed_at`, `created_at`, `archived_at` | 时间戳 |

### sessions 的新列

- `work_item_id`：线上所属工作项必填（迁移时补齐）；W1 SQL 外键与摘要保留 nullable 的兼容理由见“当前实现边界”。
- 不再保存 `role`；一个工作项可关联多个 Agent 会话。主会话从未归档会话中按 `created_at`、ID 升序选择。

`sessions.work_dir` 保留一个版本只读兼容，之后删除。

### work_messages

工作消息是派发与回收的唯一通道，必须持久化，重启不丢。

| 列 | 说明 |
|---|---|
| `id` | `wmsg_…` |
| `work_item_id` | 消息所属工作项（子工作项的消息记在子工作项上） |
| `kind` | `brief` / `done` / `question` / `blocked` / `escalation` / `reply` / `review_feedback` / `recall` / `deleted` |
| `from` | `{ kind: 'user' } \| { kind: 'session', sessionId }` |
| `to` | `parent` / `child` / `user` |
| `body` | Markdown |
| `refs` | 关联的画布节点 ID、素材版本 ID |
| `reply_to` | 回复哪条消息（`reply` 必填） |
| `delivery_id` | 投递批次；同一次注入会话的消息共享一个 |
| `resolved_by` | 仅 `question` / `blocked` / `escalation`：解决它的那条 `reply` |
| `redelivered` | 已开始但尚未确认的批次恢复时标记，默认 false |
| `target_session_id` | W1 内部目标会话外键；路由用途，不向 `WorkMessageView` 暴露 |
| `created_at`, `delivered_at`, `acked_at`, `read_at` | 时间戳；`acked_at` 是 Agent 会话按批次确认，`read_at` 是用户已读 |

### 画布框

新增节点类型 `frame`：

- 有标题、颜色和尺寸，没有槽位。
- 其他节点新增可空列 `frame_id`。创建节点和 `node.layout` 移动节点后，按节点中心点重新计算所属的框。嵌套的框取最内层的那个。
- 删除框不会删除框里的节点，只是把它们的 `frame_id` 清空。
- 框不关联工作项，派发和新建工作项不创建框；用户和 Agent 可单独创建普通框。
- 整体拖动使用 `canvas.apply` 的 `frame.move({ nodeId, dx, dy })` 操作：服务端按 `frame_id` 递归选择全部成员统一平移，包含嵌套框，保留归属；用户撤销按整个拖动作为一步，成员数超过 200 也不要求客户端拆成多批。

整体移动使用 `frameMemberIds(tx: SpaceTx, frameNodeId: string): string[]` 收集框本身与递归未删除成员；它是布局操作，不是权限判断。

## 状态机

```
  todo ──activate──▶ in_progress ──done 报告 / 用户送审──▶ in_review ──approve──▶ done
                      ▲                                    │                     │
                      └──────────── reject（带意见）────────┘                     │
                      ▲                                                          │
                      └──────────────────── reopen（仅用户）──────────────────────┘

  in_progress ──recall──▶ todo
  in_review   ──recall──▶ todo
```

回收适用于 `in_progress` 和 `in_review`；对正在排队的 `todo` 调用 `work.recall` 等于「取消排队」，只清除排队标记。`done` 不回收，要改就重开。

上面的状态机约束的是 **Agent**：工作区里的会话只能沿箭头走。子项报告 `done` 或父项会话审阅通过时，子工作项必须全部是 `done`，否则返回 `invalid_transition` 并列出未完成的子工作项。

**用户不受这些限制**（参照 Orca：看板是用户自己的）。用户可以用 `work.move({ status })` 把工作项移到任意状态，不要求理由，也不检查子工作项；用户的送审、通过同样不检查子工作项，打回的意见可选。

| 转换 | 谁能触发 | 副作用 |
|---|---|---|
| 创建 → `todo` | 用户；根项会话（`work.dispatch` 且 `activate: false`） | 建目录，不创建画框 |
| `todo` → `in_progress`（激活） | 用户；父项会话限直接子项 | 没有会话时新建一个，把 `brief` 投递到主会话 |
| `in_progress` → `in_review` | 子项会话（`work.report` 的 `done`）；用户（`work.submitReview`） | 会话停在空闲，不结束；用户送审时注明“没有完成报告” |
| `in_review` → `done`（通过） | `review_by` 指定的审阅人；用户总可以 | 归档该项会话 |
| `in_review` → `in_progress`（打回） | 同上 | 投递 `review_feedback` 给子项主会话；Agent 必须带意见，用户意见可选，不带时不发消息 |
| `in_progress` / `in_review` → `todo`（回收） | 用户；父项会话限直接子项 | 停止当前回合、取消该项未结束的生成任务，如实返回 `providerCancelled`；保留产物与历史，投递 `recall`，并用它解决未决提问、阻塞和升级。用户回收父项会级联全部未完成子项；排队 `todo` 只取消排队 |
| `done` → `in_progress`（重开） | 用户 | 恢复或新建会话 |
| 任意 → 任意（`work.move`） | 仅用户 | 进入 `in_progress` 时，从 `todo` 同激活、从 `done` 同重开、从 `in_review` 退回并保留审阅基线且不发消息。进入其他状态只改状态、清排队标记和本轮报告；离开进行中释放名额并暂停队列，进入 done 归档会话。**不停止当前回合、不取消生成、不级联子项**；要停下用回收 |

看板拖动一律走 `work.move`，任意两列都可以，不回弹、不弹确认框。

### 删除

回收是「先停下、收回来」，会话和历史都留着，以后接着做。不要了就用**删除**，仅用户可用，Agent 看不到这个工具。删除是唯一需要确认的操作，确认框按实际情况列出会受影响的内容（文案见 [UI 规格 §5.5](0009-ui-spec.md)），不提供撤销。

- **先停再删**：按回收的方式停止该工作项及全部子工作项的回合、取消未结束的生成任务（如实返回 `providerCancelled`），清掉排队标记、释放名额。然后在同一事务里给工作项和子工作项写 `archived_at`，归档它们的会话。
- **级联子工作项**：删除父项一并删除全部子项，不论状态。
- **消息**：被删工作项上未解决的 `question` / `blocked` / `escalation` 以删除结束，之后带 `replyTo` 的回复优先得到 `already_resolved`（先于已删除工作项的 `not_found`），其中 `resolution` 指向 `deleted` 删除记录，界面显示「工作项已删除」；它们不再出现在 `work.inbox` 和计数里。删除子工作项时，向父工作项主会话投递一条 `deleted` 工作消息（「用户删除了子工作项「…」，不要再跟进」）。
- **画布**：全部节点和素材保留，不再提供 `deleteCanvas` 选项。工作项不绑定画框，删除也不产生画布删除操作。
- **工作目录**：不删除，确认框显示路径。
- **之后**：删除的工作项不出现在 `work.list`、看板、侧栏与收件箱；按 ID 调用 `work.*` 返回 `not_found`；归档会话的 Agent 令牌失效。数据保留在 space.db 里，本期没有恢复入口。
- **移除事件**：复用 `work.itemChanged`，`archivedAt` 非空表示移除，界面移除对应卡片；同时更新全局收件箱与名额事件。删除结果的 `workItemIds` 含全部被删项，用于关闭其审阅和会话记录。
- **幂等与恢复**：按 `requestId` 保留删除计划与结果；停止或取消失败可重试，重启先恢复删除再恢复生成调度。关闭确认框后，以新请求重试同一工作项，会接续未完成的删除；重叠的子项删除返回 `busy`。
- **不做版本校验**：确认框打开后状态变了（例如又开始了新的生成），删除照样全部停下，不因状态变化失败。

### 运行名额

- 状态为 `in_progress` 的工作项占一个名额，不论它的 Agent 在忙、空闲还是在等回复。`todo`、`in_review`、`done` 不占。
- **名额是全局的**：studiod 启动时会打开全部项目，后台项目里的 Agent 照常运行，只按项目计算的话，开几个项目就会成倍地起 Agent。所以名额记在 app.db 的 `work_slots`（工作项、项目、占用时间），和生成护栏的 `generation_quota` 一样，在全局写事务里占用和释放。启动时扫描全部项目里 `in_progress` 的工作项，重建占用情况；读取失败就中止启动，不能漏算。
- 默认全局上限 6 个，可以在生成服务设置页的「护栏」里调。另可设单个项目的上限，默认不限。
- 名额满时，激活请求不报错：工作项留在 `todo`，写入 `waiting_slot_since`，卡片显示“等待空位”。有名额空出来时，**跨项目**按 `waiting_slot_since` 先后自动激活。队首所在项目已达到该项目的上限时，跳过它，激活下一个符合条件的工作项，不让一个项目堵住整个队列。
- 名额满时**打回或重开**也走同一个队列：工作项退回 `todo` 并开始排队，`review_feedback` 先存为待投递，激活时和工作项一起交给子项主会话。界面提示“名额已满，已排队”。
- 对排队中的工作项回收（取消排队）或编辑，会清掉排队标记。

所有转换都带 `requestId` 幂等，并接受 `expectedRevision`。不合法的转换返回 `invalid_transition`，并带上当前状态。

## 派发与消息回收

### 投递

- 发给 Agent 会话的消息，进入该会话现有的消息队列（[0004](0004-runtime-and-agent-entry.md)）。会话空闲时立即开始一个新回合；忙碌时排在当前回合之后。多条待投递消息合并成一个回合，共享一个 `delivery_id`。
- 回合真正开始时，按 `delivery_id` 整批写入 `delivered_at`。Agent 处理完、回合结束时，整批写入 `acked_at`。**确认一律按批次，不按单条消息 ID**。Orca 等待脚本踩过的坑：按单条 ID 确认，会重复读到上一轮没确认完的旧消息。
- 回合失败或进程重启时，`delivered_at` 已写而 `acked_at` 为空的批次会重新投递一次，并在消息头标明“重新投递”。
- 发给用户的消息显示在看板卡片和收件箱里，用户这一侧按工作项标记已读（`read_at`），不按批次确认。
- **已读不等于已解决**：卡片角标显示未读数，打开后消失；橙色“等待回复”状态一直保留，直到这条 `question` / `blocked` / `escalation` 被回复或随回收结束（写入 `resolved_by`）。
- `work.inbox` 只返回未读或未解决的消息。界面在收件箱这次打开期间保留刚处理掉的条目，显示“已由你回复”或 `already_resolved` 附带的首次回复，关闭后再打开时才移除。

### 谁能派发与管理子项

根工作区里的任意会话都可以派发直接子工作项；子项不能继续派发，返回 `forbidden`。不再升级角色，也不限制哪个会话负责派发。Agent 只能激活、回收、回复和审阅自己工作区的直接子项，审阅要求 `reviewBy: 'parent'`；用户始终可以接管。

子项只拿到 `brief`、`refs` 和后续工作消息，看不到父项聊天记录。发起者要在 brief 中写清目标、参考节点、范围、交付物和验收条件。工具目录来自调用方能力；工作区关系由网关在调用时检查，不靠提示词授权。生成费用仍受 [0007](0007-generation-providers.md) 的全局护栏约束。

### 父项怎么收到消息

只有有父项的工作区会话能调用 `work.report`；根项直接回复用户。报告投递到父工作区的**主会话**（第一个未归档会话，按 `createdAt`、ID 升序），空闲时自动启动回合，忙碌时排队；不需要轮询或等待脚本。没有可投递主会话时保留消息，用户仍可在收件箱处理。

`question`、`blocked`、`escalation`、`done` 同时供用户的看板角标和收件箱展示。用户与父项会话谁先回复都可以：第一条 `reply` 写入 `resolved_by`，并投递到子项主会话；后续对同一条消息的回复返回 `already_resolved` 并附首次回复。`work.reply` 不带 `replyTo` 时追加说明，不解决其他消息。

### 消息格式（注入会话时）

```
[工作消息 · question · 来自「镜头 3 抽卡」· wmsg_… · 批次 dlv_…]
<body>
关联：node_…, node_…
回复请调用 work.reply（replyTo: wmsg_…）
```

正文中的关联 ID 保留为文本，历史产物被删除不会阻断消息本身的投递。工作消息与已有用户草稿共用串行队列；已有草稿先执行，只有实际开始工作回合时才领取并合并待投递批次。

## 多项目

一个项目仍然只有一块画布，工作项、框、消息都存在各自项目的 space.db 里。跨项目的只有三样东西：运行名额、收件箱、「全部项目」看板。

- **隔离**：Agent 的令牌绑定在自己的会话和项目上。Agent 调用 `work.*`、`canvas.*` 时一律作用于自己的项目，参数里的 `spaceId` 会被拒绝。Agent 不能派发到别的项目，也不能写别的项目的画布。
- **界面跨项目操作**：界面调用 `work.*` 时可以带 `spaceId`，不带就作用于当前项目。这样在收件箱里回复、在全部看板上激活或回收，都不用先切换项目。定位本轮改过的节点、打开审阅抽屉这类需要画布的操作，会先切换到那个项目。
- **全局事件**：`events.workInboxChanged`（未读数、未解决数，按项目汇总）和 `events.workSlotsChanged` 推送给所有界面连接，不受当前选中项目的限制；单个工作项的详细事件仍然只发给打开该项目的连接。
- **后台项目的提醒**：别的项目里有新的提问或阻塞时，铃铛计数增加，项目切换器上对应项目显示橙点。

## RPC

| 方法 | callers | 说明 |
|---|---|---|
| `work.list({ status?, parentId?, scope? })` | ui, agent | 列出工作项和各自的会话摘要、未读消息数。`scope: 'all'` 只有界面能用，返回全部项目的卡片，每张带 `spaceId`、`spaceName` |
| `work.inbox()` | ui | 跨项目收件箱：所有发给用户、未读或未解决的消息，按项目和工作项分组 |
| `work.get({ workItemId })` | ui, agent | 详情和消息历史 |
| `work.create({ title, brief?, workDir? })` | ui | 用户新建根工作项 |
| `work.dispatch({ requestId, title, brief, agentKind, activate? })` | agent（根工作项的任意会话）, ui | 在当前根工作项下建直接子工作项和 Agent 会话，不建框 |
| `work.activate` / `work.recall` | ui；Agent 限自己的直接子工作项 | 见状态机 |
| `work.move({ requestId, workItemId, status, agentKind? })` | ui | 仅用户：移到任意状态，见状态机。返回卡片和是否排队 |
| `work.reopen` | ui | 仅用户 |
| `work.submitReview({ requestId, workItemId })` | ui | 用户手动送审 |
| `work.report({ requestId, kind, body, refs? })` | agent（有父项，限自己的工作项） | `done` 会把工作项推到 `in_review` |
| `work.reply({ requestId, workItemId, replyTo?, body })` | ui, agent（限直接子项） | 回复提问、阻塞或升级；不带 `replyTo` 是追加说明 |
| `work.review({ requestId, workItemId, decision, feedback? })` | ui；`review_by: parent` 时父项会话也可以 | `approve` 或 `reject`；Agent `reject` 必须带意见，用户可不带 |
| `work.update({ workItemId, title?, brief?, pinned?, reviewBy?, expectedRevision })` | ui | 编辑卡片 |
| `work.markRead({ workItemId })` | ui | 把该工作项发给用户的消息标记已读 |
| `work.changes({ workItemId })` | ui | 审阅抽屉：本轮激活以来本项会话的节点变更，按 `lastSeq` 降序 |
| `work.slots()` / `work.setSlotLimit({ spaceId?, limit })` | ui | 读取全局名额与排队；设置全局或单个项目上限 |
| `work.deletePlan({ spaceId?, workItemId })` | ui | 删除确认框用的计数：进行中的回合、未结束的生成任务、子工作项（总数与进行中数）、未解决消息、是否有未审阅的完成报告、是否在排队、工作目录 |
| `work.delete({ requestId, spaceId?, workItemId })` | ui | 仅用户：停止并删除工作项及其子工作项，见“删除”。返回被删项 `workItemIds` 与已取消的生成任务 `cancelledJobs`（含 `providerCancelled`） |

事件：`work.itemChanged`（载荷直接为完整卡片视图）、`work.messageAdded`（载荷直接为完整消息视图）、`work.messageAcked`（`{ deliveryId, sessionId, messageIds, ackedAt }`），所有窗口同步。确认事件在工作批次回合成功结束时登记，与 ack 同一事务。`events.workInboxChanged` 和 `events.workSlotsChanged` 直接携带全局计数与名额视图，向全部界面连接推送；它们不占空间 `seq`，重连后重新读取。

契约以 `packages/protocol/src/work.ts` 为准，Agent 方法由网关按调用方、所属项目、活动回合及工作区关系检查；不存在 `agentRoles`。无工作项或已归档会话不能作为工作项写入身份。

所有会话（含未关联工作项的会话）的 vis 工具确认由适配器自动允许；工具执行仍需通过网关授权与安全、费用护栏。其他命令和文件审批保留原规则。Agent 看不到 `work.create`、`work.update`、`work.markRead`、`work.move`、`work.reopen`、`work.submitReview`、`work.deletePlan`、`work.delete` 等 UI 专属方法。

## 共享画布与改动历史

所有 Agent 可以读写所属项目的共享画布。框不划分权限；内容修改携带 `expectedRevision`，冲突返回 `revision_conflict`，必须重新读取再改。生成回填继续使用槽位绑定版本校验，不再按框检查。

审阅、卡片缩略图和定位的数据来源是当前 `activation_seq` 之后本工作项自身会话的画布事件，不是框内成员。`WorkItemView.changeCount` 按节点去重，同一节点的提示词和产物计一处；`WorkChange.lastSeq` 为这些会话在该节点上的最近事件序号（包括提示词修改），`work.changes` 按它降序返回。

界面使用 `fs.reveal({ workItemId, spaceId? })` 打开工作项实际工作目录，目录不存在时返回 not_found；旧的项目素材目录与会话目录入口保留。

审阅变更 `WorkChange.nodeKind` 取变更历史事件中的节点类型，删除后仍可选择正确的预览。界面可用 `slot.history({ includeDeleted: true })` 读取删除节点/槽位的历史；Agent 传 true 返回 forbidden，默认读取行为仍拒绝删除节点。

## 界面

参照 Orca 的视觉结构，使用我们的暗色主题。布局、交互、文案与边界的定稿见 [0009-ui-spec](0009-ui-spec.md)，与本节冲突时以它为准。

### 侧栏与会话面板

0010 目标规格为列表与会话两种状态，由 App 的单一 `openSessionId` 决定；卡片单击进入主会话，不自动定位画布。列表、子项预览、会话头部与停止交互的完整规格见 [0010](0010-workspaces-without-canvas-binding.md#会话面板)。本后端任务不声明这些界面改动已验收。

### 看板

四列仍为待办、进行中、待审阅、已完成，固定行保留；跨列拖动走 `work.move`，任意两列都能移动，不中断当前回合或生成。跨项目操作仍显式带 `spaceId`；审阅和画布定位先切到对应项目。

0010 的卡片缩略图取本轮改过的最近两张图片或视频，底部显示 `本轮改动 N 处`；定位仅由用户主动点击，缩放到本轮改过的节点。没有改动时隐藏定位。画框仅显示普通框标题，选中框不改变会话面板。

### 审阅抽屉

点开 In review 的卡片会打开右侧抽屉，内容包括：

- 本轮 `done` 报告；用户手动送审时显示「没有完成报告」。
- 这次激活以来，该工作项的会话新增或修改的节点，按修订号列出前后对比。
- 消息历史。

底部有「通过」和「打回」两个按钮。打回意见可选。

### 收件箱

顶栏铃铛**始终跨项目**，显示所有项目里发给用户的未读或未解决消息，按「项目 › 工作项」分组，可以直接在里面回复，不用切换项目。

## 成本与安全

- Agent 的生成照样经过 [0007](0007-generation-providers.md) 的全局护栏。Agent 不能 override。
- 运行名额有全局上限（默认 6 个，见“运行名额”）。超出的激活请求留在 `todo`，并标记“等待空位”。
- 回收不等于没花钱。回收时，已提交的生成任务按取消语义如实标注，`providerCancelled` 为 false 的要提示用户。
- 每个会话沿用 N2/D 的外层沙箱，工作目录是工作项的 `work_dir`。子工作项默认在父目录下的 `workspaces/<子标题>/` 新建，不共享父目录的写权限。
- 消息体可能包含 Agent 输出的 Markdown，界面照旧用 react-markdown，不允许原始 HTML。

## 迁移

0009 为旧会话补建工作项：`work_dir` 从会话复制，归档会话为 done、其他为 in_progress，不自动生成框。旧的 `session.create` 保留，等价于建一个根工作项及 Agent 会话。

0010 删除 `sessions.role`、两个角色唯一索引和 `work_items.frame_node_id`，移除框 JSON 的 `workItemId`，保留全部节点和布局。`review_by: coordinator` → `parent`，消息 `to: coordinator` → `parent`、`worker` → `child`，消息会话来源删除 `role`；未确认消息照常投递。旧 `canvas_outside_frame` 待审批记录过期，对应回合按拒绝处理，旧的按节点放行记录清理。详见 [0010 迁移](0010-workspaces-without-canvas-binding.md#迁移)。

## 与后续功能的衔接

- **镜头节点**：一个镜头可作为工作项模板，生成分镜、参考图和生成节点；普通框可用于整理内容。
- **先低成本抽卡再出终稿**：作为工作项内的两个阶段，抽卡阶段 `done` 后进入审阅，通过后再激活终稿阶段。具体设计另见后续 RFC。
- **配音与配乐**：受“协调深度一层”的限制，音频工作项和镜头工作项并列挂在根工作项下面，用 `refs` 指向对应的镜头节点，而不是挂在镜头下面。

## 实施记录与后续验证

0009 已实现数据、协议、全局名额、消息批次与工作区树、看板、审阅、收件箱。0010 的后端与协议修订及界面任务拆分见 [0010 实施拆分](0010-workspaces-without-canvas-binding.md#实施拆分进行中)；界面集成、完整 e2e 和截图需在相应任务完成后验证。真实 Agent 或真实生成端到端仍需维护者明确批准、隔离数据目录与收紧额度。

## 草图

历史交互草图由 Codex 按 0009 制作（其中画框绑定、角色和越界审批已被 0010 取代）：单个自包含页面，含工作区树、看板（固定行、合法与非法拖动）、嵌套画布框、审阅抽屉、收件箱和越界审批卡。第二轮加入多项目（项目切换、全部项目看板、跨项目收件箱、全局名额自动补位、父项级联回收）。两轮评审中发现的 18 处不清楚或矛盾均已并入本文，第二轮的 6 处是：满额时打回或重开、取消排队、回收与未解决消息、收件箱已处理条目、父项结束的前提、项目上限与全局队列。第一轮的 12 处是：重开仅限用户、用户送审、回收范围与级联、配乐层级、已读与已解决、激活基线、worker 名额、父子并发写、固定与计数、列头 +、`chat` 工作项的推进方式、`already_resolved`。

## 未决项

- 0010 已决定移除角色和框绑定；普通框保留。会话面板与看板目标规格以 0010 为准。
- 收件箱里来自不同工作项的消息，要不要支持一次批量回复。
- 看板要不要显示每个工作项的 LLM 用量。需要适配器上报 token 数，Codex 和 dsh 的上报方式还要确认。
