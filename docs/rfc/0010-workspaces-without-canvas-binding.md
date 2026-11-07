# 0010 · 工作区不绑定画布，去掉 Agent 角色，会话面板简化

状态：已实现并验证（2026-10-29）

日期：2026-10-28

修订 [0009](0009-work-items-and-board.md) 与 [0009-ui-spec](0009-ui-spec.md)。与本文冲突的 0009 条目以本文为准，实现时同步改掉 0009 的对应段落。

## 背景

0009 让每个工作项在画布上有一个框，Agent 默认只写自己的框，写框外要审批；侧栏、看板、审阅、删除都围绕这个框展开。用下来有两个问题：

- **归属不对**。画布上的资产属于项目，不属于某个 Agent 或工作区。一张图先由镜头 1 的 Agent 生成，再被总导演拿去改，再被另一个工作区引用，是常态。按框划地盘，让「谁能改这张图」取决于它碰巧放在哪个框里。
- **角色是多余的管控**。协调者 / 执行者 / 普通对话三种角色各有一套权限、提示词和确认规则，用户还要理解「执行者 1/6」「升级为协调者」。父子关系本来就由工作区层级表达；真正需要守住的是安全与成本边界，与角色无关。
- **面板太复杂**。右侧面板同时维护四份「当前」状态（App 的活动会话、面板展开的会话、高亮的卡片、画布选中），靠事件互相同步。点卡片缩放到框 → 画布选中框 → 面板被收回工作区树，就是这样出的问题。

## 决定

**画布和资产属于项目；工作区只描述「谁在做什么」，Agent 属于工作区。**工作区与画布之间不再有绑定，只保留「谁改过什么」的历史记录。

**工作区里的 Agent 会话不再分角色**，都是同一种会话；关系只看工作区的父子层级。

## 去掉的

- 工作区的画布框：派发 / 新建时自动建框、「为它画一个框」、`WorkItemView.frameNodeId`、`work.create` / `work.dispatch` / `work.update` 的 `frame` 参数与 `FramePlacement`、框节点上的 `workItemId`、画布框标题栏上的工作项状态与 Agent 头像（`frameInfo`）。
- 按框的写入范围：worker 只能写自己框内、协调者写进行中的子框需审批、生成回填按框检查（`canvas-scope`），以及审批类型 `canvas_outside_frame`。
- 删除确认里的「同时删除画布框和框里的 N 个节点」与 `work.delete` 的 `deleteCanvas`；`work.deletePlan` 不再返回 `frameNodeCount`。
- 点卡片缩放画布。
- Agent 角色说明里关于框的段落（只能写自己的框、写框外需审批）。

**框**作为画布上整理内容的普通节点照常保留（`frame.create` / `frame.move` / `frame.update`），用户和 Agent 都可以用，只是不属于任何工作区。

## 保留并改用历史记录的

「这一轮这个工作区的 Agent 改了哪些节点」是历史，不是归属，审阅需要它。来源统一为：本轮激活（`activation_seq`）以来，该工作区的会话产生的画布事件。

- **审阅抽屉「产物变更」**：不变，本来就按会话的改动计算。
- **看板卡片缩略图**：从「框内最近的图」改为「本轮改过的最近 2 张图片或视频」。按 `work.changes.lastSeq` 降序并按节点去重，跳过已删除、缺失及当前没有产物的节点，取最近 2 个可显示产物；按工作项 `revision` 缓存，只在当前项目看板显示时加载。全部项目的紧凑卡片沿用不显示缩略图的布局，不为此跨项目读取画布。
- **卡片底部**：`框内 N 个节点` / `未绑定画布框` 改为 `本轮改动 N 处`（按节点计，同一节点的提示词和产物算一处）；没有改动时不显示。
- **在画布中定位**：定位到本轮改过的节点（画布缩放到包住它们的范围并选中）；没有改动时不显示这个操作。已删除的节点仍计入本轮改动数，定位仅选中和缩放到仍在画布中的节点；全部已删除时提示节点已不在画布中。由用户主动点，不在点卡片时自动发生。

