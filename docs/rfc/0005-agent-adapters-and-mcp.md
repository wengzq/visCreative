# 0005 · 多种 Agent 接入与 MCP 入口

状态：已决定（MVP）

日期：2026-10-26

> Render library follow-up (2026-11-07): the default browser animation library is now MIT-licensed anime.js 4.5.0 at `/lib/anime.js`; GSAP is no longer bundled or a dependency. The seek-only contract remains in seconds, with paused anime.js timelines converting to milliseconds and disabling the automatic main loop. Plain JavaScript is equally supported. Author-managed direct scripts in `<dataDir>/render-libs/` are read at render time with canonical containment checks, reserved built-in names and localized `render.lib_missing` errors. Agents may use these only when the author confirms availability and may not install them. The historical implementation notes below retain their original context.

项目目录、持久工作目录、项目技能和 Agent 本地媒体登记已由 [0008](0008-projects-and-workspaces.md) 补充（2026-10-27）；以下历史实测保留原日期。

调整 [0004](0004-runtime-and-agent-entry.md) 中“只接 Claude”的范围，确定接入顺序与 Agent 获取能力的方式。

## 范围调整

| 项目 | 决定 |
|---|---|
| 接入顺序 | Codex → DeepSeek Harness → Claude。Claude 适配器已实现，真实账号验证放到最后 |
| 桌面端 | 暂不做。先提供开发用命令行客户端：以界面身份连接 studiod，发消息、查看会话记录与画布变化 |
| 会话的 Agent 种类 | `agentKind` 由固定的 `'claude'` 改为 `'codex' \| 'deepseek' \| 'claude'`，在 `session.create` 时指定；studiod 按种类选择适配器 |

## 两种 Agent 的原生接口

参考 Orca 1.4.197 的 Codex 接入与 DeepSeek Harness 源码。

| | Codex | DeepSeek Harness |
|---|---|---|
| 启动 | `codex app-server`，stdio 上的 JSONL JSON-RPC | `dsh --profile acp`，stdio 上的 ACP v1 |
| 握手 | `initialize` → `initialized` | `initialize` |
| 新会话 / 恢复 | `thread/start` / `thread/resume`（带 `threadId`、`cwd`） | `session/new`（绝对路径 `cwd`、可附带 MCP 声明）/ `session/resume` |
| 一轮 | `turn/start`，过程以条目通知推送 | `session/prompt`，过程以 `session/update` 推送 |
| 取消 | 中断当前回合 | `session/cancel` |
| 审批 | 服务端向客户端发请求 | `session/request_permission` |

两者都由客户端回答审批请求，都支持 MCP。

## 能力入口：MCP

Agent 经 MCP 调用空间能力，不再经 Bash 运行 `vis`：

- `vis mcp` 启动一个 stdio MCP server，工具由 `METHODS` 中 Agent 可调用的方法生成（与 CLI、`capabilities.describe` 同源）。
- 凭据仍经 `VIS_SOCKET`、`VIS_AGENT_TOKEN` 注入 MCP server 进程，身份规则不变（0003“调用方身份”）。
- MCP server 由 Agent 进程启动，继承 Codex 的外层 Seatbelt；允许 Unix socket 网络连接，但不可读取同目录的令牌文件。实例令牌仅通过 MCP 配置注入。

### 工作项关系与能力（0010，2026-10-28）

Codex 的 `developerInstructions`、dsh overlay 的 `system-prompt.personaSuffix` 与 Claude 的协作说明统一，不再按角色切换。回合文本带 `workContext: { workItemId, parentId, hasChildren }`，说明当前工作区能否派发以及完成后是否应报告父项；它不是授权依据。画布和资产属于项目，框不划分会话的写入范围。

