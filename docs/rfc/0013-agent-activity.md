# 0013 · 会话区显示 Agent 正在做什么

状态：已实现并验证（2026-10-29）

日期：2026-10-29

基于 [0004](0004-runtime-and-agent-entry.md)、[0005](0005-agent-adapters-and-mcp.md) 与 [0010](0010-workspaces-without-canvas-binding.md)。

## 背景

维护者反馈：会话区感知不到模型在做什么，Agent 像一个沉默的干活工具，用 DeepSeek 时尤其明显。原因有三层：

1. **思考被丢弃。**dsh 会发 `agent_thought_chunk`，翻译层直接忽略（测试还断言了这一点）；Codex 的 `reasoning` 条目也没接。DeepSeek 推理模型常常先想很久，这段时间会话区一片空白。
2. **只显示完成的条目。**一段话说完、一次工具调用结束才上屏。Codex 的回复已有流式增量（`TransientEvent`），dsh 本身不发增量。
3. **运行中没有状态。**唯一的变化是发送键变成停止键；看不到在想、在调用什么、跑了多久。工具名显示原始名称，如 `mcp__vis__canvas_get`。

dsh 的逐字流式输出由 dsh 决定，本 RFC 不处理。

## 决定

### 1. 新增两种会话条目：思考与计划

`TranscriptItem.kind` 增加 `reasoning` 与 `plan`（storage 的 TS 枚举同步；SQLite 无 CHECK 约束，`db:generate` 应无迁移）。`AgentEvent` 的 `item` 可以上报这两种。

| kind | payload | 说明 |
|---|---|---|
| `reasoning` | `{ text: string }` | 思考内容，Markdown。超过 20 000 字时只保留开头 2 000 字与结尾 18 000 字，中间以「…（已省略）…」连接 |
| `plan` | `{ entries: { text: string; status: 'pending' \| 'in_progress' \| 'completed' }[]; explanation?: string }` | 每个回合一条，itemId 固定，计划每次更新时整体替换、修订号递增 |

思考是否结束、用了多久不存字段，由界面推出：同一回合里思考条目之后出现了别的条目，或回合已结束，即视为结束；时长取 `updatedAt - createdAt`，至少显示 1 秒。

**DeepSeek（ACP）**
- `agent_thought_chunk`：按 messageId 累加到条目 `ds:<acp>:<messageId>:thought`，修订号递增；与 `agent_message_chunk` 的条目分开。
- `plan`：`entries[].content` → `text`，`status` 原样（ACP 为 `pending` / `in_progress` / `completed`）；条目 `ds:<acp>:<turnId>:plan`。
- 更新原 `adapter.test.ts` 里「思考不进会话」的断言。

**Codex（app-server）**
- `reasoning` 条目完成时：`summary` 数组以空行连接为文本；摘要为空时用 `content`。条目 `cx:<turn>:<item>`：`item/started` 时先以空文本上报（修订 1），使 `createdAt` 与排序取开始时刻，完成时写入文本（修订 2）；都为空时保留空文本条目，界面显示「思考了 Ns」且不可展开。
- 推理摘要的流式增量（`item/reasoning/summaryTextDelta` 等）经现有 `TransientEvent` 推给界面，itemId 与完成条目一致，完成时以落库内容为准。
- `turn/plan/updated`：`plan[].step` → `text`；`status` 的 `inProgress` → `in_progress`；`explanation` 原样；条目 `cx:<turn>:plan`。
- 推理摘要是否默认开启要按 Codex 当前版本核对；没开就在启动参数里开启摘要（只开摘要，不改推理强度）。事件名与字段以本机安装的 Codex 版本为准，实现前核对，写进 0005。

### 2. 运行状态行

会话进行中（`activeTurnId` 非空），在记录末尾、输入框上方显示一行状态，所有 Agent 通用，纯界面推导：

| 当前回合最后一个条目 | 文案 |
|---|---|
| 没有 / 用户消息 / 思考中 / 工具结果 | 正在思考… |
| 未完成的工具调用 | 正在{工具动作}…，如「正在读取画布…」 |
| 回复文字（含流式） | 正在回复… |
| 待处理的审批 | 等待你确认 |

- 右侧显示本回合已用时间（`12s`、`1m 05s`），起点为本回合第一条记录的 `createdAt`，每秒刷新。
- 有计划时追加进度，例如「正在读取画布… · 计划 2/5」。
- 排队等执行名额时沿用现有排队提示，不重复显示。
- 文字前一个小的活动指示点；`prefers-reduced-motion` 下不动。
- 作为 `role="status"` 的区域，只在文案类别变化时更新可读文本，计时不触发朗读。

### 3. 思考块

- 进行中：展开，标题「思考中 · 12s」，正文只显示最新两行（超出部分渐隐），不抢占记录区高度。
- 结束后：自动折叠为「思考了 18s」，点开看全文（Markdown，关闭原始 HTML，与回复一致）。用户手动展开或折叠后不再自动改变。
- 同一回合多段思考各自成块。

### 4. 计划清单

- 显示为一张小卡片：标题「计划 2/5」，条目前用图标区分未开始、进行中、已完成；进行中的条目加粗。
- 位置在该回合第一次出现计划的地方，后续更新原地刷新。回合结束后保留最终状态。

### 5. 工具名友好化

协议导出 `toolLabel(name: string): string | undefined`：去掉 `mcp__vis__` / `vis.` 前缀，按 MCP 工具名规则（`toolNameOf`）反查方法，返回方法的 `summary`（例如「读取画布」）。查不到返回 `undefined`，界面显示原名。工具组摘要与状态行都用它。`toolNameOf` 的规则如需移到协议包，保持 CLI 行为不变。

## 不做

- dsh 的逐字流式输出。
- 显示 token 用量、费用。
- 修改推理强度或模型参数。

## 验收

- `pnpm check` 通过；`pnpm build` 后完整 e2e 连续两轮通过。
- 单元测试：dsh 的思考与计划翻译、修订号递增与幂等；Codex 的推理摘要（含摘要为空回退 content）与计划翻译；`toolLabel` 对两种前缀与未知工具；思考截断规则；状态行文案推导。
- e2e（fake Codex 发出推理与计划事件）：回合进行中显示「正在思考…」与计时；思考块进行中展开、结束后折叠为「思考了 Ns」；计划卡片进度随更新变化；工具组显示中文动作名。
- 两份 README（中英）与路线图更新；0005 补适配器事件对照。
