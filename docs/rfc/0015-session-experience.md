# 0015 · 会话体验：输入框、权限、历史、拖动与子项

状态：已实现，自动化验收已覆盖；真实 Agent 自动审批验收未记录（2026-11-05）

日期：2026-10-29

基于 [0010](0010-workspaces-without-canvas-binding.md)、[0013](0013-agent-activity.md) 与 [0014](0014-session-model-and-effort.md)。来源：维护者 2026-10-29 提交的体验问题清单（会话区部分）。

## 背景

功能面铺开后，会话区的日常使用有这些不顺：

1. 对话记录排版不好看，用户消息尤其突兀。
2. 输入框只能引用画布上已有的节点：想让 Agent 看一张画布外的图片，得先导入画布再引用。也没有自动审批模式，每个命令和文件写入都要点确认。
3. 会话记录一次只加载最近一页，往上翻没有继续加载。
4. 把一个工作区改状态只能去看板或用 `⋯` 菜单，不能在会话列表里直接拖到状态上。
5. 新建的工作区不能挪给另一个工作区当子项。
6. 停止一个回合会暂停该会话的发送队列（`queuePaused`），界面没有恢复入口，用户发的下一条消息会一直排队。

## 决定

### 1. 输入框

输入框底部一行放三个图标按钮，都有可访问名称和悬停提示（草图见 `优化项/会话框组件摆放.png`）：

| 按钮 | 作用 |
|---|---|
| **＋** 导入资源 | 从本机选择图片、视频或音频，直接作为这条消息的附件，**不放上画布**。也可以把文件拖进输入框或粘贴。 |
| **Skill** | 现有 Skill 选择器，不变；输入 `/` 仍可唤出。 |
| **权限** | 显示当前权限模式，点开切换（见 2）。 |

引用画布内容改为在输入框里输入 `@`：弹出画布节点列表（画布上选中的排在前面，框不列出），继续输入按名称过滤，上下键选择、回车引用，引用后去掉输入框里的 `@词`。每一项带缩略图，写出文本开头或「类别＋类型」以及所在框，当前高亮项在列表上方显示大预览，方便分辨长得相似的节点；按名称、类别或框名都能过滤。原来的「引用选中的节点」按钮去掉；画布右键菜单「作为参考发给 Agent」保留。0014 的模型与思考强度按钮属于整个会话，放在输入框上方，「下一回合生效」提示跟在它旁边。工具行放不下时换行，不收进 `⋯`。（维护者 2026-10-30 反馈。）

**导入资源的流程**（2026-10-29 维护者确认：＋ 是导入画布外的资源，不是引用画布节点）：

- 选中的文件走现有 `asset.import` 登记为项目素材（不建画布节点，按 `requestId` 幂等、同内容去重）。登记完成前发送键禁用，失败时附件显示错误并可移除。
- 输入框上方显示附件缩略图（与节点引用同一行，图标区分「画布节点」与「附件」），可移除。
- 契约：`MessageRef` 由「只有 `nodeId`」改为两种之一：现有的节点引用，或新增的 `{ assetVersionId }` 素材引用。旧消息只有节点引用，解析不变。
- 发给 Agent 时，素材引用写进提示词：素材 ID、类型、文件名，以及项目 assets 目录里的绝对路径（Agent 本来就能读这个目录）。每次投递把素材复制到项目 assets 下的新子目录，不把私有存储路径给 Agent；重复发送会多占磁盘，暂不自动清理。Agent 需要时可以用 `asset.get` 读取，或自己用 `canvas.apply` 把它放上画布。
- 会话记录里的用户消息显示附件缩略图，点击打开预览。
- 文件类型与大小沿用 `asset.import` 的限制；不支持的类型在选择时就提示。

### 2. 权限模式与自动审批

`SessionSummary` 增加 `approvalMode: 'ask' | 'auto'`，默认 `ask`（与现在一致）。服务端输出总是带上该字段；旧事件与旧幂等结果没有它，契约里为可选，界面把缺省当作 `ask`（web 端不经过 zod 解析，所以不靠 `.default()`）；新增 ui 专用方法 `session.setApprovalMode`（按 `requestId` 幂等），Agent 不能改自己的权限模式。

`auto` 的含义被刻意收窄：