- 根工作项的任意会话可以派发直接子项，brief 必须包含目标、上下文、范围、交付物和验收条件。子项只拿到 brief、refs 和后续工作消息，不继承父项聊天记录；不能继续派发。
- 子项需要决定、阻塞或升级时调用 `work.report` 并结束回合等待回复，完成报告携带节点与素材版本 refs。报告自动唤醒父项的主会话（第一个未归档会话，按 `createdAt`、ID 升序），不使用轮询或等待脚本；根项直接回复用户，不调用 report。
- 激活、回收、回复和审阅只对当前工作项的直接子项有效；审阅还要求 `reviewBy: 'parent'`。处理消息先读 `resolvedBy`，遇到 `already_resolved` 先读首次回复。遇到 `quota_exceeded` 停止并告诉用户，不绕过护栏。
- `work.*` 的 CLI 命令和 MCP 参数继续由 `METHODS` 生成；有运行凭据时，MCP 的 `tools/list` 读取网关 `capabilities.list`。UI 专属方法不暴露给 Agent，调用时网关继续检查所属项目、活动回合和工作区关系；没有工作项的会话不能执行工作项写方法。离线工具目录不授予权限。
- 所有会话（含未关联工作项的会话）的 vis 工具确认自动通过。Codex / dsh / Claude 的其他命令和文件权限仍按各自原有审批及外层隔离规则处理。

适配器、提示词与工具目录的假进程/假网关回归不等于真实模型遵循了全部协作规则；真实模型和界面验收需单独记录。

## 权限与聊天审批（N2）

- macOS 的 Codex 由 `/usr/bin/sandbox-exec -p <policy> codex app-server` 包裹整个进程树；内层显式 `danger-full-access`，避免嵌套 workspace-write 导致 `sandbox_apply` 失败。外层只允许写会话 cwd、cwd 内 `.vis-tmp`、真实 CODEX_HOME 和 `/dev/null`、`/dev/tty`、`/dev/fd`；允许联网与非敏感目录外读取。所有策略路径解析 realpath。
- 禁止 SecurityServer/securityd/securityd.xpc/security.agent 的 mach lookup，禁止读取 Keychains、`~/.ssh`、`~/.dsh`、数据目录的 `run/`、`providers.json`、`app.db*`、各空间 `space.db*` 及默认 `~/.vis-dev/run`。素材 blobs、派生媒体和旧项目 project/（含 skills）仍可读取，保留 vis 工具返回路径后的看图与技能读取能力；数据库只能经 vis 工具访问。会话 cwd 使用持久化 workDir；数据目录内部只保留 sessions/<id> 与 project/workspaces/<name> 两类旧工作区可写，不能把 spaces 或数据库父目录选成可写工作区。
- 环境仅继承 PATH/HOME/USER/LOGNAME/SHELL/LANG/LC_ALL/LC_CTYPE/TERM；另设 CODEX_HOME、工作区 TMPDIR、`SSL_CERT_FILE=/etc/ssl/cert.pem`。父进程中的供应商密钥和 studiod 令牌不继承。禁止 securityd 后，显式公共 PEM 根证书是登录和 HTTPS 可用的必要条件，绝不关闭 TLS 校验。
- **明确例外**：整个 CODEX_HOME 可读写，包括 Codex 自身登录凭据、配置、hooks 和会话。这个取舍用于兼容真实登录及升级后的运行文件，不代表隔离所有本机凭据；保证范围是生成服务 Key 和 studiod 令牌。hooks 仍继承外层沙箱。无 sandbox-exec、非 macOS、缺 PEM 或危险路径重叠时，退回原生只读模式并在会话显示 notice，拒绝提权审批。
- 外层禁止的目录外写入直接失败，审批不会解除此限制，也不保证 Codex 为它发起审批。Codex/ACP 仍发出的可支持权限请求进入聊天；任务 D 已将同一外层沙箱接到 dsh；隔离成功才开放 shell、写文件和联网，详见文末实测。
- transcript 新增 `approval`，保存 approvalId、kind、summary、detail、可选 cwd、status；状态是 pending/approved/denied/expired。处理结果另保存 decision。界面使用仅 UI 可调用的 `session.respondApproval({ requestId, approvalId, decision })`，三种选择为 allow_once/allow_session/deny。审批卡片不进入工具组，收起会话头通过快照中的 pendingApprovals 显示待审批标记。
- 本会话规则存于该会话已批准的 transcript 条目，重启仍可用。命令与文件类采用保守匹配：kind、完整 detail、cwd 完全一致才自动允许，不把 shell 文本前缀视为安全授权边界；不同参数或格式会重新询问。已识别的 vis 工具确认在所有会话里自动允许；工具本身仍受 gateway 能力、活动回合与工作区关系校验。其他命令和文件审批的按钮 title 说明「仅限完全相同的命令」。原生回复总是单次许可，由应用控制复用，避免原生 session grant 扩大范围。无法填写的 MCP 必填表单、未知请求与缺少单次许可选项都拒绝。
- 停止、回合结束、进程关闭或等待超过 10 分钟，未处理审批变 expired，Agent 收到拒绝；重启恢复也过期化遗留 pending。仍沿用每回合启动、恢复会话、执行一轮、退出的进程模型。