## 去掉 Agent 角色

去掉 `SessionRole`（`coordinator` / `worker` / `chat`）及一切按角色的分支，包括 `methods.ts` 的 `agentRoles`、「第一次派发升级为协调者」、按角色区分的提示词与自动确认。一个 Agent 会话能做什么，只由**它所在的工作区**和**操作对象**决定。未关联工作项的兼容会话调用工作项写方法返回 `forbidden`：

| 操作 | 谁能做 |
|---|---|
| 派发 / 激活 / 回收 / 回复 / 审阅子工作区 | 任何会话，对象是**本工作区的直接子项** |
| 派发新的子工作区 | 本工作区是根工作区时（只派一层，按数据判断，不按身份） |
| 报告（`done` / `question` / `blocked` / `escalation`） | 本工作区**有父项**时，发给父工作区；根工作区不报告，直接对用户说 |
| 改自己的工作区（送审等） | 任何会话，按状态机箭头 |

- **消息投递**：发给父工作区的报告、提问送到父工作区的**主会话**（第一个未归档的会话，按 `createdAt` 升序，同时间按 ID 升序）；发给子工作区的回复、打回意见、回收送到子工作区的主会话。`WorkMessageTo` 改为 `parent` / `child` / `user`，具体会话由 `targetSessionId` 记录。
- **审阅人**：`ReviewBy` 的 `coordinator` 改名为 `parent`（由上级工作区审阅），界面文案「由上级审阅」。
- **工具确认**：所有会话（包括未关联工作项的会话）的 vis 工具调用一律自动确认；其他命令和文件审批保留原规则。保护来自画布修订号、历史与撤销，以及生成的每日额度与 `requestId` 幂等，而不是逐次确认。
- **提示词**：`prompt.ts` 三份按角色的说明合并为一份；通过 `workContext: { workItemId, parentId, hasChildren }`，按当前工作区是否有父项 / 子项附上「可以派发子工作区」「完成后用 report 告诉上级」等段落（由 studiod 在会话上下文里提供事实，不是授权依据）。
- **界面**：所有「协调者」「执行者」「普通对话」字样去掉。会话标签只写 Agent 名（`Codex`、`DeepSeek`，同名第二个写 `Codex 2`）；顶栏名额「执行者 1/6」改为「运行中 1/6」（悬停：同时运行的 Agent 上限 6，满了会排队），设置里「执行者上限」改为「同时运行上限」；收件箱用 Agent 名加工作区标题；删除确认「Agent 正在工作，删除会先停止它」；审阅「没有完成报告」。「子工作项」保留，它描述的是工作区层级。

**保留不变的边界**（与角色无关）：网关按**调用方**区分用户界面与 Agent，删除、看板任意拖动、手动送审、编辑、设置只有界面能调；Agent 改状态必须走状态机箭头（`invalid_transition`）；Agent 读不到 Provider 密钥、studiod 令牌与数据库；生成按 `requestId` 幂等、受每日额度限制；同时运行名额（默认 6）全局排队。

## 多个 Agent 同时写画布

不再分地盘，只靠现有的修订号校验（[0003](0003-core-contracts.md)）：内容修改带 `expectedRevision`，同一节点后写的收到 `revision_conflict`，必须重新读取再改，不会悄悄覆盖别人的修改。生成回填沿用现有的槽位版本规则。

不加「改了别的工作区本轮改过的节点」之类的提醒，先保持简单；真实使用中出现互相覆盖的抱怨再加。

## 会话面板

以下是界面目标规格；本后端任务不声明这些交互已完成或已通过 e2e。

### 两种状态，一份「当前」

面板只有**列表**和**会话**两种状态，由 App 里唯一的 `openSessionId` 决定：为空显示列表，有值显示该会话。去掉面板自己的 `expandedId`、`expandRequest` 计数，以及 MVP 留下的会话手风琴（`SessionHeader` 的展开、收起）。