- **自动放行**：审批类型为 `command` 与 `file_write`，且路径在该会话的工作目录与项目目录之内。每次放行仍在会话里留一条记录（能看到放行了什么）。
- **仍然询问**：`network`、`other`，以及路径超出工作目录的写入。路径按规范化后的绝对路径判断（处理 `..` 与符号链接）；适配器给不出完整、可信的目标路径时（例如 dsh 只给出通用位置、附加命令授权、stdin 续写）一律询问。
- **不变**：沙箱、`vis` 工具的自动确认、钥匙串与凭据文件不可读、费用与每日上限、网关里的权限检查。自动审批只替用户点「允许」，不放宽任何一道硬规则。

切到 `auto` 时需要一次确认（说明上面三条），之后同一浏览器不再重复确认。回合运行中可以切换，从下一条审批请求开始生效。

已确认（2026-10-29）：按上面的范围收窄，不做「全部放行」。

> Revised by [RFC 0048](0048-agent-native-capabilities.md) (2026-11-12): in `auto`, a `network` request from an Agent's own read-only web search or fetch tool (ACP `fetch` kind) is auto-approved and recorded. Other `network` requests still ask.

### 3. 对话排版

先出样式对比再定，不在 RFC 里拍板。会出三版静态截图（1600×1000，deviceScaleFactor 2），同一段真实对话：

- **A · 气泡**：用户消息靠右、浅底色气泡，Agent 回复靠左、无底色。
- **B · 轻分隔**：不用气泡，用户消息左侧加强调色竖线与小标题「你」，Agent 回复保持原样，回合之间加细分隔线。
- **C · 卡片回合**：每个回合一张卡片，顶部是用户消息（弱化背景），下面是该回合的思考、工具和回复。

共同要求：字号层级收敛（正文一个字号，元信息小一号），回合间距大于条目间距，长消息完整显示，不折叠，不改动 0013 的思考块、计划卡片和状态行。

已确认（2026-10-30）：采用 **B · 轻分隔**。气泡在长消息时右侧过窄；卡片回合里计划卡片再套一层框，层级过重。

### 4. 上划加载历史

后端 `session.getTranscript` 已支持 `beforeSeq` 与 `hasMore`。界面改为：滚动到记录顶部附近（约一屏）时请求更早一页，加载中顶部显示「加载更早的记录…」，加载完成后保持用户看到的位置不跳动；`hasMore` 为 false 时显示「已到最早」。到达顶部时再上划一次才触发，避免打开会话时误连续加载。同一页并发请求要去重，切换会话时取消旧请求。

### 5. 拖动工作区到看板状态

在会话列表里开始拖动一个工作区卡片时：

- 画布区域上方展开「看板状态条」：四个投放区（待办、进行中、待审阅、已完成），从会话面板左侧滑出，宽度铺满画布；拖动结束或取消后收回。
- 放到某个状态上即调用现有 `work.move`，不要求理由或确认（0009/0010 的既有规则）。目标是进行中而没有执行名额时照常排队。
- 工作区仍有运行中的回合时，放下后显示与现在相同的提示（只改状态，不停止 Agent）。
- 键盘与无障碍：`⋯` 菜单里已有「移到…」，保持可用；投放区带 `aria-label`，拖动用 `aria-grabbed`/实时提示播报。动画遵守 `prefers-reduced-motion`。
- 看板视图下已有的卡片拖动不变。

### 6. 挪动子项

新增 ui 专用方法：

```ts
'work.reparent': {
  params: { requestId, workItemId, parentId: string | null }
  result: { item: WorkItemView; oldParentId: string | null }
}
```

规则（沿用「只有根工作项能有子项」）：

- `parentId` 必须是同一项目里的**根**工作项（未归档），不能是它自己；`null` 表示变回根。
- 被挪动的工作项必须**没有子项**（否则会出现三层）；已归档的子项也算。
- 挪动不改变状态，不停止运行中的回合，不取消生成。
- 之后的回报按新父项路由（路由本来就是实时按关系算的）；已经送达老父项的消息留在原处，仍未确认的回报改投新父项的主会话。需要在实现里确认这一点并写测试。
- 权限随关系变化：旧父项失去对它的派发相关权限，新父项获得。发出现有的 `work.itemChanged` 事件（受影响的工作项都会递增 `revision`），所有窗口刷新。
- 违反规则返回 `invalid_params`，附原因（例如「它还有子项」）。

界面入口：会话列表里把卡片拖到另一个根卡片上，或 `⋯` 菜单「移到…」→「作为子项移到…」；已是子项的卡片菜单里有「移出为独立工作区」。