## Codex 适配器

`@vis/agent-codex`，每回合启动一次 `codex app-server`（stdio 上的 JSONL JSON-RPC）：

1. `initialize` → `initialized`。
2. 首回合 `thread/start`，之后 `thread/resume`（`threadId` 即会话的 resumeId）。两者都写明 `cwd`、`sandbox: danger-full-access`（无外层隔离时 read-only）、`approvalPolicy: on-request`、`developerInstructions`，并经 `config.mcp_servers.vis` 注入 `vis mcp`；令牌只放在这个 MCP server 的环境里，不进 Codex 进程自身的环境。
3. `turn/start`，得到应答即视为已接管。

投递失败的判定（0001）：`turn/start` 发出前的任何失败或超时都是 rejected；`turn/start` 收到明确的错误应答也是 rejected；发出后超时或进程退出是 unknown。

回合中：`item/started`、`item/completed` 转为会话记录（`agentMessage` → 文本，`mcpToolCall`、`commandExecution` → 工具调用与结果，条目 ID 为 `cx:<Codex 回合>:<条目>`）；`thread/compacted` 插入压缩提示；`turn/completed` 结束回合，接管后进程退出按中断处理。`item/agentMessage/delta` 经适配器的 `stream` 出口直接作为 `events.transient` 推给界面（0003），不经 SessionService、不落库，条目 ID 与完成后的文本相同，界面收到最终条目即替换草稿。2026-10-26 实测一个回合推送 90 个片段，拼接结果与最终文本一致。

vis 工具确认直接允许；其他可支持审批请求映射到聊天并等待用户决定；允许时仅授予单次许可，拒绝时按对应版本的协议返回拒绝，外层隔离始终不变。停止回合发 `turn/interrupt`，宽限期内没结束就结束进程。

## DeepSeek Harness 适配器

`@vis/agent-deepseek`，每回合启动一次 `dsh --profile acp --patch <空间>/agents/dsh-overlay.yml`（stdio 上的 ACP v1）：

1. `initialize`，声明不提供客户端文件与终端能力。
2. 首回合 `session/new`，之后 `session/resume`（`sessionId` 即会话的 resumeId，`cwd` 必须与首回合一致）。两者都经 `mcpServers` 注入 `vis mcp`，令牌只在这个 MCP server 的环境里。
3. `session/prompt`。