- 列表里高亮的卡片由 `openSessionId` 推出（会话所属的工作区），不单独存 `selectedId`。
- **画布选中不改变面板**。删掉「选中工作项框时清空活动会话」和 0009 修复里「忽略定位引起的选中」的补丁。
- 引用、Skill、发送都作用于 `openSessionId`；列表状态下没有输入框。

```
列表                              会话
┌──────────────────────────┐     ┌──────────────────────────┐
│ 我的项目 ⌄          ＋   │     │ ←  镜头 2 · 街角霓虹  ⋯  │
│ 🔍 搜索                   │     │ 进行中 · [DeepSeek] [Codex]│
│ ● 城市晨光 MV  进行中   2 │     │                          │
│   Codex 正在派发…         │     │ ──────────────────────── │
│   ↳ ● 镜头 1  待审阅      │     │  …对话记录…               │
│   ↳ ● 镜头 2  等待回复    │     │                          │
│ ○ 片尾字幕  待办          │     │ [引用] [Skill]            │
│                          │     │ 给 Agent 发消息…          │
└──────────────────────────┘     └──────────────────────────┘
```

### 列表

- 顶部：项目切换、「＋」（新建工作区；只显示 +，悬停或聚焦时提示「开始创作」，可访问名称为「开始创作」）、搜索。去掉「N 个工作区 · N 个运行中」统计行；「打开资产库」移进项目切换菜单。
- 卡片（侧栏版）：状态点、标题、状态标签、未读数、`⋯`；下面一行动态：「Codex 正在…」「等待回复 · {摘要}」「空闲」「排队第 N 位」。子工作项缩进在父卡片下；超过 3 个时默认折叠为「N 子工作项（M 已完成）⌄」（没有已完成的省略括号），折叠行下按活跃度预览未完成子项的前 3 个，每个一行：状态点、标题、简短状态（等你回复 / 运行中 / 待审阅 / 排队第 N 位 / 状态标签）、未读数，点击进入它的主会话；剩下的显示「还有 N 个」，点它或折叠行展开全部未完成子项（沿用 0009 的卡片）；展开后同一位置显示「收起」，连续点两次就是一开一合。折叠与搜索状态由面板保存，进入会话再返回列表时不变。折叠箭头用 SVG，不用 ⌄⌃ 字符（字符无法与文字垂直居中）。活跃度排序：等你回复 > 运行中 > 待审阅 > 排队 > 其余进行中 > 待办，同级按最近活动时间倒序。已完成的（含子项，显示 ↳ 父标题）收在底部「已完成 N」。
- 去掉卡片上的 Agent 行、「N 个 Agent」折叠、悬停快捷按钮、「为它画一个框」、目录行、框内节点数。目录、状态操作、固定、重命名、审阅人、删除都在 `⋯` 菜单里。
- **单击卡片 = 进入它的主会话**：即第一个未归档的会话（按 `createdAt`、ID 升序）。全部会话已归档时打开最近创建的会话，供查看历史；还没有会话的待办打开「选择 Agent」后激活（与看板拖到进行中一致）。

### 会话

- 头部第一行：返回（回到列表）、工作区标题、`⋯`（与卡片同一个菜单）。第二行：状态标签；同一工作区有多个 Agent 时显示 Agent 标签（`DeepSeek`、`Codex`），点击切换 `openSessionId`；只有一个时显示为静态文字。标签按创建时间保留全部会话，已归档的标注「已归档」；打开归档会话时输入框和发送、引用、Skill 操作禁用，只能查看历史。
- 头部的操作按钮：在画布中定位（本轮有改动时）、审阅（待审阅时）。
- 正文是对话记录，底部是输入框。**停止不再单独放按钮**：有回合在跑且输入框为空时，发送按钮变为「■ 停止」；输入了内容就恢复为「发送」，消息排在本回合之后（沿用现有消息队列），提示行注明「本回合结束后发出」。

### 收起时