### 7. 恢复发送队列

会话头部在 `queuePaused` 且队列非空时显示一条提示：「已暂停，N 条消息等待发送」，带「继续」和「清空」按钮；`继续` 调用现有 `session.resumeQueue`。

为此补两处契约：

- `SessionSummary.queuedMessageCount`：该会话排队中（`draft`）的消息数，刷新后也能准确显示 N；旧事件没有该字段，按 0 处理。
- ui 专用 `session.clearQueue({ requestId, sessionId })` → `{ withdrawnMessageIds }`：撤回用户排队的消息（状态变为 `withdrawn`），按 `requestId` 幂等。工作项投递的回报批次不撤回，避免回报丢失；它们留在队列里，等「继续」后照常投递。清空不改变暂停状态。输入框里直接发送新消息时，如果队列已暂停，也先提示「队列已暂停」并提供「继续并发送」。

## 实施拆分

1. **契约与后端**（我）：`approvalMode` 与 `session.setApprovalMode`、`MessageRef` 的素材引用与提示词、`work.reparent` 的协议、storage 迁移、网关与服务逻辑、适配器的自动放行（Codex 与 dsh）。附单测。
2. **会话面板**：输入框三按钮与附件、对话排版、上划加载、队列恢复提示。
3. **拖动**：看板状态条与列表内拖到根卡片。

第 2、3 项依赖第 1 项的契约，可先合并类型定义再并行。

## 不做

- 全部放行档位。
- 把权限模式做成全局或按 Agent 的默认值（只按会话）。
- Skill 导入（单独处理，见路线图）。
- 把会话拖到画布上或把一个会话移到另一个工作区（只移动工作项）。

## 验收

- `pnpm check` 通过；`pnpm build` 后完整 e2e 连续两轮通过。
- 单元测试：`MessageRef` 两种形态与旧消息解析、素材引用写进提示词、`approvalMode` 默认值与幂等、自动放行范围（command/file_write 在目录内放行、network/other 与越界写入仍询问）、`work.reparent` 的各条规则与回报改投、分页去重与位置保持、拖动目标计算。
- e2e：从＋导入一张图片作为附件发送，画布节点数不变，Agent 收到素材路径；切到自动后命令审批被放行并留下记录；上划加载更早记录且位置不跳；拖卡片到状态条改状态；挪子项后回报进入新父项的会话；暂停后「继续」恢复发送。
- 排版三版截图经维护者选定；两份 README（中英）与路线图更新；0005 补自动放行对照。
- 真实 Codex / dsh 下的自动审批效果验证需要维护者批准。

## Real-use message correction (2026-11-05)

User messages and Agent replies always display in full, without folding, clipping or an expand control. This supersedes the original long-message folding option.

A retained `draft` whose work item has left `in_progress` (unless waiting for an execution slot), or whose session is archived, is shown as “Not sent: work has ended”. The queue explains the reason and offers **Reopen work and send** or the existing confirmed withdrawal action, including for archived sessions. Nothing silently drops the message. `work.reopen` accepts an optional UI-only `resumeSessionId`: it must identify a linked session with an ordinary unsent user draft, restores that session and reactivates the work through the existing slot queue. Without it, the original done-only transition remains. An active turn keeps running; no interruption is added.

Transcript reads enrich user payloads with their persisted `deliveryState`; the UI prefers newer live state events and falls back to that read value after reload. Older payloads without the field remain readable.

## Implementation audit (2026-11-05)

Attachments and scoped automatic approvals are implemented in the protocol, session service and Agent adapters; the separator layout, history pagination, queue resume/clear and work-ended recovery are wired in `SessionPanel.tsx`. Pointer dragging to status targets and reparenting are implemented in `work/WorkTree.tsx` and `WorkStatusDropBar.tsx`. `session-panel.e2e.ts` and the work-service tests cover these paths, including redirecting unacknowledged reports while retaining records already delivered to the old parent.

Pagination deliberately waits for another upward wheel/touch gesture after reaching the top, or the explicit load-history button; it does not prefetch a screen before the top as the original paragraph proposed. Page requests are deduplicated and visible content keeps its position. No implementation step remains open. A real Codex/DeepSeek automatic-approval acceptance run is not recorded here and remains separate from fake-runtime coverage; no real Agent was launched for this audit.