ACP 没有按会话传系统提示的字段，空间规则经 overlay 的 `system-prompt.personaSuffix` 注入。适配器不写工作目录的 `AGENTS.md`，以保留用户已有目录中的说明；项目技能经 `skill-filesystem.customSkillDirs` 原生接入。详见 [0008 的版本与探针证据](0008-projects-and-workspaces.md#原生-agent-技能接入与证据)。

叠加配置（补丁按条目整体替换 config）：

- `sandbox-policy` 在外层隔离成功时改为 `danger-full-access`，避免嵌套 Seatbelt；`approval` 为 `ask`。无外层隔离时仍为 `read-only` + `never`。MCP 工具调用不走审批。
- 隔离成功时开启 shell、联网和 `tool-fs` 写入/编辑；后台任务、子 Agent、工作流仍关闭。回退模式继续关闭 shell/联网与写入/编辑，只留读文件与看图。
  - Note (RFC 0026, 2026-11-03): with the isolation active (or on Windows with approvals), subagents, workflows and background jobs are enabled too. Background jobs end when the turn's dsh process exits.
- `session-log-deepseek.enabled: false`：DSH 默认在所有模式下把会话日志（消息、工具参数与结果、工作区路径）随请求上传给 DeepSeek。

凭据由 dsh 自己管理：已安装源码支持 `~/.dsh/.credentials.yaml` 的账号记录与环境引用（`DEEPSEEK_API_KEY`）。studiod 不打开凭据文件；仅按环境变量白名单原样透传这个变量，不解析、不记录、不保存其值。不是透传整个父进程环境。

投递失败的判定：`session/prompt` 要到回合结束才应答，没有单独的“已收到”。发出前的失败都是 rejected；发出后短时间内（默认 1.5 秒）收到错误应答也是 rejected（多为没有 key、参数错误）；这段时间内进程退出是 unknown；收到第一条更新、提前结束或过了这段时间视为已接管。

回合中：`agent_message_chunk` 按 messageId 累加为文本，`tool_call`、`tool_call_update` 转为工具调用与结果，`agent_thought_chunk` 按 messageId 独立累加为思考，`plan` 整体替换本回合计划；用量不记录。ACP 只发已提交的消息，没有逐字增量，所以 DeepSeek 的回复按整条消息显示，不走流式。`stopReason` 为 `end_turn` 记完成、`cancelled` 记中断，其余记失败；接管后的错误应答记失败并把原因写进会话记录。回合结束先 `session/close` 让 DSH 落盘，进程退出后才回报结束，保证下一回合恢复时会话不在使用中。

`session/request_permission` 映射到聊天；隔离成功时支持执行、修改、删除、移动请求，回退模式仍拒绝这些请求。0.2.1-rc.2 请求只带 toolCallId，适配器从之前的 tool_call 更新补全命令、类型和详情。允许时只选 allow_once，没有该选项则拒绝或 cancelled，其余未知请求返回方法不支持。停止回合发 `session/cancel`，宽限期内没结束就结束进程。

## 双 Agent 实测（2026-10-26）

同一空间开一个 Codex 会话、一个 DeepSeek 会话：

- 接力：Codex 写旁白，DeepSeek 在当前画布上找到它并生成配图，结果落在旁白旁边；两边都没有传 provider。
- 并发改同一槽位：两边引用同一修订（r1）几乎同时修改。DeepSeek 先写成 r2；Codex 的 `expectedRevision: 1` 收到 `revision_conflict`，重新读取后基于 r2 改写为 r3，并保留了对方新增的内容。冲突是明确失败，Codex 换了新的 requestId 重试，符合约定。
- 四个回合均正常结束，实例全部退出，没有残留进程。

## 素材导入与视频抽帧

以下是最初只读适配器的素材工具；N2 的 Codex 与任务 D 的 dsh 已能在隔离工作区运行命令。视频抽帧仍可由服务端代劳：

- `asset.importFile`（仅活动 Agent，MCP `asset_import_file`）：受控登记当前会话工作目录或项目 `assets/` 内的本地图片、视频；realpath 防越界，文件上限 2 GiB。登记后由 Agent 调用 `canvas.apply` 上画布。此入口不自行放宽沙箱和工具权限，见 [0008](0008-projects-and-workspaces.md#本地媒体登记与画布交付)。
- `asset.import`（仅界面）：把本机图片或视频登记为素材（`origin: import`），用 ffprobe 读尺寸与时长，不自动上画布。开发客户端 `/import <绝对路径>` 导入后新建节点。
- `asset.extractFrames`（界面与 Agent，MCP 工具 `asset_frames`）：在视频时长内均匀取 N 帧（各段中点，默认 6、上限 16），长边不超过 1024 的 JPEG，登记为 `origin: derived` 的图片素材并返回时间点与本地地址；Agent 用看图工具查看。不自动上画布。
- 依赖本机 ffmpeg / ffprobe，缺失时返回明确错误。

DeepSeek 默认模型改为 `deepseek-flash`（DeepSeek-V4.1-Flash，支持图片输入）；内置 acp profile 默认的 `deepseek-v4-flash` 不能看图。叠加配置同时补上“只读 + 不审批”的权限预设：原先这个组合不在预设表里，permission 插件启动时报错（之前 dsh 的 stderr 被丢弃，没有发现），当时将 dsh 的 stderr 转到 studiod 日志以定位问题；任务 D 为避免第三方诊断携带凭据改为丢弃原文，只记录定位路径与版本。

## 短剧流程实测（2026-10-26）

《Claude 的一天》，三个会话接力（mock 生成服务）：

- 编剧（Codex）写梗概、角色和 5 个分镜文本节点；美术（DeepSeek，deepseek-flash）生成定妆图，再以定妆图槽位为输入逐镜生成关键帧，并用 `read_image` 看图，如实说出是 mock 色块，V4.1 Flash 看图可用；视频（Codex）以关键帧为输入生成 5 段视频。
- 返工：编剧只改第 3 镜文字（r2），美术与视频分别按 `kind: slot` 原位替换第 3 镜的关键帧和视频（r2），其他镜头保持 r1。

实测发现并已修复：

- 打包后的 studiod 缺 mock 视频样片，下载一直失败。构建脚本现把样片复制到 `dist/fixtures`。
- 最终交付时每轮查询成功都会把重试计数清零，下载持续失败时无限重试、任务停在 `finalizing`。现在只有提交成功和轮询成功才清零，超过上限判定 `unknown`。
- 空间按需打开：studiod 重启后，界面连上之前不会恢复未结束的任务，空闲判断也看不到它们。现在启动时打开全部空间。重启后 mock 任务已不在内存，这几个任务按预期判定 `unknown`，绑定标为 `no_output`。

## 代码渲染（MG 动画）

数据图表、文字排版、MG 动画要求数字和文字准确，用代码渲染：Agent 把一份 HTML 写进画布文本节点，以 `provider: "render"` 提交视频生成，第一个文本输入即页面。studiod 用本机 Chrome（playwright-core 驱动，不下载浏览器）无头打开，逐帧调用 `window.vis.seek(t)` 截图，ffmpeg 合成 mp4，照常回填。

- 页面约定 `window.vis = { duration, seek(t) }`，动画完全由 seek 驱动；只等真正的 Promise（GSAP 时间轴带 then，暂停时永远不会完成）
- 页面不能联网：只应答 `https://vis.local` 下的页面、`/lib/`（gsap、rough.js）和 `/input/<n>`（素材输入），其余请求拦截并计为错误
- 页面报错、越权请求、未定义 `window.vis` 时任务 failed，错误里带页面报错，Agent 据此修改重提
- 产物按 Attempt 的幂等键存放在数据目录 `render/` 下，重启后已完成的渲染仍可找回；渲染中途重启则判定 unknown
- 同一时刻只渲染一个

2026-10-26 实测：以《人民币的“美元锚”》10 秒 MG 片为参考，DeepSeek 抽帧拆解，Codex 写 HTML 并渲染，DeepSeek 对比原片抽帧写审片意见，Codex 原位改 HTML、按槽位替换视频，共渲染 4 次。成片数据、文字与版式和原片基本一致，Claude bot 出镜讲解；手绘感偏弱，仍接近原片的矢量风格。

## 与 Orca 对齐的路径

以下差距可以逐项补齐，各自只影响一处：

| 差距 | 对齐方式 | 影响范围 |
|---|---|---|
| dsh 隔离内运行命令 | 任务 D 已实测并开放；本地媒体用 asset_import_file 登记 | dsh 适配器 |
| 审批已接入 | 聊天内响应、过期处理、会话规则与待审批标记 | 适配器、SessionService、界面 |
| 每回合重启进程，回合中不能插话 | 每会话常驻进程 | 只换适配器实现 |

DeepSeek 原生只读策略不是生成密钥隔离边界；任务 D 使用与 Codex 共用的外层 Seatbelt，内层 danger-full-access，不嵌套原生 workspace-write。

## 待核实

1. ~~`codex app-server` 能否按会话传入 MCP 配置~~：codex-cli 0.164.0 的协议 schema 中 `thread/start`、`thread/resume` 都有 `config` 覆盖字段，可按会话写入 `mcp_servers`。2026-10-26 实测（codex-cli 0.164.0，ChatGPT 登录）：按线程注入的 vis MCP 生效，只读沙箱不妨碍 MCP server 连接 studiod，调用 vis 工具没有触发审批；读画布、写文本节点、提交并等待生成均正常，第二回合经 `thread/resume` 保留了上下文。
2. ~~DeepSeek Harness 在 ACP 模式下的 key 与日志上传~~：已按源码确认（见上节）。2026-10-26 实测（@deepseek-ai/dsh 0.2.1-rc.2，DeepSeek 账号登录，deepseek-v4-flash）：`--dump-config` 确认叠加配置全部生效；MCP 工具名为 `mcp__vis__<工具>`，调用不触发审批；读画布、写文本节点、提交并等待生成均正常，第二回合经 `session/resume` 保留了上下文，进程均退出。deepseek-v4-flash 不支持看图，`read_image` 会被拒。

## 会话自动命名

`session.setTitle` 仅允许活动回合内的 Agent 调用，MCP 工具名为 `session_set_title`，CLI 与 `capabilities.describe` 从同一方法表生成。参数 `{ requestId, title }` 不接受 sessionId，会话取自运行令牌身份；标题先 trim，长度 1–24。沿用 requestId 幂等规则。

会话摘要包含 `titleSource: 'default' | 'user' | 'agent'`。旧会话迁移和新建的默认名字均为 default。若来源为 user，工具返回 `{ applied: false, reason: 'user_named', title }`，不修改；否则返回 `{ applied: true, title }`，新标题写为 agent 并广播 session.updated。标题相同则不写入、不广播。

Codex 与 DeepSeek 每回合输入携带 `<会话>` 块，包含当前标题和来源；user 来源只附标题与“用户已命名，不要修改”。默认名字在理解当前创作之后用正常回合中的工具调用命名，跟随用户语言，中文不超过 12 字，使用无引号、标点及“会话”“任务”等泛词的名词短语。agent 来源仅在工作主题明显变化时更新，user 来源不调用命名工具。不另发模型或 API 请求、不额外询问用户、不在回复中宣布改名；Claude 适配器暂不接入。

## N2 隔离实测（2026-10-27）

codex-cli 0.164.0，macOS 26.6.2，真实登录。原生 workspace-write 能读到假钥匙串与令牌；外层 Seatbelt 加原生 workspace-write 无法启动 shell，因此采用外层隔离加内层 danger-full-access。真实模型发起的 shell 已验证：工作区文件写入成功、curl example.com 返回 HTTP/2 200、目录外写入失败、测试钥匙串读取失败、run/studiod.token 与另一个测试令牌读取失败、父进程环境哨兵不可见。补充探针验证素材 blobs 可读而 space.db 不可读；素材和项目技能的目录外写入仍被拒。所有令牌读取重定向到 /dev/null；不读取生产钥匙串。测试使用唯一 account 的 `vis-creative.provider.test` 假条目，在 finally 删除。

同一真实回合的 vis MCP canvas_get 通过聊天批准后成功；拒绝路径也实际返回 user rejected MCP tool call。独立 macOS 回归以假条目和假文件覆盖原生 Seatbelt 拒绝路径，非 macOS 跳过；测试同时确认外层可信进程仍能读取假条目。目录与 mach 拒绝为 OS 强制，开发提示词不是安全边界。N2 当时未定位到 dsh，未将 Codex 的结果推广到 dsh；后续任务 D 的独立实测见下节。临时原始证据见 `/tmp/vis-n2/`，截图在 `/tmp/vis-n/`，均不提交。

## D：dsh 定位与外层隔离实测（2026-10-27）

启动前依次解析 `VIS_DSH_PATH`、PATH 上的 dsh、`~/.npm/_npx/*/node_modules/@deepseek-ai/dsh/package.json` 中版本最高且可执行的 `.bin/dsh`。按 SemVer 比较（含预发布），显式路径无效直接失败，不自动换版本或运行 npx 下载。日志只记路径与版本；缺失时会话 notice 提示「未找到 dsh，可先运行一次 npx @deepseek-ai/dsh，或设置 VIS_DSH_PATH」。本机实际选择 npx 缓存中的 **0.2.1-rc.2**。

`workbench-core/sandbox.ts` 是 Codex 与 dsh 共用的实现。dsh 允许写 cwd 和真实 `~/.dsh`，禁止读默认 `~/.codex`；其他钥匙串、令牌、数据库保护沿用 N2。缓存安装文件只读即可，不放行整个 `~/.npm` 写入。dsh 的环境只在共同白名单上增加 `DEEPSEEK_API_KEY` 的原样透传；设置工作区 TMPDIR 和 `SSL_CERT_FILE=/etc/ssl/cert.pem`。Node HTTPS 对照（有/无 NODE_EXTRA_CA_CERTS）均为 200；最终真实 dsh 对话仅用 SSL_CERT_FILE 已成功，不添加额外变量、不关闭 TLS 校验。自定义 DSH_HOME 不透传，使用默认 ~/.dsh。

**明确取舍**：整个 ~/.dsh 可读写，包括 dsh 自己的凭据、配置及会话；Agent 的 shell 也能读到这些 DeepSeek 凭据，与 CODEX_HOME 的例外相同。应用不打开这些凭据文件，也不读取或输出密钥内容。保障范围仍是生成服务 Key 和 studiod 令牌，不是所有宿主凭据。第三方 dsh stderr 不直接写入应用日志，避免诊断原文意外携带配置值。overlay 始终按会话隔离，避免并发会话覆盖权限与技能配置。

真实模型经 bash 执行：测试钥匙串读取失败、两个 studiod 令牌读取失败、环境哨兵不可见、space.db/app.db/providers.json 不可读；素材可读，工作区可写，外部写入失败；curl 和 Node HTTPS 都返回 200。vis canvas_get 返回 `{"nodes":[]}`。仅使用 `vis-creative.provider.test` 的假条目并在 finally 删除；未调用方舟。

协调确认：**vis MCP 批准/拒绝不适用**，dsh 0.2.1-rc.2 不发起 MCP 审批，vis 工具直接执行（与 N2 前一致），仍受 gateway callers 与活动回合校验；没有新增代理审批层。原生 ACP 权限请求仍映射聊天，单次许可/拒绝与只读回退有自动回归；本次模型的正常 bash 也未请求审批，不能声称真实模型触发过审批卡片。

共享 macOS 回归对两个 Agent 策略分别验证假钥匙串、令牌、数据库及后缀、素材只读、工作区内/外写入、环境与 Unix socket；另一个测试在临时 HOME 下启动实际缓存 dsh 做 ACP 握手，不发模型请求，找不到 dsh 或非 macOS 跳过。完整隔离表与原始实测记录在 `/tmp/vis-d/report.md`。

## 适配器事件 → 会话条目（0013，2026-10-29）

| 适配器事件 | 会话条目与更新方式 |
|---|---|
| ACP `agent_message_chunk` | `assistant_text`，`ds:<acp>:<messageId>`，按消息累加并递增修订 |
| ACP `agent_thought_chunk` | `reasoning`，`ds:<acp>:<messageId>:thought`，与回复独立累加并递增修订 |
| ACP `plan` | `plan`，`ds:<acp>:<本系统 turnId>:plan`，`entries[].content` → `text`，整体替换并递增修订 |
| ACP `tool_call` / 完成或失败的 `tool_call_update` | `tool_call` / `tool_result`，固定 ID 与修订，重投幂等 |
| Codex 完成的 `agentMessage` | `assistant_text`，`cx:<turn>:<item>` |
| Codex 开始与完成的 `reasoning` | `reasoning`，`cx:<turn>:<item>`；`summary: string[]` 空行连接，空摘要回退 `content: string[]`，开始时以修订 1 写空文本以保留时长与排序，完成时修订 2 替换，全空仍保留条目 |
| Codex `item/reasoning/summaryTextDelta` | `events.transient`，`kind: reasoning`，携带本系统 `turnId`，itemId 与完成条目相同 |
| Codex `item/reasoning/summaryPartAdded` | 后续摘要段（`summaryIndex > 0`）通过瞬时流补空行 |
| Codex `item/agentMessage/delta` | `events.transient`，`kind: assistant_text`，携带本系统 `turnId`，完成条目替换草稿 |
| Codex `turn/plan/updated` | `plan`，`cx:<turn>:plan`，整体替换并递增修订；`step` → `text`、`inProgress` → `in_progress`，保留非 null 的 explanation |
| Codex `mcpToolCall` / `commandExecution` | `tool_call` / `tool_result`，开始与完成使用相同调用 ID |

两种适配器共用 core 的思考截断：超过 20 000 个 Unicode 码点，保留开头 2 000 与结尾 18 000，中间「…（已省略）…」。落库条目的重复或旧修订由既有 upsert 忽略；ACP 没有块序号，不把内容相同的两个文本块误判为重复。

本机 **codex-cli 0.165.0** 的 `codex app-server generate-json-schema --out /tmp/vis-0013-schema` 已核对上述事件、`summaryIndex` 与数组字段；未发模型请求。安装包原生二进制的内嵌模型目录包含 `default_reasoning_summary: "none"`（包括 GPT-6-Astra）；导出 schema 不承诺用户配置覆盖后的有效默认值。因此适配器显式以 `-c model_reasoning_summary="auto"` 启动，确保不继承关闭摘要的配置，不设置或修改推理强度。瞬时事件新增的 kind、turnId 均可省略，旧事件继续按回复文本解释。

协议的 `toolNameOf` 与 CLI MCP 目录共用 `commandOf` 命名规则；`toolLabel` 去掉 `mcp__vis__` / `vis.` 后反查 Agent 方法的 summary，未知名称返回 undefined，CLI 工具名称不变。

## 会话模型与思考强度（0014，2026-10-29）

会话保存 `agentConfig: { model, effort }`，两个字段的 `null` 都表示 Agent 默认。只允许界面通过 `session.setAgentConfig` 修改，按 requestId 幂等并广播 `session.updated`；模型和强度必须属于运行时公布的可选项，强度的校验以所选模型（或默认模型）为准。设置在回合进入运行状态时固定，已排队但未开始的消息采用开始时的值。

| | Codex | DeepSeek Harness |
|---|---|---|
| 可选模型 | app-server `model/list`，过滤 hidden，保留名称、说明与默认标记 | ACP `session/new.configOptions` 中 id 为 model 的分组选项；值是不透明字符串 |
| 思考强度 | `supportedReasoningEfforts` 与 `defaultReasoningEffort` | 逐个模型执行 `session/set_config_option` 后读取 reasoning_effort 选项 |
| 回合生效 | `turn/start.model` / `effort`；null 时用同一进程 `model/list` 的默认模型与默认强度显式传回（目录读不到才省略） | prompt 前与 ACP 当前配置比较，仅变化时设置，先模型后强度 |
| 恢复默认 | 省略 turn/start 覆盖参数（恢复语义见下文） | 模型恢复 overlay 的 deepseek-flash；强度选择 Provider default 空串，无此选项时 high |
| 设置失败 | 回合投递失败，保留通知 | 不发送 prompt，以 rejected 结束本回合并写会话通知 |

可选项在 studiod 内存按 Agent 种类缓存十分钟；探测与正式会话使用相同的外层沙箱和配置覆盖，只交换控制协议，不发模型请求。进程无法启动或探测失败返回 unavailable 和原因，恢复两个字段为 null 不依赖探测成功。Claude 暂不提供模型选项。真实模型效果仍需维护者批准后单独验证。

Codex 0.165.0 的 schema 声明 turn/start 的模型与强度覆盖会延续到后续回合，所以改回默认时显式传回默认值而不是省略；真实 Codex 下的效果仍需维护者批准后验证。