面板收起时只显示**正在运行或在等你回复**的工作区头像，点击展开并进入该工作区的主会话。

### 顶栏与画布

- 「画布 | 看板」切换从顶栏移出，**悬浮在画布上方正中**（切到看板时仍在同一位置），前面带当前项目名：`城市晨光 MV  [画布] [看板]`，让用户看出画布和看板都属于当前项目。⌘⇧B 切换不变。顶栏只留项目名与连接状态、节点统计，以及右侧的今日额度、运行中名额、收件箱和设置。
- **双击画布空白处不再新建文本节点**，避免误触。新建节点只走底部工具栏（文本、生图、生视频、上传）和拖入文件；双击文本节点编辑、双击媒体打开预览不变。顶栏提示改为「拖入图片或视频导入 · 选中后按 Delete 删除」。[0006](0006-web-ui.md) 中「双击空白处仍可新建文本」一句随实现删除。

### 看板

看板卡片保留现在的信息量（父级行、缩略图、等待行、审阅提示、快捷按钮），只按「保留并改用历史记录的」调整缩略图、底部和定位。单击卡片的行为不变：待审阅打开审阅抽屉，其余进入主会话（切到画布、面板进入会话）。

新建项目对话框里可同时选第一个工作区的智能体（Codex、DeepSeek，默认上次的选择），创建后直接进入该工作区的会话；选「暂不创建」则只得到空画布。项目建好后第一个工作区失败时不回滚项目。

体验优化第一批（2026-10-29）：各列等高、占满看板可用高度，列内独立滚动；同一工作区的子项在一列中超过 3 个时折叠为「还有 N 项」，点击展开，滚动后仍可拖动改状态。会话列表、会话头部、选择 Agent 对话框、看板卡片与收件箱显示 Agent 图标（内联 SVG 原创图形：DeepSeek 为鲸鱼），颜色取主题变量。

## 协议变化

- `WorkChange.lastSeq`：本轮该工作区会话在该节点上的最近画布事件序号（包括提示词修改）；只统计该工作区自身会话在当前 `activation_seq` 之后的事件，不以节点的全局最近事件代替。`work.changes` 按 `lastSeq` 降序返回，供缩略图按最近改动排序。

- `work.create` / `work.dispatch` / `work.update`：去掉 `frame`。`FramePlacement` 删除。
- `WorkItemView`：去掉 `frameNodeId`、`frameNodeCount`；新增 `changeCount`（本轮改动的节点数，同 `work.changes` 按节点去重），供卡片底部与「定位」判断。新增 `lastChangeSeq`，为本轮 `WorkChange.lastSeq` 的最大值，无改动时为 `null`；同节点再次修改即使数量不变也会改变该字段，并推进工作项 `revision`。
- `work.deletePlan`：去掉 `frameNodeCount`。`work.delete`：去掉 `deleteCanvas`。
- `FrameView`：去掉 `workItemId`。
- `ApprovalKind`：去掉 `canvas_outside_frame`。已存在的这类待审批记录在迁移时标为已过期。
- `work.list` 去掉已被忽略的 `includeArchived`（PR #6 遗留）。
- 删除 `SessionRole`；会话视图、`workContext`、`work.dispatch` 结果去掉 `role` 与「已是协调者」`notice`；`methods.ts` 去掉 `agentRoles`，Agent 可调的 work 方法按上表在网关里检查工作区关系。
- `WorkMessageTo`：`coordinator` / `worker` / `user` → `parent` / `child` / `user`。`ReviewBy`：`coordinator` → `parent`。

## 迁移

