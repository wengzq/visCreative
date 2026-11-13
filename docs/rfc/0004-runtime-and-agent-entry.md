# 0004 · 运行时生命周期、本机通信与 Agent 入口

状态：已决定（MVP）

日期：2026-10-26

回答 [0001](0001-multi-agent-creative-space.md)“待决定事项”中的“运行与生命周期”，并确定 [0003](0003-core-contracts.md) 所说的传输方式与 Agent 入口。

## 进程结构

```
Electron 主进程 ──┐
                  ├── 本机 socket（JSON-RPC）──▶ studiod ──▶ Claude Agent 子进程
vis CLI（Agent）──┘                              │
                                                 └──▶ 生成服务（Provider）
```

- studiod 是独立进程，不是 Electron 主进程的一部分，这样应用更新时可以继续运行。
- 渲染层不直接连 studiod，经 Electron 主进程转发。

## 生命周期

| 场景 | 行为 |
|---|---|
| 应用更新或重启 | studiod 不退出，Agent 回合与生成任务继续。新应用连上后取快照与游标，进度连续 |
| 用户主动退出，有进行中的工作 | 弹窗：“N 个会话正在运行，M 个生成任务进行中，退出将全部停止”；【退出并停止】/【取消】 |
| 用户主动退出，无进行中的工作 | 直接退出，studiod 一并退出 |
| macOS 关闭窗口 | 应用留在后台，studiod 不受影响 |
| 已有 studiod 时再启动一个 | 新进程启动后第一件事是取 `run/studiod.lock` 上的排他锁，取不到就提示已在运行并以 0 退出，不打开任何数据库。锁由操作系统持有，进程崩溃也会释放，不需要判断残留的 PID 文件 |
| 应用未运行且 studiod 空闲 | 没有界面连接、也没有进行中的工作超过 10 分钟时，studiod 自行退出，避免更新后旧进程长期残留 |

“进行中的工作”指运行中的回合（`turns.status` 为 `running` / `waiting_user`）与未结束的生成任务（`queued` / `running` / `finalizing`）。

“退出并停止”的含义：

- Agent 回合按 0001“停止与恢复”的语义停止，待发队列保留；下次可凭 `agent_resume_id` 恢复会话。
- 生成任务**不取消**：Provider 侧任务继续，studiod 停止推进；下次启动时 runner 从数据库恢复，下载产物并回填（0002、GenerationService 的恢复路径）。已经付费的生成不会丢失。

### 版本兼容

应用更新后，后台仍是旧版本的 studiod。握手时比较协议版本：

- 兼容：直接复用。
- 不兼容：提示用户后让旧 studiod 按“退出并停止”关闭，再启动新版本。回合被打断，生成任务自动恢复。

## 本机通信

| 项目 | MVP 方案 |
|---|---|
| 传输 | macOS / Linux：Unix domain socket，`<应用数据目录>/run/studiod.sock`；Windows：命名管道 |
| 分帧 | 换行分隔的 JSON（NDJSON），每行一条 JSON-RPC 2.0 消息 |
| 单实例 | studiod 启动时持有 `run/studiod.lock`；socket 已被占用且握手成功则不再启动 |
| 启动 | Electron 主进程连接失败时以 detached 方式启动 studiod（`ELECTRON_RUN_AS_NODE=1`），输出写入日志文件 |

### 握手与凭据

每个连接的第一条请求必须是 `runtime.hello`，否则断开：

```ts
params: {
  protocolVersion: number
  credential: { kind: 'ui'; token: string } | { kind: 'agent'; token: string }
}
result: { protocolVersion: number; studiodVersion: string; runtimeEpoch: string }
```

| 凭据 | 来源 | 得到的身份 |
|---|---|---|
| `ui` | studiod 启动时生成随机令牌，写入 `run/studiod.token`（权限 0600），Electron 主进程读取 | 用户 |
| `agent` | studiod 启动 Agent 时生成，经环境变量 `VIS_AGENT_TOKEN` 注入；库中只存哈希（`agent_instances.token_hash`） | 空间 + 会话 + 运行实例 + 当前回合 |

socket 路径经 `VIS_SOCKET` 注入 Agent 进程。`runtimeEpoch` 每次 studiod 启动时重新生成，客户端发现它变化即重新取快照。

Gateway 的实现约定：

- 运行令牌格式为 `<spaceId>.<随机串>`：前缀只用来定位空间库，校验靠库中的哈希，不依赖进程内状态。
- 每个回合一个运行实例，`turns.instance_id` 指向它。Agent 的每次调用都重新确认实例仍有效且回合仍在进行，否则返回 `forbidden`。`generation.submit` 由此关联会话、回合与输入快照，`canvas.get` 的 `snapshot: 'turn'` 也由此读取。
- 界面连接打开哪个空间由 `events.subscribe` 的 `spaceId` 决定；订阅前调用空间内方法返回 `busy`。
- 协议版本不一致：界面连接握手成功，但只能调用 `runtime.shutdown`，供新版本应用关闭旧 studiod；Agent 连接直接拒绝。
- 持久事件在每次请求处理后推送，另有 100ms 兜底轮询，覆盖生成任务、Agent 事件等不经请求的写入。