- 升级边界明确记录到 `space.db`：迁移完成时的事件序号与已存在幂等记录的最大 `rowid`；重开数据库不推进边界。历史事件载荷和已有缓存结果不为适配新协议而重写。
- `events.subscribe` 的 `afterSeq` 小于或等于非零升级边界时返回现有 `reset: true` 快照路径；客户端从当前状态重新建立订阅，不重放旧协议载荷。最后一条旧事件的游标也必须重置；边界之后的有效游标仍按原规则增量订阅。空库边界为零时保持原增量行为；尚无新事件时重复重连可能再次返回快照，以保证安全。
- 升级前的幂等请求仍保留方法、指纹和首次执行记录：不同内容仍为 `idempotency_conflict`，同内容默认返回 `request_not_replayable`，明确告知请求已执行、先重新读取当前状态，绝不再次执行原操作。此错误不应自动换新 `requestId` 重试。
- 为保留已经启动的停止/取消流程，`work.recall`、`work.delete` 的内部恢复计划和 `session.stop`、`generation.cancel` 的既有回执继续用于完成收尾；回收响应的工作项视图从当前状态重建，删除仍只返回 ID 与取消结果。恢复计划正常推进完成状态，不改写历史工作项快照或重新执行首次业务修改。

- 现有工作项的框解除绑定，变成普通框，节点不动；`work_items.frame_node_id` 清空后删列（drizzle 迁移）。
- 未决的 `canvas_outside_frame` 审批标为过期，对应回合按拒绝处理。
- 会话授权里按节点放行的框外写入记录一并清理。
- `sessions.role` 及 `sessions_one_coordinator` / `sessions_one_active_worker` 索引删除；`work_messages.from` 的会话来源删除 `role`。
- `work_messages.to` 的 `coordinator` → `parent`、`worker` → `child`，`user` 保留；`work_items.review_by` 的 `coordinator` → `parent`，`user` 保留。未决消息照常投递。
- 框 JSON 删除 `workItemId`；节点、素材、布局和历史内容不删除，`work.delete` 也始终保留画布内容。

## 实施拆分

1. **后端与协议**：合约变化、去掉 `canvas-scope` 与框外审批、去掉 Agent 角色（网关检查改按工作区关系、消息投递、提示词合并、自动确认统一）、`changeCount`、迁移。附单测。
2. **会话面板**：两种状态与单一 `openSessionId`、列表卡片与子项预览、会话头部、输入框里的停止、收起头像栏；删除旧手风琴与画布选中联动。附 e2e。
3. **看板与审阅**：缩略图、底部改动数、定位到改过的节点；删除确认去掉画布选项；顶栏悬浮切换、去掉双击新建、角色字样与「运行中」名额。附 e2e 与截图。

第 2、3 项依赖第 1 项的合约，可以先合并类型定义再并行。

## 已定边界与未决项

- 已定：主会话按未归档会话的 `createdAt`、ID 升序选择；所有会话的 vis 工具确认自动通过，不以是否关联工作项分支。
- 已定：「在画布中定位」先缩放到本轮改过的全部可定位节点；节点很多且分散时暂不裁剪为最近几个，真实使用后再评估。
- 已验证（2026-10-29）：会话面板与看板随 PR #7 合入；完整 e2e 连续两轮通过；维护者已用真实 Agent 跑通多 Agent 协作流程。

## Real-use failure reporting and navigation (2026-11-05)

Terminal delivery failures (after the one automatic work-batch redelivery), failed turns and error-paused queues add one persistent system `failure` work message. Its structured `from.failure` records session, turn, reason and optional detail for localized UI copy. A child targets its parent's first unarchived session ordered by creation time then ID; roots notify the user. If the parent has no reachable session, the retained record stays visible in the user's inbox and can be routed on later parent activation. Failure messages do not require replies. Notification-only batches never generate another failure notification when their own delivery fails.

The message ID is derived from work item plus delivery batch (or ordinary turn), so repeated runtime events/recovery cannot duplicate the same failure. Card views include the current failure reason and show an error state; a later successful turn clears the derived state while retaining history. These JSON protocol additions require no physical SQLite migration (`db:generate` verifies this). Silent-hang timeouts remain out of scope.

Opening a session from an all-projects board card selects its project before loading the session, matching locate/review navigation. The shared navigation counter rejects stale asynchronous clicks.