### 运行时方法（补充 0003）

| 方法 | 调用方 | 作用 |
|---|---|---|
| `runtime.hello` | 全部 | 握手 |
| `runtime.activity` | ui | 返回进行中的回合数与生成任务数，用于退出确认 |
| `runtime.shutdown` | ui | 按“退出并停止”关闭 studiod |
| `capabilities.list` / `capabilities.describe` | agent | 列出 Agent 可用能力 / 返回某个能力的说明与参数 JSON Schema |

## Agent 入口：CLI

Agent 通过 `vis` 命令行工具操作空间。Claude 用自带的 Bash 工具调用它。

- `vis` 是薄客户端：解析参数、发 RPC、以 JSON 输出结果；错误时输出 `{ "error": { "code", "message" } }` 并以非零码退出。
- 启动 Agent 时把 `Bash(vis:*)` 加入允许列表，避免每次调用都弹权限确认。
- Skill 只教创作流程；具体能力由 `vis describe` 运行时查询，新增能力不需要改 Skill。

### 能力表是唯一来源

`packages/protocol` 中的 `METHODS` 登记每个方法的参数 schema、返回 schema、允许的调用方，并补充给 Agent 看的说明。以下内容都从它生成，新增能力只需登记一次：

- CLI 子命令（`canvas.get` → `vis canvas get`）
- `capabilities.list` / `capabilities.describe` 的输出（参数 schema 由 zod 转为 JSON Schema）
- 以后若需要：Claude SDK 进程内工具、MCP 工具

MVP 只实现 CLI 一种入口。以后接入其他 Agent，或者新增能力，都不需要改业务服务。

## Claude 适配器（MVP）

参考 Orca（1.4.197 源码静态阅读）：Orca 用 `@anthropic-ai/claude-agent-sdk`，每个会话一个常驻 Claude 进程，经 SDK 流式输入投递消息，并自行启动子进程以掌握进程号与退出确认；仅 `src/main/claude/` 就约 1.1 万行，大部分用于 MVP 不需要的能力（子 Agent、后台任务、TUI 恢复、rewind、多账号、Windows 进程树、超时后的投递对账）。

MVP 采用更简单的方案：

| 项目 | MVP 方案 |
|---|---|
| 进程模式 | 每个回合调用一次 SDK，带 `resume`（`sessions.agent_resume_id`）恢复上下文；回合结束进程退出 |
| 投递确认 | 收到本次调用的初始化消息即视为 Agent 已接管；在此之前启动失败判定 `rejected` |
| 中断 | 中止本次调用 |
| 进程退出 | 回合未正常结束即判定 `interrupted` |
| 工具权限 | 允许 `Bash(vis:*)` 与只读工具（Read / Glob / Grep）；其他工具默认拒绝。MVP 不做工具审批界面，因此不会出现 `waiting_user` |

> Note ([RFC 0048](0048-agent-native-capabilities.md), 2026-11-12): this tool list is a gap of an adapter that is not yet wired into studiod and runs without the shared sandbox, not a decision about what Claude may do. Before wiring it, launch it through `prepareSandbox`, route tool permissions through the shared approval path, and only then widen `tools` to its native set.

代价是每回合多 1–2 秒启动时间、不支持中途插话；MVP 本就不提供“立即发送”。SessionService 只经 `AgentRuntimePort`（`ensureReady` / `dispatchTurn` / `interruptTurn`）与运行时交互，以后升级为常驻进程只需替换适配器实现。


## 工作消息队列（0009）

工作消息复用 `SessionService` 的串行队列。出队只在会话空闲、未暂停、未归档且工作项进行中时执行；已有普通草稿先执行，真正开始工作回合时将所有未领取消息合并为一个批次。`messages.work_delivery_id` 记录持久批次关联，队列入库与领取在同一事务完成；每次重试仍使用新消息和新回合，但沿用批次 ID。

开始固定快照时整批记 `delivered_at`；回合成功结束时整批 ack 并写 `work.messageAcked`。失败（含非用户停止的进程意外退出）最多自动重投一次，消息头带「重新投递」。启动失败同样只自动重试一次；投递结果 unknown 暂停等待处理。重启恢复未确认批次，但保留用户主动停止的队列暂停；普通消息 unknown 仍不自动重发。手动重试工作消息保留批次关联，成功后确认原批次。

停止期间不能将异步就绪后的旧回合继续交给 Agent；若运行实例尚未创建，由会话服务直接收尾回合，避免永久占据 activeTurn。回收工作项暂停投递并中断当前回合，重新激活也不能绕过旧回合的停止围栏。

每次工作项投递附带 `workContext: { workItemId, parentId, hasChildren }`，Codex / dsh / Claude 使用统一协作说明，再按根项或子项补充派发与报告事实。模型说明不替代网关按调用方、所属项目、活动回合和工作区父子关系执行的权限检查。所有会话（包括没有工作项的会话）的 vis 工具确认都自动通过；其他命令和文件审批保留原有边界。
